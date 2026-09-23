import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, it } from 'node:test'

import {
  GENERIC_STEP_PROMPT_TEMPLATE_ID,
  WORK_PLAN_SCHEMA_VERSION,
  type WorkPlan,
} from '../../../packages/protocol-runner-core/dist/index.js'

import { FakeCodexDesktopAdapter, FakeDiscordRelayAdapter } from './adapters.js'
import { ProtocolRunnerController } from './controller.js'
import { createProtocolRunnerServer } from './server.js'
import { JsonRunnerStore } from './store.js'

interface CliHarness {
  base_url: string
  temp_root: string
  server: Server
}

const tempRoots: string[] = []
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const controlToken = 'test-only-cli-control-token-at-least-32'

function makePlan(): WorkPlan {
  return {
    schema_version: WORK_PLAN_SCHEMA_VERSION,
    run_title: 'Tiny CLI proof',
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
        visible_work_item: { item_id: 'item_001' },
        prompt_template: GENERIC_STEP_PROMPT_TEMPLATE_ID,
        on_completed: { action: 'next' },
        on_blocked: { action: 'pause' },
      },
      {
        step_id: 'derive_item_002',
        step_kind: 'work',
        contract: null,
        planned_step: 'derive item_002 under Contract A',
        visible_work_item: { item_id: 'item_002' },
        prompt_template: GENERIC_STEP_PROMPT_TEMPLATE_ID,
        on_completed: { action: 'stop' },
        on_blocked: { action: 'pause' },
      },
    ],
  }
}

async function startHarness(): Promise<CliHarness> {
  const temp_root = await fs.mkdtemp(path.join(os.tmpdir(), 'protocol-runner-cli-'))
  tempRoots.push(temp_root)
  const runs_root = path.join(temp_root, 'runs')
  await fs.mkdir(runs_root, { recursive: true })
  await fs.mkdir(path.join(temp_root, 'docs', 'contracts'), { recursive: true })
  await fs.writeFile(path.join(temp_root, 'docs', 'contracts', 'Contract_A.md'), '# Contract A\n', 'utf8')
  const controller = new ProtocolRunnerController({
    store: new JsonRunnerStore({ runs_root }),
    desktop_adapter: new FakeCodexDesktopAdapter(),
    relay_adapter: new FakeDiscordRelayAdapter(),
    contract_root: temp_root,
    now: () => new Date('2026-06-25T14:00:00.000Z'),
  })
  const server = createProtocolRunnerServer({ controller, security: { mode: 'test' } })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return {
    base_url: `http://127.0.0.1:${address.port}`,
    temp_root: runs_root,
    server,
  }
}

async function closeHarness(harness: CliHarness): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    harness.server.close((error) => (error === undefined ? resolve() : reject(error)))
  })
}

function runPython(args: string[], input?: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('python', args, {
    cwd: repoRoot,
    env: { ...process.env, PROTOCOL_RUNNER_CONTROL_TOKEN: controlToken },
    encoding: 'utf8',
    input,
  })
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

async function runPythonAsync(
  args: string[],
  input?: string,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('python', args, {
      cwd: repoRoot,
      env: { ...process.env, PROTOCOL_RUNNER_CONTROL_TOKEN: controlToken },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (status) => {
      resolve({ status, stdout, stderr })
    })

    if (input !== undefined) {
      child.stdin.write(input)
    }
    child.stdin.end()
  })
}

function parseJson(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>
}

function record(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, 'object')
  assert.notEqual(value, null)
  assert.equal(Array.isArray(value), false)
  return value as Record<string, unknown>
}

function responseOf(payload: Record<string, unknown>): Record<string, unknown> {
  return record(record(payload.data).response)
}

function stateOf(payload: Record<string, unknown>): Record<string, unknown> {
  return record(record(responseOf(payload).run).state)
}

function startPayload(run_instance_id: string, payload: Record<string, unknown>): Record<string, string> {
  const pending = record(stateOf(payload).pending_start_report)
  return {
    run_instance_id,
    step_id: String(pending.step_id),
    prompt_attempt_id: String(pending.prompt_attempt_id),
    start_token: String(pending.start_token),
  }
}

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true })
  }
})

describe('protocol runner CLI wrappers', () => {
  it('expose zero-risk usage handshakes', () => {
    const mainNoArgs = runPython(['scripts/tools/protocol_runner.py'])
    assert.equal(mainNoArgs.status, 0, mainNoArgs.stderr)
    assert.match(mainNoArgs.stdout, /safe first calls/)

    const mainUsage = runPython(['scripts/tools/protocol_runner.py', 'usage', '--format', 'json'])
    assert.equal(mainUsage.status, 0, mainUsage.stderr)
    assert.equal(parseJson(mainUsage.stdout).tool_id, 'tool.workstation_control.protocol_runner')

    const returnNoArgs = runPython(['scripts/tools/protocol_runner_return.py'])
    assert.equal(returnNoArgs.status, 0, returnNoArgs.stderr)
    assert.match(returnNoArgs.stdout, /safe first calls/)

    const returnUsage = runPython(['scripts/tools/protocol_runner_return.py', 'usage', '--format', 'json'])
    assert.equal(returnUsage.status, 0, returnUsage.stderr)
    assert.equal(parseJson(returnUsage.stdout).tool_id, 'tool.workstation_control.protocol_runner_return')

    const stepStartNoArgs = runPython(['scripts/tools/protocol_runner_step_start.py'])
    assert.equal(stepStartNoArgs.status, 0, stepStartNoArgs.stderr)
    assert.match(stepStartNoArgs.stdout, /safe first calls/)

    const stepStartUsage = runPython(['scripts/tools/protocol_runner_step_start.py', 'usage', '--format', 'json'])
    assert.equal(stepStartUsage.status, 0, stepStartUsage.stderr)
    assert.equal(parseJson(stepStartUsage.stdout).tool_id, 'tool.workstation_control.protocol_runner_step_start')
  })

  it('operates and troubleshoots a fake local run end to end', async () => {
    const harness = await startHarness()
    try {
      const workPlanPath = path.join(harness.temp_root, 'work_plan.json')
      await fs.writeFile(workPlanPath, `${JSON.stringify(makePlan(), null, 2)}\n`, 'utf8')

      const doctor = await runPythonAsync([
        'scripts/tools/protocol_runner.py',
        'doctor',
        '--base-url',
        harness.base_url,
        '--format',
        'json',
      ])
      assert.equal(doctor.status, 0, doctor.stderr)
      assert.equal(record(responseOf(parseJson(doctor.stdout)).health).ok, true)

      const created = await runPythonAsync([
        'scripts/tools/protocol_runner.py',
        'create',
        '--base-url',
        harness.base_url,
        '--work-plan',
        workPlanPath,
        '--run-instance-id',
        'run_cli_loop',
        '--auto-pickup',
        '--format',
        'json',
      ])
      assert.equal(created.status, 0, created.stderr)
      assert.equal(stateOf(parseJson(created.stdout)).status, 'draft')

      const bound = await runPythonAsync([
        'scripts/tools/protocol_runner.py',
        'bind',
        '--base-url',
        harness.base_url,
        '--run-instance-id',
        'run_cli_loop',
        '--binding-kind',
        'serial_desktop',
        '--visible-thread-label',
        'cli-thread',
        '--format',
        'json',
      ])
      assert.equal(bound.status, 0, bound.stderr)
      assert.equal(stateOf(parseJson(bound.stdout)).status, 'bound')

      const firstStart = await runPythonAsync([
        'scripts/tools/protocol_runner.py',
        'start',
        '--base-url',
        harness.base_url,
        '--run-instance-id',
        'run_cli_loop',
        '--format',
        'json',
      ])
      assert.equal(firstStart.status, 0, firstStart.stderr)
      const firstStartPayload = parseJson(firstStart.stdout)
      assert.equal(stateOf(firstStartPayload).status, 'waiting_for_start_report')

      const firstPrompt = await runPythonAsync([
        'scripts/tools/protocol_runner.py',
        'show-prompt',
        '--base-url',
        harness.base_url,
        '--run-instance-id',
        'run_cli_loop',
      ])
      assert.equal(firstPrompt.status, 0, firstPrompt.stderr)
      assert.match(firstPrompt.stdout, /derive item_001 under Contract A/)

      const firstStepStartPayload = startPayload('run_cli_loop', firstStartPayload)
      const firstStepStart = await runPythonAsync([
        'scripts/tools/protocol_runner_step_start.py',
        '--base-url',
        harness.base_url,
        '--run-instance-id',
        'run_cli_loop',
        '--step-id',
        firstStepStartPayload.step_id,
        '--prompt-attempt-id',
        firstStepStartPayload.prompt_attempt_id,
        '--start-token',
        firstStepStartPayload.start_token,
        '--format',
        'json',
      ])
      assert.equal(firstStepStart.status, 0, firstStepStart.stderr)
      assert.equal(stateOf(parseJson(firstStepStart.stdout)).status, 'waiting_for_completion_report')

      const firstStartReceipt = await runPythonAsync([
        'scripts/tools/protocol_runner.py',
        'show-start',
        '--base-url',
        harness.base_url,
        '--run-instance-id',
        'run_cli_loop',
      ])
      assert.equal(firstStartReceipt.status, 0, firstStartReceipt.stderr)
      assert.match(firstStartReceipt.stdout, /"prompt_attempt_id": "attempt_001"/)

      const firstReturn = await runPythonAsync([
        'scripts/tools/protocol_runner_return.py',
        '--base-url',
        harness.base_url,
        '--run-instance-id',
        'run_cli_loop',
        '--step-id',
        'derive_item_001',
        '--status',
        'completed',
        '--summary',
        'cli completion',
        '--format',
        'json',
      ])
      assert.equal(firstReturn.status, 0, firstReturn.stderr)
      assert.equal(stateOf(parseJson(firstReturn.stdout)).status, 'ready')
      assert.equal(stateOf(parseJson(firstReturn.stdout)).current_step_id, 'derive_item_002')

      const secondStart = await runPythonAsync([
        'scripts/tools/protocol_runner.py',
        'start',
        '--base-url',
        harness.base_url,
        '--run-instance-id',
        'run_cli_loop',
        '--format',
        'json',
      ])
      assert.equal(secondStart.status, 0, secondStart.stderr)
      const secondStartPayload = parseJson(secondStart.stdout)
      assert.equal(stateOf(secondStartPayload).status, 'waiting_for_start_report')

      const secondStepStartPayload = startPayload('run_cli_loop', secondStartPayload)
      const secondStepStart = await runPythonAsync([
        'scripts/tools/protocol_runner_step_start.py',
        '--base-url',
        harness.base_url,
        '--run-instance-id',
        'run_cli_loop',
        '--step-id',
        secondStepStartPayload.step_id,
        '--prompt-attempt-id',
        secondStepStartPayload.prompt_attempt_id,
        '--start-token',
        secondStepStartPayload.start_token,
        '--format',
        'json',
      ])
      assert.equal(secondStepStart.status, 0, secondStepStart.stderr)
      assert.equal(stateOf(parseJson(secondStepStart.stdout)).status, 'waiting_for_completion_report')

      const secondReturn = await runPythonAsync([
        'scripts/tools/protocol_runner_return.py',
        '--base-url',
        harness.base_url,
        '--run-instance-id',
        'run_cli_loop',
        '--step-id',
        'derive_item_002',
        '--status',
        'completed',
        '--summary',
        'cli completion',
        '--format',
        'json',
      ])
      assert.equal(secondReturn.status, 0, secondReturn.stderr)
      assert.equal(stateOf(parseJson(secondReturn.stdout)).status, 'completed')

      const diagnose = await runPythonAsync([
        'scripts/tools/protocol_runner.py',
        'diagnose',
        '--base-url',
        harness.base_url,
        '--run-instance-id',
        'run_cli_loop',
      ])
      assert.equal(diagnose.status, 0, diagnose.stderr)
      assert.match(diagnose.stdout, /status=completed/)
      assert.match(diagnose.stdout, /latest_files:/)

      const events = await runPythonAsync([
        'scripts/tools/protocol_runner.py',
        'tail',
        '--base-url',
        harness.base_url,
        '--run-instance-id',
        'run_cli_loop',
        '--limit',
        '5',
      ])
      assert.equal(events.status, 0, events.stderr)
      assert.match(events.stdout, /state_changed/)

      const latestStatus = await runPythonAsync([
        'scripts/tools/protocol_runner.py',
        'show-status',
        '--base-url',
        harness.base_url,
        '--run-instance-id',
        'run_cli_loop',
      ])
      assert.equal(latestStatus.status, 0, latestStatus.stderr)
      assert.match(latestStatus.stdout, /"step_id": "derive_item_002"/)

      const closed = await runPythonAsync([
        'scripts/tools/protocol_runner.py',
        'close',
        '--base-url',
        harness.base_url,
        '--run-instance-id',
        'run_cli_loop',
        '--delete-sealed-outputs',
        '--format',
        'json',
      ])
      assert.equal(closed.status, 0, closed.stderr)
      const closeout = record(responseOf(parseJson(closed.stdout)).closeout)
      assert.equal(closeout.run_instance_id, 'run_cli_loop')
      assert.equal(record(closeout.artifact_cleanup).deleted, true)
      assert.equal(record(closeout.sealed_output_cleanup).requested, true)
      assert.equal(record(closeout.sealed_output_cleanup).target_count, 0)
      assert.equal(closeout.relay_cleanup === null || typeof closeout.relay_cleanup === 'object', true)
    } finally {
      await closeHarness(harness)
    }
  })

  it('fails, closes, and recreates an unused draft through the CLI', async () => {
    const harness = await startHarness()
    try {
      const workPlanPath = path.join(harness.temp_root, 'draft_cleanup_work_plan.json')
      await fs.writeFile(workPlanPath, `${JSON.stringify(makePlan(), null, 2)}\n`, 'utf8')
      const create = () =>
        runPythonAsync([
          'scripts/tools/protocol_runner.py',
          'create',
          '--base-url',
          harness.base_url,
          '--work-plan',
          workPlanPath,
          '--run-instance-id',
          'run_cli_draft_cleanup',
          '--format',
          'json',
        ])

      const created = await create()
      assert.equal(created.status, 0, created.stderr)
      assert.equal(stateOf(parseJson(created.stdout)).status, 'draft')

      const failed = await runPythonAsync([
        'scripts/tools/protocol_runner.py',
        'fail',
        '--base-url',
        harness.base_url,
        '--run-instance-id',
        'run_cli_draft_cleanup',
        '--reason',
        'discard unused draft',
        '--format',
        'json',
      ])
      assert.equal(failed.status, 0, failed.stderr)
      assert.equal(stateOf(parseJson(failed.stdout)).status, 'failed')

      const closed = await runPythonAsync([
        'scripts/tools/protocol_runner.py',
        'close',
        '--base-url',
        harness.base_url,
        '--run-instance-id',
        'run_cli_draft_cleanup',
        '--format',
        'json',
      ])
      assert.equal(closed.status, 0, closed.stderr)
      assert.equal(record(responseOf(parseJson(closed.stdout)).closeout).run_instance_id, 'run_cli_draft_cleanup')

      const recreated = await create()
      assert.equal(recreated.status, 0, recreated.stderr)
      assert.equal(stateOf(parseJson(recreated.stdout)).status, 'draft')

      await runPythonAsync([
        'scripts/tools/protocol_runner.py',
        'fail',
        '--base-url',
        harness.base_url,
        '--run-instance-id',
        'run_cli_draft_cleanup',
        '--reason',
        'test cleanup',
      ])
      await runPythonAsync([
        'scripts/tools/protocol_runner.py',
        'close',
        '--base-url',
        harness.base_url,
        '--run-instance-id',
        'run_cli_draft_cleanup',
      ])
    } finally {
      await closeHarness(harness)
    }
  })
})
