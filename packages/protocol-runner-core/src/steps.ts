import { isSerialStep, type ResolvedStep, type RunStep, type SerialRunStep, type WorkPlan } from './types.js'

function resolveContract(plan: WorkPlan, step: SerialRunStep) {
  return step.contract ?? plan.default_contract
}

function toResolvedStep(plan: WorkPlan, step: RunStep, index: number): ResolvedStep {
  if (!isSerialStep(step)) {
    return {
      ...step,
      ordinal: index + 1,
      total_steps: plan.steps.length,
    }
  }

  return {
    ...step,
    contract: resolveContract(plan, step),
    ordinal: index + 1,
    total_steps: plan.steps.length,
  }
}

export function listResolvedSteps(plan: WorkPlan): ResolvedStep[] {
  return plan.steps.map((step, index) => toResolvedStep(plan, step, index))
}

export function resolveStep(plan: WorkPlan, stepId: string): ResolvedStep | null {
  const index = plan.steps.findIndex((step) => step.step_id === stepId)
  if (index === -1) {
    return null
  }

  return toResolvedStep(plan, plan.steps[index], index)
}

export function resolveStepByOrdinal(plan: WorkPlan, ordinal: number): ResolvedStep | null {
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > plan.steps.length) {
    return null
  }

  const index = ordinal - 1
  return toResolvedStep(plan, plan.steps[index], index)
}

export function resolveCurrentStep(
  plan: WorkPlan,
  cursor: { current_step_id: string | null; current_step_ordinal: number | null },
): ResolvedStep | null {
  if (cursor.current_step_id !== null) {
    return resolveStep(plan, cursor.current_step_id)
  }

  if (cursor.current_step_ordinal !== null) {
    return resolveStepByOrdinal(plan, cursor.current_step_ordinal)
  }

  return null
}
