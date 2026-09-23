import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface OrchestrationRun {
  run_id: string
  title: string
  status: string
  export?: {
    export_dir?: string
    board_path?: string
  }
}

export interface OrchestrationWorker {
  worker_id: string
  run_id: string
  title: string
  archetype: string
  status: string
  phase?: string | null
  discord_channel_id?: string | null
  codex_thread_label?: string | null
  binding_id?: string | null
  assignment?: {
    objective?: string
    owned_scope?: string[]
    do_not_touch_scope?: string[]
    canonical_anchors?: string[]
    authority?: string
    mutation_policy?: string
  }
}

export interface OrchestrationReport {
  report_id: string
  worker_id: string
  report_type: string
  summary: string
  status?: string | null
  phase?: string | null
}

export interface OrchestrationDecision {
  decision_id: string
  run_id: string
  worker_id?: string | null
  status: string
  title: string
  prompt: string
  resolution?: string | null
}

export interface OrchestrationBinding {
  binding_id: string
  run_id: string
  worker_id?: string | null
  binding_type: string
  discord_channel_id?: string | null
  discord_channel_name?: string | null
  codex_thread_label?: string | null
  desktop_relay_binding_id?: string | null
  status: string
  metadata?: Record<string, unknown>
}

export interface OrchestrationCollectResult {
  run_id: string
  reports: OrchestrationReport[]
  open_decisions: OrchestrationDecision[]
}

export interface OrchestrationBindWorkerResult {
  worker: OrchestrationWorker
  binding: OrchestrationBinding
}

export interface OrchestrationTurnStateObservation {
  run_id: string
  worker_id: string
  turn_state: 'idle' | 'working' | 'unknown'
  previous_turn_state?: string | null
  changed: boolean
  status_before: string
  status_after: string
  event_recorded: boolean
}

export interface OrchestrationClient {
  createRun(args: { title: string }): Promise<OrchestrationRun>
  startWorker(args: {
    runId: string
    archetype: string
    title: string
    objective: string
  }): Promise<OrchestrationWorker>
  bindWorker(args: {
    workerId: string
    discordChannelId: string
    discordChannelName?: string | null
    codexThreadLabel?: string | null
    desktopRelayBindingId: string
    status: string
    bindingStatus: string
    metadata?: Record<string, unknown>
  }): Promise<OrchestrationBindWorkerResult>
  observeWorkerTurnState(args: {
    runId?: string | null
    workerId?: string | null
    discordChannelId?: string | null
    desktopRelayBindingId?: string | null
    codexThreadLabel?: string | null
    turnState: 'idle' | 'working' | 'unknown'
    observedAt?: string | null
    source?: string | null
    metadata?: Record<string, unknown>
  }): Promise<OrchestrationTurnStateObservation>
  listWorkers(args: { runId: string }): Promise<OrchestrationWorker[]>
  getWorker(args: { workerId: string }): Promise<OrchestrationWorker>
  collect(args: { runId: string }): Promise<OrchestrationCollectResult>
  resolveDecision(args: { decisionId: string; resolution: string }): Promise<OrchestrationDecision>
  closeWorker(args: { workerId: string }): Promise<OrchestrationWorker>
  board(args: { runId: string }): Promise<string>
  archiveRun(args: { runId: string }): Promise<OrchestrationRun>
}

export interface OrchestrationCliClientOptions {
  pythonPath: string
  cliPath: string
  cwd: string
  dbPath?: string | null
  exportRoot?: string | null
  timeoutMs: number
}

export class OrchestrationCliClient implements OrchestrationClient {
  constructor(private readonly options: OrchestrationCliClientOptions) {}

  async createRun(args: { title: string }): Promise<OrchestrationRun> {
    return this.runJson<OrchestrationRun>(['create-run', '--title', args.title])
  }

  async startWorker(args: {
    runId: string
    archetype: string
    title: string
    objective: string
  }): Promise<OrchestrationWorker> {
    return this.runJson<OrchestrationWorker>([
      'start-worker',
      '--run-id',
      args.runId,
      '--archetype',
      args.archetype,
      '--title',
      args.title,
      '--objective',
      args.objective,
    ])
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
    const commandArgs = [
      'bind-worker',
      '--worker-id',
      args.workerId,
      '--discord-channel-id',
      args.discordChannelId,
      '--desktop-relay-binding-id',
      args.desktopRelayBindingId,
      '--status',
      args.status,
      '--binding-status',
      args.bindingStatus,
    ]
    if (args.discordChannelName) {
      commandArgs.push('--discord-channel-name', args.discordChannelName)
    }
    if (args.codexThreadLabel) {
      commandArgs.push('--codex-thread-label', args.codexThreadLabel)
    }
    if (args.metadata) {
      commandArgs.push('--metadata-json', JSON.stringify(args.metadata))
    }
    return this.runJson<OrchestrationBindWorkerResult>(commandArgs)
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
    const commandArgs = ['observe-turn-state', '--turn-state', args.turnState]
    if (args.runId) {
      commandArgs.push('--run-id', args.runId)
    }
    if (args.workerId) {
      commandArgs.push('--worker-id', args.workerId)
    }
    if (args.discordChannelId) {
      commandArgs.push('--discord-channel-id', args.discordChannelId)
    }
    if (args.desktopRelayBindingId) {
      commandArgs.push('--desktop-relay-binding-id', args.desktopRelayBindingId)
    }
    if (args.codexThreadLabel) {
      commandArgs.push('--codex-thread-label', args.codexThreadLabel)
    }
    if (args.observedAt) {
      commandArgs.push('--observed-at', args.observedAt)
    }
    if (args.source) {
      commandArgs.push('--source', args.source)
    }
    if (args.metadata) {
      commandArgs.push('--metadata-json', JSON.stringify(args.metadata))
    }
    return this.runJson<OrchestrationTurnStateObservation>(commandArgs)
  }

  async getWorker(args: { workerId: string }): Promise<OrchestrationWorker> {
    return this.runJson<OrchestrationWorker>(['worker', '--worker-id', args.workerId])
  }

  async listWorkers(args: { runId: string }): Promise<OrchestrationWorker[]> {
    return this.runJson<OrchestrationWorker[]>(['list-workers', '--run-id', args.runId])
  }

  async collect(args: { runId: string }): Promise<OrchestrationCollectResult> {
    return this.runJson<OrchestrationCollectResult>(['collect', '--run-id', args.runId])
  }

  async resolveDecision(args: { decisionId: string; resolution: string }): Promise<OrchestrationDecision> {
    return this.runJson<OrchestrationDecision>([
      'decision',
      'resolve',
      '--decision-id',
      args.decisionId,
      '--resolution',
      args.resolution,
    ])
  }

  async closeWorker(args: { workerId: string }): Promise<OrchestrationWorker> {
    return this.runJson<OrchestrationWorker>(['close-worker', '--worker-id', args.workerId])
  }

  async board(args: { runId: string }): Promise<string> {
    return this.runText(['board', '--run-id', args.runId])
  }

  async archiveRun(args: { runId: string }): Promise<OrchestrationRun> {
    return this.runJson<OrchestrationRun>(['archive-run', '--run-id', args.runId])
  }

  private baseArgs(jsonOutput: boolean): string[] {
    const args = [this.options.cliPath]
    if (this.options.dbPath) {
      args.push('--db-path', this.options.dbPath)
    }
    if (this.options.exportRoot) {
      args.push('--export-root', this.options.exportRoot)
    }
    if (jsonOutput) {
      args.push('--json')
    }
    return args
  }

  private async runJson<T>(commandArgs: string[]): Promise<T> {
    const stdout = await this.runText(commandArgs, true)
    try {
      return JSON.parse(stdout) as T
    } catch (error) {
      throw new Error(`Codex orchestration CLI returned non-JSON output: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async runText(commandArgs: string[], jsonOutput = false): Promise<string> {
    const args = [...this.baseArgs(jsonOutput), ...commandArgs]
    try {
      const result = await execFileAsync(this.options.pythonPath, args, {
        cwd: this.options.cwd,
        timeout: this.options.timeoutMs,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      })
      return result.stdout
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Codex orchestration CLI failed: ${message}`)
    }
  }
}
