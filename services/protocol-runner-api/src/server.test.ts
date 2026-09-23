import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { Server } from 'node:http'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, it } from 'node:test'

import {
  GENERIC_STEP_PROMPT_TEMPLATE_ID,
  WORK_PLAN_SCHEMA_VERSION,
  type WorkPlan,
  type SerialReportCommands,
} from '../../../packages/protocol-runner-core/dist/index.js'

import {
  FakeCodexDesktopAdapter,
  FakeDiscordRelayAdapter,
  type PromptSendResult,
  type SendPromptInput,
} from './adapters.js'
import { ProtocolRunnerController } from './controller.js'
import { readProtocolRunnerApiConfig } from './config.js'
import type { RunnerAttentionNotification } from './run-notifier.js'
import { createProtocolRunnerServer } from './server.js'
import { HybridRunnerStore, JsonRunnerStore, SqliteRunnerStore } from './store.js'

interface ApiHarness {
  base_url: string
  temp_root: string
  contract_root: string
  server: Server
  desktop_adapter: FakeCodexDesktopAdapter
  relay_adapter: FakeDiscordRelayAdapter
  notifications: RunnerAttentionNotification[]
  request(method: string, pathname: string, body?: unknown): Promise<{ status: number; body: unknown; text: string }>
}

const tempRoots: string[] = []
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

interface TestRunEnvelope {
  run: {
    state: {
      status: string
      current_step_id: string | null
      blocked_reason?: string
      pending_start_report?: {
        step_id: string
        prompt_attempt_id: string
        start_token: string
      }
      thread_binding?: {
        binding_kind?: string
        visible_thread_label?: string
        relay_channel_name?: string
      } | null
    }
  }
  attempt?: number
  prompt_file?: {
    relative_path: string
  }
  start_file?: {
    relative_path: string
  }
  transition?: {
    action: string
  }
}

interface TestEventsEnvelope {
  events: Array<{
    event_type: string
  }>
}

interface TestDiagnosticsEnvelope {
  diagnostics: {
    status: string
    parallel_groups: Array<{
      group_id: string
      status: string
      preflight_status: string
    }>
    latest_files: {
      prompt: string
    }
    evidence_paths: {
      run_dir: string
    }
    next_allowed_actions: Array<{
      action: string
      enabled: boolean
    }>
  }
}

interface TestValidationEnvelope {
  validation: {
    ok: boolean
    issues: Array<{
      code: string
      path: string
      message: string
    }>
    state: {
      status: string
    }
  }
}

interface TestCloseoutEnvelope {
  closeout: {
    run_instance_id: string
    relay_cleanup: {
      ok: boolean
      channel_id: string | null
      cleanup_state: string
    } | null
    artifact_cleanup: {
      ok: boolean
      deleted: boolean
      run_dir: string
    }
    sealed_output_cleanup: {
      requested: boolean
      target_count: number
      deleted_files: number
      missing_files: number
      deleted_empty_dirs: number
      targets: Array<{
        item_id: string
        path: string
        deleted: boolean
        missing: boolean
      }>
    }
  }
}

interface TestParallelPreflightEnvelope {
  run: {
    state: {
      status: string
      current_step_id: string | null
      blocked_reason?: string
    }
  }
  group: {
    group_id: string
    status: string
    preflight_status: string
    required_worker_capabilities?: string[]
    items: Array<{
      item_id: string
      status: string
    }>
    attempts: Array<{
      attempt_id: string
      item_id: string
      status: string
      warnings: Array<{ code: string }>
    }>
    leases: Array<{
      lease_id: string
      attempt_id: string
      item_id: string
      status: string
      expires_at: string | null
      heartbeat_at: string | null
    }>
  }
  preflight: {
    passed: boolean
    preflight_status: string
    launchable_item_count: number
    checks: Array<{
      code: string
      message: string
      details?: Record<string, unknown>
    }>
    errors: Array<{
      code: string
      message: string
      details?: Record<string, unknown>
    }>
    executor_summary?: Record<string, unknown>
    evidence_file?: {
      path: string
      relative_path: string
    }
  }
  leases?: Array<{
    lease_id: string
    attempt_id: string
    item_id: string
    sealed_output_path: string
    run_dir: string
    attempt_dir: string
    leased_at: string
    expires_at: string | null
    variables: Record<string, unknown>
  }>
  lease?: {
    lease_id: string
    attempt_id: string
    item_id: string
    heartbeat_at: string | null
  }
  attempt?: {
    attempt_id: string
    status: string
  }
  previous_attempt_id?: string | null
  recovered_count?: number
  stale_lease_ids?: string[]
  stale_attempt_ids?: string[]
  stale_item_ids?: string[]
  requeued_lease_ids?: string[]
  requeued_attempt_ids?: string[]
  requeued_item_ids?: string[]
  attention_lease_ids?: string[]
  attention_attempt_ids?: string[]
  attention_item_ids?: string[]
}

class DeferredFakeCodexDesktopAdapter extends FakeCodexDesktopAdapter {
  private releaseSend: (() => void) | null = null
  private readonly sendGate = new Promise<void>((resolve) => {
    this.releaseSend = resolve
  })

  release(): void {
    this.releaseSend?.()
    this.releaseSend = null
  }

  override async sendPrompt(input: SendPromptInput): Promise<PromptSendResult> {
    await this.sendGate
    return super.sendPrompt(input)
  }
}

function bodyAs<T>(response: { body: unknown }): T {
  return response.body as T
}

function makePlan(): WorkPlan {
  return {
    schema_version: WORK_PLAN_SCHEMA_VERSION,
    run_title: 'Tiny API proof',
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
        },
        prompt_template: GENERIC_STEP_PROMPT_TEMPLATE_ID,
        on_completed: { action: 'next' },
        on_blocked: { action: 'pause' },
      },
      {
        step_id: 'derive_item_002',
        step_kind: 'work',
        contract: null,
        planned_step: 'derive item_002 under Contract A',
        visible_work_item: {
          item_id: 'item_002',
        },
        prompt_template: GENERIC_STEP_PROMPT_TEMPLATE_ID,
        on_completed: { action: 'stop' },
        on_blocked: { action: 'pause' },
      },
    ],
  }
}

function makeMissingContractPlan(): WorkPlan {
  return {
    ...makePlan(),
    default_contract: {
      title: 'Missing Contract',
      path: 'docs/contracts/Missing.md',
    },
  }
}

function makeParallelFirstPlan(
  sealedOutputBaseDir = 'artifacts/protocol_runner/sealed_outputs/run_parallel_first/groups/nodes_001_002/items',
): WorkPlan {
  return {
    schema_version: WORK_PLAN_SCHEMA_VERSION,
    run_title: 'Parallel first proof',
    execution_mode: 'mixed',
    default_contract: {
      title: 'Contract A',
      path: 'docs/contracts/Contract_A.md',
    },
    steps: [
      {
        step_id: 'derive_nodes_parallel',
        step_kind: 'parallel_group',
        group_id: 'nodes_001_002',
        executor: 'codex_exec',
        contract_ref: 'docs/contracts/Contract_A.md',
        max_concurrency: 2,
        required_worker_capabilities: ['json_transform'],
        sealed_output_defaults: {
          base_dir: sealedOutputBaseDir,
          primary_artifact: 'output.md',
        },
        items: [
          {
            item_id: 'node_001',
            input_ref: 'docs/items.md#node_001',
            variables: {
              selector: 'node_001',
              nested: { preserve: true },
              ordinal: 1,
            },
          },
          {
            item_id: 'node_002',
            input_ref: 'docs/items.md#node_002',
          },
        ],
        on_completed: { action: 'stop' },
        on_blocked: { action: 'pause' },
      },
    ],
  }
}

function makeParallelThenSerialPlan(): WorkPlan {
  const plan = makeParallelFirstPlan()
  const step = plan.steps[0]
  if (step.step_kind !== 'parallel_group') {
    throw new Error('fixture parallel step missing')
  }

  return {
    ...plan,
    run_title: 'Parallel then serial proof',
    steps: [
      {
        ...step,
        on_completed: { action: 'next' },
      },
      {
        step_id: 'summarize_after_parallel',
        step_kind: 'work',
        contract: null,
        planned_step: 'summarize the sealed outputs after the parallel group',
        visible_work_item: {
          item_id: 'parallel_summary',
        },
        prompt_template: GENERIC_STEP_PROMPT_TEMPLATE_ID,
        on_completed: { action: 'stop' },
        on_blocked: { action: 'pause' },
      },
    ],
  }
}

function makeSerialThenParallelPlan(): WorkPlan {
  const serialPlan = makePlan()
  const parallelPlan = makeParallelFirstPlan()
  const parallelStep = parallelPlan.steps[0]
  if (parallelStep.step_kind !== 'parallel_group') {
    throw new Error('fixture parallel step missing')
  }

  return {
    ...parallelPlan,
    run_title: 'Serial then parallel proof',
    steps: [
      {
        ...serialPlan.steps[0],
        on_completed: { action: 'next' },
      },
      parallelStep,
    ],
  }
}

function parallelFirstOutputPath(harness: ApiHarness, itemId: string): string {
  return path.join(
    harness.contract_root,
    'artifacts',
    'protocol_runner',
    'sealed_outputs',
    'run_parallel_first',
    'groups',
    'nodes_001_002',
    'items',
    itemId,
    'output.md',
  )
}

function makeParallelMissingRefsPlan(): WorkPlan {
  const plan = makeParallelFirstPlan()
  const step = plan.steps[0]
  if (step.step_kind !== 'parallel_group') {
    throw new Error('fixture parallel step missing')
  }

  return {
    ...plan,
    steps: [
      {
        ...step,
        contract_ref: 'docs/contracts/Missing.md',
        items: [
          {
            ...step.items[0],
            input_ref: 'docs/missing-items.md#node_001',
          },
          step.items[1],
        ],
      },
    ],
  }
}

async function startHarness(
  options: { store_mode?: 'json' | 'sqlite'; desktop_adapter?: FakeCodexDesktopAdapter; report_commands?: SerialReportCommands } = {},
): Promise<ApiHarness> {
  const temp_root = await fs.mkdtemp(path.join(os.tmpdir(), 'protocol-runner-api-'))
  tempRoots.push(temp_root)
  const runs_root = path.join(temp_root, 'runs')
  await fs.mkdir(path.join(temp_root, 'docs', 'contracts'), { recursive: true })
  await fs.writeFile(path.join(temp_root, 'docs', 'contracts', 'Contract_A.md'), '# Contract A\n', 'utf8')
  await fs.writeFile(path.join(temp_root, 'docs', 'items.md'), '# Items\n\n- node_001\n- node_002\n', 'utf8')
  const desktop_adapter = options.desktop_adapter ?? new FakeCodexDesktopAdapter()
  const relay_adapter = new FakeDiscordRelayAdapter()
  const notifications: RunnerAttentionNotification[] = []
  const store =
    options.store_mode === 'sqlite'
      ? new HybridRunnerStore({
          primary: new SqliteRunnerStore({
            runs_root,
            db_path: path.join(temp_root, 'protocol_runner.sqlite'),
            now: () => new Date('2026-06-25T13:00:00.000Z'),
          }),
          legacy_json: new JsonRunnerStore({ runs_root }),
        })
      : new JsonRunnerStore({ runs_root })
  const controller = new ProtocolRunnerController({
    store,
    desktop_adapter,
    relay_adapter,
    contract_root: temp_root,
    report_commands: options.report_commands,
    now: () => new Date('2026-06-25T13:00:00.000Z'),
    notification_notifier: {
      notify: (notification) => {
        notifications.push(notification)
      },
    },
  })
  const server = createProtocolRunnerServer({ controller, security: { mode: 'test' } })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  const base_url = `http://127.0.0.1:${address.port}`

  return {
    base_url,
    temp_root: runs_root,
    contract_root: temp_root,
    server,
    desktop_adapter,
    relay_adapter,
    notifications,
    async request(method: string, pathname: string, body?: unknown) {
      const response = await fetch(`${base_url}${pathname}`, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const text = await response.text()
      const contentType = response.headers.get('content-type') ?? ''
      const parsed = contentType.includes('application/json') && text.length > 0 ? JSON.parse(text) : null
      return {
        status: response.status,
        body: parsed,
        text,
      }
    },
  }
}

async function closeHarness(harness: ApiHarness): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    harness.server.close((error) => (error === undefined ? resolve() : reject(error)))
  })
}

function statusReport(run_instance_id: string, step_id: string, status = 'completed') {
  return {
    run_instance_id,
    step_id,
    status,
    summary: 'test status report',
  }
}

function startReport(run_instance_id: string, envelope: TestRunEnvelope) {
  const pending = envelope.run.state.pending_start_report
  assert.notEqual(pending, undefined)
  return {
    run_instance_id,
    step_id: pending?.step_id,
    prompt_attempt_id: pending?.prompt_attempt_id,
    start_token: pending?.start_token,
  }
}

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true })
  }
})

describe('protocol-runner-api fake lifecycle', () => {
  it('keeps the HTTP boundary covered by the protocol-runner OpenAPI artifact', async () => {
    const contractPath = path.join(
      repoRoot,
      'contracts',
      'protocol-runner.openapi.yaml',
    )
    const contract = await fs.readFile(contractPath, 'utf8')
    assert.match(contract, /\/api\/runs\/\{run_instance_id\}\/close:/)
    assert.match(contract, /\/api\/runs\/\{run_instance_id\}\/start-report:/)
    assert.match(contract, /\/api\/runs\/\{run_instance_id\}\/parallel-groups\/\{group_id\}\/preflight:/)
    assert.match(contract, /\/api\/runs\/\{run_instance_id\}\/parallel-groups\/\{group_id\}\/leases:/)
    assert.match(contract, /\/api\/runs\/\{run_instance_id\}\/parallel-groups\/\{group_id\}\/attempts\/\{attempt_id\}\/result:/)
    assert.match(contract, /CloseoutEnvelope:/)
    assert.match(contract, /ParallelPreflightEnvelope:/)
    assert.match(contract, /ParallelGroupEnvelope:/)
    assert.match(contract, /ParallelLeasePacket:/)
    assert.match(
      contract,
      /ParallelLeasePacket:[\s\S]*?required:[\s\S]*?- variables[\s\S]*?properties:[\s\S]*?variables:\s*\n\s+type: object[\s\S]*?ParallelPreflightResult:/,
    )
    assert.match(contract, /ParallelGroupState:/)
    assert.match(contract, /contract\.path_missing/)
    assert.match(contract, /DesktopOperatorGateResponse:/)
  })

  it('completes a fake two-step run through HTTP with prompts, returns, events, diagnostics, and files', async () => {
    const config = readProtocolRunnerApiConfig({
      PROTOCOL_RUNNER_CONTROL_TOKEN: 'fake-lifecycle-token-never-real-credentials',
      PROTOCOL_RUNNER_API_PORT: '14831',
      PROTOCOL_RUNNER_PYTHON_EXECUTABLE: 'python',
      PROTOCOL_RUNNER_REPORT_SHELL: 'powershell',
    })
    const harness = await startHarness({ report_commands: config.reportCommands })
    try {
      const created = await harness.request('POST', '/api/runs', {
        run_instance_id: 'run_api_loop',
        work_plan: makePlan(),
        automation: { auto_pickup: true },
      })
      assert.equal(created.status, 201)
      const createdBody = bodyAs<TestRunEnvelope>(created)
      assert.equal(createdBody.run.state.status, 'draft')

      const bound = await harness.request('POST', '/api/runs/run_api_loop/bind', {
        binding_kind: 'serial_desktop',
        visible_thread_label: 'Thread One',
      })
      assert.equal(bound.status, 200)
      const boundBody = bodyAs<TestRunEnvelope>(bound)
      assert.equal(boundBody.run.state.status, 'bound')
      assert.equal(boundBody.run.state.thread_binding?.relay_channel_name, 'protocol-runner-run_api_loop')

      const firstStart = await harness.request('POST', '/api/runs/run_api_loop/start')
      assert.equal(firstStart.status, 200)
      const firstStartBody = bodyAs<TestRunEnvelope>(firstStart)
      assert.equal(firstStartBody.run.state.status, 'waiting_for_start_report')
      assert.equal(firstStartBody.run.state.current_step_id, 'derive_item_001')
      assert.equal(firstStartBody.attempt, 1)
      assert.equal(harness.desktop_adapter.sent_prompts.length, 1)
      assert.match(harness.desktop_adapter.sent_prompts[0].prompt, /Planned step:\nderive item_001/)
      assert.match(harness.desktop_adapter.sent_prompts[0].prompt, /^# Protocol Runner Step Start Report/)
      assert.ok(harness.desktop_adapter.sent_prompts[0].prompt.includes(path.join(repoRoot, 'scripts', 'tools', 'protocol_runner_step_start.py').replace(/'/g, "''")))
      assert.ok(harness.desktop_adapter.sent_prompts[0].prompt.includes(path.join(repoRoot, 'scripts', 'tools', 'protocol_runner_return.py').replace(/'/g, "''")))
      assert.equal(harness.desktop_adapter.sent_prompts[0].prompt.split('--base-url http://127.0.0.1:14831').length - 1, 2)
      assert.doesNotMatch(harness.desktop_adapter.sent_prompts[0].prompt, /fake-lifecycle-token-never-real-credentials/)

      assert.notEqual(firstStartBody.prompt_file, undefined)
      const firstPromptName = path.basename(firstStartBody.prompt_file?.relative_path ?? '')
      const firstPrompt = await harness.request('GET', `/api/runs/run_api_loop/files/prompts/${firstPromptName}`)
      assert.equal(firstPrompt.status, 200)
      assert.match(firstPrompt.text, /Run instance: run_api_loop/)

      const firstStartReport = await harness.request(
        'POST',
        '/api/runs/run_api_loop/start-report',
        startReport('run_api_loop', firstStartBody),
      )
      assert.equal(firstStartReport.status, 200)
      const firstStartReportBody = bodyAs<TestRunEnvelope>(firstStartReport)
      assert.equal(firstStartReportBody.run.state.status, 'waiting_for_completion_report')
      assert.notEqual(firstStartReportBody.start_file, undefined)
      const firstStartName = path.basename(firstStartReportBody.start_file?.relative_path ?? '')
      const firstStartReceipt = await harness.request('GET', `/api/runs/run_api_loop/files/starts/${firstStartName}`)
      assert.equal(firstStartReceipt.status, 200)
      assert.match(firstStartReceipt.text, /"prompt_attempt_id": "attempt_001"/)

      const firstReturn = await harness.request('POST', '/api/runs/run_api_loop/return', {
        ...statusReport('run_api_loop', 'derive_item_001'),
      })
      assert.equal(firstReturn.status, 200)
      const firstReturnBody = bodyAs<TestRunEnvelope>(firstReturn)
      assert.equal(firstReturnBody.run.state.status, 'ready')
      assert.equal(firstReturnBody.run.state.current_step_id, 'derive_item_002')
      assert.equal(firstReturnBody.transition?.action, 'advance')

      const secondStart = await harness.request('POST', '/api/runs/run_api_loop/start')
      assert.equal(secondStart.status, 200)
      const secondStartBody = bodyAs<TestRunEnvelope>(secondStart)
      assert.equal(secondStartBody.run.state.status, 'waiting_for_start_report')
      assert.equal(secondStartBody.run.state.current_step_id, 'derive_item_002')
      assert.equal(harness.desktop_adapter.sent_prompts.length, 2)

      const secondStartReport = await harness.request(
        'POST',
        '/api/runs/run_api_loop/start-report',
        startReport('run_api_loop', secondStartBody),
      )
      assert.equal(secondStartReport.status, 200)
      assert.equal(bodyAs<TestRunEnvelope>(secondStartReport).run.state.status, 'waiting_for_completion_report')

      const finalReturn = await harness.request('POST', '/api/runs/run_api_loop/return', {
        ...statusReport('run_api_loop', 'derive_item_002'),
      })
      assert.equal(finalReturn.status, 200)
      const finalReturnBody = bodyAs<TestRunEnvelope>(finalReturn)
      assert.equal(finalReturnBody.run.state.status, 'completed')
      assert.equal(finalReturnBody.transition?.action, 'stop')

      const events = await harness.request('GET', '/api/runs/run_api_loop/events')
      assert.equal(events.status, 200)
      const eventsBody = bodyAs<TestEventsEnvelope>(events)
      assert.ok(eventsBody.events.some((event) => event.event_type === 'prompt_rendered'))
      assert.ok(eventsBody.events.some((event) => event.event_type === 'start_report_received'))
      assert.ok(eventsBody.events.some((event) => event.event_type === 'status_report_received'))
      assert.ok(eventsBody.events.some((event) => event.event_type === 'transition_resolved'))

      const diagnostics = await harness.request('GET', '/api/runs/run_api_loop/diagnostics')
      assert.equal(diagnostics.status, 200)
      const diagnosticsBody = bodyAs<TestDiagnosticsEnvelope>(diagnostics)
      assert.equal(diagnosticsBody.diagnostics.status, 'completed')
      assert.equal(diagnosticsBody.diagnostics.latest_files.prompt.includes('prompts/'), true)
      assert.equal(diagnosticsBody.diagnostics.evidence_paths.run_dir, path.resolve(harness.temp_root, 'run_api_loop'))
      assert.equal(
        diagnosticsBody.diagnostics.next_allowed_actions.find((action) => action.action === 'fail')?.enabled,
        false,
      )
      assert.equal((await harness.request('POST', '/api/runs/run_api_loop/fail', { reason: 'too late' })).status, 409)
    } finally {
      await closeHarness(harness)
    }
  })

  it('blocks on an invalid return and leaves the cursor on the current step', async () => {
    const harness = await startHarness()
    try {
      await harness.request('POST', '/api/runs', {
        run_instance_id: 'run_bad_return',
        work_plan: makePlan(),
        automation: { auto_pickup: true },
      })
      await harness.request('POST', '/api/runs/run_bad_return/bind', { binding_kind: 'serial_desktop', visible_thread_label: 'Thread One' })
      const started = await harness.request('POST', '/api/runs/run_bad_return/start')
      await harness.request('POST', '/api/runs/run_bad_return/start-report', startReport('run_bad_return', bodyAs<TestRunEnvelope>(started)))

      const returned = await harness.request('POST', '/api/runs/run_bad_return/return', {
        ...statusReport('run_bad_return', 'wrong_step'),
      })
      assert.equal(returned.status, 200)
      const returnedBody = bodyAs<TestRunEnvelope>(returned)
      assert.equal(returnedBody.run.state.status, 'blocked')
      assert.equal(returnedBody.run.state.current_step_id, 'derive_item_001')
      assert.match(returnedBody.run.state.blocked_reason ?? '', /Status report rejected/)

      const diagnostics = await harness.request('GET', '/api/runs/run_bad_return/diagnostics')
      const diagnosticsBody = bodyAs<TestDiagnosticsEnvelope>(diagnostics)
      const retry = diagnosticsBody.diagnostics.next_allowed_actions.find((action) => action.action === 'retry-current')
      assert.notEqual(retry, undefined)
      assert.equal(retry?.enabled, true)
    } finally {
      await closeHarness(harness)
    }
  })

  it('rejects legacy thread_id binding payloads', async () => {
    const harness = await startHarness()
    try {
      await harness.request('POST', '/api/runs', {
        run_instance_id: 'run_legacy_bind_rejected',
        work_plan: makePlan(),
      })
      const legacyBind = await harness.request('POST', '/api/runs/run_legacy_bind_rejected/bind', {
        thread_id: 'thread_001',
      })
      assert.equal(legacyBind.status, 400)
      assert.match(legacyBind.text, /no longer accepts thread_id/)
    } finally {
      await closeHarness(harness)
    }
  })

  it('rejects structured status reports when auto_pickup is disabled', async () => {
    const harness = await startHarness()
    try {
      await harness.request('POST', '/api/runs', {
        run_instance_id: 'run_pickup_disabled',
        work_plan: makePlan(),
      })
      await harness.request('POST', '/api/runs/run_pickup_disabled/bind', { binding_kind: 'serial_desktop', visible_thread_label: 'Thread One' })
      const started = await harness.request('POST', '/api/runs/run_pickup_disabled/start')
      await harness.request(
        'POST',
        '/api/runs/run_pickup_disabled/start-report',
        startReport('run_pickup_disabled', bodyAs<TestRunEnvelope>(started)),
      )

      const returned = await harness.request('POST', '/api/runs/run_pickup_disabled/return', {
        ...statusReport('run_pickup_disabled', 'derive_item_001'),
      })
      assert.equal(returned.status, 409)
      assert.match(returned.text, /auto_pickup=true/)
    } finally {
      await closeHarness(harness)
    }
  })

  it('blocks on an unknown prompt send result and retries the same cursor with the next attempt', async () => {
    const harness = await startHarness()
    try {
      await harness.request('POST', '/api/runs', { run_instance_id: 'run_unknown_send', work_plan: makePlan() })
      await harness.request('POST', '/api/runs/run_unknown_send/bind', { binding_kind: 'serial_desktop', visible_thread_label: 'Thread One' })
      harness.desktop_adapter.setNextSendResult({
        send_status: 'unknown',
        desktop_result: 'timeout',
        message: 'fake timeout',
      })

      const started = await harness.request('POST', '/api/runs/run_unknown_send/start')
      assert.equal(started.status, 200)
      const startedBody = bodyAs<TestRunEnvelope>(started)
      assert.equal(startedBody.run.state.status, 'blocked')
      assert.equal(startedBody.run.state.current_step_id, 'derive_item_001')
      assert.match(startedBody.run.state.blocked_reason ?? '', /send_status=unknown/)

      const retry = await harness.request('POST', '/api/runs/run_unknown_send/retry-current')
      assert.equal(retry.status, 200)
      const retryBody = bodyAs<TestRunEnvelope>(retry)
      assert.equal(retryBody.run.state.status, 'waiting_for_start_report')
      assert.equal(retryBody.run.state.current_step_id, 'derive_item_001')
      assert.equal(retryBody.attempt, 2)
      assert.equal(harness.desktop_adapter.sent_prompts.length, 2)
    } finally {
      await closeHarness(harness)
    }
  })

  it('allows operator rebind while blocked and retries the same cursor on the replacement thread', async () => {
    const harness = await startHarness()
    try {
      await harness.request('POST', '/api/runs', { run_instance_id: 'run_rebind_blocked', work_plan: makePlan() })
      await harness.request('POST', '/api/runs/run_rebind_blocked/bind', {
        binding_kind: 'serial_desktop',
        visible_thread_label: 'OLD',
      })
      harness.desktop_adapter.setNextSendResult({
        send_status: 'not_sent',
        desktop_result: 'thread_mismatch',
        message: 'fake stale thread binding',
        thread_id: null,
        thread_title: 'OLD',
      })

      const started = await harness.request('POST', '/api/runs/run_rebind_blocked/start')
      assert.equal(started.status, 200)
      const startedBody = bodyAs<TestRunEnvelope>(started)
      assert.equal(startedBody.run.state.status, 'blocked')
      assert.equal(startedBody.run.state.current_step_id, 'derive_item_001')

      const diagnostics = await harness.request('GET', '/api/runs/run_rebind_blocked/diagnostics')
      const diagnosticsBody = bodyAs<TestDiagnosticsEnvelope>(diagnostics)
      const bindAction = diagnosticsBody.diagnostics.next_allowed_actions.find((action) => action.action === 'bind-thread')
      assert.equal(bindAction?.enabled, true)

      const rebound = await harness.request('POST', '/api/runs/run_rebind_blocked/bind', {
        binding_kind: 'serial_desktop',
        visible_thread_label: 'NEW',
      })
      assert.equal(rebound.status, 200)
      const reboundBody = bodyAs<TestRunEnvelope>(rebound)
      assert.equal(reboundBody.run.state.status, 'blocked')
      assert.equal(reboundBody.run.state.current_step_id, 'derive_item_001')
      assert.equal(reboundBody.run.state.thread_binding?.binding_kind, 'serial_desktop')
      assert.equal(reboundBody.run.state.thread_binding?.visible_thread_label, 'NEW')

      const retry = await harness.request('POST', '/api/runs/run_rebind_blocked/retry-current')
      assert.equal(retry.status, 200)
      const retryBody = bodyAs<TestRunEnvelope>(retry)
      assert.equal(retryBody.run.state.status, 'waiting_for_start_report')
      assert.equal(retryBody.run.state.current_step_id, 'derive_item_001')
      assert.equal(retryBody.attempt, 2)
      assert.equal(harness.desktop_adapter.sent_prompts.length, 2)
      assert.equal(harness.desktop_adapter.sent_prompts[1]?.thread_binding.visible_thread_label, 'NEW')
    } finally {
      await closeHarness(harness)
    }
  })

  it('blocks after an applied send without delivery confirmation', async () => {
    const harness = await startHarness()
    try {
      await harness.request('POST', '/api/runs', {
        run_instance_id: 'run_applied_without_delivery_id',
        work_plan: makePlan(),
        automation: { auto_pickup: true },
      })
      await harness.request('POST', '/api/runs/run_applied_without_delivery_id/bind', { binding_kind: 'serial_desktop', visible_thread_label: 'Thread One' })
      harness.desktop_adapter.setNextSendResult({
        send_status: 'unknown',
        desktop_result: 'applied',
        message: 'fake applied without delivery id',
      })

      const started = await harness.request('POST', '/api/runs/run_applied_without_delivery_id/start')
      assert.equal(started.status, 200)
      const startedBody = bodyAs<TestRunEnvelope>(started)
      assert.equal(startedBody.run.state.status, 'blocked')
      assert.equal(startedBody.run.state.current_step_id, 'derive_item_001')
      assert.match(startedBody.run.state.blocked_reason ?? '', /send_status=unknown/)
      assert.equal(startedBody.attempt, 1)
      assert.equal(harness.desktop_adapter.sent_prompts.length, 1)
    } finally {
      await closeHarness(harness)
    }
  })

  it('rejects raw visible-response return text instead of treating it as prompt confirmation', async () => {
    const harness = await startHarness()
    try {
      await harness.request('POST', '/api/runs', { run_instance_id: 'run_raw_return', work_plan: makePlan() })
      await harness.request('POST', '/api/runs/run_raw_return/bind', { binding_kind: 'serial_desktop', visible_thread_label: 'Thread One' })
      const started = await harness.request('POST', '/api/runs/run_raw_return/start')
      await harness.request('POST', '/api/runs/run_raw_return/start-report', startReport('run_raw_return', bodyAs<TestRunEnvelope>(started)))

      const returned = await harness.request('POST', '/api/runs/run_raw_return/return', {
        text: 'Done with the visible response only.',
      })
      assert.equal(returned.status, 409)

      const current = await harness.request('GET', '/api/runs/run_raw_return')
      const currentBody = bodyAs<TestRunEnvelope>(current)
      assert.equal(currentBody.run.state.status, 'waiting_for_completion_report')
      assert.equal(currentBody.run.state.current_step_id, 'derive_item_001')

      const events = await harness.request('GET', '/api/runs/run_raw_return/events')
      const eventsBody = bodyAs<TestEventsEnvelope>(events)
      assert.equal(eventsBody.events.some((event) => event.event_type === 'completion_received'), false)
      assert.equal(eventsBody.events.some((event) => event.event_type === 'status_report_received'), false)
    } finally {
      await closeHarness(harness)
    }
  })

  it('pauses and resumes without advancing the cursor', async () => {
    const harness = await startHarness()
    try {
      await harness.request('POST', '/api/runs', { run_instance_id: 'run_pause_resume', work_plan: makePlan() })
      await harness.request('POST', '/api/runs/run_pause_resume/bind', { binding_kind: 'serial_desktop', visible_thread_label: 'Thread One' })
      await harness.request('POST', '/api/runs/run_pause_resume/start')

      const paused = await harness.request('POST', '/api/runs/run_pause_resume/pause')
      assert.equal(paused.status, 200)
      const pausedBody = bodyAs<TestRunEnvelope>(paused)
      assert.equal(pausedBody.run.state.status, 'paused')
      assert.equal(pausedBody.run.state.current_step_id, 'derive_item_001')

      const resumed = await harness.request('POST', '/api/runs/run_pause_resume/resume')
      assert.equal(resumed.status, 200)
      const resumedBody = bodyAs<TestRunEnvelope>(resumed)
      assert.equal(resumedBody.run.state.status, 'waiting_for_start_report')
      assert.equal(resumedBody.run.state.current_step_id, 'derive_item_001')
      assert.equal(resumedBody.attempt, 2)
      assert.equal(harness.desktop_adapter.sent_prompts.length, 2)
    } finally {
      await closeHarness(harness)
    }
  })

  it('blocks prompt delivery before desktop send when a referenced contract file is missing', async () => {
    const harness = await startHarness()
    try {
      await harness.request('POST', '/api/runs', {
        run_instance_id: 'run_missing_contract',
        work_plan: makeMissingContractPlan(),
      })
      await harness.request('POST', '/api/runs/run_missing_contract/bind', { binding_kind: 'serial_desktop', visible_thread_label: 'Thread One' })

      const validation = await harness.request('POST', '/api/runs/run_missing_contract/validate')
      assert.equal(validation.status, 200)
      const validationBody = bodyAs<TestValidationEnvelope>(validation)
      assert.equal(validationBody.validation.ok, false)
      assert.equal(validationBody.validation.issues[0].code, 'contract.path_missing')
      assert.equal(validationBody.validation.issues[0].path, '$.default_contract.path')

      const started = await harness.request('POST', '/api/runs/run_missing_contract/start')
      assert.equal(started.status, 200)
      const startedBody = bodyAs<TestRunEnvelope>(started)
      assert.equal(startedBody.run.state.status, 'blocked')
      assert.equal(startedBody.run.state.current_step_id, 'derive_item_001')
      assert.match(startedBody.run.state.blocked_reason ?? '', /Contract preflight failed/)
      assert.equal(harness.desktop_adapter.sent_prompts.length, 0)

      const events = await harness.request('GET', '/api/runs/run_missing_contract/events')
      const eventsBody = bodyAs<TestEventsEnvelope>(events)
      assert.ok(eventsBody.events.some((event) => event.event_type === 'diagnostic'))
      assert.equal(eventsBody.events.some((event) => event.event_type === 'prompt_rendered'), false)
    } finally {
      await closeHarness(harness)
    }
  })

  it('starts parallel_group steps by preflighting and handing them to the parallel executor lane', async () => {
    const harness = await startHarness({ store_mode: 'sqlite' })
    try {
      const created = await harness.request('POST', '/api/runs', {
        run_instance_id: 'run_parallel_first',
        work_plan: makeParallelFirstPlan(),
      })
      assert.equal(created.status, 201)

      const bound = await harness.request('POST', '/api/runs/run_parallel_first/bind', { binding_kind: 'serial_desktop', visible_thread_label: 'Thread One' })
      assert.equal(bound.status, 200)

      const started = await harness.request('POST', '/api/runs/run_parallel_first/start')
      assert.equal(started.status, 200)
      const startedBody = bodyAs<TestParallelPreflightEnvelope>(started)
      assert.equal(startedBody.preflight.passed, true)
      assert.equal(startedBody.group.status, 'ready_to_lease')
      assert.equal(startedBody.group.preflight_status, 'passed')
      assert.equal(startedBody.run.state.status, 'running')
      assert.equal(startedBody.run.state.current_step_id, 'derive_nodes_parallel')
      assert.equal(harness.desktop_adapter.sent_prompts.length, 0)

      const diagnostics = await harness.request('GET', '/api/runs/run_parallel_first/diagnostics')
      assert.equal(diagnostics.status, 200)
      const diagnosticsBody = bodyAs<TestDiagnosticsEnvelope>(diagnostics)
      assert.equal(diagnosticsBody.diagnostics.status, 'running')
      assert.equal(diagnosticsBody.diagnostics.parallel_groups[0].status, 'ready_to_lease')
    } finally {
      await closeHarness(harness)
    }
  })

  it('resumes a paused parallel_group without using the serial Desktop prompt path', async () => {
    const harness = await startHarness({ store_mode: 'sqlite' })
    try {
      await harness.request('POST', '/api/runs', {
        run_instance_id: 'run_parallel_pause_resume',
        work_plan: makeParallelFirstPlan(),
      })
      await harness.request('POST', '/api/runs/run_parallel_pause_resume/bind', {
        binding_kind: 'serial_desktop',
        visible_thread_label: 'Thread One',
      })
      await harness.request('POST', '/api/runs/run_parallel_pause_resume/start')

      const paused = await harness.request('POST', '/api/runs/run_parallel_pause_resume/pause')
      assert.equal(paused.status, 200)
      assert.equal(bodyAs<TestRunEnvelope>(paused).run.state.status, 'paused')

      const resumed = await harness.request('POST', '/api/runs/run_parallel_pause_resume/resume')
      assert.equal(resumed.status, 200)
      const resumedBody = bodyAs<TestParallelPreflightEnvelope>(resumed)
      assert.equal(resumedBody.run.state.status, 'running')
      assert.equal(resumedBody.run.state.current_step_id, 'derive_nodes_parallel')
      assert.equal(resumedBody.group.status, 'ready_to_lease')
      assert.equal(harness.desktop_adapter.sent_prompts.length, 0)
    } finally {
      await closeHarness(harness)
    }
  })

  it('activates a parallel group after a completed serial step without another Desktop prompt', async () => {
    const harness = await startHarness({ store_mode: 'sqlite' })
    try {
      await harness.request('POST', '/api/runs', {
        run_instance_id: 'run_serial_then_parallel',
        work_plan: makeSerialThenParallelPlan(),
        auto_pickup: true,
        auto_advance: true,
      })
      await harness.request('POST', '/api/runs/run_serial_then_parallel/bind', { binding_kind: 'serial_desktop', visible_thread_label: 'Thread One' })

      const startedSerial = await harness.request('POST', '/api/runs/run_serial_then_parallel/start')
      assert.equal(startedSerial.status, 200)
      const startedSerialBody = bodyAs<TestRunEnvelope>(startedSerial)
      assert.equal(startedSerialBody.run.state.status, 'waiting_for_start_report')
      assert.equal(harness.desktop_adapter.sent_prompts.length, 1)

      const startAccepted = await harness.request(
        'POST',
        '/api/runs/run_serial_then_parallel/start-report',
        startReport('run_serial_then_parallel', startedSerialBody),
      )
      assert.equal(startAccepted.status, 200)

      const returned = await harness.request(
        'POST',
        '/api/runs/run_serial_then_parallel/return',
        statusReport('run_serial_then_parallel', 'derive_item_001'),
      )
      assert.equal(returned.status, 200)
      const returnedBody = bodyAs<TestRunEnvelope>(returned)
      assert.equal(returnedBody.run.state.status, 'ready')
      assert.equal(returnedBody.run.state.current_step_id, 'derive_nodes_parallel')

      const startedParallel = await harness.request('POST', '/api/runs/run_serial_then_parallel/start')
      assert.equal(startedParallel.status, 200)
      const startedParallelBody = bodyAs<TestParallelPreflightEnvelope>(startedParallel)
      assert.equal(startedParallelBody.run.state.status, 'running')
      assert.equal(startedParallelBody.run.state.current_step_id, 'derive_nodes_parallel')
      assert.equal(startedParallelBody.group.status, 'ready_to_lease')
      assert.equal(startedParallelBody.group.preflight_status, 'passed')
      assert.equal(harness.desktop_adapter.sent_prompts.length, 1)
    } finally {
      await closeHarness(harness)
    }
  })

  it('preflights the current parallel group through SQLite state without launching workers', async () => {
    const harness = await startHarness({ store_mode: 'sqlite' })
    try {
      const created = await harness.request('POST', '/api/runs', {
        run_instance_id: 'run_parallel_first',
        work_plan: makeParallelFirstPlan(),
      })
      assert.equal(created.status, 201)
      const bound = await harness.request('POST', '/api/runs/run_parallel_first/bind', { binding_kind: 'serial_desktop', visible_thread_label: 'Thread One' })
      assert.equal(bound.status, 200)

      const preflight = await harness.request(
        'POST',
        '/api/runs/run_parallel_first/parallel-groups/nodes_001_002/preflight',
      )
      assert.equal(preflight.status, 200)
      const preflightBody = bodyAs<TestParallelPreflightEnvelope>(preflight)
      assert.equal(preflightBody.preflight.passed, true)
      assert.equal(preflightBody.preflight.preflight_status, 'passed')
      assert.equal(preflightBody.group.status, 'ready_to_lease')
      assert.equal(preflightBody.group.preflight_status, 'passed')
      assert.deepEqual(preflightBody.group.required_worker_capabilities, ['json_transform'])
      assert.deepEqual(preflightBody.preflight.executor_summary?.required_worker_capabilities, ['json_transform'])
      assert.ok(
        preflightBody.preflight.checks.some(
          (check) => check.code === 'parallel_group.required_worker_capabilities_declared',
        ),
      )
      assert.deepEqual(
        preflightBody.group.items.map((item) => [item.item_id, item.status]),
        [
          ['node_001', 'pending'],
          ['node_002', 'pending'],
        ],
      )
      assert.equal(preflightBody.run.state.status, 'ready')
      assert.equal(harness.desktop_adapter.sent_prompts.length, 0)
      await assert.doesNotReject(fs.access(preflightBody.preflight.evidence_file?.path ?? ''))

      const diagnostics = await harness.request('GET', '/api/runs/run_parallel_first/diagnostics')
      assert.equal(diagnostics.status, 200)
      const diagnosticsBody = bodyAs<TestDiagnosticsEnvelope>(diagnostics)
      assert.equal(diagnosticsBody.diagnostics.parallel_groups[0].group_id, 'nodes_001_002')
      assert.equal(diagnosticsBody.diagnostics.parallel_groups[0].status, 'ready_to_lease')
    } finally {
      await closeHarness(harness)
    }
  })

  it('records failed parallel preflight reasons and blocks without launching workers', async () => {
    const harness = await startHarness({ store_mode: 'sqlite' })
    try {
      const created = await harness.request('POST', '/api/runs', {
        run_instance_id: 'run_parallel_missing_refs',
        work_plan: makeParallelMissingRefsPlan(),
      })
      assert.equal(created.status, 201)
      const bound = await harness.request('POST', '/api/runs/run_parallel_missing_refs/bind', {
        binding_kind: 'parallel_only',
      })
      assert.equal(bound.status, 200)

      const preflight = await harness.request(
        'POST',
        '/api/runs/run_parallel_missing_refs/parallel-groups/nodes_001_002/preflight',
      )
      assert.equal(preflight.status, 200)
      const preflightBody = bodyAs<TestParallelPreflightEnvelope>(preflight)
      assert.equal(preflightBody.preflight.passed, false)
      assert.equal(preflightBody.group.status, 'needs_attention')
      assert.equal(preflightBody.run.state.status, 'blocked')
      assert.match(preflightBody.run.state.blocked_reason ?? '', /Parallel preflight failed/)
      assert.ok(preflightBody.preflight.errors.some((error) => error.code === 'contract.path_missing'))
      assert.ok(preflightBody.preflight.errors.some((error) => error.code === 'parallel_group.input_ref_missing'))
      assert.equal(harness.desktop_adapter.sent_prompts.length, 0)
      await assert.doesNotReject(fs.access(preflightBody.preflight.evidence_file?.path ?? ''))
    } finally {
      await closeHarness(harness)
    }
  })

  it('fails preflight when sealed output directories cannot be created', async () => {
    const harness = await startHarness({ store_mode: 'sqlite' })
    try {
      await fs.writeFile(path.join(harness.contract_root, 'artifacts'), 'not a directory', 'utf8')
      const created = await harness.request('POST', '/api/runs', {
        run_instance_id: 'run_parallel_bad_output_dir',
        work_plan: makeParallelFirstPlan(),
      })
      assert.equal(created.status, 201)
      const bound = await harness.request('POST', '/api/runs/run_parallel_bad_output_dir/bind', {
        binding_kind: 'parallel_only',
      })
      assert.equal(bound.status, 200)

      const preflight = await harness.request(
        'POST',
        '/api/runs/run_parallel_bad_output_dir/parallel-groups/nodes_001_002/preflight',
      )
      assert.equal(preflight.status, 200)
      const preflightBody = bodyAs<TestParallelPreflightEnvelope>(preflight)
      assert.equal(preflightBody.preflight.passed, false)
      assert.equal(preflightBody.run.state.status, 'blocked')
      assert.ok(
        preflightBody.preflight.errors.some((error) => error.code === 'parallel_group.sealed_output_unwritable'),
      )
      assert.equal(harness.desktop_adapter.sent_prompts.length, 0)
    } finally {
      await closeHarness(harness)
    }
  })

  it('fails preflight when sealed output storage overlaps the runner-owned run directory', async () => {
    const harness = await startHarness({ store_mode: 'sqlite' })
    try {
      const runId = 'run_parallel_output_overlap'
      const overlappingBaseDir = `runs/${runId}/groups/nodes_001_002/items`
      const created = await harness.request('POST', '/api/runs', {
        run_instance_id: runId,
        work_plan: makeParallelFirstPlan(overlappingBaseDir),
      })
      assert.equal(created.status, 201)
      const bound = await harness.request('POST', `/api/runs/${runId}/bind`, {
        binding_kind: 'parallel_only',
      })
      assert.equal(bound.status, 200)

      const preflight = await harness.request(
        'POST',
        `/api/runs/${runId}/parallel-groups/nodes_001_002/preflight`,
      )
      assert.equal(preflight.status, 200)
      const preflightBody = bodyAs<TestParallelPreflightEnvelope>(preflight)
      assert.equal(preflightBody.preflight.passed, false)
      assert.equal(preflightBody.run.state.status, 'blocked')
      assert.ok(
        preflightBody.preflight.errors.some(
          (error) => error.code === 'parallel_group.sealed_output_run_dir_overlap',
        ),
      )
      await assert.rejects(fs.access(path.join(harness.temp_root, runId, 'groups')))
      assert.equal(harness.desktop_adapter.sent_prompts.length, 0)
    } finally {
      await closeHarness(harness)
    }
  })

  it('fails preflight when a sealed-output ancestor junction redirects into the run directory', async () => {
    const harness = await startHarness({ store_mode: 'sqlite' })
    try {
      const runId = 'run_parallel_redirected_output_overlap'
      const redirectedRoot = path.join(harness.contract_root, 'redirected_outputs')
      const redirectedBaseDir = 'redirected_outputs/groups/nodes_001_002/items'
      const created = await harness.request('POST', '/api/runs', {
        run_instance_id: runId,
        work_plan: makeParallelFirstPlan(redirectedBaseDir),
      })
      assert.equal(created.status, 201)
      await fs.symlink(path.join(harness.temp_root, runId), redirectedRoot, 'junction')
      const bound = await harness.request('POST', `/api/runs/${runId}/bind`, {
        binding_kind: 'parallel_only',
      })
      assert.equal(bound.status, 200)

      const preflight = await harness.request(
        'POST',
        `/api/runs/${runId}/parallel-groups/nodes_001_002/preflight`,
      )
      assert.equal(preflight.status, 200)
      const preflightBody = bodyAs<TestParallelPreflightEnvelope>(preflight)
      assert.equal(preflightBody.preflight.passed, false)
      const overlap = preflightBody.preflight.errors.find(
        (error) => error.code === 'parallel_group.sealed_output_run_dir_overlap',
      )
      assert.ok(overlap)
      assert.equal(overlap.details?.relationship, 'redirected_or_ambiguous_overlap')
      assert.equal(overlap.details?.physical_relationship, 'output_within_run')
      assert.equal(harness.desktop_adapter.sent_prompts.length, 0)
    } finally {
      await closeHarness(harness)
    }
  })

  it('rejects an item-output child junction redirected into the run directory at preflight and closeout', async () => {
    const harness = await startHarness({ store_mode: 'sqlite' })
    try {
      const runId = 'run_parallel_redirected_item_output'
      const sealedOutputBaseDir = `artifacts/protocol_runner/sealed_outputs/${runId}/items`
      const created = await harness.request('POST', '/api/runs', {
        run_instance_id: runId,
        work_plan: makeParallelFirstPlan(sealedOutputBaseDir),
      })
      assert.equal(created.status, 201)

      const outputBaseDir = path.join(harness.contract_root, sealedOutputBaseDir)
      const redirectedItemDir = path.join(outputBaseDir, 'node_001')
      const runDir = path.join(harness.temp_root, runId)
      await fs.mkdir(outputBaseDir, { recursive: true })
      await fs.symlink(runDir, redirectedItemDir, 'junction')
      const redirectedOutput = path.join(redirectedItemDir, 'output.md')
      await fs.writeFile(redirectedOutput, 'redirected sealed output\n', 'utf8')

      const bound = await harness.request('POST', `/api/runs/${runId}/bind`, {
        binding_kind: 'parallel_only',
      })
      assert.equal(bound.status, 200)
      const preflight = await harness.request(
        'POST',
        `/api/runs/${runId}/parallel-groups/nodes_001_002/preflight`,
      )
      assert.equal(preflight.status, 200)
      const preflightBody = bodyAs<TestParallelPreflightEnvelope>(preflight)
      assert.equal(preflightBody.preflight.passed, false)
      const overlap = preflightBody.preflight.errors.find(
        (error) => error.code === 'parallel_group.sealed_output_run_dir_overlap',
      )
      assert.ok(overlap)
      assert.equal(overlap.details?.relationship, 'declared_item_output_overlap')
      const itemConflicts = overlap.details?.item_output_conflicts as Array<Record<string, unknown>>
      assert.equal(itemConflicts[0]?.item_id, 'node_001')
      assert.equal(itemConflicts[0]?.physical_relationship, 'output_within_run')

      const failed = await harness.request('POST', `/api/runs/${runId}/fail`, {
        reason: 'redirected item-output closeout guard',
      })
      assert.equal(failed.status, 200)
      const closed = await harness.request('POST', `/api/runs/${runId}/close`)
      assert.equal(closed.status, 409)
      assert.equal(
        bodyAs<{ error: { code: string } }>(closed).error.code,
        'closeout.sealed_output_run_dir_overlap',
      )
      await assert.doesNotReject(fs.access(redirectedOutput))
      await assert.doesNotReject(fs.access(runDir))
    } finally {
      await closeHarness(harness)
    }
  })

  it('rejects an intermediate item-output junction redirected outside the contract root', async () => {
    const harness = await startHarness({ store_mode: 'sqlite' })
    const externalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'protocol-runner-external-output-'))
    try {
      const runId = 'run_parallel_external_item_redirect'
      const sealedOutputBaseDir = `artifacts/protocol_runner/sealed_outputs/${runId}/items`
      const created = await harness.request('POST', '/api/runs', {
        run_instance_id: runId,
        work_plan: makeParallelFirstPlan(sealedOutputBaseDir),
      })
      assert.equal(created.status, 201)

      const outputBaseDir = path.join(harness.contract_root, sealedOutputBaseDir)
      const redirectedItemDir = path.join(outputBaseDir, 'node_001')
      await fs.mkdir(outputBaseDir, { recursive: true })
      await fs.symlink(externalRoot, redirectedItemDir, 'junction')
      const externalOutput = path.join(externalRoot, 'output.md')
      await fs.writeFile(externalOutput, 'external sealed output\n', 'utf8')

      await harness.request('POST', `/api/runs/${runId}/bind`, { binding_kind: 'parallel_only' })
      const preflight = await harness.request(
        'POST',
        `/api/runs/${runId}/parallel-groups/nodes_001_002/preflight`,
      )
      assert.equal(preflight.status, 200)
      const preflightBody = bodyAs<TestParallelPreflightEnvelope>(preflight)
      assert.equal(preflightBody.preflight.passed, false)
      assert.ok(
        preflightBody.preflight.errors.some(
          (error) => error.code === 'parallel_group.sealed_output_physical_boundary_violation',
        ),
      )

      await harness.request('POST', `/api/runs/${runId}/fail`, {
        reason: 'external item-output cleanup guard',
      })
      const closed = await harness.request('POST', `/api/runs/${runId}/close`, {
        delete_sealed_outputs: true,
      })
      assert.equal(closed.status, 409)
      assert.equal(
        bodyAs<{ error: { code: string } }>(closed).error.code,
        'closeout.sealed_output_physical_boundary_violation',
      )
      await assert.doesNotReject(fs.access(externalOutput))
      assert.equal(bodyAs<TestRunEnvelope>(await harness.request('GET', `/api/runs/${runId}`)).run.state.status, 'failed')
    } finally {
      try {
        await closeHarness(harness)
      } finally {
        await fs.rm(externalRoot, { recursive: true, force: true })
      }
    }
  })

  it('leases, heartbeats, and accepts completed parallel attempt results through HTTP', async () => {
    const harness = await startHarness({ store_mode: 'sqlite' })
    try {
      await harness.request('POST', '/api/runs', {
        run_instance_id: 'run_parallel_http_complete',
        work_plan: makeParallelFirstPlan(),
      })
      await harness.request('POST', '/api/runs/run_parallel_http_complete/bind', { binding_kind: 'serial_desktop', visible_thread_label: 'Thread One' })
      await harness.request('POST', '/api/runs/run_parallel_http_complete/parallel-groups/nodes_001_002/preflight')

      const firstLease = await harness.request(
        'POST',
        '/api/runs/run_parallel_http_complete/parallel-groups/nodes_001_002/leases',
        { executor_id: 'executor_001', capacity: 1 },
      )
      assert.equal(firstLease.status, 200)
      const firstLeaseBody = bodyAs<TestParallelPreflightEnvelope>(firstLease)
      assert.equal(firstLeaseBody.leases?.length, 1)
      assert.equal(firstLeaseBody.leases?.[0].item_id, 'node_001')
      assert.deepEqual(firstLeaseBody.leases?.[0].variables, {
        selector: 'node_001',
        nested: { preserve: true },
        ordinal: 1,
      })
      assert.equal(firstLeaseBody.run.state.status, 'running')

      const heartbeat = await harness.request(
        'POST',
        `/api/runs/run_parallel_http_complete/parallel-groups/nodes_001_002/leases/${firstLeaseBody.leases?.[0].lease_id}/heartbeat`,
        {},
      )
      assert.equal(heartbeat.status, 200)
      const heartbeatBody = bodyAs<TestParallelPreflightEnvelope>(heartbeat)
      assert.notEqual(heartbeatBody.lease?.heartbeat_at, null)
      assert.equal(heartbeatBody.group.items.find((item) => item.item_id === 'node_001')?.status, 'running')
      assert.deepEqual(heartbeatBody.group.attempts[0]?.warnings, [])

      const warningObservedAt = new Date(Date.parse(heartbeatBody.lease?.heartbeat_at ?? '') + 1_000).toISOString()

      const warningHeartbeat = await harness.request(
        'POST',
        `/api/runs/run_parallel_http_complete/parallel-groups/nodes_001_002/leases/${firstLeaseBody.leases?.[0].lease_id}/heartbeat`,
        {
          attempt_warnings: [
            {
              code: 'long_running',
              severity: 'warning',
              message: 'attempt crossed soft long-running threshold',
              observed_at: warningObservedAt,
              threshold_ms: 60_000,
              elapsed_ms: 60_000,
            },
          ],
        },
      )
      assert.equal(warningHeartbeat.status, 200)
      const warningHeartbeatBody = bodyAs<TestParallelPreflightEnvelope>(warningHeartbeat)
      assert.equal(warningHeartbeatBody.group.items.find((item) => item.item_id === 'node_001')?.status, 'running')
      assert.equal(warningHeartbeatBody.group.attempts[0]?.status, 'running')
      assert.deepEqual(warningHeartbeatBody.group.attempts[0]?.warnings.map((warning) => warning.code), ['long_running'])

      const firstResult = await harness.request(
        'POST',
        `/api/runs/run_parallel_http_complete/parallel-groups/nodes_001_002/attempts/${firstLeaseBody.leases?.[0].attempt_id}/result`,
        {
          lease_id: firstLeaseBody.leases?.[0].lease_id,
          attempt_id: firstLeaseBody.leases?.[0].attempt_id,
          launcher_status: 'completed',
          status_report: {
            run_instance_id: 'run_parallel_http_complete',
            step_id: 'derive_nodes_parallel',
            group_id: 'nodes_001_002',
            item_id: 'node_001',
            attempt_id: firstLeaseBody.leases?.[0].attempt_id,
            status: 'completed',
            summary: 'fake item completed',
          },
          sealed_output_path: firstLeaseBody.leases?.[0].sealed_output_path,
        },
      )
      assert.equal(firstResult.status, 200)
      const firstResultBody = bodyAs<TestParallelPreflightEnvelope>(firstResult)
      assert.equal(firstResultBody.attempt?.status, 'completed')
      assert.equal(firstResultBody.group.status, 'running')

      const secondLease = await harness.request(
        'POST',
        '/api/runs/run_parallel_http_complete/parallel-groups/nodes_001_002/leases',
        { executor_id: 'executor_001', capacity: 2 },
      )
      const secondLeaseBody = bodyAs<TestParallelPreflightEnvelope>(secondLease)
      assert.equal(secondLeaseBody.leases?.length, 1)
      assert.equal(secondLeaseBody.leases?.[0].item_id, 'node_002')

      const secondResult = await harness.request(
        'POST',
        `/api/runs/run_parallel_http_complete/parallel-groups/nodes_001_002/attempts/${secondLeaseBody.leases?.[0].attempt_id}/result`,
        {
          lease_id: secondLeaseBody.leases?.[0].lease_id,
          attempt_id: secondLeaseBody.leases?.[0].attempt_id,
          launcher_status: 'completed',
          status_report: {
            run_instance_id: 'run_parallel_http_complete',
            step_id: 'derive_nodes_parallel',
            group_id: 'nodes_001_002',
            item_id: 'node_002',
            attempt_id: secondLeaseBody.leases?.[0].attempt_id,
            status: 'completed',
            summary: 'fake item completed',
          },
          sealed_output_path: secondLeaseBody.leases?.[0].sealed_output_path,
        },
      )
      assert.equal(secondResult.status, 200)
      const secondResultBody = bodyAs<TestParallelPreflightEnvelope>(secondResult)
      assert.equal(secondResultBody.group.status, 'completed')
      assert.equal(secondResultBody.run.state.status, 'completed')
      assert.equal(harness.notifications.length, 1)
      assert.equal(harness.notifications[0]?.outcome, 'finished')
      assert.equal(harness.notifications[0]?.run_instance_id, 'run_parallel_http_complete')
    } finally {
      await closeHarness(harness)
    }
  })

  it('advances from a completed parallel group to the next serial step and sends it normally', async () => {
    const harness = await startHarness({ store_mode: 'sqlite' })
    try {
      await harness.request('POST', '/api/runs', {
        run_instance_id: 'run_parallel_then_serial',
        work_plan: makeParallelThenSerialPlan(),
        auto_advance: true,
      })
      await harness.request('POST', '/api/runs/run_parallel_then_serial/bind', { binding_kind: 'serial_desktop', visible_thread_label: 'Thread One' })
      await harness.request('POST', '/api/runs/run_parallel_then_serial/parallel-groups/nodes_001_002/preflight')

      const firstLease = await harness.request(
        'POST',
        '/api/runs/run_parallel_then_serial/parallel-groups/nodes_001_002/leases',
        { executor_id: 'executor_001', capacity: 1 },
      )
      const firstLeaseBody = bodyAs<TestParallelPreflightEnvelope>(firstLease)
      await harness.request(
        'POST',
        `/api/runs/run_parallel_then_serial/parallel-groups/nodes_001_002/attempts/${firstLeaseBody.leases?.[0].attempt_id}/result`,
        {
          lease_id: firstLeaseBody.leases?.[0].lease_id,
          attempt_id: firstLeaseBody.leases?.[0].attempt_id,
          launcher_status: 'completed',
          status_report: {
            run_instance_id: 'run_parallel_then_serial',
            step_id: 'derive_nodes_parallel',
            group_id: 'nodes_001_002',
            item_id: 'node_001',
            attempt_id: firstLeaseBody.leases?.[0].attempt_id,
            status: 'completed',
            summary: 'fake item completed',
          },
          sealed_output_path: firstLeaseBody.leases?.[0].sealed_output_path,
        },
      )

      const secondLease = await harness.request(
        'POST',
        '/api/runs/run_parallel_then_serial/parallel-groups/nodes_001_002/leases',
        { executor_id: 'executor_001', capacity: 1 },
      )
      const secondLeaseBody = bodyAs<TestParallelPreflightEnvelope>(secondLease)
      const secondResult = await harness.request(
        'POST',
        `/api/runs/run_parallel_then_serial/parallel-groups/nodes_001_002/attempts/${secondLeaseBody.leases?.[0].attempt_id}/result`,
        {
          lease_id: secondLeaseBody.leases?.[0].lease_id,
          attempt_id: secondLeaseBody.leases?.[0].attempt_id,
          launcher_status: 'completed',
          status_report: {
            run_instance_id: 'run_parallel_then_serial',
            step_id: 'derive_nodes_parallel',
            group_id: 'nodes_001_002',
            item_id: 'node_002',
            attempt_id: secondLeaseBody.leases?.[0].attempt_id,
            status: 'completed',
            summary: 'fake item completed',
          },
          sealed_output_path: secondLeaseBody.leases?.[0].sealed_output_path,
        },
      )

      const secondResultBody = bodyAs<TestParallelPreflightEnvelope>(secondResult)
      assert.equal(secondResultBody.group.status, 'completed')
      assert.equal(secondResultBody.run.state.status, 'ready')
      assert.equal(secondResultBody.run.state.current_step_id, 'summarize_after_parallel')
      assert.equal(harness.notifications.length, 0)

      const started = await harness.request('POST', '/api/runs/run_parallel_then_serial/start')
      assert.equal(started.status, 200)
      const startedBody = bodyAs<TestRunEnvelope>(started)
      assert.equal(startedBody.run.state.status, 'waiting_for_start_report')
      assert.equal(startedBody.run.state.current_step_id, 'summarize_after_parallel')
      assert.equal(harness.desktop_adapter.sent_prompts.length, 1)
      assert.equal(harness.desktop_adapter.sent_prompts[0]?.step_id, 'summarize_after_parallel')
      assert.match(harness.desktop_adapter.sent_prompts[0]?.prompt ?? '', /summarize the sealed outputs/)
    } finally {
      await closeHarness(harness)
    }
  })

  it('blocks parallel groups on blocked and evidence-missing attempt results without semantic judgment', async () => {
    const harness = await startHarness({ store_mode: 'sqlite' })
    try {
      await harness.request('POST', '/api/runs', {
        run_instance_id: 'run_parallel_http_attention',
        work_plan: makeParallelFirstPlan(),
      })
      await harness.request('POST', '/api/runs/run_parallel_http_attention/bind', { binding_kind: 'serial_desktop', visible_thread_label: 'Thread One' })
      await harness.request('POST', '/api/runs/run_parallel_http_attention/parallel-groups/nodes_001_002/preflight')
      const lease = await harness.request(
        'POST',
        '/api/runs/run_parallel_http_attention/parallel-groups/nodes_001_002/leases',
        { executor_id: 'executor_001', capacity: 1 },
      )
      const leaseBody = bodyAs<TestParallelPreflightEnvelope>(lease)

      const blocked = await harness.request(
        'POST',
        `/api/runs/run_parallel_http_attention/parallel-groups/nodes_001_002/attempts/${leaseBody.leases?.[0].attempt_id}/result`,
        {
          lease_id: leaseBody.leases?.[0].lease_id,
          attempt_id: leaseBody.leases?.[0].attempt_id,
          launcher_status: 'blocked',
          status_report: {
            run_instance_id: 'run_parallel_http_attention',
            step_id: 'derive_nodes_parallel',
            group_id: 'nodes_001_002',
            item_id: 'node_001',
            attempt_id: leaseBody.leases?.[0].attempt_id,
            status: 'blocked',
            summary: 'fake model reported blocked',
          },
        },
      )
      assert.equal(blocked.status, 200)
      const blockedBody = bodyAs<TestParallelPreflightEnvelope>(blocked)
      assert.equal(blockedBody.attempt?.status, 'blocked')
      assert.equal(blockedBody.group.status, 'needs_attention')
      assert.equal(blockedBody.run.state.status, 'blocked')

      const retry = await harness.request(
        'POST',
        '/api/runs/run_parallel_http_attention/parallel-groups/nodes_001_002/items/node_001/retry',
        { requested_by: 'test', reason: 'retry blocked fake item' },
      )
      assert.equal(retry.status, 200)
      const retryBody = bodyAs<TestParallelPreflightEnvelope>(retry)
      assert.equal(retryBody.previous_attempt_id, leaseBody.leases?.[0].attempt_id)
      assert.equal(retryBody.attempt?.status, 'created')
      assert.equal(retryBody.run.state.status, 'ready')

      const retryLease = await harness.request(
        'POST',
        '/api/runs/run_parallel_http_attention/parallel-groups/nodes_001_002/leases',
        { executor_id: 'executor_001', capacity: 1 },
      )
      const retryLeaseBody = bodyAs<TestParallelPreflightEnvelope>(retryLease)
      assert.equal(retryLeaseBody.leases?.[0].attempt_id, retryBody.attempt?.attempt_id)

      const evidenceMissing = await harness.request(
        'POST',
        `/api/runs/run_parallel_http_attention/parallel-groups/nodes_001_002/attempts/${retryLeaseBody.leases?.[0].attempt_id}/result`,
        {
          lease_id: retryLeaseBody.leases?.[0].lease_id,
          attempt_id: retryLeaseBody.leases?.[0].attempt_id,
          launcher_status: 'evidence_missing',
          summary: 'fake launcher could not find status_report.json',
        },
      )
      assert.equal(evidenceMissing.status, 200)
      const missingBody = bodyAs<TestParallelPreflightEnvelope>(evidenceMissing)
      assert.equal(missingBody.attempt?.status, 'evidence_missing')
      assert.equal(missingBody.group.items.find((item) => item.item_id === 'node_001')?.status, 'needs_recovery')
      assert.equal(missingBody.group.status, 'needs_attention')
      assert.equal(missingBody.run.state.status, 'blocked')
    } finally {
      await closeHarness(harness)
    }
  })

  it('preflights and leases only a pending item retry while preserving a completed sibling output', async () => {
    const harness = await startHarness({ store_mode: 'sqlite' })
    try {
      const runId = 'run_parallel_retry_preflight'
      await harness.request('POST', '/api/runs', {
        run_instance_id: runId,
        work_plan: makeParallelFirstPlan(),
      })
      await harness.request('POST', `/api/runs/${runId}/bind`, { binding_kind: 'parallel_only' })
      await harness.request('POST', `/api/runs/${runId}/parallel-groups/nodes_001_002/preflight`)

      const initialLeaseResponse = await harness.request(
        'POST',
        `/api/runs/${runId}/parallel-groups/nodes_001_002/leases`,
        { executor_id: 'executor_001', capacity: 2 },
      )
      const initialLeases = bodyAs<TestParallelPreflightEnvelope>(initialLeaseResponse).leases ?? []
      assert.equal(initialLeases.length, 2)
      const completedLease = initialLeases.find((lease) => lease.item_id === 'node_001')
      const blockedLease = initialLeases.find((lease) => lease.item_id === 'node_002')
      assert.ok(completedLease)
      assert.ok(blockedLease)

      const completedOutput = parallelFirstOutputPath(harness, 'node_001')
      await fs.mkdir(path.dirname(completedOutput), { recursive: true })
      await fs.writeFile(completedOutput, 'retained completed output\n', 'utf8')
      await harness.request(
        'POST',
        `/api/runs/${runId}/parallel-groups/nodes_001_002/attempts/${completedLease.attempt_id}/result`,
        {
          lease_id: completedLease.lease_id,
          attempt_id: completedLease.attempt_id,
          launcher_status: 'completed',
          status_report: {
            run_instance_id: runId,
            step_id: 'derive_nodes_parallel',
            group_id: 'nodes_001_002',
            item_id: 'node_001',
            attempt_id: completedLease.attempt_id,
            status: 'completed',
            summary: 'first item completed',
          },
          sealed_output_path: completedLease.sealed_output_path,
        },
      )
      await harness.request(
        'POST',
        `/api/runs/${runId}/parallel-groups/nodes_001_002/attempts/${blockedLease.attempt_id}/result`,
        {
          lease_id: blockedLease.lease_id,
          attempt_id: blockedLease.attempt_id,
          launcher_status: 'blocked',
          status_report: {
            run_instance_id: runId,
            step_id: 'derive_nodes_parallel',
            group_id: 'nodes_001_002',
            item_id: 'node_002',
            attempt_id: blockedLease.attempt_id,
            status: 'blocked',
            summary: 'second item blocked',
          },
        },
      )

      const noRetryPreflight = bodyAs<TestParallelPreflightEnvelope>(
        await harness.request('POST', `/api/runs/${runId}/parallel-groups/nodes_001_002/preflight`),
      )
      assert.equal(noRetryPreflight.preflight.passed, false)
      assert.ok(
        noRetryPreflight.preflight.errors.some((error) => error.code === 'parallel_group.no_launchable_items'),
      )

      const retryResponse = await harness.request(
        'POST',
        `/api/runs/${runId}/parallel-groups/nodes_001_002/items/node_002/retry`,
        { requested_by: 'test', reason: 'retry only the blocked second item' },
      )
      const retryBody = bodyAs<TestParallelPreflightEnvelope>(retryResponse)
      assert.equal(retryBody.attempt?.status, 'created')

      const retryOutput = parallelFirstOutputPath(harness, 'node_002')
      await fs.mkdir(path.dirname(retryOutput), { recursive: true })
      await fs.writeFile(retryOutput, 'unexpected retry output\n', 'utf8')
      const existingRetryOutputStart = bodyAs<TestParallelPreflightEnvelope>(
        await harness.request('POST', `/api/runs/${runId}/start`),
      )
      assert.equal(existingRetryOutputStart.preflight.passed, false)
      assert.ok(
        existingRetryOutputStart.preflight.errors.some(
          (error) => error.code === 'parallel_group.sealed_output_target_exists',
        ),
      )
      await fs.rm(retryOutput)

      const clearedRetryPreflight = bodyAs<TestParallelPreflightEnvelope>(
        await harness.request('POST', `/api/runs/${runId}/parallel-groups/nodes_001_002/preflight`),
      )
      assert.equal(clearedRetryPreflight.preflight.passed, true)
      assert.equal(clearedRetryPreflight.preflight.launchable_item_count, 1)

      const started = await harness.request('POST', `/api/runs/${runId}/start`)
      assert.equal(started.status, 200)
      const startedBody = bodyAs<TestParallelPreflightEnvelope>(started)
      assert.equal(startedBody.preflight.passed, true)
      assert.equal(startedBody.preflight.launchable_item_count, 1)
      assert.equal(startedBody.run.state.status, 'running')
      assert.equal(startedBody.group.items.find((item) => item.item_id === 'node_001')?.status, 'completed')
      assert.equal(startedBody.group.items.find((item) => item.item_id === 'node_002')?.status, 'pending')
      assert.equal(await fs.readFile(completedOutput, 'utf8'), 'retained completed output\n')

      const retryLeaseResponse = await harness.request(
        'POST',
        `/api/runs/${runId}/parallel-groups/nodes_001_002/leases`,
        { executor_id: 'executor_001', capacity: 1 },
      )
      const retryLeases = bodyAs<TestParallelPreflightEnvelope>(retryLeaseResponse).leases ?? []
      assert.equal(retryLeases.length, 1)
      assert.equal(retryLeases[0]?.item_id, 'node_002')
      assert.equal(retryLeases[0]?.attempt_id, retryBody.attempt?.attempt_id)
      assert.equal(await fs.readFile(completedOutput, 'utf8'), 'retained completed output\n')
    } finally {
      await closeHarness(harness)
    }
  })

  it('keeps aggregate blocked reasons attached to the actual attention item after a later worker completes', async () => {
    const harness = await startHarness({ store_mode: 'sqlite' })
    try {
      await harness.request('POST', '/api/runs', {
        run_instance_id: 'run_parallel_attention_reason',
        work_plan: makeParallelFirstPlan(),
      })
      await harness.request('POST', '/api/runs/run_parallel_attention_reason/bind', {
        binding_kind: 'serial_desktop',
        visible_thread_label: 'Thread One',
      })
      await harness.request(
        'POST',
        '/api/runs/run_parallel_attention_reason/parallel-groups/nodes_001_002/preflight',
      )
      const leaseResponse = await harness.request(
        'POST',
        '/api/runs/run_parallel_attention_reason/parallel-groups/nodes_001_002/leases',
        { executor_id: 'executor_001', capacity: 2 },
      )
      const leaseBody = bodyAs<TestParallelPreflightEnvelope>(leaseResponse)
      const blockedLease = leaseBody.leases?.find((lease) => lease.item_id === 'node_001')
      const completedLease = leaseBody.leases?.find((lease) => lease.item_id === 'node_002')
      assert.ok(blockedLease)
      assert.ok(completedLease)

      const blockedResponse = await harness.request(
        'POST',
        `/api/runs/run_parallel_attention_reason/parallel-groups/nodes_001_002/attempts/${blockedLease.attempt_id}/result`,
        {
          lease_id: blockedLease.lease_id,
          attempt_id: blockedLease.attempt_id,
          launcher_status: 'blocked',
          status_report: {
            run_instance_id: 'run_parallel_attention_reason',
            step_id: 'derive_nodes_parallel',
            group_id: 'nodes_001_002',
            item_id: 'node_001',
            attempt_id: blockedLease.attempt_id,
            status: 'blocked',
            summary: 'node one cannot complete',
          },
        },
      )
      const blockedBody = bodyAs<TestParallelPreflightEnvelope>(blockedResponse)
      assert.equal(blockedBody.run.state.status, 'blocked')
      assert.match(blockedBody.run.state.blocked_reason ?? '', /node_001/)
      assert.match(blockedBody.run.state.blocked_reason ?? '', /status=blocked/)

      const completedResponse = await harness.request(
        'POST',
        `/api/runs/run_parallel_attention_reason/parallel-groups/nodes_001_002/attempts/${completedLease.attempt_id}/result`,
        {
          lease_id: completedLease.lease_id,
          attempt_id: completedLease.attempt_id,
          launcher_status: 'completed',
          status_report: {
            run_instance_id: 'run_parallel_attention_reason',
            step_id: 'derive_nodes_parallel',
            group_id: 'nodes_001_002',
            item_id: 'node_002',
            attempt_id: completedLease.attempt_id,
            status: 'completed',
            summary: 'node two completed',
          },
          sealed_output_path: completedLease.sealed_output_path,
        },
      )
      const completedBody = bodyAs<TestParallelPreflightEnvelope>(completedResponse)
      assert.equal(completedBody.group.status, 'needs_attention')
      assert.equal(completedBody.run.state.status, 'blocked')
      assert.match(completedBody.run.state.blocked_reason ?? '', /node_001/)
      assert.match(completedBody.run.state.blocked_reason ?? '', /status=blocked/)
      assert.doesNotMatch(completedBody.run.state.blocked_reason ?? '', /node_002/)
      assert.doesNotMatch(completedBody.run.state.blocked_reason ?? '', /status=completed/)
    } finally {
      await closeHarness(harness)
    }
  })

  it('recovers stale parallel leases through HTTP without silently retrying or advancing', async () => {
    const harness = await startHarness({ store_mode: 'sqlite' })
    try {
      await harness.request('POST', '/api/runs', {
        run_instance_id: 'run_parallel_http_stale',
        work_plan: makeParallelFirstPlan(),
      })
      await harness.request('POST', '/api/runs/run_parallel_http_stale/bind', { binding_kind: 'serial_desktop', visible_thread_label: 'Thread One' })
      await harness.request('POST', '/api/runs/run_parallel_http_stale/parallel-groups/nodes_001_002/preflight')
      const lease = await harness.request(
        'POST',
        '/api/runs/run_parallel_http_stale/parallel-groups/nodes_001_002/leases',
        { executor_id: 'executor_001', capacity: 1, lease_ttl_ms: 1 },
      )
      const leaseBody = bodyAs<TestParallelPreflightEnvelope>(lease)
      const staleLease = leaseBody.leases?.[0]
      assert.ok(staleLease)
      await fs.mkdir(staleLease.attempt_dir, { recursive: true })

      const recovered = await harness.request(
        'POST',
        '/api/runs/run_parallel_http_stale/parallel-groups/nodes_001_002/leases/recover-stale',
        { observed_at: '2099-01-01T00:00:00.000Z' },
      )

      assert.equal(recovered.status, 200)
      const recoveredBody = bodyAs<TestParallelPreflightEnvelope>(recovered)
      assert.equal(recoveredBody.recovered_count, 1)
      assert.deepEqual(recoveredBody.stale_lease_ids, [leaseBody.leases?.[0].lease_id])
      assert.deepEqual(recoveredBody.stale_attempt_ids, [leaseBody.leases?.[0].attempt_id])
      assert.deepEqual(recoveredBody.stale_item_ids, ['node_001'])
      assert.deepEqual(recoveredBody.requeued_lease_ids, [])
      assert.deepEqual(recoveredBody.attention_lease_ids, [leaseBody.leases?.[0].lease_id])
      assert.equal(recoveredBody.group.status, 'needs_attention')
      assert.equal(recoveredBody.group.leases[0].status, 'expired')
      assert.equal(recoveredBody.group.attempts[0].status, 'stale')
      assert.equal(recoveredBody.group.items.find((item) => item.item_id === 'node_001')?.status, 'needs_recovery')
      assert.equal(recoveredBody.run.state.status, 'blocked')
      assert.match(recoveredBody.run.state.blocked_reason ?? '', /stale lease/)
    } finally {
      await closeHarness(harness)
    }
  })

  it('automatically requeues an expired HTTP lease when launch never created its attempt directory', async () => {
    const harness = await startHarness({ store_mode: 'sqlite' })
    try {
      await harness.request('POST', '/api/runs', {
        run_instance_id: 'run_parallel_http_never_launched',
        work_plan: makeParallelFirstPlan(),
      })
      await harness.request('POST', '/api/runs/run_parallel_http_never_launched/bind', {
        binding_kind: 'serial_desktop',
        visible_thread_label: 'Thread One',
      })
      await harness.request(
        'POST',
        '/api/runs/run_parallel_http_never_launched/parallel-groups/nodes_001_002/preflight',
      )
      const leaseResponse = await harness.request(
        'POST',
        '/api/runs/run_parallel_http_never_launched/parallel-groups/nodes_001_002/leases',
        { executor_id: 'executor_001', capacity: 1 },
      )
      const leaseBody = bodyAs<TestParallelPreflightEnvelope>(leaseResponse)
      const firstLease = leaseBody.leases?.[0]
      assert.ok(firstLease)
      assert.equal(Date.parse(firstLease.expires_at ?? '') - Date.parse(firstLease.leased_at), 300_000)
      await assert.rejects(fs.stat(firstLease.attempt_dir))

      const recoveredResponse = await harness.request(
        'POST',
        '/api/runs/run_parallel_http_never_launched/parallel-groups/nodes_001_002/leases/recover-stale',
        { observed_at: '2099-01-01T00:00:00.000Z' },
      )
      const recoveredBody = bodyAs<TestParallelPreflightEnvelope>(recoveredResponse)
      assert.equal(recoveredResponse.status, 200)
      assert.deepEqual(recoveredBody.requeued_lease_ids, [firstLease.lease_id])
      assert.deepEqual(recoveredBody.attention_lease_ids, [])
      assert.equal(recoveredBody.group.attempts[0].status, 'created')
      assert.equal(recoveredBody.group.items.find((item) => item.item_id === firstLease.item_id)?.status, 'pending')
      assert.equal(recoveredBody.run.state.status, 'running')
      assert.equal(recoveredBody.run.state.blocked_reason, undefined)

      const secondLeaseResponse = await harness.request(
        'POST',
        '/api/runs/run_parallel_http_never_launched/parallel-groups/nodes_001_002/leases',
        { executor_id: 'executor_001', capacity: 1 },
      )
      const secondLease = bodyAs<TestParallelPreflightEnvelope>(secondLeaseResponse).leases?.[0]
      assert.equal(secondLease?.attempt_id, firstLease.attempt_id)
      assert.notEqual(secondLease?.lease_id, firstLease.lease_id)
    } finally {
      await closeHarness(harness)
    }
  })

  it('cancels active parallel attempts through HTTP without advancing the group', async () => {
    const harness = await startHarness({ store_mode: 'sqlite' })
    try {
      await harness.request('POST', '/api/runs', {
        run_instance_id: 'run_parallel_http_cancel',
        work_plan: makeParallelFirstPlan(),
      })
      await harness.request('POST', '/api/runs/run_parallel_http_cancel/bind', { binding_kind: 'serial_desktop', visible_thread_label: 'Thread One' })
      await harness.request('POST', '/api/runs/run_parallel_http_cancel/parallel-groups/nodes_001_002/preflight')
      const lease = await harness.request(
        'POST',
        '/api/runs/run_parallel_http_cancel/parallel-groups/nodes_001_002/leases',
        { executor_id: 'executor_001', capacity: 1 },
      )
      const leaseBody = bodyAs<TestParallelPreflightEnvelope>(lease)

      const cancelled = await harness.request(
        'POST',
        `/api/runs/run_parallel_http_cancel/parallel-groups/nodes_001_002/attempts/${leaseBody.leases?.[0].attempt_id}/cancel`,
        { lease_id: leaseBody.leases?.[0].lease_id, reason: 'operator cancelled smoke attempt' },
      )

      assert.equal(cancelled.status, 200)
      const cancelledBody = bodyAs<TestParallelPreflightEnvelope>(cancelled)
      assert.equal(cancelledBody.attempt?.status, 'cancelled')
      assert.equal(cancelledBody.group.status, 'needs_attention')
      assert.equal(cancelledBody.group.leases[0].status, 'cancelled')
      assert.equal(cancelledBody.group.items.find((item) => item.item_id === 'node_001')?.status, 'needs_recovery')
      assert.equal(cancelledBody.group.items.find((item) => item.item_id === 'node_002')?.status, 'pending')
      assert.equal(cancelledBody.run.state.status, 'blocked')
    } finally {
      await closeHarness(harness)
    }
  })

  it('creates and advances serial runs through the SQLite-backed store boundary', async () => {
    const harness = await startHarness({ store_mode: 'sqlite' })
    try {
      const created = await harness.request('POST', '/api/runs', {
        run_instance_id: 'run_sqlite_api_loop',
        work_plan: makePlan(),
        automation: { auto_pickup: true },
      })
      assert.equal(created.status, 201)

      const listed = await harness.request('GET', '/api/runs')
      assert.equal(listed.status, 200)
      assert.equal(
        bodyAs<{ runs: Array<{ run_instance_id: string }> }>(listed).runs.some(
          (run) => run.run_instance_id === 'run_sqlite_api_loop',
        ),
        true,
      )

      const bound = await harness.request('POST', '/api/runs/run_sqlite_api_loop/bind', { binding_kind: 'serial_desktop', visible_thread_label: 'Thread SQLite' })
      assert.equal(bound.status, 200)

      const started = await harness.request('POST', '/api/runs/run_sqlite_api_loop/start')
      assert.equal(started.status, 200)
      assert.equal(harness.desktop_adapter.sent_prompts.length, 1)
      await harness.request(
        'POST',
        '/api/runs/run_sqlite_api_loop/start-report',
        startReport('run_sqlite_api_loop', bodyAs<TestRunEnvelope>(started)),
      )

      const returned = await harness.request('POST', '/api/runs/run_sqlite_api_loop/return', {
        ...statusReport('run_sqlite_api_loop', 'derive_item_001'),
      })
      assert.equal(returned.status, 200)
      const returnedBody = bodyAs<TestRunEnvelope>(returned)
      assert.equal(returnedBody.run.state.status, 'ready')
      assert.equal(returnedBody.run.state.current_step_id, 'derive_item_002')

      const diagnostics = await harness.request('GET', '/api/runs/run_sqlite_api_loop/diagnostics')
      assert.equal(diagnostics.status, 200)
      const diagnosticsBody = bodyAs<TestDiagnosticsEnvelope>(diagnostics)
      assert.equal(diagnosticsBody.diagnostics.latest_files.prompt.includes('prompts/'), true)
      await assert.doesNotReject(fs.access(path.join(harness.contract_root, 'protocol_runner.sqlite')))
    } finally {
      await closeHarness(harness)
    }
  })

  it('explicit closeout cleans relay binding and deletes runner-owned artifacts', async () => {
    const harness = await startHarness()
    try {
      await harness.request('POST', '/api/runs', { run_instance_id: 'run_closeout', work_plan: makePlan() })
      await harness.request('POST', '/api/runs/run_closeout/bind', { binding_kind: 'serial_desktop', visible_thread_label: 'Thread One' })
      await harness.request('POST', '/api/runs/run_closeout/fail', { reason: 'test closeout' })

      const runDir = path.resolve(harness.temp_root, 'run_closeout')
      await assert.doesNotReject(fs.access(runDir))

      const closed = await harness.request('POST', '/api/runs/run_closeout/close')
      assert.equal(closed.status, 200)
      const closeBody = bodyAs<TestCloseoutEnvelope>(closed)
      assert.equal(closeBody.closeout.run_instance_id, 'run_closeout')
      assert.equal(closeBody.closeout.relay_cleanup?.ok, true)
      assert.equal(closeBody.closeout.relay_cleanup?.cleanup_state, 'cleaned_up')
      assert.equal(closeBody.closeout.sealed_output_cleanup.requested, false)
      assert.equal(closeBody.closeout.sealed_output_cleanup.target_count, 0)
      assert.equal(closeBody.closeout.artifact_cleanup.deleted, true)
      assert.equal(closeBody.closeout.artifact_cleanup.run_dir, runDir)
      assert.equal(harness.relay_adapter.closed_bindings.length, 1)
      assert.equal(harness.relay_adapter.closed_bindings[0].channel_id, 'fake_channel_run_closeout')

      await assert.rejects(fs.access(runDir))

      const missing = await harness.request('GET', '/api/runs/run_closeout')
      assert.equal(missing.status, 404)
      const list = await harness.request('GET', '/api/runs')
      const listBody = bodyAs<{ runs: Array<{ run_instance_id: string }> }>(list)
      assert.equal(listBody.runs.some((run) => run.run_instance_id === 'run_closeout'), false)
    } finally {
      await closeHarness(harness)
    }
  })

  it('supports draft fail-close cleanup and same-id recreation through the canonical API policy', async () => {
    const harness = await startHarness({ store_mode: 'sqlite' })
    try {
      const create = async () =>
        harness.request('POST', '/api/runs', {
          run_instance_id: 'run_draft_cleanup',
          work_plan: makePlan(),
        })

      assert.equal((await create()).status, 201)
      const draftDiagnostics = bodyAs<TestDiagnosticsEnvelope>(
        await harness.request('GET', '/api/runs/run_draft_cleanup/diagnostics'),
      )
      assert.equal(
        draftDiagnostics.diagnostics.next_allowed_actions.find((action) => action.action === 'fail')?.enabled,
        true,
      )
      assert.equal(
        draftDiagnostics.diagnostics.next_allowed_actions.find((action) => action.action === 'close')?.enabled,
        false,
      )
      assert.equal((await harness.request('POST', '/api/runs/run_draft_cleanup/pause')).status, 409)

      const failed = await harness.request('POST', '/api/runs/run_draft_cleanup/fail', {
        reason: 'discard unused draft',
      })
      assert.equal(failed.status, 200)
      assert.equal(bodyAs<TestRunEnvelope>(failed).run.state.status, 'failed')
      assert.equal((await harness.request('POST', '/api/runs/run_draft_cleanup/fail', { reason: 'again' })).status, 409)

      const failedDiagnostics = bodyAs<TestDiagnosticsEnvelope>(
        await harness.request('GET', '/api/runs/run_draft_cleanup/diagnostics'),
      )
      assert.equal(
        failedDiagnostics.diagnostics.next_allowed_actions.find((action) => action.action === 'fail')?.enabled,
        false,
      )
      assert.equal(
        failedDiagnostics.diagnostics.next_allowed_actions.find((action) => action.action === 'close')?.enabled,
        true,
      )

      assert.equal((await harness.request('POST', '/api/runs/run_draft_cleanup/close')).status, 200)
      assert.equal((await harness.request('GET', '/api/runs/run_draft_cleanup')).status, 404)
      assert.equal((await create()).status, 201)
      assert.equal(
        bodyAs<TestRunEnvelope>(await harness.request('GET', '/api/runs/run_draft_cleanup')).run.state.status,
        'draft',
      )
      await harness.request('POST', '/api/runs/run_draft_cleanup/fail', { reason: 'test cleanup' })
      await harness.request('POST', '/api/runs/run_draft_cleanup/close')
    } finally {
      await closeHarness(harness)
    }
  })

  it('preserves a manual fail issued while Desktop prompt dispatch is in flight', async () => {
    const desktopAdapter = new DeferredFakeCodexDesktopAdapter()
    const harness = await startHarness({ desktop_adapter: desktopAdapter })
    try {
      await harness.request('POST', '/api/runs', {
        run_instance_id: 'run_fail_during_dispatch',
        work_plan: makePlan(),
      })
      await harness.request('POST', '/api/runs/run_fail_during_dispatch/bind', {
        binding_kind: 'serial_desktop',
        visible_thread_label: 'Dispatch Test',
      })

      const startRequest = harness.request('POST', '/api/runs/run_fail_during_dispatch/start')
      let observedStatus = ''
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const current = await harness.request('GET', '/api/runs/run_fail_during_dispatch')
        observedStatus = bodyAs<TestRunEnvelope>(current).run.state.status
        if (observedStatus === 'dispatching_prompt') {
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      assert.equal(observedStatus, 'dispatching_prompt')

      const failed = await harness.request('POST', '/api/runs/run_fail_during_dispatch/fail', {
        reason: 'operator stopped in-flight dispatch',
      })
      assert.equal(failed.status, 200)
      assert.equal(bodyAs<TestRunEnvelope>(failed).run.state.status, 'failed')

      desktopAdapter.release()
      const completedSend = await startRequest
      assert.equal(completedSend.status, 200)
      assert.equal(bodyAs<TestRunEnvelope>(completedSend).run.state.status, 'failed')
      const latest = await harness.request('GET', '/api/runs/run_fail_during_dispatch')
      assert.equal(bodyAs<TestRunEnvelope>(latest).run.state.status, 'failed')

      const runEvents = bodyAs<TestEventsEnvelope>(
        await harness.request('GET', '/api/runs/run_fail_during_dispatch/events'),
      )
      assert.equal(runEvents.events.some((event) => event.event_type === 'diagnostic'), true)
      await harness.request('POST', '/api/runs/run_fail_during_dispatch/close')
    } finally {
      desktopAdapter.release()
      await closeHarness(harness)
    }
  })

  it('preserves disjoint declared parallel sealed outputs during normal closeout', async () => {
    const harness = await startHarness({ store_mode: 'sqlite' })
    try {
      await harness.request('POST', '/api/runs', { run_instance_id: 'run_parallel_first', work_plan: makeParallelFirstPlan() })
      await harness.request('POST', '/api/runs/run_parallel_first/fail', { reason: 'test closeout' })

      const outputPath = parallelFirstOutputPath(harness, 'node_001')
      const runDir = path.join(harness.temp_root, 'run_parallel_first')
      await fs.mkdir(path.dirname(outputPath), { recursive: true })
      await fs.writeFile(outputPath, 'sealed output\n', 'utf8')

      const closed = await harness.request('POST', '/api/runs/run_parallel_first/close')
      assert.equal(closed.status, 200)
      const closeBody = bodyAs<TestCloseoutEnvelope>(closed)
      assert.equal(closeBody.closeout.sealed_output_cleanup.requested, false)
      assert.equal(closeBody.closeout.artifact_cleanup.deleted, true)
      await assert.doesNotReject(fs.access(outputPath))
      await assert.rejects(fs.access(runDir))
    } finally {
      await closeHarness(harness)
    }
  })

  it('blocks a recreated run before it can overwrite a retained declared primary output', async () => {
    const harness = await startHarness({ store_mode: 'sqlite' })
    try {
      const runId = 'run_parallel_retained_output_reuse'
      const sealedOutputBaseDir = `artifacts/protocol_runner/sealed_outputs/${runId}/items`
      const workPlan = makeParallelFirstPlan(sealedOutputBaseDir)
      await harness.request('POST', '/api/runs', { run_instance_id: runId, work_plan: workPlan })
      await harness.request('POST', `/api/runs/${runId}/fail`, { reason: 'retain first-run output' })

      const retainedOutput = path.join(
        harness.contract_root,
        sealedOutputBaseDir,
        'node_001',
        'output.md',
      )
      await fs.mkdir(path.dirname(retainedOutput), { recursive: true })
      await fs.writeFile(retainedOutput, 'retained first-run output\n', 'utf8')
      assert.equal((await harness.request('POST', `/api/runs/${runId}/close`)).status, 200)

      const recreated = await harness.request('POST', '/api/runs', {
        run_instance_id: runId,
        work_plan: workPlan,
      })
      assert.equal(recreated.status, 201)
      await harness.request('POST', `/api/runs/${runId}/bind`, { binding_kind: 'parallel_only' })
      const preflight = await harness.request(
        'POST',
        `/api/runs/${runId}/parallel-groups/nodes_001_002/preflight`,
      )
      assert.equal(preflight.status, 200)
      const preflightBody = bodyAs<TestParallelPreflightEnvelope>(preflight)
      assert.equal(preflightBody.preflight.passed, false)
      assert.ok(
        preflightBody.preflight.errors.some(
          (error) => error.code === 'parallel_group.sealed_output_target_exists',
        ),
      )
      assert.equal(await fs.readFile(retainedOutput, 'utf8'), 'retained first-run output\n')
      assert.equal(harness.desktop_adapter.sent_prompts.length, 0)
    } finally {
      await closeHarness(harness)
    }
  })

  it('closes a legacy overlapping run when its descendant sealed-output root is absent', async () => {
    const harness = await startHarness({ store_mode: 'sqlite' })
    try {
      const runId = 'run_parallel_empty_legacy_overlap'
      const overlappingBaseDir = `runs/${runId}/groups/nodes_001_002/items`
      await harness.request('POST', '/api/runs', {
        run_instance_id: runId,
        work_plan: makeParallelFirstPlan(overlappingBaseDir),
      })
      await harness.request('POST', `/api/runs/${runId}/fail`, { reason: 'empty legacy closeout' })

      const outputBaseDir = path.join(harness.temp_root, runId, 'groups', 'nodes_001_002', 'items')
      await assert.rejects(fs.access(outputBaseDir))
      const closed = await harness.request('POST', `/api/runs/${runId}/close`)
      assert.equal(closed.status, 200)
      assert.equal(bodyAs<TestCloseoutEnvelope>(closed).closeout.artifact_cleanup.deleted, true)
      await assert.rejects(fs.access(path.join(harness.temp_root, runId)))
    } finally {
      await closeHarness(harness)
    }
  })

  it('refuses closeout when a legacy sealed-output root is an ancestor of the run directory', async () => {
    const harness = await startHarness({ store_mode: 'sqlite' })
    try {
      const runId = 'run_parallel_legacy_output_ancestor'
      await harness.request('POST', '/api/runs', {
        run_instance_id: runId,
        work_plan: makeParallelFirstPlan('runs'),
      })
      await harness.request('POST', `/api/runs/${runId}/fail`, { reason: 'legacy ancestor guard' })

      const closed = await harness.request('POST', `/api/runs/${runId}/close`)
      assert.equal(closed.status, 409)
      assert.equal(
        bodyAs<{ error: { code: string } }>(closed).error.code,
        'closeout.sealed_output_run_dir_overlap',
      )
      await assert.doesNotReject(fs.access(path.join(harness.temp_root, runId)))
    } finally {
      await closeHarness(harness)
    }
  })

  it('refuses closeout before deleting legacy sealed outputs that overlap the run directory', async () => {
    const harness = await startHarness({ store_mode: 'sqlite' })
    try {
      const runId = 'run_parallel_legacy_overlap'
      const overlappingBaseDir = `runs/${runId}/groups/nodes_001_002/items`
      await harness.request('POST', '/api/runs', {
        run_instance_id: runId,
        work_plan: makeParallelFirstPlan(overlappingBaseDir),
      })
      await harness.request('POST', `/api/runs/${runId}/fail`, { reason: 'test closeout guard' })

      const outputPath = path.join(
        harness.temp_root,
        runId,
        'groups',
        'nodes_001_002',
        'items',
        'node_001',
        'output.md',
      )
      await fs.mkdir(path.dirname(outputPath), { recursive: true })
      await fs.writeFile(outputPath, 'legacy sealed output\n', 'utf8')

      const closed = await harness.request('POST', `/api/runs/${runId}/close`)
      assert.equal(closed.status, 409)
      assert.equal(
        bodyAs<{ error: { code: string } }>(closed).error.code,
        'closeout.sealed_output_run_dir_overlap',
      )
      await assert.doesNotReject(fs.access(outputPath))
      const retained = await harness.request('GET', `/api/runs/${runId}`)
      assert.equal(retained.status, 200)
      assert.equal(bodyAs<TestRunEnvelope>(retained).run.state.status, 'failed')
    } finally {
      await closeHarness(harness)
    }
  })

  it('closes a legacy descendant overlap when explicit cleanup removes every declared primary output', async () => {
    const harness = await startHarness({ store_mode: 'sqlite' })
    try {
      const runId = 'run_parallel_legacy_explicit_cleanup'
      const overlappingBaseDir = `runs/${runId}/groups/nodes_001_002/items`
      await harness.request('POST', '/api/runs', {
        run_instance_id: runId,
        work_plan: makeParallelFirstPlan(overlappingBaseDir),
      })
      await harness.request('POST', `/api/runs/${runId}/fail`, { reason: 'explicit legacy cleanup' })

      const firstOutput = path.join(harness.contract_root, overlappingBaseDir, 'node_001', 'output.md')
      const secondOutput = path.join(harness.contract_root, overlappingBaseDir, 'node_002', 'output.md')
      await fs.mkdir(path.dirname(firstOutput), { recursive: true })
      await fs.mkdir(path.dirname(secondOutput), { recursive: true })
      await fs.writeFile(firstOutput, 'legacy sealed output 1\n', 'utf8')
      await fs.writeFile(secondOutput, 'legacy sealed output 2\n', 'utf8')

      const closed = await harness.request('POST', `/api/runs/${runId}/close`, {
        delete_sealed_outputs: true,
      })
      assert.equal(closed.status, 200)
      const closeBody = bodyAs<TestCloseoutEnvelope>(closed)
      assert.equal(closeBody.closeout.sealed_output_cleanup.deleted_files, 2)
      assert.equal(closeBody.closeout.artifact_cleanup.deleted, true)
      await assert.rejects(fs.access(path.join(harness.temp_root, runId)))
    } finally {
      await closeHarness(harness)
    }
  })

  it('refuses legacy run retirement after explicit cleanup when undeclared output remains', async () => {
    const harness = await startHarness({ store_mode: 'sqlite' })
    try {
      const runId = 'run_parallel_legacy_undeclared_output'
      const overlappingBaseDir = `runs/${runId}/groups/nodes_001_002/items`
      await harness.request('POST', '/api/runs', {
        run_instance_id: runId,
        work_plan: makeParallelFirstPlan(overlappingBaseDir),
      })
      await harness.request('POST', `/api/runs/${runId}/fail`, { reason: 'undeclared legacy output' })

      const firstOutput = path.join(harness.contract_root, overlappingBaseDir, 'node_001', 'output.md')
      const secondOutput = path.join(harness.contract_root, overlappingBaseDir, 'node_002', 'output.md')
      const undeclaredOutput = path.join(path.dirname(firstOutput), 'keep.md')
      await fs.mkdir(path.dirname(firstOutput), { recursive: true })
      await fs.mkdir(path.dirname(secondOutput), { recursive: true })
      await fs.writeFile(firstOutput, 'legacy sealed output 1\n', 'utf8')
      await fs.writeFile(secondOutput, 'legacy sealed output 2\n', 'utf8')
      await fs.writeFile(undeclaredOutput, 'undeclared retained output\n', 'utf8')

      const closed = await harness.request('POST', `/api/runs/${runId}/close`, {
        delete_sealed_outputs: true,
      })
      assert.equal(closed.status, 409)
      const closeError = bodyAs<{
        error: { code: string; details: { sealed_output_cleanup: { deleted_files: number } } }
      }>(closed)
      assert.equal(closeError.error.code, 'closeout.sealed_output_run_dir_overlap')
      assert.equal(closeError.error.details.sealed_output_cleanup.deleted_files, 2)
      await assert.rejects(fs.access(firstOutput))
      await assert.rejects(fs.access(secondOutput))
      await assert.doesNotReject(fs.access(undeclaredOutput))
      const retained = await harness.request('GET', `/api/runs/${runId}`)
      assert.equal(bodyAs<TestRunEnvelope>(retained).run.state.status, 'failed')
    } finally {
      await closeHarness(harness)
    }
  })

  it('rejects a final output symlink at preflight but unlinks it safely during explicit cleanup', async () => {
    const harness = await startHarness({ store_mode: 'sqlite' })
    const externalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'protocol-runner-final-output-link-'))
    try {
      const runId = 'run_parallel_final_output_symlink'
      const sealedOutputBaseDir = `artifacts/protocol_runner/sealed_outputs/${runId}/items`
      await harness.request('POST', '/api/runs', {
        run_instance_id: runId,
        work_plan: makeParallelFirstPlan(sealedOutputBaseDir),
      })

      const finalOutputLink = path.join(
        harness.contract_root,
        sealedOutputBaseDir,
        'node_001',
        'output.md',
      )
      const externalSentinel = path.join(externalRoot, 'keep.md')
      await fs.mkdir(path.dirname(finalOutputLink), { recursive: true })
      await fs.writeFile(externalSentinel, 'external target remains\n', 'utf8')
      await fs.symlink(externalSentinel, finalOutputLink, 'file')

      await harness.request('POST', `/api/runs/${runId}/bind`, { binding_kind: 'parallel_only' })
      const preflight = await harness.request(
        'POST',
        `/api/runs/${runId}/parallel-groups/nodes_001_002/preflight`,
      )
      assert.equal(preflight.status, 200)
      const preflightBody = bodyAs<TestParallelPreflightEnvelope>(preflight)
      assert.equal(preflightBody.preflight.passed, false)
      assert.ok(
        preflightBody.preflight.errors.some(
          (error) => error.code === 'parallel_group.sealed_output_target_exists',
        ),
      )
      await harness.request('POST', `/api/runs/${runId}/fail`, { reason: 'final output link cleanup' })

      const closed = await harness.request('POST', `/api/runs/${runId}/close`, {
        delete_sealed_outputs: true,
      })
      assert.equal(closed.status, 200)
      const closeBody = bodyAs<TestCloseoutEnvelope>(closed)
      assert.equal(closeBody.closeout.sealed_output_cleanup.deleted_files, 1)
      assert.equal(closeBody.closeout.sealed_output_cleanup.missing_files, 1)
      await assert.rejects(fs.access(finalOutputLink))
      await assert.doesNotReject(fs.access(externalSentinel))
    } finally {
      try {
        await closeHarness(harness)
      } finally {
        await fs.rm(externalRoot, { recursive: true, force: true })
      }
    }
  })

  it('deletes declared parallel sealed outputs only when explicitly requested', async () => {
    const harness = await startHarness()
    try {
      await harness.request('POST', '/api/runs', { run_instance_id: 'run_parallel_first', work_plan: makeParallelFirstPlan() })
      await harness.request('POST', '/api/runs/run_parallel_first/fail', { reason: 'test closeout' })

      const firstOutput = parallelFirstOutputPath(harness, 'node_001')
      const secondOutput = parallelFirstOutputPath(harness, 'node_002')
      const undeclaredSibling = path.join(path.dirname(firstOutput), 'keep.md')
      await fs.mkdir(path.dirname(firstOutput), { recursive: true })
      await fs.mkdir(path.dirname(secondOutput), { recursive: true })
      await fs.writeFile(firstOutput, 'sealed output 1\n', 'utf8')
      await fs.writeFile(secondOutput, 'sealed output 2\n', 'utf8')
      await fs.writeFile(undeclaredSibling, 'not declared for cleanup\n', 'utf8')

      const closed = await harness.request('POST', '/api/runs/run_parallel_first/close', { delete_sealed_outputs: true })
      assert.equal(closed.status, 200)
      const closeBody = bodyAs<TestCloseoutEnvelope>(closed)
      assert.equal(closeBody.closeout.sealed_output_cleanup.requested, true)
      assert.equal(closeBody.closeout.sealed_output_cleanup.target_count, 2)
      assert.equal(closeBody.closeout.sealed_output_cleanup.deleted_files, 2)
      assert.equal(closeBody.closeout.sealed_output_cleanup.missing_files, 0)
      assert.deepEqual(
        closeBody.closeout.sealed_output_cleanup.targets.map((target) => [target.item_id, target.deleted, target.missing]),
        [
          ['node_001', true, false],
          ['node_002', true, false],
        ],
      )
      await assert.rejects(fs.access(firstOutput))
      await assert.rejects(fs.access(secondOutput))
      await assert.doesNotReject(fs.access(undeclaredSibling))
    } finally {
      await closeHarness(harness)
    }
  })
})
