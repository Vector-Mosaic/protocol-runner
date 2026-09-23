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

export interface RunAutomationSettings {
  auto_pickup: boolean
  auto_advance: boolean
}

export interface RunListItem {
  run_instance_id: string
  status: RunStatus
  current_step_id: string | null
  current_step_ordinal: number | null
  automation: RunAutomationSettings
  updated_at: string
}

export interface DriverRunView {
  run_instance_id: string
  state: {
    status: RunStatus
    current_step_id: string | null
    current_step_ordinal: number | null
    automation: RunAutomationSettings
    blocked_reason?: string
  }
}

export interface ProtocolRunnerApiClient {
  listRuns(): Promise<RunListItem[]>
  getRun(run_instance_id: string): Promise<DriverRunView>
  startRun(run_instance_id: string): Promise<DriverRunView>
}

export type DriverDecisionAction =
  | 'activated'
  | 'skipped_auto_advance_disabled'
  | 'skipped_not_ready'
  | 'skipped_terminal'
  | 'no_eligible_runs'
  | 'api_error'

export interface DriverDecision {
  action: DriverDecisionAction
  run_instance_id?: string
  status?: RunStatus
  current_step_id?: string | null
  reason: string
  error?: string
}
