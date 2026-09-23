import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

import {
  type CompletionReturn,
  type BindingMetadata,
  type ParallelGroupItem,
  type ParallelGroupStep,
  type ResolvedStep,
  type ResolvedParallelGroupStep,
  type RunAutomationSettings,
  type RunnerManualAction,
  type RunState,
  type RunnerEvent,
  type ValidationIssue,
  type ValidationResult,
  type WorkPlan,
  type SerialReportCommands,
  getAllowedActions,
  isManualActionAllowed,
  isSerialStep,
  isResolvedSerialStep,
  parseProtocolRunnerStepStartReport,
  parseProtocolRunnerStatusReport,
  renderPrompt,
  resolveCurrentStep,
  resolveTransition,
  validateStepStartReport,
  validateStatusReportForStep,
  validateWorkPlan,
} from '../../../packages/protocol-runner-core/dist/index.js'

import type {
  CodexDesktopAdapter,
  DesktopOperatorGateResult,
  DiscordRelayAdapter,
  PromptSendResult,
  RelayCloseResult,
  SendPromptInput,
} from './adapters.js'
import type {
  DeleteRunResult,
  GrantParallelLeasesInput,
  ParallelAttemptWarning,
  ParallelAttemptWarningCode,
  ParallelAttemptResultRecord,
  ParallelAttemptResultStatus,
  ParallelGroupControlAction,
  ParallelGroupState,
  ParallelPreflightCheck,
  ParallelPreflightResult,
  RecoverStaleParallelLeasesInput,
  RecordParallelAttemptResultInput,
  RunInspection,
  RunnerStore,
  StoreFileRef,
  StoredRun,
} from './store.js'
import { RunnerStoreError } from './store.js'
import { requireReleasedSourceHandoffs } from './source-closeout.js'
import {
  NoopRunnerAttentionNotifier,
  type RunnerAttentionNotification,
  type RunnerAttentionNotifier,
} from './run-notifier.js'

type JsonRecord = Record<string, unknown>
type RunStatePatch = Omit<Partial<RunState>, 'timestamps'> & {
  timestamps?: Partial<RunState['timestamps']>
}
type SendOperation = 'start' | 'resume' | 'retry-current'
type SealedOutputDescendantPolicy = 'reject' | 'allow_empty' | 'allow'
const PARALLEL_ATTEMPT_WARNING_CODES = new Set<ParallelAttemptWarningCode>(['long_running', 'possibly_stalled'])

export class ProtocolRunnerError extends Error {
  readonly code: string
  readonly http_status: number
  readonly details: JsonRecord

  constructor(code: string, message: string, http_status = 400, details: JsonRecord = {}) {
    super(message)
    this.name = 'ProtocolRunnerError'
    this.code = code
    this.http_status = http_status
    this.details = details
  }
}

export interface ProtocolRunnerControllerOptions {
  store: RunnerStore
  desktop_adapter: CodexDesktopAdapter
  relay_adapter: DiscordRelayAdapter
  contract_root?: string
  report_commands?: SerialReportCommands
  notification_notifier?: RunnerAttentionNotifier
  now?: () => Date
}

export interface CreateRunRequest {
  run_instance_id?: string
  work_plan?: WorkPlan
  automation?: Partial<RunAutomationSettings>
  auto_pickup?: boolean
  auto_advance?: boolean
}

export interface SetAutomationRequest {
  auto_pickup?: boolean
  auto_advance?: boolean
}

export interface BindRunRequest {
  binding_kind?: BindingMetadata['binding_kind']
  visible_thread_label?: string
  relay_channel_id?: string
  relay_channel_name?: string
  binding_id?: string
}

interface NormalizedBindRunRequest extends BindRunRequest {
  binding_kind: BindingMetadata['binding_kind']
}

export interface ReturnRunRequest {
  run_instance_id?: string
  step_id?: string
  status?: string
  summary?: string
}

export interface StepStartReportRequest {
  run_instance_id?: string
  step_id?: string
  prompt_attempt_id?: string
  start_token?: string
}

export interface CloseRunRequest {
  delete_sealed_outputs?: boolean
  source_handoff_acknowledgements?: string[]
}

export interface ParallelLeaseRequest {
  executor_id?: string
  capacity?: number
  lease_ttl_ms?: number
}

export interface ParallelHeartbeatRequest {
  heartbeat_at?: string
  attempt_warnings?: unknown[]
}

export interface ParallelRecoverStaleRequest {
  observed_at?: string
}

export interface ParallelAttemptResultRequest {
  lease_id?: string
  attempt_id?: string
  launcher_status?: string
  status_report?: Record<string, unknown>
  process?: Record<string, unknown>
  status_report_path?: string
  sealed_output_path?: string
  result_path?: string
  summary?: string
}

export interface ParallelRetryRequest {
  requested_by?: string
  reason?: string
}

export interface ParallelCancelRequest {
  lease_id?: string
  reason?: string
}

export interface ParallelGroupControlRequest {
  reason?: string
}

export interface RunView {
  run_instance_id: string
  state: RunState
  work_plan: WorkPlan
}

export interface RunDiagnostics {
  run_instance_id: string
  status: RunState['status']
  current_step_id: string | null
  current_step_ordinal: number | null
  automation: RunAutomationSettings
  blocked_reason?: string
  next_allowed_actions: ReturnType<typeof getAllowedActions>
  last_event: RunnerEvent | null
  parallel_groups: ParallelGroupState[]
  latest_files: RunInspection['latest_files']
  evidence_paths: {
    run_dir: string
    work_plan_path: string
    state_path: string
    events_path: string
    latest_files: RunInspection['latest_files']
  }
}

export interface RunFileRead {
  content_type: string
  text: string
}

export interface RunCloseoutResult {
  run_instance_id: string
  closed_run: RunView
  relay_cleanup: RelayCloseResult | null
  sealed_output_cleanup: SealedOutputCleanupResult
  artifact_cleanup: DeleteRunResult
}

export interface SealedOutputCleanupTarget {
  step_id: string
  group_id: string
  item_id: string
  target: string
  path: string
  deleted: boolean
  missing: boolean
  deleted_empty_dirs: string[]
}

export interface SealedOutputCleanupResult {
  requested: boolean
  contract_root: string
  target_count: number
  deleted_files: number
  missing_files: number
  deleted_empty_dirs: number
  targets: SealedOutputCleanupTarget[]
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ProtocolRunnerError('request.invalid', `${name} must be a non-empty string.`)
  }

  return value.trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function issueSummary(result: ValidationResult): string {
  return result.issues.map((issue) => `${issue.code}: ${issue.message}`).join('; ')
}

function promptMessageId(result: PromptSendResult): string | undefined {
  return result.item_id ?? result.turn_id ?? undefined
}

function formatPromptAttemptId(attempt: number): string {
  return `attempt_${String(attempt).padStart(3, '0')}`
}

function shouldAwaitStartReport(result: PromptSendResult): boolean {
  return result.send_status === 'sent'
}

function normalizeAutomationRequest(input: CreateRunRequest | SetAutomationRequest): Partial<RunAutomationSettings> {
  return {
    ...('automation' in input && input.automation !== undefined ? input.automation : {}),
    ...('auto_pickup' in input && input.auto_pickup !== undefined ? { auto_pickup: input.auto_pickup } : {}),
    ...('auto_advance' in input && input.auto_advance !== undefined ? { auto_advance: input.auto_advance } : {}),
  }
}

function mergeAutomation(
  current: RunAutomationSettings,
  patch: Partial<RunAutomationSettings>,
): RunAutomationSettings {
  return {
    auto_pickup: patch.auto_pickup ?? current.auto_pickup,
    auto_advance: patch.auto_advance ?? current.auto_advance,
  }
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

export class ProtocolRunnerController {
  private readonly store: RunnerStore
  private readonly desktop_adapter: CodexDesktopAdapter
  private readonly relay_adapter: DiscordRelayAdapter
  private readonly contract_root: string
  private readonly report_commands: SerialReportCommands | undefined
  private readonly notification_notifier: RunnerAttentionNotifier
  private readonly now: () => Date

  constructor(options: ProtocolRunnerControllerOptions) {
    this.store = options.store
    this.desktop_adapter = options.desktop_adapter
    this.relay_adapter = options.relay_adapter
    this.contract_root = path.resolve(options.contract_root ?? process.cwd())
    this.report_commands = options.report_commands
    this.notification_notifier = options.notification_notifier ?? new NoopRunnerAttentionNotifier()
    this.now = options.now ?? (() => new Date())
  }

  async health(): Promise<JsonRecord> {
    return {
      ok: true,
      service: 'protocol-runner-api',
      adapters: {
        codex_desktop: await this.desktop_adapter.health(),
        discord_relay: {
          health: await this.relay_adapter.health(),
          ready: await this.relay_adapter.ready(),
        },
      },
    }
  }

  async diagnostics(): Promise<JsonRecord> {
    const desktopState = await this.desktop_adapter.getState()
    return {
      ok: true,
      service: 'protocol-runner-api',
      store: {
        ...(await this.store.getDiagnostics()),
        runs: await this.store.listRuns(),
      },
      adapters: {
        codex_desktop: {
          health: await this.desktop_adapter.health(),
          state: desktopState,
        },
        discord_relay: {
          health: await this.relay_adapter.health(),
          ready: await this.relay_adapter.ready(),
          state: await this.relay_adapter.getState(),
        },
      },
    }
  }

  async listRuns(): Promise<JsonRecord> {
    return {
      runs: await this.store.listRuns(),
    }
  }

  async desktopOperatorGate(): Promise<DesktopOperatorGateResult> {
    return this.desktop_adapter.operatorGateState()
  }

  async desktopOperatorGateWait(): Promise<DesktopOperatorGateResult> {
    return this.desktop_adapter.operatorGateWait()
  }

  async desktopOperatorGateAllowNow(): Promise<DesktopOperatorGateResult> {
    return this.desktop_adapter.operatorGateAllowNow()
  }

  async createRun(input: CreateRunRequest): Promise<RunView> {
    if (input.work_plan === undefined) {
      throw new ProtocolRunnerError('request.work_plan_required', 'work_plan is required.')
    }

    const run_instance_id = input.run_instance_id ?? this.defaultRunInstanceId()
    const stored = await this.store.createRun({
      run_instance_id,
      work_plan: input.work_plan,
      automation: normalizeAutomationRequest(input),
    })
    return this.toRunView(stored)
  }

  async getRun(run_instance_id: string): Promise<RunView> {
    return this.toRunView(await this.store.loadRun(run_instance_id))
  }

  async validateRun(run_instance_id: string): Promise<JsonRecord> {
    const stored = await this.store.loadRun(run_instance_id)
    this.requireManualAction(stored, 'validate')
    const validation = await this.validateRunDefinition(stored.work_plan)
    return {
      ok: validation.ok,
      issues: validation.issues,
      state: stored.state,
    }
  }

  async preflightParallelGroup(run_instance_id: string, group_id: string): Promise<JsonRecord> {
    const stored = await this.store.loadRun(run_instance_id)
    const step = this.currentStep(stored)
    if (isResolvedSerialStep(step)) {
      throw new ProtocolRunnerError(
        'run.current_step_not_parallel_group',
        'Parallel preflight is allowed only when the current step is a parallel_group.',
        409,
        {
          current_step_id: step.step_id,
          current_step_kind: step.step_kind,
        },
      )
    }

    if (step.group_id !== group_id) {
      throw new ProtocolRunnerError(
        'run.parallel_group_not_current',
        `Requested group_id=${group_id} is not the current parallel group.`,
        409,
        {
          current_group_id: step.group_id,
          requested_group_id: group_id,
        },
      )
    }

    const groupBeforePreflight = await this.store.getParallelGroup(run_instance_id, group_id)
    const launchableItemIds = new Set(
      groupBeforePreflight.items.filter((item) => item.status === 'pending').map((item) => item.item_id),
    )
    const checks = await this.runParallelPreflightChecks(stored, step, launchableItemIds)
    const errors = checks.filter((check) => check.status === 'failed')
    const warnings = checks.filter((check) => check.status === 'warning')
    const checked_at = this.now().toISOString()
    const preflight: ParallelPreflightResult = {
      run_instance_id,
      step_id: step.step_id,
      group_id: step.group_id,
      passed: errors.length === 0,
      preflight_status: errors.length === 0 ? 'passed' : 'failed',
      checked_at,
      checked_by: 'protocol-runner-api',
      checks,
      errors,
      warnings,
      executor_summary: {
        executor: step.executor,
        worker_launch: 'executor_owned_after_preflight',
        required_worker_capabilities: step.required_worker_capabilities ?? [],
      },
      max_concurrency: step.max_concurrency,
      item_count: step.items.length,
      launchable_item_count: errors.length === 0 ? launchableItemIds.size : 0,
    }

    const recorded = await this.store.recordParallelPreflight(run_instance_id, {
      step,
      result: preflight,
    })
    const prior = await this.store.loadRun(run_instance_id)
    const next = await this.updateStoredState(prior, {
      status: recorded.passed ? 'ready' : 'blocked',
      blocked_reason: recorded.passed ? undefined : `Parallel preflight failed: ${this.preflightErrorSummary(recorded)}`,
    })
    await this.store.appendEvent(run_instance_id, {
      event_type: 'diagnostic',
      step_id: step.step_id,
      details: {
        action: 'parallel_preflight',
        group_id: step.group_id,
        passed: recorded.passed,
        preflight_status: recorded.preflight_status,
        errors: recorded.errors,
        warnings: recorded.warnings,
        evidence_file: recorded.evidence_file,
      },
    })
    await this.appendStateChanged(prior, next, recorded.passed ? 'parallel preflight passed' : 'parallel preflight failed')

    return {
      run: this.toRunView(await this.store.loadRun(run_instance_id)),
      group: await this.store.getParallelGroup(run_instance_id, group_id),
      preflight: recorded,
    }
  }

  async grantParallelLeases(run_instance_id: string, group_id: string, input: ParallelLeaseRequest): Promise<JsonRecord> {
    const stored = await this.store.loadRun(run_instance_id)
    const step = this.currentParallelStep(stored, group_id, 'lease')
    const leaseInput: GrantParallelLeasesInput = {
      executor_id: requireString(input.executor_id, 'executor_id'),
      capacity: this.requirePositiveInteger(input.capacity, 'capacity'),
      ...(input.lease_ttl_ms !== undefined
        ? { lease_ttl_ms: this.requirePositiveInteger(input.lease_ttl_ms, 'lease_ttl_ms') }
        : {}),
    }
    const grant = await this.store.grantParallelLeases(run_instance_id, group_id, leaseInput)
    if (step.participation === 'source_writer') {
      for (const lease of grant.leases) {
        const item = step.items.find((candidate) => candidate.item_id === lease.item_id)
        if (step.source_base_commit === undefined || item?.owned_source_paths === undefined) {
          throw new ProtocolRunnerError('source_writer.invalid_plan', 'Source-writer plan lost its base or owned files.', 409)
        }
        lease.source_writer = {
          base_commit: step.source_base_commit,
          owned_paths: [...item.owned_source_paths],
          artifact_root: this.contract_root,
        }
      }
    }
    const latestStored = await this.store.loadRun(run_instance_id)
    if (grant.leases.length > 0 && latestStored.state.status !== 'running') {
      const updated = await this.updateStoredState(latestStored, {
        status: 'running',
        blocked_reason: undefined,
      })
      await this.appendStateChanged(latestStored, updated, 'parallel leases granted')
    }
    await this.store.appendEvent(run_instance_id, {
      event_type: 'diagnostic',
      step_id: latestStored.state.current_step_id ?? undefined,
      details: {
        action: 'parallel_leases_granted',
        group_id,
        executor_id: leaseInput.executor_id,
        requested_capacity: leaseInput.capacity,
        granted_count: grant.leases.length,
        lease_ids: grant.leases.map((lease) => lease.lease_id),
      },
    })
    return this.parallelEnvelope(run_instance_id, group_id, {
      leases: grant.leases,
    })
  }

  async heartbeatParallelLease(
    run_instance_id: string,
    group_id: string,
    lease_id: string,
    input: ParallelHeartbeatRequest,
  ): Promise<JsonRecord> {
    const stored = await this.store.loadRun(run_instance_id)
    this.currentParallelStep(stored, group_id, 'heartbeat')
    const attempt_warnings =
      input.attempt_warnings === undefined ? undefined : this.normalizeAttemptWarnings(input.attempt_warnings)
    const lease = await this.store.recordParallelHeartbeat(run_instance_id, group_id, lease_id, {
      ...(input.heartbeat_at !== undefined ? { heartbeat_at: requireString(input.heartbeat_at, 'heartbeat_at') } : {}),
      ...(attempt_warnings !== undefined ? { attempt_warnings } : {}),
    })
    await this.store.appendEvent(run_instance_id, {
      event_type: 'diagnostic',
      step_id: stored.state.current_step_id ?? undefined,
      details: {
        action: 'parallel_heartbeat',
        group_id,
        lease_id,
        attempt_id: lease.attempt_id,
        heartbeat_at: lease.heartbeat_at,
        warning_codes: attempt_warnings?.map((warning) => warning.code),
      },
    })
    return this.parallelEnvelope(run_instance_id, group_id, { lease })
  }

  async recoverStaleParallelLeases(
    run_instance_id: string,
    group_id: string,
    input: ParallelRecoverStaleRequest,
  ): Promise<JsonRecord> {
    const stored = await this.store.loadRun(run_instance_id)
    const step = this.currentParallelStep(stored, group_id, 'recover-stale-leases')
    const recoveryInput: RecoverStaleParallelLeasesInput = {
      ...(input.observed_at !== undefined ? { observed_at: requireString(input.observed_at, 'observed_at') } : {}),
    }
    const recovery = await this.store.recoverStaleParallelLeases(run_instance_id, group_id, recoveryInput)
    await this.store.appendEvent(run_instance_id, {
      event_type: 'diagnostic',
      step_id: step.step_id,
      details: {
        action: 'parallel_recover_stale_leases',
        group_id,
        observed_at: recovery.observed_at,
        stale_lease_ids: recovery.stale_lease_ids,
        stale_attempt_ids: recovery.stale_attempt_ids,
        stale_item_ids: recovery.stale_item_ids,
        requeued_lease_ids: recovery.requeued_lease_ids,
        requeued_attempt_ids: recovery.requeued_attempt_ids,
        requeued_item_ids: recovery.requeued_item_ids,
        attention_lease_ids: recovery.attention_lease_ids,
        attention_attempt_ids: recovery.attention_attempt_ids,
        attention_item_ids: recovery.attention_item_ids,
      },
    })
    if (recovery.attention_lease_ids.length > 0 && recovery.group.status === 'needs_attention') {
      const latestStored = await this.store.loadRun(run_instance_id)
      const updated = await this.updateStoredState(latestStored, {
        status: 'blocked',
        blocked_reason: `Parallel group ${group_id} needs attention after ${recovery.attention_lease_ids.length} evidence-bearing or ambiguous stale lease(s).`,
      })
      await this.appendStateChanged(latestStored, updated, 'parallel stale leases recovered')
    }

    return this.parallelEnvelope(run_instance_id, group_id, {
      observed_at: recovery.observed_at,
      recovered_count: recovery.stale_lease_ids.length,
      stale_lease_ids: recovery.stale_lease_ids,
      stale_attempt_ids: recovery.stale_attempt_ids,
      stale_item_ids: recovery.stale_item_ids,
      requeued_lease_ids: recovery.requeued_lease_ids,
      requeued_attempt_ids: recovery.requeued_attempt_ids,
      requeued_item_ids: recovery.requeued_item_ids,
      attention_lease_ids: recovery.attention_lease_ids,
      attention_attempt_ids: recovery.attention_attempt_ids,
      attention_item_ids: recovery.attention_item_ids,
    })
  }

  async acceptParallelAttemptResult(
    run_instance_id: string,
    group_id: string,
    attempt_id: string,
    input: ParallelAttemptResultRequest,
  ): Promise<JsonRecord> {
    const stored = await this.store.loadRun(run_instance_id)
    const step = this.currentParallelStep(stored, group_id, 'attempt-result')
    const resultInput = this.normalizeParallelAttemptResult(run_instance_id, group_id, step.step_id, attempt_id, input)
    const record = await this.store.recordParallelAttemptResult(run_instance_id, group_id, resultInput)
    await this.store.appendEvent(run_instance_id, {
      event_type: 'diagnostic',
      step_id: step.step_id,
      details: {
        action: 'parallel_attempt_result',
        group_id,
        attempt_id: resultInput.attempt_id,
        lease_id: resultInput.lease_id,
        classified_status: resultInput.status,
        status_report: resultInput.status_report,
      },
    })
    await this.applyParallelGroupOutcome(run_instance_id, step, record)
    return this.parallelEnvelope(run_instance_id, group_id, {
      attempt: record.attempt,
      lease: record.lease,
    })
  }

  async retryParallelItem(
    run_instance_id: string,
    group_id: string,
    item_id: string,
    input: ParallelRetryRequest,
  ): Promise<JsonRecord> {
    const stored = await this.store.loadRun(run_instance_id)
    const step = this.currentParallelStep(stored, group_id, 'retry-item')
    const retry = await this.store.retryParallelItem(run_instance_id, group_id, item_id, input)
    const latestStored = await this.store.loadRun(run_instance_id)
    if (latestStored.state.status !== 'ready') {
      const updated = await this.updateStoredState(latestStored, {
        status: 'ready',
        blocked_reason: undefined,
      })
      await this.appendStateChanged(latestStored, updated, 'parallel item retry requested')
    }
    await this.store.appendEvent(run_instance_id, {
      event_type: 'manual_action',
      step_id: step.step_id,
      details: {
        action: 'parallel_retry_item',
        group_id,
        item_id,
        previous_attempt_id: retry.previous_attempt_id,
        new_attempt_id: retry.attempt.attempt_id,
        requested_by: input.requested_by,
        reason: input.reason,
      },
    })
    return this.parallelEnvelope(run_instance_id, group_id, {
      attempt: retry.attempt,
      previous_attempt_id: retry.previous_attempt_id,
    })
  }

  async cancelParallelAttempt(
    run_instance_id: string,
    group_id: string,
    attempt_id: string,
    input: ParallelCancelRequest,
  ): Promise<JsonRecord> {
    const stored = await this.store.loadRun(run_instance_id)
    const step = this.currentParallelStep(stored, group_id, 'cancel-attempt')
    const lease_id = requireString(input.lease_id, 'lease_id')
    const record = await this.store.recordParallelAttemptResult(run_instance_id, group_id, {
      attempt_id,
      lease_id,
      status: 'cancelled',
      summary: input.reason,
    })
    await this.store.appendEvent(run_instance_id, {
      event_type: 'manual_action',
      step_id: step.step_id,
      details: {
        action: 'parallel_cancel_attempt',
        group_id,
        attempt_id,
        lease_id,
        reason: input.reason,
      },
    })
    await this.applyParallelGroupOutcome(run_instance_id, step, record)
    return this.parallelEnvelope(run_instance_id, group_id, {
      attempt: record.attempt,
      lease: record.lease,
    })
  }

  async controlParallelGroup(
    run_instance_id: string,
    group_id: string,
    action: ParallelGroupControlAction,
    input: ParallelGroupControlRequest = {},
  ): Promise<JsonRecord> {
    const stored = await this.store.loadRun(run_instance_id)
    const step = this.currentParallelStep(stored, group_id, action)
    const group = await this.store.controlParallelGroup(run_instance_id, group_id, action, { reason: input.reason })
    const latestStored = await this.store.loadRun(run_instance_id)
    const nextStatus: RunState['status'] = action === 'pause' ? 'paused' : 'blocked'
    const stopReason = input.reason ?? `Parallel group stopped: ${group_id}`
    const updated = await this.updateStoredState(latestStored, {
      status: nextStatus,
      blocked_reason: action === 'stop' ? stopReason : latestStored.state.blocked_reason,
    })
    await this.store.appendEvent(run_instance_id, {
      event_type: 'manual_action',
      step_id: step.step_id,
      details: {
        action: `parallel_${action}`,
        group_id,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      },
    })
    await this.appendStateChanged(latestStored, updated, `parallel group ${action}`)
    return this.parallelEnvelope(run_instance_id, group_id, { group })
  }

  async bindRun(run_instance_id: string, input: BindRunRequest): Promise<RunView> {
    const stored = await this.store.loadRun(run_instance_id)
    this.requireManualAction(stored, 'bind-thread')
    const bindingRequest = this.normalizeBindRunRequest(stored.work_plan, input)

    let binding: BindingMetadata
    try {
      binding = await this.relay_adapter.bindRun({
        run_instance_id,
        binding_kind: bindingRequest.binding_kind,
        visible_thread_label: bindingRequest.visible_thread_label,
        relay_channel_id: input.relay_channel_id,
        relay_channel_name: input.relay_channel_name,
        binding_id: input.binding_id,
      })
    } catch (error) {
      throw new ProtocolRunnerError(
        'adapter.relay_bind_failed',
        error instanceof Error ? error.message : String(error),
        502,
      )
    }
    const updated = await this.updateState(stored, {
      status: stored.state.status === 'draft' ? 'bound' : stored.state.status,
      thread_binding: binding,
    })
    await this.store.appendEvent(run_instance_id, {
      event_type: 'run_bound',
      details: { thread_binding: binding },
    })
    await this.appendStateChanged(stored, updated, 'bind')
    return this.toRunView(await this.store.loadRun(run_instance_id))
  }

  private normalizeBindRunRequest(work_plan: WorkPlan, input: BindRunRequest): NormalizedBindRunRequest {
    const legacy = input as BindRunRequest & { thread_id?: unknown; thread_label?: unknown }
    if (legacy.thread_id !== undefined || legacy.thread_label !== undefined) {
      throw new ProtocolRunnerError(
        'request.legacy_thread_binding_rejected',
        'Protocol Runner binding no longer accepts thread_id/thread_label. Use binding_kind and visible_thread_label.',
        400,
      )
    }

    const visible_thread_label =
      input.visible_thread_label === undefined ? undefined : requireString(input.visible_thread_label, 'visible_thread_label')
    const binding_kind = input.binding_kind ?? (visible_thread_label ? 'serial_desktop' : 'parallel_only')
    if (binding_kind !== 'serial_desktop' && binding_kind !== 'parallel_only') {
      throw new ProtocolRunnerError('request.invalid', 'binding_kind must be serial_desktop or parallel_only.', 400)
    }
    if (binding_kind === 'serial_desktop' && !visible_thread_label) {
      throw new ProtocolRunnerError(
        'request.visible_thread_label_required',
        'serial_desktop binding requires visible_thread_label.',
        400,
      )
    }
    if (binding_kind === 'parallel_only' && work_plan.steps.some(isSerialStep)) {
      throw new ProtocolRunnerError(
        'request.serial_binding_required',
        'Runs with serial steps require serial_desktop binding and a visible_thread_label.',
        400,
      )
    }
    return {
      ...input,
      binding_kind,
      visible_thread_label,
    }
  }

  private requireSerialDesktopBinding(binding: BindingMetadata): BindingMetadata {
    if (binding.binding_kind !== 'serial_desktop' || !binding.visible_thread_label) {
      throw new ProtocolRunnerError(
        'run.serial_desktop_binding_required',
        'Serial Desktop prompt delivery requires serial_desktop binding with visible_thread_label.',
        409,
      )
    }
    return binding
  }

  async setAutomation(run_instance_id: string, input: SetAutomationRequest): Promise<RunView> {
    const stored = await this.store.loadRun(run_instance_id)
    if (stored.state.status === 'closed') {
      throw new ProtocolRunnerError('run.invalid_status', 'Cannot update automation for a closed run.', 409)
    }

    const automation = mergeAutomation(stored.state.automation, normalizeAutomationRequest(input))
    const updated = await this.updateState(stored, { automation })
    await this.store.appendEvent(run_instance_id, {
      event_type: 'automation_updated',
      step_id: stored.state.current_step_id ?? undefined,
      details: { automation },
    })
    await this.appendStateChanged(stored, updated, 'automation')
    return this.toRunView(await this.store.loadRun(run_instance_id))
  }

  async startRun(run_instance_id: string): Promise<JsonRecord> {
    const stored = await this.store.loadRun(run_instance_id)
    this.requireManualAction(stored, 'start')

    const step = this.currentStep(stored)
    if (!isResolvedSerialStep(step)) {
      return this.startParallelGroup(stored, step)
    }

    return this.sendCurrentPrompt(stored, 'start')
  }

  async pauseRun(run_instance_id: string): Promise<RunView> {
    const stored = await this.store.loadRun(run_instance_id)
    this.requireManualAction(stored, 'pause')

    const updated = await this.updateState(stored, { status: 'paused' })
    await this.store.appendEvent(run_instance_id, {
      event_type: 'manual_action',
      step_id: stored.state.current_step_id ?? undefined,
      details: { action: 'pause' },
    })
    await this.appendStateChanged(stored, updated, 'pause')
    return this.toRunView(await this.store.loadRun(run_instance_id))
  }

  async resumeRun(run_instance_id: string): Promise<JsonRecord> {
    const stored = await this.store.loadRun(run_instance_id)
    this.requireManualAction(stored, 'resume')

    const step = this.currentStep(stored)
    if (!isResolvedSerialStep(step)) {
      if (stored.state.status === 'paused') {
        return this.resumeParallelGroup(stored, step)
      }
      return this.startParallelGroup(stored, step)
    }

    return this.sendCurrentPrompt(stored, 'resume')
  }

  async retryCurrent(run_instance_id: string): Promise<JsonRecord> {
    const stored = await this.store.loadRun(run_instance_id)
    this.requireManualAction(stored, 'retry-current')

    return this.sendCurrentPrompt(stored, 'retry-current')
  }

  async failRun(run_instance_id: string, reason: string): Promise<RunView> {
    const stored = await this.store.loadRun(run_instance_id)
    this.requireManualAction(stored, 'fail')

    const updated = await this.updateState(stored, {
      status: 'failed',
      blocked_reason: reason,
    })
    await this.store.appendEvent(run_instance_id, {
      event_type: 'manual_action',
      step_id: stored.state.current_step_id ?? undefined,
      details: { action: 'fail', reason },
    })
    await this.appendStateChanged(stored, updated, 'fail')
    return this.toRunView(await this.store.loadRun(run_instance_id))
  }

  async closeRun(run_instance_id: string, input: CloseRunRequest = {}): Promise<RunCloseoutResult> {
    const stored = await this.store.loadRun(run_instance_id)
    this.requireManualAction(stored, 'close')
    const closeRequest = this.normalizeCloseRunRequest(input)
    await this.requireSourceHandoffsReleased(stored, closeRequest.source_handoff_acknowledgements ?? [])
    const outputStorageOverlaps: JsonRecord[] = []
    for (const step of stored.work_plan.steps) {
      if (step.step_kind !== 'parallel_group') {
        continue
      }
      const overlap = await this.sealedOutputRunDirOverlap(
        run_instance_id,
        step,
        closeRequest.delete_sealed_outputs ? 'allow' : 'allow_empty',
      )
      if (overlap !== null) {
        outputStorageOverlaps.push(overlap)
      }
    }
    if (outputStorageOverlaps.length > 0) {
      throw new ProtocolRunnerError(
        'closeout.sealed_output_run_dir_overlap',
        'Refusing closeout because declared sealed-output storage overlaps the runner-owned run directory.',
        409,
        {
          run_dir: this.store.getRunPaths(run_instance_id).run_dir,
          overlaps: outputStorageOverlaps,
        },
      )
    }
    const sealed_output_cleanup = closeRequest.delete_sealed_outputs
      ? await this.cleanupDeclaredSealedOutputs(stored.work_plan)
      : this.emptySealedOutputCleanup(false)
    if (sealed_output_cleanup.requested) {
      await this.store.appendEvent(run_instance_id, {
        event_type: 'diagnostic',
        step_id: stored.state.current_step_id ?? undefined,
        details: {
          action: 'sealed_output_cleanup',
          sealed_output_cleanup,
        },
      })

      const remainingOutputStorageOverlaps: JsonRecord[] = []
      for (const step of stored.work_plan.steps) {
        if (step.step_kind !== 'parallel_group') {
          continue
        }
        const overlap = await this.sealedOutputRunDirOverlap(run_instance_id, step, 'allow_empty')
        if (overlap !== null) {
          remainingOutputStorageOverlaps.push(overlap)
        }
      }
      if (remainingOutputStorageOverlaps.length > 0) {
        throw new ProtocolRunnerError(
          'closeout.sealed_output_run_dir_overlap',
          'Refusing run-directory retirement because undeclared output remains in overlapping sealed-output storage.',
          409,
          {
            run_dir: this.store.getRunPaths(run_instance_id).run_dir,
            overlaps: remainingOutputStorageOverlaps,
            sealed_output_cleanup,
          },
        )
      }
    }

    const updated = await this.updateState(stored, { status: 'closed' })
    await this.store.appendEvent(run_instance_id, {
      event_type: 'manual_action',
      step_id: stored.state.current_step_id ?? undefined,
      details: { action: 'close' },
    })
    await this.appendStateChanged(stored, updated, 'close')
    let closedStored = await this.store.loadRun(run_instance_id)
    let relay_cleanup: RelayCloseResult | null = null
    const binding = closedStored.state.thread_binding
    if (binding?.relay_channel_id !== undefined) {
      try {
        relay_cleanup = await this.relay_adapter.closeRunBinding({
          channel_id: binding.relay_channel_id,
          force: true,
          correlation_id: `protocol-runner-closeout-${run_instance_id}`,
        })
      } catch (error) {
        relay_cleanup = {
          ok: false,
          channel_id: binding.relay_channel_id,
          cleanup_state: 'cleanup_failed',
          message: error instanceof Error ? error.message : String(error),
        }
      }

      const stateWithCleanup = await this.updateStoredState(closedStored, {
        thread_binding: {
          ...binding,
          cleanup_state: relay_cleanup.cleanup_state,
        },
      })
      await this.store.appendEvent(run_instance_id, {
        event_type: 'diagnostic',
        step_id: closedStored.state.current_step_id ?? undefined,
        details: {
          action: 'relay_cleanup',
          relay_cleanup,
        },
      })
      closedStored = {
        ...closedStored,
        state: stateWithCleanup,
      }
    }

    const closed_run = this.toRunView(closedStored)
    const artifact_cleanup = await this.store.deleteRun(run_instance_id)
    return {
      run_instance_id,
      closed_run,
      relay_cleanup,
      sealed_output_cleanup,
      artifact_cleanup,
    }
  }

  private normalizeCloseRunRequest(input: CloseRunRequest): Required<CloseRunRequest> {
    if (input.delete_sealed_outputs !== undefined && typeof input.delete_sealed_outputs !== 'boolean') {
      throw new ProtocolRunnerError('request.invalid', 'delete_sealed_outputs must be a boolean.')
    }
    if (input.source_handoff_acknowledgements !== undefined && (!Array.isArray(input.source_handoff_acknowledgements)
      || input.source_handoff_acknowledgements.some((value) => typeof value !== 'string' || !/^[A-Za-z0-9_-]+@[0-9a-f]{40}$/.test(value)))) {
      throw new ProtocolRunnerError('request.invalid', 'source_handoff_acknowledgements must contain exact attempt_id@commit values.')
    }
    return {
      delete_sealed_outputs: input.delete_sealed_outputs === true,
      source_handoff_acknowledgements: input.source_handoff_acknowledgements ?? [],
    }
  }

  private async requireSourceHandoffsReleased(stored: StoredRun, acknowledgements: string[]): Promise<void> {
    const sourceGroups = new Set(stored.work_plan.steps.filter((step) => step.step_kind === 'parallel_group'
      && step.participation === 'source_writer').map((step) => (step as ParallelGroupStep).group_id))
    if (sourceGroups.size === 0) return
    try {
      const groups = (await this.store.listParallelGroups(stored.run_instance_id)).filter((group) => sourceGroups.has(group.group_id))
      await requireReleasedSourceHandoffs(stored.run_instance_id, this.store.getRunPaths(stored.run_instance_id).run_dir, groups, acknowledgements)
    } catch (error) {
      throw new ProtocolRunnerError('closeout.source_handoff_required', error instanceof Error ? error.message : String(error), 409)
    }
  }

  private emptySealedOutputCleanup(requested: boolean): SealedOutputCleanupResult {
    return {
      requested,
      contract_root: this.contract_root,
      target_count: 0,
      deleted_files: 0,
      missing_files: 0,
      deleted_empty_dirs: 0,
      targets: [],
    }
  }

  private async cleanupDeclaredSealedOutputs(work_plan: WorkPlan): Promise<SealedOutputCleanupResult> {
    const targetPlans = await this.collectSealedOutputCleanupTargets(work_plan)
    const targets: SealedOutputCleanupTarget[] = []
    let deleted_files = 0
    let missing_files = 0
    let deleted_empty_dirs = 0

    for (const targetPlan of targetPlans) {
      const stat = await fs.lstat(targetPlan.path).catch((error: unknown) => {
        if (isNodeErrorCode(error, 'ENOENT')) {
          return null
        }
        throw error
      })
      if (stat === null) {
        await this.requirePhysicalSealedOutputContainment(
          targetPlan.base_dir,
          targetPlan.path,
          `${targetPlan.step_id}.${targetPlan.item_id}.sealed_output`,
        )
        const removedDirs = await this.removeEmptyOutputParentDirs(path.dirname(targetPlan.path), targetPlan.base_dir)
        missing_files += 1
        deleted_empty_dirs += removedDirs.length
        targets.push({
          step_id: targetPlan.step_id,
          group_id: targetPlan.group_id,
          item_id: targetPlan.item_id,
          target: targetPlan.target,
          path: targetPlan.path,
          deleted: false,
          missing: true,
          deleted_empty_dirs: removedDirs,
        })
        continue
      }

      if (stat.isDirectory()) {
        throw new ProtocolRunnerError(
          'closeout.sealed_output_target_directory',
          `Refusing to recursively delete declared sealed output directory: ${targetPlan.target}`,
          409,
          { path: targetPlan.path, target: targetPlan.target },
        )
      }

      await this.requirePhysicalSealedOutputContainment(
        targetPlan.base_dir,
        targetPlan.path,
        `${targetPlan.step_id}.${targetPlan.item_id}.sealed_output`,
      )
      await fs.rm(targetPlan.path, { force: false })
      await this.requirePhysicalSealedOutputContainment(
        targetPlan.base_dir,
        targetPlan.path,
        `${targetPlan.step_id}.${targetPlan.item_id}.sealed_output`,
      )
      const removedDirs = await this.removeEmptyOutputParentDirs(path.dirname(targetPlan.path), targetPlan.base_dir)
      deleted_files += 1
      deleted_empty_dirs += removedDirs.length
      targets.push({
        step_id: targetPlan.step_id,
        group_id: targetPlan.group_id,
        item_id: targetPlan.item_id,
        target: targetPlan.target,
        path: targetPlan.path,
        deleted: true,
        missing: false,
        deleted_empty_dirs: removedDirs,
      })
    }

    return {
      requested: true,
      contract_root: this.contract_root,
      target_count: targetPlans.length,
      deleted_files,
      missing_files,
      deleted_empty_dirs,
      targets,
    }
  }

  private async collectSealedOutputCleanupTargets(work_plan: WorkPlan): Promise<Array<{
    step_id: string
    group_id: string
    item_id: string
    target: string
    path: string
    base_dir: string
  }>> {
    const seen = new Map<string, string>()
    const targets: Array<{
      step_id: string
      group_id: string
      item_id: string
      target: string
      path: string
      base_dir: string
    }> = []

    for (const step of work_plan.steps) {
      if (step.step_kind !== 'parallel_group') {
        continue
      }
      const baseDir = path.resolve(this.contract_root, step.sealed_output_defaults.base_dir)
      this.requireSafeCleanupPath(baseDir, `${step.step_id}.sealed_output_defaults.base_dir`)
      for (const item of step.items) {
        const target = this.parallelItemSealedOutputTarget(step, item)
        const resolved = path.resolve(this.contract_root, target)
        this.requireSafeCleanupPath(resolved, `${step.step_id}.${item.item_id}.sealed_output`)
        const relativeToBase = path.relative(baseDir, resolved)
        if (relativeToBase === '' || relativeToBase.startsWith('..') || path.isAbsolute(relativeToBase)) {
          throw new ProtocolRunnerError(
            'closeout.sealed_output_target_outside_base_dir',
            `Refusing to delete sealed output outside its declared base_dir: ${target}`,
            409,
            { base_dir: baseDir, path: resolved, target },
          )
        }
        await this.requirePhysicalSealedOutputContainment(
          baseDir,
          resolved,
          `${step.step_id}.${item.item_id}.sealed_output`,
        )
        const duplicate = seen.get(resolved)
        if (duplicate !== undefined) {
          throw new ProtocolRunnerError(
            'closeout.sealed_output_target_duplicate',
            `Refusing duplicate sealed output cleanup target ${target}; already claimed by ${duplicate}.`,
            409,
            { path: resolved, target, previous_item_id: duplicate, item_id: item.item_id },
          )
        }
        seen.set(resolved, item.item_id)
        targets.push({
          step_id: step.step_id,
          group_id: step.group_id,
          item_id: item.item_id,
          target,
          path: resolved,
          base_dir: baseDir,
        })
      }
    }

    return targets
  }

  private async requirePhysicalSealedOutputContainment(
    baseDir: string,
    targetPath: string,
    label: string,
  ): Promise<void> {
    const issue = await this.physicalSealedOutputContainmentIssue(baseDir, targetPath, 'unlink')
    if (issue === null) {
      return
    }
    throw new ProtocolRunnerError(
      'closeout.sealed_output_physical_boundary_violation',
      `Refusing sealed output cleanup through a path redirected outside its physical boundary: ${label}`,
      409,
      issue,
    )
  }

  private async physicalSealedOutputContainmentIssue(
    baseDir: string,
    targetPath: string,
    operation: 'write' | 'unlink',
  ): Promise<JsonRecord | null> {
    const physicalContractRoot = await this.resolvePhysicalPathThroughExistingAncestor(this.contract_root)
    const physicalBaseDir = await this.resolvePhysicalPathThroughExistingAncestor(baseDir)
    const targetParent = path.dirname(targetPath)
    const physicalTargetParent = await this.resolvePhysicalPathThroughExistingAncestor(targetParent)
    // Do not resolve the final entry: unlinking a final symlink removes the link itself.
    const physicalTargetPath = path.resolve(physicalTargetParent, path.basename(targetPath))
    const details: JsonRecord = {
      contract_root: this.contract_root,
      base_dir: baseDir,
      target_path: targetPath,
      target_parent: targetParent,
      physical_contract_root: physicalContractRoot,
      physical_base_dir: physicalBaseDir,
      physical_target_parent: physicalTargetParent,
      physical_target_path: physicalTargetPath,
      operation,
    }
    if (!this.isInsidePath(physicalContractRoot, physicalBaseDir) || physicalBaseDir === physicalContractRoot) {
      return {
        ...details,
        reason: 'physical_base_outside_contract_root',
      }
    }
    if (
      !this.isInsidePath(physicalContractRoot, physicalTargetParent) ||
      !this.isInsidePath(physicalContractRoot, physicalTargetPath)
    ) {
      return {
        ...details,
        reason: 'physical_target_outside_contract_root',
      }
    }
    if (
      !this.isInsidePath(physicalBaseDir, physicalTargetParent) ||
      !this.isInsidePath(physicalBaseDir, physicalTargetPath)
    ) {
      return {
        ...details,
        reason: 'physical_target_outside_declared_base',
      }
    }
    if (operation === 'write') {
      const finalEntry = await fs.lstat(targetPath).catch((error: unknown) => {
        if (isNodeErrorCode(error, 'ENOENT')) {
          return null
        }
        throw error
      })
      if (finalEntry !== null) {
        return {
          ...details,
          reason: 'declared_primary_target_exists',
          final_entry_kind: finalEntry.isSymbolicLink()
            ? 'link'
            : finalEntry.isDirectory()
              ? 'directory'
              : finalEntry.isFile()
                ? 'file'
                : 'other',
        }
      }
    }
    return null
  }

  private requireSafeCleanupPath(candidate: string, label: string): void {
    if (!this.isInsideContractRoot(candidate)) {
      throw new ProtocolRunnerError(
        'closeout.sealed_output_target_outside_root',
        `Refusing sealed output cleanup path outside the configured contract root: ${label}`,
        409,
        { contract_root: this.contract_root, path: candidate },
      )
    }
    if (path.resolve(candidate) === this.contract_root) {
      throw new ProtocolRunnerError(
        'closeout.sealed_output_target_is_root',
        `Refusing sealed output cleanup path that resolves to the configured contract root: ${label}`,
        409,
        { contract_root: this.contract_root, path: candidate },
      )
    }
  }

  private async removeEmptyOutputParentDirs(startDir: string, baseDir: string): Promise<string[]> {
    const removed: string[] = []
    let current = path.resolve(startDir)
    const stop = path.resolve(baseDir)
    while (this.isInsidePath(stop, current) && current !== this.contract_root) {
      try {
        await fs.rmdir(current)
        removed.push(current)
      } catch (error) {
        if (isNodeErrorCode(error, 'ENOENT')) {
          // Already gone; keep walking toward the declared base directory.
        } else if (isNodeErrorCode(error, 'ENOTEMPTY') || isNodeErrorCode(error, 'EEXIST')) {
          break
        } else {
          throw error
        }
      }
      if (current === stop) {
        break
      }
      const parent = path.dirname(current)
      if (parent === current) {
        break
      }
      current = parent
    }
    return removed
  }

  private isInsidePath(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate)
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  }

  async acceptStartReport(run_instance_id: string, input: StepStartReportRequest): Promise<JsonRecord> {
    const stored = await this.store.loadRun(run_instance_id)
    if (stored.state.status !== 'waiting_for_start_report') {
      throw new ProtocolRunnerError(
        'run.invalid_status',
        `Cannot accept a start report while status=${stored.state.status}.`,
        409,
      )
    }

    const step = this.currentStep(stored)
    const expected = stored.state.pending_start_report
    if (expected === undefined) {
      return this.blockRun(stored, 'Start report expected, but run state has no pending start-report expectation.', {
        received_keys: Object.keys(input).sort(),
      })
    }
    const attempt = expected.attempt
    const parsed = parseProtocolRunnerStepStartReport(input)
    await this.store.appendEvent(run_instance_id, {
      event_type: 'start_report_received',
      step_id: step.step_id,
      details: {
        attempt,
        parse_ok: parsed.ok,
        issues: parsed.issues,
        received_keys: Object.keys(input).sort(),
      },
    })

    if (!parsed.ok || parsed.start_report === undefined) {
      return this.blockRun(stored, `Start report invalid: ${issueSummary(parsed)}`, {
        attempt,
        issues: parsed.issues,
      })
    }

    const validation = validateStepStartReport(parsed.start_report, {
      run_instance_id,
      step_id: step.step_id,
      prompt_attempt_id: expected.prompt_attempt_id,
      start_token: expected.start_token,
    })

    if (!validation.ok) {
      return this.blockRun(stored, `Start report rejected: ${issueSummary(validation)}`, {
        attempt,
        issues: validation.issues,
      })
    }

    const start_file = await this.store.writeStartReport(run_instance_id, {
      step: this.stepFileReference(step),
      attempt,
      start_report: parsed.start_report,
    })
    const updated = await this.updateStoredState(stored, {
      status: 'waiting_for_completion_report',
      pending_start_report: undefined,
      last_start_report: parsed.start_report,
    })
    await this.appendStateChanged(stored, updated, 'start report accepted')
    return {
      run: this.toRunView(await this.store.loadRun(run_instance_id)),
      attempt,
      start_file,
    }
  }

  async acceptReturn(run_instance_id: string, input: ReturnRunRequest): Promise<JsonRecord> {
    const stored = await this.store.loadRun(run_instance_id)
    this.requireManualAction(stored, 'accept-return')

    if (!stored.state.automation.auto_pickup) {
      throw new ProtocolRunnerError(
        'run.auto_pickup_disabled',
        'Structured status reports require auto_pickup=true for this run.',
        409,
      )
    }

    const step = this.currentStep(stored)
    const attempt = await this.currentAttemptNumber(stored, step)
    return this.acceptStructuredStatusReport(stored, step, attempt, input)
  }

  private async acceptStructuredStatusReport(
    stored: StoredRun,
    step: ResolvedStep,
    attempt: number,
    input: ReturnRunRequest,
  ): Promise<JsonRecord> {
    const run_instance_id = stored.run_instance_id
    const parsed = parseProtocolRunnerStatusReport(input)
    await this.store.appendEvent(run_instance_id, {
      event_type: 'status_report_received',
      step_id: step.step_id,
      details: {
        attempt,
        parse_ok: parsed.ok,
        issues: parsed.issues,
        received_keys: Object.keys(input).sort(),
      },
    })

    if (!parsed.ok || parsed.status_report === undefined) {
      return this.blockRun(stored, `Status report invalid: ${issueSummary(parsed)}`, {
        attempt,
        issues: parsed.issues,
      })
    }

    const status_file = await this.store.writeStatusReport(run_instance_id, {
      step: this.stepFileReference(step),
      attempt,
      status_report: parsed.status_report,
    })
    const validation = validateStatusReportForStep(parsed.status_report, {
      run_instance_id,
      step_id: step.step_id,
    })

    if (!validation.ok) {
      return this.blockRun(stored, `Status report rejected: ${issueSummary(validation)}`, {
        attempt,
        status_file,
        issues: validation.issues,
      })
    }

    const transition = resolveTransition(stored.work_plan, step, parsed.status_report)
    await this.store.appendEvent(run_instance_id, {
      event_type: 'transition_resolved',
      step_id: step.step_id,
      details: {
        attempt,
        status_file,
        transition,
      },
    })

    const updated = await this.applyTransition(stored, parsed.status_report, transition)
    await this.appendStateChanged(stored, updated, 'status report accepted')
    return {
      run: this.toRunView(await this.store.loadRun(run_instance_id)),
      attempt,
      status_file,
      transition,
    }
  }

  async getEvents(run_instance_id: string, limit?: number): Promise<JsonRecord> {
    return {
      events: await this.store.readEvents(run_instance_id, limit),
    }
  }

  async getRunDiagnostics(run_instance_id: string): Promise<RunDiagnostics> {
    const inspection = await this.store.inspectRun(run_instance_id)
    const paths = this.store.getRunPaths(run_instance_id)
    const events = inspection.events
    return {
      run_instance_id,
      status: inspection.state.status,
      current_step_id: inspection.state.current_step_id,
      current_step_ordinal: inspection.state.current_step_ordinal,
      automation: inspection.state.automation,
      blocked_reason: inspection.state.blocked_reason,
      next_allowed_actions: getAllowedActions(inspection.state.status),
      last_event: events.at(-1) ?? null,
      parallel_groups: await this.store.listParallelGroups(run_instance_id),
      latest_files: inspection.latest_files,
      evidence_paths: {
        run_dir: paths.run_dir,
        work_plan_path: paths.work_plan_path,
        state_path: paths.state_path,
        events_path: paths.events_path,
        latest_files: inspection.latest_files,
      },
    }
  }

  async readRunFile(run_instance_id: string, file_kind: string, file_name: string): Promise<RunFileRead> {
    if (file_name.includes('/') || file_name.includes('\\') || file_name !== path.basename(file_name)) {
      throw new ProtocolRunnerError('request.invalid_file_name', 'file_name must be a single evidence file name.')
    }

    const paths = this.store.getRunPaths(run_instance_id)
    const dirs: Record<string, string> = {
      step: paths.steps_dir,
      steps: paths.steps_dir,
      prompt: paths.prompts_dir,
      prompts: paths.prompts_dir,
      start: paths.starts_dir,
      starts: paths.starts_dir,
      status: paths.status_dir,
      statuses: paths.status_dir,
    }
    const dir = dirs[file_kind]
    if (dir === undefined) {
      throw new ProtocolRunnerError('request.invalid_file_kind', `Unsupported file_kind: ${file_kind}.`)
    }

    const file_path = path.resolve(dir, file_name)
    const relative = path.relative(dir, file_path)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new ProtocolRunnerError('request.invalid_file_name', 'Resolved file path escaped evidence directory.')
    }

    return {
      content_type: contentTypeForFile(file_name),
      text: await fs.readFile(file_path, 'utf8'),
    }
  }

  private async runParallelPreflightChecks(
    stored: StoredRun,
    step: ResolvedParallelGroupStep,
    launchableItemIds: ReadonlySet<string>,
  ): Promise<ParallelPreflightCheck[]> {
    const checks: ParallelPreflightCheck[] = []
    const pushCheck = (check: ParallelPreflightCheck) => checks.push(check)

    if (['bound', 'ready', 'blocked'].includes(stored.state.status)) {
      pushCheck({
        code: 'run.status_launchable',
        status: 'passed',
        message: `Run status ${stored.state.status} allows parallel preflight.`,
      })
    } else {
      pushCheck({
        code: 'run.status_launchable',
        status: 'failed',
        message: `Parallel preflight requires run status bound, ready, or blocked; current status is ${stored.state.status}.`,
      })
    }

    const schemaValidation = validateWorkPlan(stored.work_plan)
    if (schemaValidation.ok) {
      pushCheck({
        code: 'work_plan.schema_valid',
        status: 'passed',
        message: 'Work plan schema is valid.',
      })
    } else {
      schemaValidation.issues.forEach((issue) =>
        pushCheck({
          code: issue.code,
          status: 'failed',
          message: issue.message,
          path: issue.path,
        }),
      )
    }

    const contractValidation = await this.validateContractPaths(stored.work_plan)
    if (contractValidation.ok) {
      pushCheck({
        code: 'contract.refs_readable',
        status: 'passed',
        message: 'Referenced framework/contract files are readable.',
      })
    } else {
      contractValidation.issues.forEach((issue) =>
        pushCheck({
          code: issue.code,
          status: 'failed',
          message: issue.message,
          path: issue.path,
        }),
      )
    }

    pushCheck({
      code: 'parallel_group.current_step',
      status: 'passed',
      message: `Current step is parallel_group ${step.group_id}.`,
      path: '$.steps.current',
    })
    pushCheck({
      code: 'parallel_group.max_concurrency',
      status: Number.isInteger(step.max_concurrency) && step.max_concurrency > 0 ? 'passed' : 'failed',
      message: `max_concurrency is ${step.max_concurrency}.`,
      path: '$.steps.current.max_concurrency',
    })
    pushCheck({
      code: 'parallel_group.required_worker_capabilities_declared',
      status: 'passed',
      message:
        (step.required_worker_capabilities ?? []).length === 0
          ? 'No additional worker capabilities are required by this parallel group.'
          : `Required worker capabilities: ${(step.required_worker_capabilities ?? []).join(', ')}.`,
      path: '$.steps.current.required_worker_capabilities',
      details: {
        required_worker_capabilities: step.required_worker_capabilities ?? [],
      },
    })

    pushCheck(
      launchableItemIds.size > 0
        ? {
            code: 'parallel_group.launchable_items',
            status: 'passed',
            message: `${launchableItemIds.size} pending item(s) are launchable after preflight.`,
            path: '$.steps.current.items',
          }
        : {
            code: 'parallel_group.no_launchable_items',
            status: 'failed',
            message: 'Parallel preflight requires at least one pending item.',
            path: '$.steps.current.items',
          },
    )

    await Promise.all([
      this.checkParallelInputRefs(step, launchableItemIds, pushCheck),
      this.checkParallelOutputTargets(stored.run_instance_id, step, launchableItemIds, pushCheck),
    ])
    if (step.participation === 'source_writer') {
      try {
        if (step.source_base_commit === undefined || !/^[0-9a-f]{40}$/.test(step.source_base_commit)) throw new Error('Exact source base is missing.')
        const result = await promisify(execFile)('git', ['-C', this.contract_root, 'rev-parse', `${step.source_base_commit}^{commit}`], { windowsHide: true })
        if (result.stdout.trim() !== step.source_base_commit) throw new Error('Exact source base is unavailable.')
        pushCheck({ code: 'source_writer.base_available', status: 'passed', message: 'Exact source base is available; executor revalidates repository, ownership and isolated workspace before launch.' })
      } catch (error) {
        pushCheck({ code: 'source_writer.base_unavailable', status: 'failed', message: error instanceof Error ? error.message : String(error) })
      }
    }

    return checks
  }

  private currentParallelStep(stored: StoredRun, group_id: string, action: string): ResolvedParallelGroupStep {
    const step = this.currentStep(stored)
    if (isResolvedSerialStep(step)) {
      throw new ProtocolRunnerError(
        'run.current_step_not_parallel_group',
        `Parallel ${action} is allowed only when the current step is a parallel_group.`,
        409,
        {
          current_step_id: step.step_id,
          current_step_kind: step.step_kind,
        },
      )
    }
    if (step.group_id !== group_id) {
      throw new ProtocolRunnerError(
        'run.parallel_group_not_current',
        `Requested group_id=${group_id} is not the current parallel group.`,
        409,
        {
          current_group_id: step.group_id,
          requested_group_id: group_id,
        },
      )
    }
    return step
  }

  private requirePositiveInteger(value: unknown, name: string): number {
    if (!Number.isInteger(value) || typeof value !== 'number' || value < 1) {
      throw new ProtocolRunnerError('request.invalid', `${name} must be a positive integer.`)
    }
    return value
  }

  private requireNonNegativeInteger(value: unknown, name: string): number {
    if (!Number.isInteger(value) || typeof value !== 'number' || value < 0) {
      throw new ProtocolRunnerError('request.invalid', `${name} must be a non-negative integer.`)
    }
    return value
  }

  private normalizeAttemptWarnings(value: unknown[]): ParallelAttemptWarning[] {
    if (!Array.isArray(value)) {
      throw new ProtocolRunnerError('request.invalid', 'attempt_warnings must be an array.')
    }
    return value.map((warning) => this.normalizeAttemptWarning(warning))
  }

  private normalizeAttemptWarning(value: unknown): ParallelAttemptWarning {
    if (!isRecord(value)) {
      throw new ProtocolRunnerError('request.invalid', 'attempt warning must be an object.')
    }
    const code = requireString(value.code, 'attempt_warnings.code')
    if (!PARALLEL_ATTEMPT_WARNING_CODES.has(code as ParallelAttemptWarningCode)) {
      throw new ProtocolRunnerError('request.invalid', `Unsupported attempt warning code: ${code}.`)
    }
    if (value.severity !== 'warning') {
      throw new ProtocolRunnerError('request.invalid', 'attempt_warnings.severity must be warning.')
    }
    const observed_at = requireString(value.observed_at, 'attempt_warnings.observed_at')
    if (Number.isNaN(Date.parse(observed_at))) {
      throw new ProtocolRunnerError('request.invalid', 'attempt_warnings.observed_at must be an ISO timestamp.')
    }
    const warning: ParallelAttemptWarning = {
      code: code as ParallelAttemptWarningCode,
      severity: 'warning',
      message: requireString(value.message, 'attempt_warnings.message'),
      observed_at: new Date(observed_at).toISOString(),
      threshold_ms: this.requirePositiveInteger(value.threshold_ms, 'attempt_warnings.threshold_ms'),
      elapsed_ms: this.requireNonNegativeInteger(value.elapsed_ms, 'attempt_warnings.elapsed_ms'),
      ...(value.quiet_ms !== undefined
        ? { quiet_ms: this.requireNonNegativeInteger(value.quiet_ms, 'attempt_warnings.quiet_ms') }
        : {}),
      ...(value.last_observed_evidence_at !== undefined
        ? { last_observed_evidence_at: requireString(value.last_observed_evidence_at, 'attempt_warnings.last_observed_evidence_at') }
        : {}),
      ...(isRecord(value.details) ? { details: value.details } : {}),
    }
    if (
      warning.last_observed_evidence_at !== undefined &&
      Number.isNaN(Date.parse(warning.last_observed_evidence_at))
    ) {
      throw new ProtocolRunnerError('request.invalid', 'attempt_warnings.last_observed_evidence_at must be an ISO timestamp.')
    }
    if (warning.last_observed_evidence_at !== undefined) {
      warning.last_observed_evidence_at = new Date(warning.last_observed_evidence_at).toISOString()
    }
    return warning
  }

  private normalizeParallelAttemptResult(
    run_instance_id: string,
    group_id: string,
    step_id: string,
    attempt_id: string,
    input: ParallelAttemptResultRequest,
  ): RecordParallelAttemptResultInput {
    const lease_id = requireString(input.lease_id, 'lease_id')
    const requestAttemptId = requireString(input.attempt_id ?? attempt_id, 'attempt_id')
    if (requestAttemptId !== attempt_id) {
      throw new ProtocolRunnerError('request.attempt_mismatch', 'Path attempt_id and body attempt_id must match.', 409, {
        path_attempt_id: attempt_id,
        body_attempt_id: requestAttemptId,
      })
    }
    const launcher_status = requireString(input.launcher_status, 'launcher_status')
    const status = this.classifyParallelAttemptStatus({
      run_instance_id,
      step_id,
      group_id,
      attempt_id,
      launcher_status,
      status_report: input.status_report,
      sealed_output_path: input.sealed_output_path,
    })
    return {
      lease_id,
      attempt_id,
      status,
      ...(input.status_report !== undefined ? { status_report: input.status_report } : {}),
      ...(input.process !== undefined ? { process: input.process } : {}),
      ...(input.status_report_path !== undefined ? { status_report_path: input.status_report_path } : {}),
      ...(input.sealed_output_path !== undefined ? { sealed_output_path: input.sealed_output_path } : {}),
      ...(input.result_path !== undefined ? { result_path: input.result_path } : {}),
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
    }
  }

  private classifyParallelAttemptStatus(input: {
    run_instance_id: string
    step_id: string
    group_id: string
    attempt_id: string
    launcher_status: string
    status_report?: Record<string, unknown>
    sealed_output_path?: string
  }): ParallelAttemptResultStatus {
    if (
      ['failed', 'cancelled', 'timed_out', 'evidence_missing', 'output_missing', 'status_invalid'].includes(
        input.launcher_status,
      )
    ) {
      return input.launcher_status as ParallelAttemptResultStatus
    }
    if (input.launcher_status !== 'completed' && input.launcher_status !== 'blocked') {
      return 'status_invalid'
    }
    if (input.status_report === undefined) {
      return 'evidence_missing'
    }

    const status = input.status_report.status
    const idsMatch =
      input.status_report.run_instance_id === input.run_instance_id &&
      input.status_report.step_id === input.step_id &&
      input.status_report.group_id === input.group_id &&
      input.status_report.attempt_id === input.attempt_id
    if (!idsMatch || (status !== 'completed' && status !== 'blocked')) {
      return 'status_invalid'
    }

    if (status === 'blocked' || input.launcher_status === 'blocked') {
      return 'blocked'
    }
    if (typeof input.sealed_output_path !== 'string' || input.sealed_output_path.trim().length === 0) {
      return 'output_missing'
    }
    return 'completed'
  }

  private async applyParallelGroupOutcome(
    run_instance_id: string,
    step: ResolvedParallelGroupStep,
    record: ParallelAttemptResultRecord,
  ): Promise<void> {
    const stored = await this.store.loadRun(run_instance_id)
    if (record.group.status === 'completed') {
      const completion: CompletionReturn = {
        run_instance_id,
        step_id: step.step_id,
        status: 'completed',
        summary: `Parallel group ${step.group_id} completed procedurally.`,
      }
      const transition = resolveTransition(stored.work_plan, step, completion)
      await this.store.appendEvent(run_instance_id, {
        event_type: 'transition_resolved',
        step_id: step.step_id,
        details: {
          action: 'parallel_group_completed',
          group_id: step.group_id,
          transition,
        },
      })
      const updated = await this.applyTransition(stored, completion, transition)
      await this.appendStateChanged(stored, updated, 'parallel group completed')
      return
    }

    if (record.group.status === 'needs_attention') {
      const updated = await this.updateStoredState(stored, {
        status: 'blocked',
        blocked_reason: parallelGroupAttentionReason(step.group_id, record.group),
      })
      await this.appendStateChanged(stored, updated, 'parallel group needs attention')
      return
    }

    if (stored.state.status !== 'running') {
      const updated = await this.updateStoredState(stored, {
        status: 'running',
        blocked_reason: undefined,
      })
      await this.appendStateChanged(stored, updated, 'parallel group still running')
    }
  }

  private async startParallelGroup(stored: StoredRun, step: ResolvedParallelGroupStep): Promise<JsonRecord> {
    await this.store.appendEvent(stored.run_instance_id, {
      event_type: 'manual_action',
      step_id: step.step_id,
      details: {
        action: 'start_parallel_group',
        group_id: step.group_id,
      },
    })

    const envelope = await this.preflightParallelGroup(stored.run_instance_id, step.group_id)
    const latestStored = await this.store.loadRun(stored.run_instance_id)
    const group = await this.store.getParallelGroup(stored.run_instance_id, step.group_id)
    if (group.preflight_status !== 'passed') {
      return envelope
    }

    const running = await this.updateStoredState(latestStored, {
      status: 'running',
      blocked_reason: undefined,
      pending_start_report: undefined,
      timestamps: { started_at: latestStored.state.timestamps.started_at ?? this.now().toISOString() },
    })
    await this.appendStateChanged(latestStored, running, 'parallel group started')
    return {
      ...envelope,
      run: this.toRunView(await this.store.loadRun(stored.run_instance_id)),
      group: await this.store.getParallelGroup(stored.run_instance_id, step.group_id),
    }
  }

  private async resumeParallelGroup(stored: StoredRun, step: ResolvedParallelGroupStep): Promise<JsonRecord> {
    const group = await this.store.getParallelGroup(stored.run_instance_id, step.group_id)
    if (!['ready_to_lease', 'leasing', 'running'].includes(group.status)) {
      throw new ProtocolRunnerError(
        'run.parallel_group_not_resumable',
        `Parallel group ${step.group_id} cannot resume while its group status is ${group.status}.`,
        409,
        {
          step_id: step.step_id,
          group_id: step.group_id,
          group_status: group.status,
        },
      )
    }

    await this.store.appendEvent(stored.run_instance_id, {
      event_type: 'manual_action',
      step_id: step.step_id,
      details: {
        action: 'resume_parallel_group',
        group_id: step.group_id,
      },
    })
    const running = await this.updateStoredState(stored, {
      status: 'running',
      blocked_reason: undefined,
      pending_start_report: undefined,
      timestamps: { started_at: stored.state.timestamps.started_at ?? this.now().toISOString() },
    })
    await this.appendStateChanged(stored, running, 'parallel group resumed')
    return this.parallelEnvelope(stored.run_instance_id, step.group_id)
  }

  async parallelEnvelope(run_instance_id: string, group_id: string, extra: JsonRecord = {}): Promise<JsonRecord> {
    return {
      run: this.toRunView(await this.store.loadRun(run_instance_id)),
      group: await this.store.getParallelGroup(run_instance_id, group_id),
      ...extra,
    }
  }

  private async checkParallelInputRefs(
    step: ResolvedParallelGroupStep,
    launchableItemIds: ReadonlySet<string>,
    pushCheck: (check: ParallelPreflightCheck) => void,
  ): Promise<void> {
    for (const [index, item] of step.items.entries()) {
      if (!launchableItemIds.has(item.item_id)) {
        continue
      }
      const pathLabel = `$.steps.current.items[${index}].input_ref`
      const resolved = this.resolveWorkspaceRef(item.input_ref)
      if (resolved === null) {
        pushCheck({
          code: 'parallel_group.input_ref_unsupported',
          status: 'failed',
          message: `Input ref is not a supported local file ref: ${item.input_ref}`,
          path: pathLabel,
        })
        continue
      }
      if (!this.isInsideContractRoot(resolved)) {
        pushCheck({
          code: 'parallel_group.input_ref_outside_root',
          status: 'failed',
          message: `Input ref resolves outside the configured root: ${item.input_ref}`,
          path: pathLabel,
        })
        continue
      }

      try {
        const stat = await fs.stat(resolved)
        pushCheck({
          code: stat.isFile() ? 'parallel_group.input_ref_readable' : 'parallel_group.input_ref_not_file',
          status: stat.isFile() ? 'passed' : 'failed',
          message: stat.isFile()
            ? `Input ref is readable for item ${item.item_id}.`
            : `Input ref is not a file for item ${item.item_id}: ${item.input_ref}`,
          path: pathLabel,
        })
      } catch (error) {
        pushCheck({
          code: isNodeErrorCode(error, 'ENOENT')
            ? 'parallel_group.input_ref_missing'
            : 'parallel_group.input_ref_unreadable',
          status: 'failed',
          message: `Input ref cannot be inspected for item ${item.item_id}: ${item.input_ref}`,
          path: pathLabel,
        })
      }
    }
  }

  private async checkParallelOutputTargets(
    run_instance_id: string,
    step: ResolvedParallelGroupStep,
    launchableItemIds: ReadonlySet<string>,
    pushCheck: (check: ParallelPreflightCheck) => void,
  ): Promise<void> {
    const storageOverlap = await this.sealedOutputRunDirOverlap(run_instance_id, step, 'reject')
    if (storageOverlap !== null) {
      pushCheck({
        code: 'parallel_group.sealed_output_run_dir_overlap',
        status: 'failed',
        message: 'Declared sealed-output storage must be disjoint from the runner-owned run directory.',
        path: '$.steps.current.sealed_output_defaults.base_dir',
        details: storageOverlap,
      })
      return
    }

    const targets = new Map<string, string>()
    const baseDir = path.resolve(this.contract_root, step.sealed_output_defaults.base_dir)
    for (const [index, item] of step.items.entries()) {
      const pathLabel = `$.steps.current.items[${index}].sealed_output`
      const target = this.parallelItemSealedOutputTarget(step, item)
      const previous = targets.get(target)
      if (previous !== undefined) {
        pushCheck({
          code: 'parallel_group.sealed_output_target_duplicate',
          status: 'failed',
          message: `Sealed output target ${target} is already claimed by ${previous}.`,
          path: pathLabel,
        })
        continue
      }
      targets.set(target, item.item_id)
    }

    for (const [index, item] of step.items.entries()) {
      if (!launchableItemIds.has(item.item_id)) {
        continue
      }
      const pathLabel = `$.steps.current.items[${index}].sealed_output`
      const target = this.parallelItemSealedOutputTarget(step, item)

      const resolved = path.resolve(this.contract_root, target)
      if (!this.isInsideContractRoot(resolved)) {
        pushCheck({
          code: 'parallel_group.sealed_output_target_outside_root',
          status: 'failed',
          message: `Sealed output target resolves outside the configured root: ${target}`,
          path: pathLabel,
        })
        continue
      }

      const parent = path.dirname(resolved)
      try {
        const containmentIssue = await this.physicalSealedOutputContainmentIssue(baseDir, resolved, 'write')
        if (containmentIssue !== null) {
          const targetExists = containmentIssue.reason === 'declared_primary_target_exists'
          pushCheck({
            code: targetExists
              ? 'parallel_group.sealed_output_target_exists'
              : 'parallel_group.sealed_output_physical_boundary_violation',
            status: 'failed',
            message: targetExists
              ? `Sealed output target must be absent before worker launch: ${target}`
              : `Sealed output target is redirected outside its physical contract/base boundary: ${target}`,
            path: pathLabel,
            details: containmentIssue,
          })
          continue
        }
        await fs.mkdir(parent, { recursive: true })
        const recheckedContainmentIssue = await this.physicalSealedOutputContainmentIssue(baseDir, resolved, 'write')
        if (recheckedContainmentIssue !== null) {
          const targetExists = recheckedContainmentIssue.reason === 'declared_primary_target_exists'
          pushCheck({
            code: targetExists
              ? 'parallel_group.sealed_output_target_exists'
              : 'parallel_group.sealed_output_physical_boundary_violation',
            status: 'failed',
            message: targetExists
              ? `Sealed output target must be absent before worker launch: ${target}`
              : `Sealed output target is redirected outside its physical contract/base boundary: ${target}`,
            path: pathLabel,
            details: recheckedContainmentIssue,
          })
          continue
        }
        const probePath = path.join(parent, `.protocol-runner-preflight-${process.pid}-${Date.now()}.tmp`)
        await fs.writeFile(probePath, 'preflight\n', { encoding: 'utf8', flag: 'wx' })
        await fs.rm(probePath, { force: true })
        pushCheck({
          code: 'parallel_group.sealed_output_writable',
          status: 'passed',
          message: `Sealed output directory is writable for item ${item.item_id}.`,
          path: pathLabel,
          details: {
            target,
          },
        })
      } catch (error) {
        pushCheck({
          code: 'parallel_group.sealed_output_unwritable',
          status: 'failed',
          message: `Sealed output directory is not writable for item ${item.item_id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          path: pathLabel,
          details: {
            target,
          },
        })
      }
    }
  }

  private async sendCurrentPrompt(stored: StoredRun, operation: SendOperation): Promise<JsonRecord> {
    if (stored.state.thread_binding === null) {
      throw new ProtocolRunnerError('run.not_bound', 'Run must be bound to a thread before prompts can be sent.', 409)
    }

    const contractValidation = await this.validateContractPaths(stored.work_plan)
    if (!contractValidation.ok) {
      return this.blockRun(stored, `Contract preflight failed: ${issueSummary(contractValidation)}`, {
        issues: contractValidation.issues,
      })
    }

    const step = this.currentStep(stored)
    if (!isResolvedSerialStep(step)) {
      throw new ProtocolRunnerError(
        'run.parallel_group_not_supported',
        'parallel_group steps require the parallel executor and cannot be sent through the serial Desktop prompt path.',
        409,
        {
          step_id: step.step_id,
          step_kind: step.step_kind,
        },
      )
    }
    const serialBinding = this.requireSerialDesktopBinding(stored.state.thread_binding)

    const attempt = await this.store.nextAttemptNumber(stored.run_instance_id, this.stepFileReference(step))
    const startToken = randomUUID()
    const promptAttemptId = formatPromptAttemptId(attempt)
    const dispatching = await this.updateStoredState(stored, {
      blocked_reason: undefined,
      pending_start_report: undefined,
      status: 'dispatching_prompt',
      timestamps: { started_at: stored.state.timestamps.started_at ?? this.now().toISOString() },
    })
    await this.store.appendEvent(stored.run_instance_id, {
      event_type: 'manual_action',
      step_id: step.step_id,
      details: { action: operation },
    })
    await this.appendStateChanged(stored, dispatching, operation)

    let step_file: StoreFileRef | undefined
    if (attempt === 1) {
      step_file = await this.store.writeStepSnapshot(stored.run_instance_id, step)
    }

    const prompt = renderPrompt(step.prompt_template, {
      run_instance_id: stored.run_instance_id,
      step,
      prompt_attempt_id: promptAttemptId,
      start_token: startToken,
      report_commands: this.report_commands,
    })
    const prompt_file = await this.store.writePrompt(stored.run_instance_id, {
      step: this.stepFileReference(step),
      attempt,
      text: prompt,
    })
    await this.store.appendEvent(stored.run_instance_id, {
      event_type: 'prompt_rendered',
      step_id: step.step_id,
      details: {
        operation,
        attempt,
        step_file,
        prompt_file,
      },
    })

    const sendInput: SendPromptInput = {
      run_instance_id: stored.run_instance_id,
      step_id: step.step_id,
      prompt,
      thread_binding: serialBinding,
    }
    let send_result: PromptSendResult
    try {
      send_result = await this.desktop_adapter.sendPrompt(sendInput)
    } catch (error) {
      send_result = {
        send_status: 'unknown',
        desktop_result: 'adapter_exception',
        message: error instanceof Error ? error.message : String(error),
        thread_title: serialBinding.visible_thread_label,
      }
    }

    await this.store.appendEvent(stored.run_instance_id, {
      event_type: 'prompt_sent',
      step_id: step.step_id,
      details: {
        operation,
        attempt,
        prompt_file,
        send_result,
      },
    })

    const latestStored = await this.store.loadRun(stored.run_instance_id)
    if (latestStored.state.status !== 'dispatching_prompt') {
      await this.store.appendEvent(stored.run_instance_id, {
        event_type: 'diagnostic',
        step_id: step.step_id,
        details: {
          action: 'prompt_send_result_not_applied',
          operation,
          attempt,
          current_status: latestStored.state.status,
          send_result,
        },
      })
      return {
        run: this.toRunView(await this.store.loadRun(stored.run_instance_id)),
        attempt,
        prompt_file,
        send_result,
      }
    }
    if (!shouldAwaitStartReport(send_result)) {
      const blocked = await this.updateStoredState(latestStored, {
        status: 'blocked',
        blocked_reason: `Prompt send did not reach start-report wait state: send_status=${send_result.send_status}, desktop_result=${send_result.desktop_result}.`,
        last_sent_prompt_message_id: promptMessageId(send_result),
        pending_start_report: undefined,
      })
      await this.appendStateChanged(latestStored, blocked, 'prompt send blocked')
      return {
        run: this.toRunView(await this.store.loadRun(stored.run_instance_id)),
        attempt,
        prompt_file,
        send_result,
      }
    }

    const expectation = {
      run_instance_id: stored.run_instance_id,
      step_id: step.step_id,
      prompt_attempt_id: promptAttemptId,
      start_token: startToken,
      attempt,
      prompt_file: prompt_file.relative_path,
      sent_at: this.now().toISOString(),
    }
    const waiting = await this.updateStoredState(latestStored, {
      status: 'waiting_for_start_report',
      last_sent_prompt_message_id: promptMessageId(send_result),
      pending_start_report: expectation,
    })
    await this.appendStateChanged(latestStored, waiting, 'prompt sent; waiting for start report')

    return {
      run: this.toRunView(await this.store.loadRun(stored.run_instance_id)),
      attempt,
      prompt_file,
      send_result,
    }
  }

  private async validateRunDefinition(work_plan: WorkPlan): Promise<ValidationResult> {
    const schemaValidation = validateWorkPlan(work_plan)
    const contractValidation = await this.validateContractPaths(work_plan)
    const issues = [...schemaValidation.issues, ...contractValidation.issues]
    return {
      ok: issues.length === 0,
      issues,
    }
  }

  private async validateContractPaths(work_plan: WorkPlan): Promise<ValidationResult> {
    const issues: ValidationIssue[] = []
    const references: Array<{ raw_path: string; path: string }> = [
      {
        raw_path: work_plan.default_contract.path,
        path: '$.default_contract.path',
      },
    ]

    work_plan.steps.forEach((step, index) => {
      if (step.step_kind === 'parallel_group') {
        references.push({
          raw_path: step.contract_ref,
          path: `$.steps[${index}].contract_ref`,
        })
        step.items.forEach((item, itemIndex) => {
          if (item.contract_ref !== undefined) {
            references.push({
              raw_path: item.contract_ref,
              path: `$.steps[${index}].items[${itemIndex}].contract_ref`,
            })
          }
        })
        return
      }

      if (step.contract !== null) {
        references.push({
          raw_path: step.contract.path,
          path: `$.steps[${index}].contract.path`,
        })
      }
    })

    for (const item of references) {
      const rawPath = item.raw_path
      const resolved = this.resolveContractPath(rawPath)
      if (!this.isInsideContractRoot(resolved)) {
        issues.push({
          code: 'contract.path_outside_root',
          message: `Contract file path resolves outside contract root: ${rawPath}`,
          path: item.path,
          severity: 'error',
        })
        continue
      }

      try {
        const stat = await fs.stat(resolved)
        if (!stat.isFile()) {
          issues.push({
            code: 'contract.path_not_file',
            message: `Contract path is not a file: ${rawPath}`,
            path: item.path,
            severity: 'error',
          })
        }
      } catch (error) {
        if (isNodeErrorCode(error, 'ENOENT')) {
          issues.push({
            code: 'contract.path_missing',
            message: `Contract file does not exist: ${rawPath}`,
            path: item.path,
            severity: 'error',
          })
          continue
        }

        issues.push({
          code: 'contract.path_unreadable',
          message: `Contract file cannot be inspected: ${rawPath}: ${error instanceof Error ? error.message : String(error)}`,
          path: item.path,
          severity: 'error',
        })
      }
    }

    return {
      ok: issues.length === 0,
      issues,
    }
  }

  private resolveContractPath(contract_path: string): string {
    return path.resolve(path.isAbsolute(contract_path) ? contract_path : path.join(this.contract_root, contract_path))
  }

  private resolveWorkspaceRef(input_ref: string): string | null {
    const withoutAnchor = input_ref.split('#', 1)[0].trim()
    if (withoutAnchor.length === 0 || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(withoutAnchor)) {
      return null
    }

    return path.resolve(path.isAbsolute(withoutAnchor) ? withoutAnchor : path.join(this.contract_root, withoutAnchor))
  }

  private isInsideContractRoot(candidate: string): boolean {
    const relative = path.relative(this.contract_root, candidate)
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  }

  private parallelItemSealedOutputTarget(step: ParallelGroupStep, item: ParallelGroupItem): string {
    const unitId = item.sealed_output?.unit_id ?? item.item_id
    const primaryArtifact = item.sealed_output?.primary_artifact ?? step.sealed_output_defaults.primary_artifact
    return `${step.sealed_output_defaults.base_dir}/${unitId}/${primaryArtifact}`
      .trim()
      .replace(/\\/g, '/')
      .replace(/\/+/g, '/')
  }

  private async sealedOutputRunDirOverlap(
    run_instance_id: string,
    step: ParallelGroupStep,
    descendantPolicy: SealedOutputDescendantPolicy,
  ): Promise<JsonRecord | null> {
    const runDir = path.resolve(this.store.getRunPaths(run_instance_id).run_dir)
    const outputBaseDir = path.resolve(this.contract_root, step.sealed_output_defaults.base_dir)
    const physicalRunDir = await this.resolvePhysicalPathThroughExistingAncestor(runDir)
    type OutputPathRelationship = 'equal' | 'output_within_run' | 'run_within_output' | null
    type OutputPathBoundary = {
      declared_path: string
      resolved_path: string
      physical_path: string
      lexical_relationship: OutputPathRelationship
      physical_relationship: OutputPathRelationship
    }
    const relationship = (
      candidateRunDir: string,
      candidateOutputBaseDir: string,
    ): OutputPathRelationship => {
      if (candidateRunDir === candidateOutputBaseDir) {
        return 'equal'
      }
      if (this.isInsidePath(candidateRunDir, candidateOutputBaseDir)) {
        return 'output_within_run'
      }
      if (this.isInsidePath(candidateOutputBaseDir, candidateRunDir)) {
        return 'run_within_output'
      }
      return null
    }
    const inspectOutputPath = async (declaredPath: string): Promise<OutputPathBoundary> => {
      const resolvedPath = path.resolve(this.contract_root, declaredPath)
      const physicalPath = await this.resolvePhysicalPathThroughExistingAncestor(resolvedPath)
      return {
        declared_path: declaredPath,
        resolved_path: resolvedPath,
        physical_path: physicalPath,
        lexical_relationship: relationship(runDir, resolvedPath),
        physical_relationship: relationship(physicalRunDir, physicalPath),
      }
    }
    const baseBoundary = await inspectOutputPath(step.sealed_output_defaults.base_dir)
    const itemBoundaries = await Promise.all(
      step.items.map(async (item) => ({
        item_id: item.item_id,
        ...(await inspectOutputPath(this.parallelItemSealedOutputTarget(step, item))),
      })),
    )
    const lexicalRelationship = baseBoundary.lexical_relationship
    const physicalRelationship = baseBoundary.physical_relationship
    const baseIsDisjoint = lexicalRelationship === null && physicalRelationship === null
    const stableOutputDescendant =
      lexicalRelationship === 'output_within_run' && physicalRelationship === 'output_within_run'
    const itemOutputConflicts = itemBoundaries.filter((item) => {
      if (baseIsDisjoint) {
        return item.lexical_relationship !== null || item.physical_relationship !== null
      }
      if (stableOutputDescendant) {
        return (
          item.lexical_relationship !== 'output_within_run' || item.physical_relationship !== 'output_within_run'
        )
      }
      return false
    })
    if (baseIsDisjoint && itemOutputConflicts.length === 0) {
      return null
    }
    if (itemOutputConflicts.length > 0) {
      return {
        step_id: step.step_id,
        group_id: step.group_id,
        sealed_output_base_dir: step.sealed_output_defaults.base_dir,
        resolved_sealed_output_base_dir: outputBaseDir,
        run_dir: runDir,
        relationship: 'declared_item_output_overlap',
        item_output_conflicts: itemOutputConflicts,
        physical_sealed_output_base_dir: baseBoundary.physical_path,
        physical_run_dir: physicalRunDir,
      }
    }
    if (stableOutputDescendant && descendantPolicy === 'allow') {
      return null
    }
    if (stableOutputDescendant && descendantPolicy === 'allow_empty') {
      const stat = await fs.lstat(outputBaseDir).catch((error: unknown) => {
        if (isNodeErrorCode(error, 'ENOENT')) {
          return null
        }
        throw error
      })
      if (stat === null) {
        return null
      }
      if (stat.isDirectory() && (await fs.readdir(outputBaseDir)).length === 0) {
        return null
      }
    }
    return {
      step_id: step.step_id,
      group_id: step.group_id,
      sealed_output_base_dir: step.sealed_output_defaults.base_dir,
      resolved_sealed_output_base_dir: outputBaseDir,
      run_dir: runDir,
      relationship:
        lexicalRelationship === physicalRelationship ? lexicalRelationship : 'redirected_or_ambiguous_overlap',
      lexical_relationship: lexicalRelationship,
      physical_relationship: physicalRelationship,
      physical_sealed_output_base_dir: baseBoundary.physical_path,
      physical_run_dir: physicalRunDir,
    }
  }

  private async resolvePhysicalPathThroughExistingAncestor(candidate: string): Promise<string> {
    let current = path.resolve(candidate)
    const missingSegments: string[] = []
    while (true) {
      try {
        const existingAncestor = await fs.realpath(current)
        return path.resolve(existingAncestor, ...missingSegments)
      } catch (error) {
        if (!isNodeErrorCode(error, 'ENOENT') && !isNodeErrorCode(error, 'ENOTDIR')) {
          throw error
        }
        const parent = path.dirname(current)
        if (parent === current) {
          throw error
        }
        missingSegments.unshift(path.basename(current))
        current = parent
      }
    }
  }

  private preflightErrorSummary(result: ParallelPreflightResult): string {
    return result.errors.map((error) => `${error.code}: ${error.message}`).join('; ')
  }

  private async applyTransition(
    stored: StoredRun,
    completion: CompletionReturn,
    transition: ReturnType<typeof resolveTransition>,
  ): Promise<RunState> {
    if (transition.action === 'advance' || transition.action === 'go_to') {
      return this.updateStoredState(stored, {
        status: 'ready',
        current_step_id: transition.next_step_id ?? null,
        current_step_ordinal: transition.next_step_ordinal ?? null,
        last_completion: completion,
        blocked_reason: undefined,
        pending_start_report: undefined,
      })
    }

    if (transition.action === 'pause') {
      return this.updateStoredState(stored, {
        status: 'paused',
        last_completion: completion,
        blocked_reason: undefined,
        pending_start_report: undefined,
      })
    }

    if (transition.action === 'stop') {
      return this.updateStoredState(stored, {
        status: 'completed',
        last_completion: completion,
        blocked_reason: undefined,
        pending_start_report: undefined,
        timestamps: { completed_at: this.now().toISOString() },
      })
    }

    return this.updateStoredState(stored, {
      status: 'blocked',
      last_completion: completion,
      blocked_reason: transition.reason,
      pending_start_report: undefined,
    })
  }

  private async blockRun(stored: StoredRun, reason: string, details: JsonRecord): Promise<JsonRecord> {
    await this.store.appendEvent(stored.run_instance_id, {
      event_type: 'diagnostic',
      step_id: stored.state.current_step_id ?? undefined,
      details: {
        blocked_reason: reason,
        ...details,
      },
    })
    const updated = await this.updateStoredState(stored, {
      status: 'blocked',
      blocked_reason: reason,
      pending_start_report: undefined,
    })
    await this.appendStateChanged(stored, updated, 'blocked')
    return {
      run: this.toRunView(await this.store.loadRun(stored.run_instance_id)),
      blocked_reason: reason,
      ...details,
    }
  }

  private currentStep(stored: StoredRun): ResolvedStep {
    const step = resolveCurrentStep(stored.work_plan, stored.state)
    if (step === null) {
      throw new ProtocolRunnerError('run.current_step_missing', 'Run state does not point to a valid current step.', 409)
    }

    return step
  }

  private async currentAttemptNumber(stored: StoredRun, step: ResolvedStep): Promise<number> {
    const next = await this.store.nextAttemptNumber(stored.run_instance_id, this.stepFileReference(step))
    const current = next - 1
    if (current < 1) {
      throw new ProtocolRunnerError('run.prompt_attempt_missing', 'No prompt attempt exists for the current return.', 409)
    }

    return current
  }

  private stepFileReference(step: ResolvedStep): { step_id: string; ordinal: number } {
    return {
      step_id: step.step_id,
      ordinal: step.ordinal,
    }
  }

  private requireManualAction(stored: StoredRun, action: RunnerManualAction): void {
    if (!isManualActionAllowed(stored.state.status, action)) {
      throw new ProtocolRunnerError(
        'run.invalid_status',
        `${action} is not allowed while status=${stored.state.status}.`,
        409,
      )
    }
  }

  private async updateState(stored: StoredRun, patch: RunStatePatch): Promise<RunState> {
    return this.updateStoredState(stored, patch)
  }

  private async updateStoredState(stored: StoredRun, patch: RunStatePatch): Promise<RunState> {
    const next: RunState = {
      ...stored.state,
      ...patch,
      timestamps: {
        ...stored.state.timestamps,
        ...(patch.timestamps ?? {}),
        updated_at: this.now().toISOString(),
      },
    }
    await this.store.writeState(next)
    return next
  }

  private async appendStateChanged(previous: StoredRun, next: RunState, reason: string): Promise<void> {
    await this.store.appendEvent(previous.run_instance_id, {
      event_type: 'state_changed',
      step_id: next.current_step_id ?? previous.state.current_step_id ?? undefined,
      details: {
        from_status: previous.state.status,
        to_status: next.status,
        reason,
        blocked_reason: next.blocked_reason,
      },
    })
    await this.notifyAttentionState(previous, next, reason)
  }

  private async notifyAttentionState(previous: StoredRun, next: RunState, reason: string): Promise<void> {
    if (previous.state.status === next.status) {
      return
    }

    const shouldNotify = next.status === 'completed' || next.status === 'blocked' || next.status === 'failed'
    if (!shouldNotify) {
      return
    }

    const outcome: RunnerAttentionNotification['outcome'] =
      next.status === 'completed' ? 'finished' : 'needs_attention'
    const notification: RunnerAttentionNotification = {
      run_instance_id: next.run_instance_id,
      outcome,
      status: next.status,
      current_step_id: next.current_step_id,
      reason,
      blocked_reason: next.blocked_reason,
      occurred_at: next.timestamps.updated_at,
    }

    try {
      await this.notification_notifier.notify(notification)
      await this.store.appendEvent(next.run_instance_id, {
        event_type: 'diagnostic',
        step_id: next.current_step_id ?? previous.state.current_step_id ?? undefined,
        details: {
          action: 'runner_attention_notification_requested',
          notification,
        },
      })
    } catch (error) {
      await this.store.appendEvent(next.run_instance_id, {
        event_type: 'diagnostic',
        step_id: next.current_step_id ?? previous.state.current_step_id ?? undefined,
        details: {
          action: 'runner_attention_notification_failed',
          notification,
          error: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  private toRunView(stored: StoredRun): RunView {
    return {
      run_instance_id: stored.run_instance_id,
      state: stored.state,
      work_plan: stored.work_plan,
    }
  }

  private defaultRunInstanceId(): string {
    return `run_${this.now().toISOString().replace(/[-:.TZ]/g, '').toLowerCase()}`
  }
}

function parallelGroupAttentionReason(group_id: string, group: ParallelGroupState): string {
  const attentionItems = group.items.filter((item) => item.status === 'blocked' || item.status === 'needs_recovery')
  if (attentionItems.length === 0) {
    return `Parallel group ${group_id} needs attention; inspect group diagnostics for the owning attempt.`
  }

  const attemptsById = new Map(group.attempts.map((attempt) => [attempt.attempt_id, attempt]))
  const visibleItems = attentionItems.slice(0, 10).map((item) => {
    const attempt = item.latest_attempt_id === null ? undefined : attemptsById.get(item.latest_attempt_id)
    const attempt_id = attempt?.attempt_id ?? item.latest_attempt_id ?? 'none'
    const status = attempt?.status ?? item.status
    return `${item.item_id} [attempt=${attempt_id}, status=${status}]`
  })
  const remainder = attentionItems.length - visibleItems.length
  const suffix = remainder > 0 ? `; +${remainder} more` : ''
  return `Parallel group ${group_id} needs attention for ${attentionItems.length} item(s): ${visibleItems.join('; ')}${suffix}`
}

function contentTypeForFile(file_name: string): string {
  if (file_name.endsWith('.json')) {
    return 'application/json; charset=utf-8'
  }

  if (file_name.endsWith('.jsonl')) {
    return 'application/x-ndjson; charset=utf-8'
  }

  return 'text/markdown; charset=utf-8'
}

export function controllerErrorToHttp(error: unknown): { status: number; body: JsonRecord } {
  if (error instanceof ProtocolRunnerError) {
    return {
      status: error.http_status,
      body: {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      },
    }
  }

  if (error instanceof RunnerStoreError) {
    const missing = error.code.endsWith('_read_failed')
    return {
      status: missing ? 404 : 400,
      body: {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          run_instance_id: error.run_instance_id,
          file_path: error.file_path,
        },
      },
    }
  }

  return {
    status: 500,
    body: {
      ok: false,
      error: {
        code: 'internal_error',
        message: error instanceof Error ? error.message : String(error),
      },
    },
  }
}
