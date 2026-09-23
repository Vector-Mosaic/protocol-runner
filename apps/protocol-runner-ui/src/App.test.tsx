import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { App } from './App'

const runState = {
  schema_version: 'protocol_runner.run_state.v1',
  run_instance_id: 'run_protocol_ui',
  work_plan_path: 'artifacts/protocol_runner/runs/run_protocol_ui/work_plan.json',
  status: 'waiting_for_completion_report',
  current_step_id: 'derive_item_001',
  current_step_ordinal: 1,
  automation: {
    auto_pickup: true,
    auto_advance: false,
  },
  thread_binding: {
    binding_kind: 'serial_desktop',
    visible_thread_label: 'Test Codex thread',
    relay_channel_id: 'channel_001',
    relay_channel_name: 'runner-run-protocol-ui',
    binding_id: 'binding_001',
    cleanup_state: 'active',
  },
  last_sent_prompt_message_id: 'prompt_msg_001',
  timestamps: {
    created_at: '2026-06-25T15:00:00.000Z',
    updated_at: '2026-06-25T15:01:00.000Z',
    started_at: '2026-06-25T15:01:00.000Z',
  },
}

const workPlan = {
  schema_version: 'protocol_runner.work_plan.v1',
  run_title: 'Protocol seed run',
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
      prompt_template: 'generic_step',
      on_completed: { action: 'next' },
      on_blocked: { action: 'pause' },
    },
  ],
}

const run = {
  run_instance_id: 'run_protocol_ui',
  state: runState,
  work_plan: workPlan,
}

const actions = [
  { action: 'validate', enabled: false, reason: 'validate is not allowed while run status is waiting_for_completion_report.' },
  { action: 'bind-thread', enabled: false, reason: 'bind-thread is not allowed while run status is waiting_for_completion_report.' },
  { action: 'start', enabled: false, reason: 'start is not allowed while run status is waiting_for_completion_report.' },
  { action: 'pause', enabled: true, reason: 'pause is allowed while run status is waiting_for_completion_report.' },
  { action: 'resume', enabled: false, reason: 'resume is not allowed while run status is waiting_for_completion_report.' },
  {
    action: 'retry-current',
    enabled: false,
    reason: 'retry-current is not allowed while run status is waiting_for_completion_report.',
  },
  { action: 'fail', enabled: true, reason: 'fail is allowed while run status is waiting_for_completion_report.' },
  { action: 'close', enabled: false, reason: 'close is not allowed while run status is waiting_for_completion_report.' },
  {
    action: 'accept-return',
    enabled: true,
    reason: 'Runner is waiting for a structured status report from the current step.',
  },
  { action: 'refresh', enabled: true, reason: 'refresh is allowed while run status is waiting_for_completion_report.' },
]

const policyActionNames = [
  'validate',
  'bind-thread',
  'start',
  'pause',
  'resume',
  'retry-current',
  'fail',
  'close',
  'accept-return',
  'refresh',
] as const

const policyEnabledActions = {
  draft: ['validate', 'bind-thread', 'fail', 'refresh'],
  bound: ['validate', 'bind-thread', 'start', 'fail', 'refresh'],
  ready: ['validate', 'start', 'pause', 'fail', 'refresh'],
  completed: ['validate', 'close', 'refresh'],
  failed: ['validate', 'close', 'refresh'],
} as const

const runDiagnostics = {
  run_instance_id: 'run_protocol_ui',
  status: 'waiting_for_completion_report',
  current_step_id: 'derive_item_001',
  current_step_ordinal: 1,
  automation: {
    auto_pickup: true,
    auto_advance: false,
  },
  next_allowed_actions: actions,
  last_event: {
    event_id: 'event_002',
    event_type: 'prompt_sent',
    run_instance_id: 'run_protocol_ui',
    step_id: 'derive_item_001',
    timestamp: '2026-06-25T15:01:00.000Z',
    details: { send_status: 'sent' },
  },
  parallel_groups: [],
  latest_files: {
    step: 'steps/0001_derive_item_001.json',
    prompt: 'prompts/0001_derive_item_001.attempt_001.md',
    start: 'starts/0001_derive_item_001.attempt_001.json',
    status: 'status/0001_derive_item_001.attempt_001.json',
  },
  evidence_paths: {
    run_dir: 'artifacts/protocol_runner/runs/run_protocol_ui',
    work_plan_path: 'artifacts/protocol_runner/runs/run_protocol_ui/work_plan.json',
    state_path: 'artifacts/protocol_runner/runs/run_protocol_ui/state.json',
    events_path: 'artifacts/protocol_runner/runs/run_protocol_ui/events.jsonl',
    latest_files: {},
  },
}

const policyFixtures = Object.entries(policyEnabledActions).map(([status, enabledActions]) => {
  const run_instance_id = `run_policy_${status}`
  const state = {
    ...runState,
    run_instance_id,
    status,
    thread_binding: null,
  }
  const fixtureRun = {
    run_instance_id,
    state,
    work_plan: {
      ...workPlan,
      run_title: `Policy ${status} run`,
    },
  }
  return {
    run_instance_id,
    status,
    run: fixtureRun,
    list_item: {
      run_instance_id,
      status,
      current_step_id: state.current_step_id,
      current_step_ordinal: state.current_step_ordinal,
      automation: state.automation,
      updated_at: state.timestamps.updated_at,
    },
    diagnostics: {
      ...runDiagnostics,
      run_instance_id,
      status,
      next_allowed_actions: policyActionNames.map((action) => ({
        action,
        enabled: (enabledActions as readonly string[]).includes(action),
        reason: `${action} is ${(enabledActions as readonly string[]).includes(action) ? '' : 'not '}allowed while run status is ${status}.`,
      })),
    },
  }
})

const parallelRunState = {
  schema_version: 'protocol_runner.run_state.v1',
  run_instance_id: 'run_parallel_ui',
  work_plan_path: 'artifacts/protocol_runner/runs/run_parallel_ui/work_plan.json',
  status: 'running',
  current_step_id: 'parallel_nodes_001',
  current_step_ordinal: 1,
  automation: {
    auto_pickup: true,
    auto_advance: true,
  },
  thread_binding: null,
  timestamps: {
    created_at: '2026-06-29T15:00:00.000Z',
    updated_at: '2026-06-29T15:03:00.000Z',
    started_at: '2026-06-29T15:01:00.000Z',
  },
}

const parallelWorkPlan = {
  schema_version: 'protocol_runner.work_plan.v1',
  run_title: 'Parallel seed run',
  execution_mode: 'mixed',
  default_contract: {
    title: 'Default Contract',
    path: 'docs/contracts/Default.md',
  },
  steps: [
    {
      step_id: 'parallel_nodes_001',
      step_kind: 'parallel_group',
      group_id: 'node_group',
      executor: 'protocol-runner-parallel-executor',
      contract_ref: 'docs/contracts/Parallel_Contract.md',
      max_concurrency: 2,
      sealed_output_defaults: {
        base_dir: 'artifacts/outputs',
        primary_artifact: 'output.md',
      },
      items: [
        {
          item_id: 'node_001',
          label: 'Node one',
          input_ref: 'artifacts/input/node_001.md',
        },
        {
          item_id: 'node_002',
          label: 'Node two',
          input_ref: 'artifacts/input/node_002.md',
        },
      ],
      on_completed: { action: 'stop' },
      on_blocked: { action: 'pause' },
    },
  ],
}

const parallelGroup = {
  run_instance_id: 'run_parallel_ui',
  step_id: 'parallel_nodes_001',
  group_id: 'node_group',
  ordinal: 1,
  status: 'running',
  executor: 'protocol-runner-parallel-executor',
  contract_ref: 'docs/contracts/Parallel_Contract.md',
  max_concurrency: 2,
  preflight_status: 'passed',
  checked_at: '2026-06-29T15:00:30.000Z',
  checked_by: 'protocol-runner-api',
  preflight_errors: [],
  preflight_warnings: [
    {
      code: 'parallel_group.smoke_warning',
      status: 'warning',
      message: 'Smoke warning for dashboard rendering.',
      path: '$.steps[0]',
    },
  ],
  preflight_result: null,
  items: [
    {
      run_instance_id: 'run_parallel_ui',
      step_id: 'parallel_nodes_001',
      group_id: 'node_group',
      item_id: 'node_001',
      label: 'Node one',
      status: 'completed',
      input_ref: 'artifacts/input/node_001.md',
      contract_ref: 'docs/contracts/Parallel_Contract.md',
      sealed_output_target: 'artifacts/outputs/node_001/output.md',
      latest_attempt_id: 'node_group_node_001_attempt_001',
    },
    {
      run_instance_id: 'run_parallel_ui',
      step_id: 'parallel_nodes_001',
      group_id: 'node_group',
      item_id: 'node_002',
      label: 'Node two',
      status: 'running',
      input_ref: 'artifacts/input/node_002.md',
      contract_ref: 'docs/contracts/Parallel_Contract.md',
      sealed_output_target: 'artifacts/outputs/node_002/output.md',
      latest_attempt_id: 'node_group_node_002_attempt_001',
    },
  ],
  attempts: [
    {
      run_instance_id: 'run_parallel_ui',
      step_id: 'parallel_nodes_001',
      group_id: 'node_group',
      item_id: 'node_001',
      attempt_id: 'node_group_node_001_attempt_001',
      attempt_number: 1,
      status: 'completed',
      evidence_dir: 'parallel_groups/node_group/items/node_001/attempts/node_group_node_001_attempt_001',
      warnings: [],
      latest_lease_id: 'lease_node_001',
      created_at: '2026-06-29T15:01:00.000Z',
      updated_at: '2026-06-29T15:02:00.000Z',
    },
    {
      run_instance_id: 'run_parallel_ui',
      step_id: 'parallel_nodes_001',
      group_id: 'node_group',
      item_id: 'node_002',
      attempt_id: 'node_group_node_002_attempt_001',
      attempt_number: 1,
      status: 'running',
      evidence_dir: 'parallel_groups/node_group/items/node_002/attempts/node_group_node_002_attempt_001',
      warnings: [
        {
          code: 'long_running',
          severity: 'warning',
          message: 'Attempt has been active past the soft visibility threshold.',
          observed_at: '2026-06-29T15:03:00.000Z',
          threshold_ms: 1200000,
          elapsed_ms: 1200000,
        },
      ],
      latest_lease_id: 'lease_node_002',
      created_at: '2026-06-29T15:01:05.000Z',
      updated_at: '2026-06-29T15:03:00.000Z',
    },
  ],
  leases: [
    {
      run_instance_id: 'run_parallel_ui',
      step_id: 'parallel_nodes_001',
      group_id: 'node_group',
      item_id: 'node_001',
      attempt_id: 'node_group_node_001_attempt_001',
      lease_id: 'lease_node_001',
      executor_id: 'executor_alpha',
      status: 'released',
      leased_at: '2026-06-29T15:01:00.000Z',
      expires_at: '2026-06-29T15:11:00.000Z',
      heartbeat_at: '2026-06-29T15:01:30.000Z',
      created_at: '2026-06-29T15:01:00.000Z',
      updated_at: '2026-06-29T15:02:00.000Z',
    },
    {
      run_instance_id: 'run_parallel_ui',
      step_id: 'parallel_nodes_001',
      group_id: 'node_group',
      item_id: 'node_002',
      attempt_id: 'node_group_node_002_attempt_001',
      lease_id: 'lease_node_002',
      executor_id: 'executor_beta',
      status: 'active',
      leased_at: '2026-06-29T15:01:05.000Z',
      expires_at: '2026-06-29T15:11:05.000Z',
      heartbeat_at: '2026-06-29T15:03:00.000Z',
      created_at: '2026-06-29T15:01:05.000Z',
      updated_at: '2026-06-29T15:03:00.000Z',
    },
  ],
}

const parallelRun = {
  run_instance_id: 'run_parallel_ui',
  state: parallelRunState,
  work_plan: parallelWorkPlan,
}

const parallelRunDiagnostics = {
  run_instance_id: 'run_parallel_ui',
  status: 'running',
  current_step_id: 'parallel_nodes_001',
  current_step_ordinal: 1,
  automation: parallelRunState.automation,
  next_allowed_actions: actions,
  last_event: {
    event_id: 'event_parallel_001',
    event_type: 'parallel_leases_granted',
    run_instance_id: 'run_parallel_ui',
    step_id: 'parallel_nodes_001',
    timestamp: '2026-06-29T15:01:05.000Z',
    details: { group_id: 'node_group', granted_count: 2 },
  },
  parallel_groups: [parallelGroup],
  latest_files: {
    parallel_preflight: 'parallel_groups/node_group/preflight.json',
  },
  evidence_paths: {
    run_dir: 'artifacts/protocol_runner/runs/run_parallel_ui',
    work_plan_path: 'artifacts/protocol_runner/runs/run_parallel_ui/work_plan.json',
    state_path: 'artifacts/protocol_runner/runs/run_parallel_ui/state.json',
    events_path: 'artifacts/protocol_runner/runs/run_parallel_ui/events.jsonl',
    latest_files: {},
  },
}

const parallelEvents = [
  {
    event_id: 'event_parallel_001',
    event_type: 'parallel_leases_granted',
    run_instance_id: 'run_parallel_ui',
    step_id: 'parallel_nodes_001',
    timestamp: '2026-06-29T15:01:05.000Z',
    details: { group_id: 'node_group', granted_count: 2 },
  },
]

const completedRunListItem = {
  run_instance_id: 'run_completed_ui',
  status: 'completed',
  current_step_id: null,
  current_step_ordinal: null,
  automation: { auto_pickup: true, auto_advance: true },
  updated_at: '2026-06-29T15:04:00.000Z',
}

const events = [
  {
    event_id: 'event_001',
    event_type: 'plan_validated',
    run_instance_id: 'run_protocol_ui',
    timestamp: '2026-06-25T15:00:00.000Z',
    details: { step_count: 1 },
  },
  runDiagnostics.last_event,
]

const countdownDesktopGate = {
  gate_status: 'countdown',
  auto_allow_ms: 15000,
  countdown_started_at: '2026-06-25T15:01:45.000Z',
  held_since: null,
  executing_since: null,
  desktop_control_released_at: null,
  pending_count: 2,
  executing_count: 0,
  last_snapshot_count: 0,
  pending_actions: [
    {
      action_id: 'desktop_action_001',
      kind: 'prompt',
      caller: 'protocol-runner:run_protocol_ui',
      target_thread_id: 'thread_001',
      target_thread_title: 'Test Codex thread',
      summary: 'Send derive_item_001 prompt.',
      queued_at: '2026-06-25T15:01:45.000Z',
    },
    {
      action_id: 'desktop_action_002',
      kind: 'prompt',
      caller: 'protocol-runner:run_protocol_ui_two',
      target_thread_id: 'thread_002',
      target_thread_title: 'Second Codex thread',
      summary: 'Send derive_item_017 prompt.',
      queued_at: '2026-06-25T15:01:46.000Z',
    },
  ],
  executing_actions: [],
}

let activeDesktopGate = countdownDesktopGate
let hiddenRunIds = new Set<string>()
let includePolicyFixtures = false

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
  })
}

function errorJsonResponse(status: number, message: string) {
  return new Response(JSON.stringify({ error: { message } }), {
    headers: { 'content-type': 'application/json' },
    status,
  })
}

function installFetchMock() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const runDetailMatch = /^\/runner-api\/api\/runs\/([^/?]+)/.exec(url)

    if (runDetailMatch !== null && hiddenRunIds.has(decodeURIComponent(runDetailMatch[1]))) {
      return errorJsonResponse(404, `Run not found: ${decodeURIComponent(runDetailMatch[1])}`)
    }

    if (url === '/runner-api/health' && method === 'GET') {
      return jsonResponse({
        ok: true,
        service: 'protocol-runner-api',
        adapters: {
          codex_desktop: { ok: true },
          discord_relay: { health: { ok: true }, ready: { ok: true } },
        },
      })
    }

    if (url === '/runner-api/api/diagnostics' && method === 'GET') {
      return jsonResponse({
        ok: true,
        service: 'protocol-runner-api',
        store: { runs: [{ ...runState, updated_at: runState.timestamps.updated_at }, completedRunListItem] },
        adapters: {
          codex_desktop: { health: { ok: true }, state: { mode: 'fake', desktopActionQueue: activeDesktopGate } },
          discord_relay: { health: { ok: true }, ready: { ok: true }, state: { mode: 'fake' } },
        },
      })
    }

    if (url === '/runner-api/api/desktop-operator-gate' && method === 'GET') {
      return jsonResponse({
        ok: true,
        gate: activeDesktopGate,
      })
    }

    if (url === '/runner-api/api/desktop-operator-gate/wait' && method === 'POST') {
      return jsonResponse({
        ok: true,
        gate: { ...activeDesktopGate, gate_status: 'held' },
      })
    }

    if (url === '/runner-api/api/desktop-operator-gate/allow-now' && method === 'POST') {
      return jsonResponse({
        ok: true,
        gate: { ...activeDesktopGate, desktop_control_released_at: '2026-06-25T15:02:00.000Z' },
      })
    }

    if (url === '/runner-api/api/runs' && method === 'GET') {
      return jsonResponse({
        ok: true,
        runs: [
          {
            run_instance_id: 'run_protocol_ui',
            status: 'waiting_for_completion_report',
            current_step_id: 'derive_item_001',
            current_step_ordinal: 1,
            automation: runState.automation,
            updated_at: '2026-06-25T15:01:00.000Z',
          },
          {
            run_instance_id: 'run_protocol_ui_two',
            status: 'ready',
            current_step_id: 'derive_item_017',
            current_step_ordinal: 17,
            automation: { auto_pickup: true, auto_advance: true },
            updated_at: '2026-06-25T15:01:30.000Z',
          },
          {
            run_instance_id: 'run_parallel_ui',
            status: 'running',
            current_step_id: 'parallel_nodes_001',
            current_step_ordinal: 1,
            automation: parallelRunState.automation,
            updated_at: '2026-06-29T15:03:00.000Z',
          },
          completedRunListItem,
          ...(includePolicyFixtures ? policyFixtures.map((fixture) => fixture.list_item) : []),
        ].filter((item) => !hiddenRunIds.has(item.run_instance_id)),
      })
    }

    const policyFixture = policyFixtures.find((fixture) =>
      url.startsWith(`/runner-api/api/runs/${fixture.run_instance_id}`),
    )
    if (policyFixture !== undefined) {
      if (url === `/runner-api/api/runs/${policyFixture.run_instance_id}` && method === 'GET') {
        return jsonResponse({ ok: true, run: policyFixture.run })
      }
      if (url === `/runner-api/api/runs/${policyFixture.run_instance_id}/diagnostics` && method === 'GET') {
        return jsonResponse({ ok: true, diagnostics: policyFixture.diagnostics })
      }
      if (url === `/runner-api/api/runs/${policyFixture.run_instance_id}/events?limit=20` && method === 'GET') {
        return jsonResponse({ ok: true, events: [] })
      }
    }

    if (url === '/runner-api/api/runs/run_protocol_ui' && method === 'GET') {
      return jsonResponse({ ok: true, run })
    }

    if (url === '/runner-api/api/runs/run_protocol_ui/diagnostics' && method === 'GET') {
      return jsonResponse({ ok: true, diagnostics: runDiagnostics })
    }

    if (url === '/runner-api/api/runs/run_protocol_ui/events?limit=20' && method === 'GET') {
      return jsonResponse({ ok: true, events })
    }

    if (url === '/runner-api/api/runs/run_parallel_ui' && method === 'GET') {
      return jsonResponse({ ok: true, run: parallelRun })
    }

    if (url === '/runner-api/api/runs/run_parallel_ui/diagnostics' && method === 'GET') {
      return jsonResponse({ ok: true, diagnostics: parallelRunDiagnostics })
    }

    if (url === '/runner-api/api/runs/run_parallel_ui/events?limit=20' && method === 'GET') {
      return jsonResponse({ ok: true, events: parallelEvents })
    }

    if (url === '/runner-api/api/runs/run_parallel_ui/parallel-groups/node_group/preflight' && method === 'POST') {
      return jsonResponse({ ok: true, run: parallelRun, group: parallelGroup, preflight: { passed: true } })
    }

    if (url === '/runner-api/api/runs/run_parallel_ui/parallel-groups/node_group/pause' && method === 'POST') {
      return jsonResponse({ ok: true, group: { ...parallelGroup, status: 'paused' } })
    }

    if (url === '/runner-api/api/runs/run_parallel_ui/parallel-groups/node_group/stop' && method === 'POST') {
      return jsonResponse({ ok: true, group: { ...parallelGroup, status: 'stopped' } })
    }

    if (url === '/runner-api/api/runs/run_parallel_ui/parallel-groups/node_group/items/node_002/retry' && method === 'POST') {
      return jsonResponse({ ok: true, group: parallelGroup })
    }

    if (
      url ===
        '/runner-api/api/runs/run_parallel_ui/parallel-groups/node_group/attempts/node_group_node_002_attempt_001/cancel' &&
      method === 'POST'
    ) {
      return jsonResponse({ ok: true, group: parallelGroup })
    }

    if (url === '/runner-api/api/runs/run_protocol_ui/files/prompt/0001_derive_item_001.attempt_001.md') {
      return new Response('Protocol-runner invocation prompt body')
    }

    if (url === '/runner-api/api/runs/run_protocol_ui/files/status/0001_derive_item_001.attempt_001.json') {
      return new Response('{"status":"completed"}')
    }

    if (url === '/runner-api/api/runs/run_protocol_ui/files/start/0001_derive_item_001.attempt_001.json') {
      return new Response('{"prompt_attempt_id":"attempt_001"}')
    }

    if (url === '/runner-api/api/runs/run_protocol_ui/pause' && method === 'POST') {
      return jsonResponse({ ok: true, run: { ...run, state: { ...runState, status: 'paused' } } })
    }

    if (url === '/runner-api/api/runs/run_protocol_ui/fail' && method === 'POST') {
      return jsonResponse({ ok: true, run: { ...run, state: { ...runState, status: 'failed' } } })
    }

    throw new Error(`Unexpected fetch: ${method} ${url}`)
  })

  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

async function waitForCondition(check: () => void, timeoutMs = 1200) {
  const started = Date.now()
  let lastError: unknown

  while (Date.now() - started < timeoutMs) {
    try {
      check()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  throw lastError
}

function hasText(text: string): boolean {
  return document.body.textContent?.includes(text) ?? false
}

function buttonByName(name: string | RegExp): HTMLButtonElement {
  const buttons = Array.from(document.querySelectorAll('button'))
  const matched = buttons.find((button) => {
    const accessibleName = button.getAttribute('aria-label') ?? button.textContent ?? ''
    return typeof name === 'string' ? accessibleName === name : name.test(accessibleName)
  })

  if (!(matched instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${String(name)}`)
  }

  return matched
}

describe('App', () => {
  let fetchMock: ReturnType<typeof installFetchMock>
  let root: Root
  let host: HTMLDivElement

  beforeEach(async () => {
    window.history.pushState({}, '', '/')
    activeDesktopGate = countdownDesktopGate
    hiddenRunIds = new Set<string>()
    includePolicyFixtures = false
    fetchMock = installFetchMock()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)

    await act(async () => {
      root.render(<App />)
    })
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('renders run state, diagnostics, allowed action tooltips, and evidence choices', async () => {
    await waitForCondition(() => expect(hasText('Protocol seed run')).toBe(true))
    expect(hasText('derive item_001 under Contract A')).toBe(true)
    expect(hasText('prompt_sent')).toBe(true)
    expect(buttonByName('Start')).toBeDisabled()
    expect(buttonByName('Start')).toHaveAttribute(
      'title',
      'start is not allowed while run status is waiting_for_completion_report.',
    )
    expect(buttonByName('Pause')).toBeEnabled()
    expect(buttonByName(/latest prompt/i)).toBeInTheDocument()
    expect(buttonByName(/latest start report/i)).toBeInTheDocument()
    expect(buttonByName(/latest status report/i)).toBeInTheDocument()
  })

  it('loads prompt evidence through the file endpoint', async () => {
    await waitForCondition(() => expect(hasText('Protocol seed run')).toBe(true))

    await act(async () => {
      buttonByName(/latest prompt/i).click()
    })

    await waitForCondition(() => expect(hasText('Protocol-runner invocation prompt body')).toBe(true))
    expect(fetchMock).toHaveBeenCalledWith(
      '/runner-api/api/runs/run_protocol_ui/files/prompt/0001_derive_item_001.attempt_001.md',
      { redirect: 'error', credentials: 'omit' },
    )
  })

  it('posts enabled control actions and refreshes the selected run', async () => {
    await waitForCondition(() => expect(hasText('Protocol seed run')).toBe(true))

    await act(async () => {
      buttonByName('Pause').click()
    })

    await waitForCondition(() =>
      expect(fetchMock).toHaveBeenCalledWith('/runner-api/api/runs/run_protocol_ui/pause', {
        method: 'POST',
        redirect: 'error',
        credentials: 'omit',
        headers: {},
      }),
    )
  })

  it('renders draft, setup, completed, and failed controls directly from API diagnostics', async () => {
    await waitForCondition(() => expect(hasText('Protocol seed run')).toBe(true))
    includePolicyFixtures = true
    await act(async () => {
      buttonByName('Refresh dashboard').click()
    })

    for (const fixture of policyFixtures) {
      await act(async () => {
        buttonByName(new RegExp(fixture.run_instance_id)).click()
      })
      await waitForCondition(() => expect(hasText(`Policy ${fixture.status} run`)).toBe(true))

      expect(buttonByName('Fail').disabled).toBe(!['draft', 'bound', 'ready'].includes(fixture.status))
      expect(buttonByName('Close').disabled).toBe(!['completed', 'failed'].includes(fixture.status))
    }
  })

  it('posts Desktop gate wait requests through protocol-runner-api', async () => {
    await waitForCondition(() => expect(hasText('Desktop gate')).toBe(true))

    await act(async () => {
      buttonByName('Wait on Desktop gate').click()
    })

    await waitForCondition(() =>
      expect(fetchMock).toHaveBeenCalledWith('/runner-api/api/desktop-operator-gate/wait', {
        method: 'POST',
        redirect: 'error',
        credentials: 'omit',
        headers: {},
      }),
    )
  })

  it('renders the global Desktop queue independently from the selected run', async () => {
    await waitForCondition(() => expect(hasText('Protocol seed run')).toBe(true))

    expect(hasText('run_protocol_ui_two')).toBe(true)
    expect(hasText('Global queued desktop actions')).toBe(true)
    expect(hasText('protocol-runner:run_protocol_ui / prompt')).toBe(true)
    expect(hasText('protocol-runner:run_protocol_ui_two / prompt')).toBe(true)
    expect(hasText('Second Codex thread')).toBe(true)
    expect(buttonByName('Wait on Desktop gate')).toBeEnabled()
    expect(buttonByName('Allow Desktop gate now')).toBeEnabled()
  })

  it('shows an unmissable Desktop-control overlay while the shared queue is executing', async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()

    activeDesktopGate = {
      ...countdownDesktopGate,
      gate_status: 'executing',
      countdown_started_at: null,
      executing_since: '2026-06-25T15:02:00.000Z',
      pending_count: 0,
      executing_count: 1,
      last_snapshot_count: 1,
      pending_actions: [],
      executing_actions: [countdownDesktopGate.pending_actions[0]],
    }

    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)

    await act(async () => {
      root.render(<App />)
    })

    await waitForCondition(() => expect(hasText('Desktop Control Active')).toBe(true))
    expect(hasText('Do not click, type, or move focus until this clears.')).toBe(true)
    expect(hasText('protocol-runner:run_protocol_ui / prompt')).toBe(true)
  })

  it('renders a runner finished notification from API run state', async () => {
    await waitForCondition(() => expect(hasText('Runner Work Finished')).toBe(true))

    expect(hasText('run_completed_ui')).toBe(true)
    expect(hasText('completed')).toBe(true)
  })

  it('renders parallel group item, attempt, lease, and evidence state for a selected run', async () => {
    await waitForCondition(() => expect(hasText('Protocol seed run')).toBe(true))

    await act(async () => {
      buttonByName(/run_parallel_ui/).click()
    })

    await waitForCondition(() => expect(hasText('Parallel seed run')).toBe(true))
    expect(hasText('Execution mode')).toBe(true)
    expect(hasText('mixed')).toBe(true)
    expect(hasText('Parallel Group')).toBe(true)
    expect(hasText('node_group')).toBe(true)
    expect(hasText('Items')).toBe(true)
    expect(hasText('completed: 1, running: 1')).toBe(true)
    expect(hasText('node_group_node_002_attempt_001')).toBe(true)
    expect(hasText('long_running')).toBe(true)
    expect(hasText('lease_node_002')).toBe(true)
    expect(hasText('executor_beta')).toBe(true)
    expect(hasText('parallel_groups/node_group/items/node_002/attempts/node_group_node_002_attempt_001/status_report.json')).toBe(
      true,
    )
    expect(hasText('parallel_groups/node_group/items/node_002/attempts/node_group_node_002_attempt_001/codex_exec.jsonl')).toBe(
      true,
    )
    expect(hasText('parallel_groups/node_group/items/node_002/attempts/node_group_node_002_attempt_001/stdout.log')).toBe(
      false,
    )
    expect(buttonByName('Pause Group')).toBeEnabled()
    expect(buttonByName('Preflight')).toBeDisabled()
    expect(buttonByName(/parallel groups/i)).toBeInTheDocument()
  })

  it('refreshes away from a selected run that disappeared from the run list', async () => {
    await waitForCondition(() => expect(hasText('Protocol seed run')).toBe(true))

    await act(async () => {
      buttonByName(/run_parallel_ui/).click()
    })

    await waitForCondition(() => expect(hasText('Parallel seed run')).toBe(true))
    fetchMock.mockClear()
    hiddenRunIds.add('run_parallel_ui')

    await act(async () => {
      buttonByName('Refresh dashboard').click()
    })

    await waitForCondition(() => expect(hasText('Protocol seed run')).toBe(true))
    const calledUrls = fetchMock.mock.calls.map(([input]) => String(input))
    expect(calledUrls.some((url) => url.startsWith('/runner-api/api/runs/run_parallel_ui'))).toBe(false)
  })

  it('posts parallel group controls through protocol-runner-api', async () => {
    await waitForCondition(() => expect(hasText('Protocol seed run')).toBe(true))

    await act(async () => {
      buttonByName(/run_parallel_ui/).click()
    })

    await waitForCondition(() => expect(hasText('Parallel seed run')).toBe(true))

    await act(async () => {
      buttonByName('Pause Group').click()
    })

    await waitForCondition(() =>
      expect(fetchMock).toHaveBeenCalledWith('/runner-api/api/runs/run_parallel_ui/parallel-groups/node_group/pause', {
        method: 'POST',
        redirect: 'error',
        credentials: 'omit',
        headers: {},
      }),
    )
  })

  it('shows a focused operator gate view from the gate URL', async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()

    window.history.pushState({}, '', '/?gate=1')
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)

    await act(async () => {
      root.render(<App />)
    })

    await waitForCondition(() => expect(hasText('Codex Desktop Control Requested')).toBe(true))
    expect(document.title).toBe('Protocol Runner Gate')
    expect(buttonByName('Wait on Desktop gate')).toBeInTheDocument()
    expect(buttonByName('Allow Desktop gate now')).toBeInTheDocument()
    expect(hasText('Queued desktop actions')).toBe(true)
    expect(hasText('protocol-runner:run_protocol_ui_two / prompt')).toBe(true)
  })

  it('shows a focused runner notification view from the notify URL', async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()

    window.history.pushState({}, '', '/?notify=1')
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)

    await act(async () => {
      root.render(<App />)
    })

    await waitForCondition(() => expect(hasText('Runner Work Finished')).toBe(true))
    expect(document.title).toBe('Protocol Runner Notification')
    expect(buttonByName('Refresh runner notification state')).toBeInTheDocument()
    expect(hasText('run_completed_ui')).toBe(true)
  })

  it('confirms and sends a manual failure reason for fail', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    vi.spyOn(window, 'prompt').mockReturnValue('operator stopped the run')

    await waitForCondition(() => expect(hasText('Protocol seed run')).toBe(true))

    await act(async () => {
      buttonByName('Fail').click()
    })

    await waitForCondition(() =>
      expect(fetchMock).toHaveBeenCalledWith('/runner-api/api/runs/run_protocol_ui/fail', {
        method: 'POST',
        redirect: 'error',
        credentials: 'omit',
        body: JSON.stringify({ reason: 'operator stopped the run' }),
        headers: { 'content-type': 'application/json' },
      }),
    )
  })
})
