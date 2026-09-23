import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

import type {
  CodexRawThreadReadResult,
  CodexRawThreadSummary,
  CreateThreadResponse,
  SubmitPromptResponse,
} from '@workstation-control/remote-core'

import { createLogger } from './logger.js'

// Ordinary App Server thread transport. Goal/Mission execution and research
// observations are separate consumers and are not part of this public package.
type PendingRequest = {
  method: string
  resolve: (value: any) => void
  reject: (error: Error) => void
  cleanup: () => void
}

export interface CodexBoundary {
  start(signal?: AbortSignal): Promise<void>
  stop(): Promise<void>
  isReady(): boolean
  getReadyReason(): string | null
  sanityCheck(signal?: AbortSignal): Promise<void>
  listThreads(): Promise<CodexRawThreadSummary[]>
  readThread(threadId: string): Promise<CodexRawThreadReadResult>
  resumeThread(threadId: string): Promise<void>
  createThread(prompt: string): Promise<CreateThreadResponse>
  submitPrompt(threadId: string, prompt: string): Promise<SubmitPromptResponse>
  subscribe(listener: (message: any) => void): () => void
}

export type CodexAppServerBoundaryOptions = {
  restartOnUnexpectedExit?: boolean
}

export class CodexBoundaryCancelledError extends Error {
  constructor(
    readonly phase: string,
    readonly reason: unknown,
  ) {
    super(`App Server operation was explicitly cancelled during ${phase}`)
    this.name = 'CodexBoundaryCancelledError'
  }
}

type CodexCliInvocation = {
  executable: string
  prefixArgs: readonly string[]
  shell: boolean
}

function cancellationError(signal: AbortSignal, phase: string): CodexBoundaryCancelledError {
  return new CodexBoundaryCancelledError(phase, signal.reason)
}

function throwIfCancelled(signal: AbortSignal | undefined, phase: string): void {
  if (signal?.aborted) {
    throw cancellationError(signal, phase)
  }
}

const CHILD_ENVIRONMENT_KEYS = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'SYSTEMDRIVE',
  'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USER', 'USERNAME', 'USERPROFILE',
  'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)',
  'PROCESSOR_ARCHITECTURE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'XDG_RUNTIME_DIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM', 'COLORTERM',
  'NO_COLOR', 'FORCE_COLOR', 'CODEX_HOME', 'OPENAI_API_KEY', 'OPENAI_BASE_URL',
  'CODEX_API_KEY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
  'NODE_EXTRA_CA_CERTS',
])

/** Preserve CLI runtime/auth configuration without inheriting service secrets. */
export function createCodexChildEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([key, value]) =>
    value !== undefined && CHILD_ENVIRONMENT_KEYS.has(key.toUpperCase()),
  ))
}

function codexCliInvocation(cliPath: string): CodexCliInvocation {
  if (process.platform === 'win32' && path.extname(cliPath).toLowerCase() === '.cmd') {
    const resolved = path.resolve(cliPath)
    const executable = path.join(
      path.dirname(resolved),
      'node_modules',
      '@openai',
      'codex',
      'node_modules',
      '@openai',
      'codex-win32-x64',
      'vendor',
      'x86_64-pc-windows-msvc',
      'bin',
      'codex.exe',
    )
    if (path.basename(resolved).toLowerCase() !== 'codex.cmd' || !fs.existsSync(executable)) {
      throw new Error('absolute codex.cmd could not be resolved to the native Codex executable')
    }
    return { executable, prefixArgs: [], shell: false }
  }
  return { executable: cliPath, prefixArgs: [], shell: process.platform === 'win32' }
}

function extractResult(message: any): any {
  return message?.result ?? message
}

function extractThreadResult(message: any): any {
  const result = extractResult(message)
  return result?.data ?? result
}

function extractThreadId(value: any): string | null {
  const candidate = value?.thread?.id ?? value?.threadId ?? value?.id
  return typeof candidate === 'string' && candidate.trim() ? candidate : null
}

function extractTurnId(value: any): string | null {
  const candidate = value?.turn?.id ?? value?.turnId
  return typeof candidate === 'string' && candidate.trim() ? candidate : null
}

function asThreadSummary(value: unknown): CodexRawThreadSummary | null {
  const candidate = value as { id?: unknown; name?: unknown } | null
  if (!candidate || typeof candidate.id !== 'string') {
    return null
  }
  return {
    ...(candidate as Record<string, unknown>),
    id: candidate.id,
    name: typeof candidate.name === 'string' ? candidate.name : null,
  } as CodexRawThreadSummary
}

function coerceThreadListPage(message: any): Readonly<{
  data: readonly any[]
  nextCursor: string | null
}> {
  const result = extractResult(message)
  if (!result || typeof result !== 'object' || Array.isArray(result) || !Array.isArray(result.data)) {
    throw new Error('thread/list returned an invalid pagination envelope')
  }
  const nextCursor = result.nextCursor
  if (nextCursor !== null && (typeof nextCursor !== 'string' || nextCursor.length === 0)) {
    throw new Error('thread/list returned an invalid nextCursor')
  }
  return { data: result.data, nextCursor }
}

function coerceThreadReadResult(message: any): CodexRawThreadReadResult {
  const result = extractThreadResult(message)
  const thread = asThreadSummary(result?.thread ?? result)
  if (!thread) {
    throw new Error('thread/read returned no thread')
  }
  return { thread }
}

class JsonRpcResponseError extends Error {
  readonly jsonRpcCode: number | string | null
  readonly jsonRpcMethod: string

  constructor(method: string, error: any) {
    super(typeof error?.message === 'string' ? error.message : 'Codex App Server request failed')
    this.name = 'JsonRpcResponseError'
    this.jsonRpcCode =
      typeof error?.code === 'number' || typeof error?.code === 'string' ? error.code : null
    this.jsonRpcMethod = method
  }
}

function stderrLogFields(value: unknown): Record<string, unknown> {
  const stderr = String(value)
  const byteCount = Buffer.byteLength(stderr, 'utf8')
  return {
    stderr_present: byteCount > 0,
    stderr_character_count: Array.from(stderr).length,
    stderr_byte_count: byteCount,
    stderr_sha256:
      byteCount === 0
        ? null
        : createHash('sha256').update(stderr, 'utf8').digest('hex'),
  }
}

function boundaryErrorLogFields(error: unknown): Record<string, unknown> {
  if (error instanceof JsonRpcResponseError) {
    return {
      error_class: 'JsonRpcResponseError',
      json_rpc_code: typeof error.jsonRpcCode === 'number' && Number.isSafeInteger(error.jsonRpcCode)
        ? error.jsonRpcCode : null,
      json_rpc_code_present: error.jsonRpcCode !== null,
    }
  }
  return { error_class: error instanceof Error ? 'Error' : 'UnknownError' }
}

export class CodexAppServerBoundary extends EventEmitter implements CodexBoundary {
  private readonly logger = createLogger('codex_boundary')
  private readonly pending = new Map<string, PendingRequest>()
  private readonly resumedThreadIds = new Set<string>()
  private child: ReturnType<typeof spawn> | null = null
  private childClosed = true
  private lineReader: readline.Interface | null = null
  private nextId = 1
  private ready = false
  private readyReason: string | null = 'starting'
  private startPromise: Promise<void> | null = null
  private stopped = false
  private intentionalTerminationReason: string | null = null
  private fatalBoundaryError: string | null = null
  private restartTimer: NodeJS.Timeout | null = null
  private messageQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly cliPath: string,
    private readonly workspaceRoot: string,
    private readonly options: CodexAppServerBoundaryOptions = {},
  ) {
    super()
  }

  async start(signal?: AbortSignal): Promise<void> {
    throwIfCancelled(signal, 'boundary startup')
    if (this.ready) {
      return
    }
    if (this.startPromise) {
      return this.startPromise
    }
    if (this.fatalBoundaryError) {
      throw new Error(this.fatalBoundaryError)
    }
    this.startPromise = this.doStart(signal).finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  private async doStart(signal?: AbortSignal): Promise<void> {
    this.stopped = false
    this.intentionalTerminationReason = null
    this.ready = false
    this.readyReason = 'starting'
    const invocation = codexCliInvocation(this.cliPath)
    const child = spawn(invocation.executable, [...invocation.prefixArgs, 'app-server'], {
      cwd: this.workspaceRoot,
      env: createCodexChildEnvironment(),
      shell: invocation.shell,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    this.childClosed = false
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      this.logger.warn('bridge.boundary.stderr', stderrLogFields(chunk))
    })
    child.once('error', (error) => {
      this.ready = false
      this.readyReason = 'unable to start Codex App Server'
      this.fatalBoundaryError = this.readyReason
      this.cancelPendingRequests(this.readyReason)
      this.logger.error('bridge.boundary.spawn_failed', boundaryErrorLogFields(error))
    })
    child.once('exit', (code) => {
      this.markProcessExited(code)
    })
    child.once('close', (code) => {
      void this.onProcessClose(code)
    })
    this.lineReader = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
    this.lineReader.on('line', (line) => {
      const trimmed = line.trim()
      if (!trimmed) {
        return
      }
      try {
        this.dispatchDecodedMessage(JSON.parse(trimmed))
      } catch {
        this.logger.error('bridge.boundary.invalid_json_line', {})
      }
    })
    try {
      await this.request(
        'initialize',
        {
          clientInfo: {
            name: 'workstation-control-bridge',
            title: 'Workstation Control Bridge',
            version: '0.0.0',
          },
          capabilities: { experimentalApi: true },
        },
        signal,
        'boundary startup',
      )
      await this.sanityCheck(signal)
      throwIfCancelled(signal, 'boundary startup')
      this.ready = true
      this.readyReason = null
    } catch (error) {
      if (signal?.aborted) {
        this.intentionalTerminationReason = 'boundary startup explicitly cancelled'
        this.ready = false
        this.readyReason = this.intentionalTerminationReason
        await this.stopNativeAppServerProcess()
        this.cancelPendingRequests(this.readyReason)
        throw cancellationError(signal, 'boundary startup')
      }
      throw error
    }
  }

  private markProcessExited(code: number | null): void {
    this.ready = false
    this.readyReason =
      this.intentionalTerminationReason ?? 'boundary exited with code ' + (code ?? 'unknown')
  }

  private cancelPendingRequests(reason: string): void {
    for (const pending of this.pending.values()) {
      pending.cleanup()
      const error = new Error(reason)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private async onProcessClose(code: number | null): Promise<void> {
    this.childClosed = true
    this.markProcessExited(code)
    this.cancelPendingRequests(this.readyReason ?? 'Codex App Server process closed')
    this.resumedThreadIds.clear()
    if (this.stopped || this.intentionalTerminationReason !== null || this.fatalBoundaryError) return
    if (this.options.restartOnUnexpectedExit === false) {
      this.fatalBoundaryError = this.readyReason
      return
    }
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      void this.start().catch((error) => {
        this.logger.error('bridge.boundary.restart_failed', boundaryErrorLogFields(error))
      })
    }, 1000)
  }

  protected dispatchDecodedMessage(message: any): void {
    const responseId = message?.id
    if (responseId !== undefined && typeof message?.method !== 'string') {
      const requestId = String(responseId)
      const pending = this.pending.get(requestId)
      if (!pending) {
        return
      }
      this.pending.delete(requestId)
      pending.cleanup()
      if (message.error) {
        pending.reject(new JsonRpcResponseError(pending.method, message.error))
      } else {
        pending.resolve(message)
      }
      return
    }
    void this.enqueueRuntimeMessage(message)
  }

  protected enqueueRuntimeMessage(message: any): Promise<void> {
    const next = this.messageQueue.then(() => {
      if (message?.id !== undefined && typeof message?.method === 'string') {
        // This transport has no server-side tool/approval owner. Reject unknown
        // requests explicitly; never execute them or infer approval.
        this.child?.stdin?.write(JSON.stringify({
          jsonrpc: '2.0', id: message.id,
          error: { code: -32601, message: 'Unsupported server request' },
        }) + '\n')
      } else {
        this.emit('notification', message)
      }
    })
    this.messageQueue = next.catch((error) => {
      this.logger.error('bridge.boundary.message_failed', boundaryErrorLogFields(error))
    })
    return next
  }

  protected async ensureReady(signal?: AbortSignal): Promise<void> {
    throwIfCancelled(signal, 'boundary readiness')
    if (this.fatalBoundaryError) {
      throw new Error(this.fatalBoundaryError)
    }
    if (!this.ready) {
      await this.start(signal)
    }
    throwIfCancelled(signal, 'boundary readiness')
  }

  protected request(
    method: string,
    params: unknown,
    signal?: AbortSignal,
    cancellationPhase = 'App Server request',
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(cancellationError(signal, cancellationPhase))
        return
      }
      const stdin = this.child?.stdin
      if (!stdin || this.childClosed || this.stopped || this.intentionalTerminationReason !== null) {
        reject(new Error('boundary stdin is unavailable'))
        return
      }
      const id = 'req-' + this.nextId++
      let abortListener: (() => void) | null = null
      const cleanup = (): void => {
        if (abortListener) {
          signal?.removeEventListener('abort', abortListener)
          abortListener = null
        }
      }
      const pending: PendingRequest = { method, resolve, reject, cleanup }
      if (signal) {
        abortListener = () => {
          if (this.pending.get(id) !== pending) {
            return
          }
          this.pending.delete(id)
          cleanup()
          const error = cancellationError(signal, cancellationPhase)
          reject(error)
        }
        signal.addEventListener('abort', abortListener, { once: true })
      }
      this.pending.set(id, pending)
      try {
        stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      } catch (error) {
        this.pending.delete(id)
        cleanup()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  isReady(): boolean {
    return this.ready
  }

  getReadyReason(): string | null {
    return this.readyReason
  }

  async sanityCheck(signal?: AbortSignal): Promise<void> {
    const result = await this.request('config/read', {}, signal, 'boundary startup')
    if (!extractResult(result)?.config) {
      throw new Error('boundary sanity check did not return config')
    }
  }

  async listThreads(): Promise<CodexRawThreadSummary[]> {
    await this.ensureReady()
    const threads: CodexRawThreadSummary[] = []
    let cursor: string | null = null
    const seenNextCursors = new Set<string>()
    while (true) {
      const page = coerceThreadListPage(
        await this.request('thread/list', {
          limit: 100,
          ...(cursor === null ? {} : { cursor }),
        }),
      )
      if (
        page.nextCursor !== null &&
        (page.nextCursor === cursor || seenNextCursors.has(page.nextCursor))
      ) {
        throw new Error('thread/list pagination cursor did not advance')
      }
      for (const row of page.data) {
        const thread = asThreadSummary(row)
        if (!thread) {
          throw new Error('thread/list returned an invalid thread entry')
        }
        threads.push(thread)
      }
      if (page.nextCursor === null) {
        return threads
      }
      seenNextCursors.add(page.nextCursor)
      cursor = page.nextCursor
    }
  }

  async readThread(threadId: string): Promise<CodexRawThreadReadResult> {
    await this.ensureReady()
    return coerceThreadReadResult(
      await this.request('thread/read', { threadId, includeTurns: true }),
    )
  }

  async resumeThread(threadId: string): Promise<void> {
    await this.ensureReady()
    if (this.resumedThreadIds.has(threadId)) {
      return
    }
    await this.request('thread/resume', { threadId, cwd: this.workspaceRoot })
    this.resumedThreadIds.add(threadId)
  }

  async createThread(prompt: string): Promise<CreateThreadResponse> {
    await this.ensureReady()
    const started = await this.request('thread/start', {
      cwd: this.workspaceRoot,
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    })
    const threadId = extractThreadId(extractResult(started))
    if (!threadId) {
      throw new Error('thread/start did not return a thread id')
    }
    const turn = await this.request('turn/start', {
      threadId,
      cwd: this.workspaceRoot,
      approvalPolicy: 'never',
      input: [{ type: 'text', text: prompt, text_elements: [] }],
    })
    return { threadId, turnId: extractTurnId(extractResult(turn)) }
  }

  async submitPrompt(threadId: string, prompt: string): Promise<SubmitPromptResponse> {
    await this.ensureReady()
    const turn = await this.request('turn/start', {
      threadId,
      cwd: this.workspaceRoot,
      approvalPolicy: 'never',
      input: [{ type: 'text', text: prompt, text_elements: [] }],
    })
    return { threadId, turnId: extractTurnId(extractResult(turn)) }
  }

  subscribe(listener: (message: any) => void): () => void {
    this.on('notification', listener)
    return () => this.off('notification', listener)
  }

  private async stopNativeAppServerProcess(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    const child = this.child
    if (!child || this.childClosed) {
      return
    }
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
    if (
      child.exitCode === null &&
      child.signalCode === null &&
      (signal === 'SIGKILL' || !child.killed)
    ) {
      // A false return can race a natural child exit. `close` is the authoritative
      // lifecycle edge because it also proves the stdio streams have drained.
      child.kill(signal)
    }
    await closed
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.intentionalTerminationReason ??= 'stopped'
    this.ready = false
    this.readyReason = this.intentionalTerminationReason
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    await this.stopNativeAppServerProcess()
    this.cancelPendingRequests(this.readyReason)
    this.lineReader?.close()
    this.lineReader = null
    this.child = null
    this.resumedThreadIds.clear()
  }
}
