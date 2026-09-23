import type { ResolvedStep, StatusReport, TransitionResolution, WorkPlan } from './types.js'
import { resolveStep, resolveStepByOrdinal } from './steps.js'

export function resolveTransition(
  plan: WorkPlan,
  step: ResolvedStep,
  completion: StatusReport,
): TransitionResolution {
  if (completion.step_id !== step.step_id) {
    return {
      action: 'block',
      reason: `Completion step_id ${completion.step_id} does not match current step ${step.step_id}.`,
    }
  }

  const rule = completion.status === 'completed' ? step.on_completed : step.on_blocked

  if (rule.action === 'pause') {
    return {
      action: 'pause',
      reason: `Transition rule for status=${completion.status} requested pause.`,
    }
  }

  if (rule.action === 'stop') {
    return {
      action: 'stop',
      reason: `Transition rule for status=${completion.status} requested stop.`,
    }
  }

  if (rule.action === 'go_to') {
    const target = resolveStep(plan, rule.step_id)
    if (target === null) {
      return {
        action: 'block',
        reason: `Transition target does not exist: ${rule.step_id}.`,
      }
    }

    return {
      action: 'go_to',
      next_step_id: target.step_id,
      next_step_ordinal: target.ordinal,
      reason: `Transition rule for status=${completion.status} routed to ${target.step_id}.`,
    }
  }

  const nextStep = resolveStepByOrdinal(plan, step.ordinal + 1)
  if (nextStep === null) {
    return {
      action: 'block',
      reason: `Transition rule requested next after final step ${step.step_id}.`,
    }
  }

  return {
    action: 'advance',
    next_step_id: nextStep.step_id,
    next_step_ordinal: nextStep.ordinal,
    reason: `Transition rule for status=${completion.status} advanced to ${nextStep.step_id}.`,
  }
}
