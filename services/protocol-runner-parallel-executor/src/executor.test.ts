import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'

import { ProtocolRunnerParallelExecutor } from './executor.js'
import { CodexExecWorkerLauncher, FakeParallelWorkerLauncher } from './launcher.js'
import type {
  ParallelGroupState,
  ParallelLeasePacket,
  ParallelGroupEnvelope,
  ProtocolRunnerParallelApiClient,
  RunDiagnostics,
  RunListItem,
  RunStatus,
} from './types.js'

let tempRoot = ''

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'protocol-runner-parallel-executor-'))
})

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true })
})

class FakeProtocolRunnerParallelApiClient implements ProtocolRunnerParallelApiClient {
  readonly heartbeats: string[] = []
  readonly warningHeartbeats: Array<{ lease_id: string; codes: string[] }> = []
  readonly submitted: Array<{ attempt_id: string; launcher_status: string; sealed_output_path?: string }> = []
  readonly leaseRequests: Array<{ group_id: string; capacity: number; lease_ttl_ms?: number }> = []
  readonly staleRecoveries: string[] = []
  readonly controls: Array<{ group_id: string; action: 'pause' | 'stop'; reason?: string }> = []

  group: ParallelGroupState
  runStatus: RunListItem['status'] = 'ready'
  heartbeatErrorAfter: number | undefined

  constructor(private readonly leasesToGrant: ParallelLeasePacket[]) {
    this.group = makeGroup('ready_to_lease', leasesToGrant.length)
  }

  async listRuns(): Promise<RunListItem[]> {
    return [
      {
        run_instance_id: 'run_parallel_fake',
        status: this.runStatus,
        current_step_id: 'derive_nodes_parallel',
        current_step_ordinal: 1,
        automation: {
          auto_pickup: true,
          auto_advance: true,
        },
        updated_at: '2026-06-29T00:00:00.000Z',
      },
    ]
  }

  async getRunDiagnostics(_run_instance_id: string): Promise<RunDiagnostics> {
    return {
      run_instance_id: 'run_parallel_fake',
      status: this.runStatus,
      current_step_id: 'derive_nodes_parallel',
      current_step_ordinal: 1,
      parallel_groups: [this.group],
    }
  }

  async getParallelGroup(): Promise<ParallelGroupEnvelope> {
    return this.envelope(this.runStatus)
  }

  async grantLeases(
    _run_instance_id: string,
    group_id: string,
    input: { executor_id: string; capacity: number; lease_ttl_ms?: number },
  ): Promise<ParallelGroupEnvelope> {
    this.leaseRequests.push({ group_id, capacity: input.capacity, lease_ttl_ms: input.lease_ttl_ms })
    const alreadyGrantedItemIds = new Set(
      this.group.leases.filter((lease) => lease.status === 'active').map((lease) => lease.item_id),
    )
    const granted = this.leasesToGrant
      .filter((lease) => !alreadyGrantedItemIds.has(lease.item_id))
      .slice(0, input.capacity)
      .map((lease) => {
        const priorLeaseCount = this.group.leases.filter((candidate) => candidate.item_id === lease.item_id).length
        return priorLeaseCount === 0
          ? lease
          : {
              ...lease,
              lease_id: `${lease.attempt_id}_lease_${String(priorLeaseCount + 1).padStart(3, '0')}`,
            }
      })
    const existingAttemptIds = new Set(this.group.attempts.map((attempt) => attempt.attempt_id))
    this.group = {
      ...this.group,
      status: 'running',
      leases: [...this.group.leases, ...granted],
      attempts: [
        ...this.group.attempts.map((attempt) => {
          const lease = granted.find((candidate) => candidate.attempt_id === attempt.attempt_id)
          return lease === undefined
            ? attempt
            : { ...attempt, status: 'leased' as const, latest_lease_id: lease.lease_id, warnings: [] }
        }),
        ...granted.filter((lease) => !existingAttemptIds.has(lease.attempt_id)).map((lease) => ({
          run_instance_id: lease.run_instance_id,
          step_id: lease.step_id,
          group_id: lease.group_id,
          item_id: lease.item_id,
          attempt_id: lease.attempt_id,
          attempt_number: 1,
          status: 'leased' as const,
          evidence_dir: path.relative(tempRoot, lease.attempt_dir).replace(/\\/g, '/'),
          latest_lease_id: lease.lease_id,
          warnings: [],
          created_at: lease.created_at,
          updated_at: lease.updated_at,
        })),
      ],
      items: this.group.items.map((item) =>
        granted.some((lease) => lease.item_id === item.item_id)
          ? { ...item, status: 'leased', latest_attempt_id: granted.find((lease) => lease.item_id === item.item_id)?.attempt_id ?? null }
          : item,
      ),
    }
    return { ...this.envelope('running'), leases: granted }
  }

  async heartbeat(
    _run_instance_id: string,
    _group_id: string,
    lease_id: string,
    input: Parameters<ProtocolRunnerParallelApiClient['heartbeat']>[3] = {},
  ): Promise<ParallelGroupEnvelope> {
    this.heartbeats.push(lease_id)
    if (this.heartbeatErrorAfter !== undefined && this.heartbeats.length > this.heartbeatErrorAfter) {
      throw new Error('synthetic heartbeat failure')
    }
    if (input.attempt_warnings !== undefined && input.attempt_warnings.length > 0) {
      this.warningHeartbeats.push({ lease_id, codes: input.attempt_warnings.map((warning) => warning.code) })
    }
    const lease = this.group.leases.find((candidate) => candidate.lease_id === lease_id)
    if (lease !== undefined) {
      this.group = {
        ...this.group,
        attempts: this.group.attempts.map((attempt) =>
          attempt.attempt_id === lease.attempt_id
            ? {
                ...attempt,
                status: attempt.status === 'leased' ? 'running' : attempt.status,
                warnings: mergeWarningsForTest(attempt.warnings, input.attempt_warnings ?? []),
              }
            : attempt,
        ),
        items: this.group.items.map((item) =>
          item.item_id === lease.item_id && item.status === 'leased' ? { ...item, status: 'running' } : item,
        ),
      }
    }
    return this.envelope('running')
  }

  async recoverStaleLeases(_run_instance_id: string, group_id: string): Promise<ParallelGroupEnvelope> {
    this.staleRecoveries.push(group_id)
    const activeLeases = this.group.leases.filter((lease) => lease.status === 'active')
    const dispositions = await Promise.all(
      activeLeases.map(async (lease) => {
        const packet = this.leasesToGrant.find((candidate) => candidate.attempt_id === lease.attempt_id)
        return {
          lease,
          requeue: packet !== undefined && !(await directoryExists(packet.attempt_dir)),
        }
      }),
    )
    const requeued = dispositions.filter((disposition) => disposition.requeue)
    const attention = dispositions.filter((disposition) => !disposition.requeue)
    const staleLeaseIds = activeLeases.map((lease) => lease.lease_id)
    const requeuedLeaseIds = requeued.map(({ lease }) => lease.lease_id)
    const requeuedAttemptIds = requeued.map(({ lease }) => lease.attempt_id)
    const requeuedItemIds = requeued.map(({ lease }) => lease.item_id)
    const attentionLeaseIds = attention.map(({ lease }) => lease.lease_id)
    const attentionAttemptIds = attention.map(({ lease }) => lease.attempt_id)
    const attentionItemIds = attention.map(({ lease }) => lease.item_id)
    const hasAttention = attentionLeaseIds.length > 0
    this.runStatus = hasAttention ? 'blocked' : 'running'
    this.group = {
      ...this.group,
      status: hasAttention ? 'needs_attention' : 'running',
      leases: this.group.leases.map((lease) =>
        lease.status === 'active' ? { ...lease, status: 'expired', updated_at: '2026-06-29T00:01:00.000Z' } : lease,
      ),
      attempts: this.group.attempts.map((attempt) =>
        requeuedAttemptIds.includes(attempt.attempt_id)
          ? { ...attempt, status: 'created', warnings: [], updated_at: '2026-06-29T00:01:00.000Z' }
          : attentionAttemptIds.includes(attempt.attempt_id)
          ? { ...attempt, status: 'stale', updated_at: '2026-06-29T00:01:00.000Z' }
          : attempt,
      ),
      items: this.group.items.map((item) =>
        requeuedItemIds.includes(item.item_id)
          ? { ...item, status: 'pending' }
          : attentionItemIds.includes(item.item_id)
            ? { ...item, status: 'needs_recovery' }
            : item,
      ),
    }
    return {
      ...this.envelope(this.runStatus),
      recovered_count: staleLeaseIds.length,
      stale_lease_ids: staleLeaseIds,
      stale_attempt_ids: attentionAttemptIds,
      stale_item_ids: attentionItemIds,
      requeued_lease_ids: requeuedLeaseIds,
      requeued_attempt_ids: requeuedAttemptIds,
      requeued_item_ids: requeuedItemIds,
      attention_lease_ids: attentionLeaseIds,
      attention_attempt_ids: attentionAttemptIds,
      attention_item_ids: attentionItemIds,
    }
  }

  async controlParallelGroup(
    _run_instance_id: string,
    group_id: string,
    action: 'pause' | 'stop',
    input: { reason?: string } = {},
  ): Promise<ParallelGroupEnvelope> {
    this.controls.push({ group_id, action, reason: input.reason })
    this.runStatus = action === 'pause' ? 'paused' : 'blocked'
    this.group = {
      ...this.group,
      status: action === 'pause' ? 'paused' : 'stopped',
    }
    return this.envelope(this.runStatus)
  }

  async submitAttemptResult(
    _run_instance_id: string,
    _group_id: string,
    attempt_id: string,
    input: { launcher_status: string; sealed_output_path?: string },
  ): Promise<ParallelGroupEnvelope> {
    this.submitted.push({ attempt_id, launcher_status: input.launcher_status, sealed_output_path: input.sealed_output_path })
    this.group = {
      ...this.group,
      status: this.submitted.length === this.leasesToGrant.length ? 'completed' : 'running',
    }
    return this.envelope(this.group.status === 'completed' ? 'completed' : 'running')
  }

  cancelActiveAttempt(lease: ParallelLeasePacket): void {
    this.runStatus = 'blocked'
    this.group = {
      ...this.group,
      status: 'needs_attention',
      leases: this.group.leases.map((candidate) =>
        candidate.lease_id === lease.lease_id ? { ...candidate, status: 'cancelled' } : candidate,
      ),
      attempts: this.group.attempts.map((attempt) =>
        attempt.attempt_id === lease.attempt_id ? { ...attempt, status: 'cancelled' } : attempt,
      ),
      items: this.group.items.map((item) =>
        item.item_id === lease.item_id ? { ...item, status: 'needs_recovery' } : item,
      ),
    }
  }

  private envelope(status: RunStatus): ParallelGroupEnvelope {
    return {
      run: {
        run_instance_id: 'run_parallel_fake',
        state: {
          status,
          current_step_id: 'derive_nodes_parallel',
          current_step_ordinal: 1,
        },
      },
      group: this.group,
    }
  }
}

test('fake executor leases up to capacity, writes evidence, and submits completed results', async () => {
  const leases = [
    lease('node_001', path.join(tempRoot, 'attempts', 'node_001'), 'artifacts/outputs/node_001/output.md'),
    lease('node_002', path.join(tempRoot, 'attempts', 'node_002'), 'artifacts/outputs/node_002/output.md'),
  ]
  const client = new FakeProtocolRunnerParallelApiClient(leases)
  const executor = new ProtocolRunnerParallelExecutor({
    client,
    launcher: new FakeParallelWorkerLauncher({
      executor_id: 'executor_001',
      workspace_root: tempRoot,
      now: () => new Date('2026-06-29T12:00:00.000Z'),
    }),
    executor_id: 'executor_001',
    capacity: 2,
    launch_batch_size: 2,
  })

  const decision = await executor.tick()

  assert.equal(decision.action, 'launched')
  assert.equal(decision.launched_count, 2)
  assert.deepEqual(client.leaseRequests, [{ group_id: 'nodes_001_002', capacity: 2, lease_ttl_ms: 300_000 }])
  assert.deepEqual(
    [...client.heartbeats].sort(),
    [leases[0]!.lease_id, leases[0]!.lease_id, leases[1]!.lease_id, leases[1]!.lease_id].sort(),
  )
  assert.deepEqual(client.submitted.map((result) => result.launcher_status), ['completed', 'completed'])
  await assertFileIncludes(leases[0]!.prompt_path, 'Do not process unassigned sibling items.')
  await assertFileIncludes(
    leases[0]!.prompt_path,
    'use only the exact sealed-output inputs assigned to this item by its concrete contract.',
  )
  await assertFileIncludes(
    leases[0]!.prompt_path,
    'unless the assigned concrete contract explicitly authorizes exact named shared paths',
  )
  await assertFileIncludes(leases[0]!.prompt_path, '"selector": "node_001"')
  await assertFileExcludes(leases[0]!.prompt_path, '"selector": "node_002"')
  await assertFileIncludes(leases[0]!.worker_packet_path, '"item_id": "node_001"')
  await assertFileIncludes(leases[0]!.worker_packet_path, '"selector": "node_001"')
  await assertFileIncludes(leases[0]!.status_report_path, '"status": "completed"')
  await assertFileIncludes(leases[0]!.process_path, '"mode": "fake"')
  await assertFileIncludes(leases[0]!.result_path, '"launcher_status": "completed"')
  await assertFileIncludes(path.join(tempRoot, 'artifacts', 'outputs', 'node_001', 'output.md'), 'Fake Parallel Worker Output: node_001')
})

test('executor ramps large launch waves in configured batches', async () => {
  const leases = Array.from({ length: 5 }, (_, index) => {
    const itemId = `node_${String(index + 1).padStart(3, '0')}`
    return lease(itemId, path.join(tempRoot, 'attempts', itemId), `artifacts/outputs/${itemId}/output.md`)
  })
  const client = new FakeProtocolRunnerParallelApiClient(leases)
  const sleeps: number[] = []
  const executor = new ProtocolRunnerParallelExecutor({
    client,
    launcher: new FakeParallelWorkerLauncher({
      executor_id: 'executor_001',
      workspace_root: tempRoot,
    }),
    executor_id: 'executor_001',
    capacity: 5,
    launch_batch_size: 2,
    launch_batch_interval_ms: 25,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
  })

  const decision = await executor.tick()

  assert.equal(decision.action, 'launched')
  assert.equal(decision.launched_count, 5)
  assert.equal(decision.launch_batch_count, 3)
  assert.equal(decision.launch_batch_size, 2)
  assert.equal(decision.launch_batch_interval_ms, 25)
  assert.deepEqual(client.leaseRequests.map((request) => request.capacity), [2, 2, 1])
  assert.deepEqual(sleeps, [25, 25])
  assert.deepEqual(
    client.submitted.map((result) => result.launcher_status),
    ['completed', 'completed', 'completed', 'completed', 'completed'],
  )
})

test('executor shutdown aborts its active worker, reports cancellation, and stops taking leases', async () => {
  const packet = lease('node_001', path.join(tempRoot, 'attempts', 'node_001'), 'artifacts/outputs/node_001/output.md')
  const client = new FakeProtocolRunnerParallelApiClient([packet])
  const fake = new FakeParallelWorkerLauncher({ executor_id: 'executor_001', workspace_root: tempRoot,
    item_status_overrides: { node_001: 'cancelled' } })
  let started!: () => void
  const launchStarted = new Promise<void>((resolve) => { started = resolve })
  const executor = new ProtocolRunnerParallelExecutor({
    client, executor_id: 'executor_001', capacity: 1,
    launcher: {
      async launch(lease, context) {
        started()
        await new Promise<void>((resolve) => {
          if (context?.signal?.aborted) resolve()
          else context?.signal?.addEventListener('abort', () => resolve(), { once: true })
        })
        return fake.launch(lease)
      },
    },
  })
  const running = executor.tick()
  await launchStarted
  executor.requestShutdown()
  await running
  assert.deepEqual(client.submitted.map((item) => item.launcher_status), ['cancelled'])
  assert.deepEqual(client.controls, [])
  await executor.tick()
  assert.equal(client.leaseRequests.length, 1)
})

test('fake executor preserves evidence-missing attempts without fabricating completion', async () => {
  const leases = [lease('node_001', path.join(tempRoot, 'attempts', 'node_001'), 'artifacts/outputs/node_001/output.md')]
  const client = new FakeProtocolRunnerParallelApiClient(leases)
  const executor = new ProtocolRunnerParallelExecutor({
    client,
    launcher: new FakeParallelWorkerLauncher({
      executor_id: 'executor_001',
      workspace_root: tempRoot,
      item_status_overrides: {
        node_001: 'evidence_missing',
      },
    }),
    executor_id: 'executor_001',
    capacity: 1,
  })

  const decision = await executor.tick()

  assert.equal(decision.action, 'launched')
  assert.equal(decision.needs_attention_count, 1)
  assert.deepEqual(client.submitted.map((result) => result.launcher_status), ['evidence_missing'])
  await assert.rejects(fs.stat(leases[0]!.status_report_path))
  await assertFileIncludes(leases[0]!.result_path, '"launcher_status": "evidence_missing"')
})

test('executor reports launcher setup exceptions and releases the attempt instead of wedging its lease', async () => {
  const packet = lease('node_001', path.join(tempRoot, 'attempts', 'node_001'), 'artifacts/outputs/node_001/output.md')
  const client = new FakeProtocolRunnerParallelApiClient([packet])
  const executor = new ProtocolRunnerParallelExecutor({
    client,
    launcher: {
      async launch() {
        throw new Error('synthetic pre-launch setup failure')
      },
    },
    executor_id: 'executor_001',
    capacity: 1,
  })

  const decision = await executor.tick()

  assert.equal(decision.action, 'launched')
  assert.equal(decision.needs_attention_count, 1)
  assert.deepEqual(client.submitted.map((result) => result.launcher_status), ['failed'])
  assert.equal((await fs.stat(packet.attempt_dir)).isDirectory(), true)
  await assert.rejects(fs.stat(packet.result_path))
})

test('executor checks API reachability before creating attempt evidence', async () => {
  const packet = lease('node_001', path.join(tempRoot, 'attempts', 'node_001'), 'artifacts/outputs/node_001/output.md')
  const client = new FakeProtocolRunnerParallelApiClient([packet])
  client.heartbeatErrorAfter = 0
  const executor = new ProtocolRunnerParallelExecutor({
    client,
    launcher: new FakeParallelWorkerLauncher({
      executor_id: 'executor_001',
      workspace_root: tempRoot,
    }),
    executor_id: 'executor_001',
    capacity: 1,
  })

  const decision = await executor.tick()

  assert.equal(decision.action, 'launcher_error')
  assert.deepEqual(client.heartbeats, [packet.lease_id])
  assert.deepEqual(client.submitted, [])
  await assert.rejects(fs.stat(packet.attempt_dir))
})

test('executor refuses to create attempt evidence through an intermediate junction', async () => {
  const runDir = path.join(tempRoot, 'runs', 'run_parallel_fake')
  const attemptId = 'nodes_001_002_node_001_attempt_001'
  const attemptsAncestor = path.join(
    runDir,
    'parallel_groups',
    'nodes_001_002',
    'items',
    'node_001',
    'attempts',
  )
  const attemptDir = path.join(attemptsAncestor, attemptId)
  const externalAttempts = path.join(tempRoot, 'external-attempts')
  await fs.mkdir(path.dirname(attemptsAncestor), { recursive: true })
  await fs.mkdir(externalAttempts, { recursive: true })
  await fs.symlink(externalAttempts, attemptsAncestor, 'junction')
  const packet = lease('node_001', attemptDir, 'artifacts/outputs/node_001/output.md', runDir)
  const client = new FakeProtocolRunnerParallelApiClient([packet])
  const executor = new ProtocolRunnerParallelExecutor({
    client,
    launcher: new FakeParallelWorkerLauncher({
      executor_id: 'executor_001',
      workspace_root: tempRoot,
    }),
    executor_id: 'executor_001',
    capacity: 1,
  })

  const decision = await executor.tick()

  assert.equal(decision.action, 'launched')
  assert.equal(decision.needs_attention_count, 1)
  assert.deepEqual(client.heartbeats, [packet.lease_id])
  assert.deepEqual(client.submitted.map((result) => result.launcher_status), ['failed'])
  await assert.rejects(fs.stat(path.join(externalAttempts, attemptId)))
})

test('executor blocks before leasing when required worker capability is missing', async () => {
  const leases = [lease('node_001', path.join(tempRoot, 'attempts', 'node_001'), 'artifacts/outputs/node_001/output.md')]
  const client = new FakeProtocolRunnerParallelApiClient(leases)
  client.group = {
    ...client.group,
    required_worker_capabilities: ['json_transform'],
  }
  const executor = new ProtocolRunnerParallelExecutor({
    client,
    launcher: new FakeParallelWorkerLauncher({
      executor_id: 'executor_001',
      workspace_root: tempRoot,
    }),
    executor_id: 'executor_001',
    capacity: 1,
    worker_runtime_profile: {
      profile_id: 'test_base_only',
      capabilities: ['base'],
      env: {},
      path_prepend: [],
      tool_statuses: {
        node_exe: { env_var: 'NODE_EXE', exists: false },
        pnpm_cmd: { env_var: 'PNPM_CMD', exists: false },
        python_exe: { env_var: 'PYTHON_EXE', exists: false },
      },
    },
  })

  const decision = await executor.tick()

  assert.equal(decision.action, 'missing_required_capabilities')
  assert.deepEqual(decision.required_worker_capabilities, ['json_transform'])
  assert.deepEqual(decision.available_worker_capabilities, ['base'])
  assert.deepEqual(decision.missing_worker_capabilities, ['json_transform'])
  assert.deepEqual(client.leaseRequests, [])
  assert.equal(client.controls.length, 1)
  assert.equal(client.controls[0]?.action, 'stop')
  assert.match(client.controls[0]?.reason ?? '', /requires worker capabilities/)
})

test('codex exec launcher runs one worker process and preserves launcher evidence', async () => {
  const stubPath = path.join(tempRoot, 'codex-exec-stub.mjs')
  await fs.writeFile(stubPath, codexExecStubSource(), 'utf8')
  const packet = lease('node_001', path.join(tempRoot, 'attempts', 'node_001'), 'artifacts/outputs/node_001/output.md')
  const launcher = new CodexExecWorkerLauncher({
    executor_id: 'executor_001',
    workspace_root: tempRoot,
    codex_command: process.execPath,
    codex_base_args: [stubPath],
    now: () => new Date('2026-06-29T12:00:00.000Z'),
  })

  const result = await launcher.launch(packet)

  assert.equal(result.launcher_status, 'completed')
  assert.equal(result.process.mode, 'codex_exec')
  assert.equal(result.process.command, process.execPath)
  assert.ok(result.process.args?.includes('workspace-write'))
  assert.ok(result.process.args?.includes('approval_policy="never"'))
  assert.ok(!result.process.args?.includes('--dangerously-bypass-approvals-and-sandbox'))
  assert.equal(result.status_report?.status, 'completed')
  await assertFileIncludes(packet.prompt_path, '"selector": "node_001"')
  await assertFileIncludes(packet.worker_packet_path, '"selector": "node_001"')
  await assertFileIncludes(packet.status_report_path, '"status": "completed"')
  await assertFileIncludes(path.join(tempRoot, 'artifacts', 'outputs', 'node_001', 'output.md'), 'REAL_PARALLEL_STEP_001: node_001')
  await assertFileIncludes(path.join(packet.attempt_dir, 'codex_exec.jsonl'), '"event":"stub_completed"')
  await assert.rejects(
    fs.access(path.join(packet.attempt_dir, 'stdout.log')),
    (error: unknown) =>
      typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT',
  )
  await assertFileIncludes(path.join(packet.attempt_dir, 'final_message.md'), 'stub final message')
  await assertFileIncludes(path.join(packet.attempt_dir, 'process_started.json'), '"pid"')
  await assertFileIncludes(packet.result_path, '"launcher_status": "completed"')
  const resultFile = JSON.parse(await fs.readFile(packet.result_path, 'utf8')) as {
    stdout_path: string
    codex_exec_jsonl_path: string
  }
  assert.equal(resultFile.stdout_path, resultFile.codex_exec_jsonl_path)
  assert.equal(resultFile.stdout_path, path.join(packet.attempt_dir, 'codex_exec.jsonl'))
})

test('codex exec launcher exposes and injects the worker runtime profile', async () => {
  const stubPath = path.join(tempRoot, 'codex-exec-profile-stub.mjs')
  await fs.writeFile(stubPath, codexExecStubSource({ echoEnv: true }), 'utf8')
  const packet = {
    ...lease('node_001', path.join(tempRoot, 'attempts', 'node_001'), 'artifacts/outputs/node_001/output.md'),
    required_worker_capabilities: ['json_transform' as const],
  }
  const fakePythonPath = path.join(tempRoot, 'python.exe')
  await fs.writeFile(fakePythonPath, '', 'utf8')
  const launcher = new CodexExecWorkerLauncher({
    executor_id: 'executor_001',
    workspace_root: tempRoot,
    codex_command: process.execPath,
    codex_base_args: [stubPath],
    worker_runtime_profile: {
      profile_id: 'test_json_transform',
      capabilities: ['base', 'json_transform'],
      env: {
        NODE_EXE: process.execPath,
        PYTHON_EXE: fakePythonPath,
      },
      path_prepend: [path.dirname(process.execPath)],
      tool_statuses: {
        node_exe: { env_var: 'NODE_EXE', configured_path: process.execPath, usable_path: process.execPath, exists: true },
        pnpm_cmd: { env_var: 'PNPM_CMD', exists: false },
        python_exe: { env_var: 'PYTHON_EXE', configured_path: fakePythonPath, usable_path: fakePythonPath, exists: true },
      },
    },
    now: () => new Date('2026-06-29T12:00:00.000Z'),
  })

  const result = await launcher.launch(packet)
  const sealedOutputPath = path.join(tempRoot, 'artifacts', 'outputs', 'node_001', 'output.md')

  assert.equal(result.launcher_status, 'completed')
  await assertFileIncludes(packet.prompt_path, 'Worker runtime profile:')
  await assertFileIncludes(packet.prompt_path, '"required_worker_capabilities"')
  await assertFileIncludes(packet.worker_packet_path, '"profile_id": "test_json_transform"')
  await assertFileIncludes(path.join(packet.attempt_dir, 'process_started.json'), '"worker_runtime_profile"')
  await assertFileIncludes(packet.process_path, '"worker_runtime_profile"')
  await assertFileIncludes(sealedOutputPath, `NODE_EXE=${process.execPath}`)
})

test('codex exec launcher accepts BOM-prefixed worker status report', async () => {
  const stubPath = path.join(tempRoot, 'codex-exec-bom-status-stub.mjs')
  await fs.writeFile(stubPath, codexExecStubSource({ statusReportBom: true }), 'utf8')
  const packet = lease('node_001', path.join(tempRoot, 'attempts', 'node_001'), 'artifacts/outputs/node_001/output.md')
  const launcher = new CodexExecWorkerLauncher({
    executor_id: 'executor_001',
    workspace_root: tempRoot,
    codex_command: process.execPath,
    codex_base_args: [stubPath],
    now: () => new Date('2026-06-29T12:00:00.000Z'),
  })

  const result = await launcher.launch(packet)
  const statusReportBytes = await fs.readFile(packet.status_report_path)

  assert.equal(result.launcher_status, 'completed')
  assert.deepEqual([...statusReportBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf])
  assert.equal(result.status_report?.status, 'completed')
  await assertFileIncludes(packet.result_path, '"launcher_status": "completed"')
})

test('codex exec launcher keeps malformed worker status report invalid', async () => {
  const stubPath = path.join(tempRoot, 'codex-exec-malformed-status-stub.mjs')
  await fs.writeFile(stubPath, codexExecStubSource({ malformedStatusReport: true }), 'utf8')
  const packet = lease('node_001', path.join(tempRoot, 'attempts', 'node_001'), 'artifacts/outputs/node_001/output.md')
  const launcher = new CodexExecWorkerLauncher({
    executor_id: 'executor_001',
    workspace_root: tempRoot,
    codex_command: process.execPath,
    codex_base_args: [stubPath],
    now: () => new Date('2026-06-29T12:00:00.000Z'),
  })

  const result = await launcher.launch(packet)

  assert.equal(result.launcher_status, 'status_invalid')
  assert.equal(result.status_report, undefined)
  await assertFileIncludes(packet.result_path, '"launcher_status": "status_invalid"')
})

test('fake executor skips groups that have not passed preflight', async () => {
  const leases = [lease('node_001', path.join(tempRoot, 'attempts', 'node_001'), 'artifacts/outputs/node_001/output.md')]
  const client = new FakeProtocolRunnerParallelApiClient(leases)
  client.group = {
    ...client.group,
    preflight_status: 'failed',
  }
  const executor = new ProtocolRunnerParallelExecutor({
    client,
    launcher: new FakeParallelWorkerLauncher({
      executor_id: 'executor_001',
      workspace_root: tempRoot,
    }),
    executor_id: 'executor_001',
    capacity: 1,
  })

  const decision = await executor.tick()

  assert.equal(decision.action, 'no_eligible_groups')
  assert.deepEqual(client.leaseRequests, [])
})

test('executor applies the default grace to legacy null-expiry leases before granting more work', async () => {
  const activeLease = lease('node_001', path.join(tempRoot, 'attempts', 'node_001'), 'artifacts/outputs/node_001/output.md')
  const client = new FakeProtocolRunnerParallelApiClient([activeLease])
  client.group = {
    ...client.group,
    status: 'running',
    max_concurrency: 1,
    items: client.group.items.map((item) =>
      item.item_id === activeLease.item_id
        ? { ...item, status: 'running', latest_attempt_id: activeLease.attempt_id }
        : item,
    ),
    attempts: [
      {
        run_instance_id: activeLease.run_instance_id,
        step_id: activeLease.step_id,
        group_id: activeLease.group_id,
        item_id: activeLease.item_id,
        attempt_id: activeLease.attempt_id,
        attempt_number: 1,
        status: 'running',
        evidence_dir: activeLease.attempt_dir,
        warnings: [],
        latest_lease_id: activeLease.lease_id,
        created_at: activeLease.created_at,
        updated_at: activeLease.updated_at,
      },
    ],
    leases: [
      {
        ...activeLease,
        leased_at: '2000-01-01T00:00:00.000Z',
        expires_at: null,
        heartbeat_at: null,
      },
    ],
  }
  const executor = new ProtocolRunnerParallelExecutor({
    client,
    launcher: new FakeParallelWorkerLauncher({
      executor_id: 'executor_001',
      workspace_root: tempRoot,
    }),
    executor_id: 'executor_001',
    capacity: 1,
  })

  const decision = await executor.tick()

  assert.equal(decision.action, 'stale_leases_recovered')
  assert.equal(decision.recovered_count, 1)
  assert.deepEqual(decision.stale_lease_ids, [activeLease.lease_id])
  assert.deepEqual(decision.requeued_attempt_ids, [activeLease.attempt_id])
  assert.deepEqual(decision.attention_attempt_ids, [])
  assert.equal(client.runStatus, 'running')
  assert.deepEqual(client.staleRecoveries, ['nodes_001_002'])
  assert.equal(client.leaseRequests.length, 0)
  assert.equal(client.heartbeats.length, 0)
  assert.equal(client.submitted.length, 0)

  const nextDecision = await executor.tick()

  assert.equal(nextDecision.action, 'launched')
  assert.equal(nextDecision.launched_count, 1)
  assert.equal(client.leaseRequests.length, 1)
  assert.deepEqual(client.submitted.map((result) => result.launcher_status), ['completed'])
})

test('codex exec launcher classifies hard timeout without fabricating completion', async () => {
  const stubPath = path.join(tempRoot, 'codex-timeout-stub.mjs')
  await fs.writeFile(stubPath, codexExecTimeoutStubSource(), 'utf8')
  const packet = lease('node_001', path.join(tempRoot, 'attempts', 'node_001'), 'artifacts/outputs/node_001/output.md')
  const launcher = new CodexExecWorkerLauncher({
    executor_id: 'executor_001',
    workspace_root: tempRoot,
    codex_command: process.execPath,
    codex_base_args: [stubPath],
    hard_timeout_ms: 50,
    now: () => new Date('2026-06-29T12:00:00.000Z'),
  })

  const result = await launcher.launch(packet)

  assert.equal(result.launcher_status, 'timed_out')
  assert.equal(result.status_report, undefined)
  await assertFileIncludes(packet.result_path, '"launcher_status": "timed_out"')
  await assert.rejects(fs.stat(packet.status_report_path))
})

test('executor kills an active codex exec child when API state cancels the lease', async () => {
  const stubPath = path.join(tempRoot, 'codex-active-cancel-stub.mjs')
  await fs.writeFile(stubPath, codexExecActiveCancelStubSource(), 'utf8')
  const packet = lease('node_001', path.join(tempRoot, 'attempts', 'node_001'), 'artifacts/outputs/node_001/output.md')
  const client = new FakeProtocolRunnerParallelApiClient([packet])
  const executor = new ProtocolRunnerParallelExecutor({
    client,
    launcher: new CodexExecWorkerLauncher({
      executor_id: 'executor_001',
      workspace_root: tempRoot,
      codex_command: process.execPath,
      codex_base_args: [stubPath],
    }),
    executor_id: 'executor_001',
    capacity: 1,
    control_poll_interval_ms: 25,
  })

  const tick = executor.tick()
  await waitForFile(path.join(packet.attempt_dir, 'worker_started.json'), 5_000)
  client.cancelActiveAttempt(packet)

  const decision = await tick

  assert.equal(decision.action, 'launched')
  assert.equal(decision.needs_attention_count, 1)
  assert.deepEqual(client.submitted, [])
  await assertFileIncludes(packet.result_path, '"launcher_status": "cancelled"')
  await assertFileIncludes(packet.result_path, '"kill_reason": "cancelled"')
  await assertFileIncludes(packet.process_path, '"killed_by_runner": true')
  await assertFileIncludes(packet.process_path, '"kill_reason": "cancelled"')
})

test('executor renews an active worker lease on the configured heartbeat interval', async () => {
  const stubPath = path.join(tempRoot, 'codex-active-heartbeat-stub.mjs')
  await fs.writeFile(stubPath, codexExecActiveCancelStubSource(), 'utf8')
  const packet = lease('node_001', path.join(tempRoot, 'attempts', 'node_001'), 'artifacts/outputs/node_001/output.md')
  const client = new FakeProtocolRunnerParallelApiClient([packet])
  const executor = new ProtocolRunnerParallelExecutor({
    client,
    launcher: new CodexExecWorkerLauncher({
      executor_id: 'executor_001',
      workspace_root: tempRoot,
      codex_command: process.execPath,
      codex_base_args: [stubPath],
    }),
    executor_id: 'executor_001',
    capacity: 1,
    control_poll_interval_ms: 10,
    heartbeat_interval_ms: 25,
    long_running_after_ms: 60_000,
    possibly_stalled_after_ms: 60_000,
  })

  const tick = executor.tick()
  try {
    await waitForCondition(() => {
      assert.ok(client.heartbeats.length >= 3)
    }, 5_000)
    assert.deepEqual(client.submitted, [])
  } finally {
    client.cancelActiveAttempt(packet)
    await tick
  }
})

test('executor keeps failed periodic heartbeat retries interval-bounded', async () => {
  const stubPath = path.join(tempRoot, 'codex-active-heartbeat-failure-stub.mjs')
  await fs.writeFile(stubPath, codexExecActiveCancelStubSource(), 'utf8')
  const packet = lease('node_001', path.join(tempRoot, 'attempts', 'node_001'), 'artifacts/outputs/node_001/output.md')
  const client = new FakeProtocolRunnerParallelApiClient([packet])
  client.heartbeatErrorAfter = 2
  const executor = new ProtocolRunnerParallelExecutor({
    client,
    launcher: new CodexExecWorkerLauncher({
      executor_id: 'executor_001',
      workspace_root: tempRoot,
      codex_command: process.execPath,
      codex_base_args: [stubPath],
    }),
    executor_id: 'executor_001',
    capacity: 1,
    control_poll_interval_ms: 10,
    heartbeat_interval_ms: 200,
    long_running_after_ms: 60_000,
    possibly_stalled_after_ms: 60_000,
  })

  const tick = executor.tick()
  try {
    await waitForCondition(() => {
      assert.equal(client.heartbeats.length, 3)
    }, 5_000)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(client.heartbeats.length, 3)
  } finally {
    client.cancelActiveAttempt(packet)
    await tick
  }
})

test('executor reports soft timing warnings without completing or timing out an active child', async () => {
  const stubPath = path.join(tempRoot, 'codex-active-warning-stub.mjs')
  await fs.writeFile(stubPath, codexExecActiveCancelStubSource(), 'utf8')
  const packet = lease('node_001', path.join(tempRoot, 'attempts', 'node_001'), 'artifacts/outputs/node_001/output.md')
  const client = new FakeProtocolRunnerParallelApiClient([packet])
  const executor = new ProtocolRunnerParallelExecutor({
    client,
    launcher: new CodexExecWorkerLauncher({
      executor_id: 'executor_001',
      workspace_root: tempRoot,
      codex_command: process.execPath,
      codex_base_args: [stubPath],
    }),
    executor_id: 'executor_001',
    capacity: 1,
    control_poll_interval_ms: 25,
    long_running_after_ms: 25,
    possibly_stalled_after_ms: 25,
  })

  const tick = executor.tick()
  try {
    await waitForCondition(() => {
      assert.ok(client.warningHeartbeats.some((heartbeat) => heartbeat.codes.includes('long_running')))
      assert.ok(client.warningHeartbeats.some((heartbeat) => heartbeat.codes.includes('possibly_stalled')))
    }, 5_000)

    const activeAttempt = client.group.attempts.find((attempt) => attempt.attempt_id === packet.attempt_id)
    assert.equal(activeAttempt?.status, 'running')
    assert.deepEqual(
      activeAttempt?.warnings.map((warning) => warning.code).sort(),
      ['long_running', 'possibly_stalled'],
    )
    assert.deepEqual(client.submitted, [])
  } finally {
    client.cancelActiveAttempt(packet)
    await tick
  }
})

async function assertFileIncludes(filePath: string, text: string): Promise<void> {
  const body = await fs.readFile(filePath, 'utf8')
  assert.match(body, new RegExp(escapeRegExp(text)))
}

async function assertFileExcludes(filePath: string, text: string): Promise<void> {
  const body = await fs.readFile(filePath, 'utf8')
  assert.doesNotMatch(body, new RegExp(escapeRegExp(text)))
}

async function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await fs.stat(filePath)
      return
    } catch (error) {
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) {
        throw error
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for file: ${filePath}`)
}

async function directoryExists(directoryPath: string): Promise<boolean> {
  try {
    return (await fs.stat(directoryPath)).isDirectory()
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

async function waitForCondition(assertion: () => void, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw lastError instanceof Error ? lastError : new Error(`Timed out waiting for condition: ${String(lastError)}`)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function mergeWarningsForTest<T extends { code: string }>(current: T[], next: T[]): T[] {
  const byCode = new Map<string, T>()
  for (const warning of current) {
    byCode.set(warning.code, warning)
  }
  for (const warning of next) {
    byCode.set(warning.code, warning)
  }
  return [...byCode.values()]
}

function makeGroup(status: ParallelGroupState['status'], itemCount: number): ParallelGroupState {
  return {
    run_instance_id: 'run_parallel_fake',
    step_id: 'derive_nodes_parallel',
    group_id: 'nodes_001_002',
    ordinal: 1,
    status,
    executor: 'codex_exec',
    contract_ref: 'docs/contracts/Contract_A.md',
    max_concurrency: itemCount,
    required_worker_capabilities: [],
    preflight_status: 'passed',
    checked_at: '2026-06-29T00:00:00.000Z',
    checked_by: 'test',
    items: Array.from({ length: itemCount }, (_, index) => {
      const item_id = `node_${String(index + 1).padStart(3, '0')}`
      return {
        run_instance_id: 'run_parallel_fake',
        step_id: 'derive_nodes_parallel',
        group_id: 'nodes_001_002',
        item_id,
        status: 'pending',
        input_ref: `docs/items.md#${item_id}`,
        contract_ref: 'docs/contracts/Contract_A.md',
        sealed_output_target: `artifacts/outputs/${item_id}/output.md`,
        latest_attempt_id: null,
      }
    }),
    attempts: [],
    leases: [],
  }
}

function lease(item_id: string, attempt_dir: string, sealed_output_path: string, run_dir = tempRoot): ParallelLeasePacket {
  const attempt_id = `nodes_001_002_${item_id}_attempt_001`
  return {
    run_instance_id: 'run_parallel_fake',
    step_id: 'derive_nodes_parallel',
    group_id: 'nodes_001_002',
    item_id,
    attempt_id,
    lease_id: `${attempt_id}_lease_001`,
    executor_id: 'executor_001',
    status: 'active',
    leased_at: '2026-06-29T00:00:00.000Z',
    expires_at: null,
    heartbeat_at: null,
    created_at: '2026-06-29T00:00:00.000Z',
    updated_at: '2026-06-29T00:00:00.000Z',
    run_dir,
    attempt_dir,
    prompt_path: path.join(attempt_dir, 'prompt.md'),
    worker_packet_path: path.join(attempt_dir, 'worker_packet.json'),
    status_report_path: path.join(attempt_dir, 'status_report.json'),
    process_path: path.join(attempt_dir, 'process.json'),
    result_path: path.join(attempt_dir, 'result.json'),
    sealed_output_path,
    input_ref: `docs/items.md#${item_id}`,
    contract_ref: 'docs/contracts/Contract_A.md',
    variables: {
      selector: item_id,
      nested: { preserve: true },
      ordinal: Number(item_id.slice(-3)),
    },
    required_worker_capabilities: [],
  }
}

function codexExecStubSource(options: { statusReportBom?: boolean; malformedStatusReport?: boolean; echoEnv?: boolean } = {}): string {
  const statusBodyExpression =
    options.malformedStatusReport === true
      ? "'{not json\\n'"
      : `${options.statusReportBom === true ? "'\\uFEFF' + " : ''}JSON.stringify(report, null, 2) + '\\n'`
  const sealedOutputExpression =
    options.echoEnv === true
      ? "'REAL_PARALLEL_STEP_001: ' + packet.item_id + '\\nNODE_EXE=' + (process.env.NODE_EXE || '') + '\\nPYTHON_EXE=' + (process.env.PYTHON_EXE || '') + '\\n'"
      : "'REAL_PARALLEL_STEP_001: ' + packet.item_id + '\\n'"
  return `
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

let stdin = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) {
  stdin += chunk
}

const finalIndex = process.argv.indexOf('--output-last-message')
const finalPath = finalIndex >= 0 ? process.argv[finalIndex + 1] : undefined
const packetMatch = stdin.match(/Worker-visible item packet:\\n\`\`\`json\\n([\\s\\S]*?)\\n\`\`\`/)
if (!packetMatch) {
  throw new Error('worker-visible item packet missing')
}
const packet = JSON.parse(packetMatch[1])
const sealedOutputPath = path.resolve(process.cwd(), packet.sealed_output_path)
const statusReportPath = path.resolve(packet.status_report_path)
await mkdir(path.dirname(sealedOutputPath), { recursive: true })
await mkdir(path.dirname(statusReportPath), { recursive: true })
await writeFile(sealedOutputPath, ${sealedOutputExpression}, 'utf8')
const report = {
  run_instance_id: getLine(stdin, 'Run instance:'),
  step_id: getLine(stdin, 'Step:'),
  group_id: getLine(stdin, 'Parallel group:'),
  item_id: packet.item_id,
  attempt_id: getLine(stdin, 'Attempt:'),
  status: 'completed',
  sealed_output_path: packet.sealed_output_path,
  notes: 'stub completed ' + packet.item_id
}
const statusBody = ${statusBodyExpression}
await writeFile(statusReportPath, statusBody, 'utf8')
if (finalPath) {
  await mkdir(path.dirname(path.resolve(finalPath)), { recursive: true })
  await writeFile(finalPath, 'stub final message\\n', 'utf8')
}
process.stdout.write(JSON.stringify({ event: 'stub_completed', item_id: packet.item_id }) + '\\n')

function getLine(body, prefix) {
  const line = body.split(/\\r?\\n/).find((candidate) => candidate.startsWith(prefix))
  if (!line) {
    throw new Error('missing line ' + prefix)
  }
  return line.slice(prefix.length).trim()
}
`
}

function codexExecTimeoutStubSource(): string {
  return `
await new Promise((resolve) => setTimeout(resolve, 10_000))
`
}

function codexExecActiveCancelStubSource(): string {
  return `
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

let stdin = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) {
  stdin += chunk
}

const packetMatch = stdin.match(/Worker-visible item packet:\\n\`\`\`json\\n([\\s\\S]*?)\\n\`\`\`/)
if (!packetMatch) {
  throw new Error('worker-visible item packet missing')
}
const packet = JSON.parse(packetMatch[1])
const startedPath = path.join(path.dirname(path.resolve(packet.status_report_path)), 'worker_started.json')
await mkdir(path.dirname(startedPath), { recursive: true })
await writeFile(startedPath, JSON.stringify({ pid: process.pid, item_id: packet.item_id }) + '\\n', 'utf8')
process.stdout.write(JSON.stringify({ event: 'stub_started', item_id: packet.item_id, pid: process.pid }) + '\\n')
setInterval(() => {}, 1_000)
await new Promise(() => {})
`
}
