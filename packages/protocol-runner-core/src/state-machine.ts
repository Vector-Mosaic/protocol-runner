import type { RunStatus, ValidationIssue, ValidationResult } from './types.js'

export const ALLOWED_RUN_STATUS_TRANSITIONS = {
  draft: ['bound', 'failed'],
  bound: ['ready', 'failed'],
  ready: ['dispatching_prompt', 'running', 'paused', 'failed'],
  dispatching_prompt: ['waiting_for_start_report', 'blocked', 'failed'],
  waiting_for_start_report: ['waiting_for_completion_report', 'paused', 'blocked', 'failed'],
  waiting_for_completion_report: ['ready', 'paused', 'blocked', 'completed', 'failed'],
  running: ['ready', 'paused', 'blocked', 'completed', 'failed'],
  paused: ['ready', 'failed', 'closed'],
  blocked: ['ready', 'failed', 'closed'],
  completed: ['closed'],
  failed: ['closed'],
  closed: [],
} as const satisfies Record<RunStatus, readonly RunStatus[]>

function issue(code: string, message: string): ValidationIssue {
  return {
    code,
    message,
    path: '$.status',
    severity: 'error',
  }
}

export function nextStatusesForRunStatus(status: RunStatus): readonly RunStatus[] {
  return ALLOWED_RUN_STATUS_TRANSITIONS[status]
}

export function canTransitionRunStatus(from: RunStatus, to: RunStatus): boolean {
  const allowed: readonly RunStatus[] = ALLOWED_RUN_STATUS_TRANSITIONS[from]
  return allowed.includes(to)
}

export function validateRunStatusTransition(from: RunStatus, to: RunStatus): ValidationResult {
  if (canTransitionRunStatus(from, to)) {
    return { ok: true, issues: [] }
  }

  return {
    ok: false,
    issues: [
      issue(
        'run_status.invalid_transition',
        `Run status cannot transition from ${from} to ${to}. Allowed next statuses: ${ALLOWED_RUN_STATUS_TRANSITIONS[
          from
        ].join(', ') || 'none'}.`,
      ),
    ],
  }
}
