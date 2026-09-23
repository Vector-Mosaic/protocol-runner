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

interface ProcessControlContext {
  repoRoot: string
  serviceRoot: string
  apiMain: string
  smokeRoot: string
  codexCommand: string
}

interface ScenarioContext extends ProcessControlContext {
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

interface ActiveAttempt {
  attempt_id: string
  lease_id: string
  attempt_dir: string
  process_started_path: string
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
  process_started_path?: string
  process_path?: string
  result_path?: string
  error?: string
}

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const serviceRoot = path.resolve(moduleDir, '..')
const repoRoot = path.resolve(serviceRoot, '..', '..')
const timestamp = timestampSlug(new Date())
const identityTimestamp = timestamp.toLowerCase()
const smokeRoot = path.resolve(
  process.env.PROTOCOL_RUNNER_PARALLEL_PROCESS_CONTROL_SMOKE_ROOT?.trim() ||
    path.join(repoRoot, 'artifacts', 'protocol_runner', 'parallel_process_control_smoke', timestamp),
)
const context: ProcessControlContext = {
  repoRoot,
  serviceRoot,
  apiMain: path.join(serviceRoot, '..', 'protocol-runner-api', 'dist', 'main.js'),
  smokeRoot,
  codexCommand:
    process.env.PROTOCOL_RUNNER_PARALLEL_PROCESS_CONTROL_SMOKE_CODEX_COMMAND?.trim() ||
    process.env.PROTOCOL_RUNNER_PARALLEL_EXECUTOR_CODEX_COMMAND?.trim() ||
    'codex',
}

process.env.PROTOCOL_RUNNER_CONTROL_TOKEN ||= randomBytes(32).toString('hex')

await main()

async function main(): Promise<void> {
  if (!process.argv.includes('--live')) throw new Error('This smoke launches real Codex workers. Pass --live explicitly.')
  await fs.mkdir(context.smokeRoot, { recursive: true })
  const scenarios: Array<(ctx: ProcessControlContext) => Promise<ScenarioResult>> = [
    (ctx) => runControlScenario(ctx, 'cancel_active_attempt', 'cancel'),
    (ctx) => runControlScenario(ctx, 'stop_active_group', 'stop'),
  ]

  const results: ScenarioResult[] = []
  for (const scenario of scenarios) {
    const result = await scenario(context)
    results.push(result)
    process.stdout.write(`${JSON.stringify({ event: 'process_control_smoke_scenario_finished', result })}\n`)
    if (result.status === 'failed') {
      break
    }
  }

  const summary = {
    schema_version: 'protocol_runner.parallel_process_control_smoke.v1',
    generated_at: new Date().toISOString(),
    smoke_root: context.smokeRoot,
    codex_command: context.codexCommand,
    passed: results.every((result) => result.status === 'passed') && results.length === scenarios.length,
    results,
    note:
      'This smoke proves launcher-level process termination after API-owned cancel/stop state is observed. It does not judge worker output quality.',
  }
  await fs.writeFile(path.join(context.smokeRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  if (!summary.passed) {
    process.exitCode = 1
  }
}

async function runControlScenario(
  ctx: ProcessControlContext,
  scenarioId: string,
  action: 'cancel' | 'stop',
): Promise<ScenarioResult> {
  return runScenario(ctx, scenarioId, async (scenario) => {
    await preflightScenario(scenario)
    const executor = new ProtocolRunnerParallelExecutor({
      client: scenario.client,
      launcher: new CodexExecWorkerLauncher({
        executor_id: 'process_control_smoke_executor',
        workspace_root: scenario.repoRoot,
        codex_command: scenario.codexCommand,
        codex_base_args: [],
        sandbox: process.env.PROTOCOL_RUNNER_PARALLEL_EXECUTOR_CODEX_SANDBOX?.trim() || 'workspace-write',
      }),
      executor_id: 'process_control_smoke_executor',
      capacity: 1,
      lease_ttl_ms: 60_000,
      control_poll_interval_ms: 25,
    })
    const tick = executor.tick()
    const active = await waitForActiveAttemptProcess(scenario)

    if (action === 'cancel') {
      await requestJson(
        `${scenario.apiBaseUrl}/api/runs/${scenario.run_instance_id}/parallel-groups/${scenario.group_id}/attempts/${active.attempt_id}/cancel`,
        {
          method: 'POST',
          body: { lease_id: active.lease_id, reason: 'process control smoke cancellation' },
        },
      )
    } else {
      await requestJson(`${scenario.apiBaseUrl}/api/runs/${scenario.run_instance_id}/parallel-groups/${scenario.group_id}/stop`, {
        method: 'POST',
        body: {},
      })
    }

    const decision = await tick
    assertEqual(decision.action, 'launched', `${scenarioId} should launch exactly one child process.`)
    assertEqual(decision.needs_attention_count, 1, `${scenarioId} should report one non-completed launch outcome.`)

    const diagnostics = await readDiagnostics(scenario)
    const group = firstGroup(diagnostics)
    if (action === 'cancel') {
      assertEqual(diagnostics.status, 'blocked', `${scenarioId} run should block.`)
      assertEqual(group.status, 'needs_attention', `${scenarioId} group should need attention.`)
      assertEqual(group.leases[0]?.status, 'cancelled', `${scenarioId} lease should be cancelled.`)
      assertEqual(group.attempts[0]?.status, 'cancelled', `${scenarioId} attempt should be cancelled.`)
      assertEqual(group.items[0]?.status, 'needs_recovery', `${scenarioId} item should need recovery.`)
    } else {
      assertEqual(diagnostics.status, 'blocked', `${scenarioId} run should block.`)
      assertEqual(group.status, 'stopped', `${scenarioId} group should be stopped.`)
      assertEqual(group.leases[0]?.status, 'cancelled', `${scenarioId} lease should be cancelled.`)
      assertEqual(group.attempts[0]?.status, 'cancelled', `${scenarioId} attempt should be cancelled.`)
      assertEqual(group.items[0]?.status, 'stopped', `${scenarioId} item should be stopped.`)
    }

    const processPath = path.join(active.attempt_dir, 'process.json')
    const resultPath = path.join(active.attempt_dir, 'result.json')
    await assertFileIncludes(active.process_started_path, '"pid"')
    await assertFileIncludes(processPath, '"killed_by_runner": true')
    await assertFileIncludes(processPath, '"kill_reason": "cancelled"')
    await assertFileIncludes(resultPath, '"launcher_status": "cancelled"')
    await assertFileIncludes(resultPath, '"kill_reason": "cancelled"')
    return { diagnostics, decision, active, processPath, resultPath }
  })
}

async function runScenario(
  ctx: ProcessControlContext,
  scenarioId: string,
  body: (
    scenario: ScenarioContext,
  ) => Promise<{
    diagnostics: RunDiagnostics
    decision?: ParallelExecutorDecision
    active?: ActiveAttempt
    processPath?: string
    resultPath?: string
  }>,
): Promise<ScenarioResult> {
  const scenarioRoot = path.join(ctx.smokeRoot, scenarioId)
  const run_instance_id = `parallel_process_control_${identityTimestamp}_${scenarioId}`
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
      root: scenarioRoot,
      run_instance_id,
      group_id,
      api_port: apiPort,
      run_status: result.diagnostics.status,
      group_status: group.status,
      ...(result.decision !== undefined ? { decision: result.decision } : {}),
      ...(result.active !== undefined ? { process_started_path: result.active.process_started_path } : {}),
      ...(result.processPath !== undefined ? { process_path: result.processPath } : {}),
      ...(result.resultPath !== undefined ? { result_path: result.resultPath } : {}),
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
        }
      }
    }
    await sleep(50)
  }
  throw new Error('Timed out waiting for active worker process_started evidence.')
}

async function preflightScenario(scenario: ScenarioContext): Promise<void> {
  await requestJson(`${scenario.apiBaseUrl}/api/runs/${scenario.run_instance_id}/parallel-groups/${scenario.group_id}/preflight`, {
    method: 'POST',
    body: {},
  })
}

async function readDiagnostics(scenario: ScenarioContext): Promise<RunDiagnostics> {
  const response = await requestJson(`${scenario.apiBaseUrl}/api/runs/${scenario.run_instance_id}/diagnostics`, {
    method: 'GET',
  })
  return response.diagnostics as RunDiagnostics
}

async function writeScenarioFixtures(
  ctx: ProcessControlContext,
  scenarioRoot: string,
  run_instance_id: string,
  group_id: string,
): Promise<JsonRecord> {
  const contractPath = path.join(scenarioRoot, 'contract', 'Parallel_Process_Control_Smoke_Contract.md')
  const inputPath = path.join(scenarioRoot, 'inputs', 'smoke_item_001.md')
  const sealedDir = path.join(scenarioRoot, 'sealed_outputs')
  await fs.mkdir(path.dirname(contractPath), { recursive: true })
  await fs.mkdir(path.dirname(inputPath), { recursive: true })
  await fs.mkdir(sealedDir, { recursive: true })
  await fs.writeFile(contractPath, renderContract(), 'utf8')
  await fs.writeFile(inputPath, ['# Parallel Process Control Smoke Input', '', 'item_id: smoke_item_001', ''].join('\n'), 'utf8')

  const workPlan = {
    schema_version: 'protocol_runner.work_plan.v1',
    run_title: `Protocol Runner parallel process control smoke ${run_instance_id}`,
    execution_mode: 'mixed',
    default_contract: {
      title: 'Parallel Process Control Smoke Contract',
      path: repoRelative(ctx.repoRoot, contractPath),
    },
    steps: [
      {
        step_id: `parallel_step_${group_id}`,
        step_kind: 'parallel_group',
        group_id,
        label: `Process control smoke ${group_id}`,
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
            label: 'Process control smoke item 1',
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

function renderContract(): string {
  return [
    '# Parallel Process Control Smoke Contract',
    '',
    'This smoke contract exists only to prove that active launcher child processes can be cancelled or stopped through API-owned runner state.',
    'If allowed to run to completion, a worker would write only its assigned sealed output and status report.',
    'The smoke cancels or stops the worker before semantic work is evaluated.',
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
