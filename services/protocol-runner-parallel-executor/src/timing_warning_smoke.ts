import { randomBytes } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { promises as fs } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { HttpProtocolRunnerParallelApiClient, readControlToken } from './client.js'
import { ProtocolRunnerParallelExecutor } from './executor.js'
import { CodexExecWorkerLauncher } from './launcher.js'
import type { ParallelExecutorDecision } from './types.js'

type JsonRecord = Record<string, unknown>

interface ChildHandle {
  child: ChildProcessWithoutNullStreams
  stdout: Buffer[]
  stderr: Buffer[]
}

interface TimingWarningContext {
  repoRoot: string
  serviceRoot: string
  apiMain: string
  smokeRoot: string
}

interface ScenarioContext extends TimingWarningContext {
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
  attempts: Array<{
    attempt_id: string
    item_id: string
    status: string
    evidence_dir: string | null
    warnings: Array<{ code: string; message?: string }>
  }>
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

interface ActiveAttempt {
  attempt_id: string
  lease_id: string
  attempt_dir: string
  process_started_path: string
  result_path: string
}

interface ScenarioResult {
  id: string
  status: 'passed' | 'failed'
  mode: 'progress' | 'quiet'
  root: string
  run_instance_id: string
  group_id: string
  api_port: number
  observed_warning_codes?: string[]
  run_status?: string
  group_status?: string
  decision?: ParallelExecutorDecision
  process_started_path?: string
  result_path?: string
  error?: string
}

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const serviceRoot = path.resolve(moduleDir, '..')
const repoRoot = path.resolve(serviceRoot, '..', '..')
const timestamp = timestampSlug(new Date())
const identityTimestamp = timestamp.toLowerCase()
const smokeRoot = path.resolve(
  process.env.PROTOCOL_RUNNER_PARALLEL_TIMING_WARNING_SMOKE_ROOT?.trim() ||
    path.join(repoRoot, 'artifacts', 'protocol_runner', 'parallel_timing_warning_smoke', timestamp),
)
const context: TimingWarningContext = {
  repoRoot,
  serviceRoot,
  apiMain: path.join(serviceRoot, '..', 'protocol-runner-api', 'dist', 'main.js'),
  smokeRoot,
}

process.env.PROTOCOL_RUNNER_CONTROL_TOKEN ||= randomBytes(32).toString('hex')

await main()

async function main(): Promise<void> {
  await fs.mkdir(context.smokeRoot, { recursive: true })
  const scenarios: Array<(ctx: TimingWarningContext) => Promise<ScenarioResult>> = [
    (ctx) => runTimingScenario(ctx, 'progressing_active_attempt', 'progress', ['long_running'], ['possibly_stalled']),
    (ctx) => runTimingScenario(ctx, 'quiet_active_attempt', 'quiet', ['long_running', 'possibly_stalled'], []),
  ]

  const results: ScenarioResult[] = []
  for (const scenario of scenarios) {
    const result = await scenario(context)
    results.push(result)
    process.stdout.write(`${JSON.stringify({ event: 'timing_warning_smoke_scenario_finished', result })}\n`)
    if (result.status === 'failed') {
      break
    }
  }

  const summary = {
    schema_version: 'protocol_runner.parallel_timing_warning_smoke.v1',
    generated_at: new Date().toISOString(),
    smoke_root: context.smokeRoot,
    passed: results.every((result) => result.status === 'passed') && results.length === scenarios.length,
    results,
    note:
      'This smoke proves non-terminal attempt timing warnings only. It does not judge worker output quality and does not imply completion, retry, advancement, or process termination before explicit cancel.',
  }
  await fs.writeFile(path.join(context.smokeRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  if (!summary.passed) {
    process.exitCode = 1
  }
}

async function runTimingScenario(
  ctx: TimingWarningContext,
  scenarioId: string,
  mode: 'progress' | 'quiet',
  expectedWarningCodes: string[],
  forbiddenWarningCodes: string[],
): Promise<ScenarioResult> {
  return runScenario(ctx, scenarioId, mode, async (scenario) => {
    await preflightScenario(scenario)
    const workerStub = await writeWorkerStub(scenario.scenarioRoot)
    const executor = new ProtocolRunnerParallelExecutor({
      client: scenario.client,
      launcher: new CodexExecWorkerLauncher({
        executor_id: 'timing_warning_smoke_executor',
        workspace_root: scenario.repoRoot,
        codex_command: process.execPath,
        codex_base_args: [workerStub, mode],
      }),
      executor_id: 'timing_warning_smoke_executor',
      capacity: 1,
      lease_ttl_ms: 60_000,
      control_poll_interval_ms: 50,
      long_running_after_ms: 450,
      possibly_stalled_after_ms: 450,
    })

    const tick = executor.tick()
    let active: ActiveAttempt | undefined
    try {
      active = await waitForActiveAttemptProcess(scenario)
      const warningDiagnostics = await waitForWarnings(scenario, expectedWarningCodes, forbiddenWarningCodes)
      const warningGroup = firstGroup(warningDiagnostics)
      const attempt = warningGroup.attempts.find((candidate) => candidate.attempt_id === active?.attempt_id)
      if (attempt === undefined) {
        throw new Error(`${scenarioId} diagnostics lost active attempt ${active.attempt_id}.`)
      }
      assertEqual(warningDiagnostics.status, 'running', `${scenarioId} run should still be running after warnings.`)
      assertEqual(warningGroup.status, 'running', `${scenarioId} group should still be running after warnings.`)
      assertEqual(attempt.status, 'running', `${scenarioId} attempt should still be running after warnings.`)
      assertEqual(
        warningGroup.leases.find((lease) => lease.lease_id === active?.lease_id)?.status,
        'active',
        `${scenarioId} lease should still be active after warnings.`,
      )
      if (await fileExists(active.result_path)) {
        throw new Error(`${scenarioId} result file existed before explicit cancellation.`)
      }

      await cancelAttempt(scenario, active)

      const decision = await tick
      assertEqual(decision.action, 'launched', `${scenarioId} should launch exactly one active child process.`)
      assertEqual(decision.needs_attention_count, 1, `${scenarioId} should end through explicit cancellation.`)

      const finalDiagnostics = await readDiagnostics(scenario)
      const finalGroup = firstGroup(finalDiagnostics)
      assertEqual(finalDiagnostics.status, 'blocked', `${scenarioId} run should block after explicit cancellation.`)
      assertEqual(finalGroup.status, 'needs_attention', `${scenarioId} group should need attention after cancellation.`)
      assertEqual(
        finalGroup.attempts.find((candidate) => candidate.attempt_id === active?.attempt_id)?.status,
        'cancelled',
        `${scenarioId} attempt should be cancelled after explicit cancellation.`,
      )
      await assertFileIncludes(active.result_path, '"launcher_status": "cancelled"')
      await assertFileIncludes(active.result_path, '"kill_reason": "cancelled"')

      return { diagnostics: finalDiagnostics, decision, active, observed_warning_codes: warningCodes(attempt) }
    } catch (error) {
      if (active !== undefined) {
        try {
          await cancelAttempt(scenario, active)
          await Promise.race([tick, sleep(5_000)])
        } catch {
          // Preserve the original assertion failure; cleanup is best effort.
        }
      }
      throw error
    }
  })
}

async function runScenario(
  ctx: TimingWarningContext,
  scenarioId: string,
  mode: 'progress' | 'quiet',
  body: (
    scenario: ScenarioContext,
  ) => Promise<{
    diagnostics: RunDiagnostics
    decision?: ParallelExecutorDecision
    active?: ActiveAttempt
    observed_warning_codes?: string[]
  }>,
): Promise<ScenarioResult> {
  const scenarioRoot = path.join(ctx.smokeRoot, scenarioId)
  const run_instance_id = `parallel_timing_warning_${identityTimestamp}_${scenarioId}`
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
    const workPlan = await writeScenarioFixtures(ctx, scenarioRoot, run_instance_id, group_id)
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
      mode,
      root: scenarioRoot,
      run_instance_id,
      group_id,
      api_port: apiPort,
      observed_warning_codes: result.observed_warning_codes,
      run_status: result.diagnostics.status,
      group_status: group.status,
      ...(result.decision !== undefined ? { decision: result.decision } : {}),
      ...(result.active !== undefined ? { process_started_path: result.active.process_started_path } : {}),
      ...(result.active !== undefined ? { result_path: result.active.result_path } : {}),
    }
  } catch (error) {
    return {
      id: scenarioId,
      status: 'failed',
      mode,
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

async function waitForActiveAttemptProcess(scenario: ScenarioContext): Promise<ActiveAttempt> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const diagnostics = await readDiagnostics(scenario)
    const group = firstGroup(diagnostics)
    const activeLease = group.leases.find((lease) => lease.status === 'active')
    const attempt = group.attempts.find((candidate) => candidate.attempt_id === activeLease?.attempt_id)
    if (activeLease !== undefined && attempt?.evidence_dir !== null && attempt?.evidence_dir !== undefined) {
      const attemptDir = path.join(diagnostics.evidence_paths.run_dir, attempt.evidence_dir)
      const processStartedPath = path.join(attemptDir, 'process_started.json')
      if (await fileExists(processStartedPath)) {
        return {
          attempt_id: activeLease.attempt_id,
          lease_id: activeLease.lease_id,
          attempt_dir: attemptDir,
          process_started_path: processStartedPath,
          result_path: path.join(attemptDir, 'result.json'),
        }
      }
    }
    await sleep(50)
  }
  throw new Error('Timed out waiting for active worker process_started evidence.')
}

async function waitForWarnings(
  scenario: ScenarioContext,
  expectedWarningCodes: string[],
  forbiddenWarningCodes: string[],
): Promise<RunDiagnostics> {
  const deadline = Date.now() + 15_000
  let lastObserved: string[] = []
  while (Date.now() < deadline) {
    const diagnostics = await readDiagnostics(scenario)
    const group = firstGroup(diagnostics)
    const attempt = group.attempts[0]
    if (attempt !== undefined) {
      lastObserved = warningCodes(attempt)
      const hasExpected = expectedWarningCodes.every((code) => lastObserved.includes(code))
      const hasForbidden = forbiddenWarningCodes.some((code) => lastObserved.includes(code))
      if (hasExpected && !hasForbidden) {
        return diagnostics
      }
      if (hasForbidden) {
        throw new Error(`Observed forbidden warning code(s): ${lastObserved.join(', ')}`)
      }
    }
    await sleep(50)
  }
  throw new Error(`Timed out waiting for warnings ${expectedWarningCodes.join(', ')}. Last observed: ${lastObserved.join(', ')}`)
}

async function preflightScenario(scenario: ScenarioContext): Promise<void> {
  await requestJson(`${scenario.apiBaseUrl}/api/runs/${scenario.run_instance_id}/parallel-groups/${scenario.group_id}/preflight`, {
    method: 'POST',
    body: {},
  })
}

async function cancelAttempt(scenario: ScenarioContext, active: ActiveAttempt): Promise<void> {
  await requestJson(
    `${scenario.apiBaseUrl}/api/runs/${scenario.run_instance_id}/parallel-groups/${scenario.group_id}/attempts/${active.attempt_id}/cancel`,
    {
      method: 'POST',
      body: { lease_id: active.lease_id, reason: 'timing warning smoke cancellation' },
    },
  )
}

async function readDiagnostics(scenario: ScenarioContext): Promise<RunDiagnostics> {
  const response = await requestJson(`${scenario.apiBaseUrl}/api/runs/${scenario.run_instance_id}/diagnostics`, {
    method: 'GET',
  })
  return response.diagnostics as RunDiagnostics
}

async function writeScenarioFixtures(
  ctx: TimingWarningContext,
  scenarioRoot: string,
  run_instance_id: string,
  group_id: string,
): Promise<JsonRecord> {
  const contractPath = path.join(scenarioRoot, 'contract', 'Parallel_Timing_Warning_Smoke_Contract.md')
  const inputPath = path.join(scenarioRoot, 'inputs', 'smoke_item_001.md')
  const sealedDir = path.join(scenarioRoot, 'sealed_outputs')
  await fs.mkdir(path.dirname(contractPath), { recursive: true })
  await fs.mkdir(path.dirname(inputPath), { recursive: true })
  await fs.mkdir(sealedDir, { recursive: true })
  await fs.writeFile(contractPath, renderContract(), 'utf8')
  await fs.writeFile(inputPath, ['# Parallel Timing Warning Smoke Input', '', 'item_id: smoke_item_001', ''].join('\n'), 'utf8')

  const workPlan = {
    schema_version: 'protocol_runner.work_plan.v1',
    run_title: `Protocol Runner parallel timing warning smoke ${run_instance_id}`,
    execution_mode: 'mixed',
    default_contract: {
      title: 'Parallel Timing Warning Smoke Contract',
      path: repoRelative(ctx.repoRoot, contractPath),
    },
    steps: [
      {
        step_id: `parallel_step_${group_id}`,
        step_kind: 'parallel_group',
        group_id,
        label: `Timing warning smoke ${group_id}`,
        executor: 'codex_exec',
        contract_ref: repoRelative(ctx.repoRoot, contractPath),
        max_concurrency: 1,
        sealed_output_defaults: {
          base_dir: repoRelative(ctx.repoRoot, sealedDir),
          primary_artifact: 'output.md',
        },
        items: [
          {
            item_id: 'smoke_item_001',
            label: 'Timing warning smoke item 1',
            input_ref: repoRelative(ctx.repoRoot, inputPath),
          },
        ],
        on_completed: { action: 'stop' },
        on_blocked: { action: 'pause' },
      },
    ],
  }
  await fs.writeFile(path.join(scenarioRoot, 'work_plan.json'), `${JSON.stringify(workPlan, null, 2)}\n`, 'utf8')
  await fs.writeFile(path.join(scenarioRoot, 'run_identity.json'), `${JSON.stringify({ run_instance_id, group_id }, null, 2)}\n`, 'utf8')
  return workPlan
}

async function writeWorkerStub(scenarioRoot: string): Promise<string> {
  const workerStubPath = path.join(scenarioRoot, 'scripts', 'timing_worker_stub.mjs')
  await fs.mkdir(path.dirname(workerStubPath), { recursive: true })
  await fs.writeFile(
    workerStubPath,
    [
      "import { promises as fs } from 'node:fs'",
      "import path from 'node:path'",
      '',
      'const args = process.argv.slice(2)',
      "const mode = args[0] || 'quiet'",
      "const outputIndex = args.indexOf('--output-last-message')",
      'const finalMessagePath = outputIndex >= 0 ? args[outputIndex + 1] : undefined',
      "if (!finalMessagePath) { throw new Error('missing --output-last-message') }",
      'const attemptDir = path.dirname(finalMessagePath)',
      'await fs.mkdir(attemptDir, { recursive: true })',
      'await fs.writeFile(path.join(attemptDir, "worker_started.json"), `${JSON.stringify({ mode, started_at: new Date().toISOString() }, null, 2)}\\n`, "utf8")',
      "process.stdin.resume()",
      "process.stdin.on('data', () => {})",
      "if (mode === 'progress') {",
      '  let counter = 0',
      '  setInterval(async () => {',
      '    counter += 1',
      '    await fs.writeFile(path.join(attemptDir, "progress.touch"), `${JSON.stringify({ counter, observed_at: new Date().toISOString() }, null, 2)}\\n`, "utf8")',
      '  }, 75)',
      '}',
      'setInterval(() => {}, 1000)',
      '',
    ].join('\n'),
    'utf8',
  )
  return workerStubPath
}

function renderContract(): string {
  return [
    '# Parallel Timing Warning Smoke Contract',
    '',
    'This smoke contract exists only to prove non-terminal timing warning behavior for active parallel workers.',
    'The smoke intentionally keeps worker processes active until the runner-owned API cancel path is invoked.',
    'The runner must not treat timing warnings as semantic completion, retry authority, group advancement, or implicit process termination.',
    '',
  ].join('\n')
}

async function assertFileIncludes(filePath: string, text: string): Promise<void> {
  const body = await fs.readFile(filePath, 'utf8')
  if (!body.includes(text)) {
    throw new Error(`${filePath} did not include ${text}.`)
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath)
    return stat.isFile()
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

function firstGroup(diagnostics: RunDiagnostics): ParallelGroupDiagnostics {
  const group = diagnostics.parallel_groups[0]
  if (group === undefined) {
    throw new Error('Diagnostics did not include a parallel group.')
  }
  return group
}

function warningCodes(attempt: { warnings: Array<{ code: string }> }): string[] {
  return attempt.warnings.map((warning) => warning.code)
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message} Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`)
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

async function requestJson(url: string, options: { method: 'GET' | 'POST'; body?: JsonRecord }): Promise<JsonRecord> {
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
