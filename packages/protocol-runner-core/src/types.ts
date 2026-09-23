export const WORK_PLAN_SCHEMA_VERSION = 'protocol_runner.work_plan.v1' as const
export const RUN_STATE_SCHEMA_VERSION = 'protocol_runner.run_state.v1' as const
export const GENERIC_STEP_PROMPT_TEMPLATE_ID = 'generic_step' as const

export type WorkPlanSchemaVersion = typeof WORK_PLAN_SCHEMA_VERSION
export type RunStateSchemaVersion = typeof RUN_STATE_SCHEMA_VERSION
export type PromptTemplateId = typeof GENERIC_STEP_PROMPT_TEMPLATE_ID

export type RunStatus =
  | 'draft'
  | 'bound'
  | 'ready'
  | 'dispatching_prompt'
  | 'waiting_for_start_report'
  | 'waiting_for_completion_report'
  | 'running'
  | 'paused'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'closed'

export type SerialStepKind = 'work' | 'review'
export type StepKind = SerialStepKind | 'parallel_group'
export type ExecutionMode = 'serial' | 'mixed'
export type ParallelExecutor = 'codex_exec'
export const WORKER_CAPABILITIES = ['base', 'json_transform', 'source_writer'] as const
export type WorkerCapability = (typeof WORKER_CAPABILITIES)[number]
export type CompletionStatus = 'completed' | 'blocked'
export type StatusReportStatus = CompletionStatus
export type TransitionAction = 'next' | 'pause' | 'stop' | 'go_to'

export interface ContractReference {
  title: string
  path: string
}

export type TransitionRule =
  | {
      action: 'next'
    }
  | {
      action: 'pause'
    }
  | {
      action: 'stop'
    }
  | {
      action: 'go_to'
      step_id: string
    }

export interface SerialRunStep {
  step_id: string
  step_kind: SerialStepKind
  contract: ContractReference | null
  planned_step: string
  visible_work_item: Record<string, unknown>
  prompt_template: PromptTemplateId
  on_completed: TransitionRule
  on_blocked: TransitionRule
}

export interface ParallelGroupSealedOutputDefaults {
  base_dir: string
  primary_artifact: string
}

export interface ParallelGroupItemSealedOutput {
  unit_id?: string
  primary_artifact?: string
}

export interface ParallelGroupItem {
  item_id: string
  label?: string
  input_ref: string
  variables?: Record<string, unknown>
  contract_ref?: string
  sealed_output?: ParallelGroupItemSealedOutput
  /** Exact repo-relative files this isolated writer may change, including new files. */
  owned_source_paths?: string[]
}

export interface ParallelGroupStep {
  step_id: string
  step_kind: 'parallel_group'
  group_id: string
  label?: string
  executor: ParallelExecutor
  contract_ref: string
  max_concurrency: number
  required_worker_capabilities?: WorkerCapability[]
  /** Omission preserves the existing shared-read/artifact-output lane. */
  participation?: 'artifact_only' | 'source_writer'
  source_base_commit?: string
  sealed_output_defaults: ParallelGroupSealedOutputDefaults
  timeout_policy?: Record<string, unknown>
  items: ParallelGroupItem[]
  on_completed: TransitionRule
  on_blocked: TransitionRule
}

export type RunStep = SerialRunStep | ParallelGroupStep
export type WorkPlanStep = RunStep

export interface WorkPlan {
  schema_version: WorkPlanSchemaVersion
  run_title: string
  execution_mode: ExecutionMode
  default_contract: ContractReference
  steps: RunStep[]
}

export interface ResolvedSerialStep extends SerialRunStep {
  contract: ContractReference
  ordinal: number
  total_steps: number
}

export interface ResolvedParallelGroupStep extends ParallelGroupStep {
  ordinal: number
  total_steps: number
}

export type ResolvedStep = ResolvedSerialStep | ResolvedParallelGroupStep

export function isSerialStep(step: RunStep): step is SerialRunStep {
  return step.step_kind === 'work' || step.step_kind === 'review'
}

export function isResolvedSerialStep(step: ResolvedStep): step is ResolvedSerialStep {
  return isSerialStep(step)
}

export type BindingKind = 'serial_desktop' | 'parallel_only'

export interface BindingMetadata {
  binding_kind: BindingKind
  visible_thread_label?: string
  relay_channel_id?: string
  relay_channel_name?: string
  binding_id?: string
  cleanup_state?: 'active' | 'cleanup_requested' | 'cleaned_up' | 'cleanup_failed'
}

export interface RunTimestamps {
  created_at: string
  updated_at: string
  started_at?: string
  completed_at?: string
}

export interface RunAutomationSettings {
  auto_pickup: boolean
  auto_advance: boolean
}

export interface RunState {
  schema_version: RunStateSchemaVersion
  run_instance_id: string
  work_plan_path: string
  status: RunStatus
  current_step_id: string | null
  current_step_ordinal: number | null
  automation: RunAutomationSettings
  thread_binding: BindingMetadata | null
  last_sent_prompt_message_id?: string
  pending_start_report?: PromptStartExpectation
  last_start_report?: StepStartReport
  last_completion?: CompletionReturn
  blocked_reason?: string
  timestamps: RunTimestamps
}

export interface PromptStartExpectation {
  run_instance_id: string
  step_id: string
  prompt_attempt_id: string
  start_token: string
  attempt: number
  prompt_file: string
  sent_at: string
}

export interface StepStartReport {
  run_instance_id: string
  step_id: string
  prompt_attempt_id: string
  start_token: string
}

export interface CompletionReturn {
  run_instance_id: string
  step_id: string
  status: CompletionStatus
  summary?: string
}

export type StatusReport = CompletionReturn

export type RunnerEventType =
  | 'plan_validated'
  | 'run_bound'
  | 'prompt_rendered'
  | 'prompt_sent'
  | 'start_report_received'
  | 'status_report_received'
  | 'transition_resolved'
  | 'state_changed'
  | 'manual_action'
  | 'automation_updated'
  | 'driver_observed'
  | 'desktop_action_queued'
  | 'desktop_action_started'
  | 'desktop_action_finished'
  | 'diagnostic'

export interface RunnerEvent {
  event_id: string
  event_type: RunnerEventType
  run_instance_id: string
  step_id?: string
  timestamp: string
  details: Record<string, unknown>
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
}

export type TransitionResolutionAction = 'advance' | 'pause' | 'stop' | 'go_to' | 'block'

export interface TransitionResolution {
  action: TransitionResolutionAction
  next_step_id?: string
  next_step_ordinal?: number
  reason: string
}

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

export interface AllowedAction {
  action: RunnerManualAction
  enabled: boolean
  reason: string
}
