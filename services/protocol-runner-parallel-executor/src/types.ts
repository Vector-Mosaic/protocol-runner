export type RunStatus =
  | 'draft'
  | 'bound'
  | 'ready'
  | 'running'
  | 'waiting_for_return'
  | 'paused'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'closed'

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
export type ParallelAttemptWarningCode = 'long_running' | 'possibly_stalled'
export type WorkerReportedStatus = 'completed' | 'blocked'
export type WorkerCapability = 'base' | 'json_transform' | 'source_writer'
export const WORKER_CAPABILITIES: WorkerCapability[] = ['base', 'json_transform', 'source_writer']
export type LauncherStatus =
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'evidence_missing'
  | 'output_missing'
  | 'status_invalid'

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

export interface RunDiagnostics {
  run_instance_id: string
  status: RunStatus
  current_step_id: string | null
  current_step_ordinal: number | null
  blocked_reason?: string
  parallel_groups: ParallelGroupState[]
}

export interface RunView {
  run_instance_id: string
  state: {
    status: RunStatus
    current_step_id: string | null
    current_step_ordinal: number | null
    blocked_reason?: string
  }
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
  required_worker_capabilities?: WorkerCapability[]
  preflight_status: ParallelPreflightStatus
  checked_at: string | null
  checked_by: string | null
  items: ParallelItemState[]
  attempts: ParallelAttemptState[]
  leases: ParallelLeaseState[]
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

export interface ParallelAttemptState {
  run_instance_id: string
  step_id: string
  group_id: string
  item_id: string
  attempt_id: string
  attempt_number: number
  status: ParallelAttemptStatus
  evidence_dir: string | null
  latest_lease_id: string | null
  warnings: ParallelAttemptWarning[]
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

export interface ParallelLeasePacket extends ParallelLeaseState {
  run_dir: string
  attempt_dir: string
  prompt_path: string
  worker_packet_path: string
  status_report_path: string
  process_path: string
  result_path: string
  sealed_output_path: string
  input_ref: string
  contract_ref: string
  variables: Record<string, unknown>
  required_worker_capabilities?: WorkerCapability[]
  source_writer?: {
    base_commit: string
    owned_paths: string[]
    artifact_root: string
  }
}

export interface ParallelGroupEnvelope {
  ok?: true
  run: RunView
  group: ParallelGroupState
  leases?: ParallelLeasePacket[]
  lease?: ParallelLeaseState
  attempt?: ParallelAttemptState
  previous_attempt_id?: string | null
  observed_at?: string
  recovered_count?: number
  stale_lease_ids?: string[]
  stale_attempt_ids?: string[]
  stale_item_ids?: string[]
  requeued_lease_ids?: string[]
  requeued_attempt_ids?: string[]
  requeued_item_ids?: string[]
  attention_lease_ids?: string[]
  attention_attempt_ids?: string[]
  attention_item_ids?: string[]
}

export interface ParallelAttemptStatusReport {
  run_instance_id: string
  step_id: string
  group_id: string
  item_id: string
  attempt_id: string
  status: WorkerReportedStatus
  sealed_output_path: string
  notes?: string
  summary?: string
}

export interface ParallelAttemptProcessRecord {
  executor_id: string
  mode: 'fake' | 'codex_exec'
  run_instance_id: string
  group_id: string
  item_id: string
  attempt_id: string
  lease_id: string
  started_at: string
  completed_at: string
  exit_code: number
  pid?: number
  signal?: string | null
  command?: string
  args?: string[]
  worker_runtime_profile?: WorkerRuntimeProfile
  error?: string
  killed_by_runner?: boolean
  kill_reason?: string
  kill_error?: string
  source_workspace?: string
  source_handoff_path?: string
}

export interface ParallelAttemptResultFile {
  launcher_status: LauncherStatus
  summary: string
  status_report_path?: string
  sealed_output_path?: string
  /** Compatibility alias for codex_exec_jsonl_path; both name one carrier. */
  stdout_path?: string
  stderr_path?: string
  codex_exec_jsonl_path?: string
  final_message_path?: string
  process_started_path?: string
  kill_reason?: string
  kill_error?: string
}

export interface ProtocolRunnerParallelApiClient {
  listRuns(): Promise<RunListItem[]>
  getRunDiagnostics(run_instance_id: string): Promise<RunDiagnostics>
  getParallelGroup(run_instance_id: string, group_id: string): Promise<ParallelGroupEnvelope>
  grantLeases(run_instance_id: string, group_id: string, input: {
    executor_id: string
    capacity: number
    lease_ttl_ms?: number
  }): Promise<ParallelGroupEnvelope>
  heartbeat(run_instance_id: string, group_id: string, lease_id: string, input?: {
    attempt_warnings?: ParallelAttemptWarning[]
  }): Promise<ParallelGroupEnvelope>
  recoverStaleLeases(run_instance_id: string, group_id: string, input?: {
    observed_at?: string
  }): Promise<ParallelGroupEnvelope>
  controlParallelGroup(run_instance_id: string, group_id: string, action: 'pause' | 'stop', input?: {
    reason?: string
  }): Promise<ParallelGroupEnvelope>
  submitAttemptResult(run_instance_id: string, group_id: string, attempt_id: string, input: {
    lease_id: string
    attempt_id: string
    launcher_status: LauncherStatus
    status_report?: ParallelAttemptStatusReport
    process?: ParallelAttemptProcessRecord
    status_report_path?: string
    sealed_output_path?: string
    result_path?: string
    summary?: string
  }): Promise<ParallelGroupEnvelope>
}

export interface FakeLauncherOptions {
  executor_id: string
  workspace_root: string
  item_status_overrides?: Record<
    string,
    WorkerReportedStatus | 'cancelled' | 'timed_out' | 'evidence_missing' | 'output_missing' | 'status_invalid' | 'failed'
  >
  now?: () => Date
}

export interface CodexExecLauncherOptions {
  executor_id: string
  workspace_root: string
  codex_command: string
  codex_base_args: string[]
  model?: string
  profile?: string
  sandbox?: string
  bypass_approvals_and_sandbox?: boolean
  hard_timeout_ms?: number
  worker_runtime_profile?: WorkerRuntimeProfile
  now?: () => Date
}

export interface WorkerRuntimeToolStatus {
  env_var: 'NODE_EXE' | 'PNPM_CMD' | 'PYTHON_EXE'
  configured_path?: string
  usable_path?: string
  exists: boolean
}

export interface WorkerRuntimeProfile {
  profile_id: string
  capabilities: WorkerCapability[]
  env: Partial<Record<'NODE_EXE' | 'PNPM_CMD' | 'PYTHON_EXE', string>>
  path_prepend: string[]
  tool_statuses: Record<'node_exe' | 'pnpm_cmd' | 'python_exe', WorkerRuntimeToolStatus>
  source_writer_status?: { available: boolean; reason: string }
}

export interface ParallelWorkerLaunchContext {
  signal?: AbortSignal
}

export interface ParallelWorkerLaunchResult {
  lease: ParallelLeasePacket
  launcher_status: LauncherStatus
  status_report?: ParallelAttemptStatusReport
  process: ParallelAttemptProcessRecord
  result_file: ParallelAttemptResultFile
}

export type FakeLaunchResult = ParallelWorkerLaunchResult

export interface ParallelWorkerLauncher {
  launch(lease: ParallelLeasePacket, context?: ParallelWorkerLaunchContext): Promise<ParallelWorkerLaunchResult>
}

export type ParallelExecutorDecisionAction =
  | 'launched'
  | 'no_eligible_groups'
  | 'no_leases_granted'
  | 'stale_leases_recovered'
  | 'missing_required_capabilities'
  | 'api_error'
  | 'launcher_error'

export interface ParallelExecutorDecision {
  action: ParallelExecutorDecisionAction
  run_instance_id?: string
  group_id?: string
  launched_count?: number
  launch_batch_count?: number
  launch_batch_size?: number
  launch_batch_interval_ms?: number
  completed_count?: number
  blocked_count?: number
  needs_attention_count?: number
  recovered_count?: number
  stale_lease_ids?: string[]
  stale_attempt_ids?: string[]
  stale_item_ids?: string[]
  requeued_lease_ids?: string[]
  requeued_attempt_ids?: string[]
  requeued_item_ids?: string[]
  attention_lease_ids?: string[]
  attention_attempt_ids?: string[]
  attention_item_ids?: string[]
  required_worker_capabilities?: WorkerCapability[]
  available_worker_capabilities?: WorkerCapability[]
  missing_worker_capabilities?: WorkerCapability[]
  reason: string
  error?: string
}
