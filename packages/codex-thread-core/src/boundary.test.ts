import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import test from 'node:test'

import {
  CodexAppServerBoundary,
  CodexBoundaryCancelledError,
  createCodexChildEnvironment,
  type CodexAppServerBoundaryOptions,
} from './boundary.js'

const WORKSPACE = path.resolve('example-workspace')

class FakeAppServerProcess extends EventEmitter {
  readonly writes: string[] = []
  readonly killSignals: (NodeJS.Signals | number | undefined)[] = []
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killed = false
  killResult = true
  readonly stdin = {
    write: (chunk: string): boolean => {
      this.writes.push(String(chunk))
      return true
    },
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = this.killResult
    this.killSignals.push(signal)
    return this.killResult
  }

  exit(code: number | null = 0): void {
    this.exitCode = code
    this.emit('exit', code)
  }

  close(code: number | null = this.exitCode): void {
    this.emit('close', code)
  }
}

class RpcLifecycleBoundary extends CodexAppServerBoundary {
  constructor(readonly fakeProcess: FakeAppServerProcess, options: CodexAppServerBoundaryOptions = {}) {
    super('codex', WORKSPACE, options)
    const internals = this as unknown as {
      child: FakeAppServerProcess
      childClosed: boolean
      markProcessExited: (code: number | null) => void
      onProcessClose: (code: number | null) => Promise<void>
    }
    internals.child = fakeProcess
    internals.childClosed = false
    fakeProcess.once('exit', (code: number | null) => internals.markProcessExited(code))
    fakeProcess.once('close', (code: number | null) => {
      void internals.onProcessClose(code)
    })
  }

  markReady(): void {
    const internals = this as unknown as {
      ready: boolean
      readyReason: string | null
    }
    internals.ready = true
    internals.readyReason = null
  }

  rpc(method: string, params: unknown, signal?: AbortSignal): Promise<any> {
    return this.request(method, params, signal, 'test lifecycle RPC')
  }

  deliverResponse(id: string, result: unknown): void {
    this.dispatchDecodedMessage({ jsonrpc: '2.0', id, result })
  }

  deliverError(id: string, error: unknown): void {
    this.dispatchDecodedMessage({ jsonrpc: '2.0', id, error })
  }
}

test('lifecycle cancellation drains a late mutation reply before rejecting requests left at close', async () => {
  const fakeProcess = new FakeAppServerProcess()
  const boundary = new RpcLifecycleBoundary(fakeProcess)
  const lateMutation = boundary.rpc('thread/archive', { threadId: 'late-thread' })
  const cancelled = boundary.rpc('thread/read', { threadId: 'cancelled-thread' })
  const cancelledAssertion = assert.rejects(cancelled, /stopped/)
  const stopPromise = boundary.stop()

  fakeProcess.exit(0)
  boundary.deliverResponse('req-1', { archived: true })
  assert.deepEqual(await lateMutation, {
    jsonrpc: '2.0',
    id: 'req-1',
    result: { archived: true },
  })

  fakeProcess.close(0)
  await cancelledAssertion
  await stopPromise
})

test('explicit RPC cancellation is typed and a late reply cannot satisfy another request', async () => {
  const fakeProcess = new FakeAppServerProcess()
  const boundary = new RpcLifecycleBoundary(fakeProcess)
  const controller = new AbortController()
  const cancelled = boundary.rpc('thread/read', { threadId: 'cancelled-thread' }, controller.signal)

  controller.abort('operator_stop')
  await assert.rejects(cancelled, (error: unknown) => {
    assert.ok(error instanceof CodexBoundaryCancelledError)
    assert.equal(error.phase, 'test lifecycle RPC')
    assert.equal(error.reason, 'operator_stop')
    return true
  })

  boundary.deliverResponse('req-1', { stale: true })
  const next = boundary.rpc('thread/read', { threadId: 'next-thread' })
  boundary.deliverResponse('req-2', { thread: { id: 'next-thread' } })
  assert.deepEqual((await next).result, { thread: { id: 'next-thread' } })

  const stopPromise = boundary.stop()
  fakeProcess.exit(0)
  fakeProcess.close(0)
  await stopPromise
})

test('JSON-RPC response errors carry only the exact outgoing method and safe error fields', async () => {
  const fakeProcess = new FakeAppServerProcess()
  const boundary = new RpcLifecycleBoundary(fakeProcess)
  const failed = boundary.rpc('thread/read', {
    threadId: 'private-thread-id',
    content: 'private-request-content',
  })

  boundary.deliverError('req-1', {
    code: -32602,
    message: 'request rejected',
    data: { content: 'private-response-content' },
  })

  await assert.rejects(failed, (error: unknown) => {
    assert.ok(error instanceof Error)
    const rpcError = error as Error & {
      jsonRpcCode?: unknown
      jsonRpcMethod?: unknown
    }
    assert.equal(rpcError.name, 'JsonRpcResponseError')
    assert.equal(rpcError.jsonRpcCode, -32602)
    assert.equal(rpcError.jsonRpcMethod, 'thread/read')
    assert.equal('params' in rpcError, false)
    assert.equal('data' in rpcError, false)
    assert.equal(JSON.stringify(rpcError).includes('private-'), false)
    return true
  })

  const stopPromise = boundary.stop()
  fakeProcess.exit(0)
  fakeProcess.close(0)
  await stopPromise
})

test('graceful stop sends TERM and waits for process close without a hidden deadline', async () => {
  const fakeProcess = new FakeAppServerProcess()
  const boundary = new RpcLifecycleBoundary(fakeProcess)
  let settled = false
  const stopPromise = boundary.stop().then(() => {
    settled = true
  })

  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(fakeProcess.killSignals, ['SIGTERM'])
  assert.equal(settled, false)

  fakeProcess.exit(0)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(settled, false)

  fakeProcess.close(0)
  await stopPromise
  assert.equal(settled, true)
})

test('graceful stop tolerates a false TERM return followed by authoritative process close', async () => {
  const fakeProcess = new FakeAppServerProcess()
  fakeProcess.killResult = false
  const boundary = new RpcLifecycleBoundary(fakeProcess)
  let settled = false
  const stopPromise = boundary.stop().then(() => {
    settled = true
  })

  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(fakeProcess.killSignals, ['SIGTERM'])
  assert.equal(settled, false)

  fakeProcess.exit(0)
  fakeProcess.close(0)
  await stopPromise
  assert.equal(settled, true)
})

class ThreadListBoundary extends CodexAppServerBoundary {
  readonly requests: unknown[] = []
  constructor(private readonly pages: unknown[]) { super('codex', WORKSPACE) }
  protected override async ensureReady(): Promise<void> {}
  protected override async request(method: string, params: unknown): Promise<any> {
    assert.equal(method, 'thread/list')
    this.requests.push(params)
    return { result: this.pages.shift() }
  }
}

test('generic thread listing returns every App Server page without a repository count ceiling', async () => {
  const ids = Array.from({ length: 205 }, (_value, index) => `thread.${index}`)
  const boundary = new ThreadListBoundary([
    { data: ids.slice(0, 100).map((id) => ({ id })), nextCursor: '100' },
    { data: ids.slice(100, 200).map((id) => ({ id })), nextCursor: '200' },
    { data: ids.slice(200).map((id) => ({ id })), nextCursor: null },
  ])
  assert.deepEqual((await boundary.listThreads()).map((thread) => thread.id), ids)
  assert.deepEqual(boundary.requests, [
    { limit: 100 }, { limit: 100, cursor: '100' }, { limit: 100, cursor: '200' },
  ])
})

test('thread listing rejects a repeated cursor instead of looping indefinitely', async () => {
  const boundary = new ThreadListBoundary([
    { data: [{ id: 'first' }], nextCursor: 'same' },
    { data: [{ id: 'second' }], nextCursor: 'same' },
  ])
  await assert.rejects(boundary.listThreads(), /cursor did not advance/)
})

test('App Server receives runtime and Codex auth settings without service or unrelated credentials', () => {
  const child = createCodexChildEnvironment({
    Path: 'runtime-bin', SYSTEMROOT: 'system', HOME: 'home',
    CODEX_HOME: 'codex-home', OPENAI_API_KEY: 'codex-key', HTTPS_PROXY: 'proxy',
    WORKSTATION_CONTROL_BEARER_TOKEN: 'service-token', PROTOCOL_RUNNER_API_TOKEN: 'runner-token',
    DISCORD_BOT_TOKEN: 'bot-token', AWS_SECRET_ACCESS_KEY: 'unrelated-key',
    NODE_OPTIONS: '--require untrusted-loader', UNSET: undefined,
  })
  assert.deepEqual(child, {
    Path: 'runtime-bin', SYSTEMROOT: 'system', HOME: 'home',
    CODEX_HOME: 'codex-home', OPENAI_API_KEY: 'codex-key', HTTPS_PROXY: 'proxy',
  })
})
