import {
  GENERIC_STEP_PROMPT_TEMPLATE_ID,
  type ContractReference,
  type ParallelGroupSealedOutputDefaults,
  type TransitionRule,
  type ValidationIssue,
  type ValidationResult,
  WORKER_CAPABILITIES,
  WORK_PLAN_SCHEMA_VERSION,
} from './types.js'

const STEP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
const STEP_KINDS = new Set(['work', 'review', 'parallel_group'])
const SERIAL_STEP_KINDS = new Set(['work', 'review'])
const EXECUTION_MODES = new Set(['serial', 'mixed'])
const TRANSITION_ACTIONS = new Set(['next', 'pause', 'stop', 'go_to'])
const PARALLEL_EXECUTORS = new Set(['codex_exec'])
const WORKER_CAPABILITY_SET = new Set<string>(WORKER_CAPABILITIES)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pushIssue(
  issues: ValidationIssue[],
  code: string,
  path: string,
  message: string,
): void {
  issues.push({
    code,
    message,
    path,
    severity: 'error',
  })
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function normalizePathish(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/\/+/g, '/')
}

function isEscapingPathish(value: string): boolean {
  const normalized = normalizePathish(value)
  return (
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split('/').some((segment) => segment === '..')
  )
}

function validateContractReference(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): value is ContractReference {
  if (!isRecord(value)) {
    pushIssue(issues, 'contract.not_object', path, 'Contract reference must be an object.')
    return false
  }

  let ok = true
  if (!isNonEmptyString(value.title)) {
    pushIssue(issues, 'contract.title', `${path}.title`, 'Contract title must be a non-empty string.')
    ok = false
  }

  if (!isNonEmptyString(value.path)) {
    pushIssue(issues, 'contract.path', `${path}.path`, 'Contract path must be a non-empty string.')
    ok = false
  }

  return ok
}

function validateStepId(value: unknown, path: string, issues: ValidationIssue[]): value is string {
  if (!isNonEmptyString(value)) {
    pushIssue(issues, 'step_id.required', path, 'Step id must be a non-empty string.')
    return false
  }

  if (!STEP_ID_PATTERN.test(value)) {
    pushIssue(
      issues,
      'step_id.invalid',
      path,
      'Step id must start with a letter or number and contain only letters, numbers, underscores, or hyphens.',
    )
    return false
  }

  return true
}

function validatePathish(value: unknown, path: string, issues: ValidationIssue[], label: string): value is string {
  if (!isNonEmptyString(value)) {
    pushIssue(issues, 'path.required', path, `${label} must be a non-empty string.`)
    return false
  }

  if (isEscapingPathish(value)) {
    pushIssue(issues, 'path.unsafe', path, `${label} must be a relative non-escaping path.`)
    return false
  }

  return true
}

function validateTransitionRule(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): value is TransitionRule {
  if (!isRecord(value)) {
    pushIssue(issues, 'transition.not_object', path, 'Transition rule must be an object.')
    return false
  }

  const action = value.action
  if (typeof action !== 'string' || !TRANSITION_ACTIONS.has(action)) {
    pushIssue(
      issues,
      'transition.action',
      `${path}.action`,
      'Transition action must be one of next, pause, stop, or go_to.',
    )
    return false
  }

  if (action === 'go_to') {
    return validateStepId(value.step_id, `${path}.step_id`, issues)
  }

  if ('step_id' in value) {
    pushIssue(
      issues,
      'transition.step_id_unexpected',
      `${path}.step_id`,
      'step_id is only valid for go_to transition rules.',
    )
    return false
  }

  return true
}

function validateParallelSealedOutputDefaults(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): value is ParallelGroupSealedOutputDefaults {
  if (!isRecord(value)) {
    pushIssue(issues, 'parallel_group.sealed_output_defaults', path, 'sealed_output_defaults must be an object.')
    return false
  }

  let ok = true
  if (!isNonEmptyString(value.base_dir)) {
    pushIssue(
      issues,
      'parallel_group.sealed_output_defaults.base_dir',
      `${path}.base_dir`,
      'sealed_output_defaults.base_dir must be a non-empty relative non-escaping path.',
    )
    ok = false
  } else if (isEscapingPathish(value.base_dir)) {
    pushIssue(
      issues,
      'parallel_group.sealed_output_defaults.base_dir',
      `${path}.base_dir`,
      'sealed_output_defaults.base_dir must be a non-empty relative non-escaping path.',
    )
    ok = false
  }

  if (!validatePathish(
    value.primary_artifact,
    `${path}.primary_artifact`,
    issues,
    'sealed_output_defaults.primary_artifact',
  )) {
    ok = false
  }

  return ok
}

function parallelItemPrimaryTarget(input: {
  base_dir: string
  default_primary_artifact: string
  item_id: string
  unit_id?: string
  primary_artifact?: string
}): string {
  const unitId = input.unit_id ?? input.item_id
  const primaryArtifact = input.primary_artifact ?? input.default_primary_artifact
  return normalizePathish(`${input.base_dir}/${unitId}/${primaryArtifact}`)
}

function validateParallelGroupStep(
  rawStep: Record<string, unknown>,
  stepPath: string,
  issues: ValidationIssue[],
  globalSealedOutputTargets: Map<string, string>,
): void {
  const sourceWriter = rawStep.participation === 'source_writer'
  if (rawStep.participation !== undefined && !['artifact_only', 'source_writer'].includes(String(rawStep.participation))) {
    pushIssue(issues, 'parallel_group.participation', `${stepPath}.participation`, 'participation must be artifact_only or source_writer.')
  }
  if (sourceWriter) {
    if (typeof rawStep.source_base_commit !== 'string' || !/^[0-9a-f]{40}$/.test(rawStep.source_base_commit)) {
      pushIssue(issues, 'parallel_group.source_base_commit', `${stepPath}.source_base_commit`, 'Source writers require an exact 40-character Git commit.')
    }
    if (!Array.isArray(rawStep.required_worker_capabilities) || !rawStep.required_worker_capabilities.includes('source_writer')) {
      pushIssue(issues, 'parallel_group.source_capability', `${stepPath}.required_worker_capabilities`, 'Source writers must explicitly require source_writer so older backends/executors cannot silently use the artifact-only lane.')
    }
  } else if (rawStep.source_base_commit !== undefined) {
    pushIssue(issues, 'parallel_group.source_base_unexpected', `${stepPath}.source_base_commit`, 'source_base_commit is only valid for source_writer participation.')
  }
  if ('label' in rawStep && rawStep.label !== undefined && typeof rawStep.label !== 'string') {
    pushIssue(issues, 'parallel_group.label', `${stepPath}.label`, 'label must be a string when provided.')
  }

  if (typeof rawStep.executor !== 'string' || !PARALLEL_EXECUTORS.has(rawStep.executor)) {
    pushIssue(
      issues,
      'parallel_group.executor',
      `${stepPath}.executor`,
      'parallel_group executor must be codex_exec.',
    )
  }

  if (!isNonEmptyString(rawStep.contract_ref)) {
    pushIssue(
      issues,
      'parallel_group.contract_ref',
      `${stepPath}.contract_ref`,
      'parallel_group contract_ref must be a non-empty string.',
    )
  }

  if (!isPositiveInteger(rawStep.max_concurrency)) {
    pushIssue(
      issues,
      'parallel_group.max_concurrency',
      `${stepPath}.max_concurrency`,
      'parallel_group max_concurrency must be a positive integer.',
    )
  }

  if ('required_worker_capabilities' in rawStep && rawStep.required_worker_capabilities !== undefined) {
    if (!Array.isArray(rawStep.required_worker_capabilities) || rawStep.required_worker_capabilities.length === 0) {
      pushIssue(
        issues,
        'parallel_group.required_worker_capabilities',
        `${stepPath}.required_worker_capabilities`,
        'required_worker_capabilities must be a non-empty array when provided.',
      )
    } else {
      const seenCapabilities = new Set<string>()
      rawStep.required_worker_capabilities.forEach((capability, capabilityIndex) => {
        const capabilityPath = `${stepPath}.required_worker_capabilities[${capabilityIndex}]`
        if (typeof capability !== 'string' || !WORKER_CAPABILITY_SET.has(capability)) {
          pushIssue(
            issues,
            'parallel_group.required_worker_capability.unknown',
            capabilityPath,
            `required_worker_capabilities entries must be one of: ${WORKER_CAPABILITIES.join(', ')}.`,
          )
          return
        }
        if (seenCapabilities.has(capability)) {
          pushIssue(
            issues,
            'parallel_group.required_worker_capability.duplicate',
            capabilityPath,
            `Duplicate required worker capability: ${capability}.`,
          )
        }
        seenCapabilities.add(capability)
      })
    }
  }

  const sealedOutputDefaultsOk = validateParallelSealedOutputDefaults(
    rawStep.sealed_output_defaults,
    `${stepPath}.sealed_output_defaults`,
    issues,
  )

  if ('timeout_policy' in rawStep && rawStep.timeout_policy !== undefined && !isRecord(rawStep.timeout_policy)) {
    pushIssue(
      issues,
      'parallel_group.timeout_policy',
      `${stepPath}.timeout_policy`,
      'timeout_policy must be an object when provided.',
    )
  }

  if (!Array.isArray(rawStep.items) || rawStep.items.length === 0) {
    pushIssue(issues, 'parallel_group.items', `${stepPath}.items`, 'parallel_group items must be a non-empty array.')
    return
  }

  const itemIds = new Set<string>()
  const sourceOwners = new Map<string, string>()
  rawStep.items.forEach((rawItem, itemIndex) => {
    const itemPath = `${stepPath}.items[${itemIndex}]`
    if (!isRecord(rawItem)) {
      pushIssue(issues, 'parallel_group.item.not_object', itemPath, 'parallel_group item must be an object.')
      return
    }
    if (sourceWriter) {
      if (!Array.isArray(rawItem.owned_source_paths) || rawItem.owned_source_paths.length === 0) {
        pushIssue(issues, 'parallel_group.source_paths', `${itemPath}.owned_source_paths`, 'Source writers require a nonempty list of exact owned source files.')
      } else {
        for (const [sourceIndex, sourcePath] of rawItem.owned_source_paths.entries()) {
          const label = `${itemPath}.owned_source_paths[${sourceIndex}]`
          // eslint-disable-next-line no-control-regex -- Control bytes are deliberately forbidden in owned source paths.
          if (typeof sourcePath !== 'string' || !sourcePath || sourcePath !== sourcePath.trim() || /[\\:*?[\]\x00-\x1f]/.test(sourcePath)
            || sourcePath.startsWith('/') || sourcePath.split('/').some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
            pushIssue(issues, 'parallel_group.source_path_unsafe', label, 'Owned source must be an exact slash-separated repo-relative file path without traversal or pathspec syntax.')
            continue
          }
          const identity = sourcePath.toLowerCase()
          if (sourceOwners.has(identity)) {
            pushIssue(issues, 'parallel_group.source_path_overlap', label, `Source file is already owned at ${sourceOwners.get(identity)}.`)
          }
          sourceOwners.set(identity, label)
        }
      }
    } else if (rawItem.owned_source_paths !== undefined) {
      pushIssue(issues, 'parallel_group.source_paths_unexpected', `${itemPath}.owned_source_paths`, 'owned_source_paths is only valid for source_writer participation.')
    }

    const itemId = typeof rawItem.item_id === 'string' ? rawItem.item_id : undefined
    const itemIdOk = validateStepId(rawItem.item_id, `${itemPath}.item_id`, issues)
    if (itemIdOk && itemId !== undefined) {
      if (itemIds.has(itemId)) {
        pushIssue(
          issues,
          'parallel_group.item_id.duplicate',
          `${itemPath}.item_id`,
          `Duplicate parallel item id in group: ${itemId}.`,
        )
      }
      itemIds.add(itemId)
    }

    if ('label' in rawItem && rawItem.label !== undefined && typeof rawItem.label !== 'string') {
      pushIssue(issues, 'parallel_group.item.label', `${itemPath}.label`, 'label must be a string when provided.')
    }

    if (!isNonEmptyString(rawItem.input_ref)) {
      pushIssue(
        issues,
        'parallel_group.item.input_ref',
        `${itemPath}.input_ref`,
        'parallel_group item input_ref must be a non-empty string.',
      )
    }

    if ('variables' in rawItem && rawItem.variables !== undefined && !isRecord(rawItem.variables)) {
      pushIssue(
        issues,
        'parallel_group.item.variables',
        `${itemPath}.variables`,
        'variables must be an object when provided.',
      )
    }

    if ('contract_ref' in rawItem && rawItem.contract_ref !== undefined && !isNonEmptyString(rawItem.contract_ref)) {
      pushIssue(
        issues,
        'parallel_group.item.contract_ref',
        `${itemPath}.contract_ref`,
        'item contract_ref must be a non-empty string when provided.',
      )
    }

    if ('sealed_output' in rawItem && rawItem.sealed_output !== undefined && !isRecord(rawItem.sealed_output)) {
      pushIssue(
        issues,
        'parallel_group.item.sealed_output',
        `${itemPath}.sealed_output`,
        'sealed_output must be an object when provided.',
      )
      return
    }

    const sealedOutput = isRecord(rawItem.sealed_output) ? rawItem.sealed_output : undefined
    const unitId = typeof sealedOutput?.unit_id === 'string' ? sealedOutput.unit_id : undefined
    const primaryArtifact =
      typeof sealedOutput?.primary_artifact === 'string' ? sealedOutput.primary_artifact : undefined
    if (sealedOutput !== undefined) {
      if ('unit_id' in sealedOutput && sealedOutput.unit_id !== undefined) {
        validateStepId(sealedOutput.unit_id, `${itemPath}.sealed_output.unit_id`, issues)
      }

      if ('primary_artifact' in sealedOutput && sealedOutput.primary_artifact !== undefined) {
        validatePathish(
          sealedOutput.primary_artifact,
          `${itemPath}.sealed_output.primary_artifact`,
          issues,
          'sealed_output.primary_artifact',
        )
      }
    }

    if (sealedOutputDefaultsOk && itemIdOk && itemId !== undefined && isRecord(rawStep.sealed_output_defaults)) {
      const baseDir = rawStep.sealed_output_defaults.base_dir
      const defaultPrimaryArtifact = rawStep.sealed_output_defaults.primary_artifact
      if (!isNonEmptyString(baseDir) || !isNonEmptyString(defaultPrimaryArtifact)) {
        return
      }
      const target = parallelItemPrimaryTarget({
        base_dir: baseDir,
        default_primary_artifact: defaultPrimaryArtifact,
        item_id: itemId,
        unit_id: unitId,
        primary_artifact: primaryArtifact,
      })
      if (sourceWriter && Array.isArray(rawItem.owned_source_paths)
        && rawItem.owned_source_paths.some((sourcePath) => typeof sourcePath === 'string' && sourcePath.toLowerCase() === target.toLowerCase())) {
        pushIssue(issues, 'parallel_group.source_output_overlap', `${itemPath}.owned_source_paths`, 'Source files and the sealed output must have distinct ownership.')
      }
      const previous = globalSealedOutputTargets.get(target)
      if (previous !== undefined) {
        pushIssue(
          issues,
          'parallel_group.sealed_output_target.duplicate',
          `${itemPath}.sealed_output`,
          `Duplicate sealed-output primary artifact target ${target}; first declared at ${previous}.`,
        )
      } else {
        globalSealedOutputTargets.set(target, `${itemPath}.sealed_output`)
      }
    }
  })
}

export function validateWorkPlan(input: unknown): ValidationResult {
  const issues: ValidationIssue[] = []

  if (!isRecord(input)) {
    pushIssue(issues, 'work_plan.not_object', '$', 'Work plan must be an object.')
    return { ok: false, issues }
  }

  if (input.schema_version !== WORK_PLAN_SCHEMA_VERSION) {
    pushIssue(
      issues,
      'work_plan.schema_version',
      '$.schema_version',
      `Work plan schema_version must be ${WORK_PLAN_SCHEMA_VERSION}.`,
    )
  }

  if (!isNonEmptyString(input.run_title)) {
    pushIssue(issues, 'work_plan.run_title', '$.run_title', 'run_title must be a non-empty string.')
  }

  if (typeof input.execution_mode !== 'string' || !EXECUTION_MODES.has(input.execution_mode)) {
    pushIssue(
      issues,
      'work_plan.execution_mode',
      '$.execution_mode',
      'execution_mode must be serial or mixed.',
    )
  }

  validateContractReference(input.default_contract, '$.default_contract', issues)

  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    pushIssue(issues, 'work_plan.steps', '$.steps', 'steps must be a non-empty array.')
    return { ok: issues.length === 0, issues }
  }

  const stepIds = new Set<string>()
  const groupIds = new Set<string>()
  const globalSealedOutputTargets = new Map<string, string>()
  const transitionTargets: Array<{ path: string; step_id: string }> = []
  let sawParallelGroup = false

  input.steps.forEach((rawStep, index) => {
    const stepPath = `$.steps[${index}]`
    if (!isRecord(rawStep)) {
      pushIssue(issues, 'step.not_object', stepPath, 'Step must be an object.')
      return
    }

    if (validateStepId(rawStep.step_id, `${stepPath}.step_id`, issues)) {
      if (stepIds.has(rawStep.step_id)) {
        pushIssue(issues, 'step_id.duplicate', `${stepPath}.step_id`, `Duplicate step id: ${rawStep.step_id}.`)
      }
      stepIds.add(rawStep.step_id)
    }

    if (typeof rawStep.step_kind !== 'string' || !STEP_KINDS.has(rawStep.step_kind)) {
      pushIssue(issues, 'step.step_kind', `${stepPath}.step_kind`, 'step_kind must be work, review, or parallel_group.')
      return
    }

    if (rawStep.step_kind === 'parallel_group') {
      sawParallelGroup = true
      if (validateStepId(rawStep.group_id, `${stepPath}.group_id`, issues)) {
        if (groupIds.has(rawStep.group_id)) {
          pushIssue(
            issues,
            'parallel_group.group_id.duplicate',
            `${stepPath}.group_id`,
            `Duplicate parallel group id: ${rawStep.group_id}.`,
          )
        }
        groupIds.add(rawStep.group_id)
      }
      validateParallelGroupStep(rawStep, stepPath, issues, globalSealedOutputTargets)
    } else if (SERIAL_STEP_KINDS.has(rawStep.step_kind)) {
      if (!('contract' in rawStep)) {
        pushIssue(
          issues,
          'step.contract_missing',
          `${stepPath}.contract`,
          'contract must be null to use the default contract or a contract reference object to override it.',
        )
      } else if (rawStep.contract !== null) {
        validateContractReference(rawStep.contract, `${stepPath}.contract`, issues)
      }

      if (!isNonEmptyString(rawStep.planned_step)) {
        pushIssue(
          issues,
          'step.planned_step',
          `${stepPath}.planned_step`,
          'planned_step must be a non-empty string.',
        )
      }

      if (!isRecord(rawStep.visible_work_item)) {
        pushIssue(
          issues,
          'step.visible_work_item',
          `${stepPath}.visible_work_item`,
          'visible_work_item must be an object.',
        )
      }

      if (rawStep.prompt_template !== GENERIC_STEP_PROMPT_TEMPLATE_ID) {
        pushIssue(
          issues,
          'step.prompt_template',
          `${stepPath}.prompt_template`,
          `Only prompt_template=${GENERIC_STEP_PROMPT_TEMPLATE_ID} is supported for serial work/review steps.`,
        )
      }
    }

    if (validateTransitionRule(rawStep.on_completed, `${stepPath}.on_completed`, issues)) {
      if (rawStep.on_completed.action === 'go_to') {
        transitionTargets.push({
          path: `${stepPath}.on_completed.step_id`,
          step_id: rawStep.on_completed.step_id,
        })
      }
    }

    if (validateTransitionRule(rawStep.on_blocked, `${stepPath}.on_blocked`, issues)) {
      if (rawStep.on_blocked.action === 'go_to') {
        transitionTargets.push({
          path: `${stepPath}.on_blocked.step_id`,
          step_id: rawStep.on_blocked.step_id,
        })
      }
    }
  })

  for (const target of transitionTargets) {
    if (!stepIds.has(target.step_id)) {
      pushIssue(
        issues,
        'transition.unknown_step_id',
        target.path,
        `Transition target does not exist in this work plan: ${target.step_id}.`,
      )
    }
  }

  if (input.execution_mode === 'serial' && sawParallelGroup) {
    pushIssue(
      issues,
      'work_plan.execution_mode_parallel_group',
      '$.execution_mode',
      'execution_mode=serial cannot contain parallel_group steps; use execution_mode=mixed.',
    )
  }

  return { ok: issues.length === 0, issues }
}
