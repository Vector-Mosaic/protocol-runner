import { randomBytes } from 'node:crypto'
import { readControlToken } from './client.js'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { promises as fs } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

type LauncherMode = 'fake' | 'codex_exec'
type JsonRecord = Record<string, unknown>

interface SmokeRung {
  id: string
  label: string
  launcher_mode: LauncherMode
  item_count: number
  max_concurrency: number
  executor_capacity: number
  launch_batch_size?: number
  launch_batch_interval_ms?: number
  requires_codex_exec: boolean
}

interface SmokeRungResult {
  id: string
  status: 'passed' | 'failed'
  launcher_mode: LauncherMode
  item_count: number
  max_concurrency: number
  executor_capacity: number
  launch_batch_size?: number
  launch_batch_interval_ms?: number
  run_instance_id: string
  group_id: string
  root: string
  api_port: number
  executor_exit_code: number | null
  run_status?: string
  group_status?: string
  completed_items?: number
  completed_attempts?: number
  sealed_outputs?: string[]
  error?: string
}

interface ChildHandle {
  child: ChildProcessWithoutNullStreams
  stdout: Buffer[]
  stderr: Buffer[]
}

interface RungContext {
  repoRoot: string
  serviceRoot: string
  executorMain: string
  apiMain: string
  smokeRoot: string
}

interface ParallelGroupItemState {
  item_id: string
  status: string
  sealed_output_target: string
}

interface ParallelAttemptState {
  attempt_id: string
  status: string
}

interface ParallelGroupState {
  status: string
  items: ParallelGroupItemState[]
  attempts: ParallelAttemptState[]
}

interface RunDiagnostics {
  status: string
  parallel_groups: ParallelGroupState[]
}

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const serviceRoot = path.resolve(moduleDir, '..')
const repoRoot = path.resolve(serviceRoot, '..', '..')
const timestamp = timestampSlug(new Date())
const identityTimestamp = timestamp.toLowerCase()
const smokeRoot = path.resolve(
  process.env.PROTOCOL_RUNNER_PARALLEL_SMOKE_ROOT?.trim() ||
    path.join(repoRoot, 'artifacts', 'protocol_runner', 'parallel_smoke_ladder', timestamp),
)
const context: RungContext = {
  repoRoot,
  serviceRoot,
  executorMain: path.join(serviceRoot, 'dist', 'main.js'),
  apiMain: path.join(serviceRoot, '..', 'protocol-runner-api', 'dist', 'main.js'),
  smokeRoot,
}

const includeRealTen =
  process.argv.includes('--include-real-10') || process.env.PROTOCOL_RUNNER_PARALLEL_SMOKE_INCLUDE_REAL_10 === '1'
const includeRealThirtyC10 =
  process.argv.includes('--include-real-30-c10') ||
  process.env.PROTOCOL_RUNNER_PARALLEL_SMOKE_INCLUDE_REAL_30_C10 === '1'
const includeRealThirtyC30 =
  process.argv.includes('--include-real-30-c30') ||
  process.env.PROTOCOL_RUNNER_PARALLEL_SMOKE_INCLUDE_REAL_30_C30 === '1'
const includeRealFortyC20 =
  process.argv.includes('--include-real-40-c20') ||
  process.env.PROTOCOL_RUNNER_PARALLEL_SMOKE_INCLUDE_REAL_40_C20 === '1'
const includeRealFiftyC50 =
  process.argv.includes('--include-real-50-c50') ||
  process.env.PROTOCOL_RUNNER_PARALLEL_SMOKE_INCLUDE_REAL_50_C50 === '1'
const rungFilter = readRungFilter(process.argv)
const allRungs: SmokeRung[] = [
  {
    id: 'fake_2',
    label: 'fake executor with 2 items',
    launcher_mode: 'fake',
    item_count: 2,
    max_concurrency: 2,
    executor_capacity: 2,
    requires_codex_exec: false,
  },
  {
    id: 'fake_10_c3',
    label: 'fake executor with 10 items and max_concurrency=3',
    launcher_mode: 'fake',
    item_count: 10,
    max_concurrency: 3,
    executor_capacity: 3,
    requires_codex_exec: false,
  },
  {
    id: 'real_1',
    label: 'real codex exec with 1 item',
    launcher_mode: 'codex_exec',
    item_count: 1,
    max_concurrency: 1,
    executor_capacity: 1,
    requires_codex_exec: true,
  },
  {
    id: 'real_2',
    label: 'real codex exec with 2 parallel items',
    launcher_mode: 'codex_exec',
    item_count: 2,
    max_concurrency: 2,
    executor_capacity: 2,
    requires_codex_exec: true,
  },
  {
    id: 'real_10',
    label: 'real codex exec with 10 items after machine/process behavior review',
    launcher_mode: 'codex_exec',
    item_count: 10,
    max_concurrency: 3,
    executor_capacity: 3,
    requires_codex_exec: true,
  },
  {
    id: 'real_30_c10',
    label: 'real codex exec with 30 items and max_concurrency=10',
    launcher_mode: 'codex_exec',
    item_count: 30,
    max_concurrency: 10,
    executor_capacity: 10,
    requires_codex_exec: true,
  },
  {
    id: 'real_30_c30',
    label: 'real codex exec with 30 items, max_concurrency=30, and launch ramping',
    launcher_mode: 'codex_exec',
    item_count: 30,
    max_concurrency: 30,
    executor_capacity: 30,
    launch_batch_size: 10,
    launch_batch_interval_ms: 15_000,
    requires_codex_exec: true,
  },
  {
    id: 'real_40_c20',
    label: 'real codex exec with 40 items and max_concurrency=20',
    launcher_mode: 'codex_exec',
    item_count: 40,
    max_concurrency: 20,
    executor_capacity: 20,
    requires_codex_exec: true,
  },
  {
    id: 'real_50_c50',
    label: 'real codex exec with 50 items, max_concurrency=50, and launch ramping',
    launcher_mode: 'codex_exec',
    item_count: 50,
    max_concurrency: 50,
    executor_capacity: 50,
    launch_batch_size: 10,
    launch_batch_interval_ms: 15_000,
    requires_codex_exec: true,
  },
]

process.env.PROTOCOL_RUNNER_CONTROL_TOKEN ||= randomBytes(32).toString('hex')

await main()

async function main(): Promise<void> {
  const rungs = allRungs.filter((rung) => {
    if (rung.requires_codex_exec && !process.argv.includes('--live')) return false
    if (rung.id === 'real_10' && !includeRealTen) {
      return false
    }
    if (rung.id === 'real_30_c10' && !includeRealThirtyC10) {
      return false
    }
    if (rung.id === 'real_30_c30' && !includeRealThirtyC30) {
      return false
    }
    if (rung.id === 'real_40_c20' && !includeRealFortyC20) {
      return false
    }
    if (rung.id === 'real_50_c50' && !includeRealFiftyC50) {
      return false
    }
    return rungFilter === null || rungFilter.has(rung.id)
  })
  if (rungs.length === 0) {
    throw new Error('No smoke ladder rungs selected.')
  }

  await fs.mkdir(context.smokeRoot, { recursive: true })
  const results: SmokeRungResult[] = []
  for (const rung of rungs) {
    const result = await runRung(context, rung)
    results.push(result)
    process.stdout.write(`${JSON.stringify({ event: 'smoke_rung_finished', result })}\n`)
    if (result.status === 'failed') {
      break
    }
  }

  const summary = {
    schema_version: 'protocol_runner.parallel_smoke_ladder.v1',
    generated_at: new Date().toISOString(),
    smoke_root: context.smokeRoot,
    include_real_10: includeRealTen,
    include_real_30_c10: includeRealThirtyC10,
    include_real_30_c30: includeRealThirtyC30,
    include_real_40_c20: includeRealFortyC20,
    include_real_50_c50: includeRealFiftyC50,
    selected_rungs: rungs.map((rung) => rung.id),
    passed: results.every((result) => result.status === 'passed') && results.length === rungs.length,
    results,
    note:
      'The larger real-worker rungs are intentionally opt-in because they are workstation/resource proof runs, not default fast verification.',
  }
  await fs.writeFile(path.join(context.smokeRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  if (!summary.passed) {
    process.exitCode = 1
  }
}

async function runRung(ctx: RungContext, rung: SmokeRung): Promise<SmokeRungResult> {
  const rungRoot = path.join(ctx.smokeRoot, rung.id)
  const run_instance_id = `parallel_smoke_${identityTimestamp}_${rung.id}`
  const group_id = `parallel_group_${rung.id}`
  const apiPort = await freePort()
  await fs.mkdir(rungRoot, { recursive: true })
  const api = startChild(process.execPath, [ctx.apiMain], {
    cwd: ctx.repoRoot,
    env: {
      ...process.env,
      PROTOCOL_RUNNER_API_HOST: '127.0.0.1',
      PROTOCOL_RUNNER_API_PORT: String(apiPort),
      PROTOCOL_RUNNER_RUNS_ROOT: path.join(rungRoot, 'runs'),
      PROTOCOL_RUNNER_DB_PATH: path.join(rungRoot, 'protocol_runner.sqlite'),
      PROTOCOL_RUNNER_CONTRACT_ROOT: ctx.repoRoot,
      PROTOCOL_RUNNER_ADAPTER_MODE: 'fake',
      PROTOCOL_RUNNER_STORE_MODE: 'sqlite',
      PROTOCOL_RUNNER_NOTIFICATION_ENABLED: 'false',
    },
  })

  try {
    await waitForHealth(`http://127.0.0.1:${apiPort}/health`)

    const workPlan = await writeRungFixtures(ctx, rung, rungRoot, run_instance_id, group_id)
    await requestJson(`http://127.0.0.1:${apiPort}/api/runs`, {
      method: 'POST',
      body: { run_instance_id, work_plan: workPlan },
    })
    await requestJson(`http://127.0.0.1:${apiPort}/api/runs/${run_instance_id}/bind`, {
      method: 'POST',
      body: { binding_kind: 'parallel_only' },
    })
    await requestJson(`http://127.0.0.1:${apiPort}/api/runs/${run_instance_id}/parallel-groups/${group_id}/preflight`, {
      method: 'POST',
      body: {},
    })

    const executor = await runExecutor(ctx, rung, apiPort, rungRoot)
    const diagnosticsResponse = await requestJson(`http://127.0.0.1:${apiPort}/api/runs/${run_instance_id}/diagnostics`, {
      method: 'GET',
    })
    const diagnostics = diagnosticsResponse.diagnostics as RunDiagnostics
    const group = diagnostics.parallel_groups.find((candidate) => candidate.status === 'completed') ?? diagnostics.parallel_groups[0]
    if (group === undefined) {
      throw new Error('Run diagnostics did not include a parallel group.')
    }
    const sealedOutputs = await verifyRungOutputs(ctx, rung, group)
    const completedItems = group.items.filter((item) => item.status === 'completed').length
    const completedAttempts = group.attempts.filter((attempt) => attempt.status === 'completed').length
    if (diagnostics.status !== 'completed' || group.status !== 'completed') {
      throw new Error(`Expected completed run/group, got run=${diagnostics.status} group=${group.status}.`)
    }
    if (completedItems !== rung.item_count || completedAttempts !== rung.item_count) {
      throw new Error(
        `Expected ${rung.item_count} completed items/attempts, got items=${completedItems} attempts=${completedAttempts}.`,
      )
    }

    return {
      id: rung.id,
      status: 'passed',
      launcher_mode: rung.launcher_mode,
      item_count: rung.item_count,
      max_concurrency: rung.max_concurrency,
      executor_capacity: rung.executor_capacity,
      ...(rung.launch_batch_size !== undefined ? { launch_batch_size: rung.launch_batch_size } : {}),
      ...(rung.launch_batch_interval_ms !== undefined ? { launch_batch_interval_ms: rung.launch_batch_interval_ms } : {}),
      run_instance_id,
      group_id,
      root: rungRoot,
      api_port: apiPort,
      executor_exit_code: executor.exitCode,
      run_status: diagnostics.status,
      group_status: group.status,
      completed_items: completedItems,
      completed_attempts: completedAttempts,
      sealed_outputs: sealedOutputs,
    }
  } catch (error) {
    return {
      id: rung.id,
      status: 'failed',
      launcher_mode: rung.launcher_mode,
      item_count: rung.item_count,
      max_concurrency: rung.max_concurrency,
      executor_capacity: rung.executor_capacity,
      ...(rung.launch_batch_size !== undefined ? { launch_batch_size: rung.launch_batch_size } : {}),
      ...(rung.launch_batch_interval_ms !== undefined ? { launch_batch_interval_ms: rung.launch_batch_interval_ms } : {}),
      run_instance_id,
      group_id,
      root: rungRoot,
      api_port: apiPort,
      executor_exit_code: null,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    await stopChild(api)
    await writeChildLogs(rungRoot, 'api', api)
  }
}

async function writeRungFixtures(
  ctx: RungContext,
  rung: SmokeRung,
  rungRoot: string,
  run_instance_id: string,
  group_id: string,
): Promise<JsonRecord> {
  const contractPath = path.join(rungRoot, 'contract', 'Parallel_Smoke_Contract.md')
  const inputsDir = path.join(rungRoot, 'inputs')
  const sealedDir = path.join(rungRoot, 'sealed_outputs')
  await fs.mkdir(path.dirname(contractPath), { recursive: true })
  await fs.mkdir(inputsDir, { recursive: true })
  await fs.mkdir(sealedDir, { recursive: true })
  await fs.writeFile(contractPath, renderContract(rung), 'utf8')

  const items: JsonRecord[] = []
  for (let index = 1; index <= rung.item_count; index += 1) {
    const item_id = `smoke_item_${String(index).padStart(3, '0')}`
    const inputPath = path.join(inputsDir, `${item_id}.md`)
    await fs.writeFile(
      inputPath,
      [
        `# Parallel Smoke Input: ${item_id}`,
        '',
        `item_id: ${item_id}`,
        'expected_literal: blueberries',
        '',
      ].join('\n'),
      'utf8',
    )
    items.push({
      item_id,
      label: `Smoke item ${index}`,
      input_ref: repoRelative(ctx.repoRoot, inputPath),
    })
  }

  const workPlan = {
    schema_version: 'protocol_runner.work_plan.v1',
    run_title: `Protocol Runner parallel smoke ladder ${rung.id}`,
    execution_mode: 'mixed',
    default_contract: {
      title: 'Parallel Smoke Contract',
      path: repoRelative(ctx.repoRoot, contractPath),
    },
    steps: [
      {
        step_id: `parallel_step_${rung.id}`,
        step_kind: 'parallel_group',
        group_id,
        label: rung.label,
        executor: 'codex_exec',
        contract_ref: repoRelative(ctx.repoRoot, contractPath),
        max_concurrency: rung.max_concurrency,
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
  await fs.writeFile(path.join(rungRoot, 'work_plan.json'), `${JSON.stringify(workPlan, null, 2)}\n`, 'utf8')
  await fs.writeFile(path.join(rungRoot, 'run_identity.json'), `${JSON.stringify({ run_instance_id, group_id }, null, 2)}\n`, 'utf8')
  return workPlan
}

function renderContract(rung: SmokeRung): string {
  return [
    '# Parallel Smoke Contract',
    '',
    'This contract is intentionally rote and obviously batchable. It exists to prove the Protocol Runner keeps each worker item isolated.',
    '',
    'For the one worker-visible item only:',
    '',
    '1. Read the `input_ref` file named in the worker-visible item packet.',
    '2. Confirm the file contains `expected_literal: blueberries`.',
    '3. Write the sealed output at the exact `sealed_output_path` from the invocation.',
    '4. The sealed output must contain exactly one primary proof line in this form:',
    '',
    '```text',
    'PARALLEL_SMOKE_OUTPUT: <item_id>: blueberries',
    '```',
    '',
    'Use the actual worker item id for `<item_id>`.',
    '',
    'Do not process sibling items, infer future work, synthesize, write shared final files, or call the runner API directly.',
    '',
    'Before exiting, write the procedural `status_report.json` at the exact path from the invocation. The report must use `status: "completed"` only after the sealed output is written. If any required file or instruction cannot be followed, use `status: "blocked"` with a short procedural note.',
    '',
    `Smoke rung: ${rung.id}`,
    '',
  ].join('\n')
}

async function runExecutor(
  ctx: RungContext,
  rung: SmokeRung,
  apiPort: number,
  rungRoot: string,
): Promise<{ exitCode: number | null }> {
  const executor = startChild(process.execPath, [ctx.executorMain, '--drain'], {
    cwd: ctx.repoRoot,
    env: {
      ...process.env,
      PROTOCOL_RUNNER_API_URL: `http://127.0.0.1:${apiPort}`,
      PROTOCOL_RUNNER_PARALLEL_EXECUTOR_ID: `smoke_executor_${rung.id}`,
      PROTOCOL_RUNNER_PARALLEL_EXECUTOR_MODE: rung.launcher_mode,
      PROTOCOL_RUNNER_PARALLEL_EXECUTOR_CAPACITY: String(rung.executor_capacity),
      ...(rung.launch_batch_size === undefined
        ? {}
        : { PROTOCOL_RUNNER_PARALLEL_EXECUTOR_LAUNCH_BATCH_SIZE: String(rung.launch_batch_size) }),
      ...(rung.launch_batch_interval_ms === undefined
        ? {}
        : { PROTOCOL_RUNNER_PARALLEL_EXECUTOR_LAUNCH_BATCH_INTERVAL_MS: String(rung.launch_batch_interval_ms) }),
      PROTOCOL_RUNNER_PARALLEL_EXECUTOR_WORKSPACE_ROOT: ctx.repoRoot,
      PROTOCOL_RUNNER_PARALLEL_EXECUTOR_HEALTH_PORT: String(await freePort()),
      PROTOCOL_RUNNER_PARALLEL_EXECUTOR_CODEX_BYPASS_APPROVALS_AND_SANDBOX:
        process.env.PROTOCOL_RUNNER_PARALLEL_EXECUTOR_CODEX_BYPASS_APPROVALS_AND_SANDBOX ?? 'false',
      PROTOCOL_RUNNER_PARALLEL_EXECUTOR_HARD_TIMEOUT_MS:
        process.env.PROTOCOL_RUNNER_PARALLEL_EXECUTOR_HARD_TIMEOUT_MS ?? '1200000',
    },
  })
  const exitCode = await waitForExit(executor.child)
  await writeChildLogs(rungRoot, 'executor', executor)
  if (exitCode !== 0) {
    throw new Error(`Executor exited with code ${exitCode}.`)
  }
  return { exitCode }
}

async function verifyRungOutputs(ctx: RungContext, rung: SmokeRung, group: ParallelGroupState): Promise<string[]> {
  const sealedOutputs: string[] = []
  for (const item of group.items) {
    const outputPath = path.resolve(ctx.repoRoot, item.sealed_output_target)
    const body = await fs.readFile(outputPath, 'utf8')
    if (rung.launcher_mode === 'codex_exec') {
      const expected = `PARALLEL_SMOKE_OUTPUT: ${item.item_id}: blueberries`
      if (!body.includes(expected)) {
        throw new Error(`Sealed output for ${item.item_id} did not contain ${expected}.`)
      }
    } else if (!body.includes(`Fake Parallel Worker Output: ${item.item_id}`)) {
      throw new Error(`Fake sealed output for ${item.item_id} did not contain the fake worker marker.`)
    }
    sealedOutputs.push(outputPath)
  }
  return sealedOutputs
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

function readRungFilter(argv: string[]): Set<string> | null {
  const index = argv.indexOf('--rung')
  if (index < 0) {
    return null
  }
  const value = argv[index + 1]
  if (value === undefined || value.trim().length === 0) {
    throw new Error('--rung requires a comma-separated rung id list.')
  }
  return new Set(value.split(',').map((part) => part.trim()).filter(Boolean))
}
