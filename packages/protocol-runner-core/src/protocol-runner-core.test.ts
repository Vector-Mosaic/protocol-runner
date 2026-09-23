import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  GENERIC_STEP_PROMPT_TEMPLATE_ID,
  WORK_PLAN_SCHEMA_VERSION,
  canTransitionRunStatus,
  getAllowedActions,
  isManualActionAllowed,
  isResolvedSerialStep,
  parseProtocolRunnerStatusReport,
  parseProtocolRunnerStepStartReport,
  renderGenericStepPrompt,
  resolveStep,
  resolveTransition,
  validateStatusReportForStep,
  validateStepStartReport,
  validateRunStatusTransition,
  validateWorkPlan,
  type ParallelGroupStep,
  type ResolvedSerialStep,
  type ResolvedStep,
  type RunnerManualAction,
  type RunStatus,
  type WorkPlan,
} from './index.js'

function makePlan(): WorkPlan {
  return {
    schema_version: WORK_PLAN_SCHEMA_VERSION,
    run_title: 'Tiny derivation pass',
    execution_mode: 'serial',
    default_contract: {
      title: 'Contract A',
      path: 'docs/contracts/Contract_A.md',
    },
    steps: [
      {
        step_id: 'derive_item_001',
        step_kind: 'work',
        contract: null,
        planned_step: 'derive item_001 under Contract A',
        visible_work_item: {
          item_id: 'item_001',
          source_path: 'docs/items.md',
        },
        prompt_template: GENERIC_STEP_PROMPT_TEMPLATE_ID,
        on_completed: { action: 'next' },
        on_blocked: { action: 'pause' },
      },
      {
        step_id: 'review_item_001',
        step_kind: 'review',
        contract: {
          title: 'Review Contract',
          path: 'docs/contracts/Review.md',
        },
        planned_step: 'review item_001 under Review Contract',
        visible_work_item: {
          item_id: 'item_001',
          output_path: 'docs/output.md',
        },
        prompt_template: GENERIC_STEP_PROMPT_TEMPLATE_ID,
        on_completed: { action: 'stop' },
        on_blocked: { action: 'go_to', step_id: 'derive_item_001' },
      },
    ],
  }
}

function makeParallelPlan(): WorkPlan {
  return {
    schema_version: WORK_PLAN_SCHEMA_VERSION,
    run_title: 'Mixed derivation pass',
    execution_mode: 'mixed',
    default_contract: {
      title: 'Contract A',
      path: 'docs/contracts/Contract_A.md',
    },
    steps: [
      {
        step_id: 'prepare_batch',
        step_kind: 'work',
        contract: null,
        planned_step: 'prepare the batch inputs',
        visible_work_item: {
          batch_id: 'nodes_001_002',
        },
        prompt_template: GENERIC_STEP_PROMPT_TEMPLATE_ID,
        on_completed: { action: 'next' },
        on_blocked: { action: 'pause' },
      },
      {
        step_id: 'derive_nodes_parallel',
        step_kind: 'parallel_group',
        group_id: 'nodes_001_002',
        label: 'Derive nodes 001-002',
        executor: 'codex_exec',
        contract_ref: 'docs/contracts/Contract_A.md',
        max_concurrency: 2,
        sealed_output_defaults: {
          base_dir: 'artifacts/protocol_runner/sealed_outputs/run_001/groups/nodes_001_002/items',
          primary_artifact: 'output.md',
        },
        items: [
          {
            item_id: 'node_001',
            label: 'annotation',
            input_ref: 'docs/items.md#annotation',
            variables: {
              node_name: 'annotation',
            },
            sealed_output: {
              unit_id: 'node_001',
            },
          },
          {
            item_id: 'node_002',
            label: 'macro_definition',
            input_ref: 'docs/items.md#macro_definition',
            contract_ref: 'docs/contracts/Contract_A.md',
            sealed_output: {
              unit_id: 'node_002',
            },
          },
        ],
        on_completed: { action: 'next' },
        on_blocked: { action: 'pause' },
      },
      {
        step_id: 'review_parallel_outputs',
        step_kind: 'review',
        contract: {
          title: 'Review Contract',
          path: 'docs/contracts/Review.md',
        },
        planned_step: 'review sealed parallel outputs',
        visible_work_item: {
          group_id: 'nodes_001_002',
        },
        prompt_template: GENERIC_STEP_PROMPT_TEMPLATE_ID,
        on_completed: { action: 'stop' },
        on_blocked: { action: 'pause' },
      },
    ],
  }
}

function expectStep(step: ResolvedStep | null): ResolvedStep {
  if (step === null) {
    throw new Error('Expected test fixture step to resolve.')
  }

  return step
}

function expectSerialStep(step: ResolvedStep | null): ResolvedSerialStep {
  const resolved = expectStep(step)
  if (!isResolvedSerialStep(resolved)) {
    throw new Error('Expected test fixture step to resolve to a serial work/review step.')
  }

  return resolved
}

function expectParallelGroupStep(plan: WorkPlan, stepId: string): ParallelGroupStep {
  const step = plan.steps.find((candidate) => candidate.step_id === stepId)
  if (step?.step_kind !== 'parallel_group') {
    throw new Error('Expected test fixture step to resolve to a parallel_group step.')
  }

  return step
}

describe('validateWorkPlan', () => {
  it('accepts a tiny serial work plan', () => {
    const result = validateWorkPlan(makePlan())

    assert.equal(result.ok, true)
    assert.deepEqual(result.issues, [])
  })

  it('rejects duplicate step ids and invalid transition targets', () => {
    const plan = makePlan()
    plan.steps[1] = {
      ...plan.steps[1],
      step_id: 'derive_item_001',
      on_blocked: { action: 'go_to', step_id: 'missing_step' },
    }

    const result = validateWorkPlan(plan)

    assert.equal(result.ok, false)
    assert.ok(result.issues.some((issue) => issue.code === 'step_id.duplicate'))
    assert.ok(result.issues.some((issue) => issue.code === 'transition.unknown_step_id'))
  })

  it('rejects unknown execution modes', () => {
    const result = validateWorkPlan({
      ...makePlan(),
      execution_mode: 'parallel',
    })

    assert.equal(result.ok, false)
    assert.ok(result.issues.some((issue) => issue.code === 'work_plan.execution_mode'))
  })

  it('accepts a mixed work plan with a structurally valid parallel_group step', () => {
    const result = validateWorkPlan(makeParallelPlan())

    assert.equal(result.ok, true)
    assert.deepEqual(result.issues, [])
  })

  it('accepts declared parallel worker capabilities', () => {
    const plan = makeParallelPlan()
    const group = expectParallelGroupStep(plan, 'derive_nodes_parallel')
    plan.steps[1] = {
      ...group,
      required_worker_capabilities: ['base', 'json_transform'],
    }

    const result = validateWorkPlan(plan)

    assert.equal(result.ok, true)
    assert.deepEqual(result.issues, [])
  })

  it('requires explicit source-writer capability, exact base and disjoint source ownership', () => {
    const plan = makeParallelPlan()
    const group = expectParallelGroupStep(plan, 'derive_nodes_parallel')
    group.participation = 'source_writer'
    group.source_base_commit = 'a'.repeat(40)
    group.required_worker_capabilities = ['source_writer']
    group.items[0].owned_source_paths = ['src/first.ts']
    group.items[1].owned_source_paths = ['src/second.ts']
    assert.equal(validateWorkPlan(plan).ok, true)
    group.items[1].owned_source_paths = ['src/FIRST.ts', '../escape', ':(glob)**']
    const invalid = validateWorkPlan(plan)
    assert.ok(invalid.issues.some((issue) => issue.code === 'parallel_group.source_path_overlap'))
    assert.ok(invalid.issues.some((issue) => issue.code === 'parallel_group.source_path_unsafe'))
    group.required_worker_capabilities = ['base']
    group.source_base_commit = 'building'
    const missing = validateWorkPlan(plan)
    assert.ok(missing.issues.some((issue) => issue.code === 'parallel_group.source_capability'))
    assert.ok(missing.issues.some((issue) => issue.code === 'parallel_group.source_base_commit'))
  })

  it('keeps source ownership out of the default artifact-only lane', () => {
    const plan = makeParallelPlan()
    const group = expectParallelGroupStep(plan, 'derive_nodes_parallel')
    group.items[0].owned_source_paths = ['src/first.ts']
    assert.ok(validateWorkPlan(plan).issues.some((issue) => issue.code === 'parallel_group.source_paths_unexpected'))
  })

  it('rejects unknown or duplicate parallel worker capabilities', () => {
    const plan = makeParallelPlan()
    const group = expectParallelGroupStep(plan, 'derive_nodes_parallel')
    plan.steps[1] = {
      ...group,
      required_worker_capabilities: ['json_transform', 'json_transform', 'made_up_capability'],
    } as ParallelGroupStep

    const result = validateWorkPlan(plan)

    assert.equal(result.ok, false)
    assert.ok(result.issues.some((issue) => issue.code === 'parallel_group.required_worker_capability.duplicate'))
    assert.ok(result.issues.some((issue) => issue.code === 'parallel_group.required_worker_capability.unknown'))
  })

  it('rejects parallel_group steps under serial execution_mode', () => {
    const result = validateWorkPlan({
      ...makeParallelPlan(),
      execution_mode: 'serial',
    })

    assert.equal(result.ok, false)
    assert.ok(result.issues.some((issue) => issue.code === 'work_plan.execution_mode_parallel_group'))
  })

  it('rejects unsafe parallel_group structure before launch', () => {
    const plan = makeParallelPlan()
    const group = expectParallelGroupStep(plan, 'derive_nodes_parallel')
    plan.steps[1] = {
      ...group,
      max_concurrency: 0,
      items: [
        {
          item_id: 'node_001',
          input_ref: 'docs/items.md#annotation',
          sealed_output: { unit_id: 'shared' },
        },
        {
          item_id: 'node_001',
          input_ref: 'docs/items.md#macro_definition',
          sealed_output: { unit_id: 'shared' },
        },
      ],
    }

    const result = validateWorkPlan(plan)

    assert.equal(result.ok, false)
    assert.ok(result.issues.some((issue) => issue.code === 'parallel_group.max_concurrency'))
    assert.ok(result.issues.some((issue) => issue.code === 'parallel_group.item_id.duplicate'))
    assert.ok(result.issues.some((issue) => issue.code === 'parallel_group.sealed_output_target.duplicate'))
  })
})

describe('step resolution and prompt rendering', () => {
  it('resolves default and override contracts', () => {
    const plan = makePlan()
    const workStep = expectSerialStep(resolveStep(plan, 'derive_item_001'))
    const reviewStep = expectSerialStep(resolveStep(plan, 'review_item_001'))

    assert.equal(workStep.contract.title, 'Contract A')
    assert.equal(reviewStep.contract.title, 'Review Contract')
    assert.equal(workStep.ordinal, 1)
    assert.equal(reviewStep.ordinal, 2)
  })

  it('resolves parallel_group steps without serial prompt contract materialization', () => {
    const parallelStep = expectStep(resolveStep(makeParallelPlan(), 'derive_nodes_parallel'))

    assert.equal(parallelStep.step_kind, 'parallel_group')
    assert.equal(parallelStep.ordinal, 2)
    assert.equal(parallelStep.total_steps, 3)
  })

  it('renders the locked generic invocation prompt shape', () => {
    const step = expectSerialStep(resolveStep(makePlan(), 'derive_item_001'))

    const prompt = renderGenericStepPrompt({
      run_instance_id: 'run_001',
      step,
      prompt_attempt_id: 'attempt_001',
      start_token: 'start-token-001',
    })

    assert.match(prompt, /^# Protocol Runner Step Start Report/)
    assert.match(
      prompt,
      /python scripts\/tools\/protocol_runner_step_start\.py --run-instance-id run_001 --step-id derive_item_001 --prompt-attempt-id attempt_001 --start-token start-token-001/,
    )
    assert.match(prompt, /# Protocol Runner Invocation/)
    assert.match(prompt, /Read docs\/contracts\/Contract_A\.md in full before starting work\./)
    assert.match(prompt, /Planned step:\nderive item_001 under Contract A/)
    assert.match(prompt, /Do not inspect or infer the hidden ordered work plan\./)
    assert.match(
      prompt,
      /python scripts\/tools\/protocol_runner_return\.py --run-instance-id run_001 --step-id derive_item_001 --status completed/,
    )
    assert.match(prompt, /Do not put runner handoff data in your visible response\./)
  })

  it('refuses to render a parallel_group with the serial prompt template', () => {
    const step = expectStep(resolveStep(makeParallelPlan(), 'derive_nodes_parallel'))

    assert.throws(
      () =>
        renderGenericStepPrompt({
          run_instance_id: 'run_001',
          step,
          prompt_attempt_id: 'attempt_001',
          start_token: 'start-token-001',
        }),
      /parallel_group steps do not use the generic serial prompt template/,
    )
  })

  it('renders installed report helpers and nondefault API origins with host-shell quoting', () => {
    const input = {
      run_instance_id: 'run_001',
      step: expectSerialStep(resolveStep(makePlan(), 'derive_item_001')),
      prompt_attempt_id: 'attempt_001',
      start_token: 'start-token-001',
    }
    const windowsPrompt = renderGenericStepPrompt({
      ...input,
      report_commands: {
        shell: 'powershell',
        start_report: ['C:\\Program Files\\Python\\python.exe', "C:\\Runner's copy\\scripts\\tools\\protocol_runner_step_start.py", '--base-url', 'http://127.0.0.1:14831'],
        status_report: ['C:\\Program Files\\Python\\python.exe', "C:\\Runner's copy\\scripts\\tools\\protocol_runner_return.py", '--base-url', 'http://127.0.0.1:14831'],
      },
    })
    assert.ok(windowsPrompt.includes("& 'C:\\Program Files\\Python\\python.exe' 'C:\\Runner''s copy\\scripts\\tools\\protocol_runner_step_start.py' --base-url http://127.0.0.1:14831 --run-instance-id run_001"))
    assert.ok(windowsPrompt.includes("& 'C:\\Program Files\\Python\\python.exe' 'C:\\Runner''s copy\\scripts\\tools\\protocol_runner_return.py' --base-url http://127.0.0.1:14831 --run-instance-id run_001"))
    const posixPrompt = renderGenericStepPrompt({
      ...input,
      report_commands: {
        shell: 'posix',
        start_report: ['python3', "/opt/Runner's $copy/step_start.py", '--base-url', 'http://127.0.0.1:14831'],
        status_report: ['python3', '/opt/Runner $copy/return.py', '--base-url', 'http://127.0.0.1:14831'],
      },
    })
    assert.ok(posixPrompt.includes("python3 '/opt/Runner'\"'\"'s $copy/step_start.py' --base-url http://127.0.0.1:14831"))
    assert.ok(posixPrompt.includes("python3 '/opt/Runner $copy/return.py' --base-url http://127.0.0.1:14831"))
    assert.doesNotMatch(windowsPrompt + posixPrompt, /Authorization|PROTOCOL_RUNNER_CONTROL_TOKEN/)
  })
})

describe('step start report parsing', () => {
  it('parses and validates a matching structured start report', () => {
    const result = parseProtocolRunnerStepStartReport({
      run_instance_id: 'run_001',
      step_id: 'derive_item_001',
      prompt_attempt_id: 'attempt_001',
      start_token: 'start-token-001',
    })

    assert.equal(result.ok, true)
    assert.deepEqual(result.start_report, {
      run_instance_id: 'run_001',
      step_id: 'derive_item_001',
      prompt_attempt_id: 'attempt_001',
      start_token: 'start-token-001',
    })

    const validation = validateStepStartReport(result.start_report!, {
      run_instance_id: 'run_001',
      step_id: 'derive_item_001',
      prompt_attempt_id: 'attempt_001',
      start_token: 'start-token-001',
    })
    assert.equal(validation.ok, true)
  })

  it('rejects malformed start reports and wrong tokens procedurally', () => {
    const extraKey = parseProtocolRunnerStepStartReport({
      run_instance_id: 'run_001',
      step_id: 'derive_item_001',
      prompt_attempt_id: 'attempt_001',
      start_token: 'start-token-001',
      extra: 'no',
    })
    assert.equal(extraKey.ok, false)
    assert.ok(extraKey.issues.some((issue) => issue.code === 'start_report_key.unexpected'))

    const mismatch = validateStepStartReport(
      {
        run_instance_id: 'run_001',
        step_id: 'derive_item_001',
        prompt_attempt_id: 'attempt_001',
        start_token: 'wrong-token',
      },
      {
        run_instance_id: 'run_001',
        step_id: 'derive_item_001',
        prompt_attempt_id: 'attempt_001',
        start_token: 'start-token-001',
      },
    )
    assert.equal(mismatch.ok, false)
    assert.ok(mismatch.issues.some((issue) => issue.code === 'start_report.start_token_mismatch'))
  })
})

describe('status report parsing', () => {
  it('parses a valid structured status report', () => {
    const result = parseProtocolRunnerStatusReport({
      run_instance_id: 'run_001',
      step_id: 'derive_item_001',
      status: 'completed',
      summary: 'wrote the requested output',
    })

    assert.equal(result.ok, true)
    assert.deepEqual(result.status_report, {
      run_instance_id: 'run_001',
      step_id: 'derive_item_001',
      status: 'completed',
      summary: 'wrote the requested output',
    })
  })

  it('rejects malformed structured status reports and wrong step ids procedurally', () => {
    const extraKey = parseProtocolRunnerStatusReport({
      run_instance_id: 'run_001',
      step_id: 'derive_item_001',
      status: 'completed',
      extra: 'no',
    })
    assert.equal(extraKey.ok, false)
    assert.ok(extraKey.issues.some((issue) => issue.code === 'status_report_key.unexpected'))

    const mismatch = validateStatusReportForStep(
      {
        run_instance_id: 'run_001',
        step_id: 'wrong_step',
        status: 'completed',
      },
      {
        run_instance_id: 'run_001',
        step_id: 'derive_item_001',
      },
    )
    assert.equal(mismatch.ok, false)
    assert.ok(mismatch.issues.some((issue) => issue.code === 'status_report.step_id_mismatch'))
  })
})

describe('transition resolution', () => {
  it('advances to the next declared step on completed + next', () => {
    const plan = makePlan()
    const step = expectStep(resolveStep(plan, 'derive_item_001'))

    const transition = resolveTransition(plan, step, {
      run_instance_id: 'run_001',
      step_id: 'derive_item_001',
      status: 'completed',
    })

    assert.equal(transition.action, 'advance')
    assert.equal(transition.next_step_id, 'review_item_001')
    assert.equal(transition.next_step_ordinal, 2)
  })

  it('routes only by declared transition labels', () => {
    const plan = makePlan()
    const step = expectStep(resolveStep(plan, 'review_item_001'))

    const completed = resolveTransition(plan, step, {
      run_instance_id: 'run_001',
      step_id: 'review_item_001',
      status: 'completed',
    })
    assert.equal(completed.action, 'stop')

    const blocked = resolveTransition(plan, step, {
      run_instance_id: 'run_001',
      step_id: 'review_item_001',
      status: 'blocked',
    })
    assert.equal(blocked.action, 'go_to')
    assert.equal(blocked.next_step_id, 'derive_item_001')
  })

  it('blocks rather than guessing when next is requested after the final step', () => {
    const plan = makePlan()
    plan.steps[1] = {
      ...plan.steps[1],
      on_completed: { action: 'next' },
    }
    const step = expectStep(resolveStep(plan, 'review_item_001'))

    const transition = resolveTransition(plan, step, {
      run_instance_id: 'run_001',
      step_id: 'review_item_001',
      status: 'completed',
    })

    assert.equal(transition.action, 'block')
    assert.match(transition.reason, /after final step/)
  })
})

describe('run state machine and diagnostics', () => {
  it('allows only declared run status transitions', () => {
    assert.equal(canTransitionRunStatus('waiting_for_start_report', 'waiting_for_completion_report'), true)
    assert.equal(canTransitionRunStatus('waiting_for_completion_report', 'ready'), true)
    assert.equal(canTransitionRunStatus('waiting_for_completion_report', 'draft'), false)
    assert.equal(validateRunStatusTransition('draft', 'bound').ok, true)
    assert.equal(validateRunStatusTransition('draft', 'failed').ok, true)
    assert.equal(validateRunStatusTransition('closed', 'ready').ok, false)
  })

  it('uses one complete canonical manual-action matrix for diagnostics and policy queries', () => {
    const expected = {
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
    } satisfies Record<RunStatus, RunnerManualAction[]>

    for (const [status, enabledActions] of Object.entries(expected) as [RunStatus, RunnerManualAction[]][]) {
      const diagnostics = getAllowedActions(status)
      assert.deepEqual(
        diagnostics.filter((entry) => entry.enabled).map((entry) => entry.action),
        enabledActions,
        `enabled diagnostics for ${status}`,
      )
      for (const entry of diagnostics) {
        assert.equal(
          isManualActionAllowed(status, entry.action),
          entry.enabled,
          `policy query for ${status}/${entry.action}`,
        )
      }
    }

    const waitingActions = getAllowedActions('waiting_for_completion_report')
    assert.match(
      waitingActions.find((action) => action.action === 'accept-return')?.reason ?? '',
      /structured status report/,
    )
  })
})
