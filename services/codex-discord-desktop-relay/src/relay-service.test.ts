import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import type { DiscordThreadMessage } from '@workstation-control/discord-transport'

import type { CodexDiscordDesktopRelayConfig } from './config.js'
import type { DesktopAdapter, DesktopAdapterState, DesktopPromptResult, DesktopThreadSummary } from './desktop-adapter.js'
import type {
  OrchestrationBindWorkerResult,
  OrchestrationClient,
  OrchestrationCollectResult,
  OrchestrationDecision,
  OrchestrationRun,
  OrchestrationTurnStateObservation,
  OrchestrationWorker,
} from './orchestration-client.js'
import { CodexDiscordDesktopRelayService, sanitizeDiscordTextChannelName, type RelayDiscordTransport } from './relay-service.js'
import { RelayStateStore } from './state-store.js'

class FakeDiscordTransport implements RelayDiscordTransport {
  private nextMessageId = 1
  private nextChannelId = 1
  readonly messages = new Map<string, DiscordThreadMessage[]>()
  readonly createdChannels: Array<{ name: string; parentChannelId: string | null; channelId: string }> = []
  readonly renamedChannels: Array<{ channelId: string; name: string }> = []
  readonly deletedChannels: string[] = []
  readonly deleteFailures = new Map<string, Error>()

  constructor(commandChannelId: string) {
    this.messages.set(commandChannelId, [])
  }

  async createMessage(channelId: string, content: string): Promise<{ messageId: string }> {
    const message = this.makeMessage(content, true)
    this.messages.set(channelId, [...(this.messages.get(channelId) ?? []), message])
    return { messageId: message.messageId }
  }

  async listMessages(channelId: string, afterMessageId: string | null): Promise<DiscordThreadMessage[]> {
    const messages = this.messages.get(channelId) ?? []
    if (!afterMessageId) {
      return structuredClone(messages)
    }
    const index = messages.findIndex((message) => message.messageId === afterMessageId)
    return structuredClone(index === -1 ? messages : messages.slice(index + 1))
  }

  async createTextChannel(
    name: string,
    parentChannelId: string | null = null,
  ): Promise<{ guildId: string; channelId: string; name: string; channelUrl: string | null }> {
    const channelId = `channel-${this.nextChannelId++}`
    this.createdChannels.push({ name, parentChannelId, channelId })
    this.messages.set(channelId, [])
    return { guildId: 'guild-1', channelId, name, channelUrl: `https://discord.test/${channelId}` }
  }

  async updateTextChannelName(channelId: string, name: string): Promise<{ channelId: string; name: string }> {
    this.renamedChannels.push({ channelId, name })
    return { channelId, name }
  }

  async deleteTextChannel(channelId: string): Promise<void> {
    const failure = this.deleteFailures.get(channelId)
    if (failure) {
      throw failure
    }
    this.deletedChannels.push(channelId)
    this.messages.delete(channelId)
  }

  pushHumanMessage(channelId: string, content: string): string {
    const message = this.makeMessage(content, false)
    this.messages.set(channelId, [...(this.messages.get(channelId) ?? []), message])
    return message.messageId
  }

  private makeMessage(content: string, authorIsBot: boolean): DiscordThreadMessage {
    const messageId = `message-${this.nextMessageId++}`
    return {
      messageId,
      authorId: authorIsBot ? 'bot-1' : 'user-1',
      authorDisplay: authorIsBot ? 'Relay Bot' : 'Operator',
      authorIsBot,
      content,
      createdAt: `2026-05-05T16:00:${String(this.nextMessageId).padStart(2, '0')}.000Z`,
      attachments: [],
    }
  }
}

class FakeDesktopAdapter implements DesktopAdapter {
  state: DesktopAdapterState = {
    available: false,
    mode: 'stub',
    windowTitle: 'Codex',
    reason: 'desktop_uia_adapter_not_implemented',
  }
  threads: DesktopThreadSummary[] = []
  submitted: Array<{ desktopThreadLabel: string; text: string }> = []
  created: string[] = []
  nextPromptResult: DesktopPromptResult | null = null
  nextCreateResult: DesktopPromptResult | null = null
  nextBindCurrentResult: DesktopPromptResult | null = null

  async getState(): Promise<DesktopAdapterState> {
    return this.state
  }

  async listThreads(): Promise<DesktopThreadSummary[]> {
    return this.threads
  }

  async submitPrompt(args: { desktopThreadLabel: string; text: string }): Promise<DesktopPromptResult> {
    this.submitted.push(args)
    if (this.nextPromptResult) {
      const result = this.nextPromptResult
      this.nextPromptResult = null
      return result
    }
    return {
      result: 'submitted',
      message: null,
      desktopThreadLabel: args.desktopThreadLabel,
    }
  }

  async createThread(args: { text: string }): Promise<DesktopPromptResult> {
    this.created.push(args.text)
    if (this.nextCreateResult) {
      const result = this.nextCreateResult
      this.nextCreateResult = null
      return result
    }
    return { result: 'refused', message: 'not implemented', desktopThreadLabel: null }
  }

  async bindCurrent(): Promise<DesktopPromptResult> {
    if (this.nextBindCurrentResult) {
      const result = this.nextBindCurrentResult
      this.nextBindCurrentResult = null
      return result
    }
    return { result: 'refused', message: 'not implemented', desktopThreadLabel: null }
  }
}

class FakeOrchestrationClient implements OrchestrationClient {
  runs: OrchestrationRun[] = []
  workers: OrchestrationWorker[] = []
  collectResult: OrchestrationCollectResult | null = null
  boardText = '# Fake board\n\n- ok\n'
  archived: OrchestrationRun[] = []
  bindings: OrchestrationBindWorkerResult[] = []
  turnStateObservations: Array<{
    runId?: string | null
    workerId?: string | null
    discordChannelId?: string | null
    desktopRelayBindingId?: string | null
    codexThreadLabel?: string | null
    turnState: 'idle' | 'working' | 'unknown'
    observedAt?: string | null
    source?: string | null
    metadata?: Record<string, unknown>
  }> = []

  async createRun(args: { title: string }): Promise<OrchestrationRun> {
    const run = { run_id: `run-${this.runs.length + 1}`, title: args.title, status: 'active' }
    this.runs.push(run)
    return run
  }

  async startWorker(args: {
    runId: string
    archetype: string
    title: string
    objective: string
  }): Promise<OrchestrationWorker> {
    const worker = {
      worker_id: `w${String(this.workers.length + 1).padStart(3, '0')}`,
      run_id: args.runId,
      title: args.title,
      archetype: args.archetype,
      status: 'queued',
      assignment: { objective: args.objective },
    }
    this.workers.push(worker)
    return worker
  }

  async bindWorker(args: {
    workerId: string
    discordChannelId: string
    discordChannelName?: string | null
    codexThreadLabel?: string | null
    desktopRelayBindingId: string
    status: string
    bindingStatus: string
    metadata?: Record<string, unknown>
  }): Promise<OrchestrationBindWorkerResult> {
    const worker = await this.getWorker({ workerId: args.workerId })
    worker.discord_channel_id = args.discordChannelId
    worker.codex_thread_label = args.codexThreadLabel ?? null
    worker.binding_id = args.desktopRelayBindingId
    worker.status = args.status
    const result = {
      worker,
      binding: {
        binding_id: `b-${args.workerId}`,
        run_id: worker.run_id,
        worker_id: worker.worker_id,
        binding_type: 'codex_discord_desktop_relay',
        discord_channel_id: args.discordChannelId,
        discord_channel_name: args.discordChannelName ?? null,
        codex_thread_label: args.codexThreadLabel ?? null,
        desktop_relay_binding_id: args.desktopRelayBindingId,
        status: args.bindingStatus,
        metadata: args.metadata,
      },
    }
    this.bindings.push(result)
    return result
  }

  async observeWorkerTurnState(args: {
    runId?: string | null
    workerId?: string | null
    discordChannelId?: string | null
    desktopRelayBindingId?: string | null
    codexThreadLabel?: string | null
    turnState: 'idle' | 'working' | 'unknown'
    observedAt?: string | null
    source?: string | null
    metadata?: Record<string, unknown>
  }): Promise<OrchestrationTurnStateObservation> {
    this.turnStateObservations.push(args)
    const worker =
      this.workers.find((candidate) => {
        if (args.workerId && candidate.worker_id === args.workerId) {
          return true
        }
        if (args.discordChannelId && candidate.discord_channel_id === args.discordChannelId) {
          return true
        }
        if (args.desktopRelayBindingId && candidate.binding_id === args.desktopRelayBindingId) {
          return true
        }
        return false
      }) ?? (await this.getWorker({ workerId: args.workerId ?? 'w001' }))
    const statusBefore = worker.status
    if (args.turnState === 'working' && ['queued', 'active', 'waiting', 'stale'].includes(worker.status)) {
      worker.status = 'active'
    } else if (args.turnState === 'idle' && ['queued', 'active', 'waiting', 'stale'].includes(worker.status)) {
      worker.status = 'waiting'
    }
    return {
      run_id: args.runId ?? worker.run_id,
      worker_id: worker.worker_id,
      turn_state: args.turnState,
      previous_turn_state: null,
      changed: true,
      status_before: statusBefore,
      status_after: worker.status,
      event_recorded: true,
    }
  }

  async getWorker(args: { workerId: string }): Promise<OrchestrationWorker> {
    return (
      this.workers.find((worker) => worker.worker_id === args.workerId) ?? {
        worker_id: args.workerId,
        run_id: 'run-1',
        title: 'Missing fake',
        archetype: 'Fake',
        status: 'unknown',
      }
    )
  }

  async listWorkers(args: { runId: string }): Promise<OrchestrationWorker[]> {
    return this.workers.filter((worker) => worker.run_id === args.runId)
  }

  async collect(args: { runId: string }): Promise<OrchestrationCollectResult> {
    return (
      this.collectResult ?? {
        run_id: args.runId,
        reports: [],
        open_decisions: [],
      }
    )
  }

  async resolveDecision(args: { decisionId: string; resolution: string }): Promise<OrchestrationDecision> {
    return {
      decision_id: args.decisionId,
      run_id: 'run-1',
      status: 'resolved',
      title: args.resolution,
      prompt: 'fake prompt',
      resolution: args.resolution,
    }
  }

  async closeWorker(args: { workerId: string }): Promise<OrchestrationWorker> {
    const worker = await this.getWorker(args)
    worker.status = 'archived'
    return worker
  }

  async board(): Promise<string> {
    return this.boardText
  }

  async archiveRun(args: { runId: string }): Promise<OrchestrationRun> {
    const run = {
      run_id: args.runId,
      title: 'Archived fake run',
      status: 'archived',
      export: { export_dir: 'C:\\exports\\run-1' },
    }
    this.archived.push(run)
    return run
  }
}

function createConfig(stateDir: string): CodexDiscordDesktopRelayConfig {
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
    operatorEnabled: false,
    operatorBearerToken: null,
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
      textChannelParentId: 'category-1',
      channelNamePrefix: 'codex',
    },
  }
}

async function createService(stateDir: string) {
  const config = createConfig(stateDir)
  const discord = new FakeDiscordTransport(config.discord.commandChannelId)
  const desktop = new FakeDesktopAdapter()
  const store = new RelayStateStore(stateDir, {
    guildId: config.discord.guildId,
    commandChannelId: config.discord.commandChannelId,
  })
  const service = new CodexDiscordDesktopRelayService({ config, desktop, discord, store })
  return { config, desktop, discord, service, store }
}

async function createServiceWithOrchestration(stateDir: string) {
  const config = createConfig(stateDir)
  const discord = new FakeDiscordTransport(config.discord.commandChannelId)
  const desktop = new FakeDesktopAdapter()
  const orchestration = new FakeOrchestrationClient()
  const store = new RelayStateStore(stateDir, {
    guildId: config.discord.guildId,
    commandChannelId: config.discord.commandChannelId,
  })
  const service = new CodexDiscordDesktopRelayService({ config, desktop, discord, orchestration, store })
  return { config, desktop, discord, orchestration, service, store }
}

function makeThread(
  label: string,
  overrides: Partial<Omit<DesktopThreadSummary, 'label'>> = {},
): DesktopThreadSummary {
  return {
    label,
    group: overrides.group ?? 'unknown',
    visible: overrides.visible ?? true,
    turnState: overrides.turnState ?? 'idle',
    indicatorText: overrides.indicatorText ?? null,
    indicatorReason: overrides.indicatorReason ?? null,
  }
}

test('sanitizeDiscordTextChannelName creates stable Discord-safe names', () => {
  assert.equal(sanitizeDiscordTextChannelName('My Great Thread!', 'codex'), 'codex-my-great-thread')
  assert.ok(sanitizeDiscordTextChannelName('x'.repeat(200), 'codex').length <= 90)
})

test('operatorProtocolRunnerBindChannel creates an inspectable channel without sending a desktop prompt', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-service-protocol-runner-bind-'))
  const { config, desktop, discord, service, store } = await createService(stateDir)

  try {
    const result = await service.operatorProtocolRunnerBindChannel({
      runInstanceId: 'run_slice_5',
      threadTitle: 'Protocol Runner Test Thread',
      channelName: 'runner slice 5',
      correlationId: 'corr-slice-5',
    })

    assert.equal(result.ok, true)
    assert.equal(result.channelId, 'channel-1')
    assert.equal(result.channelName, 'codex-runner-slice-5')
    assert.equal(result.channelUrl, 'https://discord.test/channel-1')
    assert.equal(result.codexThreadId, null)
    assert.equal(result.desktopThreadLabel, 'Protocol Runner Test Thread')
    assert.equal(result.status, 'ready')
    assert.equal(result.bindingNoteStatus, 'pending')
    assert.equal(discord.createdChannels.length, 1)
    assert.equal(discord.createdChannels[0]?.parentChannelId, config.discord.textChannelParentId)
    assert.equal(desktop.created.length, 0)
    assert.equal(desktop.submitted.length, 0)
    assert.match(discord.messages.get('channel-1')?.at(-1)?.content ?? '', /did not send a runner prompt/)

    const state = await store.read()
    const mapping = state.channels['channel-1']
    assert.equal(mapping?.createdBy, 'operator')
    assert.equal(mapping?.purpose, 'protocol_runner')
    assert.equal(mapping?.status, 'ready')
    assert.equal(mapping?.codexThreadId, null)
    assert.equal(mapping?.desktopThreadLabel, 'Protocol Runner Test Thread')
    assert.equal(mapping?.bindingId, result.bindingId)
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('pollOnce handles help and start-new-thread command messages', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-service-command-'))
  const { config, discord, service, store } = await createService(stateDir)

  try {
    discord.pushHumanMessage(config.discord.commandChannelId, 'help')
    discord.pushHumanMessage(config.discord.commandChannelId, 'start new thread')

    const result = await service.pollOnce()
    assert.equal(result.commandMessagesSeen, 2)
    assert.ok(result.actions.includes('help'))
    assert.ok(result.actions.includes('start_new_thread_channel_created'))
    assert.equal(discord.createdChannels.length, 1)
    assert.equal(discord.createdChannels[0]?.parentChannelId, 'category-1')
    const commandMessages = discord.messages.get(config.discord.commandChannelId) ?? []
    const helpMessages = commandMessages.slice(2, -1)
    assert.ok(helpMessages.length > 1)
    assert.match(helpMessages[0]?.content ?? '', /Codex Desktop relay commands/)
    assert.ok(helpMessages.every((message) => message.content.length <= 1900))

    const state = await store.read()
    const created = Object.values(state.channels)[0]
    assert.equal(created?.discordChannelId, 'channel-1')
    assert.equal(created?.status, 'needs_manual_binding')
    assert.equal(created?.createdByCommandMessageId, 'message-2')
    assert.match(discord.messages.get(config.discord.commandChannelId)?.at(-1)?.content ?? '', /Created relay text channel/)
    assert.match(discord.messages.get('channel-1')?.at(-1)?.content ?? '', /Send the first prompt/)
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('pollOnce handles orchestration run and records refused worker companion binding', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-service-orchestration-'))
  const { config, desktop, discord, orchestration, service, store } = await createServiceWithOrchestration(stateDir)

  try {
    discord.pushHumanMessage(config.discord.commandChannelId, '@YourBot start orchestration run Mobile control build')
    const created = await service.pollOnce()
    assert.ok(created.actions.includes('orchestration_run_created'))
    assert.equal((await store.read()).orchestration.activeRunId, 'run-1')
    assert.match(discord.messages.get(config.discord.commandChannelId)?.at(-1)?.content ?? '', /Active orchestration run created/)

    discord.pushHumanMessage(
      config.discord.commandChannelId,
      '@YourBot start worker Parallel Build: implement the command handler',
    )
    const worker = await service.pollOnce()
    assert.ok(worker.actions.includes('orchestration_worker_started'))
    assert.ok(worker.actions.includes('orchestration_worker_prompt_not_submitted'))
    assert.equal(orchestration.workers[0]?.run_id, 'run-1')
    assert.equal(orchestration.workers[0]?.archetype, 'Parallel Build')
    assert.equal(orchestration.workers[0]?.assignment?.objective, 'implement the command handler')
    assert.equal(desktop.created.length, 1)
    assert.equal(desktop.submitted.length, 0)
    assert.match(desktop.created[0] ?? '', /Worker id: w001/)
    assert.match(desktop.created[0] ?? '', /codex_orchestrate.py report --run-id run-1 --worker-id w001/)
    assert.equal(discord.createdChannels.length, 1)
    assert.equal(orchestration.bindings[0]?.binding.discord_channel_id, 'channel-1')
    assert.equal(orchestration.bindings[0]?.worker.status, 'blocked')
    assert.match(discord.messages.get(config.discord.commandChannelId)?.at(-1)?.content ?? '', /prompt was not submitted/)

    discord.pushHumanMessage(config.discord.commandChannelId, '@YourBot show run board')
    const board = await service.pollOnce()
    assert.ok(board.actions.includes('orchestration_board'))
    assert.match(discord.messages.get(config.discord.commandChannelId)?.at(-1)?.content ?? '', /# Fake board/)

    orchestration.boardText = 'x'.repeat(4000)
    const beforeLongBoard = discord.messages.get(config.discord.commandChannelId)?.length ?? 0
    discord.pushHumanMessage(config.discord.commandChannelId, '@YourBot show run board')
    const longBoard = await service.pollOnce()
    const longBoardMessages = (discord.messages.get(config.discord.commandChannelId) ?? []).slice(beforeLongBoard + 1)
    assert.ok(longBoard.actions.includes('orchestration_board'))
    assert.equal(longBoardMessages.length, 3)
    assert.ok(longBoardMessages.every((message) => message.content.length <= 1900))
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('pollOnce submits Codex Desktop worker prompt when orchestration start worker is accepted', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-service-orchestration-submit-'))
  const { config, desktop, discord, orchestration, service, store } = await createServiceWithOrchestration(stateDir)

  try {
    await store.setActiveOrchestrationRun('run-1')
    desktop.nextCreateResult = { result: 'submitted', message: null, desktopThreadLabel: 'Parallel Build Worker' }
    discord.pushHumanMessage(
      config.discord.commandChannelId,
      '@YourBot start worker Parallel Build: implement the command handler',
    )

    const result = await service.pollOnce()

    assert.ok(result.actions.includes('orchestration_worker_started'))
    assert.ok(result.actions.includes('orchestration_worker_prompt_submitted'))
    assert.equal(orchestration.workers[0]?.status, 'active')
    assert.equal(orchestration.workers[0]?.discord_channel_id, 'channel-1')
    assert.equal(orchestration.workers[0]?.codex_thread_label, 'Parallel Build Worker')
    assert.match(desktop.created[0] ?? '', /Codex multi-thread orchestration worker assignment/)
    assert.match(desktop.created[0] ?? '', /Publish only the final visible assistant response/)
    assert.match(discord.messages.get(config.discord.commandChannelId)?.at(-1)?.content ?? '', /prompt submitted/)
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('pollOnce records worker desktop identity from current Visible Desktop Read fallback', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-service-orchestration-identity-fallback-'))
  const { config, desktop, discord, orchestration, service, store } = await createServiceWithOrchestration(stateDir)

  try {
    await store.setActiveOrchestrationRun('run-1')
    desktop.nextCreateResult = { result: 'submitted', message: null, desktopThreadLabel: null }
    desktop.nextBindCurrentResult = { result: 'submitted', message: null, desktopThreadLabel: 'Fallback Worker Thread' }
    discord.pushHumanMessage(
      config.discord.commandChannelId,
      '@YourBot start worker Parallel Build: implement the command handler',
    )

    const result = await service.pollOnce()

    assert.ok(result.actions.includes('orchestration_worker_prompt_submitted'))
    assert.equal(orchestration.workers[0]?.status, 'active')
    assert.equal(orchestration.workers[0]?.codex_thread_label, 'Fallback Worker Thread')
    assert.deepEqual(discord.renamedChannels, [{ channelId: 'channel-1', name: 'codex-fallback-worker-thread' }])
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('pollOnce handles orchestration collect, decision, worker close, and run archive commands', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-service-orchestration-ops-'))
  const { config, discord, orchestration, service, store } = await createServiceWithOrchestration(stateDir)

  try {
    await store.setActiveOrchestrationRun('run-1')
    orchestration.workers.push({
      worker_id: 'w001',
      run_id: 'run-1',
      title: 'Parallel Build',
      archetype: 'Parallel Build',
      status: 'active',
      assignment: { objective: 'Build a slice.' },
    })
    orchestration.collectResult = {
      run_id: 'run-1',
      reports: [{ report_id: 'r-1', worker_id: 'w001', report_type: 'status', summary: 'halfway done' }],
      open_decisions: [
        {
          decision_id: 'd-1',
          run_id: 'run-1',
          worker_id: 'w001',
          status: 'open',
          title: 'Choose path',
          prompt: 'A or B?',
        },
      ],
    }

    discord.pushHumanMessage(config.discord.commandChannelId, '@YourBot collect reports')
    const collected = await service.pollOnce()
    assert.ok(collected.actions.includes('orchestration_reports_collected'))
    assert.match(discord.messages.get(config.discord.commandChannelId)?.at(-1)?.content ?? '', /halfway done/)

    discord.pushHumanMessage(config.discord.commandChannelId, '@YourBot resolve decision d-1: use A')
    const resolved = await service.pollOnce()
    assert.ok(resolved.actions.includes('orchestration_decision_resolved'))
    assert.match(discord.messages.get(config.discord.commandChannelId)?.at(-1)?.content ?? '', /Resolved/)

    discord.pushHumanMessage(config.discord.commandChannelId, '@YourBot close worker 1')
    const closed = await service.pollOnce()
    assert.ok(closed.actions.includes('orchestration_worker_closed'))
    assert.match(discord.messages.get(config.discord.commandChannelId)?.at(-1)?.content ?? '', /w001/)

    discord.pushHumanMessage(config.discord.commandChannelId, '@YourBot archive run')
    const archived = await service.pollOnce()
    assert.ok(archived.actions.includes('orchestration_run_archived'))
    assert.equal((await store.read()).orchestration.activeRunId, null)
    assert.equal((await store.read()).orchestration.lastRunId, 'run-1')
    assert.match(discord.messages.get(config.discord.commandChannelId)?.at(-1)?.content ?? '', /Archived orchestration run/)
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('pollOnce handles active-run management commands', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-service-active-run-'))
  const { config, discord, service, store } = await createServiceWithOrchestration(stateDir)

  try {
    discord.pushHumanMessage(config.discord.commandChannelId, '@YourBot show active run')
    const none = await service.pollOnce()
    assert.ok(none.actions.includes('orchestration_active_run_none'))
    assert.match(discord.messages.get(config.discord.commandChannelId)?.at(-1)?.content ?? '', /No active/)

    discord.pushHumanMessage(config.discord.commandChannelId, '@YourBot switch active run run-manual')
    const switched = await service.pollOnce()
    assert.ok(switched.actions.includes('orchestration_active_run_switched'))
    assert.equal((await store.read()).orchestration.activeRunId, 'run-manual')

    discord.pushHumanMessage(config.discord.commandChannelId, '@YourBot show active run')
    const shown = await service.pollOnce()
    assert.ok(shown.actions.includes('orchestration_active_run_shown'))
    assert.match(discord.messages.get(config.discord.commandChannelId)?.at(-1)?.content ?? '', /run-manual/)

    discord.pushHumanMessage(config.discord.commandChannelId, '@YourBot clear active run')
    const cleared = await service.pollOnce()
    assert.ok(cleared.actions.includes('orchestration_active_run_cleared'))
    assert.equal((await store.read()).orchestration.activeRunId, null)
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('pollOnce refreshes orchestration worker identity from the selected desktop thread', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-service-refresh-worker-identity-'))
  const { config, desktop, discord, orchestration, service, store } = await createServiceWithOrchestration(stateDir)

  try {
    await store.setActiveOrchestrationRun('run-1')
    await store.ensureChannel({
      discordChannelId: 'channel-1',
      discordChannelName: 'codex-w001-worker',
      status: 'needs_manual_binding',
      createdBy: 'operator',
    })
    orchestration.workers.push({
      worker_id: 'w001',
      run_id: 'run-1',
      title: 'Investigation Swarm',
      archetype: 'Investigation Swarm',
      status: 'blocked',
      discord_channel_id: 'channel-1',
      binding_id: 'bind-old',
      assignment: { objective: 'Inspect the worker lane.' },
    })
    desktop.nextBindCurrentResult = {
      result: 'submitted',
      message: null,
      desktopThreadLabel: 'Investigation worker lane',
    }

    discord.pushHumanMessage(config.discord.commandChannelId, '@YourBot refresh worker identity 1')
    const result = await service.pollOnce()

    assert.ok(result.actions.includes('orchestration_worker_identity_refreshed'))
    assert.equal(orchestration.workers[0]?.status, 'active')
    assert.equal(orchestration.workers[0]?.codex_thread_label, 'Investigation worker lane')
    assert.equal((await store.read()).channels['channel-1']?.desktopThreadLabel, 'Investigation worker lane')
    assert.deepEqual(discord.renamedChannels, [{ channelId: 'channel-1', name: 'codex-investigation-worker-lane' }])
    assert.match(discord.messages.get(config.discord.commandChannelId)?.at(-1)?.content ?? '', /Identity source: current_desktop_selection/)
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('pollOnce cleanup worker deletes companion mapping and archives worker', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-service-cleanup-worker-'))
  const { config, discord, orchestration, service, store } = await createServiceWithOrchestration(stateDir)

  try {
    await store.setActiveOrchestrationRun('run-1')
    await store.ensureChannel({
      discordChannelId: 'channel-1',
      discordChannelName: 'codex-w001-test',
      status: 'ready',
      createdBy: 'operator',
    })
    orchestration.workers.push({
      worker_id: 'w001',
      run_id: 'run-1',
      title: 'Investigation Swarm',
      archetype: 'Investigation Swarm',
      status: 'complete',
      discord_channel_id: 'channel-1',
    })

    discord.pushHumanMessage(config.discord.commandChannelId, '@YourBot cleanup worker 1')
    const result = await service.pollOnce()

    assert.ok(result.actions.includes('orchestration_worker_cleaned_up'))
    assert.ok(result.actions.includes('orchestration_worker_companion_deleted'))
    assert.deepEqual(discord.deletedChannels, ['channel-1'])
    assert.equal((await store.read()).channels['channel-1'], undefined)
    assert.equal(orchestration.workers[0]?.status, 'archived')
    assert.match(discord.messages.get(config.discord.commandChannelId)?.at(-1)?.content ?? '', /Cleaned up orchestration worker/)
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('pollOnce cleanup run collects reports, deletes companions, archives run, and clears active run', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-service-cleanup-run-'))
  const { config, discord, orchestration, service, store } = await createServiceWithOrchestration(stateDir)

  try {
    await store.setActiveOrchestrationRun('run-1')
    await store.ensureChannel({
      discordChannelId: 'channel-1',
      discordChannelName: 'codex-w001-test',
      status: 'ready',
      createdBy: 'operator',
    })
    await store.ensureChannel({
      discordChannelId: 'channel-2',
      discordChannelName: 'codex-w002-test',
      status: 'waiting_for_codex',
      createdBy: 'operator',
    })
    orchestration.workers.push(
      {
        worker_id: 'w001',
        run_id: 'run-1',
        title: 'Investigation Swarm',
        archetype: 'Investigation Swarm',
        status: 'complete',
        discord_channel_id: 'channel-1',
      },
      {
        worker_id: 'w002',
        run_id: 'run-1',
        title: 'Evaluation Runner',
        archetype: 'Evaluation / Benchmark Runner',
        status: 'active',
        discord_channel_id: 'channel-2',
      },
    )
    orchestration.collectResult = {
      run_id: 'run-1',
      reports: [{ report_id: 'r-1', worker_id: 'w001', report_type: 'final_report', summary: 'done' }],
      open_decisions: [],
    }

    discord.pushHumanMessage(config.discord.commandChannelId, '@YourBot cleanup run')
    const result = await service.pollOnce()

    assert.ok(result.actions.includes('orchestration_run_cleaned_up'))
    assert.deepEqual(discord.deletedChannels, ['channel-1', 'channel-2'])
    assert.equal((await store.read()).channels['channel-1'], undefined)
    assert.equal((await store.read()).channels['channel-2'], undefined)
    assert.equal((await store.read()).orchestration.activeRunId, null)
    assert.equal(orchestration.archived[0]?.run_id, 'run-1')
    assert.match(discord.messages.get(config.discord.commandChannelId)?.at(-1)?.content ?? '', /Companion channels: 2\/2 deleted/)
    assert.match(discord.messages.get(config.discord.commandChannelId)?.at(-1)?.content ?? '', /Reports collected: 1/)
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('pollOnce resolves numeric worker selectors against the active run', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-service-worker-selector-'))
  const { config, discord, orchestration, service, store } = await createServiceWithOrchestration(stateDir)

  try {
    await store.setActiveOrchestrationRun('run-2')
    orchestration.workers.push(
      {
        worker_id: 'w001',
        run_id: 'run-1',
        title: 'Old worker',
        archetype: 'Parallel Build',
        status: 'active',
      },
      {
        worker_id: 'w009',
        run_id: 'run-2',
        title: 'Active worker',
        archetype: 'Parallel Build',
        status: 'active',
      },
    )

    discord.pushHumanMessage(config.discord.commandChannelId, '@YourBot close worker 1')
    const result = await service.pollOnce()

    assert.ok(result.actions.includes('orchestration_worker_closed'))
    assert.equal(orchestration.workers.find((worker) => worker.worker_id === 'w001')?.status, 'active')
    assert.equal(orchestration.workers.find((worker) => worker.worker_id === 'w009')?.status, 'archived')
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('pollOnce syncs desktop turn-state transitions into orchestration registry', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-service-turn-state-'))
  const { desktop, orchestration, service, store } = await createServiceWithOrchestration(stateDir)

  try {
    desktop.state = { available: true, mode: 'api', windowTitle: 'Codex', reason: null }
    orchestration.workers.push({
      worker_id: 'w001',
      run_id: 'run-1',
      title: 'Observed worker',
      archetype: 'Parallel Build',
      status: 'waiting',
      discord_channel_id: 'channel-1',
      codex_thread_label: 'Observed desktop thread',
      binding_id: 'bind-observed',
    })
    await store.ensureChannel({
      discordChannelId: 'channel-1',
      discordChannelName: 'codex-observed',
      desktopThreadLabel: 'Observed desktop thread',
      status: 'ready',
    })
    const mapping = (await store.read()).channels['channel-1']
    assert.ok(mapping)
    orchestration.workers[0]!.binding_id = mapping.bindingId

    desktop.threads = [makeThread('Observed desktop thread', { turnState: 'working' })]
    const working = await service.pollOnce()
    assert.ok(working.actions.includes('turn_state_none_to_working'))
    assert.equal(orchestration.turnStateObservations[0]?.turnState, 'working')
    assert.equal(orchestration.workers[0]?.status, 'active')

    desktop.threads = [makeThread('Observed desktop thread', { turnState: 'idle' })]
    const idle = await service.pollOnce()
    assert.ok(idle.actions.includes('turn_state_working_to_idle'))
    assert.equal(orchestration.turnStateObservations.at(-1)?.turnState, 'idle')
    assert.equal(orchestration.workers[0]?.status, 'waiting')
    const finalMapping = (await store.read()).channels['channel-1']
    assert.equal(finalMapping?.lastDesktopTurnState, 'idle')
    assert.ok(finalMapping?.lastDesktopTurnStateRegistrySyncedAt)
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('pollOnce does not sync protocol-runner-owned channel turn states into orchestration registry', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-service-runner-turn-state-'))
  const { desktop, orchestration, service, store } = await createServiceWithOrchestration(stateDir)

  try {
    desktop.state = { available: true, mode: 'api', windowTitle: 'Codex', reason: null }
    await store.ensureChannel({
      discordChannelId: 'channel-runner',
      discordChannelName: 'codex-protocol-runner',
      desktopThreadLabel: 'Protocol runner target',
      codexThreadId: null,
      purpose: 'protocol_runner',
      status: 'ready',
      createdBy: 'operator',
    })

    desktop.threads = [makeThread('Protocol runner target', { turnState: 'working' })]
    const result = await service.pollOnce()

    assert.ok(result.actions.includes('turn_state_none_to_working'))
    assert.equal(orchestration.turnStateObservations.length, 0)
    const mapping = (await store.read()).channels['channel-runner']
    assert.equal(mapping?.lastDesktopTurnState, 'working')
    assert.equal(mapping?.lastDesktopTurnStateRegistrySyncedAt, null)
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('pollOnce stores the shown desktop thread list and picks up a numeric item', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-service-pickup-list-'))
  const { config, desktop, discord, service, store } = await createService(stateDir)

  try {
    desktop.state = { available: true, mode: 'api', windowTitle: 'Codex', reason: null }
    desktop.threads = [makeThread('Alpha desktop thread'), makeThread('Test Discord relay')]

    discord.pushHumanMessage(config.discord.commandChannelId, '<@123456789> show current threads')
    const shown = await service.pollOnce()
    assert.ok(shown.actions.includes('show_threads_all'))
    assert.match(discord.messages.get(config.discord.commandChannelId)?.at(-1)?.content ?? '', /2\. Test Discord relay/)
    assert.equal((await store.read()).lastDesktopThreadList?.items[1]?.label, 'Test Discord relay')

    discord.pushHumanMessage(config.discord.commandChannelId, '<@123456789> pickup 2')
    const pickedUp = await service.pollOnce()
    assert.ok(pickedUp.actions.includes('pickup_last_list_item'))
    assert.ok(pickedUp.actions.includes('pickup_channel_created'))
    assert.ok(pickedUp.actions.includes('binding_note_injected'))
    assert.equal(discord.createdChannels[0]?.name, 'codex-test-discord-relay')
    assert.equal(desktop.submitted.length, 1)
    assert.match(desktop.submitted[0]?.text ?? '', /Discord relay binding note/)
    const mapping = Object.values((await store.read()).channels)[0]
    assert.equal(mapping?.desktopThreadLabel, 'Test Discord relay')
    assert.equal(mapping?.status, 'ready')
    assert.equal(mapping?.bindingNoteStatus, 'injected')
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('pollOnce leaves pickup binding note pending while the desktop sidebar shows working', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-service-pickup-working-'))
  const { config, desktop, discord, service, store } = await createService(stateDir)

  try {
    desktop.state = { available: true, mode: 'api', windowTitle: 'Codex', reason: null }
    desktop.threads = [makeThread('Busy desktop thread', { turnState: 'working' })]

    discord.pushHumanMessage(config.discord.commandChannelId, 'show current threads')
    await service.pollOnce()
    discord.pushHumanMessage(config.discord.commandChannelId, 'pickup 1')
    const pickedUp = await service.pollOnce()

    assert.ok(pickedUp.actions.includes('binding_note_pending_working'))
    assert.equal(desktop.submitted.length, 0)
    const mapping = Object.values((await store.read()).channels)[0]
    assert.equal(mapping?.desktopThreadLabel, 'Busy desktop thread')
    assert.equal(mapping?.bindingNoteStatus, 'pending')
    assert.match(discord.messages.get(config.discord.commandChannelId)?.at(-2)?.content ?? '', /Run `refresh binding`/)
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('pollOnce reuses an existing mapped relay channel for a numeric pickup item', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-service-pickup-existing-'))
  const { config, desktop, discord, service, store } = await createService(stateDir)

  try {
    desktop.state = { available: true, mode: 'api', windowTitle: 'Codex', reason: null }
    desktop.threads = [makeThread('Alpha desktop thread'), makeThread('Test Discord relay')]
    await store.ensureChannel({
      discordChannelId: 'channel-existing',
      discordChannelName: 'codex-test-discord-relay',
      desktopThreadLabel: 'Test Discord relay',
      status: 'ready',
    })

    discord.pushHumanMessage(config.discord.commandChannelId, 'show current threads')
    await service.pollOnce()
    discord.pushHumanMessage(config.discord.commandChannelId, 'pickup 2')
    const result = await service.pollOnce()

    assert.ok(result.actions.includes('pickup_existing_desktop_mapping'))
    assert.equal(discord.createdChannels.length, 0)
    assert.match(discord.messages.get(config.discord.commandChannelId)?.at(-1)?.content ?? '', /Relay already exists/)
    assert.match(discord.messages.get(config.discord.commandChannelId)?.at(-1)?.content ?? '', /<#channel-existing>/)
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('pollOnce reuses an existing mapped relay channel for an exact-title pickup', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-service-pickup-title-existing-'))
  const { config, desktop, discord, service, store } = await createService(stateDir)

  try {
    await store.ensureChannel({
      discordChannelId: 'channel-existing',
      discordChannelName: 'codex-test-discord-relay',
      desktopThreadLabel: 'Test Discord relay',
      status: 'ready',
    })

    discord.pushHumanMessage(config.discord.commandChannelId, 'pickup "Test Discord relay"')
    const result = await service.pollOnce()

    assert.ok(result.actions.includes('pickup_existing_desktop_mapping'))
    assert.equal(desktop.submitted.length, 0)
    assert.equal(discord.createdChannels.length, 0)
    assert.match(discord.messages.get(config.discord.commandChannelId)?.at(-1)?.content ?? '', /<#channel-existing>/)
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('pollOnce forwards mapped prompt through desktop adapter with publish footer', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-service-prompt-'))
  const { config, desktop, discord, service, store } = await createService(stateDir)
  config.port = 16430

  try {
    const initial = await store.ensureChannel({
      discordChannelId: 'channel-1',
      discordChannelName: 'codex-existing',
      desktopThreadLabel: 'Existing desktop thread',
      status: 'ready',
    })
    discord.pushHumanMessage('channel-1', 'Please continue the work.')

    const result = await service.pollOnce()
    assert.equal(result.promptMessagesSeen, 1)
    assert.ok(result.actions.includes('prompt_submitted'))
    assert.ok(result.actions.includes('discord_channel_renamed'))
    assert.equal(desktop.submitted.length, 1)
    assert.equal(desktop.submitted[0]?.desktopThreadLabel, 'Existing desktop thread')
    assert.match(
      desktop.submitted[0]?.text ?? '',
      new RegExp(`codex_discord_publish.py' --base-url 'http://127.0.0.1:16430' --channel-id channel-1 --binding-id ${initial.bindingId}`),
    )
    assert.match(desktop.submitted[0]?.text ?? '', /Publish only the final visible assistant response/)
    assert.match(discord.messages.get('channel-1')?.at(-1)?.content ?? '', /Forwarded to Codex desktop/)
    assert.deepEqual(discord.renamedChannels, [{ channelId: 'channel-1', name: 'codex-existing-desktop-thread' }])

    const mapping = (await store.read()).channels['channel-1']
    assert.equal(mapping?.status, 'waiting_for_codex')
    assert.equal(mapping?.bindingNoteStatus, 'injected')
    assert.equal(mapping?.discordChannelName, 'codex-existing-desktop-thread')
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('pollOnce refreshes a binding note inside a mapped channel when the sidebar is idle', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-service-refresh-binding-'))
  const { desktop, discord, service, store } = await createService(stateDir)

  try {
    desktop.state = { available: true, mode: 'api', windowTitle: 'Codex', reason: null }
    desktop.threads = [makeThread('Existing desktop thread')]
    const mapping = await store.ensureChannel({
      discordChannelId: 'channel-1',
      discordChannelName: 'codex-existing',
      desktopThreadLabel: 'Existing desktop thread',
      status: 'ready',
      bindingNoteStatus: 'pending',
    })
    const humanMessageId = discord.pushHumanMessage('channel-1', '<@123456789> refresh binding')

    const result = await service.pollOnce()

    assert.ok(result.actions.includes('binding_note_injected'))
    assert.equal(desktop.submitted.length, 1)
    assert.equal(desktop.submitted[0]?.desktopThreadLabel, 'Existing desktop thread')
    assert.match(desktop.submitted[0]?.text ?? '', /Discord relay binding note/)
    assert.match(desktop.submitted[0]?.text ?? '', new RegExp(`Active binding id: ${mapping.bindingId}`))
    assert.match(desktop.submitted[0]?.text ?? '', /Publish only the final visible assistant response/)
    assert.doesNotMatch(desktop.submitted[0]?.text ?? '', /substantive/)
    const updated = (await store.read()).channels['channel-1']
    assert.equal(updated?.status, 'ready')
    assert.equal(updated?.bindingNoteStatus, 'injected')
    assert.equal(updated?.lastSeenMessageId, humanMessageId)
    assert.match(discord.messages.get('channel-1')?.at(-1)?.content ?? '', /Binding note injected/)

    await service.pollOnce()
    assert.equal(desktop.submitted.length, 1)
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('pollOnce refreshes a binding note from a command-channel selector', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-service-refresh-binding-command-'))
  const { config, desktop, discord, service, store } = await createService(stateDir)

  try {
    desktop.state = { available: true, mode: 'api', windowTitle: 'Codex', reason: null }
    desktop.threads = [makeThread('Existing desktop thread')]
    await store.ensureChannel({
      discordChannelId: 'channel-1',
      discordChannelName: 'codex-existing',
      desktopThreadLabel: 'Existing desktop thread',
      status: 'ready',
      bindingNoteStatus: 'pending',
    })
    discord.pushHumanMessage(config.discord.commandChannelId, '<@123456789> refresh binding Existing desktop thread')

    const result = await service.pollOnce()

    assert.ok(result.actions.includes('binding_note_injected'))
    assert.equal(desktop.submitted.length, 1)
    assert.match(discord.messages.get(config.discord.commandChannelId)?.at(-1)?.content ?? '', /Binding note injected/)
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('pollOnce refreshes a binding note when sidebar state is unknown but not working', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-service-refresh-binding-unknown-'))
  const { desktop, discord, service, store } = await createService(stateDir)

  try {
    desktop.state = { available: true, mode: 'api', windowTitle: 'Codex', reason: null }
    desktop.threads = [
      makeThread('Existing d\u00e9sktop thread', {
        turnState: 'unknown',
        indicatorReason: 'non_pinned_row_without_indicator_text',
      }),
    ]
    const mapping = await store.ensureChannel({
      discordChannelId: 'channel-1',
      discordChannelName: 'codex-existing',
      desktopThreadLabel: 'Existing desktop thread',
      status: 'error',
      bindingNoteStatus: 'pending',
    })
    discord.pushHumanMessage('channel-1', '<@123456789> refresh binding')

    const result = await service.pollOnce()

    assert.ok(result.actions.includes('binding_note_injected'))
    assert.equal(desktop.submitted.length, 1)
    assert.equal(desktop.submitted[0]?.desktopThreadLabel, 'Existing desktop thread')
    assert.match(desktop.submitted[0]?.text ?? '', new RegExp(`Active binding id: ${mapping.bindingId}`))
    const updated = (await store.read()).channels['channel-1']
    assert.equal(updated?.status, 'ready')
    assert.equal(updated?.desktopThreadLabel, 'Existing d\u00e9sktop thread')
    assert.equal(updated?.lastRefusalReason, null)
    assert.equal(updated?.bindingNoteStatus, 'injected')
    assert.match(discord.messages.get('channel-1')?.at(-1)?.content ?? '', /Binding note injected/)
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('pollOnce refuses mapped prompt when the desktop sidebar still shows working', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-service-working-refusal-'))
  const { desktop, discord, service, store } = await createService(stateDir)

  try {
    desktop.state = { available: true, mode: 'api', windowTitle: 'Codex', reason: null }
    desktop.threads = [
      makeThread('Existing desktop thread', {
        turnState: 'working',
        indicatorReason: 'sidebar_context_progress_indicator_likely',
      }),
    ]
    await store.ensureChannel({
      discordChannelId: 'channel-1',
      discordChannelName: 'codex-existing',
      desktopThreadLabel: 'Existing desktop thread',
      status: 'ready',
    })
    discord.pushHumanMessage('channel-1', 'Please continue the work.')

    const result = await service.pollOnce()

    assert.ok(result.actions.includes('prompt_refused_desktop_working'))
    assert.equal(desktop.submitted.length, 0)
    assert.match(discord.messages.get('channel-1')?.at(-1)?.content ?? '', /working indicator/)
    assert.equal((await store.read()).channels['channel-1']?.status, 'error')
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('pollOnce answers check inside a mapped channel from sidebar state', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-service-check-channel-'))
  const { desktop, discord, service, store } = await createService(stateDir)

  try {
    desktop.state = { available: true, mode: 'api', windowTitle: 'Codex', reason: null }
    desktop.threads = [makeThread('Existing desktop thread')]
    await store.ensureChannel({
      discordChannelId: 'channel-1',
      discordChannelName: 'codex-existing',
      desktopThreadLabel: 'Existing desktop thread',
      status: 'ready',
    })
    discord.pushHumanMessage('channel-1', '<@123456789> check')

    const result = await service.pollOnce()

    assert.ok(result.actions.includes('check_thread'))
    assert.equal(desktop.submitted.length, 0)
    assert.match(discord.messages.get('channel-1')?.at(-1)?.content ?? '', /Looks safe to prompt/)
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('operatorStartThread creates a companion channel without desktop mutation when no prompt is provided', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-service-operator-channel-'))
  const { desktop, discord, service, store } = await createService(stateDir)

  try {
    const result = await service.operatorStartThread({ title: 'Research Options' })

    assert.equal(result.ok, true)
    assert.equal(result.channelId, 'channel-1')
    assert.equal(result.channelName, 'codex-research-options')
    assert.equal(result.promptSubmitted, false)
    assert.equal(result.desktopResult, null)
    assert.equal(desktop.created.length, 0)
    assert.equal(discord.createdChannels[0]?.name, 'codex-research-options')
    assert.match(discord.messages.get('channel-1')?.at(-1)?.content ?? '', /waiting for manual binding/)

    const mapping = (await store.read()).channels['channel-1']
    assert.equal(mapping?.createdBy, 'operator')
    assert.equal(mapping?.status, 'needs_manual_binding')
    assert.equal(mapping?.bindingNoteStatus, 'injected')
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('operatorStartThread submits a new desktop thread prompt with the active binding footer', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-service-operator-prompt-'))
  const { desktop, discord, service, store } = await createService(stateDir)

  try {
    desktop.nextCreateResult = {
      result: 'submitted',
      message: null,
      desktopThreadLabel: 'Operator worker thread',
    }

    const result = await service.operatorStartThread({
      title: 'Worker Seed',
      prompt: 'Please do the bounded worker task.',
      correlationId: 'operator-test-1',
    })

    assert.equal(result.ok, true)
    assert.equal(result.promptSubmitted, true)
    assert.equal(result.desktopThreadLabel, 'Operator worker thread')
    assert.equal(result.status, 'waiting_for_codex')
    assert.equal(result.bindingNoteStatus, 'injected')
    assert.equal(desktop.created.length, 1)
    assert.match(desktop.created[0] ?? '', /Please do the bounded worker task/)
    assert.match(
      desktop.created[0] ?? '',
      new RegExp(`codex_discord_publish.py' --base-url 'http://127.0.0.1:0' --channel-id channel-1 --binding-id ${result.bindingId}`),
    )
    assert.match(desktop.created[0] ?? '', /operator-test-1/)
    assert.deepEqual(discord.renamedChannels, [{ channelId: 'channel-1', name: 'codex-operator-worker-thread' }])

    const mapping = (await store.read()).channels['channel-1']
    assert.equal(mapping?.createdBy, 'operator')
    assert.equal(mapping?.desktopThreadLabel, 'Operator worker thread')
    assert.equal(mapping?.status, 'waiting_for_codex')
    assert.equal(mapping?.bindingId, result.bindingId)
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('operatorStartThread captures current desktop label when create Visible Desktop Read omits it', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-service-operator-label-fallback-'))
  const { desktop, discord, service, store } = await createService(stateDir)

  try {
    desktop.nextCreateResult = {
      result: 'submitted',
      message: null,
      desktopThreadLabel: null,
    }
    desktop.nextBindCurrentResult = {
      result: 'submitted',
      message: null,
      desktopThreadLabel: 'Fallback worker thread',
    }

    const result = await service.operatorStartThread({
      title: 'Worker Seed',
      prompt: 'Please do the bounded worker task.',
      correlationId: 'operator-test-fallback',
    })

    assert.equal(result.ok, true)
    assert.equal(result.promptSubmitted, true)
    assert.equal(result.desktopThreadLabel, 'Fallback worker thread')
    assert.deepEqual(discord.renamedChannels, [{ channelId: 'channel-1', name: 'codex-fallback-worker-thread' }])

    const mapping = (await store.read()).channels['channel-1']
    assert.equal(mapping?.desktopThreadLabel, 'Fallback worker thread')
    assert.equal(mapping?.status, 'waiting_for_codex')
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('operatorStartThread leaves label unbound when create and current readback omit the exact desktop label', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-service-operator-label-missing-'))
  const { desktop, discord, service, store } = await createService(stateDir)

  try {
    desktop.nextCreateResult = {
      result: 'submitted',
      message: null,
      desktopThreadLabel: null,
    }

    const result = await service.operatorStartThread({
      title: 'w035 ceiling compact budget optimizer',
      prompt: [
        'w035 Ceiling compact budget optimizer',
        '',
        'Codex multi-thread orchestration worker assignment',
        '',
        'Run id: extctx-proof-20260508-b',
      ].join('\n'),
      correlationId: 'operator-test-worker-prefix',
    })

    assert.equal(result.ok, true)
    assert.equal(result.promptSubmitted, true)
    assert.equal(result.desktopThreadLabel, null)
    assert.deepEqual(discord.renamedChannels, [])

    const mapping = (await store.read()).channels['channel-1']
    assert.equal(mapping?.discordChannelName, 'codex-w035-ceiling-compact-budget-optimizer')
    assert.equal(mapping?.desktopThreadLabel, null)
    assert.equal(mapping?.status, 'waiting_for_codex')
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('operatorStartThread does not infer a desktop label when create verification is refused', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-service-operator-label-refused-'))
  const { desktop, discord, service, store } = await createService(stateDir)

  try {
    desktop.nextCreateResult = {
      result: 'refused',
      message: 'Codex desktop create-thread submit action could not verify the prompt in the new thread.',
      desktopThreadLabel: null,
    }

    const result = await service.operatorStartThread({
      title: 'w038 ceiling compact budget v2',
      prompt: [
        'w038 Ceiling compact budget v2',
        '',
        'Codex multi-thread orchestration worker assignment',
        '',
        'Run id: extctx-proof-20260508-b',
      ].join('\n'),
      correlationId: 'operator-test-worker-prefix-refused',
    })

    assert.equal(result.ok, true)
    assert.equal(result.promptSubmitted, false)
    assert.equal(result.desktopThreadLabel, null)
    assert.match(result.desktopResult?.message ?? '', /could not verify/)

    const mapping = (await store.read()).channels['channel-1']
    assert.equal(mapping?.desktopThreadLabel, null)
    assert.equal(mapping?.status, 'error')
    assert.equal(mapping?.bindingNoteStatus, 'pending')
    assert.match(discord.messages.get('channel-1')?.at(-1)?.content ?? '', /could not verify/)
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('operatorStartThread keeps the channel but records refusal when desktop creation is disabled', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-service-operator-refused-'))
  const { desktop, discord, service, store } = await createService(stateDir)

  try {
    const result = await service.operatorStartThread({
      title: 'Refused Worker',
      prompt: 'Try to create this worker.',
    })

    assert.equal(result.ok, true)
    assert.equal(result.promptSubmitted, false)
    assert.equal(result.desktopResult?.result, 'refused')
    assert.equal(desktop.created.length, 1)
    assert.match(discord.messages.get('channel-1')?.at(-1)?.content ?? '', /not implemented/)

    const mapping = (await store.read()).channels['channel-1']
    assert.equal(mapping?.createdBy, 'operator')
    assert.equal(mapping?.status, 'error')
    assert.equal(mapping?.bindingNoteStatus, 'pending')
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('operatorCloseChannel deletes a ready companion channel and mapping without desktop mutation', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-service-operator-close-'))
  const { desktop, discord, service, store } = await createService(stateDir)

  try {
    const mapping = await store.ensureChannel({
      discordChannelId: 'channel-1',
      discordChannelName: 'codex-operator-smoke',
      desktopThreadLabel: 'Operator smoke thread',
      status: 'ready',
      createdBy: 'operator',
    })

    const result = await service.operatorCloseChannel({ shortLabel: mapping.shortLabel, correlationId: 'cleanup-1' })

    assert.equal(result.ok, true)
    if (!result.ok) {
      assert.fail('operator close should have succeeded')
    }
    assert.equal(result.channelId, 'channel-1')
    assert.equal(result.removedMapping, true)
    assert.equal(result.discordDeleteStatus, 'deleted')
    assert.deepEqual(discord.deletedChannels, ['channel-1'])
    assert.equal(desktop.submitted.length, 0)
    assert.equal(desktop.created.length, 0)
    assert.equal((await store.read()).channels['channel-1'], undefined)
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('operatorCloseChannel refuses waiting companion cleanup unless forced', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-service-operator-close-waiting-'))
  const { discord, service, store } = await createService(stateDir)

  try {
    await store.ensureChannel({
      discordChannelId: 'channel-1',
      discordChannelName: 'codex-waiting',
      desktopThreadLabel: 'Waiting thread',
      status: 'waiting_for_codex',
      createdBy: 'operator',
    })

    const refused = await service.operatorCloseChannel({ channelId: 'channel-1' })
    assert.equal(refused.ok, false)
    if (refused.ok) {
      assert.fail('close should have been refused while waiting for Codex')
    }
    assert.equal(refused.error, 'waiting_for_codex')
    assert.deepEqual(discord.deletedChannels, [])
    assert.notEqual((await store.read()).channels['channel-1'], undefined)

    const forced = await service.operatorCloseChannel({ channelId: 'channel-1', force: true })
    assert.equal(forced.ok, true)
    if (!forced.ok) {
      assert.fail('forced operator close should have succeeded')
    }
    assert.deepEqual(discord.deletedChannels, ['channel-1'])
    assert.equal((await store.read()).channels['channel-1'], undefined)
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('operatorCloseChannel prunes stale mapping when Discord channel is already missing', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-service-operator-close-missing-'))
  const { discord, service, store } = await createService(stateDir)

  try {
    await store.ensureChannel({
      discordChannelId: 'channel-1',
      discordChannelName: 'codex-stale',
      status: 'ready',
      createdBy: 'operator',
    })
    discord.deleteFailures.set('channel-1', new Error('Discord API /channels/channel-1 failed: HTTP 404 Unknown Channel'))

    const result = await service.operatorCloseChannel({ channelId: 'channel-1' })

    assert.equal(result.ok, true)
    if (!result.ok) {
      assert.fail('stale operator close should have succeeded')
    }
    assert.equal(result.deletedDiscordChannel, false)
    assert.equal(result.discordDeleteStatus, 'already_missing')
    assert.equal((await store.read()).channels['channel-1'], undefined)
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('operatorRecoverPublish sends a recovery prompt only for an idle waiting mapped thread', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-service-operator-recover-'))
  const { desktop, discord, service, store } = await createService(stateDir)

  try {
    desktop.state = { available: true, mode: 'api', windowTitle: 'Codex', reason: null }
    desktop.threads = [makeThread('Waiting desktop thread')]
    const mapping = await store.ensureChannel({
      discordChannelId: 'channel-1',
      discordChannelName: 'codex-waiting',
      desktopThreadLabel: 'Waiting desktop thread',
      status: 'waiting_for_codex',
      createdBy: 'operator',
    })

    const result = await service.operatorRecoverPublish({ channelId: 'channel-1', correlationId: 'recover-1' })

    assert.equal(result.ok, true)
    if (!result.ok) {
      assert.fail('operator recover should have succeeded')
    }
    assert.equal(result.channelId, 'channel-1')
    assert.equal(result.bindingId, mapping.bindingId)
    assert.equal(result.desktopResult.result, 'submitted')
    assert.equal(desktop.submitted.length, 1)
    assert.equal(desktop.submitted[0]?.desktopThreadLabel, 'Waiting desktop thread')
    assert.match(desktop.submitted[0]?.text ?? '', /immediately previous assistant reply/)
    assert.match(desktop.submitted[0]?.text ?? '', new RegExp(`--binding-id ${mapping.bindingId}`))
    assert.match(desktop.submitted[0]?.text ?? '', /--stdin/)
    assert.match(desktop.submitted[0]?.text ?? '', /recover-1/)
    assert.match(discord.messages.get('channel-1')?.at(-1)?.content ?? '', /Recovery prompt sent/)
    const updated = (await store.read()).channels['channel-1']
    assert.equal(updated?.status, 'waiting_for_codex')
    assert.equal(updated?.lastSeenMessageId, result.reminderMessageId)
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('operatorRecoverPublish refuses prefix-only visible thread matches', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-service-operator-prefix-recover-refused-'))
  const { desktop, service, store } = await createService(stateDir)

  try {
    desktop.state = { available: true, mode: 'api', windowTitle: 'Codex', reason: null }
    desktop.threads = [
      makeThread('w035 Ceiling compact budget optimizer Codex multi-thread orchestration worker assignment', {
        turnState: 'idle',
      }),
    ]
    const mapping = await store.ensureChannel({
      discordChannelId: 'channel-1',
      discordChannelName: 'codex-w035-ceiling-compact-budget-optimizer',
      desktopThreadLabel: 'w035 Ceiling compact budget optimizer',
      status: 'waiting_for_codex',
      createdBy: 'operator',
    })

    const result = await service.operatorRecoverPublish({ channelId: 'channel-1', correlationId: 'recover-prefix-1' })

    assert.equal(result.ok, false)
    if (result.ok) {
      assert.fail('operator recover should have refused a prefix-only visible thread match')
    }
    assert.equal(result.error, 'desktop_thread_not_found')
    assert.equal(result.channelId, 'channel-1')
    assert.equal(result.desktopThreadLabel, mapping.desktopThreadLabel)
    assert.equal(desktop.submitted.length, 0)
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('operatorRecoverPublish refuses non-waiting and non-idle mapped threads', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-service-operator-recover-refuse-'))
  const { desktop, service, store } = await createService(stateDir)

  try {
    desktop.state = { available: true, mode: 'api', windowTitle: 'Codex', reason: null }
    desktop.threads = [makeThread('Ready desktop thread'), makeThread('Busy desktop thread', { turnState: 'working' })]
    await store.ensureChannel({
      discordChannelId: 'channel-ready',
      desktopThreadLabel: 'Ready desktop thread',
      status: 'ready',
    })
    await store.ensureChannel({
      discordChannelId: 'channel-busy',
      desktopThreadLabel: 'Busy desktop thread',
      status: 'waiting_for_codex',
    })

    const ready = await service.operatorRecoverPublish({ channelId: 'channel-ready' })
    assert.equal(ready.ok, false)
    if (ready.ok) {
      assert.fail('ready channel should not accept recovery publish')
    }
    assert.equal(ready.error, 'not_waiting_for_codex')

    const busy = await service.operatorRecoverPublish({ channelId: 'channel-busy' })
    assert.equal(busy.ok, false)
    if (busy.ok) {
      assert.fail('busy channel should not accept recovery publish')
    }
    assert.equal(busy.error, 'desktop_thread_not_idle')
    assert.equal(desktop.submitted.length, 0)
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('pollOnce accepts recover publish inside a waiting mapped channel', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-service-recover-channel-'))
  const { desktop, discord, service, store } = await createService(stateDir)

  try {
    desktop.state = { available: true, mode: 'api', windowTitle: 'Codex', reason: null }
    desktop.threads = [makeThread('Waiting desktop thread')]
    await store.ensureChannel({
      discordChannelId: 'channel-1',
      discordChannelName: 'codex-waiting',
      desktopThreadLabel: 'Waiting desktop thread',
      status: 'waiting_for_codex',
    })
    discord.pushHumanMessage('channel-1', '<@123456789> recover publish')

    const result = await service.pollOnce()

    assert.equal(result.promptMessagesSeen, 1)
    assert.ok(result.actions.includes('recover_publish_submitted'))
    assert.equal(desktop.submitted.length, 1)
    assert.match(desktop.submitted[0]?.text ?? '', /Discord relay recovery instruction/)
    assert.match(discord.messages.get('channel-1')?.at(-1)?.content ?? '', /Recovery prompt sent/)

    await service.pollOnce()
    assert.equal(desktop.submitted.length, 1)
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('pollOnce creates a desktop thread from the first prompt in a new relay channel', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-service-create-'))
  const { desktop, discord, service, store } = await createService(stateDir)

  try {
    desktop.nextCreateResult = {
      result: 'submitted',
      message: null,
      desktopThreadLabel: 'Fresh desktop thread',
    }
    const initial = await store.ensureChannel({
      discordChannelId: 'channel-1',
      discordChannelName: 'codex-new',
      status: 'needs_manual_binding',
    })
    discord.pushHumanMessage('channel-1', 'Start from Discord.')

    const result = await service.pollOnce()
    assert.ok(result.actions.includes('create_thread_submitted'))
    assert.ok(result.actions.includes('discord_channel_renamed'))
    assert.equal(desktop.created.length, 1)
    assert.match(
      desktop.created[0] ?? '',
      new RegExp(`codex_discord_publish.py' --base-url 'http://127.0.0.1:0' --channel-id channel-1 --binding-id ${initial.bindingId}`),
    )
    assert.match(desktop.created[0] ?? '', /Publish only the final visible assistant response/)
    assert.match(discord.messages.get('channel-1')?.at(-1)?.content ?? '', /Created Codex desktop thread/)
    assert.deepEqual(discord.renamedChannels, [{ channelId: 'channel-1', name: 'codex-fresh-desktop-thread' }])

    const mapping = (await store.read()).channels['channel-1']
    assert.equal(mapping?.desktopThreadLabel, 'Fresh desktop thread')
    assert.equal(mapping?.discordChannelName, 'codex-fresh-desktop-thread')
    assert.equal(mapping?.status, 'waiting_for_codex')
    assert.equal(mapping?.bindingId, initial.bindingId)
    assert.equal(mapping?.bindingNoteStatus, 'injected')
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('pollOnce retries first-prompt create for a command-created channel after a prior refusal', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-service-create-retry-'))
  const { desktop, discord, service, store } = await createService(stateDir)

  try {
    desktop.nextCreateResult = {
      result: 'submitted',
      message: null,
      desktopThreadLabel: 'Retried desktop thread',
    }
    await store.ensureChannel({
      discordChannelId: 'channel-1',
      discordChannelName: 'codex-new',
      status: 'error',
      createdByCommandMessageId: 'command-message-1',
    })
    discord.pushHumanMessage('channel-1', '<@123456789> Start again after enabling UIA.')

    const result = await service.pollOnce()
    assert.ok(result.actions.includes('create_thread_submitted'))
    assert.equal(desktop.created.length, 1)

    const mapping = (await store.read()).channels['channel-1']
    assert.equal(mapping?.desktopThreadLabel, 'Retried desktop thread')
    assert.equal(mapping?.status, 'waiting_for_codex')
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('pollOnce retries first-prompt create for an operator-created channel after a prior refusal', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-service-create-retry-operator-'))
  const { desktop, discord, service, store } = await createService(stateDir)

  try {
    desktop.nextCreateResult = {
      result: 'submitted',
      message: null,
      desktopThreadLabel: 'Operator retried desktop thread',
    }
    await store.ensureChannel({
      discordChannelId: 'channel-1',
      discordChannelName: 'codex-operator-new',
      status: 'error',
      createdBy: 'operator',
    })
    discord.pushHumanMessage('channel-1', '<@123456789> Start after enabling UIA.')

    const result = await service.pollOnce()
    assert.ok(result.actions.includes('create_thread_submitted'))
    assert.equal(desktop.created.length, 1)

    const mapping = (await store.read()).channels['channel-1']
    assert.equal(mapping?.createdBy, 'operator')
    assert.equal(mapping?.desktopThreadLabel, 'Operator retried desktop thread')
    assert.equal(mapping?.status, 'waiting_for_codex')
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('pollOnce refuses unbound mapped channels without desktop mutation', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-service-unbound-'))
  const { desktop, discord, service, store } = await createService(stateDir)

  try {
    await store.ensureChannel({
      discordChannelId: 'channel-1',
      discordChannelName: 'codex-unbound',
      status: 'error',
    })
    discord.pushHumanMessage('channel-1', 'Prompt that must not be forwarded.')

    const result = await service.pollOnce()
    assert.ok(result.actions.includes('prompt_refused_unbound'))
    assert.equal(desktop.submitted.length, 0)
    assert.equal(desktop.created.length, 0)
    assert.match(discord.messages.get('channel-1')?.at(-1)?.content ?? '', /not bound/)
    assert.equal((await store.read()).channels['channel-1']?.status, 'error')
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('pollOnce archives a ready mapped relay text channel without desktop mutation', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-service-archive-'))
  const { config, desktop, discord, service, store } = await createService(stateDir)

  try {
    await store.ensureChannel({
      discordChannelId: 'channel-1',
      discordChannelName: 'codex-existing',
      desktopThreadLabel: 'Existing desktop thread',
      status: 'ready',
    })
    discord.messages.set('channel-1', [])
    discord.pushHumanMessage('channel-1', '<@123456789> archive')

    const result = await service.pollOnce()
    assert.equal(result.promptMessagesSeen, 1)
    assert.ok(result.actions.includes('archive_channel_deleted'))
    assert.deepEqual(discord.deletedChannels, ['channel-1'])
    assert.equal(desktop.submitted.length, 0)
    assert.equal(desktop.created.length, 0)
    assert.equal((await store.read()).channels['channel-1'], undefined)
    assert.match(discord.messages.get(config.discord.commandChannelId)?.at(-1)?.content ?? '', /Archived relay text channel/)
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('pollOnce cancels an unused new-thread relay channel without desktop mutation', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-service-cancel-'))
  const { config, desktop, discord, service, store } = await createService(stateDir)

  try {
    await store.ensureChannel({
      discordChannelId: 'channel-1',
      discordChannelName: 'codex-new-202605051911',
      status: 'needs_manual_binding',
    })
    discord.messages.set('channel-1', [])
    discord.pushHumanMessage('channel-1', '<@123456789> cancel')

    const result = await service.pollOnce()
    assert.equal(result.promptMessagesSeen, 1)
    assert.ok(result.actions.includes('archive_channel_deleted'))
    assert.deepEqual(discord.deletedChannels, ['channel-1'])
    assert.equal(desktop.submitted.length, 0)
    assert.equal(desktop.created.length, 0)
    assert.equal((await store.read()).channels['channel-1'], undefined)
    assert.match(discord.messages.get(config.discord.commandChannelId)?.at(-1)?.content ?? '', /Archived relay text channel/)
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('pollOnce refuses archive while waiting for Codex self-report', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-service-archive-waiting-'))
  const { discord, service, store } = await createService(stateDir)

  try {
    await store.ensureChannel({
      discordChannelId: 'channel-1',
      discordChannelName: 'codex-existing',
      desktopThreadLabel: 'Existing desktop thread',
      status: 'waiting_for_codex',
    })
    discord.messages.set('channel-1', [])
    discord.pushHumanMessage('channel-1', 'archive')

    const result = await service.pollOnce()
    assert.equal(result.promptMessagesSeen, 1)
    assert.ok(result.actions.includes('archive_refused_waiting_for_codex'))
    assert.deepEqual(discord.deletedChannels, [])
    const mapping = (await store.read()).channels['channel-1']
    assert.equal(mapping?.status, 'waiting_for_codex')
    assert.match(discord.messages.get('channel-1')?.at(-1)?.content ?? '', /Still waiting for Codex/)
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})
