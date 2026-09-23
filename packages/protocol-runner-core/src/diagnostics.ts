import type { AllowedAction, RunStatus, RunnerManualAction } from './types.js'

const ACTIONS: readonly RunnerManualAction[] = [
  'validate',
  'bind-thread',
  'start',
  'pause',
  'resume',
  'retry-current',
  'fail',
  'close',
  'accept-return',
  'refresh',
]

const ENABLED_BY_STATUS: Record<RunStatus, readonly RunnerManualAction[]> = {
  draft: ['validate', 'bind-thread', 'fail', 'refresh'],
  bound: ['validate', 'bind-thread', 'start', 'fail', 'refresh'],
  ready: ['validate', 'start', 'pause', 'fail', 'refresh'],
  dispatching_prompt: ['validate', 'fail', 'refresh'],
  waiting_for_start_report: ['validate', 'pause', 'fail', 'refresh'],
  waiting_for_completion_report: ['validate', 'pause', 'fail', 'accept-return', 'refresh'],
  running: ['validate', 'pause', 'fail', 'refresh'],
  paused: ['validate', 'bind-thread', 'resume', 'retry-current', 'fail', 'close', 'refresh'],
  blocked: ['validate', 'bind-thread', 'resume', 'retry-current', 'fail', 'close', 'refresh'],
  completed: ['validate', 'close', 'refresh'],
  failed: ['validate', 'close', 'refresh'],
  closed: ['refresh'],
}

function enabledReason(action: RunnerManualAction, status: RunStatus): string {
  if (action === 'accept-return') {
    return 'Runner is waiting for a structured status report from the current step.'
  }

  return `${action} is allowed while run status is ${status}.`
}

function disabledReason(action: RunnerManualAction, status: RunStatus): string {
  if (action === 'accept-return') {
    return 'No structured status report is expected in the current status.'
  }

  return `${action} is not allowed while run status is ${status}.`
}

export function getAllowedActions(status: RunStatus): AllowedAction[] {
  return ACTIONS.map((action) => {
    const enabled = isManualActionAllowed(status, action)
    return {
      action,
      enabled,
      reason: enabled ? enabledReason(action, status) : disabledReason(action, status),
    }
  })
}

export function isManualActionAllowed(status: RunStatus, action: RunnerManualAction): boolean {
  return ENABLED_BY_STATUS[status].includes(action)
}
