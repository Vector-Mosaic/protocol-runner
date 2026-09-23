import { randomBytes } from 'node:crypto'
import { readControlToken } from './client.js'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { promises as fs } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

type JsonRecord = Record<string, unknown>
type LauncherMode = 'codex_exec'
type SmokeStatus = 'passed' | 'failed'

interface ChildHandle {
  child: ChildProcessWithoutNullStreams
  stdout: Buffer[]
  stderr: Buffer[]
}

interface SmokeContext {
  repoRoot: string
  serviceRoot: string
  executorMain: string
  apiMain: string
  smokeRoot: string
  nodeExe: string
}

interface SmokeResult {
  id: string
  status: SmokeStatus
  root: string
  run_instance_id: string
  group_id: string
  api_port: number
  executor_exit_code: number | null
  run_status?: string
  group_status?: string
  completed_items?: number
  completed_attempts?: number
  worker_attempts?: number
  sealed_outputs?: string[]
  profile_evidence?: string[]
  error?: string
}

interface ParallelGroupItemState {
  item_id: string
  status: string
  sealed_output_target: string
  latest_attempt_id: string | null
}

interface ParallelAttemptState {
  attempt_id: string
  item_id: string
  status: string
  evidence_dir: string | null
}

interface ParallelLeaseState {
  lease_id: string
  item_id: string
  status: string
}

interface ParallelGroupState {
  group_id: string
  status: string
  preflight_status: string
  required_worker_capabilities?: string[]
  items: ParallelGroupItemState[]
  attempts: ParallelAttemptState[]
  leases: ParallelLeaseState[]
}

interface RunDiagnostics {
  status: string
  current_step_id: string | null
  blocked_reason?: string
  parallel_groups: ParallelGroupState[]
}

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const serviceRoot = path.resolve(moduleDir, '..')
const repoRoot = path.resolve(serviceRoot, '..', '..')
const timestamp = timestampSlug(new Date())
const smokeRoot = path.resolve(
  process.env.PROTOCOL_RUNNER_WORKER_RUNTIME_PROFILE_SMOKE_ROOT?.trim() ||
    path.join(repoRoot, 'artifacts', 'protocol_runner', 'worker_runtime_profile_smoke', timestamp),
)

const context: SmokeContext = {
  repoRoot,
  serviceRoot,
  executorMain: path.join(serviceRoot, 'dist', 'main.js'),
  apiMain: path.join(serviceRoot, '..', 'protocol-runner-api', 'dist', 'main.js'),
  smokeRoot,
  nodeExe: process.execPath,
}

process.env.PROTOCOL_RUNNER_CONTROL_TOKEN ||= randomBytes(32).toString('hex')

await main()

async function main(): Promise<void> {
  if (!process.argv.includes('--live')) throw new Error('This smoke launches real Codex workers. Pass --live explicitly.')
  await fs.mkdir(context.smokeRoot, { recursive: true })
  const results: SmokeResult[] = []
  for (const smoke of [
    runBackCompatPureParallelSmoke,
    runJsonTransformPureParallelSmoke,
    runMissingCapabilitySmoke,
    runMixedJsonTransformSmoke,
  ]) {
    const result = await smoke(context)
    results.push(result)
    process.stdout.write(`${JSON.stringify({ event: 'worker_runtime_profile_smoke_finished', result })}\n`)
    if (result.status === 'failed') {
      break
    }
  }

  const summary = {
    schema_version: 'protocol_runner.worker_runtime_profile_smoke.v1',
    generated_at: new Date().toISOString(),
    smoke_root: context.smokeRoot,
    codex_exec_mode: 'real',
    serial_adapter_mode: 'loopback_fake_for_serial_prompt_delivery_only',
    worker_runtime_profile_node_exe: context.nodeExe,
    passed: results.length === 4 && results.every((result) => result.status === 'passed'),
    results,
  }
  await fs.writeFile(path.join(context.smokeRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  if (!summary.passed) {
    process.exitCode = 1
  }
}

async function runBackCompatPureParallelSmoke(ctx: SmokeContext): Promise<SmokeResult> {
  return runPureParallelSmoke(ctx, {
    id: '01_backcompat_no_required_capabilities',
    label: 'Backward compatibility pure parallel smoke without required_worker_capabilities',
    itemCount: 1,
    requiredWorkerCapabilities: undefined,
    expectJsonTransform: false,
  })
}

async function runJsonTransformPureParallelSmoke(ctx: SmokeContext): Promise<SmokeResult> {
  return runPureParallelSmoke(ctx, {
    id: '02_json_transform_required',
    label: 'Pure parallel json_transform smoke with explicit worker runtime profile',
    itemCount: 1,
    requiredWorkerCapabilities: ['json_transform'],
    expectJsonTransform: true,
  })
}

async function runPureParallelSmoke(
  ctx: SmokeContext,
  input: {
    id: string
    label: string
    itemCount: number
    requiredWorkerCapabilities: string[] | undefined
    expectJsonTransform: boolean
  },
): Promise<SmokeResult> {
  const root = path.join(ctx.smokeRoot, input.id)
  const run_instance_id = `worker_runtime_${timestamp.toLowerCase()}_${input.id}`
  const group_id = `${input.id}_group`
  const apiPort = await freePort()
  await fs.mkdir(root, { recursive: true })
  const api = startApi(ctx, root, apiPort)
  try {
    await waitForHealth(`http://127.0.0.1:${apiPort}/health`)
    const workPlan = await writeParallelWorkPlan(ctx, root, {
      runTitle: input.label,
      run_instance_id,
      group_id,
      step_id: `${input.id}_parallel`,
      itemCount: input.itemCount,
      requiredWorkerCapabilities: input.requiredWorkerCapabilities,
      onCompleted: { action: 'stop' },
    })
    await createAndBindRun(apiPort, run_instance_id, workPlan, 'parallel_only')
    await requestJson(`http://127.0.0.1:${apiPort}/api/runs/${run_instance_id}/parallel-groups/${group_id}/preflight`, {
      method: 'POST',
      body: {},
    })
    const executor = await runExecutor(ctx, {
      id: input.id,
      root,
      apiPort,
      mode: 'codex_exec',
      capacity: input.itemCount,
      includeWorkerRuntimeTools: true,
    })
    const diagnostics = await getDiagnostics(apiPort, run_instance_id)
    const group = requireGroup(diagnostics, group_id)
    const sealedOutputs = await verifyCompletedCodexGroup(ctx, group, {
      expectedItemCount: input.itemCount,
      expectJsonTransform: input.expectJsonTransform,
    })
    const profileEvidence = await verifyProfileEvidence(ctx, group, {
      runRoot: path.join(root, 'runs', run_instance_id),
      expectJsonTransform: input.expectJsonTransform,
    })
    return passed(input.id, root, run_instance_id, group_id, apiPort, executor.exitCode, diagnostics, group, {
      sealed_outputs: sealedOutputs,
      profile_evidence: profileEvidence,
    })
  } catch (error) {
    return failed(input.id, root, run_instance_id, group_id, apiPort, null, error)
  } finally {
    await stopChild(api)
    await writeChildLogs(root, 'api', api)
  }
}

async function runMissingCapabilitySmoke(ctx: SmokeContext): Promise<SmokeResult> {
  const id = '03_missing_json_transform_blocks'
  const root = path.join(ctx.smokeRoot, id)
  const run_instance_id = `worker_runtime_${timestamp.toLowerCase()}_${id}`
  const group_id = `${id}_group`
  const apiPort = await freePort()
  await fs.mkdir(root, { recursive: true })
  const api = startApi(ctx, root, apiPort)
  try {
    await waitForHealth(`http://127.0.0.1:${apiPort}/health`)
    const workPlan = await writeParallelWorkPlan(ctx, root, {
      runTitle: 'Missing capability smoke blocks before leasing workers',
      run_instance_id,
      group_id,
      step_id: `${id}_parallel`,
      itemCount: 1,
      requiredWorkerCapabilities: ['json_transform'],
      onCompleted: { action: 'stop' },
    })
    await createAndBindRun(apiPort, run_instance_id, workPlan, 'parallel_only')
    await requestJson(`http://127.0.0.1:${apiPort}/api/runs/${run_instance_id}/parallel-groups/${group_id}/preflight`, {
      method: 'POST',
      body: {},
    })
    const executor = await runExecutor(ctx, {
      id,
      root,
      apiPort,
      mode: 'codex_exec',
      capacity: 1,
      includeWorkerRuntimeTools: false,
    })
    const diagnostics = await getDiagnostics(apiPort, run_instance_id)
    const group = requireGroup(diagnostics, group_id)
    if (group.status !== 'stopped') {
      throw new Error(`Expected stopped group after missing capability, got ${group.status}.`)
    }
    if (group.attempts.length !== 0 || group.leases.length !== 0) {
      throw new Error(
        `Expected zero attempts and zero leases after missing capability, got attempts=${group.attempts.length} leases=${group.leases.length}.`,
      )
    }
    const stdout = await fs.readFile(path.join(root, 'executor.stdout.log'), 'utf8').catch(() => '')
    if (!stdout.includes('missing_required_capabilities')) {
      throw new Error('Executor log did not include missing_required_capabilities decision.')
    }
    return passed(id, root, run_instance_id, group_id, apiPort, executor.exitCode, diagnostics, group)
  } catch (error) {
    return failed(id, root, run_instance_id, group_id, apiPort, null, error)
  } finally {
    await stopChild(api)
    await writeChildLogs(root, 'api', api)
  }
}

async function runMixedJsonTransformSmoke(ctx: SmokeContext): Promise<SmokeResult> {
  const id = '04_mixed_serial_parallel_serial'
  const root = path.join(ctx.smokeRoot, id)
  const run_instance_id = `worker_runtime_${timestamp.toLowerCase()}_${id}`
  const group_id = `${id}_group`
  const apiPort = await freePort()
  await fs.mkdir(root, { recursive: true })
  const api = startApi(ctx, root, apiPort)
  try {
    await waitForHealth(`http://127.0.0.1:${apiPort}/health`)
    const workPlan = await writeMixedWorkPlan(ctx, root, {
      run_instance_id,
      group_id,
      itemCount: 1,
    })
    await createAndBindRun(apiPort, run_instance_id, workPlan, 'serial_desktop')
    await completeSerialStep(apiPort, run_instance_id, 'serial_prepare')

    await requestJson(`http://127.0.0.1:${apiPort}/api/runs/${run_instance_id}/start`, {
      method: 'POST',
      body: {},
    })
    const executor = await runExecutor(ctx, {
      id,
      root,
      apiPort,
      mode: 'codex_exec',
      capacity: 1,
      includeWorkerRuntimeTools: true,
    })
    const afterParallel = await getDiagnostics(apiPort, run_instance_id)
    const group = requireGroup(afterParallel, group_id)
    const sealedOutputs = await verifyCompletedCodexGroup(ctx, group, {
      expectedItemCount: 1,
      expectJsonTransform: true,
    })
    const profileEvidence = await verifyProfileEvidence(ctx, group, {
      runRoot: path.join(root, 'runs', run_instance_id),
      expectJsonTransform: true,
    })

    if (afterParallel.status !== 'ready' || afterParallel.current_step_id !== 'serial_finish') {
      throw new Error(
        `Expected mixed run ready at serial_finish after parallel completion, got status=${afterParallel.status} current=${afterParallel.current_step_id}.`,
      )
    }
    await completeSerialStep(apiPort, run_instance_id, 'serial_finish')
    const finalDiagnostics = await getDiagnostics(apiPort, run_instance_id)
    if (finalDiagnostics.status !== 'completed') {
      throw new Error(`Expected mixed run completed after final serial return, got ${finalDiagnostics.status}.`)
    }

    return passed(id, root, run_instance_id, group_id, apiPort, executor.exitCode, finalDiagnostics, group, {
      sealed_outputs: sealedOutputs,
      profile_evidence: profileEvidence,
    })
  } catch (error) {
    return failed(id, root, run_instance_id, group_id, apiPort, null, error)
  } finally {
    await stopChild(api)
    await writeChildLogs(root, 'api', api)
  }
}

async function writeParallelWorkPlan(
  ctx: SmokeContext,
  root: string,
  input: {
    runTitle: string
    run_instance_id: string
    group_id: string
    step_id: string
    itemCount: number
    requiredWorkerCapabilities: string[] | undefined
    onCompleted: JsonRecord
  },
): Promise<JsonRecord> {
  const contractPath = path.join(root, 'contract', 'Worker_Runtime_Profile_Smoke_Contract.md')
  await writeContract(contractPath)
  const inputsDir = path.join(root, 'inputs')
  const sealedDir = path.join(root, 'sealed_outputs')
  await fs.mkdir(inputsDir, { recursive: true })
  await fs.mkdir(sealedDir, { recursive: true })
  const items: JsonRecord[] = []
  for (let index = 1; index <= input.itemCount; index += 1) {
    const item_id = `profile_smoke_item_${String(index).padStart(3, '0')}`
    const inputPath = path.join(inputsDir, `${item_id}.json`)
    await fs.writeFile(
      inputPath,
      `${JSON.stringify(
        {
          item_id,
          marker: 'worker_runtime_profile_smoke',
          expected_literal: 'json_transform_profile',
          numbers: [2, 3, 5],
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
    items.push({
      item_id,
      label: `Worker runtime profile smoke item ${index}`,
      input_ref: repoRelative(ctx.repoRoot, inputPath),
    })
  }
  const parallelStep: JsonRecord = {
    step_id: input.step_id,
    step_kind: 'parallel_group',
    group_id: input.group_id,
    label: input.runTitle,
    executor: 'codex_exec',
    contract_ref: repoRelative(ctx.repoRoot, contractPath),
    max_concurrency: input.itemCount,
    ...(input.requiredWorkerCapabilities === undefined
      ? {}
      : { required_worker_capabilities: input.requiredWorkerCapabilities }),
    sealed_output_defaults: {
      base_dir: repoRelative(ctx.repoRoot, sealedDir),
      primary_artifact: 'output.md',
    },
    items,
    on_completed: input.onCompleted,
    on_blocked: { action: 'pause' },
  }
  const workPlan = {
    schema_version: 'protocol_runner.work_plan.v1',
    run_title: input.runTitle,
    execution_mode: 'mixed',
    default_contract: {
      title: 'Worker Runtime Profile Smoke Contract',
      path: repoRelative(ctx.repoRoot, contractPath),
    },
    steps: [parallelStep],
  }
  await fs.writeFile(path.join(root, 'work_plan.json'), `${JSON.stringify(workPlan, null, 2)}\n`, 'utf8')
  await fs.writeFile(
    path.join(root, 'run_identity.json'),
    `${JSON.stringify({ run_instance_id: input.run_instance_id, group_id: input.group_id }, null, 2)}\n`,
    'utf8',
  )
  return workPlan
}

async function writeMixedWorkPlan(
  ctx: SmokeContext,
  root: string,
  input: {
    run_instance_id: string
    group_id: string
    itemCount: number
  },
): Promise<JsonRecord> {
  const workPlan = await writeParallelWorkPlan(ctx, root, {
    runTitle: 'Mixed serial parallel serial worker runtime profile smoke',
    run_instance_id: input.run_instance_id,
    group_id: input.group_id,
    step_id: 'parallel_json_transform',
    itemCount: input.itemCount,
    requiredWorkerCapabilities: ['json_transform'],
    onCompleted: { action: 'next' },
  })
  const contract = workPlan.default_contract as JsonRecord
  workPlan.steps = [
    serialStep('serial_prepare', contract, 'Prepare the isolated mixed-run smoke.', { phase: 'prepare' }, { action: 'next' }),
    ...(workPlan.steps as JsonRecord[]),
    serialStep('serial_finish', contract, 'Close the isolated mixed-run smoke.', { phase: 'finish' }, { action: 'stop' }),
  ]
  await fs.writeFile(path.join(root, 'work_plan.json'), `${JSON.stringify(workPlan, null, 2)}\n`, 'utf8')
  return workPlan
}

function serialStep(
  step_id: string,
  contract: JsonRecord,
  planned_step: string,
  visible_work_item: JsonRecord,
  on_completed: JsonRecord,
): JsonRecord {
  return {
    step_id,
    step_kind: 'work',
    contract,
    planned_step,
    visible_work_item,
    prompt_template: 'generic_step',
    on_completed,
    on_blocked: { action: 'pause' },
  }
}

async function writeContract(contractPath: string): Promise<void> {
  await fs.mkdir(path.dirname(contractPath), { recursive: true })
  await fs.writeFile(
    contractPath,
    [
      '# Worker Runtime Profile Smoke Contract',
      '',
      'This contract is only for isolated Protocol Runner worker-runtime smoke runs.',
      '',
      'For the one worker-visible item only:',
      '',
      '1. Read the worker-visible item packet from the invocation prompt.',
      '2. Read the JSON `input_ref` file.',
      '3. Confirm the input JSON contains `expected_literal: "json_transform_profile"`.',
      '4. If `required_worker_capabilities` includes `json_transform`, use the explicit `NODE_EXE` environment variable from the worker runtime profile. Do not use a bare `node` command for this check.',
      '5. Use `NODE_EXE` to run a tiny runtime probe that reads the same input JSON and prints JSON containing `marker`, `item_id`, `sum`, and `node_exe`.',
      '6. Write the sealed output at the exact `sealed_output_path` from the invocation.',
      '7. The sealed output must contain these literal lines:',
      '',
      '```text',
      'WORKER_RUNTIME_PROFILE_SMOKE: <item_id>',
      'JSON_TRANSFORM_RUNTIME_PROBE: <probe-json>',
      '```',
      '',
      'The `<probe-json>` must come from the `NODE_EXE` runtime probe and must include `"sum":10` for the input numbers.',
      '',
      'For compatibility runs where `required_worker_capabilities` is empty, still write the sealed output marker, and include `JSON_TRANSFORM_RUNTIME_PROBE: not_required`.',
      '',
      'Before exiting, write the procedural `status_report.json` at the exact path from the invocation. The report must use `status: "completed"` only after the sealed output is written. If any required file, tool, or instruction cannot be followed, write `status: "blocked"` with a short procedural note.',
      '',
      'Do not process sibling items. Do not call the runner API directly.',
      '',
    ].join('\n'),
    'utf8',
  )
}

async function createAndBindRun(
  apiPort: number,
  run_instance_id: string,
  workPlan: JsonRecord,
  bindingKind: 'parallel_only' | 'serial_desktop',
): Promise<void> {
  await requestJson(`http://127.0.0.1:${apiPort}/api/runs`, {
    method: 'POST',
    body: {
      run_instance_id,
      work_plan: workPlan,
      auto_pickup: true,
      auto_advance: true,
    },
  })
  await requestJson(`http://127.0.0.1:${apiPort}/api/runs/${run_instance_id}/bind`, {
    method: 'POST',
    body:
      bindingKind === 'parallel_only'
        ? { binding_kind: 'parallel_only' }
        : { binding_kind: 'serial_desktop', visible_thread_label: `smoke-${run_instance_id}` },
  })
}

async function completeSerialStep(apiPort: number, run_instance_id: string, step_id: string): Promise<void> {
  const startResponse = await requestJson(`http://127.0.0.1:${apiPort}/api/runs/${run_instance_id}/start`, {
    method: 'POST',
    body: {},
  })
  const pending = getPendingStartReport(startResponse)
  await requestJson(`http://127.0.0.1:${apiPort}/api/runs/${run_instance_id}/start-report`, {
    method: 'POST',
    body: {
      run_instance_id,
      step_id,
      prompt_attempt_id: pending.prompt_attempt_id,
      start_token: pending.start_token,
    },
  })
  await requestJson(`http://127.0.0.1:${apiPort}/api/runs/${run_instance_id}/return`, {
    method: 'POST',
    body: {
      run_instance_id,
      step_id,
      status: 'completed',
      summary: `${step_id} smoke complete`,
    },
  })
}

function getPendingStartReport(response: JsonRecord): { prompt_attempt_id: string; start_token: string } {
  const run = asRecord(response.run, 'run')
  const state = asRecord(run.state, 'run.state')
  const pending = asRecord(state.pending_start_report, 'run.state.pending_start_report')
  if (typeof pending.prompt_attempt_id !== 'string' || typeof pending.start_token !== 'string') {
    throw new Error('Start response did not include prompt_attempt_id and start_token.')
  }
  return {
    prompt_attempt_id: pending.prompt_attempt_id,
    start_token: pending.start_token,
  }
}

async function runExecutor(
  ctx: SmokeContext,
  input: {
    id: string
    root: string
    apiPort: number
    mode: LauncherMode
    capacity: number
    includeWorkerRuntimeTools: boolean
  },
): Promise<{ exitCode: number | null }> {
  const executor = startChild(process.execPath, [ctx.executorMain, '--drain'], {
    cwd: ctx.repoRoot,
    env: {
      ...process.env,
      PROTOCOL_RUNNER_API_URL: `http://127.0.0.1:${input.apiPort}`,
      PROTOCOL_RUNNER_PARALLEL_EXECUTOR_ID: `worker_runtime_smoke_${input.id}`,
      PROTOCOL_RUNNER_PARALLEL_EXECUTOR_MODE: input.mode,
      PROTOCOL_RUNNER_PARALLEL_EXECUTOR_CAPACITY: String(input.capacity),
      PROTOCOL_RUNNER_PARALLEL_EXECUTOR_LAUNCH_BATCH_SIZE: String(input.capacity),
      PROTOCOL_RUNNER_PARALLEL_EXECUTOR_LAUNCH_BATCH_INTERVAL_MS: '1000',
      PROTOCOL_RUNNER_PARALLEL_EXECUTOR_WORKSPACE_ROOT: ctx.repoRoot,
      PROTOCOL_RUNNER_PARALLEL_EXECUTOR_HEALTH_PORT: String(await freePort()),
      PROTOCOL_RUNNER_PARALLEL_EXECUTOR_CODEX_BYPASS_APPROVALS_AND_SANDBOX:
        process.env.PROTOCOL_RUNNER_PARALLEL_EXECUTOR_CODEX_BYPASS_APPROVALS_AND_SANDBOX ?? 'false',
      PROTOCOL_RUNNER_PARALLEL_EXECUTOR_HARD_TIMEOUT_MS:
        process.env.PROTOCOL_RUNNER_PARALLEL_EXECUTOR_HARD_TIMEOUT_MS ?? '1200000',
      PROTOCOL_RUNNER_PARALLEL_EXECUTOR_WORKER_RUNTIME_PROFILE_ID: input.includeWorkerRuntimeTools
        ? 'smoke_json_transform_profile'
        : 'smoke_base_only_profile',
      ...(input.includeWorkerRuntimeTools
        ? { PROTOCOL_RUNNER_PARALLEL_EXECUTOR_WORKER_NODE_EXE: ctx.nodeExe }
        : { PROTOCOL_RUNNER_PARALLEL_EXECUTOR_WORKER_NODE_EXE: path.join(input.root, 'missing-node.exe') }),
    },
  })
  const exitCode = await waitForExit(executor.child)
  await writeChildLogs(input.root, 'executor', executor)
  if (exitCode !== 0) {
    throw new Error(`Executor exited with code ${exitCode}.`)
  }
  return { exitCode }
}

function startApi(ctx: SmokeContext, root: string, apiPort: number): ChildHandle {
  return startChild(process.execPath, [ctx.apiMain], {
    cwd: ctx.repoRoot,
    env: {
      ...process.env,
      PROTOCOL_RUNNER_API_HOST: '127.0.0.1',
      PROTOCOL_RUNNER_API_PORT: String(apiPort),
      PROTOCOL_RUNNER_RUNS_ROOT: path.join(root, 'runs'),
      PROTOCOL_RUNNER_DB_PATH: path.join(root, 'protocol_runner.sqlite'),
      PROTOCOL_RUNNER_CONTRACT_ROOT: ctx.repoRoot,
      PROTOCOL_RUNNER_ADAPTER_MODE: 'fake',
      PROTOCOL_RUNNER_STORE_MODE: 'sqlite',
      PROTOCOL_RUNNER_NOTIFICATION_ENABLED: 'false',
    },
  })
}

async function verifyCompletedCodexGroup(
  ctx: SmokeContext,
  group: ParallelGroupState,
  input: { expectedItemCount: number; expectJsonTransform: boolean },
): Promise<string[]> {
  if (group.status !== 'completed') {
    throw new Error(`Expected completed group, got ${group.status}.`)
  }
  const completedItems = group.items.filter((item) => item.status === 'completed').length
  const completedAttempts = group.attempts.filter((attempt) => attempt.status === 'completed').length
  if (completedItems !== input.expectedItemCount || completedAttempts !== input.expectedItemCount) {
    throw new Error(
      `Expected ${input.expectedItemCount} completed items/attempts, got items=${completedItems} attempts=${completedAttempts}.`,
    )
  }
  const sealedOutputs: string[] = []
  for (const item of group.items) {
    const outputPath = path.resolve(ctx.repoRoot, item.sealed_output_target)
    const body = await fs.readFile(outputPath, 'utf8')
    if (!body.includes(`WORKER_RUNTIME_PROFILE_SMOKE: ${item.item_id}`)) {
      throw new Error(`Sealed output for ${item.item_id} did not include the worker runtime marker.`)
    }
    if (input.expectJsonTransform) {
      if (!body.includes('JSON_TRANSFORM_RUNTIME_PROBE:') || !body.includes('"sum":10')) {
        throw new Error(`Sealed output for ${item.item_id} did not include a successful JSON transform probe.`)
      }
    }
    sealedOutputs.push(outputPath)
  }
  return sealedOutputs
}

async function verifyProfileEvidence(
  ctx: SmokeContext,
  group: ParallelGroupState,
  input: { runRoot: string; expectJsonTransform: boolean },
): Promise<string[]> {
  const evidence: string[] = []
  for (const attempt of group.attempts) {
    if (attempt.evidence_dir === null) {
      throw new Error(`Attempt ${attempt.attempt_id} did not include an evidence_dir.`)
    }
    const evidenceDir = path.resolve(input.runRoot, attempt.evidence_dir)
    const workerPacketPath = path.join(evidenceDir, 'worker_packet.json')
    const processStartedPath = path.join(evidenceDir, 'process_started.json')
    const processPath = path.join(evidenceDir, 'process.json')
    const promptPath = path.join(evidenceDir, 'prompt.md')
    for (const filePath of [workerPacketPath, processStartedPath, processPath, promptPath]) {
      await assertFile(filePath)
      evidence.push(filePath)
    }
    const packet = JSON.parse(await fs.readFile(workerPacketPath, 'utf8')) as JsonRecord
    const processStarted = JSON.parse(await fs.readFile(processStartedPath, 'utf8')) as JsonRecord
    const processRecord = JSON.parse(await fs.readFile(processPath, 'utf8')) as JsonRecord
    for (const [label, record] of [
      ['worker_packet', packet],
      ['process_started', processStarted],
      ['process', processRecord],
    ] as Array<[string, JsonRecord]>) {
      const profile = asRecord(record.worker_runtime_profile, `${label}.worker_runtime_profile`)
      const capabilities = profile.capabilities
      if (!Array.isArray(capabilities) || !capabilities.includes('base')) {
        throw new Error(`${label} did not include base worker capability.`)
      }
      if (input.expectJsonTransform && !capabilities.includes('json_transform')) {
        throw new Error(`${label} did not include json_transform worker capability.`)
      }
      const env = asRecord(profile.env, `${label}.worker_runtime_profile.env`)
      if (input.expectJsonTransform && typeof env.NODE_EXE !== 'string') {
        throw new Error(`${label} did not include NODE_EXE in worker runtime profile env.`)
      }
    }
  }
  return evidence
}

async function getDiagnostics(apiPort: number, run_instance_id: string): Promise<RunDiagnostics> {
  const diagnosticsResponse = await requestJson(`http://127.0.0.1:${apiPort}/api/runs/${run_instance_id}/diagnostics`, {
    method: 'GET',
  })
  return diagnosticsResponse.diagnostics as RunDiagnostics
}

function requireGroup(diagnostics: RunDiagnostics, group_id: string): ParallelGroupState {
  const group = diagnostics.parallel_groups.find((candidate) => candidate.group_id === group_id)
  if (group === undefined) {
    throw new Error(`Run diagnostics did not include parallel group ${group_id}.`)
  }
  return group
}

function passed(
  id: string,
  root: string,
  run_instance_id: string,
  group_id: string,
  api_port: number,
  executor_exit_code: number | null,
  diagnostics: RunDiagnostics,
  group: ParallelGroupState,
  extra: Partial<SmokeResult> = {},
): SmokeResult {
  return {
    id,
    status: 'passed',
    root,
    run_instance_id,
    group_id,
    api_port,
    executor_exit_code,
    run_status: diagnostics.status,
    group_status: group.status,
    completed_items: group.items.filter((item) => item.status === 'completed').length,
    completed_attempts: group.attempts.filter((attempt) => attempt.status === 'completed').length,
    worker_attempts: group.attempts.length,
    ...extra,
  }
}

function failed(
  id: string,
  root: string,
  run_instance_id: string,
  group_id: string,
  api_port: number,
  executor_exit_code: number | null,
  error: unknown,
): SmokeResult {
  return {
    id,
    status: 'failed',
    root,
    run_instance_id,
    group_id,
    api_port,
    executor_exit_code,
    error: error instanceof Error ? error.message : String(error),
  }
}

function startChild(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): ChildHandle {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    windowsHide: true,
  })
  const handle: ChildHandle = {
    child,
    stdout: [],
    stderr: [],
  }
  child.stdout.on('data', (chunk: Buffer) => handle.stdout.push(chunk))
  child.stderr.on('data', (chunk: Buffer) => handle.stderr.push(chunk))
  return handle
}

async function stopChild(handle: ChildHandle): Promise<void> {
  if (handle.child.exitCode !== null || handle.child.killed) {
    return
  }
  handle.child.kill()
  await Promise.race([waitForExit(handle.child), sleep(2_000)])
}

async function writeChildLogs(root: string, prefix: string, handle: ChildHandle): Promise<void> {
  await fs.mkdir(root, { recursive: true })
  await fs.writeFile(path.join(root, `${prefix}.stdout.log`), Buffer.concat(handle.stdout))
  await fs.writeFile(path.join(root, `${prefix}.stderr.log`), Buffer.concat(handle.stderr))
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode)
      return
    }
    child.once('close', (code) => resolve(code))
  })
}

async function requestJson(
  url: string,
  options: { method: 'GET' | 'POST'; body?: JsonRecord },
): Promise<JsonRecord> {
  const response = await fetch(url, {
    method: options.method,
    redirect: 'error',
    headers: { authorization: `Bearer ${await readControlToken()}` },
    ...(options.body === undefined
      ? {}
      : {
          headers: { authorization: `Bearer ${await readControlToken()}`, 'content-type': 'application/json' },
          body: JSON.stringify(options.body),
        }),
  })
  const text = await response.text()
  const parsed = text.trim().length === 0 ? {} : (JSON.parse(text) as JsonRecord)
  if (!response.ok) {
    throw new Error(`${options.method} ${url} returned HTTP ${response.status}: ${text}`)
  }
  return parsed
}

async function waitForHealth(url: string): Promise<void> {
  const deadline = Date.now() + 20_000
  let lastError = ''
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) {
        return
      }
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await sleep(250)
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError}`)
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address !== 'object' || address === null) {
        server.close(() => reject(new Error('Could not allocate a loopback port.')))
        return
      }
      const port = address.port
      server.close(() => resolve(port))
    })
  })
}

async function assertFile(filePath: string): Promise<void> {
  const stat = await fs.stat(filePath)
  if (!stat.isFile()) {
    throw new Error(`${filePath} is not a file.`)
  }
}

function asRecord(value: unknown, label: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} was not an object.`)
  }
  return value as JsonRecord
}

function repoRelative(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join('/')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function timestampSlug(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}
