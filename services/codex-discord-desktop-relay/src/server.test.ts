import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import type { CodexDiscordDesktopRelayConfig } from './config.js'
import { SafeStubDesktopAdapter } from './desktop-adapter.js'
import { DiscordPublisher, type DiscordPublisherTransport } from './discord-publisher.js'
import type {
  CodexDiscordDesktopRelayService,
  OperatorCloseChannelRequest,
  OperatorProtocolRunnerBindChannelRequest,
  OperatorRecoverPublishRequest,
  OperatorStartThreadRequest,
} from './relay-service.js'
import { createCodexDiscordDesktopRelayApp } from './server.js'
import { RelayStateStore } from './state-store.js'

class FakeDiscordPublisherTransport implements DiscordPublisherTransport {
  messages: Array<{ channelId: string; content: string }> = []

  async createMessage(channelId: string, content: string): Promise<{ messageId: string }> {
    this.messages.push({ channelId, content })
    return { messageId: `message-${this.messages.length}` }
  }
}

class MutatingDiscordPublisherTransport extends FakeDiscordPublisherTransport {
  afterCreateMessage: (() => Promise<void>) | null = null

  override async createMessage(channelId: string, content: string): Promise<{ messageId: string }> {
    const result = await super.createMessage(channelId, content)
    await this.afterCreateMessage?.()
    return result
  }
}

function createConfig(
  stateDir: string,
  overrides: Partial<Pick<CodexDiscordDesktopRelayConfig, 'operatorEnabled' | 'operatorBearerToken'>> = {},
): CodexDiscordDesktopRelayConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    stateDir,
    allowedCwd: 'C:\\dev\\protocol-runner',
    windowTitle: 'Codex',
    desktopAdapterMode: 'stub',
    desktopActionMode: 'focus',
    desktopApiBaseUrl: 'http://127.0.0.1:4825',
    desktopApiBearerToken: null,
    desktopApiTimeoutMs: 60000,
    pollIntervalMs: 2500,
    publishBearerToken: 'publish-secret',
    operatorEnabled: overrides.operatorEnabled ?? false,
    operatorBearerToken: overrides.operatorBearerToken ?? null,
    logFilePath: null,
    orchestration: {
      enabled: true,
      pythonPath: 'python',
      cliPath: 'C:\\dev\\protocol-runner\\scripts\\tools\\codex_orchestrate.py',
      dbPath: null,
      exportRoot: null,
      timeoutMs: 30000,
    },
    discord: {
      apiBaseUrl: 'https://discord.com/api/v10',
      botToken: 'bot-token',
      guildId: 'guild-1',
      commandChannelId: 'command-1',
      textChannelParentId: null,
      channelNamePrefix: 'codex',
    },
  }
}

function createFakeRelay() {
  const requests: OperatorStartThreadRequest[] = []
  const protocolRunnerBindRequests: OperatorProtocolRunnerBindChannelRequest[] = []
  const closeRequests: OperatorCloseChannelRequest[] = []
  const recoverRequests: OperatorRecoverPublishRequest[] = []
  const relay = {
    operatorStartThread: async (request: OperatorStartThreadRequest) => {
      requests.push(request)
      return {
        ok: true,
        channelId: 'channel-operator',
        channelName: 'codex-operator',
        channelUrl: 'https://discord.test/channel-operator',
        shortLabel: 1,
        bindingId: 'bind-operator',
        status: 'needs_manual_binding',
        bindingNoteStatus: 'injected',
        desktopThreadLabel: null,
        promptSubmitted: false,
        desktopResult: null,
      }
    },
    operatorProtocolRunnerBindChannel: async (request: OperatorProtocolRunnerBindChannelRequest) => {
      protocolRunnerBindRequests.push(request)
      return {
        ok: true,
        channelId: 'channel-protocol-runner',
        channelName: 'codex-protocol-runner-run-one',
        channelUrl: 'https://discord.test/channel-protocol-runner',
        shortLabel: 2,
        bindingId: 'bind-protocol-runner',
        status: 'ready',
        bindingNoteStatus: 'pending',
        desktopThreadLabel: request.threadTitle ?? null,
        codexThreadId: request.threadId ?? null,
      }
    },
    operatorCloseChannel: async (request: OperatorCloseChannelRequest) => {
      closeRequests.push(request)
      return {
        ok: true,
        channelId: request.channelId ?? 'channel-operator',
        channelName: 'codex-operator',
        desktopThreadLabel: null,
        status: 'ready',
        shortLabel: 1,
        deletedDiscordChannel: true,
        removedMapping: true,
        discordDeleteStatus: 'deleted',
      }
    },
    operatorRecoverPublish: async (request: OperatorRecoverPublishRequest) => {
      recoverRequests.push(request)
      return {
        ok: true,
        channelId: request.channelId ?? 'channel-operator',
        channelName: 'codex-operator',
        desktopThreadLabel: 'Operator worker thread',
        bindingId: 'bind-operator',
        status: 'waiting_for_codex',
        desktopResult: {
          result: 'submitted',
          message: null,
          desktopThreadLabel: 'Operator worker thread',
        },
        reminderMessageId: 'message-reminder',
      }
    },
  } as unknown as CodexDiscordDesktopRelayService
  return { relay, requests, protocolRunnerBindRequests, closeRequests, recoverRequests }
}

async function createTestServer(
  stateDir: string,
  transport = new FakeDiscordPublisherTransport(),
  configOverrides: Partial<Pick<CodexDiscordDesktopRelayConfig, 'operatorEnabled' | 'operatorBearerToken'>> = {},
  relay?: CodexDiscordDesktopRelayService,
) {
  const config = createConfig(stateDir, configOverrides)
  const store = new RelayStateStore(stateDir, {
    guildId: config.discord.guildId,
    commandChannelId: config.discord.commandChannelId,
  })
  const app = createCodexDiscordDesktopRelayApp({
    config,
    desktop: new SafeStubDesktopAdapter(config.windowTitle),
    publisher: new DiscordPublisher(transport),
    relay,
    store,
  })
  const server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('relay test server did not bind')
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    store,
    transport,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

function authHeaders() {
  return {
    Authorization: 'Bearer publish-secret',
    'Content-Type': 'application/json',
  }
}

test('health is open, readyz reports safe stub unavailable, and APIs require bearer auth', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-server-auth-'))
  const server = await createTestServer(stateDir)

  try {
    const health = await fetch(`${server.baseUrl}/healthz`)
    assert.equal(health.status, 200)

    const ready = await fetch(`${server.baseUrl}/readyz`)
    assert.equal(ready.status, 503)
    const readyJson = (await ready.json()) as { desktop: { mode: string; reason: string } }
    assert.equal(readyJson.desktop.mode, 'stub')
    assert.equal(readyJson.desktop.reason, 'desktop_api_adapter_not_enabled')

    const unauthorized = await fetch(`${server.baseUrl}/api/state`)
    assert.equal(unauthorized.status, 401)
  } finally {
    await server.close()
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('operator endpoints require explicit operator mode and operator bearer token', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-server-operator-auth-'))
  const disabled = await createTestServer(stateDir)

  try {
    const disabledResponse = await fetch(`${disabled.baseUrl}/api/operator/state`, {
      headers: { Authorization: 'Bearer operator-secret' },
    })
    assert.equal(disabledResponse.status, 403)
    assert.deepEqual(await disabledResponse.json(), { ok: false, error: 'operator_disabled' })
  } finally {
    await disabled.close()
  }

  const enabled = await createTestServer(
    stateDir,
    new FakeDiscordPublisherTransport(),
    { operatorEnabled: true, operatorBearerToken: 'operator-secret' },
  )
  try {
    const unauthorized = await fetch(`${enabled.baseUrl}/api/operator/state`, {
      headers: { Authorization: 'Bearer publish-secret' },
    })
    assert.equal(unauthorized.status, 401)

    const authorized = await fetch(`${enabled.baseUrl}/api/operator/state`, {
      headers: { Authorization: 'Bearer operator-secret' },
    })
    assert.equal(authorized.status, 200)
    const state = (await authorized.json()) as { commandChannelId: string }
    assert.equal(state.commandChannelId, 'command-1')
  } finally {
    await enabled.close()
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('operator start-thread endpoint delegates to the relay with sanitized request fields', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-server-operator-start-'))
  const fakeRelay = createFakeRelay()
  const server = await createTestServer(
    stateDir,
    new FakeDiscordPublisherTransport(),
    { operatorEnabled: true, operatorBearerToken: 'operator-secret' },
    fakeRelay.relay,
  )

  try {
    const response = await fetch(`${server.baseUrl}/api/operator/start-thread`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer operator-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: '  Worker Thread  ',
        prompt: 'Do a bounded task.',
        correlationId: '  corr-1  ',
      }),
    })

    assert.equal(response.status, 201)
    const body = (await response.json()) as { ok: boolean; channelId: string; bindingId: string }
    assert.equal(body.ok, true)
    assert.equal(body.channelId, 'channel-operator')
    assert.equal(body.bindingId, 'bind-operator')
    assert.deepEqual(fakeRelay.requests, [
      {
        title: 'Worker Thread',
        prompt: 'Do a bounded task.',
        correlationId: 'corr-1',
      },
    ])
  } finally {
    await server.close()
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('operator close-channel endpoint delegates to the relay with sanitized request fields', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-server-operator-close-'))
  const fakeRelay = createFakeRelay()
  const server = await createTestServer(
    stateDir,
    new FakeDiscordPublisherTransport(),
    { operatorEnabled: true, operatorBearerToken: 'operator-secret' },
    fakeRelay.relay,
  )

  try {
    const response = await fetch(`${server.baseUrl}/api/operator/close-channel`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer operator-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        channelId: '  channel-operator  ',
        force: true,
        correlationId: '  cleanup-1  ',
      }),
    })

    assert.equal(response.status, 200)
    const body = (await response.json()) as { ok: boolean; channelId: string; removedMapping: boolean }
    assert.equal(body.ok, true)
    assert.equal(body.channelId, 'channel-operator')
    assert.equal(body.removedMapping, true)
    assert.equal(fakeRelay.closeRequests.length, 1)
    assert.deepEqual(fakeRelay.closeRequests[0], {
      channelId: 'channel-operator',
      shortLabel: undefined,
      desktopThreadLabel: undefined,
      force: true,
      correlationId: 'cleanup-1',
    })
  } finally {
    await server.close()
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('operator protocol-runner bind-channel endpoint delegates to the relay with sanitized request fields', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-server-protocol-runner-bind-'))
  const fakeRelay = createFakeRelay()
  const server = await createTestServer(
    stateDir,
    new FakeDiscordPublisherTransport(),
    { operatorEnabled: true, operatorBearerToken: 'operator-secret' },
    fakeRelay.relay,
  )

  try {
    const response = await fetch(`${server.baseUrl}/api/operator/protocol-runner/bind-channel`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer operator-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        runInstanceId: '  run-one  ',
        threadTitle: '  Test Codex Thread  ',
        channelName: '  runner scratch  ',
        correlationId: '  pr-1  ',
      }),
    })

    assert.equal(response.status, 201)
    const body = (await response.json()) as { ok: boolean; channelId: string; bindingId: string; codexThreadId: string | null }
    assert.equal(body.ok, true)
    assert.equal(body.channelId, 'channel-protocol-runner')
    assert.equal(body.bindingId, 'bind-protocol-runner')
    assert.equal(body.codexThreadId, null)
    assert.deepEqual(fakeRelay.protocolRunnerBindRequests, [
      {
        runInstanceId: 'run-one',
        threadId: undefined,
        threadTitle: 'Test Codex Thread',
        channelName: 'runner scratch',
        correlationId: 'pr-1',
      },
    ])
  } finally {
    await server.close()
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('operator recover-publish endpoint delegates to the relay with sanitized request fields', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-server-operator-recover-'))
  const fakeRelay = createFakeRelay()
  const server = await createTestServer(
    stateDir,
    new FakeDiscordPublisherTransport(),
    { operatorEnabled: true, operatorBearerToken: 'operator-secret' },
    fakeRelay.relay,
  )

  try {
    const response = await fetch(`${server.baseUrl}/api/operator/recover-publish`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer operator-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        shortLabel: '5',
        correlationId: '  recover-1  ',
      }),
    })

    assert.equal(response.status, 202)
    const body = (await response.json()) as { ok: boolean; channelId: string; reminderMessageId: string }
    assert.equal(body.ok, true)
    assert.equal(body.channelId, 'channel-operator')
    assert.equal(body.reminderMessageId, 'message-reminder')
    assert.equal(fakeRelay.recoverRequests.length, 1)
    assert.deepEqual(fakeRelay.recoverRequests[0], {
      channelId: undefined,
      shortLabel: '5',
      desktopThreadLabel: undefined,
      correlationId: 'recover-1',
    })
  } finally {
    await server.close()
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('publish endpoint chunks Discord messages and marks the channel ready', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-publish-'))
  const server = await createTestServer(stateDir)
  const longText = `${'hello '.repeat(500)}done`

  try {
    const mapping = await server.store.ensureChannel({
      discordChannelId: 'channel-1',
      desktopThreadLabel: 'Thread One',
      status: 'waiting_for_codex',
    })
    const publish = await fetch(`${server.baseUrl}/api/publish`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        channelId: 'channel-1',
        bindingId: mapping.bindingId,
        text: longText,
        source: 'test',
        correlationId: 'corr-1',
      }),
    })

    assert.equal(publish.status, 201)
    const publishJson = (await publish.json()) as {
      ok: boolean
      channelId: string
      messageIds: string[]
      chunkCount: number
      textSha256: string
    }
    assert.equal(publishJson.ok, true)
    assert.equal(publishJson.channelId, 'channel-1')
    assert.equal(publishJson.chunkCount, 2)
    assert.deepEqual(publishJson.messageIds, ['message-1', 'message-2'])
    assert.match(publishJson.textSha256, /^[a-f0-9]{64}$/)
    assert.equal(server.transport.messages.length, 2)
    assert.ok(server.transport.messages[0]?.content.startsWith('(1/2)\n'))

    const state = await fetch(`${server.baseUrl}/api/state`, { headers: authHeaders() })
    const stateJson = (await state.json()) as {
      channels: Record<string, { status: string; lastOutboundMessageId: string }>
    }
    assert.equal(stateJson.channels['channel-1']?.status, 'ready')
    assert.equal(stateJson.channels['channel-1']?.lastOutboundMessageId, 'message-2')
  } finally {
    await server.close()
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('publish endpoint validates required request fields', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-publish-invalid-'))
  const server = await createTestServer(stateDir)

  try {
    const missingChannel = await fetch(`${server.baseUrl}/api/publish`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ text: 'hello' }),
    })
    assert.equal(missingChannel.status, 400)
    assert.deepEqual(await missingChannel.json(), { ok: false, error: 'channel_id_required' })

    const missingText = await fetch(`${server.baseUrl}/api/publish`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ channelId: 'channel-1', bindingId: 'bind-test' }),
    })
    assert.equal(missingText.status, 400)
    assert.deepEqual(await missingText.json(), { ok: false, error: 'text_required' })

    const missingBinding = await fetch(`${server.baseUrl}/api/publish`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ channelId: 'channel-1', text: 'hello' }),
    })
    assert.equal(missingBinding.status, 400)
    assert.deepEqual(await missingBinding.json(), { ok: false, error: 'binding_id_required' })
  } finally {
    await server.close()
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('publish endpoint refuses inactive or stale relay bindings before Discord publish', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-publish-binding-'))
  const server = await createTestServer(stateDir)

  try {
    const inactive = await fetch(`${server.baseUrl}/api/publish`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ channelId: 'channel-missing', bindingId: 'bind-missing', text: 'hello' }),
    })
    assert.equal(inactive.status, 409)
    assert.deepEqual(await inactive.json(), { ok: false, error: 'binding_not_active' })

    const mapping = await server.store.ensureChannel({
      discordChannelId: 'channel-1',
      desktopThreadLabel: 'Thread One',
      status: 'ready',
    })
    const stale = await fetch(`${server.baseUrl}/api/publish`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ channelId: 'channel-1', bindingId: `${mapping.bindingId}-old`, text: 'hello' }),
    })
    assert.equal(stale.status, 409)
    assert.deepEqual(await stale.json(), { ok: false, error: 'binding_mismatch' })
    assert.equal(server.transport.messages.length, 0)
  } finally {
    await server.close()
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('publish endpoint does not resurrect a mapping closed after Discord accepted the message', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-publish-close-race-'))
  const transport = new MutatingDiscordPublisherTransport()
  const server = await createTestServer(stateDir, transport)

  try {
    const mapping = await server.store.ensureChannel({
      discordChannelId: 'channel-1',
      desktopThreadLabel: 'Thread One',
      status: 'waiting_for_codex',
    })
    transport.afterCreateMessage = async () => {
      await server.store.deleteChannel('channel-1')
    }

    const publish = await fetch(`${server.baseUrl}/api/publish`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ channelId: 'channel-1', bindingId: mapping.bindingId, text: 'hello' }),
    })

    assert.equal(publish.status, 201)
    assert.equal(transport.messages.length, 1)
    assert.equal((await server.store.read()).channels['channel-1'], undefined)
  } finally {
    await server.close()
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})
