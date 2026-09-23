import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import initSqlJs from 'sql.js'

import {
  GENERIC_STEP_PROMPT_TEMPLATE_ID,
  RUN_STATE_SCHEMA_VERSION,
  WORK_PLAN_SCHEMA_VERSION,
  resolveStep,
  type RunState,
  type WorkPlan,
} from '../../../packages/protocol-runner-core/dist/index.js'

import {
  DEFAULT_PARALLEL_LEASE_TTL_MS,
  HybridRunnerStore,
  JsonRunnerStore,
  type ParallelPreflightResult,
  RunnerStoreError,
  SqliteRunnerStore,
} from './store.js'
import { RunArtifactLifecycle, type RunArtifactTransaction } from './run-artifact-lifecycle.js'

let tempRoot = ''
let counter = 0

function nextDate(): Date {
  counter += 1
  return new Date(`2026-06-25T12:00:${String(counter).padStart(2, '0')}.000Z`)
}

function makePlan(): WorkPlan {
  return {
    schema_version: WORK_PLAN_SCHEMA_VERSION,
    run_title: 'Tiny store proof',
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
        step_id: 'review_item_001',
        step_kind: 'review',
        contract: {
          title: 'Review Contract',
          path: 'docs/contracts/Review.md',
        },
        planned_step: 'review item_001',
        visible_work_item: {
          item_id: 'item_001',
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
    run_title: 'Parallel store proof',
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
          base_dir: 'artifacts/protocol_runner/sealed_outputs/run_parallel_store/nodes_001_002',
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
            label: 'Node 002',
            input_ref: 'docs/items.md#node_002',
            sealed_output: {
              unit_id: 'node_two',
            },
          },
        ],
        on_completed: { action: 'stop' },
        on_blocked: { action: 'pause' },
      },
    ],
  }
}

function expectParallelStep(work_plan: WorkPlan) {
  const step = resolveStep(work_plan, 'derive_nodes_parallel')
  if (step === null || step.step_kind !== 'parallel_group') {
    throw new Error('fixture parallel step did not resolve')
  }
  return step
}

function makePassingParallelPreflight(run_instance_id: string): ParallelPreflightResult {
  return {
    run_instance_id,
    step_id: 'derive_nodes_parallel',
    group_id: 'nodes_001_002',
    passed: true,
    preflight_status: 'passed',
    checked_at: '2026-06-25T12:55:00.000Z',
    checked_by: 'test',
    checks: [
      {
        code: 'test.preflight',
        status: 'passed',
        message: 'test preflight passed',
      },
    ],
    errors: [],
    warnings: [],
    executor_summary: { executor: 'codex_exec' },
    max_concurrency: 2,
    item_count: 2,
    launchable_item_count: 2,
  }
}

function makeStore(): JsonRunnerStore {
  return new JsonRunnerStore({
    runs_root: tempRoot,
    now: nextDate,
    event_id_factory: () => `event_${String(counter + 1).padStart(3, '0')}`,
  })
}

function makeSqliteStore(runsRoot = path.join(tempRoot, 'runs')): SqliteRunnerStore {
  return new SqliteRunnerStore({
    runs_root: runsRoot,
    db_path: path.join(tempRoot, 'protocol_runner.sqlite'),
    now: nextDate,
    event_id_factory: () => `event_${String(counter + 1).padStart(3, '0')}`,
  })
}

async function readText(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf8')
}

async function withSqliteFile<T>(dbPath: string, operation: (db: initSqlJs.Database) => T): Promise<T> {
  const SQL = await initSqlJs()
  const db = new SQL.Database(await fs.readFile(dbPath))
  try {
    return operation(db)
  } finally {
    db.close()
  }
}

async function mutateSqliteFile(dbPath: string, operation: (db: initSqlJs.Database) => void): Promise<void> {
  const SQL = await initSqlJs()
  const db = new SQL.Database(await fs.readFile(dbPath))
  try {
    operation(db)
    await fs.writeFile(dbPath, db.export())
  } finally {
    db.close()
  }
}

function sqliteScalar(db: initSqlJs.Database, sql: string, params: initSqlJs.BindParams = []): number {
  const statement = db.prepare(sql)
  try {
    statement.bind(params)
    assert.equal(statement.step(), true)
    const value = statement.get()[0]
    if (typeof value !== 'number') {
      throw new Error(`Expected numeric SQLite scalar, received ${typeof value}.`)
    }
    return value
  } finally {
    statement.free()
  }
}

class FailFirstCreatePromotionLifecycle extends RunArtifactLifecycle {
  private shouldFail = true

  override async commitCreate(transaction: RunArtifactTransaction): Promise<void> {
    if (this.shouldFail) {
      this.shouldFail = false
      throw new Error('forced create promotion failure')
    }
    await super.commitCreate(transaction)
  }
}

class FailAfterFirstCreatePromotionLifecycle extends RunArtifactLifecycle {
  private shouldFail = true

  override async commitCreate(transaction: RunArtifactTransaction): Promise<void> {
    await super.commitCreate(transaction)
    if (this.shouldFail) {
      this.shouldFail = false
      throw new Error('forced failure after create promotion')
    }
  }
}

class FailFirstRetireCommitLifecycle extends RunArtifactLifecycle {
  private shouldFail = true

  override async commitRetire(transaction: RunArtifactTransaction): Promise<void> {
    if (this.shouldFail) {
      this.shouldFail = false
      throw new Error('forced retire commit failure')
    }
    await super.commitRetire(transaction)
  }
}

beforeEach(async () => {
  counter = 0
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'protocol-runner-store-'))
})

afterEach(async () => {
  if (tempRoot.length > 0) {
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
})

describe('JsonRunnerStore create/load/inspect', () => {
  it('creates its run root before readiness so a later empty list is observational', async () => {
    const runsRoot = path.join(tempRoot, 'fresh-json-runs')
    const store = new JsonRunnerStore({ runs_root: runsRoot })

    await assert.doesNotReject(fs.access(runsRoot))
    await store.getDiagnostics()
    assert.deepEqual(await store.listRuns(), [])
  })

  it('creates a durable run folder with frozen work plan, state, events, and evidence dirs', async () => {
    const store = makeStore()
    const stored = await store.createRun({
      run_instance_id: 'protocol_run_2026_06_25_153012',
      work_plan: makePlan(),
    })

    assert.equal(stored.state.schema_version, RUN_STATE_SCHEMA_VERSION)
    assert.equal(stored.state.status, 'draft')
    assert.equal(stored.state.current_step_id, 'derive_item_001')
    assert.equal(stored.state.current_step_ordinal, 1)

    const paths = store.getRunPaths('protocol_run_2026_06_25_153012')
    await assert.doesNotReject(fs.access(paths.work_plan_path))
    await assert.doesNotReject(fs.access(paths.state_path))
    await assert.doesNotReject(fs.access(paths.events_path))
    await assert.doesNotReject(fs.access(paths.steps_dir))
    await assert.doesNotReject(fs.access(paths.prompts_dir))
    await assert.doesNotReject(fs.access(paths.starts_dir))
    await assert.doesNotReject(fs.access(paths.status_dir))

    const loaded = await store.loadRun('protocol_run_2026_06_25_153012')
    assert.equal(loaded.work_plan.run_title, 'Tiny store proof')
    assert.equal(loaded.state.work_plan_path, 'work_plan.json')

    const events = await store.readEvents('protocol_run_2026_06_25_153012')
    assert.equal(events.length, 1)
    assert.equal(events[0].event_type, 'plan_validated')

    const inspection = await store.inspectRun('protocol_run_2026_06_25_153012')
    assert.ok(inspection.files.includes('work_plan.json'))
    assert.ok(inspection.files.includes('state.json'))
    assert.ok(inspection.files.includes('events.jsonl'))
  })

  it('rejects run ids that could escape the run root', () => {
    const store = makeStore()

    assert.throws(() => store.getRunPaths('../bad'), RunnerStoreError)
    assert.throws(() => store.getRunPaths('BadUppercase'), RunnerStoreError)
    assert.throws(() => store.getRunPaths('bad id'), RunnerStoreError)
  })

  it('deletes a run folder during explicit closeout cleanup', async () => {
    const store = makeStore()
    await store.createRun({
      run_instance_id: 'run_store_delete',
      work_plan: makePlan(),
    })
    const paths = store.getRunPaths('run_store_delete')
    await assert.doesNotReject(fs.access(paths.run_dir))

    const deleted = await store.deleteRun('run_store_delete')
    assert.equal(deleted.ok, true)
    assert.equal(deleted.deleted, true)
    assert.equal(deleted.run_dir, paths.run_dir)

    await assert.rejects(fs.access(paths.run_dir))
    await assert.rejects(store.loadRun('run_store_delete'), RunnerStoreError)
    assert.equal((await store.listRuns()).some((run) => run.run_instance_id === 'run_store_delete'), false)
  })
})

describe('JsonRunnerStore evidence and attempts', () => {
  it('writes step snapshots, prompts, start reports, and status reports without overwriting prior attempts', async () => {
    const store = makeStore()
    await store.createRun({
      run_instance_id: 'run_store_evidence',
      work_plan: makePlan(),
    })

    const step = resolveStep(makePlan(), 'derive_item_001')
    if (step === null) {
      throw new Error('fixture step did not resolve')
    }

    const stepRef = {
      step_id: step.step_id,
      ordinal: step.ordinal,
    }

    const stepSnapshot = await store.writeStepSnapshot('run_store_evidence', step)
    const prompt = await store.writePrompt('run_store_evidence', {
      step: stepRef,
      attempt: 1,
      text: 'prompt body',
    })
    const start = await store.writeStartReport('run_store_evidence', {
      step: stepRef,
      attempt: 1,
      start_report: {
        run_instance_id: 'run_store_evidence',
        step_id: 'derive_item_001',
        prompt_attempt_id: 'attempt_001',
        start_token: 'start-token-001',
      },
    })
    const status = await store.writeStatusReport('run_store_evidence', {
      step: stepRef,
      attempt: 1,
      status_report: {
        run_instance_id: 'run_store_evidence',
        step_id: 'derive_item_001',
        status: 'completed',
        summary: 'done',
      },
    })

    assert.equal(stepSnapshot.relative_path, 'steps/0001_derive_item_001.json')
    assert.equal(prompt.relative_path, 'prompts/0001_derive_item_001.attempt_001.md')
    assert.equal(start.relative_path, 'starts/0001_derive_item_001.attempt_001.json')
    assert.equal(status.relative_path, 'status/0001_derive_item_001.attempt_001.json')
    assert.equal(await store.nextAttemptNumber('run_store_evidence', stepRef), 2)

    await assert.rejects(
      store.writePrompt('run_store_evidence', {
        step: stepRef,
        attempt: 1,
        text: 'overwrite attempt',
      }),
    )
    assert.equal(await readText(prompt.path), 'prompt body')

    const inspection = await store.inspectRun('run_store_evidence')
    assert.equal(inspection.latest_files.prompt, 'prompts/0001_derive_item_001.attempt_001.md')
    assert.equal(inspection.latest_files.start, 'starts/0001_derive_item_001.attempt_001.json')
    assert.equal(inspection.latest_files.status, 'status/0001_derive_item_001.attempt_001.json')
  })

  it('appends JSONL events and can read the latest bounded window', async () => {
    const store = makeStore()
    await store.createRun({
      run_instance_id: 'run_store_events',
      work_plan: makePlan(),
    })

    await store.appendEvent('run_store_events', {
      event_type: 'prompt_rendered',
      step_id: 'derive_item_001',
      details: { attempt: 1 },
    })
    await store.appendEvent('run_store_events', {
      event_type: 'prompt_sent',
      step_id: 'derive_item_001',
      details: { message_id: 'message_001' },
    })

    const events = await store.readEvents('run_store_events')
    assert.equal(events.length, 3)
    assert.equal(events[1].event_type, 'prompt_rendered')
    assert.equal(events[2].details.message_id, 'message_001')

    const latest = await store.readEvents('run_store_events', 1)
    assert.equal(latest.length, 1)
    assert.equal(latest[0].event_type, 'prompt_sent')
  })
})

describe('JsonRunnerStore recovery behavior', () => {
  it('preserves waiting_for_completion_report across reload and recovery', async () => {
    const store = makeStore()
    const stored = await store.createRun({
      run_instance_id: 'run_waiting',
      work_plan: makePlan(),
    })
    const waiting: RunState = {
      ...stored.state,
      status: 'waiting_for_completion_report',
      timestamps: {
        ...stored.state.timestamps,
        updated_at: '2026-06-25T12:10:00.000Z',
      },
    }
    await store.writeState(waiting)

    const reloaded = await store.loadRun('run_waiting')
    assert.equal(reloaded.state.status, 'waiting_for_completion_report')

    const recovery = await store.recoverRun('run_waiting', 'test recovery')
    assert.equal(recovery.ok, true)
    assert.equal(recovery.changed, false)
    assert.equal(recovery.state?.status, 'waiting_for_completion_report')
  })

  it('marks stale running state as blocked during recovery', async () => {
    const store = makeStore()
    const stored = await store.createRun({
      run_instance_id: 'run_running',
      work_plan: makePlan(),
    })
    const running: RunState = {
      ...stored.state,
      status: 'running',
      timestamps: {
        ...stored.state.timestamps,
        updated_at: '2026-06-25T12:20:00.000Z',
      },
    }
    await store.writeState(running)

    const recovery = await store.recoverRun('run_running', 'process restart')
    assert.equal(recovery.ok, true)
    assert.equal(recovery.changed, true)
    assert.equal(recovery.state?.status, 'blocked')

    const reloaded = await store.loadRun('run_running')
    assert.equal(reloaded.state.status, 'blocked')

    const events = await store.readEvents('run_running')
    assert.equal(events.at(-1)?.event_type, 'state_changed')
    assert.equal(events.at(-1)?.details.to_status, 'blocked')
  })

  it('does not rebuild state from corrupt state.json', async () => {
    const store = makeStore()
    await store.createRun({
      run_instance_id: 'run_corrupt',
      work_plan: makePlan(),
    })
    const paths = store.getRunPaths('run_corrupt')
    await fs.writeFile(paths.state_path, '{not json', 'utf8')

    await assert.rejects(store.loadRun('run_corrupt'), RunnerStoreError)
    const recovery = await store.recoverRun('run_corrupt')
    assert.equal(recovery.ok, false)
    assert.equal(recovery.changed, false)
    assert.match(recovery.reason, /Recovery blocked/)
  })
})

describe('SqliteRunnerStore create/load/update', () => {
  it('creates serial runs with SQLite as procedural state and filesystem evidence mirrors', async () => {
    const store = makeSqliteStore()
    const stored = await store.createRun({
      run_instance_id: 'run_sqlite_create',
      work_plan: makePlan(),
      automation: { auto_pickup: true },
    })

    assert.equal(stored.state.status, 'draft')
    assert.equal(stored.state.automation.auto_pickup, true)
    assert.equal(await store.hasRun('run_sqlite_create'), true)

    const paths = store.getRunPaths('run_sqlite_create')
    await assert.doesNotReject(fs.access(paths.work_plan_path))
    await assert.doesNotReject(fs.access(paths.state_path))
    await assert.doesNotReject(fs.access(paths.events_path))

    const listed = await store.listRuns()
    assert.equal(listed.length, 1)
    assert.equal(listed[0].run_instance_id, 'run_sqlite_create')
    assert.equal(listed[0].status, 'draft')
    assert.equal(listed[0].automation.auto_pickup, true)

    const ready: RunState = {
      ...stored.state,
      status: 'ready',
      current_step_id: 'review_item_001',
      current_step_ordinal: 2,
      timestamps: {
        ...stored.state.timestamps,
        updated_at: '2026-06-25T12:30:00.000Z',
      },
    }
    await store.writeState(ready)

    const row = await store.debugGetRunRow('run_sqlite_create')
    assert.equal(row.status, 'ready')
    assert.equal(row.current_step_id, 'review_item_001')
    assert.equal(row.current_step_ordinal, 2)
    const rowState = JSON.parse(row.state_json) as RunState
    assert.equal(rowState.status, 'ready')
    assert.equal(rowState.current_step_id, 'review_item_001')

    const reloaded = await store.loadRun('run_sqlite_create')
    assert.equal(reloaded.state.status, 'ready')
    assert.equal(reloaded.state.current_step_ordinal, 2)
  })

  it('records evidence refs while preserving the current filesystem artifact layout', async () => {
    const store = makeSqliteStore()
    await store.createRun({
      run_instance_id: 'run_sqlite_evidence',
      work_plan: makePlan(),
    })

    const step = resolveStep(makePlan(), 'derive_item_001')
    if (step === null) {
      throw new Error('fixture step did not resolve')
    }
    const stepRef = { step_id: step.step_id, ordinal: step.ordinal }
    await store.writeStepSnapshot('run_sqlite_evidence', step)
    const prompt = await store.writePrompt('run_sqlite_evidence', {
      step: stepRef,
      attempt: 1,
      text: 'sqlite prompt body',
    })
    await store.writeStatusReport('run_sqlite_evidence', {
      step: stepRef,
      attempt: 1,
      status_report: {
        run_instance_id: 'run_sqlite_evidence',
        step_id: 'derive_item_001',
        status: 'completed',
      },
    })

    assert.equal(prompt.relative_path, 'prompts/0001_derive_item_001.attempt_001.md')
    assert.equal(await store.nextAttemptNumber('run_sqlite_evidence', stepRef), 2)

    const events = await store.readEvents('run_sqlite_evidence')
    assert.equal(events.length, 1)
    assert.equal(events[0].event_type, 'plan_validated')

    const inspection = await store.inspectRun('run_sqlite_evidence')
    assert.equal(inspection.latest_files.prompt, 'prompts/0001_derive_item_001.attempt_001.md')
    assert.equal(inspection.latest_files.status, 'status/0001_derive_item_001.attempt_001.json')
  })

  it('recovers stale running SQLite state without rebuilding corrupt or missing runs', async () => {
    const store = makeSqliteStore()
    const stored = await store.createRun({
      run_instance_id: 'run_sqlite_running',
      work_plan: makePlan(),
    })
    await store.writeState({
      ...stored.state,
      status: 'running',
      timestamps: {
        ...stored.state.timestamps,
        updated_at: '2026-06-25T12:40:00.000Z',
      },
    })

    const recovery = await store.recoverRun('run_sqlite_running', 'sqlite restart')
    assert.equal(recovery.ok, true)
    assert.equal(recovery.changed, true)
    assert.equal(recovery.state?.status, 'blocked')

    const events = await store.readEvents('run_sqlite_running')
    assert.equal(events.at(-1)?.event_type, 'state_changed')
    assert.equal(events.at(-1)?.details.reason, 'sqlite restart')
  })

  it('serializes concurrent SQLite writes and persists them to disk', async () => {
    const runsRoot = path.join(tempRoot, 'runs')
    const store = makeSqliteStore(runsRoot)
    await store.createRun({
      run_instance_id: 'run_sqlite_write_queue',
      work_plan: makePlan(),
    })

    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        store.appendEvent('run_sqlite_write_queue', {
          event_type: 'state_changed',
          details: { index },
        }),
      ),
    )

    const reopened = makeSqliteStore(runsRoot)
    const events = await reopened.readEvents('run_sqlite_write_queue')
    assert.equal(events.length, 9)
    assert.deepEqual(
      events
        .slice(1)
        .map((event) => event.details.index)
        .sort((left, right) => Number(left) - Number(right)),
      [0, 1, 2, 3, 4, 5, 6, 7],
    )
  })

  it('materializes parallel group and item state for mixed work plans', async () => {
    const store = makeSqliteStore()
    await store.createRun({
      run_instance_id: 'run_parallel_store',
      work_plan: makeParallelPlan(),
    })

    const groups = await store.listParallelGroups('run_parallel_store')
    assert.equal(groups.length, 1)
    assert.equal(groups[0].group_id, 'nodes_001_002')
    assert.equal(groups[0].status, 'pending')
    assert.equal(groups[0].preflight_status, 'not_run')
    assert.deepEqual(groups[0].required_worker_capabilities, ['json_transform'])
    assert.equal(groups[0].items.length, 2)
    assert.deepEqual(
      groups[0].items.map((item) => [item.item_id, item.status, item.sealed_output_target]),
      [
        [
          'node_001',
          'pending',
          'artifacts/protocol_runner/sealed_outputs/run_parallel_store/nodes_001_002/node_001/output.md',
        ],
        [
          'node_002',
          'pending',
          'artifacts/protocol_runner/sealed_outputs/run_parallel_store/nodes_001_002/node_two/output.md',
        ],
      ],
    )
  })

  it('records parallel preflight state and group-level evidence', async () => {
    const runsRoot = path.join(tempRoot, 'runs')
    const store = makeSqliteStore(runsRoot)
    const work_plan = makeParallelPlan()
    await store.createRun({
      run_instance_id: 'run_parallel_preflight',
      work_plan,
    })

    const step = resolveStep(work_plan, 'derive_nodes_parallel')
    if (step === null || step.step_kind !== 'parallel_group') {
      throw new Error('fixture parallel step did not resolve')
    }
    const result: ParallelPreflightResult = {
      run_instance_id: 'run_parallel_preflight',
      step_id: 'derive_nodes_parallel',
      group_id: 'nodes_001_002',
      passed: true,
      preflight_status: 'passed',
      checked_at: '2026-06-25T12:55:00.000Z',
      checked_by: 'test',
      checks: [
        {
          code: 'test.preflight',
          status: 'passed',
          message: 'test preflight passed',
        },
      ],
      errors: [],
      warnings: [],
      executor_summary: { executor: 'codex_exec' },
      max_concurrency: 2,
      item_count: 2,
      launchable_item_count: 2,
    }

    const recorded = await store.recordParallelPreflight('run_parallel_preflight', { step, result })
    assert.equal(recorded.evidence_file?.relative_path, 'steps/0001_derive_nodes_parallel/parallel_groups/nodes_001_002/preflight.json')
    const preflightText = await readText(recorded.evidence_file?.path ?? '')
    assert.match(preflightText, /"passed": true/)

    const reopened = makeSqliteStore(runsRoot)
    const group = await reopened.getParallelGroup('run_parallel_preflight', 'nodes_001_002')
    assert.equal(group.status, 'ready_to_lease')
    assert.equal(group.preflight_status, 'passed')
    assert.equal(group.preflight_result?.evidence_file?.relative_path, recorded.evidence_file?.relative_path)
  })

  it('grants leases, records heartbeat, and completes a parallel group procedurally', async () => {
    const store = makeSqliteStore()
    const work_plan = makeParallelPlan()
    const step = expectParallelStep(work_plan)
    await store.createRun({
      run_instance_id: 'run_parallel_lease_complete',
      work_plan,
    })
    await store.recordParallelPreflight('run_parallel_lease_complete', {
      step,
      result: makePassingParallelPreflight('run_parallel_lease_complete'),
    })

    const firstGrant = await store.grantParallelLeases('run_parallel_lease_complete', 'nodes_001_002', {
      executor_id: 'executor_001',
      capacity: 1,
    })
    assert.equal(firstGrant.leases.length, 1)
    assert.equal(firstGrant.leases[0].item_id, 'node_001')
    assert.deepEqual(firstGrant.leases[0].variables, {
      selector: 'node_001',
      nested: { preserve: true },
      ordinal: 1,
    })
    assert.deepEqual(firstGrant.leases[0].required_worker_capabilities, ['json_transform'])
    assert.equal(
      Date.parse(firstGrant.leases[0].expires_at ?? '') - Date.parse(firstGrant.leases[0].leased_at),
      DEFAULT_PARALLEL_LEASE_TTL_MS,
    )
    assert.equal(firstGrant.group.status, 'running')
    assert.equal(firstGrant.group.items.find((item) => item.item_id === 'node_001')?.status, 'leased')

    const firstHeartbeatAt = new Date(Date.parse(firstGrant.leases[0].leased_at) + 60_000).toISOString()
    const heartbeat = await store.recordParallelHeartbeat(
      'run_parallel_lease_complete',
      'nodes_001_002',
      firstGrant.leases[0].lease_id,
      { heartbeat_at: firstHeartbeatAt },
    )
    assert.equal(heartbeat.heartbeat_at, firstHeartbeatAt)
    assert.equal(
      Date.parse(heartbeat.expires_at ?? '') - Date.parse(heartbeat.updated_at),
      DEFAULT_PARALLEL_LEASE_TTL_MS,
    )
    let group = await store.getParallelGroup('run_parallel_lease_complete', 'nodes_001_002')
    assert.equal(group.items.find((item) => item.item_id === 'node_001')?.status, 'running')
    assert.equal(group.attempts[0].status, 'running')
    assert.deepEqual(group.attempts[0].warnings, [])

    await assert.rejects(
      store.recordParallelHeartbeat(
        'run_parallel_lease_complete',
        'nodes_001_002',
        firstGrant.leases[0].lease_id,
        { heartbeat_at: firstGrant.leases[0].leased_at },
      ),
      (error: unknown) => error instanceof RunnerStoreError && error.code === 'store.parallel_heartbeat_regressed',
    )

    const secondHeartbeatAt = new Date(Date.parse(firstHeartbeatAt) + 60_000).toISOString()
    const warningHeartbeat = await store.recordParallelHeartbeat(
      'run_parallel_lease_complete',
      'nodes_001_002',
      firstGrant.leases[0].lease_id,
      {
        heartbeat_at: secondHeartbeatAt,
        attempt_warnings: [
          {
            code: 'long_running',
            severity: 'warning',
            message: 'attempt crossed soft long-running threshold',
            observed_at: secondHeartbeatAt,
            threshold_ms: 60_000,
            elapsed_ms: 60_000,
          },
        ],
      },
    )
    assert.equal(
      Date.parse(warningHeartbeat.expires_at ?? '') - Date.parse(warningHeartbeat.updated_at),
      DEFAULT_PARALLEL_LEASE_TTL_MS,
    )
    group = await store.getParallelGroup('run_parallel_lease_complete', 'nodes_001_002')
    assert.equal(group.items.find((item) => item.item_id === 'node_001')?.status, 'running')
    assert.equal(group.attempts[0].status, 'running')
    assert.deepEqual(group.attempts[0].warnings.map((warning) => warning.code), ['long_running'])

    await store.recordParallelAttemptResult('run_parallel_lease_complete', 'nodes_001_002', {
      lease_id: firstGrant.leases[0].lease_id,
      attempt_id: firstGrant.leases[0].attempt_id,
      status: 'completed',
      status_report: {
        status: 'completed',
      },
      sealed_output_path: firstGrant.leases[0].sealed_output_path,
    })
    group = await store.getParallelGroup('run_parallel_lease_complete', 'nodes_001_002')
    assert.equal(group.items.find((item) => item.item_id === 'node_001')?.status, 'completed')
    assert.equal(group.status, 'running')
    assert.equal(group.leases[0].status, 'released')

    const secondGrant = await store.grantParallelLeases('run_parallel_lease_complete', 'nodes_001_002', {
      executor_id: 'executor_001',
      capacity: 5,
    })
    assert.equal(secondGrant.leases.length, 1)
    assert.equal(secondGrant.leases[0].item_id, 'node_002')
    assert.deepEqual(secondGrant.leases[0].variables, {})
    const completed = await store.recordParallelAttemptResult('run_parallel_lease_complete', 'nodes_001_002', {
      lease_id: secondGrant.leases[0].lease_id,
      attempt_id: secondGrant.leases[0].attempt_id,
      status: 'completed',
      status_report: {
        status: 'completed',
      },
      sealed_output_path: secondGrant.leases[0].sealed_output_path,
    })
    assert.equal(completed.group.status, 'completed')
    assert.deepEqual(
      completed.group.items.map((item) => [item.item_id, item.status]),
      [
        ['node_001', 'completed'],
        ['node_002', 'completed'],
      ],
    )
  })

  it('uses store time to reject a stale reported heartbeat after lease expiry', async () => {
    let storeNow = new Date('2026-06-25T12:00:00.000Z')
    const store = new SqliteRunnerStore({
      runs_root: path.join(tempRoot, 'runs'),
      db_path: path.join(tempRoot, 'protocol_runner.sqlite'),
      now: () => new Date(storeNow),
    })
    const work_plan = makeParallelPlan()
    const step = expectParallelStep(work_plan)
    await store.createRun({
      run_instance_id: 'run_parallel_expired_heartbeat',
      work_plan,
    })
    await store.recordParallelPreflight('run_parallel_expired_heartbeat', {
      step,
      result: makePassingParallelPreflight('run_parallel_expired_heartbeat'),
    })
    const grant = await store.grantParallelLeases('run_parallel_expired_heartbeat', 'nodes_001_002', {
      executor_id: 'executor_001',
      capacity: 1,
      lease_ttl_ms: 1_000,
    })
    const lease = grant.leases[0]
    storeNow = new Date(Date.parse(lease.expires_at ?? '') + 1)

    await assert.rejects(
      store.recordParallelHeartbeat('run_parallel_expired_heartbeat', 'nodes_001_002', lease.lease_id, {
        heartbeat_at: lease.leased_at,
      }),
      (error: unknown) => error instanceof RunnerStoreError && error.code === 'store.parallel_lease_expired',
    )
    await assert.rejects(
      store.recordParallelAttemptResult('run_parallel_expired_heartbeat', 'nodes_001_002', {
        lease_id: lease.lease_id,
        attempt_id: lease.attempt_id,
        status: 'completed',
      }),
      (error: unknown) => error instanceof RunnerStoreError && error.code === 'store.parallel_lease_expired',
    )

    const group = await store.getParallelGroup('run_parallel_expired_heartbeat', 'nodes_001_002')
    assert.equal(group.leases[0].heartbeat_at, null)
    assert.equal(group.leases[0].expires_at, lease.expires_at)
  })

  it('classifies evidence-missing results conservatively and requires explicit retry', async () => {
    const store = makeSqliteStore()
    const work_plan = makeParallelPlan()
    const step = expectParallelStep(work_plan)
    await store.createRun({
      run_instance_id: 'run_parallel_retry',
      work_plan,
    })
    await store.recordParallelPreflight('run_parallel_retry', {
      step,
      result: makePassingParallelPreflight('run_parallel_retry'),
    })
    const grant = await store.grantParallelLeases('run_parallel_retry', 'nodes_001_002', {
      executor_id: 'executor_001',
      capacity: 1,
    })

    const missing = await store.recordParallelAttemptResult('run_parallel_retry', 'nodes_001_002', {
      lease_id: grant.leases[0].lease_id,
      attempt_id: grant.leases[0].attempt_id,
      status: 'evidence_missing',
      summary: 'fake worker omitted required status evidence',
    })
    assert.equal(missing.group.status, 'needs_attention')
    assert.equal(missing.attempt.status, 'evidence_missing')
    assert.equal(missing.group.items.find((item) => item.item_id === 'node_001')?.status, 'needs_recovery')

    const retry = await store.retryParallelItem('run_parallel_retry', 'nodes_001_002', 'node_001', {
      requested_by: 'test',
      reason: 'retry after missing evidence',
    })
    assert.equal(retry.previous_attempt_id, grant.leases[0].attempt_id)
    assert.equal(retry.attempt.status, 'created')
    assert.equal(retry.group.status, 'ready_to_lease')
    assert.equal(retry.group.items.find((item) => item.item_id === 'node_001')?.status, 'pending')

    const retryGrant = await store.grantParallelLeases('run_parallel_retry', 'nodes_001_002', {
      executor_id: 'executor_001',
      capacity: 1,
    })
    assert.equal(retryGrant.leases[0].attempt_id, retry.attempt.attempt_id)
    assert.notEqual(retryGrant.leases[0].attempt_id, grant.leases[0].attempt_id)
  })

  it('expires stale active leases conservatively without relaunching or completing work', async () => {
    const store = makeSqliteStore()
    const work_plan = makeParallelPlan()
    const step = expectParallelStep(work_plan)
    await store.createRun({
      run_instance_id: 'run_parallel_stale_lease',
      work_plan,
    })
    await store.recordParallelPreflight('run_parallel_stale_lease', {
      step,
      result: makePassingParallelPreflight('run_parallel_stale_lease'),
    })
    const grant = await store.grantParallelLeases('run_parallel_stale_lease', 'nodes_001_002', {
      executor_id: 'executor_001',
      capacity: 1,
      lease_ttl_ms: 1,
    })
    await fs.mkdir(grant.leases[0].attempt_dir, { recursive: true })

    const recovery = await store.recoverStaleParallelLeases('run_parallel_stale_lease', 'nodes_001_002', {
      observed_at: '2026-06-25T12:30:00.000Z',
    })

    assert.deepEqual(recovery.stale_lease_ids, [grant.leases[0].lease_id])
    assert.deepEqual(recovery.stale_attempt_ids, [grant.leases[0].attempt_id])
    assert.deepEqual(recovery.stale_item_ids, ['node_001'])
    assert.deepEqual(recovery.requeued_lease_ids, [])
    assert.deepEqual(recovery.attention_lease_ids, [grant.leases[0].lease_id])
    assert.equal(recovery.group.status, 'needs_attention')
    assert.equal(recovery.group.leases[0].status, 'expired')
    assert.equal(recovery.group.attempts[0].status, 'stale')
    assert.equal(recovery.group.items.find((item) => item.item_id === 'node_001')?.status, 'needs_recovery')
    assert.equal(recovery.group.items.find((item) => item.item_id === 'node_002')?.status, 'pending')

    let noFurtherLeases: unknown
    try {
      await store.grantParallelLeases('run_parallel_stale_lease', 'nodes_001_002', {
        executor_id: 'executor_001',
        capacity: 1,
      })
    } catch (error) {
      noFurtherLeases = error
    }
    assert.ok(noFurtherLeases instanceof RunnerStoreError)
    assert.equal((noFurtherLeases as RunnerStoreError).code, 'store.parallel_group_not_leaseable')
  })

  it('automatically requeues the same expired attempt only when its attempt directory is absent', async () => {
    const store = makeSqliteStore()
    const work_plan = makeParallelPlan()
    const step = expectParallelStep(work_plan)
    await store.createRun({
      run_instance_id: 'run_parallel_never_launched',
      work_plan,
    })
    await store.recordParallelPreflight('run_parallel_never_launched', {
      step,
      result: makePassingParallelPreflight('run_parallel_never_launched'),
    })
    const grant = await store.grantParallelLeases('run_parallel_never_launched', 'nodes_001_002', {
      executor_id: 'executor_001',
      capacity: 1,
    })
    const firstLease = grant.leases[0]
    assert.equal(await fs.stat(firstLease.attempt_dir).then(() => true, () => false), false)

    const recovery = await store.recoverStaleParallelLeases('run_parallel_never_launched', 'nodes_001_002', {
      observed_at: new Date(Date.parse(firstLease.expires_at ?? '') + 1).toISOString(),
    })

    assert.deepEqual(recovery.stale_lease_ids, [firstLease.lease_id])
    assert.deepEqual(recovery.stale_attempt_ids, [])
    assert.deepEqual(recovery.stale_item_ids, [])
    assert.deepEqual(recovery.requeued_lease_ids, [firstLease.lease_id])
    assert.deepEqual(recovery.requeued_attempt_ids, [firstLease.attempt_id])
    assert.deepEqual(recovery.requeued_item_ids, [firstLease.item_id])
    assert.deepEqual(recovery.attention_lease_ids, [])
    assert.equal(recovery.group.leases[0].status, 'expired')
    assert.equal(recovery.group.attempts[0].status, 'created')
    assert.equal(recovery.group.items.find((item) => item.item_id === firstLease.item_id)?.status, 'pending')

    const secondGrant = await store.grantParallelLeases('run_parallel_never_launched', 'nodes_001_002', {
      executor_id: 'executor_001',
      capacity: 1,
    })
    assert.equal(secondGrant.leases[0].attempt_id, firstLease.attempt_id)
    assert.notEqual(secondGrant.leases[0].lease_id, firstLease.lease_id)

    await assert.rejects(
      store.recordParallelAttemptResult('run_parallel_never_launched', 'nodes_001_002', {
        lease_id: firstLease.lease_id,
        attempt_id: firstLease.attempt_id,
        status: 'completed',
      }),
      (error: unknown) => error instanceof RunnerStoreError && error.code === 'store.parallel_lease_not_active',
    )
    const stillReacquired = await store.getParallelGroup('run_parallel_never_launched', 'nodes_001_002')
    assert.equal(stillReacquired.attempts[0].status, 'leased')
    assert.equal(stillReacquired.items.find((item) => item.item_id === firstLease.item_id)?.status, 'leased')

    const completed = await store.recordParallelAttemptResult('run_parallel_never_launched', 'nodes_001_002', {
      lease_id: secondGrant.leases[0].lease_id,
      attempt_id: secondGrant.leases[0].attempt_id,
      status: 'completed',
    })
    assert.equal(completed.attempt.status, 'completed')
    assert.equal(completed.lease?.status, 'released')
  })

  it('keeps a dangling attempt-directory junction on the conservative recovery path', async () => {
    const store = makeSqliteStore()
    const work_plan = makeParallelPlan()
    const step = expectParallelStep(work_plan)
    await store.createRun({
      run_instance_id: 'run_parallel_dangling_attempt',
      work_plan,
    })
    await store.recordParallelPreflight('run_parallel_dangling_attempt', {
      step,
      result: makePassingParallelPreflight('run_parallel_dangling_attempt'),
    })
    const grant = await store.grantParallelLeases('run_parallel_dangling_attempt', 'nodes_001_002', {
      executor_id: 'executor_001',
      capacity: 1,
      lease_ttl_ms: 1,
    })
    const lease = grant.leases[0]
    const junctionTarget = path.join(tempRoot, 'removed-attempt-target')
    await fs.mkdir(junctionTarget, { recursive: true })
    await fs.mkdir(path.dirname(lease.attempt_dir), { recursive: true })
    await fs.symlink(junctionTarget, lease.attempt_dir, 'junction')
    await fs.rm(junctionTarget, { recursive: true })

    const recovery = await store.recoverStaleParallelLeases('run_parallel_dangling_attempt', 'nodes_001_002', {
      observed_at: new Date(Date.parse(lease.expires_at ?? '') + 1).toISOString(),
    })

    assert.deepEqual(recovery.requeued_lease_ids, [])
    assert.deepEqual(recovery.attention_lease_ids, [lease.lease_id])
    assert.equal(recovery.group.attempts[0].status, 'stale')
    assert.equal(recovery.group.items.find((item) => item.item_id === lease.item_id)?.status, 'needs_recovery')
  })

  it('does not auto-requeue through an intermediate attempt-path junction', async () => {
    const store = makeSqliteStore()
    const work_plan = makeParallelPlan()
    const step = expectParallelStep(work_plan)
    await store.createRun({
      run_instance_id: 'run_parallel_redirected_attempts',
      work_plan,
    })
    await store.recordParallelPreflight('run_parallel_redirected_attempts', {
      step,
      result: makePassingParallelPreflight('run_parallel_redirected_attempts'),
    })
    const grant = await store.grantParallelLeases('run_parallel_redirected_attempts', 'nodes_001_002', {
      executor_id: 'executor_001',
      capacity: 1,
      lease_ttl_ms: 1,
    })
    const lease = grant.leases[0]
    const attemptsAncestor = path.dirname(lease.attempt_dir)
    const externalAttempts = path.join(tempRoot, 'external-attempts')
    await fs.mkdir(path.dirname(attemptsAncestor), { recursive: true })
    await fs.mkdir(externalAttempts, { recursive: true })
    await fs.symlink(externalAttempts, attemptsAncestor, 'junction')

    const recovery = await store.recoverStaleParallelLeases('run_parallel_redirected_attempts', 'nodes_001_002', {
      observed_at: new Date(Date.parse(lease.expires_at ?? '') + 1).toISOString(),
    })

    assert.deepEqual(recovery.requeued_lease_ids, [])
    assert.deepEqual(recovery.attention_lease_ids, [lease.lease_id])
    assert.equal(recovery.group.attempts[0].status, 'stale')
    assert.equal(recovery.group.items.find((item) => item.item_id === lease.item_id)?.status, 'needs_recovery')
    await assert.rejects(fs.stat(path.join(externalAttempts, lease.attempt_id)))
  })

  it('preserves an operator-paused group while requeueing an expired never-launched lease', async () => {
    const store = makeSqliteStore()
    const work_plan = makeParallelPlan()
    const step = expectParallelStep(work_plan)
    await store.createRun({
      run_instance_id: 'run_parallel_paused_requeue',
      work_plan,
    })
    await store.recordParallelPreflight('run_parallel_paused_requeue', {
      step,
      result: makePassingParallelPreflight('run_parallel_paused_requeue'),
    })
    const grant = await store.grantParallelLeases('run_parallel_paused_requeue', 'nodes_001_002', {
      executor_id: 'executor_001',
      capacity: 1,
      lease_ttl_ms: 1,
    })
    const lease = grant.leases[0]
    const paused = await store.controlParallelGroup('run_parallel_paused_requeue', 'nodes_001_002', 'pause')
    assert.equal(paused.status, 'paused')

    const recovery = await store.recoverStaleParallelLeases('run_parallel_paused_requeue', 'nodes_001_002', {
      observed_at: new Date(Date.parse(lease.expires_at ?? '') + 1).toISOString(),
    })

    assert.deepEqual(recovery.requeued_lease_ids, [lease.lease_id])
    assert.equal(recovery.group.status, 'paused')
    assert.equal(recovery.group.attempts[0].status, 'created')
    assert.equal(recovery.group.items.find((item) => item.item_id === lease.item_id)?.status, 'pending')
    await assert.rejects(
      store.grantParallelLeases('run_parallel_paused_requeue', 'nodes_001_002', {
        executor_id: 'executor_001',
        capacity: 1,
      }),
      (error: unknown) => error instanceof RunnerStoreError && error.code === 'store.parallel_group_not_leaseable',
    )
  })

  it('applies the default grace to legacy active leases with null expiry', async () => {
    const runsRoot = path.join(tempRoot, 'runs')
    const dbPath = path.join(tempRoot, 'protocol_runner.sqlite')
    const store = makeSqliteStore(runsRoot)
    const work_plan = makeParallelPlan()
    const step = expectParallelStep(work_plan)
    await store.createRun({
      run_instance_id: 'run_parallel_legacy_null_expiry',
      work_plan,
    })
    await store.recordParallelPreflight('run_parallel_legacy_null_expiry', {
      step,
      result: makePassingParallelPreflight('run_parallel_legacy_null_expiry'),
    })
    const grant = await store.grantParallelLeases('run_parallel_legacy_null_expiry', 'nodes_001_002', {
      executor_id: 'legacy_executor',
      capacity: 1,
    })
    await mutateSqliteFile(dbPath, (db) => {
      db.run('UPDATE parallel_leases SET expires_at = NULL WHERE run_instance_id = ?', [
        'run_parallel_legacy_null_expiry',
      ])
    })

    const reopened = new SqliteRunnerStore({ runs_root: runsRoot, db_path: dbPath, now: nextDate })
    const recovery = await reopened.recoverStaleParallelLeases(
      'run_parallel_legacy_null_expiry',
      'nodes_001_002',
      {
        observed_at: new Date(Date.parse(grant.leases[0].leased_at) + DEFAULT_PARALLEL_LEASE_TTL_MS + 1).toISOString(),
      },
    )

    assert.deepEqual(recovery.requeued_lease_ids, [grant.leases[0].lease_id])
    assert.deepEqual(recovery.attention_lease_ids, [])
    assert.equal(recovery.group.attempts[0].status, 'created')
    assert.equal(recovery.group.items[0].status, 'pending')
  })

  it('keeps foreign-key enforcement enabled after initial open and repeated persisted writes', async () => {
    const store = makeSqliteStore()
    const initial = await store.getDiagnostics()
    assert.equal(initial.sqlite?.schema_version, '2')
    assert.equal(initial.sqlite?.foreign_keys_enabled, true)
    assert.equal(initial.sqlite?.foreign_key_violation_count, 0)

    await store.createRun({
      run_instance_id: 'run_sqlite_foreign_keys',
      work_plan: makePlan(),
    })
    for (let index = 0; index < 5; index += 1) {
      await store.appendEvent('run_sqlite_foreign_keys', {
        event_type: 'diagnostic',
        details: { index },
      })
    }

    const afterWrites = await store.getDiagnostics()
    assert.equal(afterWrites.sqlite?.foreign_keys_enabled, true)
    assert.equal(afterWrites.sqlite?.foreign_key_violation_count, 0)
  })

  it('migrates v1 by deleting only parentless descendants while preserving valid run state', async () => {
    const dbPath = path.join(tempRoot, 'protocol_runner.sqlite')
    const runsRoot = path.join(tempRoot, 'runs')
    const original = makeSqliteStore(runsRoot)
    await original.createRun({
      run_instance_id: 'run_valid_during_migration',
      work_plan: makePlan(),
    })
    await original.appendEvent('run_valid_during_migration', {
      event_type: 'diagnostic',
      details: { remains: true },
    })

    await mutateSqliteFile(dbPath, (db) => {
      db.exec('PRAGMA foreign_keys = OFF;')
      db.run("UPDATE runner_schema SET value = '1' WHERE key = 'schema_version'")
      db.run(
        'INSERT INTO run_steps (run_instance_id, step_id, ordinal, step_kind, step_json) VALUES (?, ?, ?, ?, ?)',
        ['run_parentless', 'orphan_step', 1, 'work', '{}'],
      )
      db.run(
        `INSERT INTO runner_events
          (event_id, run_instance_id, event_type, step_id, timestamp, details_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['orphan_event', 'run_parentless', 'diagnostic', null, '2026-06-25T12:00:00.000Z', '{}'],
      )
      db.run(
        `INSERT INTO evidence_files
          (run_instance_id, kind, step_id, ordinal, attempt, relative_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ['run_parentless', 'step', null, null, null, 'steps/orphan.json', '2026-06-25T12:00:00.000Z'],
      )
      db.run(
        `INSERT INTO parallel_groups
          (run_instance_id, step_id, group_id, ordinal, status, executor, contract_ref, max_concurrency,
           group_json, preflight_status, preflight_errors_json, preflight_warnings_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'run_parentless',
          'orphan_parallel_step',
          'orphan_group',
          1,
          'pending',
          'codex_exec',
          'docs/contracts/Contract_A.md',
          1,
          '{}',
          'not_run',
          '[]',
          '[]',
          '2026-06-25T12:00:00.000Z',
          '2026-06-25T12:00:00.000Z',
        ],
      )
      db.run(
        `INSERT INTO parallel_items
          (run_instance_id, step_id, group_id, item_id, status, input_ref, contract_ref, variables_json,
           sealed_output_json, sealed_output_target, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'run_parentless',
          'orphan_parallel_step',
          'orphan_group',
          'orphan_item',
          'pending',
          'docs/items.md#orphan',
          'docs/contracts/Contract_A.md',
          '{}',
          '{}',
          'artifacts/orphan/output.md',
          '2026-06-25T12:00:00.000Z',
          '2026-06-25T12:00:00.000Z',
        ],
      )
      db.run(
        `INSERT INTO parallel_attempts
          (run_instance_id, step_id, group_id, item_id, attempt_id, attempt_number, status, warnings_json,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'run_parentless',
          'orphan_parallel_step',
          'orphan_group',
          'orphan_item',
          'orphan_attempt',
          1,
          'created',
          '[]',
          '2026-06-25T12:00:00.000Z',
          '2026-06-25T12:00:00.000Z',
        ],
      )
      db.run(
        `INSERT INTO parallel_leases
          (run_instance_id, step_id, group_id, item_id, attempt_id, lease_id, executor_id, status,
           leased_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'run_parentless',
          'orphan_parallel_step',
          'orphan_group',
          'orphan_item',
          'orphan_attempt',
          'orphan_lease',
          'executor_test',
          'active',
          '2026-06-25T12:00:00.000Z',
          '2026-06-25T12:00:00.000Z',
          '2026-06-25T12:00:00.000Z',
        ],
      )
    })

    const migrated = makeSqliteStore(runsRoot)
    const diagnostics = await migrated.getDiagnostics()
    assert.equal(diagnostics.sqlite?.migrated_from, '1')
    assert.equal(diagnostics.sqlite?.foreign_keys_enabled, true)
    assert.equal(diagnostics.sqlite?.foreign_key_violation_count, 0)
    assert.deepEqual(diagnostics.sqlite?.orphan_rows_removed, {
      parallel_leases: 1,
      parallel_attempts: 1,
      parallel_items: 1,
      parallel_groups: 1,
      evidence_files: 1,
      runner_events: 1,
      run_steps: 1,
    })
    assert.equal((await migrated.loadRun('run_valid_during_migration')).state.status, 'draft')
    assert.equal((await migrated.readEvents('run_valid_during_migration')).length, 2)

    await withSqliteFile(dbPath, (db) => {
      assert.equal(sqliteScalar(db, "SELECT COUNT(*) FROM runs WHERE run_instance_id = 'run_valid_during_migration'"), 1)
      assert.equal(sqliteScalar(db, "SELECT COUNT(*) FROM run_steps WHERE run_instance_id = 'run_valid_during_migration'"), 2)
      assert.equal(sqliteScalar(db, "SELECT COUNT(*) FROM runner_events WHERE run_instance_id = 'run_valid_during_migration'"), 2)
      assert.equal(sqliteScalar(db, "SELECT COUNT(*) FROM runner_events WHERE run_instance_id = 'run_parentless'"), 0)
      assert.equal(db.exec('PRAGMA foreign_key_check').length, 0)
    })
  })

  it('refuses v1 migration when a violation belongs to an existing run', async () => {
    const dbPath = path.join(tempRoot, 'protocol_runner.sqlite')
    const runsRoot = path.join(tempRoot, 'runs')
    const original = makeSqliteStore(runsRoot)
    await original.createRun({
      run_instance_id: 'run_integrity_violation',
      work_plan: makePlan(),
    })

    await mutateSqliteFile(dbPath, (db) => {
      db.exec('PRAGMA foreign_keys = OFF;')
      db.run("UPDATE runner_schema SET value = '1' WHERE key = 'schema_version'")
      db.run(
        `INSERT INTO parallel_items
          (run_instance_id, step_id, group_id, item_id, status, input_ref, contract_ref, variables_json,
           sealed_output_json, sealed_output_target, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'run_integrity_violation',
          'missing_parallel_step',
          'missing_group',
          'stranded_item',
          'pending',
          'docs/items.md#stranded',
          'docs/contracts/Contract_A.md',
          '{}',
          '{}',
          'artifacts/stranded/output.md',
          '2026-06-25T12:00:00.000Z',
          '2026-06-25T12:00:00.000Z',
        ],
      )
    })

    const reopened = makeSqliteStore(runsRoot)
    await assert.rejects(
      reopened.getDiagnostics(),
      (error: unknown) => error instanceof RunnerStoreError && error.code === 'store.foreign_key_integrity_failed',
    )
  })

  it('rolls back the complete run graph and staged artifacts after a forced mid-create failure', async () => {
    const runsRoot = path.join(tempRoot, 'runs')
    const dbPath = path.join(tempRoot, 'protocol_runner.sqlite')
    let eventId = 'duplicate_initial_event'
    const store = new SqliteRunnerStore({
      runs_root: runsRoot,
      db_path: dbPath,
      now: nextDate,
      event_id_factory: () => eventId,
    })
    await store.createRun({ run_instance_id: 'run_existing_event', work_plan: makePlan() })

    await assert.rejects(store.createRun({ run_instance_id: 'run_failed_create', work_plan: makeParallelPlan() }))
    assert.equal(await store.hasRun('run_failed_create'), false)
    await assert.rejects(fs.access(store.getRunPaths('run_failed_create').run_dir))
    assert.equal((await store.listRuns()).some((run) => run.run_instance_id === 'run_failed_create'), false)
    await withSqliteFile(dbPath, (db) => {
      for (const table of [
        'runs',
        'run_steps',
        'runner_events',
        'evidence_files',
        'parallel_groups',
        'parallel_items',
        'parallel_attempts',
        'parallel_leases',
      ]) {
        assert.equal(
          sqliteScalar(db, `SELECT COUNT(*) FROM ${table} WHERE run_instance_id = ?`, ['run_failed_create']),
          0,
          table,
        )
      }
    })

    eventId = 'replacement_initial_event'
    const recreated = await store.createRun({ run_instance_id: 'run_failed_create', work_plan: makeParallelPlan() })
    assert.equal(recreated.state.status, 'draft')
    assert.equal((await store.listParallelGroups('run_failed_create')).length, 1)
  })

  it('compensates forced create-promotion failures in both SQLite and JSON stores', async () => {
    const sqliteRunsRoot = path.join(tempRoot, 'sqlite-runs')
    const sqliteLifecycle = new FailFirstCreatePromotionLifecycle({ runs_root: sqliteRunsRoot })
    const sqliteStore = new SqliteRunnerStore({
      runs_root: sqliteRunsRoot,
      db_path: path.join(tempRoot, 'promotion.sqlite'),
      artifact_lifecycle: sqliteLifecycle,
      now: nextDate,
    })
    await assert.rejects(
      sqliteStore.createRun({ run_instance_id: 'run_sqlite_promotion', work_plan: makePlan() }),
      /forced create promotion failure/,
    )
    assert.equal(await sqliteStore.hasRun('run_sqlite_promotion'), false)
    await assert.rejects(fs.access(sqliteStore.getRunPaths('run_sqlite_promotion').run_dir))
    assert.equal((await sqliteStore.listRuns()).length, 0)
    assert.equal(
      (await sqliteStore.createRun({ run_instance_id: 'run_sqlite_promotion', work_plan: makePlan() })).state.status,
      'draft',
    )

    const jsonRunsRoot = path.join(tempRoot, 'json-runs')
    const jsonLifecycle = new FailFirstCreatePromotionLifecycle({ runs_root: jsonRunsRoot })
    const jsonStore = new JsonRunnerStore({
      runs_root: jsonRunsRoot,
      artifact_lifecycle: jsonLifecycle,
      now: nextDate,
    })
    await assert.rejects(
      jsonStore.createRun({ run_instance_id: 'run_json_promotion', work_plan: makePlan() }),
      /forced create promotion failure/,
    )
    await assert.rejects(fs.access(jsonStore.getRunPaths('run_json_promotion').run_dir))
    assert.equal((await jsonStore.listRuns()).length, 0)
    assert.equal(
      (await jsonStore.createRun({ run_instance_id: 'run_json_promotion', work_plan: makePlan() })).state.status,
      'draft',
    )
  })

  it('removes a JSON run when failure occurs after staged material was promoted', async () => {
    const runsRoot = path.join(tempRoot, 'json-after-promotion-runs')
    const store = new JsonRunnerStore({
      runs_root: runsRoot,
      artifact_lifecycle: new FailAfterFirstCreatePromotionLifecycle({ runs_root: runsRoot }),
      now: nextDate,
    })

    await assert.rejects(
      store.createRun({ run_instance_id: 'run_json_after_promotion', work_plan: makePlan() }),
      /forced failure after create promotion/,
    )
    await assert.rejects(fs.access(store.getRunPaths('run_json_after_promotion').run_dir))
    assert.equal((await store.listRuns()).some((run) => run.run_instance_id === 'run_json_after_promotion'), false)
    assert.equal(
      (await store.createRun({ run_instance_id: 'run_json_after_promotion', work_plan: makePlan() })).state.status,
      'draft',
    )
  })

  it('finishes SQLite retirement after durable DB deletion and restores JSON retirement on commit failure', async () => {
    const sqliteRunsRoot = path.join(tempRoot, 'sqlite-retire-runs')
    const sqliteStore = new SqliteRunnerStore({
      runs_root: sqliteRunsRoot,
      db_path: path.join(tempRoot, 'retire.sqlite'),
      artifact_lifecycle: new FailFirstRetireCommitLifecycle({ runs_root: sqliteRunsRoot }),
      now: nextDate,
    })
    await sqliteStore.createRun({ run_instance_id: 'run_sqlite_retire', work_plan: makePlan() })
    await assert.rejects(sqliteStore.deleteRun('run_sqlite_retire'), /forced retire commit failure/)
    await assert.rejects(sqliteStore.loadRun('run_sqlite_retire'), RunnerStoreError)
    await assert.rejects(fs.access(sqliteStore.getRunPaths('run_sqlite_retire').run_dir))
    assert.equal(
      (await sqliteStore.createRun({ run_instance_id: 'run_sqlite_retire', work_plan: makePlan() })).state.status,
      'draft',
    )
    await sqliteStore.deleteRun('run_sqlite_retire')

    const jsonRunsRoot = path.join(tempRoot, 'json-retire-runs')
    const jsonStore = new JsonRunnerStore({
      runs_root: jsonRunsRoot,
      artifact_lifecycle: new FailFirstRetireCommitLifecycle({ runs_root: jsonRunsRoot }),
      now: nextDate,
    })
    await jsonStore.createRun({ run_instance_id: 'run_json_retire', work_plan: makePlan() })
    await assert.rejects(jsonStore.deleteRun('run_json_retire'), /forced retire commit failure/)
    assert.equal((await jsonStore.loadRun('run_json_retire')).state.status, 'draft')
    await assert.doesNotReject(fs.access(jsonStore.getRunPaths('run_json_retire').run_dir))
    await jsonStore.deleteRun('run_json_retire')
  })

  it('reconciles interrupted committed create and retirement transactions during SQLite initialization', async () => {
    const runsRoot = path.join(tempRoot, 'reconcile-runs')
    const dbPath = path.join(tempRoot, 'reconcile.sqlite')
    const original = new SqliteRunnerStore({ runs_root: runsRoot, db_path: dbPath, now: nextDate })
    await original.createRun({ run_instance_id: 'run_reconcile_create', work_plan: makePlan() })

    const lifecycle = new RunArtifactLifecycle({ runs_root: runsRoot })
    const interruptedCreate = await lifecycle.beginCreate('run_reconcile_create')
    await fs.rm(interruptedCreate.staged_run_dir, { recursive: true })
    await fs.rename(interruptedCreate.final_run_dir, interruptedCreate.staged_run_dir)

    const reopenedAfterCreate = new SqliteRunnerStore({ runs_root: runsRoot, db_path: dbPath, now: nextDate })
    const createDiagnostics = await reopenedAfterCreate.getDiagnostics()
    assert.equal(createDiagnostics.artifact_reconciliation?.create_finalized, 1)
    assert.equal((await reopenedAfterCreate.loadRun('run_reconcile_create')).state.status, 'draft')

    const interruptedRetire = await lifecycle.beginRetire('run_reconcile_create')
    const reopenedAfterRetire = new SqliteRunnerStore({ runs_root: runsRoot, db_path: dbPath, now: nextDate })
    const retireDiagnostics = await reopenedAfterRetire.getDiagnostics()
    assert.equal(retireDiagnostics.artifact_reconciliation?.retire_restored, 1)
    assert.equal((await reopenedAfterRetire.loadRun('run_reconcile_create')).state.status, 'draft')
    assert.equal(await fs.stat(interruptedRetire.final_run_dir).then((stat) => stat.isDirectory()), true)
  })

  it('fully deletes descendants and permits serial and parallel run-id reuse', async () => {
    const runsRoot = path.join(tempRoot, 'reuse-runs')
    const dbPath = path.join(tempRoot, 'reuse.sqlite')
    const store = new SqliteRunnerStore({ runs_root: runsRoot, db_path: dbPath, now: nextDate })
    const cases = [
      { run_instance_id: 'run_reuse_serial', work_plan: makePlan() },
      { run_instance_id: 'run_reuse_parallel', work_plan: makeParallelPlan() },
    ]

    for (const fixture of cases) {
      await store.createRun(fixture)
      await store.deleteRun(fixture.run_instance_id)
      await withSqliteFile(dbPath, (db) => {
        for (const table of [
          'runs',
          'run_steps',
          'runner_events',
          'evidence_files',
          'parallel_groups',
          'parallel_items',
          'parallel_attempts',
          'parallel_leases',
        ]) {
          assert.equal(
            sqliteScalar(db, `SELECT COUNT(*) FROM ${table} WHERE run_instance_id = ?`, [fixture.run_instance_id]),
            0,
            `${fixture.run_instance_id}/${table}`,
          )
        }
      })

      const recreated = await store.createRun(fixture)
      assert.equal(recreated.state.status, 'draft')
      if (fixture.work_plan.execution_mode === 'mixed') {
        assert.equal((await store.listParallelGroups(fixture.run_instance_id)).length, 1)
      }
      await store.deleteRun(fixture.run_instance_id)
    }
  })
})

describe('HybridRunnerStore SQLite primary with JSON fallback', () => {
  it('creates new runs in SQLite while loading existing JSON runs as legacy fallback', async () => {
    const runsRoot = path.join(tempRoot, 'runs')
    const legacy = new JsonRunnerStore({
      runs_root: runsRoot,
      now: nextDate,
      event_id_factory: () => `legacy_event_${String(counter + 1).padStart(3, '0')}`,
    })
    await legacy.createRun({
      run_instance_id: 'legacy_json_run',
      work_plan: makePlan(),
    })

    const primary = makeSqliteStore(runsRoot)
    const hybrid = new HybridRunnerStore({ primary, legacy_json: legacy })

    await assert.rejects(
      hybrid.createRun({
        run_instance_id: 'legacy_json_run',
        work_plan: makePlan(),
      }),
      RunnerStoreError,
    )

    const created = await hybrid.createRun({
      run_instance_id: 'new_sqlite_run',
      work_plan: makePlan(),
    })
    assert.equal(created.state.status, 'draft')
    assert.equal(await primary.hasRun('new_sqlite_run'), true)
    assert.equal(await primary.hasRun('legacy_json_run'), false)

    const loadedLegacy = await hybrid.loadRun('legacy_json_run')
    assert.equal(loadedLegacy.work_plan.run_title, 'Tiny store proof')

    const ids = (await hybrid.listRuns()).map((run) => run.run_instance_id)
    assert.deepEqual(ids, ['legacy_json_run', 'new_sqlite_run'])

    await hybrid.writeState({
      ...loadedLegacy.state,
      status: 'blocked',
      timestamps: {
        ...loadedLegacy.state.timestamps,
        updated_at: '2026-06-25T12:50:00.000Z',
      },
    })
    assert.equal((await legacy.loadRun('legacy_json_run')).state.status, 'blocked')

    await hybrid.deleteRun('new_sqlite_run')
    assert.equal(await primary.hasRun('new_sqlite_run'), false)
    await hybrid.deleteRun('legacy_json_run')
    await assert.rejects(legacy.loadRun('legacy_json_run'), RunnerStoreError)
  })

  it('never exposes hidden transaction material as a legacy JSON run', async () => {
    const runsRoot = path.join(tempRoot, 'runs')
    const lifecycle = new RunArtifactLifecycle({ runs_root: runsRoot })
    const staged = await lifecycle.beginCreate('run_hidden_stage')
    await fs.writeFile(path.join(staged.staged_run_dir, 'partial.txt'), 'partial', 'utf8')

    const primary = new SqliteRunnerStore({
      runs_root: runsRoot,
      db_path: path.join(tempRoot, 'hidden.sqlite'),
      now: nextDate,
    })
    const legacy = new JsonRunnerStore({ runs_root: runsRoot, now: nextDate })
    const hybrid = new HybridRunnerStore({ primary, legacy_json: legacy })

    assert.deepEqual(await hybrid.listRuns(), [])
    assert.equal(await fs.access(staged.transaction_dir).then(() => true, () => false), false)
  })
})
