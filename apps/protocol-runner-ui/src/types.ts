export type RunStatus =
  | 'draft'
  | 'bound'
  | 'ready'
  | 'running'
  | 'dispatching_prompt'
  | 'waiting_for_start_report'
  | 'waiting_for_completion_report'
  | 'paused'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'closed'

export type RunnerManualAction =
  | 'validate'
  | 'bind-thread'
  | 'start'
  | 'pause'
  | 'resume'
  | 'retry-current'
  | 'fail'
  | 'close'
  | 'accept-return'
  | 'refresh'

export type EvidenceKind = 'step' | 'prompt' | 'start' | 'status' | 'parallel_preflight'

export interface ContractReference {
  title: string
  path: string
}

export interface TransitionRule {
  action: 'next' | 'pause' | 'stop' | 'go_to'
  step_id?: string
}

export interface SerialRunStep {
  step_id: string
  step_kind: 'work' | 'review'
  contract: ContractReference | null
  planned_step: string
  visible_work_item: Record<string, unknown>
  prompt_template: string
  on_completed: TransitionRule
  on_blocked: TransitionRule
}

export interface ParallelGroupItem {
  item_id: string
  label?: string
  input_ref: string
  variables?: Record<string, unknown>
  contract_ref?: string
  sealed_output?: {
    unit_id?: string
    primary_artifact?: string
  }
}

export interface ParallelGroupStep {
  step_id: string
  step_kind: 'parallel_group'
  group_id: string
  executor: string
  contract_ref: string
  max_concurrency: number
  items: ParallelGroupItem[]
  sealed_output_defaults: {
    base_dir: string
    primary_artifact: string
  }
  on_completed: TransitionRule
  on_blocked: TransitionRule
}

export type RunStep = SerialRunStep | ParallelGroupStep

export interface WorkPlan {
  schema_version: string
  run_title: string
  execution_mode: 'serial' | 'mixed'
  default_contract: ContractReference
  steps: RunStep[]
}

export interface BindingMetadata {
  binding_kind: 'serial_desktop' | 'parallel_only'
  visible_thread_label?: string
  relay_channel_id?: string
  relay_channel_name?: string
  binding_id?: string
  cleanup_state?: 'active' | 'cleanup_requested' | 'cleaned_up' | 'cleanup_failed'
}

export interface CompletionReturn {
  run_instance_id: string
  step_id: string
  status: 'completed' | 'blocked'
  summary?: string
}

export interface RunState {
  schema_version: string
  run_instance_id: string
  work_plan_path: string
  status: RunStatus
  current_step_id: string | null
  current_step_ordinal: number | null
  automation: {
    auto_pickup: boolean
    auto_advance: boolean
  }
  thread_binding: BindingMetadata | null
  last_sent_prompt_message_id?: string
  last_completion?: CompletionReturn
  blocked_reason?: string
  timestamps: {
    created_at: string
    updated_at: string
    started_at?: string
    completed_at?: string
  }
}

export interface RunView {
  run_instance_id: string
  state: RunState
  work_plan: WorkPlan
}

export interface RunListItem {
  run_instance_id: string
  status: RunStatus
  current_step_id: string | null
  current_step_ordinal: number | null
  automation: {
    auto_pickup: boolean
    auto_advance: boolean
  }
  updated_at: string
}

export interface AllowedAction {
  action: RunnerManualAction
  enabled: boolean
  reason: string
}

export interface RunnerEvent {
  event_id: string
  event_type: string
  run_instance_id: string
  step_id?: string
  timestamp: string
  details: Record<string, unknown>
}

export interface RunDiagnostics {
  run_instance_id: string
  status: RunStatus
  current_step_id: string | null
  current_step_ordinal: number | null
  automation: {
    auto_pickup: boolean
    auto_advance: boolean
  }
  blocked_reason?: string
  next_allowed_actions: AllowedAction[]
  last_event: RunnerEvent | null
  parallel_groups: ParallelGroupState[]
  latest_files: Partial<Record<EvidenceKind, string>>
  evidence_paths: {
    run_dir: string
    work_plan_path: string
    state_path: string
    events_path: string
    latest_files: Partial<Record<EvidenceKind, string>>
  }
}

export type ParallelGroupStatus =
  | 'pending'
  | 'preflighting'
  | 'ready_to_lease'
  | 'leasing'
  | 'running'
  | 'paused'
  | 'completed'
  | 'needs_attention'
  | 'stopped'
  | 'cancelled'

export type ParallelItemStatus =
  | 'pending'
  | 'leased'
  | 'running'
  | 'completed'
  | 'blocked'
  | 'needs_recovery'
  | 'cancelled'
  | 'stopped'

export type ParallelAttemptStatus =
  | 'created'
  | 'leased'
  | 'running'
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'cancelled'
  | 'stale'
  | 'timed_out'
  | 'evidence_missing'
  | 'output_missing'
  | 'status_invalid'

export type ParallelLeaseStatus = 'active' | 'released' | 'expired' | 'cancelled'
export type ParallelPreflightStatus = 'not_run' | 'passed' | 'failed'
export type ParallelPreflightCheckStatus = 'passed' | 'failed' | 'warning'
export type ParallelAttemptWarningCode = 'long_running' | 'possibly_stalled'

export interface ParallelAttemptWarning {
  code: ParallelAttemptWarningCode
  severity: 'warning'
  message: string
  observed_at: string
  threshold_ms: number
  elapsed_ms: number
  quiet_ms?: number
  last_observed_evidence_at?: string
  details?: Record<string, unknown>
}

export interface ParallelPreflightCheck {
  code: string
  status: ParallelPreflightCheckStatus
  message: string
  path?: string
  details?: Record<string, unknown>
}

export interface ParallelPreflightResult {
  run_instance_id: string
  step_id: string
  group_id: string
  passed: boolean
  preflight_status: ParallelPreflightStatus
  checked_at: string
  checked_by: string
  checks: ParallelPreflightCheck[]
  errors: ParallelPreflightCheck[]
  warnings: ParallelPreflightCheck[]
  executor_summary: Record<string, unknown>
  max_concurrency: number
  item_count: number
  launchable_item_count: number
  evidence_file?: unknown
}

export interface ParallelItemState {
  run_instance_id: string
  step_id: string
  group_id: string
  item_id: string
  label?: string
  status: ParallelItemStatus
  input_ref: string
  contract_ref: string
  sealed_output_target: string
  latest_attempt_id: string | null
}

export interface ParallelAttemptState {
  run_instance_id: string
  step_id: string
  group_id: string
  item_id: string
  attempt_id: string
  attempt_number: number
  status: ParallelAttemptStatus
  evidence_dir: string | null
  warnings: ParallelAttemptWarning[]
  latest_lease_id: string | null
  created_at: string
  updated_at: string
}

export interface ParallelLeaseState {
  run_instance_id: string
  step_id: string
  group_id: string
  item_id: string
  attempt_id: string
  lease_id: string
  executor_id: string
  status: ParallelLeaseStatus
  leased_at: string
  expires_at: string | null
  heartbeat_at: string | null
  created_at: string
  updated_at: string
}

export interface ParallelGroupState {
  run_instance_id: string
  step_id: string
  group_id: string
  ordinal: number
  status: ParallelGroupStatus
  executor: string
  contract_ref: string
  max_concurrency: number
  preflight_status: ParallelPreflightStatus
  checked_at: string | null
  checked_by: string | null
  preflight_errors: ParallelPreflightCheck[]
  preflight_warnings: ParallelPreflightCheck[]
  preflight_result: ParallelPreflightResult | null
  items: ParallelItemState[]
  attempts: ParallelAttemptState[]
  leases: ParallelLeaseState[]
}

export interface ApiHealth {
  ok: boolean
  service: string
  adapters?: Record<string, unknown>
}

export interface GlobalDiagnostics {
  ok: boolean
  service: string
  store: {
    runs: RunListItem[]
  }
  adapters: Record<string, unknown>
}

export interface DesktopOperatorGateState {
  gate_status: string
  auto_allow_ms?: number
  countdown_started_at?: string | null
  held_since?: string | null
  executing_since?: string | null
  desktop_control_released_at?: string | null
  pending_count?: number
  executing_count?: number
  last_snapshot_count?: number
  pending_actions?: DesktopOperatorGateAction[]
  executing_actions?: DesktopOperatorGateAction[]
}

export interface DesktopOperatorGateAction {
  action_id: string
  kind: string
  caller: string
  target_thread_id?: string | null
  target_thread_title?: string | null
  summary: string
  queued_at: string
}

export interface ValidationIssue {
  code: string
  message: string
  path: string
  severity: 'error' | 'warning'
}

export interface ValidationResult {
  ok: boolean
  issues: ValidationIssue[]
  state: RunState
}

export interface EvidenceOption {
  id: string
  label: string
  detail: string
  mode: 'virtual' | 'api'
  text?: string
  file_kind?: EvidenceKind
  file_name?: string
}
