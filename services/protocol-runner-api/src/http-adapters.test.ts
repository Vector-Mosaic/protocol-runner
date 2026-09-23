import assert from 'node:assert/strict'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { readProtocolRunnerApiConfig } from './config.js'
import { HttpCodexDesktopAdapter, HttpDiscordRelayAdapter } from './http-adapters.js'

interface CapturedRequest {
  method: string
  path: string
  authorization: string | null
  body: unknown
}

const servers: http.Server[] = []
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const controlToken = 'test-only-config-control-token-at-least-32'

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw.trim() ? (JSON.parse(raw) as unknown) : null
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  })
  response.end(text)
}

async function startHttpHarness(
  handler: (request: IncomingMessage, response: ServerResponse, captured: CapturedRequest[]) => Promise<void>,
): Promise<{ baseUrl: string; captured: CapturedRequest[]; close(): Promise<void> }> {
  const captured: CapturedRequest[] = []
  const server = http.createServer((request, response) => {
    void handler(request, response, captured).catch((error: unknown) => {
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  const address = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    captured,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

function record(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, 'object')
  assert.notEqual(value, null)
  assert.equal(Array.isArray(value), false)
  return value as Record<string, unknown>
}

after(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          if (!server.listening) {
            resolve()
            return
          }
          server.close(() => resolve())
        }),
    ),
  )
})

describe('protocol runner API config', () => {
  it('defaults to fake adapters on the dedicated protocol-runner port', () => {
    const config = readProtocolRunnerApiConfig({ PROTOCOL_RUNNER_CONTROL_TOKEN: controlToken })
    assert.equal(config.host, '127.0.0.1')
    assert.equal(config.port, 4831)
    assert.equal(config.adapterMode, 'fake')
    assert.equal(config.storeMode, 'sqlite')
    assert.equal(path.basename(config.dbPath), 'protocol_runner.sqlite')
    assert.equal(config.contractRoot, repoRoot)
    assert.equal(config.desktop.baseUrl, 'http://127.0.0.1:4825')
    assert.equal(config.desktop.bearerToken, null)
    assert.equal(config.relay.baseUrl, 'http://127.0.0.1:4830')
    assert.equal(config.relay.publishBearerToken, null)
    assert.equal(config.relay.operatorBearerToken, null)
    assert.equal(config.notification.enabled, false)
    assert.equal(config.notification.notifyUrl, 'http://127.0.0.1:5174/?notify=1')
    assert.equal(path.basename(config.notification.scriptPath), 'show_protocol_runner_gate.ps1')
  })

  it('requires real adapter tokens only when real mode is enabled', () => {
    assert.throws(
      () => readProtocolRunnerApiConfig({ PROTOCOL_RUNNER_CONTROL_TOKEN: controlToken, PROTOCOL_RUNNER_ADAPTER_MODE: 'real' }),
      /PROTOCOL_RUNNER_CODEX_DESKTOP_BEARER_TOKEN/,
    )

    const config = readProtocolRunnerApiConfig({
      PROTOCOL_RUNNER_CONTROL_TOKEN: controlToken,
      PROTOCOL_RUNNER_ADAPTER_MODE: 'real',
      PROTOCOL_RUNNER_CODEX_DESKTOP_BEARER_TOKEN: 'desktop-secret',
      PROTOCOL_RUNNER_DISCORD_RELAY_PUBLISH_BEARER_TOKEN: 'publish-secret',
      PROTOCOL_RUNNER_DISCORD_RELAY_OPERATOR_BEARER_TOKEN: 'relay-secret',
    })
    assert.equal(config.adapterMode, 'real')
    assert.equal(config.desktop.bearerToken, 'desktop-secret')
    assert.equal(config.relay.publishBearerToken, 'publish-secret')
    assert.equal(config.relay.operatorBearerToken, 'relay-secret')
  })

  it('allows the contract preflight root to be configured separately from run storage', () => {
    const contractRoot = path.join(repoRoot, 'protocol-contract-fixtures')
    const dbPath = path.join(repoRoot, 'protocol-runner-state', 'runner.sqlite')
    const config = readProtocolRunnerApiConfig({
      PROTOCOL_RUNNER_CONTROL_TOKEN: controlToken,
      PROTOCOL_RUNNER_CONTRACT_ROOT: contractRoot,
      PROTOCOL_RUNNER_DB_PATH: dbPath,
      PROTOCOL_RUNNER_STORE_MODE: 'json',
    })
    assert.equal(config.contractRoot, contractRoot)
    assert.equal(config.dbPath, dbPath)
    assert.equal(config.storeMode, 'json')
  })
})

describe('HttpCodexDesktopAdapter', () => {
  it('requires delivery confirmation for sent and classifies refused prompts as not_sent', async () => {
    const harness = await startHttpHarness(async (request, response, captured) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const body = request.method === 'POST' ? await readJsonBody(request) : null
      captured.push({
        method: request.method ?? 'GET',
        path: url.pathname,
        authorization: request.headers.authorization ?? null,
        body,
      })

      if (url.pathname === '/healthz') {
        sendJson(response, 200, { ok: true })
        return
      }

      if (request.headers.authorization !== 'Bearer desktop-secret') {
        sendJson(response, 401, { error: 'auth_required' })
        return
      }

      if (url.pathname === '/api/codex-desktop/state') {
        sendJson(response, 200, { result: 'applied', windowFound: true })
        return
      }

      if (url.pathname === '/api/codex-desktop/prompt') {
        const payload = record(body)
        if (payload.text === 'refuse') {
          sendJson(response, 200, {
            result: 'thread_mismatch',
            message: 'Wrong thread',
            threadId: payload.threadId,
            threadTitle: payload.threadTitle,
            turnId: null,
            itemId: null,
            selectionConfirmed: false,
            composeDiagnostics: {
              acceptedCandidateCount: 0,
              rejectedReasons: {
                above_compose_region: 2,
              },
            },
          })
          return
        }
        if (payload.text === 'inconclusive') {
          sendJson(response, 200, {
            result: 'applied',
            message: 'UI action applied and exact sidebar selection was confirmed.',
            threadId: payload.threadId,
            threadTitle: payload.threadTitle,
            turnId: null,
            itemId: null,
            selectionConfirmed: true,
          })
          return
        }
        if (payload.text === 'selected-only') {
          sendJson(response, 200, {
            result: 'applied',
            message: 'Visible sidebar selection confirmed.',
            threadId: payload.threadId,
            threadTitle: payload.threadTitle,
            turnId: null,
            itemId: null,
            selectionConfirmed: true,
          })
          return
        }
        if (payload.text === 'ids-only') {
          sendJson(response, 200, {
            result: 'applied',
            message: 'Thread ids exist but exact sidebar selection confirmation is missing.',
            threadId: payload.threadId,
            threadTitle: payload.threadTitle,
            turnId: 'turn-ids-only',
            itemId: 'item-ids-only',
            selectionConfirmed: false,
          })
          return
        }
        sendJson(response, 200, {
          result: 'applied',
          message: null,
          threadId: payload.threadId,
          threadTitle: payload.threadTitle,
          turnId: 'turn-1',
          itemId: 'item-1',
          selectionConfirmed: true,
        })
        return
      }

      sendJson(response, 404, { error: 'not_found' })
    })

    try {
      const adapter = new HttpCodexDesktopAdapter({
        baseUrl: harness.baseUrl,
        bearerToken: 'desktop-secret',
        promptMode: 'focus',
      })
      assert.equal((await adapter.health()).ok, true)
      assert.equal((await adapter.getState()).windowFound, true)

      const sent = await adapter.sendPrompt({
        run_instance_id: 'run-1',
        step_id: 'step-1',
        prompt: 'do work',
        thread_binding: {
          binding_kind: 'serial_desktop',
          visible_thread_label: 'Thread One',
          relay_channel_id: 'channel-1',
        },
      })
      assert.equal(sent.send_status, 'sent')
      assert.equal(sent.desktop_result, 'applied')
      assert.equal(sent.turn_id, 'turn-1')

      const inconclusive = await adapter.sendPrompt({
        run_instance_id: 'run-1',
        step_id: 'step-1',
        prompt: 'inconclusive',
        thread_binding: {
          binding_kind: 'serial_desktop',
          visible_thread_label: 'Thread One',
          relay_channel_id: 'channel-1',
        },
      })
      assert.equal(inconclusive.send_status, 'sent')
      assert.equal(inconclusive.desktop_result, 'applied')
      assert.match(inconclusive.message ?? '', /sidebar selection/)

      const selectedOnly = await adapter.sendPrompt({
        run_instance_id: 'run-1',
        step_id: 'step-1',
        prompt: 'selected-only',
        thread_binding: {
          binding_kind: 'serial_desktop',
          visible_thread_label: 'Thread One',
          relay_channel_id: 'channel-1',
        },
      })
      assert.equal(selectedOnly.send_status, 'sent')
      assert.equal(selectedOnly.desktop_result, 'applied')
      assert.equal(selectedOnly.turn_id, null)
      assert.equal(selectedOnly.item_id, null)
      assert.equal(selectedOnly.selection_confirmed, true)

      const idsOnly = await adapter.sendPrompt({
        run_instance_id: 'run-1',
        step_id: 'step-1',
        prompt: 'ids-only',
        thread_binding: {
          binding_kind: 'serial_desktop',
          visible_thread_label: 'Thread One',
          relay_channel_id: 'channel-1',
        },
      })
      assert.equal(idsOnly.send_status, 'unknown')
      assert.equal(idsOnly.desktop_result, 'applied')
      assert.equal(idsOnly.turn_id, 'turn-ids-only')
      assert.equal(idsOnly.item_id, 'item-ids-only')
      assert.match(idsOnly.message ?? '', /sidebar selection/)

      const refused = await adapter.sendPrompt({
        run_instance_id: 'run-1',
        step_id: 'step-1',
        prompt: 'refuse',
        thread_binding: {
          binding_kind: 'serial_desktop',
          visible_thread_label: 'Thread One',
          relay_channel_id: 'channel-1',
        },
      })
      assert.equal(refused.send_status, 'not_sent')
      assert.equal(refused.desktop_result, 'thread_mismatch')
      assert.match(refused.message ?? '', /Wrong thread/)
      assert.deepEqual(refused.desktop_diagnostics, {
        acceptedCandidateCount: 0,
        rejectedReasons: {
          above_compose_region: 2,
        },
      })

      const promptRequests = harness.captured.filter((request) => request.path === '/api/codex-desktop/prompt')
      assert.equal(promptRequests.length, 5)
      assert.equal(promptRequests[0]?.authorization, 'Bearer desktop-secret')
      assert.equal(record(promptRequests[0]?.body).mode, 'focus')
      assert.equal('deliveryMode' in record(promptRequests[0]?.body), false)
      assert.equal(record(promptRequests[0]?.body).threadId, undefined)
      assert.equal(record(promptRequests[0]?.body).threadTitle, 'Thread One')
    } finally {
      await harness.close()
    }
  })
})

describe('HttpDiscordRelayAdapter', () => {
  it('creates a protocol-runner relay binding through the operator endpoint', async () => {
    const harness = await startHttpHarness(async (request, response, captured) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const body = request.method === 'POST' ? await readJsonBody(request) : null
      captured.push({
        method: request.method ?? 'GET',
        path: url.pathname,
        authorization: request.headers.authorization ?? null,
        body,
      })

      if (url.pathname === '/healthz') {
        sendJson(response, 200, { ok: true })
        return
      }
      if (url.pathname === '/readyz') {
        sendJson(response, 200, { ok: true })
        return
      }

      if (url.pathname === '/api/publish') {
        if (request.headers.authorization !== 'Bearer publish-secret') {
          sendJson(response, 401, { ok: false, error: 'auth_required' })
          return
        }
        sendJson(response, 201, {
          ok: true,
          channelId: 'channel-1',
          messageIds: ['message-1'],
          chunkCount: 1,
          textSha256: 'a'.repeat(64),
        })
        return
      }

      if (request.headers.authorization !== 'Bearer relay-secret') {
        sendJson(response, 401, { ok: false, error: 'auth_required' })
        return
      }

      if (url.pathname === '/api/operator/state') {
        sendJson(response, 200, { schemaVersion: 1, channels: {} })
        return
      }

      if (url.pathname === '/api/operator/protocol-runner/bind-channel') {
        const payload = record(body)
        sendJson(response, 201, {
          ok: true,
          channelId: 'channel-1',
          channelName: 'codex-protocol-runner-run-1',
          channelUrl: 'https://discord.test/channel-1',
          shortLabel: 7,
          bindingId: 'bind-1',
          status: 'ready',
          bindingNoteStatus: 'pending',
          desktopThreadLabel: payload.threadTitle,
          codexThreadId: null,
        })
        return
      }

      if (url.pathname === '/api/operator/close-channel') {
        const payload = record(body)
        sendJson(response, 200, {
          ok: true,
          channelId: payload.channelId,
          channelName: 'codex-protocol-runner-run-1',
          desktopThreadLabel: 'Thread One',
          status: 'ready',
          shortLabel: 7,
          deletedDiscordChannel: true,
          removedMapping: true,
          discordDeleteStatus: 'deleted',
        })
        return
      }

      sendJson(response, 404, { error: 'not_found' })
    })

    try {
      const adapter = new HttpDiscordRelayAdapter({
        baseUrl: harness.baseUrl,
        operatorBearerToken: 'relay-secret',
        publishBearerToken: 'publish-secret',
      })
      assert.equal((await adapter.health()).ok, true)
      assert.equal((await adapter.ready()).ok, true)
      assert.equal((await adapter.getState()).schemaVersion, 1)

      const binding = await adapter.bindRun({
        run_instance_id: 'run-1',
        binding_kind: 'serial_desktop',
        visible_thread_label: 'Thread One',
        relay_channel_name: 'runner run 1',
      })
      assert.equal(binding.binding_kind, 'serial_desktop')
      assert.equal(binding.visible_thread_label, 'Thread One')
      assert.equal(binding.relay_channel_id, 'channel-1')
      assert.equal(binding.relay_channel_name, 'codex-protocol-runner-run-1')
      assert.equal(binding.binding_id, 'bind-1')
      assert.equal(binding.cleanup_state, 'active')

      const bindRequest = harness.captured.find(
        (request) => request.path === '/api/operator/protocol-runner/bind-channel',
      )
      assert.notEqual(bindRequest, undefined)
      assert.equal(bindRequest?.authorization, 'Bearer relay-secret')
      assert.equal(record(bindRequest?.body).runInstanceId, 'run-1')
      assert.equal(record(bindRequest?.body).threadId, undefined)
      assert.equal(record(bindRequest?.body).threadTitle, 'Thread One')
      assert.equal(record(bindRequest?.body).channelName, 'runner run 1')

      const capturedBeforeParallelOnly = harness.captured.length
      const parallelOnly = await adapter.bindRun({
        run_instance_id: 'parallel-run',
        binding_kind: 'parallel_only',
      })
      assert.equal(parallelOnly.binding_kind, 'parallel_only')
      assert.equal(parallelOnly.relay_channel_id, undefined)
      assert.equal(harness.captured.length, capturedBeforeParallelOnly)

      const published = await adapter.publish({
        channel_id: 'channel-1',
        binding_id: 'bind-1',
        text: 'runner status',
        correlation_id: 'publish-1',
      })
      assert.equal(published.ok, true)
      assert.deepEqual(published.message_ids, ['message-1'])
      assert.equal(published.chunk_count, 1)
      assert.equal(published.text_sha256, 'a'.repeat(64))

      const publishRequest = harness.captured.find((request) => request.path === '/api/publish')
      assert.notEqual(publishRequest, undefined)
      assert.equal(publishRequest?.authorization, 'Bearer publish-secret')
      assert.equal(record(publishRequest?.body).source, 'protocol_runner')
      assert.equal(record(publishRequest?.body).correlationId, 'publish-1')

      const closed = await adapter.closeRunBinding({
        channel_id: 'channel-1',
        force: true,
        correlation_id: 'cleanup-1',
      })
      assert.equal(closed.ok, true)
      assert.equal(closed.cleanup_state, 'cleaned_up')

      const closeRequest = harness.captured.find((request) => request.path === '/api/operator/close-channel')
      assert.notEqual(closeRequest, undefined)
      assert.equal(closeRequest?.authorization, 'Bearer relay-secret')
      assert.equal(record(closeRequest?.body).channelId, 'channel-1')
      assert.equal(record(closeRequest?.body).force, true)
      assert.equal(record(closeRequest?.body).correlationId, 'cleanup-1')
    } finally {
      await harness.close()
    }
  })
})
