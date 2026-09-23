import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DiscordThreadMessage } from '@workstation-control/discord-transport'

import { parseRelayCommand, renderHelpText, type RelayCommand } from './command-router.js'
import type { CodexDiscordDesktopRelayConfig } from './config.js'
import type { DesktopAdapter, DesktopPromptResult, DesktopThreadSummary } from './desktop-adapter.js'
import { sha256Text } from './discord-publisher.js'
import { createLogger } from './logger.js'
import type {
  OrchestrationClient,
  OrchestrationCollectResult,
  OrchestrationDecision,
  OrchestrationRun,
  OrchestrationWorker,
} from './orchestration-client.js'
import type { RelayStateStore } from './state-store.js'
import type { RelayChannelMapping, RelayDesktopThreadListItem, RelayDesktopTurnState, RelayState } from './types.js'

const publishScriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../scripts/tools/codex_discord_publish.py')
function quotePowerShellArgument(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'"
}

function publishCommand(config: Pick<CodexDiscordDesktopRelayConfig, 'host' | 'port'>): string {
  const host = config.host === '::1' ? '[::1]' : config.host
  const baseUrl = `http://${host}:${config.port}`
  return `python ${quotePowerShellArgument(publishScriptPath)} --base-url ${quotePowerShellArgument(baseUrl)}`
}

export interface RelayDiscordTransport {
  createMessage(channelId: string, content: string): Promise<{ messageId: string }>
  listMessages(channelId: string, afterMessageId: string | null): Promise<DiscordThreadMessage[]>
  updateTextChannelName(channelId: string, name: string): Promise<{ channelId: string; name: string }>
  deleteTextChannel(channelId: string): Promise<void>
  createTextChannel(
    name: string,
    parentChannelId?: string | null,
  ): Promise<{ guildId: string; channelId: string; name: string; channelUrl: string | null }>
}

export interface PollSummary {
  ok: true
  commandMessagesSeen: number
  promptMessagesSeen: number
  actions: string[]
}

export interface OperatorStartThreadRequest {
  title?: string | null
  prompt?: string | null
  correlationId?: string | null
}

export interface OperatorProtocolRunnerBindChannelRequest {
  runInstanceId?: string | null
  threadId?: string | null
  threadTitle?: string | null
  channelName?: string | null
  correlationId?: string | null
}

export interface OperatorCloseChannelRequest {
  channelId?: string | null
  shortLabel?: number | string | null
  desktopThreadLabel?: string | null
  force?: boolean | null
  correlationId?: string | null
}

export interface OperatorRecoverPublishRequest {
  channelId?: string | null
  shortLabel?: number | string | null
  desktopThreadLabel?: string | null
  correlationId?: string | null
}

export interface OperatorStartThreadResult {
  ok: true
  channelId: string
  channelName: string
  channelUrl: string | null
  shortLabel: number
  bindingId: string
  status: RelayChannelMapping['status']
  bindingNoteStatus: RelayChannelMapping['bindingNoteStatus']
  desktopThreadLabel: string | null
  promptSubmitted: boolean
  desktopResult: DesktopPromptResult | null
}

export interface OperatorProtocolRunnerBindChannelResult {
  ok: true
  channelId: string
  channelName: string
  channelUrl: string | null
  shortLabel: number
  bindingId: string
  status: RelayChannelMapping['status']
  bindingNoteStatus: RelayChannelMapping['bindingNoteStatus']
  desktopThreadLabel: string | null
  codexThreadId: string | null
}

export type OperatorCloseChannelResult =
  | {
      ok: true
      channelId: string
      channelName: string | null
      desktopThreadLabel: string | null
      status: RelayChannelMapping['status']
      shortLabel: number
      deletedDiscordChannel: boolean
      removedMapping: true
      discordDeleteStatus: 'deleted' | 'already_missing'
    }
  | {
      ok: false
      error:
        | 'selector_required'
        | 'mapping_not_found'
        | 'ambiguous_selector'
        | 'waiting_for_codex'
        | 'discord_delete_failed'
      message: string
      channelId: string | null
      desktopThreadLabel: string | null
    }

export type OperatorRecoverPublishResult =
  | {
      ok: true
      channelId: string
      channelName: string | null
      desktopThreadLabel: string
      bindingId: string
      status: RelayChannelMapping['status']
      desktopResult: DesktopPromptResult
      reminderMessageId: string
    }
  | {
      ok: false
      error:
        | 'selector_required'
        | 'mapping_not_found'
        | 'ambiguous_selector'
        | 'not_waiting_for_codex'
        | 'missing_desktop_thread_label'
        | 'desktop_unavailable'
        | 'desktop_thread_not_found'
        | 'desktop_thread_ambiguous'
        | 'desktop_thread_not_idle'
        | 'desktop_submit_refused'
      message: string
      channelId: string | null
      desktopThreadLabel: string | null
      desktopResult?: DesktopPromptResult
    }

const logger = createLogger('codex_discord_desktop_relay')
const TURN_STATE_REGISTRY_SYNC_INTERVAL_MS = 60_000

type OrchestrationRelayCommand = Extract<
  RelayCommand,
  {
    kind:
      | 'orchestration_create_run'
      | 'orchestration_show_board'
      | 'orchestration_start_worker'
      | 'orchestration_refresh_worker_identity'
      | 'orchestration_show_worker'
      | 'orchestration_collect_reports'
      | 'orchestration_resolve_decision'
      | 'orchestration_close_worker'
      | 'orchestration_archive_run'
      | 'orchestration_cleanup_worker'
      | 'orchestration_cleanup_run'
      | 'orchestration_show_active_run'
      | 'orchestration_switch_active_run'
      | 'orchestration_clear_active_run'
  }
>

function compactSpaces(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function compactComparableThreadLabel(value: string): string {
  return compactSpaces(value)
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
}

export function sanitizeDiscordTextChannelName(value: string, prefix: string): string {
  const base = compactSpaces(value)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72)
    .replace(/-+$/g, '')
  const safeBase = base || 'thread'
  return `${prefix}-${safeBase}`.slice(0, 90).replace(/-+$/g, '')
}

function latestMessageId(messages: DiscordThreadMessage[]): string | null {
  return messages.at(-1)?.messageId ?? null
}

function toDisplayedThreadListItems(
  threads: DesktopThreadSummary[],
  group: 'all' | 'pinned' | 'non_pinned',
): RelayDesktopThreadListItem[] {
  return threads
    .filter((thread) => group === 'all' || thread.group === group)
    .map((thread, offset) => ({
      index: offset + 1,
      label: thread.label,
      group: thread.group,
      visible: thread.visible,
      turnState: thread.turnState,
      indicatorText: thread.indicatorText,
      indicatorReason: thread.indicatorReason,
    }))
}

function formatThreadTurnState(thread: Pick<RelayDesktopThreadListItem, 'turnState'>): string {
  if (thread.turnState === 'working') {
    return ' [working]'
  }

  if (thread.turnState === 'unknown') {
    return ' [status unknown]'
  }

  return ''
}

function formatThreadList(items: RelayDesktopThreadListItem[]): string {
  if (items.length === 0) {
    return 'No visible desktop threads were reported for that view.'
  }

  return items.map((thread) => `${thread.index}. ${thread.label}${formatThreadTurnState(thread)}`).join('\n')
}

function promptFooter(mapping: Pick<RelayChannelMapping, 'discordChannelId' | 'bindingId'>, correlationId: string, config: CodexDiscordDesktopRelayConfig): string {
  return [
    '',
    '',
    '---',
    'Discord relay self-report instruction:',
    `This Codex thread is bound to Discord channel ${mapping.discordChannelId} with binding id ${mapping.bindingId}.`,
    'Publish only the final visible assistant response for each turn to Discord before ending the turn. Do not publish progress updates, commentary/status messages, tool logs, chain-of-thought, or this binding instruction.',
    `${publishCommand(config)} --channel-id ${mapping.discordChannelId} --binding-id ${mapping.bindingId} --text-file <path-to-final-response.txt> --correlation-id ${correlationId}`,
    'For very short replies, you may use `--text "exact reply text"` instead of `--text-file`; for shell pipelines, `--stdin` is also supported.',
  ].join('\n')
}

function bindingNoteText(mapping: Pick<RelayChannelMapping, 'discordChannelId' | 'bindingId'>, config: CodexDiscordDesktopRelayConfig): string {
  return [
    'Discord relay binding note:',
    `This Codex Desktop thread is bound to Discord channel ${mapping.discordChannelId}.`,
    `Active binding id: ${mapping.bindingId}`,
    '',
    'Publish only the final visible assistant response for each turn to the Discord companion before ending the turn. This includes short final replies, confirmations, and test replies.',
    'Do not publish progress updates, commentary/status messages, tool logs, chain-of-thought, or this binding note itself.',
    `${publishCommand(config)} --channel-id ${mapping.discordChannelId} --binding-id ${mapping.bindingId} --text-file <path-to-final-response.txt>`,
    'For very short replies, you may use `--text "exact reply text"` instead of `--text-file`; for shell pipelines, `--stdin` is also supported.',
    '',
    'If the publish command says the binding is stale or inactive, continue normally in Codex Desktop and mention that Discord mirroring failed in your visible reply.',
  ].join('\n')
}

function recoveryPromptText(mapping: Pick<RelayChannelMapping, 'discordChannelId' | 'bindingId'>, correlationId: string, config: CodexDiscordDesktopRelayConfig): string {
  return [
    'Discord relay recovery instruction:',
    `This Codex Desktop thread is still waiting for a Discord self-report for channel ${mapping.discordChannelId}.`,
    `Active binding id: ${mapping.bindingId}`,
    '',
    'If your immediately previous assistant reply in this thread was not published to Discord, publish that exact previous reply now. Do not do new task work before publishing it.',
    `${publishCommand(config)} --channel-id ${mapping.discordChannelId} --binding-id ${mapping.bindingId} --text-file <path-to-missed-reply.txt> --correlation-id ${correlationId}`,
    'For a very short missed reply, `--text "exact missed reply"` is acceptable; for shell pipelines, `--stdin` is also supported.',
    '',
    'After attempting the publish, reply briefly in Codex Desktop with whether the Discord recovery publish succeeded. Do not publish this recovery instruction itself.',
  ].join('\n')
}

function stripLeadingDiscordMentions(value: string): string {
  return value.replace(/^\s*(?:<@!?\d+>\s*)+/, '').trim()
}

function shouldTryFirstPromptCreate(mapping: RelayChannelMapping): boolean {
  if (mapping.desktopThreadLabel) {
    return false
  }

  if (mapping.status === 'needs_manual_binding') {
    return true
  }

  return mapping.status === 'error' && (mapping.createdByCommandMessageId !== null || mapping.createdBy === 'operator')
}

function isDiscordChannelNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('HTTP 404') || message.toLowerCase().includes('unknown channel')
}

function normalizeShortLabel(value: number | string | null | undefined): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value
  }

  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10)
  }

  return null
}

function epochMs(value: string | null | undefined): number | null {
  if (!value) {
    return null
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function shouldSyncTurnStateToRegistry(mapping: RelayChannelMapping, changed: boolean, observedAt: string): boolean {
  if (isProtocolRunnerOwnedMapping(mapping)) {
    return false
  }
  if (changed || !mapping.lastDesktopTurnStateRegistrySyncedAt) {
    return true
  }
  const observedMs = epochMs(observedAt)
  const syncedMs = epochMs(mapping.lastDesktopTurnStateRegistrySyncedAt)
  if (observedMs === null || syncedMs === null) {
    return true
  }
  return observedMs - syncedMs >= TURN_STATE_REGISTRY_SYNC_INTERVAL_MS
}

function isProtocolRunnerOwnedMapping(mapping: RelayChannelMapping): boolean {
  return mapping.purpose === 'protocol_runner' || (Boolean(mapping.codexThreadId?.trim()) && mapping.createdBy === 'operator')
}

function resolveMappingSelector(
  state: RelayState,
  selector: {
    channelId?: string | null
    shortLabel?: number | string | null
    desktopThreadLabel?: string | null
  },
):
  | { ok: true; mapping: RelayChannelMapping }
  | {
      ok: false
      error: 'selector_required' | 'mapping_not_found' | 'ambiguous_selector'
      message: string
      channelId: string | null
      desktopThreadLabel: string | null
    } {
  const channelId = compactSpaces(selector.channelId ?? '')
  const shortLabel = normalizeShortLabel(selector.shortLabel)
  const desktopThreadLabel = compactSpaces(selector.desktopThreadLabel ?? '')
  const selectorCount = [Boolean(channelId), shortLabel !== null, Boolean(desktopThreadLabel)].filter(Boolean).length

  if (selectorCount !== 1) {
    return {
      ok: false,
      error: 'selector_required',
      message: 'Provide exactly one of channelId, shortLabel, or desktopThreadLabel.',
      channelId: channelId || null,
      desktopThreadLabel: desktopThreadLabel || null,
    }
  }

  if (channelId) {
    const mapping = state.channels[channelId] ?? null
    return mapping
      ? { ok: true, mapping }
      : {
          ok: false,
          error: 'mapping_not_found',
          message: 'No relay mapping matched that selector.',
          channelId,
          desktopThreadLabel: null,
        }
  }

  if (shortLabel !== null) {
    const mapping = Object.values(state.channels).find((candidate) => candidate.shortLabel === shortLabel) ?? null
    return mapping
      ? { ok: true, mapping }
      : {
          ok: false,
          error: 'mapping_not_found',
          message: 'No relay mapping matched that selector.',
          channelId: null,
          desktopThreadLabel: null,
        }
  }

  const matches = Object.values(state.channels).filter((candidate) => candidate.desktopThreadLabel === desktopThreadLabel)
  if (matches.length > 1) {
    return {
      ok: false,
      error: 'ambiguous_selector',
      message: `Multiple relay mappings use desktop thread label: ${desktopThreadLabel}`,
      channelId: null,
      desktopThreadLabel,
    }
  }

  const mapping = matches[0] ?? null
  return mapping
    ? { ok: true, mapping }
    : {
        ok: false,
        error: 'mapping_not_found',
        message: 'No relay mapping matched that selector.',
        channelId: null,
        desktopThreadLabel: desktopThreadLabel || null,
    }
}

function isOrchestrationCommand(command: RelayCommand): command is OrchestrationRelayCommand {
  return command.kind.startsWith('orchestration_')
}

async function resolveWorkerSelector(orchestration: OrchestrationClient, runId: string, selector: string): Promise<string> {
  const normalized = compactSpaces(selector)
  if (/^\d+$/.test(normalized)) {
    const index = Number.parseInt(normalized, 10) - 1
    const workers = await orchestration.listWorkers({ runId })
    return workers[index]?.worker_id ?? `w${Number.parseInt(normalized, 10).toString().padStart(3, '0')}`
  }
  return normalized
}

function formatOrchestrationRun(run: OrchestrationRun): string {
  return `${run.title} (${run.run_id}, ${run.status})`
}

function formatWorker(worker: OrchestrationWorker): string {
  const objective = worker.assignment?.objective ? `\nObjective: ${worker.assignment.objective}` : ''
  const discord = worker.discord_channel_id ? `\nDiscord: <#${worker.discord_channel_id}>` : ''
  const desktop = worker.codex_thread_label ? `\nCodex desktop: ${worker.codex_thread_label}` : ''
  const phase = worker.phase ? ` / ${worker.phase}` : ''
  return [
    `Worker ${worker.worker_id}: ${worker.title}`,
    `Archetype: ${worker.archetype}`,
    `Status: ${worker.status}${phase}`,
    `Run: ${worker.run_id}`,
    discord,
    desktop,
    objective,
  ]
    .filter(Boolean)
    .join('\n')
}

function formatListBlock(title: string, values: string[] | undefined): string[] {
  if (!values || values.length === 0) {
    return []
  }
  return ['', `${title}:`, ...values.map((value) => `- ${value}`)]
}

function renderWorkerAssignmentPrompt(worker: OrchestrationWorker): string {
  const assignment = worker.assignment ?? {}
  const reportBase = `python scripts/tools/codex_orchestrate.py report --run-id ${worker.run_id} --worker-id ${worker.worker_id}`
  return [
    `${worker.worker_id} ${worker.title}`,
    '',
    'Codex multi-thread orchestration worker assignment',
    '',
    `Run id: ${worker.run_id}`,
    `Worker id: ${worker.worker_id}`,
    `Archetype: ${worker.archetype}`,
    `Title: ${worker.title}`,
    '',
    'Objective:',
    assignment.objective ?? 'Complete the assigned worker task and report back through the orchestration registry.',
    ...formatListBlock('Owned scope', assignment.owned_scope),
    ...formatListBlock('Do-not-touch scope', assignment.do_not_touch_scope),
    ...formatListBlock('Canonical anchors', assignment.canonical_anchors),
    '',
    'Worker operating rules:',
    '- You are a worker thread for a larger Codex orchestration run, not the orchestrator.',
    '- Follow the repo AGENTS.md and the canonical docs for any system you touch.',
    '- Stay within owned scope and do not change do-not-touch scope unless the orchestrator explicitly updates the assignment.',
    '- Report durable progress, blockers, decisions, artifacts, and completion through the local orchestration registry.',
    '- Do not coordinate directly with other worker threads; route decisions and summaries through the orchestrator.',
    '',
    'Reporting commands:',
    `- Acknowledge once you are grounded: ${reportBase} --type ack --summary "grounded and starting"`,
    `- Report status at meaningful boundaries: ${reportBase} --type status --summary "<short status>"`,
    `- Request a decision if blocked: ${reportBase} --type decision_request --summary "<decision needed>" --needs-decision`,
    `- Finish with a final report: ${reportBase} --type final_report --summary "<result summary>"`,
  ].join('\n')
}

function formatCollectResult(result: OrchestrationCollectResult): string {
  const lines = [
    `Collected ${result.reports.length} unread report(s) and ${result.open_decisions.length} open decision(s) for ${result.run_id}.`,
  ]
  if (result.reports.length > 0) {
    lines.push('', 'Reports:')
    for (const report of result.reports) {
      lines.push(`- ${report.report_id} from ${report.worker_id} (${report.report_type}): ${report.summary}`)
    }
  }
  if (result.open_decisions.length > 0) {
    lines.push('', 'Open decisions:')
    for (const decision of result.open_decisions) {
      const worker = decision.worker_id ? ` from ${decision.worker_id}` : ''
      lines.push(`- ${decision.decision_id}${worker}: ${decision.title}`)
    }
  }
  return lines.join('\n')
}

function formatCompanionCleanup(result: OperatorCloseChannelResult | null): string {
  if (!result) {
    return 'no companion channel recorded'
  }
  if (result.ok) {
    return `${result.discordDeleteStatus}: ${result.channelName ?? result.channelId}`
  }
  return `not deleted (${result.error}): ${result.message}`
}

function formatDecision(decision: OrchestrationDecision): string {
  const worker = decision.worker_id ? ` for ${decision.worker_id}` : ''
  return `Decision ${decision.decision_id}${worker} is ${decision.status}: ${decision.title}`
}

function chunkDiscordMessage(text: string): string[] {
  const maxLength = 1900
  if (text.length <= maxLength) {
    return [text]
  }

  const chunks: string[] = []
  let remaining = text
  while (remaining.length > maxLength) {
    const newlineIndex = remaining.lastIndexOf('\n', maxLength)
    const splitAt = newlineIndex > 0 ? newlineIndex : maxLength
    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).trimStart()
  }
  if (remaining) {
    chunks.push(remaining)
  }
  return chunks
}

export class CodexDiscordDesktopRelayService {
  private timer: NodeJS.Timeout | null = null
  private polling = false

  constructor(
    private readonly options: {
      config: CodexDiscordDesktopRelayConfig
      desktop: DesktopAdapter
      discord: RelayDiscordTransport
      orchestration?: OrchestrationClient | null
      store: RelayStateStore
    },
  ) {}

  async start(): Promise<void> {
    await this.bootstrapCursors()
    this.timer = setInterval(() => {
      void this.pollOnce().catch((error) => {
        logger.error('relay.poll.failed', { message: error instanceof Error ? error.message : String(error) })
      })
    }, this.options.config.pollIntervalMs)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  async pollOnce(): Promise<PollSummary> {
    if (this.polling) {
      return { ok: true, commandMessagesSeen: 0, promptMessagesSeen: 0, actions: ['poll_already_running'] }
    }

    this.polling = true
    try {
      const actions: string[] = []
      const commandCount = await this.pollCommandChannel(actions)
      const promptCount = await this.pollMappedChannels(actions)
      const turnStateCount = await this.pollDesktopTurnStates(actions)
      if (turnStateCount > 0) {
        actions.push(`turn_state_observations_${turnStateCount}`)
      }
      return { ok: true, commandMessagesSeen: commandCount, promptMessagesSeen: promptCount, actions }
    } finally {
      this.polling = false
    }
  }

  async operatorStartThread(request: OperatorStartThreadRequest): Promise<OperatorStartThreadResult> {
    const title = compactSpaces(request.title ?? '')
    const prompt = request.prompt?.trim() ? request.prompt : null
    const timestamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
    const channelSeed = title || `operator-${timestamp}`
    const channelName = sanitizeDiscordTextChannelName(channelSeed, this.options.config.discord.channelNamePrefix)
    const channel = await this.options.discord.createTextChannel(
      channelName,
      this.options.config.discord.textChannelParentId,
    )
    const welcome = await this.options.discord.createMessage(
      channel.channelId,
      [
        'Operator-created Codex relay channel.',
        prompt
          ? 'The operator prompt is being forwarded to a new Codex desktop thread when the desktop adapter allows it.'
          : 'No prompt was provided; this channel is waiting for manual binding or a future prompt.',
      ].join('\n'),
    )
    let mapping = await this.options.store.ensureChannel({
      discordChannelId: channel.channelId,
      discordChannelName: channel.name,
      status: 'needs_manual_binding',
      createdBy: 'operator',
      lastSeenMessageId: welcome.messageId,
      bindingNoteStatus: prompt ? 'pending' : 'injected',
    })
    let desktopResult: DesktopPromptResult | null = null

    if (prompt) {
      const correlationId = compactSpaces(request.correlationId ?? '') || `operator-${channel.channelId}-${timestamp}`
      const promptWithFooter = `${prompt}${promptFooter(mapping, correlationId, this.options.config)}`
      logger.info('relay.operator.start_thread_prompt_received', {
        channel_id: channel.channelId,
        prompt_length: prompt.length,
        prompt_sha256: sha256Text(prompt),
        correlation_id: correlationId,
      })
      desktopResult = await this.options.desktop.createThread({ text: promptWithFooter })
      desktopResult = await this.captureSubmittedCreateThreadLabel(desktopResult, {
        channelId: mapping.discordChannelId,
        source: 'operator_start_thread',
        correlationId,
      })

      if (desktopResult.result === 'submitted') {
        if (desktopResult.desktopThreadLabel) {
          mapping = await this.options.store.bindChannel({
            discordChannelId: mapping.discordChannelId,
            desktopThreadLabel: desktopResult.desktopThreadLabel,
            rotateBindingId: false,
          })
          mapping = await this.syncDiscordChannelName(mapping, desktopResult.desktopThreadLabel, [])
        }
        mapping = await this.options.store.ensureChannel({
          discordChannelId: mapping.discordChannelId,
          status: 'waiting_for_codex',
          createdBy: 'operator',
          bindingNoteStatus: 'injected',
        })
        const ack = await this.options.discord.createMessage(
          mapping.discordChannelId,
          `Operator prompt forwarded to Codex desktop${desktopResult.desktopThreadLabel ? `: ${desktopResult.desktopThreadLabel}` : '.'}`,
        )
        mapping = await this.options.store.ensureChannel({
          discordChannelId: mapping.discordChannelId,
          lastSeenMessageId: ack.messageId,
          createdBy: 'operator',
        })
        logger.info('relay.operator.start_thread_submitted', {
          channel_id: mapping.discordChannelId,
          desktop_thread_label: desktopResult.desktopThreadLabel,
          binding_id: mapping.bindingId,
        })
      } else {
        const refusal = await this.options.discord.createMessage(
          mapping.discordChannelId,
          desktopResult.message ?? 'Desktop adapter refused this operator start-thread request.',
        )
        mapping = await this.options.store.markRefused(
          mapping.discordChannelId,
          desktopResult.message ?? desktopResult.result,
        )
        mapping = await this.options.store.ensureChannel({
          discordChannelId: mapping.discordChannelId,
          createdBy: 'operator',
          bindingNoteStatus: 'pending',
        })
        mapping = await this.options.store.markChannelSeen(mapping.discordChannelId, refusal.messageId)
        logger.warn('relay.operator.start_thread_refused', {
          channel_id: mapping.discordChannelId,
          desktop_result: desktopResult.result,
          message: desktopResult.message,
        })
      }
    }

    return {
      ok: true,
      channelId: mapping.discordChannelId,
      channelName: mapping.discordChannelName ?? channel.name,
      channelUrl: channel.channelUrl,
      shortLabel: mapping.shortLabel,
      bindingId: mapping.bindingId,
      status: mapping.status,
      bindingNoteStatus: mapping.bindingNoteStatus,
      desktopThreadLabel: mapping.desktopThreadLabel,
      promptSubmitted: desktopResult?.result === 'submitted',
      desktopResult,
    }
  }

  async operatorProtocolRunnerBindChannel(
    request: OperatorProtocolRunnerBindChannelRequest,
  ): Promise<OperatorProtocolRunnerBindChannelResult> {
    const runInstanceId = compactSpaces(request.runInstanceId ?? '')
    const threadId = compactSpaces(request.threadId ?? '') || null
    const threadTitle = compactSpaces(request.threadTitle ?? '') || null
    if (!threadTitle) {
      throw new Error('Protocol Runner bind-channel requires a visible thread label.')
    }
    const requestedChannelName = compactSpaces(request.channelName ?? '')
    const channelSeed = requestedChannelName || threadTitle || `protocol-runner-${runInstanceId}`
    const channelName = sanitizeDiscordTextChannelName(channelSeed, this.options.config.discord.channelNamePrefix)
    const channel = await this.options.discord.createTextChannel(
      channelName,
      this.options.config.discord.textChannelParentId,
    )
    const welcome = await this.options.discord.createMessage(
      channel.channelId,
      [
        'Protocol Runner relay channel.',
        `Run instance: ${runInstanceId}`,
        `Codex visible thread label: ${threadTitle}`,
        threadId ? `Codex thread id metadata: ${threadId}` : null,
        'This binding created the inspectable Discord channel only; it did not send a runner prompt.',
      ]
        .filter((line): line is string => line !== null)
        .join('\n'),
    )
    const mapping = await this.options.store.ensureChannel({
      discordChannelId: channel.channelId,
      discordChannelName: channel.name,
      desktopThreadLabel: threadTitle,
      codexThreadId: threadId,
      purpose: 'protocol_runner',
      status: 'ready',
      createdBy: 'operator',
      lastSeenMessageId: welcome.messageId,
      bindingNoteStatus: 'pending',
    })

    logger.info('relay.operator.protocol_runner_bind_channel_created', {
      run_instance_id: runInstanceId,
      channel_id: mapping.discordChannelId,
      channel_name: mapping.discordChannelName,
      desktop_thread_label: mapping.desktopThreadLabel,
      codex_thread_id: mapping.codexThreadId,
      binding_id: mapping.bindingId,
      correlation_id: request.correlationId ?? null,
    })

    return {
      ok: true,
      channelId: mapping.discordChannelId,
      channelName: mapping.discordChannelName ?? channel.name,
      channelUrl: channel.channelUrl,
      shortLabel: mapping.shortLabel,
      bindingId: mapping.bindingId,
      status: mapping.status,
      bindingNoteStatus: mapping.bindingNoteStatus,
      desktopThreadLabel: mapping.desktopThreadLabel,
      codexThreadId: mapping.codexThreadId,
    }
  }

  private async captureSubmittedCreateThreadLabel(
    result: DesktopPromptResult,
    context: { channelId: string; source: string; correlationId?: string | null },
  ): Promise<DesktopPromptResult> {
    if (result.result !== 'submitted' || result.desktopThreadLabel) {
      return result
    }

    const readback = await this.options.desktop.bindCurrent()
    if (readback.result === 'submitted' && readback.desktopThreadLabel) {
      logger.info('relay.desktop.create_thread_label_captured', {
        channel_id: context.channelId,
        source: context.source,
        desktop_thread_label: readback.desktopThreadLabel,
        correlation_id: compactSpaces(context.correlationId ?? '') || null,
      })
      return {
        ...result,
        desktopThreadLabel: readback.desktopThreadLabel,
      }
    }

    logger.warn('relay.desktop.create_thread_label_capture_failed', {
      channel_id: context.channelId,
      source: context.source,
      readback_result: readback.result,
      message: readback.message,
      correlation_id: compactSpaces(context.correlationId ?? '') || null,
    })
    return result
  }

  async operatorCloseChannel(request: OperatorCloseChannelRequest): Promise<OperatorCloseChannelResult> {
    const state = await this.options.store.read()
    const resolved = resolveMappingSelector(state, request)
    if (!resolved.ok) {
      return resolved
    }
    const mapping = resolved.mapping

    if (mapping.status === 'waiting_for_codex' && request.force !== true) {
      return {
        ok: false,
        error: 'waiting_for_codex',
        message: 'Relay channel is waiting for Codex. Re-run with force only if you intentionally want to abandon the companion channel.',
        channelId: mapping.discordChannelId,
        desktopThreadLabel: mapping.desktopThreadLabel,
      }
    }

    logger.info('relay.operator.channel_close_requested', {
      channel_id: mapping.discordChannelId,
      channel_name: mapping.discordChannelName,
      desktop_thread_label: mapping.desktopThreadLabel,
      status: mapping.status,
      force: request.force === true,
      correlation_id: compactSpaces(request.correlationId ?? '') || null,
    })

    let discordDeleteStatus: 'deleted' | 'already_missing' = 'deleted'
    try {
      await this.options.discord.deleteTextChannel(mapping.discordChannelId)
    } catch (error) {
      if (isDiscordChannelNotFound(error)) {
        discordDeleteStatus = 'already_missing'
        logger.warn('relay.operator.channel_already_missing', {
          channel_id: mapping.discordChannelId,
          channel_name: mapping.discordChannelName,
          desktop_thread_label: mapping.desktopThreadLabel,
          correlation_id: compactSpaces(request.correlationId ?? '') || null,
        })
      } else {
        logger.error('relay.operator.channel_close_failed', {
          channel_id: mapping.discordChannelId,
          channel_name: mapping.discordChannelName,
          desktop_thread_label: mapping.desktopThreadLabel,
          message: error instanceof Error ? error.message : String(error),
          correlation_id: compactSpaces(request.correlationId ?? '') || null,
        })
        return {
          ok: false,
          error: 'discord_delete_failed',
          message: error instanceof Error ? error.message : String(error),
          channelId: mapping.discordChannelId,
          desktopThreadLabel: mapping.desktopThreadLabel,
        }
      }
    }

    await this.options.store.deleteChannel(mapping.discordChannelId)
    logger.info('relay.operator.channel_closed', {
      channel_id: mapping.discordChannelId,
      channel_name: mapping.discordChannelName,
      desktop_thread_label: mapping.desktopThreadLabel,
      status: mapping.status,
      discord_delete_status: discordDeleteStatus,
      correlation_id: compactSpaces(request.correlationId ?? '') || null,
    })

    return {
      ok: true,
      channelId: mapping.discordChannelId,
      channelName: mapping.discordChannelName,
      desktopThreadLabel: mapping.desktopThreadLabel,
      status: mapping.status,
      shortLabel: mapping.shortLabel,
      deletedDiscordChannel: discordDeleteStatus === 'deleted',
      removedMapping: true,
      discordDeleteStatus,
    }
  }

  async operatorRecoverPublish(request: OperatorRecoverPublishRequest): Promise<OperatorRecoverPublishResult> {
    const state = await this.options.store.read()
    const resolved = resolveMappingSelector(state, request)
    if (!resolved.ok) {
      return resolved
    }
    const mapping = resolved.mapping

    if (mapping.status !== 'waiting_for_codex') {
      return {
        ok: false,
        error: 'not_waiting_for_codex',
        message: 'Relay channel is not waiting for a Codex self-report.',
        channelId: mapping.discordChannelId,
        desktopThreadLabel: mapping.desktopThreadLabel,
      }
    }

    if (!mapping.desktopThreadLabel) {
      return {
        ok: false,
        error: 'missing_desktop_thread_label',
        message: 'Relay channel is waiting but is not bound to a Codex desktop thread label.',
        channelId: mapping.discordChannelId,
        desktopThreadLabel: null,
      }
    }

    const desktopState = await this.options.desktop.getState()
    if (!desktopState.available) {
      return {
        ok: false,
        error: 'desktop_unavailable',
        message: desktopState.reason ?? 'Desktop adapter is unavailable.',
        channelId: mapping.discordChannelId,
        desktopThreadLabel: mapping.desktopThreadLabel,
      }
    }

    const match = await this.findVisibleDesktopThread(mapping.desktopThreadLabel)
    if (match.status === 'not_found') {
      return {
        ok: false,
        error: 'desktop_thread_not_found',
        message: `No exact visible desktop thread match: ${mapping.desktopThreadLabel}`,
        channelId: mapping.discordChannelId,
        desktopThreadLabel: mapping.desktopThreadLabel,
      }
    }
    if (match.status === 'ambiguous') {
      return {
        ok: false,
        error: 'desktop_thread_ambiguous',
        message: `Ambiguous desktop thread title: ${mapping.desktopThreadLabel}`,
        channelId: mapping.discordChannelId,
        desktopThreadLabel: mapping.desktopThreadLabel,
      }
    }
    if (match.thread.turnState !== 'idle') {
      return {
        ok: false,
        error: 'desktop_thread_not_idle',
        message: `Codex Desktop sidebar status is ${match.thread.turnState}; recovery prompt was not sent.`,
        channelId: mapping.discordChannelId,
        desktopThreadLabel: mapping.desktopThreadLabel,
      }
    }

    const timestamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
    const correlationId =
      compactSpaces(request.correlationId ?? '') || `operator-recover-${mapping.discordChannelId}-${timestamp}`
    const text = recoveryPromptText(mapping, correlationId, this.options.config)
    logger.info('relay.operator.recover_publish_requested', {
      channel_id: mapping.discordChannelId,
      channel_name: mapping.discordChannelName,
      desktop_thread_label: mapping.desktopThreadLabel,
      binding_id: mapping.bindingId,
      correlation_id: correlationId,
    })
    const desktopResult = await this.options.desktop.submitPrompt({
      desktopThreadLabel: mapping.desktopThreadLabel,
      text,
    })
    if (desktopResult.result !== 'submitted') {
      logger.warn('relay.operator.recover_publish_refused', {
        channel_id: mapping.discordChannelId,
        desktop_thread_label: mapping.desktopThreadLabel,
        desktop_result: desktopResult.result,
        message: desktopResult.message,
        correlation_id: correlationId,
      })
      return {
        ok: false,
        error: 'desktop_submit_refused',
        message: desktopResult.message ?? desktopResult.result,
        channelId: mapping.discordChannelId,
        desktopThreadLabel: mapping.desktopThreadLabel,
        desktopResult,
      }
    }

    const reminder = await this.options.discord.createMessage(
      mapping.discordChannelId,
      'Recovery prompt sent to Codex Desktop to publish the missed prior reply. This channel stays waiting until Codex publishes through the relay.',
    )
    await this.options.store.markChannelSeen(mapping.discordChannelId, reminder.messageId)
    logger.info('relay.operator.recover_publish_submitted', {
      channel_id: mapping.discordChannelId,
      desktop_thread_label: mapping.desktopThreadLabel,
      binding_id: mapping.bindingId,
      reminder_message_id: reminder.messageId,
      correlation_id: correlationId,
    })

    return {
      ok: true,
      channelId: mapping.discordChannelId,
      channelName: mapping.discordChannelName,
      desktopThreadLabel: mapping.desktopThreadLabel,
      bindingId: mapping.bindingId,
      status: mapping.status,
      desktopResult,
      reminderMessageId: reminder.messageId,
    }
  }

  private async bootstrapCursors(): Promise<void> {
    const state = await this.options.store.read()
    if (!state.lastCommandMessageId) {
      const commandMessages = await this.options.discord.listMessages(this.options.config.discord.commandChannelId, null)
      const latest = latestMessageId(commandMessages)
      if (latest) {
        await this.options.store.markCommandSeen(latest)
      }
    }

    for (const mapping of Object.values(state.channels)) {
      if (mapping.discordChannelId === state.commandChannelId || mapping.lastSeenMessageId) {
        continue
      }
      const messages = await this.options.discord.listMessages(mapping.discordChannelId, null)
      const latest = latestMessageId(messages)
      if (latest) {
        await this.options.store.markChannelSeen(mapping.discordChannelId, latest)
      }
    }
  }

  private async pollCommandChannel(actions: string[]): Promise<number> {
    const state = await this.options.store.read()
    const messages = await this.options.discord.listMessages(state.commandChannelId, state.lastCommandMessageId)
    let seen = 0
    for (const message of messages) {
      seen += 1
      if (!message.authorIsBot) {
        const command = parseRelayCommand(message.content)
        await this.handleCommandMessage(command, message, actions)
      }
      await this.options.store.markCommandSeen(message.messageId)
    }
    return seen
  }

  private async pollDesktopTurnStates(actions: string[]): Promise<number> {
    const state = await this.options.store.read()
    const mappings = Object.values(state.channels).filter(
      (mapping) => mapping.discordChannelId !== state.commandChannelId && Boolean(mapping.desktopThreadLabel),
    )
    if (mappings.length === 0) {
      return 0
    }

    const observedAt = new Date().toISOString()
    let threads: DesktopThreadSummary[] = []
    try {
      threads = await this.options.desktop.listThreads()
    } catch (error) {
      logger.warn('relay.desktop.turn_state_list_failed', {
        message: error instanceof Error ? error.message : String(error),
      })
      actions.push('turn_state_list_failed')
    }

    let observed = 0
    for (const mapping of mappings) {
      const label = mapping.desktopThreadLabel
      if (!label) {
        continue
      }
      const matches = threads.filter((thread) => thread.label === label)
      const thread = matches.length === 1 ? matches[0] : null
      const turnState: RelayDesktopTurnState = thread?.turnState ?? 'unknown'
      const local = await this.options.store.recordChannelTurnState({
        channelId: mapping.discordChannelId,
        turnState,
        observedAt,
      })
      observed += 1
      if (local.changed) {
        actions.push(`turn_state_${local.previousTurnState ?? 'none'}_to_${turnState}`)
      }
      if (!shouldSyncTurnStateToRegistry(local.mapping, local.changed, observedAt)) {
        continue
      }
      const synced = await this.syncOrchestrationTurnState({
        activeRunId: state.orchestration.activeRunId,
        mapping: local.mapping,
        previousTurnState: local.previousTurnState,
        changed: local.changed,
        turnState,
        observedAt,
        matchStatus: matches.length === 0 ? 'not_found' : matches.length === 1 ? 'matched' : 'ambiguous',
        thread,
      })
      if (synced) {
        await this.options.store.markChannelTurnStateRegistrySynced(mapping.discordChannelId, observedAt)
      }
    }
    return observed
  }

  private async syncOrchestrationTurnState(args: {
    activeRunId: string | null
    mapping: RelayChannelMapping
    previousTurnState: RelayDesktopTurnState | null
    changed: boolean
    turnState: RelayDesktopTurnState
    observedAt: string
    matchStatus: 'matched' | 'not_found' | 'ambiguous'
    thread: DesktopThreadSummary | null
  }): Promise<boolean> {
    if (!this.options.config.orchestration.enabled || !this.options.orchestration) {
      return false
    }

    try {
      const result = await this.options.orchestration.observeWorkerTurnState({
        runId: args.activeRunId,
        discordChannelId: args.mapping.discordChannelId,
        desktopRelayBindingId: args.mapping.bindingId,
        codexThreadLabel: args.mapping.desktopThreadLabel,
        turnState: args.turnState,
        observedAt: args.observedAt,
        source: 'codex-discord-desktop-relay',
        metadata: {
          relayStatus: args.mapping.status,
          bindingNoteStatus: args.mapping.bindingNoteStatus,
          localTurnStateChanged: args.changed,
          localPreviousTurnState: args.previousTurnState,
          desktopThreadMatchStatus: args.matchStatus,
          indicatorText: args.thread?.indicatorText ?? null,
          indicatorReason: args.thread?.indicatorReason ?? null,
        },
      })
      logger.info('relay.orchestration.turn_state_observed', {
        run_id: result.run_id,
        worker_id: result.worker_id,
        channel_id: args.mapping.discordChannelId,
        desktop_thread_label: args.mapping.desktopThreadLabel,
        turn_state: args.turnState,
        previous_turn_state: args.previousTurnState,
        changed: result.changed,
        status_before: result.status_before,
        status_after: result.status_after,
      })
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.warn('relay.orchestration.turn_state_sync_failed', {
        channel_id: args.mapping.discordChannelId,
        desktop_thread_label: args.mapping.desktopThreadLabel,
        turn_state: args.turnState,
        message,
      })
      return message.includes('Worker not found for turn-state observation')
    }
  }

  private async handleCommandMessage(
    command: RelayCommand,
    message: DiscordThreadMessage,
    actions: string[],
  ): Promise<void> {
    logger.info('relay.discord.command_received', {
      command_kind: command.kind,
      discord_message_id: message.messageId,
      text_length: message.content.length,
      text_sha256: sha256Text(message.content),
    })

    if (isOrchestrationCommand(command)) {
      await this.handleOrchestrationCommand(command, actions)
      return
    }

    if (command.kind === 'help') {
      await this.sendCommandChannelMessage(renderHelpText())
      actions.push('help')
      return
    }

    if (command.kind === 'status') {
      await this.sendCommandChannelMessage(await this.renderStatus())
      actions.push('status')
      return
    }

    if (command.kind === 'show_threads') {
      const desktopState = await this.options.desktop.getState()
      if (!desktopState.available) {
        await this.options.discord.createMessage(
          this.options.config.discord.commandChannelId,
          `Desktop thread listing is not available yet: ${desktopState.reason ?? 'unavailable'}`,
        )
        actions.push('show_threads_unavailable')
        return
      }
      const threads = await this.options.desktop.listThreads()
      const displayed = toDisplayedThreadListItems(threads, command.group)
      await this.options.store.recordDesktopThreadList({
        group: command.group,
        sourceCommandMessageId: message.messageId,
        items: displayed.map((item) => ({
          label: item.label,
          group: item.group,
          visible: item.visible,
          turnState: item.turnState,
          indicatorText: item.indicatorText,
          indicatorReason: item.indicatorReason,
        })),
      })
      await this.sendCommandChannelMessage(formatThreadList(displayed))
      actions.push(`show_threads_${command.group}`)
      return
    }

    if (command.kind === 'start_new_thread') {
      await this.handleStartNewThread(message, actions)
      return
    }

    if (command.kind === 'pickup_thread') {
      await this.handlePickup(command.selector, actions)
      return
    }

    if (command.kind === 'check_thread') {
      if (!command.selector) {
        await this.options.discord.createMessage(
          this.options.config.discord.commandChannelId,
          'Use `check <number-or-title>` here, or type `check` inside a mapped Codex relay text channel.',
        )
        actions.push('check_needs_selector')
        return
      }
      await this.handleCheck(command.selector, this.options.config.discord.commandChannelId, actions)
      return
    }

    if (command.kind === 'refresh_binding') {
      if (!command.selector) {
        await this.options.discord.createMessage(
          this.options.config.discord.commandChannelId,
          'Use `refresh binding <number-or-title>` here, or type `refresh binding` inside a mapped Codex relay text channel.',
        )
        actions.push('refresh_binding_needs_selector')
        return
      }
      await this.handleRefreshBinding(command.selector, this.options.config.discord.commandChannelId, actions)
      return
    }

    if (command.kind === 'bind_current') {
      await this.options.discord.createMessage(
        this.options.config.discord.commandChannelId,
        'Use `bind current` inside a mapped Codex text channel after the desktop adapter is enabled.',
      )
      actions.push('bind_current_needs_channel')
      return
    }

    if (command.kind === 'archive_channel') {
      await this.options.discord.createMessage(
        this.options.config.discord.commandChannelId,
        'Use `archive` inside the mapped Codex relay text channel you want to delete.',
      )
      actions.push('archive_needs_channel')
      return
    }

    if (command.kind === 'unknown' && command.reason === 'empty_command') {
      await this.options.discord.createMessage(
        this.options.config.discord.commandChannelId,
        [
          'Discord did not expose that message body to the bot.',
          'For now, mention the bot at the start of commands, like `@YourBot start new thread`.',
        ].join('\n'),
      )
      actions.push('unknown_empty_command')
      return
    }

    await this.sendCommandChannelMessage(`Command not recognized. ${renderHelpText()}`)
    actions.push(`unknown_${command.reason}`)
  }

  private async handleOrchestrationCommand(command: OrchestrationRelayCommand, actions: string[]): Promise<void> {
    if (!this.options.config.orchestration.enabled || !this.options.orchestration) {
      await this.sendCommandChannelMessage('Codex orchestration registry commands are disabled for this relay runtime.')
      actions.push('orchestration_disabled')
      return
    }

    try {
      if (command.kind === 'orchestration_create_run') {
        const run = await this.options.orchestration.createRun({ title: command.title })
        await this.options.store.setActiveOrchestrationRun(run.run_id)
        await this.sendCommandChannelMessage([
          `Active orchestration run created: ${formatOrchestrationRun(run)}`,
          'Slice 9 is live: `start worker <archetype>: <objective>` creates a worker companion channel and attempts a Codex Desktop worker prompt through the relay operator lane.',
        ].join('\n'))
        actions.push('orchestration_run_created')
        return
      }

      if (command.kind === 'orchestration_show_active_run') {
        const state = await this.options.store.read()
        const runId = state.orchestration.activeRunId
        if (!runId) {
          await this.sendCommandChannelMessage([
            'No active orchestration run.',
            state.orchestration.lastRunId ? `Last run: ${state.orchestration.lastRunId}` : null,
          ].filter(Boolean).join('\n'))
          actions.push('orchestration_active_run_none')
          return
        }
        await this.sendCommandChannelMessage([
          `Active orchestration run: ${runId}`,
          '',
          await this.options.orchestration.board({ runId }),
        ].join('\n'))
        actions.push('orchestration_active_run_shown')
        return
      }

      if (command.kind === 'orchestration_switch_active_run') {
        await this.options.orchestration.board({ runId: command.runId })
        await this.options.store.setActiveOrchestrationRun(command.runId)
        await this.sendCommandChannelMessage(`Active orchestration run set: ${command.runId}`)
        actions.push('orchestration_active_run_switched')
        return
      }

      if (command.kind === 'orchestration_clear_active_run') {
        await this.options.store.setActiveOrchestrationRun(null)
        await this.sendCommandChannelMessage('Active orchestration run cleared.')
        actions.push('orchestration_active_run_cleared')
        return
      }

      const runId = await this.requireActiveOrchestrationRun()
      if (!runId) {
        await this.sendCommandChannelMessage('No active orchestration run. Start one with `start orchestration run <title>`.')
        actions.push('orchestration_missing_active_run')
        return
      }

      if (command.kind === 'orchestration_show_board') {
        await this.sendCommandChannelMessage(await this.options.orchestration.board({ runId }))
        actions.push('orchestration_board')
        return
      }

      if (command.kind === 'orchestration_start_worker') {
        let worker = await this.options.orchestration.startWorker({
          runId,
          archetype: command.archetype,
          title: command.title,
          objective: command.objective,
        })
        const operatorResult = await this.operatorStartThread({
          title: `${worker.worker_id} ${worker.title}`,
          prompt: renderWorkerAssignmentPrompt(worker),
          correlationId: `orchestration-${runId}-${worker.worker_id}`,
        })
        const bindResult = await this.options.orchestration.bindWorker({
          workerId: worker.worker_id,
          discordChannelId: operatorResult.channelId,
          discordChannelName: operatorResult.channelName,
          codexThreadLabel: operatorResult.desktopThreadLabel,
          desktopRelayBindingId: operatorResult.bindingId,
          status: operatorResult.promptSubmitted ? 'active' : 'blocked',
          bindingStatus: operatorResult.promptSubmitted ? 'active' : 'pending',
          metadata: {
            source: 'codex-discord-desktop-relay',
            promptSubmitted: operatorResult.promptSubmitted,
            relayStatus: operatorResult.status,
            bindingNoteStatus: operatorResult.bindingNoteStatus,
            desktopResult: operatorResult.desktopResult?.result ?? null,
            channelUrl: operatorResult.channelUrl,
          },
        })
        worker = bindResult.worker
        await this.sendCommandChannelMessage([
          operatorResult.promptSubmitted
            ? `Worker companion created and prompt submitted: <#${operatorResult.channelId}>`
            : `Worker companion created but Codex Desktop prompt was not submitted: <#${operatorResult.channelId}>`,
          formatWorker(worker),
          '',
          `Relay binding id: ${operatorResult.bindingId}`,
          operatorResult.desktopResult?.message ? `Desktop result: ${operatorResult.desktopResult.message}` : null,
        ].join('\n'))
        actions.push('orchestration_worker_started')
        actions.push(operatorResult.promptSubmitted ? 'orchestration_worker_prompt_submitted' : 'orchestration_worker_prompt_not_submitted')
        return
      }

      if (command.kind === 'orchestration_show_worker') {
        const worker = await this.options.orchestration.getWorker({
          workerId: await resolveWorkerSelector(this.options.orchestration, runId, command.selector),
        })
        await this.sendCommandChannelMessage(formatWorker(worker))
        actions.push('orchestration_worker_shown')
        return
      }

      if (command.kind === 'orchestration_refresh_worker_identity') {
        await this.refreshOrchestrationWorkerIdentity(runId, command.selector, actions)
        return
      }

      if (command.kind === 'orchestration_collect_reports') {
        const result = await this.options.orchestration.collect({ runId })
        await this.sendCommandChannelMessage(formatCollectResult(result))
        actions.push('orchestration_reports_collected')
        return
      }

      if (command.kind === 'orchestration_resolve_decision') {
        const decision = await this.options.orchestration.resolveDecision({
          decisionId: command.decisionId,
          resolution: command.resolution,
        })
        await this.sendCommandChannelMessage(`Resolved. ${formatDecision(decision)}`)
        actions.push('orchestration_decision_resolved')
        return
      }

      if (command.kind === 'orchestration_close_worker') {
        const worker = await this.options.orchestration.closeWorker({
          workerId: await resolveWorkerSelector(this.options.orchestration, runId, command.selector),
        })
        await this.sendCommandChannelMessage(`Closed registry worker.\n${formatWorker(worker)}`)
        actions.push('orchestration_worker_closed')
        return
      }

      if (command.kind === 'orchestration_cleanup_worker') {
        const workerId = await resolveWorkerSelector(this.options.orchestration, runId, command.selector)
        const workerBefore = await this.options.orchestration.getWorker({ workerId })
        const companionCleanup = workerBefore.discord_channel_id
          ? await this.operatorCloseChannel({
              channelId: workerBefore.discord_channel_id,
              force: true,
              correlationId: `cleanup-${runId}-${workerId}`,
            })
          : null
        const worker = await this.options.orchestration.closeWorker({ workerId })
        await this.sendCommandChannelMessage([
          'Cleaned up orchestration worker.',
          formatWorker(worker),
          '',
          `Companion channel: ${formatCompanionCleanup(companionCleanup)}`,
          'Codex Desktop was not archived or closed.',
        ].join('\n'))
        actions.push('orchestration_worker_cleaned_up')
        if (companionCleanup?.ok) {
          actions.push('orchestration_worker_companion_deleted')
        }
        return
      }

      if (command.kind === 'orchestration_archive_run') {
        const archived = await this.options.orchestration.archiveRun({ runId })
        await this.options.store.setActiveOrchestrationRun(null)
        await this.sendCommandChannelMessage([
          `Archived orchestration run: ${formatOrchestrationRun(archived)}`,
          archived.export?.export_dir ? `Export: ${archived.export.export_dir}` : null,
        ].filter(Boolean).join('\n'))
        actions.push('orchestration_run_archived')
        return
      }

      if (command.kind === 'orchestration_cleanup_run') {
        const workers = await this.options.orchestration.listWorkers({ runId })
        const companionResults: Array<{ worker: OrchestrationWorker; result: OperatorCloseChannelResult | null }> = []
        for (const worker of workers) {
          const result = worker.discord_channel_id
            ? await this.operatorCloseChannel({
                channelId: worker.discord_channel_id,
                force: true,
                correlationId: `cleanup-${runId}-${worker.worker_id}`,
              })
            : null
          companionResults.push({ worker, result })
        }
        const collected = await this.options.orchestration.collect({ runId })
        const archived = await this.options.orchestration.archiveRun({ runId })
        await this.options.store.setActiveOrchestrationRun(null)
        const deletedCount = companionResults.filter((item) => item.result?.ok).length
        const attemptedCount = companionResults.filter((item) => item.result !== null).length
        const failed = companionResults.filter((item) => item.result && !item.result.ok)
        await this.sendCommandChannelMessage([
          `Cleaned up orchestration run: ${formatOrchestrationRun(archived)}`,
          `Companion channels: ${deletedCount}/${attemptedCount} deleted.`,
          `Reports collected: ${collected.reports.length}; open decisions: ${collected.open_decisions.length}.`,
          archived.export?.export_dir ? `Export: ${archived.export.export_dir}` : null,
          failed.length > 0 ? '' : null,
          ...failed.map((item) => `- ${item.worker.worker_id}: ${formatCompanionCleanup(item.result)}`),
          '',
          'Codex Desktop threads were not archived or closed.',
        ].filter((line): line is string => line !== null).join('\n'))
        actions.push('orchestration_run_cleaned_up')
        return
      }
    } catch (error) {
      logger.error('relay.orchestration.command_failed', {
        command_kind: command.kind,
        message: error instanceof Error ? error.message : String(error),
      })
      await this.sendCommandChannelMessage(`Orchestration command failed: ${error instanceof Error ? error.message : String(error)}`)
      actions.push('orchestration_command_failed')
      return
    }

    await this.sendCommandChannelMessage('Unsupported orchestration command.')
    actions.push('orchestration_unsupported')
  }

  private async refreshOrchestrationWorkerIdentity(
    runId: string,
    selector: string,
    actions: string[],
  ): Promise<void> {
    if (!this.options.orchestration) {
      await this.sendCommandChannelMessage('Codex orchestration registry commands are disabled for this relay runtime.')
      actions.push('orchestration_disabled')
      return
    }

    const workerId = await resolveWorkerSelector(this.options.orchestration, runId, selector)
    const workerBefore = await this.options.orchestration.getWorker({ workerId })
    if (!workerBefore.discord_channel_id) {
      await this.sendCommandChannelMessage(`Worker ${workerBefore.worker_id} has no Discord companion channel to refresh.`)
      actions.push('orchestration_worker_identity_no_companion')
      return
    }

    const state = await this.options.store.read()
    let mapping = state.channels[workerBefore.discord_channel_id] ?? null
    if (!mapping) {
      mapping = await this.options.store.ensureChannel({
        discordChannelId: workerBefore.discord_channel_id,
        desktopThreadLabel: workerBefore.codex_thread_label ?? null,
        status: workerBefore.codex_thread_label ? 'ready' : 'needs_manual_binding',
        createdBy: 'operator',
      })
    }

    let desktopThreadLabel = mapping.desktopThreadLabel ?? workerBefore.codex_thread_label ?? null
    const identitySource = mapping.desktopThreadLabel
      ? 'relay_mapping'
      : workerBefore.codex_thread_label
        ? 'registry_worker'
        : 'current_desktop_selection'

    if (!desktopThreadLabel) {
      const bindResult = await this.options.desktop.bindCurrent()
      if (bindResult.result !== 'submitted' || !bindResult.desktopThreadLabel) {
        await this.sendCommandChannelMessage([
          `Worker ${workerBefore.worker_id} identity is still missing.`,
          `The companion channel exists (<#${workerBefore.discord_channel_id}>), but neither relay state nor the registry had a desktop thread label.`,
          `Current Visible Desktop Read: ${bindResult.message ?? bindResult.result}`,
          'Select the intended Codex Desktop worker thread, then run `refresh worker identity <number-or-id>` again.',
        ].join('\n'))
        actions.push('orchestration_worker_identity_refresh_refused')
        return
      }
      desktopThreadLabel = bindResult.desktopThreadLabel
    }

    const priorStatus = mapping.status
    mapping = await this.options.store.bindChannel({
      discordChannelId: mapping.discordChannelId,
      desktopThreadLabel,
      rotateBindingId: false,
    })
    if (priorStatus === 'waiting_for_codex') {
      mapping = await this.options.store.ensureChannel({
        discordChannelId: mapping.discordChannelId,
        status: 'waiting_for_codex',
        createdBy: 'operator',
      })
    }
    mapping = await this.syncDiscordChannelName(mapping, desktopThreadLabel, actions)

    const workerStatus =
      workerBefore.status === 'queued' || workerBefore.status === 'blocked' ? 'active' : workerBefore.status
    const bindResult = await this.options.orchestration.bindWorker({
      workerId: workerBefore.worker_id,
      discordChannelId: mapping.discordChannelId,
      discordChannelName: mapping.discordChannelName,
      codexThreadLabel: desktopThreadLabel,
      desktopRelayBindingId: mapping.bindingId,
      status: workerStatus,
      bindingStatus: 'active',
      metadata: {
        source: 'codex-discord-desktop-relay',
        refreshWorkerIdentity: true,
        identitySource,
        relayStatus: mapping.status,
        bindingNoteStatus: mapping.bindingNoteStatus,
      },
    })

    await this.sendCommandChannelMessage([
      `Worker identity refreshed: ${bindResult.worker.worker_id}`,
      formatWorker(bindResult.worker),
      '',
      `Identity source: ${identitySource}`,
      `Relay binding id: ${mapping.bindingId}`,
    ].join('\n'))
    actions.push('orchestration_worker_identity_refreshed')
  }

  private async requireActiveOrchestrationRun(): Promise<string | null> {
    const state = await this.options.store.read()
    return state.orchestration.activeRunId
  }

  private async sendCommandChannelMessage(text: string): Promise<void> {
    for (const chunk of chunkDiscordMessage(text)) {
      await this.options.discord.createMessage(this.options.config.discord.commandChannelId, chunk)
    }
  }

  private async handleStartNewThread(message: DiscordThreadMessage, actions: string[]): Promise<void> {
    const timestamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
    const channelName = sanitizeDiscordTextChannelName(`new-${timestamp}`, this.options.config.discord.channelNamePrefix)
    const channel = await this.options.discord.createTextChannel(
      channelName,
      this.options.config.discord.textChannelParentId,
    )
    const welcome = await this.options.discord.createMessage(
      channel.channelId,
      [
        'New Codex relay channel created.',
        'Send the first prompt here to create a new Codex desktop thread when the UIA adapter is enabled.',
        'Until then, the safe stub will refuse without touching Codex desktop.',
      ].join('\n'),
    )
    await this.options.store.ensureChannel({
      discordChannelId: channel.channelId,
      discordChannelName: channel.name,
      status: 'needs_manual_binding',
      createdBy: 'discord_command',
      createdByCommandMessageId: message.messageId,
      lastSeenMessageId: welcome.messageId,
    })
    await this.options.discord.createMessage(
      this.options.config.discord.commandChannelId,
      `Created relay text channel <#${channel.channelId}>. First prompt will create a Codex desktop thread once UIA mode is enabled.`,
    )
    logger.info('relay.discord.channel_created', {
      channel_id: channel.channelId,
      channel_name: channel.name,
      command_message_id: message.messageId,
    })
    actions.push('start_new_thread_channel_created')
  }

  private async handlePickup(selector: string, actions: string[]): Promise<void> {
    const state = await this.options.store.read()
    const numeric = /^\d+$/.test(selector.trim()) ? Number.parseInt(selector.trim(), 10) : NaN
    if (Number.isFinite(numeric) && state.lastDesktopThreadList) {
      const listedThread = state.lastDesktopThreadList.items.find((item) => item.index === numeric)
      if (listedThread) {
        await this.handlePickupByDesktopThreadLabel(listedThread.label, actions, 'pickup_last_list_item')
        return
      }
    }

    if (Number.isFinite(numeric)) {
      const existing = Object.values(state.channels).find((mapping) => mapping.shortLabel === numeric)
      if (existing) {
        await this.options.discord.createMessage(
          this.options.config.discord.commandChannelId,
          `Relay channel ${numeric}: <#${existing.discordChannelId}> (${existing.status})`,
        )
        actions.push('pickup_existing_short_label')
        return
      }
    }

    const existingByLabel = Object.values(state.channels).find((mapping) => mapping.desktopThreadLabel === selector)
    if (existingByLabel) {
      await this.respondWithExistingDesktopMapping(selector, existingByLabel, actions)
      return
    }

    await this.handlePickupByDesktopThreadLabel(selector, actions, 'pickup_exact_title')
  }

  private resolveDesktopThreadLabelFromSelector(
    selector: string,
    state: RelayState,
  ): string | null {
    const trimmed = selector.trim()
    const numeric = /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : NaN
    if (Number.isFinite(numeric) && state.lastDesktopThreadList) {
      const listedThread = state.lastDesktopThreadList.items.find((item) => item.index === numeric)
      if (listedThread) {
        return listedThread.label
      }
    }

    if (Number.isFinite(numeric)) {
      const existing = Object.values(state.channels).find((mapping) => mapping.shortLabel === numeric)
      if (existing?.desktopThreadLabel) {
        return existing.desktopThreadLabel
      }
    }

    const existingByLabel = Object.values(state.channels).find((mapping) => mapping.desktopThreadLabel === trimmed)
    return existingByLabel?.desktopThreadLabel ?? trimmed
  }

  private resolveMappingFromSelector(selector: string, state: RelayState): RelayChannelMapping | null {
    const trimmed = selector.trim()
    const numeric = /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : NaN
    if (Number.isFinite(numeric) && state.lastDesktopThreadList) {
      const listedThread = state.lastDesktopThreadList.items.find((item) => item.index === numeric)
      if (listedThread) {
        return (
          Object.values(state.channels).find((mapping) => mapping.desktopThreadLabel === listedThread.label) ?? null
        )
      }
    }

    if (Number.isFinite(numeric)) {
      return Object.values(state.channels).find((mapping) => mapping.shortLabel === numeric) ?? null
    }

    return Object.values(state.channels).find((mapping) => mapping.desktopThreadLabel === trimmed) ?? null
  }

  private async handleCheck(selector: string, responseChannelId: string, actions: string[]): Promise<void> {
    const state = await this.options.store.read()
    const desktopThreadLabel = this.resolveDesktopThreadLabelFromSelector(selector, state)
    if (!desktopThreadLabel) {
      await this.options.discord.createMessage(responseChannelId, `No desktop thread label found for: ${selector}`)
      actions.push('check_not_found')
      return
    }

    const check = await this.renderDesktopThreadCheck(desktopThreadLabel)
    await this.options.discord.createMessage(responseChannelId, check)
    actions.push('check_thread')
  }

  private async handleRefreshBinding(selector: string, responseChannelId: string, actions: string[]): Promise<void> {
    const state = await this.options.store.read()
    const mapping = this.resolveMappingFromSelector(selector, state)
    if (!mapping) {
      await this.options.discord.createMessage(
        responseChannelId,
        `No active relay mapping found for: ${selector}. Use pickup first.`,
      )
      actions.push('refresh_binding_not_found')
      return
    }

    await this.injectBindingNoteIfIdle(mapping, responseChannelId, actions)
  }

  private async renderDesktopThreadCheck(desktopThreadLabel: string): Promise<string> {
    const desktopState = await this.options.desktop.getState()
    if (!desktopState.available) {
      return `Cannot check ${desktopThreadLabel}: ${desktopState.reason ?? 'desktop unavailable'}`
    }

    const match = await this.findVisibleDesktopThread(desktopThreadLabel)
    if (match.status !== 'matched') {
      return match.status === 'not_found'
        ? `Cannot check ${desktopThreadLabel}: no exact visible desktop thread match.`
        : `Cannot check ${desktopThreadLabel}: ambiguous visible desktop thread title.`
    }

    if (match.thread.turnState === 'working') {
      return `Not safe to prompt yet: Codex Desktop still shows the sidebar working indicator for ${match.thread.label}.`
    }

    if (match.thread.turnState === 'idle') {
      return `Looks safe to prompt: Codex Desktop shows an idle sidebar indicator for ${match.thread.label}.`
    }

    return `Status unknown for ${match.thread.label}: the sidebar does not expose a clear idle/working indicator.`
  }

  private async findVisibleDesktopThread(
    desktopThreadLabel: string,
  ): Promise<
    | { status: 'matched'; thread: DesktopThreadSummary }
    | { status: 'not_found' }
    | { status: 'ambiguous'; matches: DesktopThreadSummary[] }
  > {
    const threads = await this.options.desktop.listThreads()
    const normalizedLabel = compactComparableThreadLabel(desktopThreadLabel)
    const matches = threads.filter((thread) => compactComparableThreadLabel(thread.label) === normalizedLabel)
    if (matches.length === 1) {
      return { status: 'matched', thread: matches[0] as DesktopThreadSummary }
    }
    if (matches.length > 1) {
      return { status: 'ambiguous', matches }
    }

    return { status: 'not_found' }
  }

  private async injectBindingNoteIfIdle(
    mapping: RelayChannelMapping,
    responseChannelId: string,
    actions: string[],
  ): Promise<RelayChannelMapping> {
    if (!mapping.desktopThreadLabel) {
      await this.options.store.markBindingNoteStatus(mapping.discordChannelId, 'pending')
      await this.options.discord.createMessage(
        responseChannelId,
        `Binding note pending for <#${mapping.discordChannelId}>: no desktop thread label is bound yet.`,
      )
      actions.push('binding_note_pending_unbound')
      return { ...mapping, bindingNoteStatus: 'pending' }
    }

    const desktopState = await this.options.desktop.getState()
    if (!desktopState.available) {
      await this.options.store.markBindingNoteStatus(mapping.discordChannelId, 'pending')
      await this.options.discord.createMessage(
        responseChannelId,
        `Binding note pending for ${mapping.desktopThreadLabel}: ${desktopState.reason ?? 'desktop unavailable'}`,
      )
      actions.push('binding_note_pending_desktop_unavailable')
      return { ...mapping, bindingNoteStatus: 'pending' }
    }

    const match = await this.findVisibleDesktopThread(mapping.desktopThreadLabel)
    if (match.status !== 'matched') {
      await this.options.store.markBindingNoteStatus(mapping.discordChannelId, 'pending')
      await this.options.discord.createMessage(
        responseChannelId,
        match.status === 'not_found'
          ? `Binding note pending for ${mapping.desktopThreadLabel}: no exact visible desktop thread match.`
          : `Binding note pending for ${mapping.desktopThreadLabel}: ambiguous visible desktop thread title.`,
      )
      actions.push(match.status === 'not_found' ? 'binding_note_pending_not_found' : 'binding_note_pending_ambiguous')
      return { ...mapping, bindingNoteStatus: 'pending' }
    }

    if (match.thread.turnState === 'working') {
      await this.options.store.markBindingNoteStatus(mapping.discordChannelId, 'pending')
      await this.options.discord.createMessage(
        responseChannelId,
        `Binding note pending for ${match.thread.label}: sidebar status is ${match.thread.turnState}. Run \`refresh binding\` when it is idle.`,
      )
      actions.push('binding_note_pending_working')
      return { ...mapping, bindingNoteStatus: 'pending' }
    }

    const result = await this.options.desktop.submitPrompt({
      desktopThreadLabel: mapping.desktopThreadLabel,
      text: bindingNoteText(mapping, this.options.config),
    })
    if (result.result !== 'submitted') {
      await this.options.store.markBindingNoteStatus(mapping.discordChannelId, 'pending')
      await this.options.discord.createMessage(
        responseChannelId,
        `Binding note pending for ${mapping.desktopThreadLabel}: ${result.message ?? result.result}`,
      )
      actions.push(`binding_note_refused_${result.result}`)
      return { ...mapping, bindingNoteStatus: 'pending' }
    }

    let updated = await this.options.store.bindChannel({
      discordChannelId: mapping.discordChannelId,
      desktopThreadLabel: match.thread.label,
      codexThreadId: mapping.codexThreadId,
      rotateBindingId: false,
    })
    updated = await this.options.store.markBindingNoteStatus(mapping.discordChannelId, 'injected')
    await this.options.discord.createMessage(
      responseChannelId,
      `Binding note injected for ${mapping.desktopThreadLabel}. Future desktop-originated Codex replies should self-report to <#${mapping.discordChannelId}> while this binding stays active.`,
    )
    actions.push('binding_note_injected')
    return updated
  }

  private async handlePickupByDesktopThreadLabel(
    desktopThreadLabel: string,
    actions: string[],
    sourceAction: string,
  ): Promise<void> {
    const state = await this.options.store.read()
    const existingByLabel = Object.values(state.channels).find(
      (mapping) => mapping.desktopThreadLabel === desktopThreadLabel,
    )
    if (existingByLabel) {
      await this.respondWithExistingDesktopMapping(desktopThreadLabel, existingByLabel, actions)
      return
    }

    const desktopState = await this.options.desktop.getState()
    if (!desktopState.available) {
      await this.options.discord.createMessage(
        this.options.config.discord.commandChannelId,
        `Cannot pick up desktop thread yet: ${desktopState.reason ?? 'desktop unavailable'}`,
      )
      actions.push('pickup_unavailable')
      return
    }

    const match = await this.findVisibleDesktopThread(desktopThreadLabel)
    if (match.status !== 'matched') {
      await this.options.discord.createMessage(
        this.options.config.discord.commandChannelId,
        match.status === 'not_found'
          ? `No exact visible desktop thread match: ${desktopThreadLabel}`
          : `Ambiguous desktop thread title: ${desktopThreadLabel}`,
      )
      actions.push(match.status === 'not_found' ? 'pickup_not_found' : 'pickup_ambiguous')
      return
    }

    const channelName = sanitizeDiscordTextChannelName(match.thread.label, this.options.config.discord.channelNamePrefix)
    const channel = await this.options.discord.createTextChannel(
      channelName,
      this.options.config.discord.textChannelParentId,
    )
    const welcome = await this.options.discord.createMessage(
      channel.channelId,
      `Relay channel bound to visible desktop thread label: ${match.thread.label}${formatThreadTurnState(match.thread)}`,
    )
    let mapping = await this.options.store.ensureChannel({
      discordChannelId: channel.channelId,
      discordChannelName: channel.name,
      desktopThreadLabel: match.thread.label,
      status: 'ready',
      createdBy: 'discord_command',
      lastSeenMessageId: welcome.messageId,
    })
    mapping = await this.injectBindingNoteIfIdle(mapping, this.options.config.discord.commandChannelId, actions)
    await this.options.discord.createMessage(
      this.options.config.discord.commandChannelId,
      `Created relay text channel <#${channel.channelId}> for ${match.thread.label}. Binding note: ${mapping.bindingNoteStatus}.`,
    )
    actions.push(sourceAction)
    actions.push('pickup_channel_created')
  }

  private async respondWithExistingDesktopMapping(
    desktopThreadLabel: string,
    mapping: RelayChannelMapping,
    actions: string[],
  ): Promise<void> {
    await this.options.discord.createMessage(
      this.options.config.discord.commandChannelId,
      `Relay already exists for ${desktopThreadLabel}: <#${mapping.discordChannelId}> (${mapping.status}).`,
    )
    actions.push('pickup_existing_desktop_mapping')
  }

  private async pollMappedChannels(actions: string[]): Promise<number> {
    const state = await this.options.store.read()
    let seen = 0
    for (const mapping of Object.values(state.channels)) {
      if (mapping.discordChannelId === state.commandChannelId) {
        continue
      }
      const messages = await this.options.discord.listMessages(mapping.discordChannelId, mapping.lastSeenMessageId)
      for (const message of messages) {
        seen += 1
        if (message.authorIsBot) {
          await this.options.store.markChannelSeen(mapping.discordChannelId, message.messageId)
          continue
        }

        await this.handleMappedChannelMessage(mapping, message, actions)
      }
    }
    return seen
  }

  private async handleMappedChannelMessage(
    mapping: RelayChannelMapping,
    message: DiscordThreadMessage,
    actions: string[],
  ): Promise<void> {
    if (mapping.desktopThreadLabel) {
      mapping = await this.syncDiscordChannelName(mapping, mapping.desktopThreadLabel, actions)
    }

    const content = stripLeadingDiscordMentions(message.content)
    if (!content) {
      const response = await this.options.discord.createMessage(
        mapping.discordChannelId,
        [
          'Discord did not expose that message body to the bot.',
          'For now, mention the bot at the start of prompts, like `@YourBot please continue the work`.',
        ].join('\n'),
      )
      await this.options.store.markChannelSeen(mapping.discordChannelId, response.messageId)
      actions.push('blank_prompt_refused')
      return
    }

    if (content.toLowerCase() === 'bind current') {
      const bindResult = await this.options.desktop.bindCurrent()
      await this.respondToDesktopResult(mapping, message, bindResult, actions, 'bind_current')
      return
    }

    if (this.isRefreshBindingCommand(content)) {
      await this.injectBindingNoteIfIdle(mapping, mapping.discordChannelId, actions)
      await this.options.store.markChannelSeen(mapping.discordChannelId, message.messageId)
      return
    }

    if (this.isRecoverPublishCommand(content)) {
      const recovery = await this.operatorRecoverPublish({ channelId: mapping.discordChannelId })
      if (recovery.ok) {
        actions.push('recover_publish_submitted')
      } else {
        const response = await this.options.discord.createMessage(
          mapping.discordChannelId,
          `Recovery prompt was not sent: ${recovery.message}`,
        )
        await this.options.store.markChannelSeen(mapping.discordChannelId, response.messageId)
        actions.push(`recover_publish_refused_${recovery.error}`)
      }
      return
    }

    if (this.isCheckCommand(content)) {
      if (!mapping.desktopThreadLabel) {
        const response = await this.options.discord.createMessage(
          mapping.discordChannelId,
          'This relay channel is not bound to a Codex desktop thread yet.',
        )
        await this.options.store.markChannelSeen(mapping.discordChannelId, response.messageId)
        actions.push('check_unbound')
        return
      }

      const check = await this.renderDesktopThreadCheck(mapping.desktopThreadLabel)
      const response = await this.options.discord.createMessage(mapping.discordChannelId, check)
      await this.options.store.markChannelSeen(mapping.discordChannelId, response.messageId)
      actions.push('check_thread')
      return
    }

    if (this.isArchiveCommand(content)) {
      await this.handleArchiveChannel(mapping, message, actions)
      return
    }

    if (mapping.status === 'waiting_for_codex') {
      const refusal = await this.options.discord.createMessage(
        mapping.discordChannelId,
        'Still waiting for Codex to publish the prior response. I did not forward this message. Type `recover publish` here to send a recovery prompt if the desktop thread is idle.',
      )
      await this.options.store.markChannelSeen(mapping.discordChannelId, refusal.messageId)
      actions.push('prompt_refused_waiting_for_codex')
      return
    }

    const correlationId = `discord-${message.messageId}`
    const prompt = `${content}${promptFooter(mapping, correlationId, this.options.config)}`

    if (shouldTryFirstPromptCreate(mapping)) {
      logger.info('relay.discord.prompt_received', {
        channel_id: mapping.discordChannelId,
        discord_message_id: message.messageId,
        prompt_length: content.length,
        prompt_sha256: sha256Text(content),
        desktop_thread_label: null,
        desktop_action: 'create_thread',
      })
      const result = await this.options.desktop.createThread({ text: prompt })
      await this.respondToDesktopResult(mapping, message, result, actions, 'create_thread')
      return
    }

    if (!mapping.desktopThreadLabel) {
      const refusal = await this.options.discord.createMessage(
        mapping.discordChannelId,
        'This Discord channel is not bound to a Codex desktop thread yet. Use `pickup` or `bind current` after the desktop adapter is enabled.',
      )
      await this.options.store.markRefused(mapping.discordChannelId, 'needs_manual_binding')
      await this.options.store.markChannelSeen(mapping.discordChannelId, refusal.messageId)
      actions.push('prompt_refused_unbound')
      return
    }

    logger.info('relay.discord.prompt_received', {
      channel_id: mapping.discordChannelId,
      discord_message_id: message.messageId,
      prompt_length: content.length,
      prompt_sha256: sha256Text(content),
      desktop_thread_label: mapping.desktopThreadLabel,
    })
    const safetyCheck = await this.findVisibleDesktopThread(mapping.desktopThreadLabel)
    if (safetyCheck.status === 'matched' && safetyCheck.thread.turnState === 'working') {
      const refusal = await this.options.discord.createMessage(
        mapping.discordChannelId,
        `Codex Desktop still shows the sidebar working indicator for ${safetyCheck.thread.label}. I did not forward this message.`,
      )
      await this.options.store.markRefused(mapping.discordChannelId, 'desktop_thread_working')
      await this.options.store.markChannelSeen(mapping.discordChannelId, refusal.messageId)
      actions.push('prompt_refused_desktop_working')
      return
    }

    const result = await this.options.desktop.submitPrompt({
      desktopThreadLabel: mapping.desktopThreadLabel,
      text: prompt,
    })
    await this.respondToDesktopResult(mapping, message, result, actions, 'prompt')
  }

  private isArchiveCommand(content: string): boolean {
    const normalized = content.replace(/\s+/g, ' ').trim().toLowerCase()
    return normalized === 'archive' || normalized === 'close' || normalized === 'cancel'
  }

  private isCheckCommand(content: string): boolean {
    const normalized = content.replace(/\s+/g, ' ').trim().toLowerCase()
    return normalized === 'check' || normalized === 'safe' || normalized === 'safe?'
  }

  private isRefreshBindingCommand(content: string): boolean {
    const normalized = content.replace(/\s+/g, ' ').trim().toLowerCase()
    return normalized === 'refresh binding' || normalized === 'bind note'
  }

  private isRecoverPublishCommand(content: string): boolean {
    const normalized = content.replace(/\s+/g, ' ').trim().toLowerCase()
    return (
      normalized === 'recover publish' ||
      normalized === 'retry publish' ||
      normalized === 'nudge publish' ||
      normalized === 'publish recovery'
    )
  }

  private async handleArchiveChannel(
    mapping: RelayChannelMapping,
    message: DiscordThreadMessage,
    actions: string[],
  ): Promise<void> {
    if (mapping.status === 'waiting_for_codex') {
      const refusal = await this.options.discord.createMessage(
        mapping.discordChannelId,
        'Still waiting for Codex to publish the prior response. I did not archive this relay channel.',
      )
      await this.options.store.markChannelSeen(mapping.discordChannelId, refusal.messageId)
      actions.push('archive_refused_waiting_for_codex')
      return
    }

    logger.info('relay.discord.channel_archive_requested', {
      channel_id: mapping.discordChannelId,
      discord_message_id: message.messageId,
      desktop_thread_label: mapping.desktopThreadLabel,
      status: mapping.status,
    })
    await this.options.discord.deleteTextChannel(mapping.discordChannelId)
    await this.options.store.deleteChannel(mapping.discordChannelId)
    logger.info('relay.discord.channel_archived', {
      channel_id: mapping.discordChannelId,
      channel_name: mapping.discordChannelName,
      desktop_thread_label: mapping.desktopThreadLabel,
    })
    await this.options.discord.createMessage(
      this.options.config.discord.commandChannelId,
      `Archived relay text channel ${mapping.discordChannelName ?? mapping.discordChannelId}${mapping.desktopThreadLabel ? ` for ${mapping.desktopThreadLabel}` : ''}.`,
    )
    actions.push('archive_channel_deleted')
  }

  private async respondToDesktopResult(
    mapping: RelayChannelMapping,
    message: DiscordThreadMessage,
    result: DesktopPromptResult,
    actions: string[],
    action: 'prompt' | 'bind_current' | 'create_thread',
  ): Promise<void> {
    if (result.result === 'submitted') {
      if (action === 'create_thread') {
        result = await this.captureSubmittedCreateThreadLabel(result, {
          channelId: mapping.discordChannelId,
          source: 'mapped_channel_first_prompt',
          correlationId: `discord-${message.messageId}`,
        })
      }
      let currentMapping = mapping
      if (action === 'bind_current' && result.desktopThreadLabel) {
        currentMapping = await this.options.store.bindChannel({
          discordChannelId: mapping.discordChannelId,
          desktopThreadLabel: result.desktopThreadLabel,
        })
      } else if (action === 'create_thread') {
        if (result.desktopThreadLabel) {
          currentMapping = await this.options.store.bindChannel({
            discordChannelId: mapping.discordChannelId,
            desktopThreadLabel: result.desktopThreadLabel,
            rotateBindingId: false,
          })
        }
        currentMapping = await this.options.store.markInboundAccepted(mapping.discordChannelId, message.messageId)
        currentMapping = await this.options.store.markBindingNoteStatus(mapping.discordChannelId, 'injected')
      } else {
        if (result.desktopThreadLabel) {
          currentMapping = await this.options.store.bindChannel({
            discordChannelId: mapping.discordChannelId,
            desktopThreadLabel: result.desktopThreadLabel,
            rotateBindingId: false,
          })
        }
        currentMapping = await this.options.store.markInboundAccepted(mapping.discordChannelId, message.messageId)
        currentMapping = await this.options.store.markBindingNoteStatus(mapping.discordChannelId, 'injected')
      }
      if (result.desktopThreadLabel) {
        await this.syncDiscordChannelName(currentMapping, result.desktopThreadLabel, actions)
      }
      const ackText =
        action === 'bind_current'
          ? `Bound to Codex desktop thread: ${result.desktopThreadLabel ?? 'current thread'}`
          : action === 'create_thread'
            ? `Created Codex desktop thread and forwarded the prompt${result.desktopThreadLabel ? `: ${result.desktopThreadLabel}` : '.'}`
          : 'Forwarded to Codex desktop.'
      const ack = await this.options.discord.createMessage(mapping.discordChannelId, ackText)
      await this.options.store.markChannelSeen(mapping.discordChannelId, ack.messageId)
      actions.push(`${action}_submitted`)
      return
    }

    const response = await this.options.discord.createMessage(
      mapping.discordChannelId,
      result.message ?? 'Desktop adapter refused this action.',
    )
    await this.options.store.markRefused(mapping.discordChannelId, result.message ?? result.result)
    await this.options.store.markChannelSeen(mapping.discordChannelId, response.messageId)
    actions.push(`${action}_refused_${result.result}`)
  }

  private async syncDiscordChannelName(
    mapping: RelayChannelMapping,
    desktopThreadLabel: string,
    actions: string[],
  ): Promise<RelayChannelMapping> {
    const desiredName = sanitizeDiscordTextChannelName(desktopThreadLabel, this.options.config.discord.channelNamePrefix)
    if (mapping.discordChannelName === desiredName) {
      return mapping
    }

    try {
      const renamed = await this.options.discord.updateTextChannelName(mapping.discordChannelId, desiredName)
      const updatedMapping = await this.options.store.ensureChannel({
        discordChannelId: mapping.discordChannelId,
        discordChannelName: renamed.name,
      })
      logger.info('relay.discord.channel_renamed', {
        channel_id: mapping.discordChannelId,
        old_channel_name: mapping.discordChannelName,
        new_channel_name: renamed.name,
        desktop_thread_label: desktopThreadLabel,
      })
      actions.push('discord_channel_renamed')
      return updatedMapping
    } catch (error) {
      logger.warn('relay.discord.channel_rename_failed', {
        channel_id: mapping.discordChannelId,
        desired_channel_name: desiredName,
        desktop_thread_label: desktopThreadLabel,
        message: error instanceof Error ? error.message : String(error),
      })
      actions.push('discord_channel_rename_failed')
      return mapping
    }
  }

  private async renderStatus(): Promise<string> {
    const state = await this.options.store.read()
    const orchestrationLine = state.orchestration.activeRunId
      ? `Active orchestration run: ${state.orchestration.activeRunId}`
      : 'Active orchestration run: none'
    const mappings = Object.values(state.channels).filter((mapping) => mapping.discordChannelId !== state.commandChannelId)
    if (mappings.length === 0) {
      return ['No Codex relay text channels are mapped yet.', orchestrationLine].join('\n')
    }

    return [
      ...mappings.map((mapping) => {
        const label = mapping.desktopThreadLabel ?? 'unbound'
        const turn = mapping.lastDesktopTurnState
          ? ` - turn ${mapping.lastDesktopTurnState}${mapping.lastDesktopTurnStateAt ? ` @ ${mapping.lastDesktopTurnStateAt}` : ''}`
          : ''
        return `${mapping.shortLabel}. <#${mapping.discordChannelId}> - ${mapping.status} - ${label}${turn}`
      }),
      orchestrationLine,
    ].join('\n')
  }
}
