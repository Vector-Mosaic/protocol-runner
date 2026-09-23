import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  FileText,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Square,
  XCircle,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  allowDesktopOperatorGateNow,
  basenameFromEvidencePath,
  cancelParallelAttempt,
  controlParallelGroup,
  getDesktopOperatorGate,
  getGlobalDiagnostics,
  getHealth,
  getRun,
  getRunDiagnostics,
  getRunEvents,
  listRuns,
  postRunAction,
  preflightParallelGroup,
  readRunFile,
  retryParallelItem,
  validateRun,
  waitDesktopOperatorGate,
} from './api'
import type {
  AllowedAction,
  ApiHealth,
  DesktopOperatorGateAction,
  DesktopOperatorGateState,
  EvidenceOption,
  GlobalDiagnostics,
  ParallelAttemptState,
  ParallelGroupState,
  ParallelItemState,
  ParallelLeaseState,
  RunDiagnostics,
  RunListItem,
  RunStatus,
  RunnerEvent,
  RunnerManualAction,
  RunStep,
  RunView,
} from './types'

type ControlAction = 'validate' | 'start' | 'pause' | 'resume' | 'retry-current' | 'fail' | 'close' | 'refresh'
type ParallelControlAction = 'preflight' | 'pause' | 'stop' | 'retry-item' | 'cancel-attempt'
type RunnerNotificationOutcome = 'finished' | 'needs_attention'

interface RunnerNotification {
  id: string
  outcome: RunnerNotificationOutcome
  title: string
  message: string
  run_instance_id: string
  status: RunStatus
  current_step_id: string | null
}

const CONTROL_ACTIONS: Array<{
  action: ControlAction
  label: string
  Icon: typeof Play
}> = [
  { action: 'validate', label: 'Validate', Icon: CheckCircle2 },
  { action: 'start', label: 'Start', Icon: Play },
  { action: 'pause', label: 'Pause', Icon: Pause },
  { action: 'resume', label: 'Resume', Icon: Play },
  { action: 'retry-current', label: 'Retry', Icon: RotateCcw },
  { action: 'fail', label: 'Fail', Icon: XCircle },
  { action: 'close', label: 'Close', Icon: Square },
  { action: 'refresh', label: 'Refresh', Icon: RefreshCw },
]

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function formatTimestamp(value: string | undefined): string {
  if (value === undefined || value.length === 0) {
    return '-'
  }

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return value
  }

  return parsed.toLocaleString()
}

function isGateFocusMode(): boolean {
  return new URLSearchParams(window.location.search).get('gate') === '1'
}

function isNotifyFocusMode(): boolean {
  return new URLSearchParams(window.location.search).get('notify') === '1'
}

function notificationForRun(run: RunListItem): RunnerNotification | null {
  if (run.status === 'completed') {
    return {
      id: `${run.run_instance_id}:completed:${run.current_step_id ?? 'none'}`,
      outcome: 'finished',
      title: 'Runner Work Finished',
      message: 'Scheduled runner work reached a completed run state.',
      run_instance_id: run.run_instance_id,
      status: run.status,
      current_step_id: run.current_step_id,
    }
  }

  if (run.status === 'blocked' || run.status === 'failed') {
    return {
      id: `${run.run_instance_id}:${run.status}:${run.current_step_id ?? 'none'}`,
      outcome: 'needs_attention',
      title: 'Runner Needs Attention',
      message: 'Scheduled runner work cannot safely continue without operator review.',
      run_instance_id: run.run_instance_id,
      status: run.status,
      current_step_id: run.current_step_id,
    }
  }

  return null
}

function buildRunnerNotifications(runs: RunListItem[]): RunnerNotification[] {
  return runs.map(notificationForRun).filter((notification): notification is RunnerNotification => notification !== null)
}

function gateCountdownSeconds(gate: DesktopOperatorGateState | null, nowMs: number): number | null {
  if (gate?.gate_status !== 'countdown' || gate.countdown_started_at === null || gate.countdown_started_at === undefined) {
    return null
  }

  const startedAt = new Date(gate.countdown_started_at).getTime()
  const autoAllowMs = gate.auto_allow_ms ?? 0
  if (!Number.isFinite(startedAt) || autoAllowMs <= 0) {
    return null
  }

  return Math.max(0, Math.ceil((startedAt + autoAllowMs - nowMs) / 1000))
}

function actionMap(actions: AllowedAction[] | undefined): Map<RunnerManualAction, AllowedAction> {
  return new Map((actions ?? []).map((action) => [action.action, action]))
}

function actionInfo(
  actions: Map<RunnerManualAction, AllowedAction>,
  action: ControlAction,
): { enabled: boolean; reason: string } {
  if (action === 'refresh') {
    const refresh = actions.get('refresh')
    return {
      enabled: refresh?.enabled ?? true,
      reason: refresh?.reason ?? 'Refresh dashboard data from protocol-runner-api.',
    }
  }

  const allowed = actions.get(action)
  return {
    enabled: allowed?.enabled ?? false,
    reason: allowed?.reason ?? 'Run diagnostics are not loaded.',
  }
}

function currentStep(run: RunView | null): RunStep | null {
  if (run?.state.current_step_id === null || run?.state.current_step_id === undefined) {
    return null
  }

  return run.work_plan.steps.find((step) => step.step_id === run.state.current_step_id) ?? null
}

function currentParallelGroup(run: RunView | null, diagnostics: RunDiagnostics | null): ParallelGroupState | null {
  const step = currentStep(run)
  if (step?.step_kind !== 'parallel_group') {
    return null
  }

  return diagnostics?.parallel_groups.find((group) => group.group_id === step.group_id) ?? null
}

function stepContractTitle(run: RunView, step: RunStep | null): string {
  if (step?.step_kind === 'parallel_group') {
    return step.contract_ref
  }

  return step?.contract?.title ?? run.work_plan.default_contract.title
}

function stepContractPath(run: RunView, step: RunStep | null): string {
  if (step?.step_kind === 'parallel_group') {
    return step.contract_ref
  }

  return step?.contract?.path ?? run.work_plan.default_contract.path
}

function plannedStepText(step: RunStep | null): string {
  if (step === null) {
    return 'No active planned step.'
  }

  if (step.step_kind === 'parallel_group') {
    return `Parallel group ${step.group_id}: ${step.items.length} item(s), max_concurrency=${step.max_concurrency}, executor=${step.executor}`
  }

  return step.planned_step
}

function countByStatus<T extends { status: string }>(items: T[]): string {
  if (items.length === 0) {
    return 'none'
  }

  const counts = new Map<string, number>()
  for (const item of items) {
    counts.set(item.status, (counts.get(item.status) ?? 0) + 1)
  }

  return Array.from(counts.entries())
    .map(([status, count]) => `${status}: ${count}`)
    .join(', ')
}

function activeLeases(group: ParallelGroupState): ParallelLeaseState[] {
  return group.leases.filter((lease) => lease.status === 'active')
}

function latestAttemptForItem(group: ParallelGroupState, item: ParallelItemState): ParallelAttemptState | null {
  if (item.latest_attempt_id === null) {
    return null
  }

  return group.attempts.find((attempt) => attempt.attempt_id === item.latest_attempt_id) ?? null
}

function latestLeaseForAttempt(group: ParallelGroupState, attempt: ParallelAttemptState): ParallelLeaseState | null {
  if (attempt.latest_lease_id === null) {
    return null
  }

  return group.leases.find((lease) => lease.lease_id === attempt.latest_lease_id) ?? null
}

function canPreflightGroup(run: RunView, group: ParallelGroupState, busyParallelAction: ParallelControlAction | null) {
  if (busyParallelAction !== null) {
    return { enabled: false, reason: `Waiting for ${busyParallelAction}.` }
  }

  if (run.state.current_step_id !== group.step_id) {
    return { enabled: false, reason: 'Only the current parallel group can be preflighted.' }
  }

  if (['running', 'completed', 'stopped', 'cancelled'].includes(group.status)) {
    return { enabled: false, reason: `Preflight is not allowed while group status=${group.status}.` }
  }

  return { enabled: true, reason: 'Run preflight checks for this parallel group before leasing workers.' }
}

function canPauseGroup(run: RunView, group: ParallelGroupState, busyParallelAction: ParallelControlAction | null) {
  if (busyParallelAction !== null) {
    return { enabled: false, reason: `Waiting for ${busyParallelAction}.` }
  }

  if (run.state.current_step_id !== group.step_id) {
    return { enabled: false, reason: 'Only the current parallel group can be paused.' }
  }

  if (!['ready_to_lease', 'leasing', 'running'].includes(group.status)) {
    return { enabled: false, reason: `Pause is not allowed while group status=${group.status}.` }
  }

  return { enabled: true, reason: 'Pause this parallel group through protocol-runner-api.' }
}

function canStopGroup(run: RunView, group: ParallelGroupState, busyParallelAction: ParallelControlAction | null) {
  if (busyParallelAction !== null) {
    return { enabled: false, reason: `Waiting for ${busyParallelAction}.` }
  }

  if (run.state.current_step_id !== group.step_id) {
    return { enabled: false, reason: 'Only the current parallel group can be stopped.' }
  }

  if (['completed', 'stopped', 'cancelled'].includes(group.status)) {
    return { enabled: false, reason: `Stop is not allowed while group status=${group.status}.` }
  }

  return { enabled: true, reason: 'Stop this parallel group and preserve evidence.' }
}

function canRetryItem(item: ParallelItemState, busyParallelAction: ParallelControlAction | null) {
  if (busyParallelAction !== null) {
    return { enabled: false, reason: `Waiting for ${busyParallelAction}.` }
  }

  if (!['blocked', 'needs_recovery', 'cancelled', 'stopped'].includes(item.status)) {
    return { enabled: false, reason: `Retry is not allowed while item status=${item.status}.` }
  }

  return { enabled: true, reason: 'Create a new numbered attempt for this item through protocol-runner-api.' }
}

function canCancelAttempt(
  group: ParallelGroupState,
  attempt: ParallelAttemptState | null,
  busyParallelAction: ParallelControlAction | null,
) {
  if (busyParallelAction !== null) {
    return { enabled: false, reason: `Waiting for ${busyParallelAction}.`, lease: null as ParallelLeaseState | null }
  }

  if (attempt === null) {
    return { enabled: false, reason: 'No attempt exists for this item.', lease: null as ParallelLeaseState | null }
  }

  const lease = latestLeaseForAttempt(group, attempt)
  if (lease === null || lease.status !== 'active') {
    return { enabled: false, reason: 'Cancel requires an active lease.', lease }
  }

  if (!['leased', 'running'].includes(attempt.status)) {
    return { enabled: false, reason: `Cancel is not allowed while attempt status=${attempt.status}.`, lease }
  }

  return { enabled: true, reason: 'Cancel the active attempt through protocol-runner-api.', lease }
}

function attemptEvidenceRefs(attempt: ParallelAttemptState | null): string[] {
  if (attempt?.evidence_dir === null || attempt?.evidence_dir === undefined) {
    return []
  }

  return [
    'prompt.md',
    'worker_packet.json',
    'status_report.json',
    'process.json',
    'stderr.log',
    'codex_exec.jsonl',
    'final_message.md',
    'result.json',
  ].map((fileName) => `${attempt.evidence_dir}/${fileName}`)
}

function bindingSummary(run: RunView | null): string {
  const binding = run?.state.thread_binding
  if (binding === null || binding === undefined) {
    return 'unbound'
  }

  const channel = binding.relay_channel_name ?? binding.relay_channel_id
  const thread = binding.visible_thread_label ?? binding.binding_kind
  return channel ? `${thread} / ${channel}` : thread
}

function buildEvidenceOptions(
  run: RunView | null,
  diagnostics: RunDiagnostics | null,
  events: RunnerEvent[],
): EvidenceOption[] {
  if (run === null) {
    return []
  }

  const options: EvidenceOption[] = [
    {
      id: 'state',
      label: 'state.json',
      detail: run.state.work_plan_path,
      mode: 'virtual',
      text: `${jsonText(run.state)}\n`,
    },
    {
      id: 'work_plan',
      label: 'work_plan.json',
      detail: run.work_plan.run_title,
      mode: 'virtual',
      text: `${jsonText(run.work_plan)}\n`,
    },
    {
      id: 'events',
      label: 'events.jsonl',
      detail: `${events.length} latest events`,
      mode: 'virtual',
      text: `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
    },
  ]

  if ((diagnostics?.parallel_groups.length ?? 0) > 0) {
    options.push({
      id: 'parallel_groups',
      label: 'parallel groups',
      detail: `${diagnostics?.parallel_groups.length ?? 0} group(s) from run diagnostics`,
      mode: 'virtual',
      text: `${jsonText(diagnostics?.parallel_groups ?? [])}\n`,
    })
  }

  const latest = diagnostics?.latest_files ?? {}
  const labels: Record<string, string> = {
    step: 'latest step',
    prompt: 'latest prompt',
    start: 'latest start report',
    status: 'latest status report',
    parallel_preflight: 'latest parallel preflight',
  }

  for (const [kind, path] of Object.entries(latest)) {
    if (path === undefined) {
      continue
    }

    const fileName = basenameFromEvidencePath(path)
    options.push({
      id: `${kind}:${fileName}`,
      label: labels[kind] ?? kind,
      detail: path,
      mode: 'api',
      file_kind: kind as EvidenceOption['file_kind'],
      file_name: fileName,
    })
  }

  return options
}

function validSelectedRunId(current: string | null, nextRuns: RunListItem[]): string | null {
  if (current !== null && nextRuns.some((item) => item.run_instance_id === current)) {
    return current
  }

  return nextRuns[0]?.run_instance_id ?? null
}

function StatusPill({ value }: { value: string }) {
  return <span className={`status-pill status-${value}`}>{value}</span>
}

function Field({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div className="field">
      <span>{label}</span>
      <strong>{value ?? '-'}</strong>
    </div>
  )
}

function gateActionTarget(action: DesktopOperatorGateAction): string {
  if (action.target_thread_title !== null && action.target_thread_title !== undefined && action.target_thread_title !== '') {
    return action.target_thread_title
  }

  if (action.target_thread_id !== null && action.target_thread_id !== undefined && action.target_thread_id !== '') {
    return action.target_thread_id
  }

  return 'no target thread'
}

function GateActionList({
  title,
  actions,
  emptyText,
}: {
  title: string
  actions: DesktopOperatorGateAction[]
  emptyText: string
}) {
  return (
    <div className="gate-action-list">
      <h3>{title}</h3>
      {actions.length === 0 ? (
        <p>{emptyText}</p>
      ) : (
        <ul>
          {actions.map((action) => (
            <li key={action.action_id}>
              <strong>
                {action.caller} / {action.kind}
              </strong>
              <span>{gateActionTarget(action)}</span>
              <em>{action.summary}</em>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function OperatorGateFocusPanel({
  desktopGate,
  busyGateAction,
  nowMs,
  onGateAction,
}: {
  desktopGate: DesktopOperatorGateState | null
  busyGateAction: 'wait' | 'allow-now' | null
  nowMs: number
  onGateAction: (action: 'wait' | 'allow-now') => void
}) {
  const gateStatus = desktopGate?.gate_status ?? 'unknown'
  const countdownSeconds = gateCountdownSeconds(desktopGate, nowMs)
  const pendingCount = desktopGate?.pending_count ?? 0
  const executingCount = desktopGate?.executing_count ?? 0
  const lastSnapshotCount = desktopGate?.last_snapshot_count ?? 0
  const pendingActions = desktopGate?.pending_actions ?? []
  const executingActions = desktopGate?.executing_actions ?? []
  const canWait = gateStatus === 'countdown' && busyGateAction === null
  const canSend = (gateStatus === 'countdown' || gateStatus === 'held') && busyGateAction === null

  let message = 'No queued Codex Desktop action is waiting.'
  if (gateStatus === 'countdown') {
    message =
      countdownSeconds === null
        ? 'Codex Desktop automation is waiting for operator attention.'
        : `Codex Desktop automation will take control in ${countdownSeconds} seconds.`
  } else if (gateStatus === 'held') {
    message = 'Codex Desktop automation is held until Send is pressed.'
  } else if (gateStatus === 'executing') {
    message = 'Codex Desktop automation is using the desktop now.'
  } else if (desktopGate?.desktop_control_released_at) {
    message = `Desktop control released at ${formatTimestamp(desktopGate.desktop_control_released_at)}.`
  }

  return (
    <section className={`gate-focus-panel gate-focus-${gateStatus}`} aria-live="assertive">
      <div className="gate-focus-copy">
        <AlertTriangle size={26} aria-hidden="true" />
        <div>
          <h2>Codex Desktop Control Requested</h2>
          <p>{message}</p>
        </div>
      </div>
      <div className="gate-focus-metrics">
        <Field label="Gate" value={gateStatus} />
        <Field label="Queued" value={pendingCount} />
        <Field label="Executing" value={executingCount} />
        <Field label="Last batch" value={lastSnapshotCount} />
      </div>
      <div className="gate-focus-actions">
        <button
          type="button"
          className="control-button"
          disabled={!canWait}
          title="Hold all queued Codex Desktop automation until Send is pressed."
          aria-label="Wait on Desktop gate"
          onClick={() => onGateAction('wait')}
        >
          <Pause size={16} aria-hidden="true" />
          <span>Wait</span>
        </button>
        <button
          type="button"
          className="control-button"
          disabled={!canSend}
          title="Release the current queued Desktop action snapshot and execute it serially."
          aria-label="Allow Desktop gate now"
          onClick={() => onGateAction('allow-now')}
        >
          <Play size={16} aria-hidden="true" />
          <span>Send</span>
        </button>
      </div>
      <div className="gate-action-lists">
        <GateActionList
          title="Queued desktop actions"
          actions={pendingActions}
          emptyText="No queued desktop actions."
        />
        <GateActionList
          title="Executing desktop actions"
          actions={executingActions}
          emptyText="No desktop actions are executing."
        />
      </div>
    </section>
  )
}

function DesktopControlExecutingOverlay({ desktopGate }: { desktopGate: DesktopOperatorGateState | null }) {
  const gateStatus = desktopGate?.gate_status ?? 'unknown'
  const executingActions = desktopGate?.executing_actions ?? []
  const isExecuting = gateStatus === 'executing' || (desktopGate?.executing_count ?? 0) > 0

  if (!isExecuting) {
    return null
  }

  return (
    <div className="desktop-control-overlay" role="alert" aria-live="assertive">
      <section className="desktop-control-card" aria-labelledby="desktop-control-title">
        <AlertTriangle size={44} aria-hidden="true" />
        <div>
          <h2 id="desktop-control-title">Desktop Control Active</h2>
          <p>Codex automation is using the NUC desktop now. Do not click, type, or move focus until this clears.</p>
        </div>
        <GateActionList
          title="Executing desktop actions"
          actions={executingActions}
          emptyText="Desktop automation is executing."
        />
      </section>
    </div>
  )
}

function RunnerNotificationList({ notifications }: { notifications: RunnerNotification[] }) {
  if (notifications.length === 0) {
    return <p className="muted-text">No completed or attention-needed runner work is currently reported.</p>
  }

  return (
    <ul className="runner-notification-list">
      {notifications.map((notification) => (
        <li key={notification.id} className={`runner-notification-item ${notification.outcome}`}>
          <strong>{notification.run_instance_id}</strong>
          <span>{notification.status}</span>
          <em>{notification.current_step_id ?? 'no current step'}</em>
        </li>
      ))}
    </ul>
  )
}

function RunnerNotificationFocusPanel({
  notifications,
  onRefresh,
}: {
  notifications: RunnerNotification[]
  onRefresh: () => void
}) {
  const hasAttention = notifications.some((notification) => notification.outcome === 'needs_attention')
  const title = hasAttention ? 'Runner Needs Attention' : 'Runner Work Finished'
  const message =
    notifications.length === 0
      ? 'No terminal or attention-needed runner work is currently reported.'
      : hasAttention
        ? 'At least one runner is blocked or failed and needs operator review.'
        : 'Scheduled runner work reached a completed run state.'

  return (
    <section className={`runner-notification-focus ${hasAttention ? 'needs-attention' : 'finished'}`} aria-live="assertive">
      <div className="runner-notification-copy">
        {hasAttention ? <AlertTriangle size={30} aria-hidden="true" /> : <CheckCircle2 size={30} aria-hidden="true" />}
        <div>
          <h2>{title}</h2>
          <p>{message}</p>
        </div>
      </div>
      <RunnerNotificationList notifications={notifications} />
      <button
        type="button"
        className="control-button"
        title="Refresh dashboard data from protocol-runner-api."
        aria-label="Refresh runner notification state"
        onClick={onRefresh}
      >
        <RefreshCw size={16} aria-hidden="true" />
        <span>Refresh</span>
      </button>
    </section>
  )
}

function RunnerNotificationBanner({ notifications }: { notifications: RunnerNotification[] }) {
  if (notifications.length === 0) {
    return null
  }

  const hasAttention = notifications.some((notification) => notification.outcome === 'needs_attention')
  const completedCount = notifications.filter((notification) => notification.outcome === 'finished').length
  const attentionCount = notifications.length - completedCount

  return (
    <section className={`runner-notification-banner ${hasAttention ? 'needs-attention' : 'finished'}`} aria-live="assertive">
      <div className="runner-notification-copy">
        {hasAttention ? <AlertTriangle size={22} aria-hidden="true" /> : <CheckCircle2 size={22} aria-hidden="true" />}
        <div>
          <h2>{hasAttention ? 'Runner Needs Attention' : 'Runner Work Finished'}</h2>
          <p>
            {completedCount} completed, {attentionCount} needing attention.
          </p>
        </div>
      </div>
      <RunnerNotificationList notifications={notifications} />
    </section>
  )
}

function DiagnosticsBlock({
  health,
  diagnostics,
  desktopGate,
  busyGateAction,
  onGateAction,
}: {
  health: ApiHealth | null
  diagnostics: GlobalDiagnostics | null
  desktopGate: DesktopOperatorGateState | null
  busyGateAction: 'wait' | 'allow-now' | null
  onGateAction: (action: 'wait' | 'allow-now') => void
}) {
  const gateStatus = desktopGate?.gate_status ?? 'unknown'
  const pendingActions = desktopGate?.pending_actions ?? []
  const executingActions = desktopGate?.executing_actions ?? []
  const canWait = gateStatus === 'countdown' && busyGateAction === null
  const canSend = (gateStatus === 'countdown' || gateStatus === 'held') && busyGateAction === null

  return (
    <section className="panel diagnostics-panel" aria-labelledby="diagnostics-title">
      <div className="panel-heading">
        <Activity size={17} aria-hidden="true" />
        <h2 id="diagnostics-title">Diagnostics</h2>
      </div>
      <div className="health-strip">
        <Field label="API" value={health?.ok === true ? 'ok' : 'unknown'} />
        <Field label="Service" value={health?.service ?? diagnostics?.service ?? '-'} />
        <Field label="Runs" value={diagnostics?.store.runs.length ?? '-'} />
        <Field label="Desktop gate" value={desktopGate?.gate_status ?? 'unknown'} />
        <Field label="Queued" value={desktopGate?.pending_count ?? '-'} />
      </div>
      <div className="control-bar gate-controls" aria-label="Desktop operator gate controls">
        <button
          type="button"
          className="control-button"
          disabled={!canWait}
          title="Hold all queued Codex Desktop automation until Send/Allow now is pressed."
          aria-label="Wait on Desktop gate"
          onClick={() => onGateAction('wait')}
        >
          <Pause size={16} aria-hidden="true" />
          <span>Wait</span>
        </button>
        <button
          type="button"
          className="control-button"
          disabled={!canSend}
          title="Release the current queued Desktop action snapshot and execute it serially."
          aria-label="Allow Desktop gate now"
          onClick={() => onGateAction('allow-now')}
        >
          <Play size={16} aria-hidden="true" />
          <span>Send</span>
        </button>
      </div>
      <div className="gate-action-lists compact">
        <GateActionList
          title="Global queued desktop actions"
          actions={pendingActions}
          emptyText="No queued desktop actions."
        />
        <GateActionList
          title="Global executing desktop actions"
          actions={executingActions}
          emptyText="No desktop actions are executing."
        />
      </div>
      <pre className="json-preview">{jsonText({ health, adapters: diagnostics?.adapters ?? null })}</pre>
    </section>
  )
}

function ParallelControlButton({
  label,
  title,
  disabled,
  onClick,
}: {
  label: string
  title: string
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button type="button" className="parallel-action-button" disabled={disabled} title={title} onClick={onClick}>
      {label}
    </button>
  )
}

function ParallelGroupPanel({
  run,
  group,
  busyParallelAction,
  onParallelAction,
}: {
  run: RunView
  group: ParallelGroupState | null
  busyParallelAction: ParallelControlAction | null
  onParallelAction: (action: ParallelControlAction, payload: Record<string, string>) => void
}) {
  if (group === null) {
    return (
      <section className="panel parallel-panel" aria-labelledby="parallel-title">
        <div className="panel-heading">
          <Activity size={17} aria-hidden="true" />
          <h2 id="parallel-title">Parallel Group</h2>
        </div>
        <p className="muted-text">No current parallel group is exposed by diagnostics.</p>
      </section>
    )
  }

  const preflight = canPreflightGroup(run, group, busyParallelAction)
  const pause = canPauseGroup(run, group, busyParallelAction)
  const stop = canStopGroup(run, group, busyParallelAction)
  const activeLeaseCount = activeLeases(group).length

  return (
    <section className="panel parallel-panel" aria-labelledby="parallel-title">
      <div className="panel-heading">
        <Activity size={17} aria-hidden="true" />
        <h2 id="parallel-title">Parallel Group</h2>
      </div>
      <div className="parallel-header">
        <div>
          <strong>{group.group_id}</strong>
          <span>{group.contract_ref}</span>
        </div>
        <StatusPill value={group.status} />
      </div>
      <div className="summary-grid parallel-summary">
        <Field label="Step" value={group.step_id} />
        <Field label="Executor" value={group.executor} />
        <Field label="Max concurrency" value={group.max_concurrency} />
        <Field label="Preflight" value={group.preflight_status} />
        <Field label="Active leases" value={activeLeaseCount} />
        <Field label="Items" value={countByStatus(group.items)} />
        <Field label="Attempts" value={countByStatus(group.attempts)} />
        <Field label="Checked" value={formatTimestamp(group.checked_at ?? undefined)} />
      </div>
      <div className="parallel-control-bar" aria-label="Parallel group controls">
        <ParallelControlButton
          label="Preflight"
          disabled={!preflight.enabled}
          title={preflight.reason}
          onClick={() => onParallelAction('preflight', { group_id: group.group_id })}
        />
        <ParallelControlButton
          label="Pause Group"
          disabled={!pause.enabled}
          title={pause.reason}
          onClick={() => onParallelAction('pause', { group_id: group.group_id })}
        />
        <ParallelControlButton
          label="Stop Group"
          disabled={!stop.enabled}
          title={stop.reason}
          onClick={() => onParallelAction('stop', { group_id: group.group_id })}
        />
      </div>
      {group.preflight_errors.length > 0 ? (
        <div className="parallel-alert">
          <strong>Preflight errors</strong>
          {group.preflight_errors.map((error) => (
            <span key={`${error.code}:${error.path ?? ''}`}>{error.message}</span>
          ))}
        </div>
      ) : null}
      {group.preflight_warnings.length > 0 ? (
        <div className="parallel-warning">
          <strong>Preflight warnings</strong>
          {group.preflight_warnings.map((warning) => (
            <span key={`${warning.code}:${warning.path ?? ''}`}>{warning.message}</span>
          ))}
        </div>
      ) : null}
      <div className="parallel-table-wrap">
        <table className="parallel-table">
          <caption>Worker items</caption>
          <thead>
            <tr>
              <th>Item</th>
              <th>Status</th>
              <th>Latest attempt</th>
              <th>Input</th>
              <th>Sealed output</th>
              <th>Controls</th>
            </tr>
          </thead>
          <tbody>
            {group.items.map((item) => {
              const attempt = latestAttemptForItem(group, item)
              const retry = canRetryItem(item, busyParallelAction)
              const cancel = canCancelAttempt(group, attempt, busyParallelAction)
              return (
                <tr key={item.item_id}>
                  <td>
                    <strong>{item.item_id}</strong>
                    <span>{item.label ?? '-'}</span>
                  </td>
                  <td>
                    <StatusPill value={item.status} />
                  </td>
                  <td>{attempt?.attempt_id ?? '-'}</td>
                  <td>{item.input_ref}</td>
                  <td>{item.sealed_output_target}</td>
                  <td>
                    <div className="parallel-row-actions">
                      <ParallelControlButton
                        label="Retry"
                        disabled={!retry.enabled}
                        title={retry.reason}
                        onClick={() => onParallelAction('retry-item', { group_id: group.group_id, item_id: item.item_id })}
                      />
                      <ParallelControlButton
                        label="Cancel"
                        disabled={!cancel.enabled}
                        title={cancel.reason}
                        onClick={() =>
                          onParallelAction('cancel-attempt', {
                            group_id: group.group_id,
                            attempt_id: attempt?.attempt_id ?? '',
                            lease_id: cancel.lease?.lease_id ?? '',
                          })
                        }
                      />
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="parallel-table-wrap">
        <table className="parallel-table">
          <caption>Attempts and leases</caption>
          <thead>
            <tr>
              <th>Attempt</th>
              <th>Item</th>
              <th>Status</th>
              <th>Lease</th>
              <th>Executor / PID</th>
              <th>Timing</th>
              <th>Evidence refs</th>
            </tr>
          </thead>
          <tbody>
            {group.attempts.length === 0 ? (
              <tr>
                <td colSpan={7}>No attempts have been created.</td>
              </tr>
            ) : (
              group.attempts.map((attempt) => {
                const lease = latestLeaseForAttempt(group, attempt)
                return (
                  <tr key={attempt.attempt_id}>
                    <td>{attempt.attempt_id}</td>
                    <td>{attempt.item_id}</td>
                    <td>
                      <StatusPill value={attempt.status} />
                      {attempt.warnings.length > 0 ? (
                        <div className="attempt-warning-list" aria-label={`Warnings for ${attempt.attempt_id}`}>
                          {attempt.warnings.map((warning) => (
                            <span key={`${attempt.attempt_id}:${warning.code}`} title={warning.message}>
                              {warning.code}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </td>
                    <td>{lease === null ? '-' : `${lease.status}: ${lease.lease_id}`}</td>
                    <td>{lease === null ? '-' : lease.executor_id}</td>
                    <td>
                      <span>created {formatTimestamp(attempt.created_at)}</span>
                      <span>updated {formatTimestamp(attempt.updated_at)}</span>
                      <span>heartbeat {formatTimestamp(lease?.heartbeat_at ?? undefined)}</span>
                    </td>
                    <td>
                      <ul className="evidence-ref-list">
                        {attemptEvidenceRefs(attempt).map((ref) => (
                          <li key={ref}>{ref}</li>
                        ))}
                      </ul>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function RunList({
  runs,
  selectedRunId,
  onSelect,
}: {
  runs: RunListItem[]
  selectedRunId: string | null
  onSelect: (runInstanceId: string) => void
}) {
  return (
    <section className="runs-column" aria-labelledby="runs-title">
      <div className="column-heading">
        <h2 id="runs-title">Runs</h2>
        <span>{runs.length}</span>
      </div>
      <div className="run-list">
        {runs.map((run) => (
          <button
            key={run.run_instance_id}
            type="button"
            className={`run-list-item ${run.run_instance_id === selectedRunId ? 'selected' : ''}`}
            onClick={() => onSelect(run.run_instance_id)}
          >
            <span className="run-list-top">
              <strong>{run.run_instance_id}</strong>
              <StatusPill value={run.status} />
            </span>
            <span>{run.current_step_id ?? 'no current step'}</span>
            <span>{formatTimestamp(run.updated_at)}</span>
          </button>
        ))}
      </div>
    </section>
  )
}

function ControlBar({
  actions,
  busyAction,
  onAction,
}: {
  actions: Map<RunnerManualAction, AllowedAction>
  busyAction: ControlAction | null
  onAction: (action: ControlAction) => void
}) {
  return (
    <div className="control-bar" aria-label="Run controls">
      {CONTROL_ACTIONS.map(({ action, label, Icon }) => {
        const info = actionInfo(actions, action)
        const disabled = busyAction !== null || !info.enabled
        const title = disabled && busyAction !== null ? `Waiting for ${busyAction}.` : info.reason
        return (
          <button
            key={action}
            type="button"
            className={`control-button control-${action}`}
            disabled={disabled}
            title={title}
            aria-label={label}
            onClick={() => onAction(action)}
          >
            <Icon size={16} aria-hidden="true" />
            <span>{label}</span>
          </button>
        )
      })}
    </div>
  )
}

function RunDetail({
  run,
  diagnostics,
  health,
  globalDiagnostics,
  desktopGate,
  events,
  busyAction,
  busyGateAction,
  busyParallelAction,
  onAction,
  onGateAction,
  onParallelAction,
}: {
  run: RunView | null
  diagnostics: RunDiagnostics | null
  health: ApiHealth | null
  globalDiagnostics: GlobalDiagnostics | null
  desktopGate: DesktopOperatorGateState | null
  events: RunnerEvent[]
  busyAction: ControlAction | null
  busyGateAction: 'wait' | 'allow-now' | null
  busyParallelAction: ParallelControlAction | null
  onAction: (action: ControlAction) => void
  onGateAction: (action: 'wait' | 'allow-now') => void
  onParallelAction: (action: ParallelControlAction, payload: Record<string, string>) => void
}) {
  const step = currentStep(run)
  const parallelGroup = currentParallelGroup(run, diagnostics)
  const actions = actionMap(diagnostics?.next_allowed_actions)
  const progress =
    run?.state.current_step_ordinal === null || run?.state.current_step_ordinal === undefined
      ? '-'
      : `${run.state.current_step_ordinal} of ${run.work_plan.steps.length}`

  if (run === null) {
    return (
      <main className="detail-column">
        <section className="panel empty-state">
          <AlertTriangle size={18} aria-hidden="true" />
          <span>No run selected.</span>
        </section>
        <DiagnosticsBlock
          health={health}
          diagnostics={globalDiagnostics}
          desktopGate={desktopGate}
          busyGateAction={busyGateAction}
          onGateAction={onGateAction}
        />
      </main>
    )
  }

  return (
    <main className="detail-column">
      <section className="panel run-summary-panel" aria-labelledby="run-title">
        <div className="run-title-row">
          <div>
            <h1 id="run-title">{run.work_plan.run_title}</h1>
            <p>{run.run_instance_id}</p>
          </div>
          <StatusPill value={run.state.status} />
        </div>
        <ControlBar actions={actions} busyAction={busyAction} onAction={onAction} />
        <div className="summary-grid">
          <Field label="Progress" value={progress} />
          <Field label="Current step" value={run.state.current_step_id} />
          <Field label="Step kind" value={step?.step_kind} />
          <Field label="Execution mode" value={run.work_plan.execution_mode} />
          <Field label="Auto pickup" value={String(run.state.automation.auto_pickup)} />
          <Field label="Auto advance" value={String(run.state.automation.auto_advance)} />
          <Field label="Binding" value={bindingSummary(run)} />
          <Field label="Prompt message" value={run.state.last_sent_prompt_message_id} />
          <Field label="Updated" value={formatTimestamp(run.state.timestamps.updated_at)} />
        </div>
        {run.state.blocked_reason !== undefined ? <p className="blocked-reason">{run.state.blocked_reason}</p> : null}
      </section>

      <section className="panel step-panel" aria-labelledby="step-title">
        <div className="panel-heading">
          <FileText size={17} aria-hidden="true" />
          <h2 id="step-title">Current Step</h2>
        </div>
        <div className="step-body">
          <Field label="Contract" value={stepContractTitle(run, step)} />
          <Field label="Contract path" value={stepContractPath(run, step)} />
          <Field label="Completion" value={run.state.last_completion?.status} />
        </div>
        <pre className="planned-step">{plannedStepText(step)}</pre>
      </section>

      {step?.step_kind === 'parallel_group' ? (
        <ParallelGroupPanel
          run={run}
          group={parallelGroup}
          busyParallelAction={busyParallelAction}
          onParallelAction={onParallelAction}
        />
      ) : null}

      <DiagnosticsBlock
        health={health}
        diagnostics={globalDiagnostics}
        desktopGate={desktopGate}
        busyGateAction={busyGateAction}
        onGateAction={onGateAction}
      />

      <section className="panel events-panel" aria-labelledby="events-title">
        <div className="panel-heading">
          <Activity size={17} aria-hidden="true" />
          <h2 id="events-title">Last 20 Events</h2>
        </div>
        <div className="event-list">
          {events.map((event) => (
            <div key={event.event_id} className="event-row">
              <span>{formatTimestamp(event.timestamp)}</span>
              <strong>{event.event_type}</strong>
              <span>{event.step_id ?? '-'}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="panel allowed-actions-panel" aria-labelledby="allowed-actions-title">
        <div className="panel-heading">
          <CheckCircle2 size={17} aria-hidden="true" />
          <h2 id="allowed-actions-title">Allowed Actions</h2>
        </div>
        <div className="allowed-actions-list">
          {(diagnostics?.next_allowed_actions ?? []).map((action) => (
            <div key={action.action} className={action.enabled ? 'allowed' : 'blocked'}>
              <span>{action.action}</span>
              <span>{action.reason}</span>
            </div>
          ))}
        </div>
      </section>
    </main>
  )
}

function EvidenceViewer({
  options,
  selectedId,
  text,
  onSelect,
}: {
  options: EvidenceOption[]
  selectedId: string | null
  text: string
  onSelect: (optionId: string) => void
}) {
  return (
    <aside className="evidence-column" aria-labelledby="evidence-title">
      <div className="column-heading">
        <h2 id="evidence-title">Evidence</h2>
        <span>{options.length}</span>
      </div>
      <div className="evidence-options">
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            className={`evidence-option ${option.id === selectedId ? 'selected' : ''}`}
            onClick={() => onSelect(option.id)}
            title={option.detail}
          >
            <strong>{option.label}</strong>
            <span>{option.detail}</span>
          </button>
        ))}
      </div>
      <pre className="evidence-text">{text}</pre>
    </aside>
  )
}

export function App() {
  const [gateFocusMode] = useState(isGateFocusMode)
  const [notifyFocusMode] = useState(isNotifyFocusMode)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [runs, setRuns] = useState<RunListItem[]>([])
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [run, setRun] = useState<RunView | null>(null)
  const [runDiagnostics, setRunDiagnostics] = useState<RunDiagnostics | null>(null)
  const [health, setHealth] = useState<ApiHealth | null>(null)
  const [globalDiagnostics, setGlobalDiagnostics] = useState<GlobalDiagnostics | null>(null)
  const [desktopGate, setDesktopGate] = useState<DesktopOperatorGateState | null>(null)
  const [events, setEvents] = useState<RunnerEvent[]>([])
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string | null>('state')
  const [evidenceText, setEvidenceText] = useState('')
  const [busyAction, setBusyAction] = useState<ControlAction | null>(null)
  const [busyGateAction, setBusyGateAction] = useState<'wait' | 'allow-now' | null>(null)
  const [busyParallelAction, setBusyParallelAction] = useState<ParallelControlAction | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [operationResult, setOperationResult] = useState<string | null>(null)
  const refreshInFlightRef = useRef(false)

  const clearRunDetail = useCallback(() => {
    setRun(null)
    setRunDiagnostics(null)
    setEvents([])
    setSelectedEvidenceId(null)
    setEvidenceText('')
  }, [])

  const loadShell = useCallback(async (currentRunId: string | null): Promise<string | null> => {
    const [nextHealth, nextDiagnostics, nextRuns, nextDesktopGate] = await Promise.all([
      getHealth(),
      getGlobalDiagnostics(),
      listRuns(),
      getDesktopOperatorGate(),
    ])
    setHealth(nextHealth)
    setGlobalDiagnostics(nextDiagnostics)
    setRuns(nextRuns)
    setDesktopGate(nextDesktopGate)

    const nextSelectedRunId = validSelectedRunId(currentRunId, nextRuns)
    setSelectedRunId(nextSelectedRunId)
    return nextSelectedRunId
  }, [])

  const loadRun = useCallback(async (runInstanceId: string) => {
    const [nextRun, nextDiagnostics, nextEvents] = await Promise.all([
      getRun(runInstanceId),
      getRunDiagnostics(runInstanceId),
      getRunEvents(runInstanceId, 20),
    ])
    setRun(nextRun)
    setRunDiagnostics(nextDiagnostics)
    setEvents(nextEvents)
  }, [])

  const refresh = useCallback(async () => {
    if (refreshInFlightRef.current) {
      return
    }

    refreshInFlightRef.current = true
    setError(null)
    try {
      const nextSelectedRunId = await loadShell(selectedRunId)
      if (nextSelectedRunId === null) {
        clearRunDetail()
        return
      }

      await loadRun(nextSelectedRunId)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      refreshInFlightRef.current = false
    }
  }, [clearRunDetail, loadRun, loadShell, selectedRunId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    const interval = window.setInterval(() => {
      void refresh()
    }, 5000)

    return () => window.clearInterval(interval)
  }, [refresh])

  useEffect(() => {
    document.title = gateFocusMode
      ? 'Protocol Runner Gate'
      : notifyFocusMode
        ? 'Protocol Runner Notification'
        : 'Protocol Runner'
  }, [gateFocusMode, notifyFocusMode])

  useEffect(() => {
    if (!gateFocusMode) {
      return undefined
    }

    const interval = window.setInterval(() => {
      setNowMs(Date.now())
      void getDesktopOperatorGate()
        .then(setDesktopGate)
        .catch((gateError) => {
          setError(gateError instanceof Error ? gateError.message : String(gateError))
        })
    }, 1000)

    return () => window.clearInterval(interval)
  }, [gateFocusMode])

  useEffect(() => {
    if (selectedRunId === null) {
      clearRunDetail()
      return
    }

    setError(null)
    void loadRun(selectedRunId).catch((loadError) => {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    })
  }, [clearRunDetail, loadRun, selectedRunId])

  const evidenceOptions = useMemo(
    () => buildEvidenceOptions(run, runDiagnostics, events),
    [events, run, runDiagnostics],
  )
  const runnerNotifications = useMemo(() => buildRunnerNotifications(runs), [runs])

  useEffect(() => {
    if (evidenceOptions.length === 0) {
      setSelectedEvidenceId(null)
      setEvidenceText('')
      return
    }

    if (selectedEvidenceId === null || !evidenceOptions.some((option) => option.id === selectedEvidenceId)) {
      setSelectedEvidenceId(evidenceOptions[0].id)
    }
  }, [evidenceOptions, selectedEvidenceId])

  useEffect(() => {
    const option = evidenceOptions.find((candidate) => candidate.id === selectedEvidenceId)
    if (option === undefined || run === null) {
      return
    }

    if (option.mode === 'virtual') {
      setEvidenceText(option.text ?? '')
      return
    }

    if (option.file_kind === undefined || option.file_name === undefined) {
      setEvidenceText('Evidence reference is incomplete.')
      return
    }

    let cancelled = false
    void readRunFile(run.run_instance_id, option.file_kind, option.file_name)
      .then((text) => {
        if (!cancelled) {
          setEvidenceText(text)
        }
      })
      .catch((loadError) => {
        if (cancelled) {
          return
        }
        setEvidenceText(loadError instanceof Error ? loadError.message : String(loadError))
      })

    return () => {
      cancelled = true
    }
  }, [evidenceOptions, run, selectedEvidenceId])

  const handleAction = async (action: ControlAction) => {
    if (selectedRunId === null) {
      return
    }

    if (action === 'refresh') {
      await refresh()
      return
    }

    if (action === 'retry-current' && !window.confirm('Retry the current Protocol Runner step?')) {
      return
    }

    if (
      action === 'close' &&
      !window.confirm('Close out this Protocol Runner run and delete its runner-owned artifacts?')
    ) {
      return
    }

    let body: Record<string, unknown> | undefined
    if (action === 'fail') {
      if (!window.confirm('Fail this Protocol Runner run?')) {
        return
      }
      body = { reason: window.prompt('Failure reason', 'Manual fail requested.') ?? 'Manual fail requested.' }
    }

    setBusyAction(action)
    setError(null)
    try {
      const result = action === 'validate' ? await validateRun(selectedRunId) : await postRunAction(selectedRunId, action, body)
      setOperationResult(`${jsonText(result)}\n`)
      if (action === 'close') {
        const nextSelectedRunId = await loadShell(null)
        if (nextSelectedRunId === null) {
          clearRunDetail()
        } else {
          await loadRun(nextSelectedRunId)
        }
        return
      }

      const nextSelectedRunId = await loadShell(selectedRunId)
      if (nextSelectedRunId === null) {
        clearRunDetail()
        return
      }

      await loadRun(nextSelectedRunId)
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError))
    } finally {
      setBusyAction(null)
    }
  }

  const handleGateAction = async (action: 'wait' | 'allow-now') => {
    setBusyGateAction(action)
    setError(null)
    try {
      const result = action === 'wait' ? await waitDesktopOperatorGate() : await allowDesktopOperatorGateNow()
      setDesktopGate(result)
      await loadShell(selectedRunId)
    } catch (gateError) {
      setError(gateError instanceof Error ? gateError.message : String(gateError))
    } finally {
      setBusyGateAction(null)
    }
  }

  const handleParallelAction = async (action: ParallelControlAction, payload: Record<string, string>) => {
    if (selectedRunId === null) {
      return
    }

    const groupId = payload.group_id
    if (groupId === undefined || groupId.length === 0) {
      setError('Parallel group id is missing.')
      return
    }

    if (action === 'stop' && !window.confirm(`Stop parallel group ${groupId}?`)) {
      return
    }

    if (action === 'cancel-attempt' && !window.confirm(`Cancel attempt ${payload.attempt_id ?? ''}?`)) {
      return
    }

    setBusyParallelAction(action)
    setError(null)
    try {
      let result: unknown
      if (action === 'preflight') {
        result = await preflightParallelGroup(selectedRunId, groupId)
      } else if (action === 'pause' || action === 'stop') {
        result = await controlParallelGroup(selectedRunId, groupId, action)
      } else if (action === 'retry-item') {
        result = await retryParallelItem(selectedRunId, groupId, payload.item_id ?? '')
      } else {
        result = await cancelParallelAttempt(selectedRunId, groupId, payload.attempt_id ?? '', payload.lease_id ?? '')
      }

      setOperationResult(`${jsonText(result)}\n`)
      const nextSelectedRunId = await loadShell(selectedRunId)
      if (nextSelectedRunId === null) {
        clearRunDetail()
        return
      }

      await loadRun(nextSelectedRunId)
    } catch (parallelError) {
      setError(parallelError instanceof Error ? parallelError.message : String(parallelError))
    } finally {
      setBusyParallelAction(null)
    }
  }

  return (
    <div className="app-shell">
      <DesktopControlExecutingOverlay desktopGate={desktopGate} />
      <header className="top-bar">
        <div>
          <h1>Protocol Runner</h1>
          <span>{selectedRunId ?? 'no run selected'}</span>
        </div>
        <button
          type="button"
          className="icon-button"
          title="Refresh dashboard data from protocol-runner-api."
          aria-label="Refresh dashboard"
          onClick={() => void refresh()}
        >
          <RefreshCw size={18} aria-hidden="true" />
        </button>
      </header>

      {error !== null ? <div className="error-banner">{error}</div> : null}
      {gateFocusMode ? (
        <OperatorGateFocusPanel
          desktopGate={desktopGate}
          busyGateAction={busyGateAction}
          nowMs={nowMs}
          onGateAction={(action) => void handleGateAction(action)}
        />
      ) : null}
      {notifyFocusMode ? (
        <RunnerNotificationFocusPanel notifications={runnerNotifications} onRefresh={() => void refresh()} />
      ) : (
        <RunnerNotificationBanner notifications={runnerNotifications} />
      )}
      {operationResult !== null ? <pre className="operation-result">{operationResult}</pre> : null}

      <div className="workspace-grid">
        <RunList runs={runs} selectedRunId={selectedRunId} onSelect={setSelectedRunId} />
        <RunDetail
          run={run}
          diagnostics={runDiagnostics}
          health={health}
          globalDiagnostics={globalDiagnostics}
          desktopGate={desktopGate}
          events={events}
          busyAction={busyAction}
          busyGateAction={busyGateAction}
          busyParallelAction={busyParallelAction}
          onAction={(action) => void handleAction(action)}
          onGateAction={(action) => void handleGateAction(action)}
          onParallelAction={(action, payload) => void handleParallelAction(action, payload)}
        />
        <EvidenceViewer
          options={evidenceOptions}
          selectedId={selectedEvidenceId}
          text={evidenceText}
          onSelect={setSelectedEvidenceId}
        />
      </div>
    </div>
  )
}
