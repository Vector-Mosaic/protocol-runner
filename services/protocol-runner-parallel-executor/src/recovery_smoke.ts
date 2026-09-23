import { randomBytes } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { promises as fs } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { HttpProtocolRunnerParallelApiClient, readControlToken } from './client.js'
import { ProtocolRunnerParallelExecutor } from './executor.js'
import { FakeParallelWorkerLauncher } from './launcher.js'
import type { ParallelExecutorDecision, WorkerReportedStatus } from './types.js'

type JsonRecord = Record<string, unknown>
type FakeOverride = WorkerReportedStatus | 'cancelled' | 'timed_out' | 'evidence_missing' | 'output_missing' | 'status_invalid' | 'failed'

interface ChildHandle {
  child: ChildProcessWithoutNullStreams
  stdout: Buffer[]
  stderr: Buffer[]
}

interface RecoveryContext {
  repoRoot: string
  serviceRoot: string
  apiMain: string
  smokeRoot: string
}

interface ScenarioContext extends RecoveryContext {
  scenarioRoot: string
  run_instance_id: string
  group_id: string
  apiPort: number
  apiBaseUrl: string
  client: HttpProtocolRunnerParallelApiClient
}

interface ParallelGroupDiagnostics {
  status: string
  items: Array<{ item_id: string; status: string }>
  attempts: Array<{ attempt_id: string; item_id: string; status: string; evidence_dir: string | null }>
  leases: Array<{ lease_id: string; attempt_id: string; item_id: string; status: string }>
}

interface RunDiagnostics {
  status: string
  blocked_reason?: string
  parallel_groups: ParallelGroupDiagnostics[]
  evidence_paths: {
    run_dir: string
  }
}

interface ScenarioResult {
  id: string
  status: 'passed' | 'failed'
  root: string
  run_instance_id: string
  group_id: string
  api_port: number
  run_status?: string
  group_status?: string
  decision?: ParallelExecutorDecision
  error?: string
}

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const serviceRoot = path.resolve(moduleDir, '..')
const repoRoot = path.resolve(serviceRoot, '..', '..')
const timestamp = timestampSlug(new Date())
const identityTimestamp = timestamp.toLowerCase()
const smokeRoot = path.resolve(
  process.env.PROTOCOL_RUNNER_PARALLEL_RECOVERY_SMOKE_ROOT?.trim() ||
    path.join(repoRoot, 'artifacts', 'protocol_runner', 'parallel_recovery_smoke', timestamp),
)
const context: RecoveryContext = {
  repoRoot,
  serviceRoot,
  apiMain: path.join(serviceRoot, '..', 'protocol-runner-api', 'dist', 'main.js'),
  smokeRoot,
}

process.env.PROTOCOL_RUNNER_CONTROL_TOKEN ||= randomBytes(32).toString('hex')

await main()

async function main(): Promise<void> {
  await fs.mkdir(context.smokeRoot, { recursive: true })
  const scenarios: Array<(ctx: RecoveryContext) => Promise<ScenarioResult>> = [
    (ctx) => runFakeFailureScenario(ctx, 'fake_timed_out', 'timed_out'),
    (ctx) => runFakeFailureScenario(ctx, 'fake_status_invalid', 'status_invalid'),
    runStaleLeaseScenario,
    runCancelAttemptScenario,
    runStopGroupScenario,
  ]

  const results: ScenarioResult[] = []
  for (const scenario of scenarios) {
    const result = await scenario(context)
    results.push(result)
    process.stdout.write(`${JSON.stringify({ event: 'recovery_smoke_scenario_finished', result })}\n`)
    if (result.status === 'failed') {
      break
    }
  }

  const summary = {
    schema_version: 'protocol_runner.parallel_recovery_smoke.v1',
    generated_at: new Date().toISOString(),
    smoke_root: context.smokeRoot,
    passed: results.every((result) => result.status === 'passed') && results.length === scenarios.length,
    results,
    note:
      'This smoke proves procedural recovery/control state only. It does not judge worker output quality and does not prove launcher-level process kill for live codex exec children.',
  }
  await fs.writeFile(path.join(context.smokeRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  if (!summary.passed) {
    process.exitCode = 1
  }
}

async function runFakeFailureScenario(
  ctx: RecoveryContext,
  scenarioId: string,
  override: FakeOverride,
): Promise<ScenarioResult> {
  return runScenario(ctx, scenarioId, 1, 1, async (scenario) => {
    await preflightScenario(scenario)
    const decision = await runFakeExecutorTick(scenario, { smoke_item_001: override })
    assertEqual(decision.action, 'launched', `${scenarioId} should launch one fake worker.`)
    assertEqual(decision.needs_attention_count, 1, `${scenarioId} should report one attention result.`)

    const diagnostics = await readDiagnostics(scenario)
    const group = firstGroup(diagnostics)
    assertEqual(diagnostics.status, 'blocked', `${scenarioId} run should block.`)
    assertEqual(group.status, 'needs_attention', `${scenarioId} group should need attention.`)
    assertEqual(group.attempts[0]?.status, override, `${scenarioId} attempt status should match override.`)
    assertEqual(group.items[0]?.status, 'needs_recovery', `${scenarioId} item should need recovery.`)
    await assertAttemptResultIncludes(diagnostics, group, `"launcher_status": "${override}"`)
    return { diagnostics, decision }
  })
}

async function runStaleLeaseScenario(ctx: RecoveryContext): Promise<ScenarioResult> {
  return runScenario(ctx, 'stale_lease_recovery', 2, 1, async (scenario) => {
    await preflightScenario(scenario)
    const leaseEnvelope = await requestJson(
      `${scenario.apiBaseUrl}/api/runs/${scenario.run_instance_id}/parallel-groups/${scenario.group_id}/leases`,
      {
        method: 'POST',
        body: { executor_id: 'recovery_smoke_executor', capacity: 1, lease_ttl_ms: 1 },
      },
    )
    const lease = firstLease(leaseEnvelope)
    await fs.mkdir(lease.attempt_dir, { recursive: true })
    await sleep(25)

    const decision = await runFakeExecutorTick(scenario, {})
    assertEqual(decision.action, 'stale_leases_recovered', 'executor should ask API to recover stale leases before launching.')
    assertEqual(decision.recovered_count, 1, 'stale lease recovery should recover one lease.')

    const diagnostics = await readDiagnostics(scenario)
    const group = firstGroup(diagnostics)
    assertEqual(diagnostics.status, 'blocked', 'stale lease run should block.')
    assertEqual(group.status, 'needs_attention', 'stale lease group should need attention.')
    assertEqual(group.leases[0]?.status, 'expired', 'stale lease should become expired.')
    assertEqual(group.attempts[0]?.status, 'stale', 'stale lease attempt should become stale.')
    assertEqual(itemStatus(group, 'smoke_item_001'), 'needs_recovery', 'stale lease item should need recovery.')
    assertEqual(itemStatus(group, 'smoke_item_002'), 'pending', 'sibling item should remain pending and unlaunched.')
    return { diagnostics, decision }
  })
}

async function runCancelAttemptScenario(ctx: RecoveryContext): Promise<ScenarioResult> {
  return runScenario(ctx, 'cancel_attempt', 2, 1, async (scenario) => {
    await preflightScenario(scenario)
    const leaseEnvelope = await requestJson(
      `${scenario.apiBaseUrl}/api/runs/${scenario.run_instance_id}/parallel-groups/${scenario.group_id}/leases`,
      {
        method: 'POST',
        body: { executor_id: 'recovery_smoke_executor', capacity: 1 },
      },
    )
    const lease = firstLease(leaseEnvelope)
    await requestJson(
      `${scenario.apiBaseUrl}/api/runs/${scenario.run_instance_id}/parallel-groups/${scenario.group_id}/attempts/${lease.attempt_id}/cancel`,
      {
        method: 'POST',
        body: { lease_id: lease.lease_id, reason: 'recovery smoke cancellation' },
      },
    )
    const decision = await runFakeExecutorTick(scenario, {})
    assertEqual(decision.action, 'no_eligible_groups', 'cancelled group should not launch more work.')

    const diagnostics = await readDiagnostics(scenario)
    const group = firstGroup(diagnostics)
    assertEqual(diagnostics.status, 'blocked', 'cancelled attempt run should block.')
    assertEqual(group.status, 'needs_attention', 'cancelled attempt group should need attention.')
    assertEqual(group.leases[0]?.status, 'cancelled', 'lease should be cancelled.')
    assertEqual(group.attempts[0]?.status, 'cancelled', 'attempt should be cancelled.')
    assertEqual(itemStatus(group, 'smoke_item_001'), 'needs_recovery', 'cancelled item should need recovery.')
    assertEqual(itemStatus(group, 'smoke_item_002'), 'pending', 'sibling item should remain pending and unlaunched.')
    return { diagnostics, decision }
  })
}

async function runStopGroupScenario(ctx: RecoveryContext): Promise<ScenarioResult> {
  return runScenario(ctx, 'stop_group', 2, 2, async (scenario) => {
    await preflightScenario(scenario)
    await requestJson(`${scenario.apiBaseUrl}/api/runs/${scenario.run_instance_id}/parallel-groups/${scenario.group_id}/leases`, {
      method: 'POST',
      body: { executor_id: 'recovery_smoke_executor', capacity: 2 },
    })
    await requestJson(`${scenario.apiBaseUrl}/api/runs/${scenario.run_instance_id}/parallel-groups/${scenario.group_id}/stop`, {
      method: 'POST',
      body: {},
    })
    const decision = await runFakeExecutorTick(scenario, {})
    assertEqual(decision.action, 'no_eligible_groups', 'stopped group should not launch more work.')

    const diagnostics = await readDiagnostics(scenario)
    const group = firstGroup(diagnostics)
    assertEqual(diagnostics.status, 'blocked', 'stopped group run should block.')
    assertEqual(group.status, 'stopped', 'group should be stopped.')
    assertEqual(group.leases.filter((lease) => lease.status === 'cancelled').length, 2, 'active leases should be cancelled.')
    assertEqual(group.attempts.filter((attempt) => attempt.status === 'cancelled').length, 2, 'active attempts should be cancelled.')
    assertEqual(group.items.filter((item) => item.status === 'stopped').length, 2, 'items should be stopped.')
    return { diagnostics, decision }
  })
}

async function runScenario(
  ctx: RecoveryContext,
  scenarioId: string,
  itemCount: number,
  maxConcurrency: number,
  body: (scenario: ScenarioContext) => Promise<{ diagnostics: RunDiagnostics; decision?: ParallelExecutorDecision }>,
): Promise<ScenarioResult> {
  const scenarioRoot = path.join(ctx.smokeRoot, scenarioId)
  const run_instance_id = `parallel_recovery_${identityTimestamp}_${scenarioId}`
  const group_id = `parallel_group_${scenarioId}`
  const apiPort = await freePort()
  await fs.mkdir(scenarioRoot, { recursive: true })
  const api = startChild(process.execPath, [ctx.apiMain], {
    cwd: ctx.repoRoot,
    env: {
      ...process.env,
      PROTOCOL_RUNNER_API_HOST: '127.0.0.1',
      PROTOCOL_RUNNER_API_PORT: String(apiPort),
      PROTOCOL_RUNNER_RUNS_ROOT: path.join(scenarioRoot, 'runs'),
      PROTOCOL_RUNNER_DB_PATH: path.join(scenarioRoot, 'protocol_runner.sqlite'),
      PROTOCOL_RUNNER_CONTRACT_ROOT: ctx.repoRoot,
      PROTOCOL_RUNNER_ADAPTER_MODE: 'fake',
      PROTOCOL_RUNNER_STORE_MODE: 'sqlite',
      PROTOCOL_RUNNER_NOTIFICATION_ENABLED: 'false',
    },
  })

  try {
    const apiBaseUrl = `http://127.0.0.1:${apiPort}`
    await waitForHealth(`${apiBaseUrl}/health`)
    const workPlan = await writeScenarioFixtures(ctx, scenarioRoot, run_instance_id, group_id, itemCount, maxConcurrency)
    await requestJson(`${apiBaseUrl}/api/runs`, {
      method: 'POST',
      body: { run_instance_id, work_plan: workPlan },
    })
    await requestJson(`${apiBaseUrl}/api/runs/${run_instance_id}/bind`, {
      method: 'POST',
      body: { binding_kind: 'parallel_only' },
    })

    const scenario: ScenarioContext = {
      ...ctx,
      scenarioRoot,
      run_instance_id,
      group_id,
      apiPort,
      apiBaseUrl,
      client: new HttpProtocolRunnerParallelApiClient({ baseUrl: apiBaseUrl, timeoutMs: 30_000 }),
    }
    const result = await body(scenario)
    const group = firstGroup(result.diagnostics)
    return {
      id: scenarioId,
      status: 'passed',
      root: scenarioRoot,
      run_instance_id,
      group_id,
      api_port: apiPort,
      run_status: result.diagnostics.status,
      group_status: group.status,
      ...(result.decision !== undefined ? { decision: result.decision } : {}),
    }
  } catch (error) {
    return {
      id: scenarioId,
      status: 'failed',
      root: scenarioRoot,
      run_instance_id,
      group_id,
      api_port: apiPort,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    await stopChild(api)
    await writeChildLogs(scenarioRoot, 'api', api)
  }
}

async function preflightScenario(scenario: ScenarioContext): Promise<void> {
  await requestJson(`${scenario.apiBaseUrl}/api/runs/${scenario.run_instance_id}/parallel-groups/${scenario.group_id}/preflight`, {
    method: 'POST',
    body: {},
  })
}

async function runFakeExecutorTick(
  scenario: ScenarioContext,
  overrides: Record<string, FakeOverride>,
): Promise<ParallelExecutorDecision> {
  const executor = new ProtocolRunnerParallelExecutor({
    client: scenario.client,
    launcher: new FakeParallelWorkerLauncher({
      executor_id: 'recovery_smoke_executor',
      workspace_root: scenario.repoRoot,
      item_status_overrides: overrides,
    }),
    executor_id: 'recovery_smoke_executor',
    capacity: 2,
    lease_ttl_ms: 10_000,
  })
  return executor.tick()
}

async function readDiagnostics(scenario: ScenarioContext): Promise<RunDiagnostics> {
  const response = await requestJson(`${scenario.apiBaseUrl}/api/runs/${scenario.run_instance_id}/diagnostics`, {
    method: 'GET',
  })
  return response.diagnostics as RunDiagnostics
}

async function writeScenarioFixtures(
  ctx: RecoveryContext,
  scenarioRoot: string,
  run_instance_id: string,
  group_id: string,
  itemCount: number,
  maxConcurrency: number,
): Promise<JsonRecord> {
  const contractPath = path.join(scenarioRoot, 'contract', 'Parallel_Recovery_Smoke_Contract.md')
  const inputsDir = path.join(scenarioRoot, 'inputs')
  const sealedDir = path.join(scenarioRoot, 'sealed_outputs')
  await fs.mkdir(path.dirname(contractPath), { recursive: true })
  await fs.mkdir(inputsDir, { recursive: true })
  await fs.mkdir(sealedDir, { recursive: true })
  await fs.writeFile(contractPath, renderContract(), 'utf8')

  const items: JsonRecord[] = []
  for (let index = 1; index <= itemCount; index += 1) {
    const item_id = `smoke_item_${String(index).padStart(3, '0')}`
    const inputPath = path.join(inputsDir, `${item_id}.md`)
    await fs.writeFile(inputPath, [`# Parallel Recovery Smoke Input: ${item_id}`, '', `item_id: ${item_id}`, ''].join('\n'), 'utf8')
    items.push({
      item_id,
      label: `Recovery smoke item ${index}`,
      input_ref: repoRelative(ctx.repoRoot, inputPath),
    })
  }

  const workPlan = {
    schema_version: 'protocol_runner.work_plan.v1',
    run_title: `Protocol Runner parallel recovery smoke ${run_instance_id}`,
    execution_mode: 'mixed',
    default_contract: {
      title: 'Parallel Recovery Smoke Contract',
      path: repoRelative(ctx.repoRoot, contractPath),
    },
    steps: [
      {
        step_id: `parallel_step_${group_id}`,
        step_kind: 'parallel_group',
        group_id,
        label: `Recovery smoke ${group_id}`,
        executor: 'codex_exec',
        contract_ref: repoRelative(ctx.repoRoot, contractPath),
        max_concurrency: maxConcurrency,
        sealed_output_defaults: {
          base_dir: repoRelative(ctx.repoRoot, sealedDir),
          primary_artifact: 'output.md',
        },
        items,
        on_completed: { action: 'stop' },
        on_blocked: { action: 'pause' },
      },
    ],
  }
  await fs.writeFile(path.join(scenarioRoot, 'work_plan.json'), `${JSON.stringify(workPlan, null, 2)}\n`, 'utf8')
  await fs.writeFile(path.join(scenarioRoot, 'run_identity.json'), `${JSON.stringify({ run_instance_id, group_id }, null, 2)}\n`, 'utf8')
  return workPlan
}

function renderContract(): string {
  return [
    '# Parallel Recovery Smoke Contract',
    '',
    'This fake contract exists only for recovery and control smoke tests.',
    'Workers should write only their assigned sealed output and status report when the fake launcher asks them to complete.',
    'The recovery smoke intentionally injects procedural failures to prove runner state behavior.',
    '',
  ].join('\n')
}

async function assertAttemptResultIncludes(
  diagnostics: RunDiagnostics,
  group: ParallelGroupDiagnostics,
  expected: string,
): Promise<void> {
  const attempt = group.attempts[0]
  if (attempt?.evidence_dir === null || attempt?.evidence_dir === undefined) {
    throw new Error('Attempt evidence_dir missing.')
  }
  const resultPath = path.join(diagnostics.evidence_paths.run_dir, attempt.evidence_dir, 'result.json')
  const body = await fs.readFile(resultPath, 'utf8')
  if (!body.includes(expected)) {
    throw new Error(`${resultPath} did not include ${expected}.`)
  }
}

function firstGroup(diagnostics: RunDiagnostics): ParallelGroupDiagnostics {
  const group = diagnostics.parallel_groups[0]
  if (group === undefined) {
    throw new Error('Diagnostics did not include a parallel group.')
  }
  return group
}

function firstLease(
  envelope: JsonRecord,
): { lease_id: string; attempt_id: string; item_id: string; attempt_dir: string } {
  const leases = envelope.leases
  if (!Array.isArray(leases) || leases.length === 0) {
    throw new Error('Expected at least one lease in API envelope.')
  }
  return leases[0] as { lease_id: string; attempt_id: string; item_id: string; attempt_dir: string }
}

function itemStatus(group: ParallelGroupDiagnostics, item_id: string): string | undefined {
  return group.items.find((item) => item.item_id === item_id)?.status
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message} Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`)
  }
}

function startChild(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): ChildHandle {
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

function repoRelative(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join('/')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function timestampSlug(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}
