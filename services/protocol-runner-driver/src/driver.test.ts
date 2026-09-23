import assert from 'node:assert/strict'
import test from 'node:test'

import { ProtocolRunnerDriver } from './driver.js'
import type { DriverRunView, ProtocolRunnerApiClient, RunListItem } from './types.js'

class FakeProtocolRunnerApiClient implements ProtocolRunnerApiClient {
  readonly started: string[] = []

  constructor(readonly runs: RunListItem[]) {}

  async listRuns(): Promise<RunListItem[]> {
    return this.runs.map((run) => ({ ...run, automation: { ...run.automation } }))
  }

  async getRun(run_instance_id: string): Promise<DriverRunView> {
    return this.view(run_instance_id)
  }

  async startRun(run_instance_id: string): Promise<DriverRunView> {
    this.started.push(run_instance_id)
    const run = this.runs.find((candidate) => candidate.run_instance_id === run_instance_id)
    if (!run) {
      throw new Error(`unknown run ${run_instance_id}`)
    }
    run.status = 'waiting_for_start_report'
    return this.view(run_instance_id)
  }

  private view(run_instance_id: string): DriverRunView {
    const run = this.runs.find((candidate) => candidate.run_instance_id === run_instance_id)
    if (!run) {
      throw new Error(`unknown run ${run_instance_id}`)
    }
    return {
      run_instance_id,
      state: {
        status: run.status,
        current_step_id: run.current_step_id,
        current_step_ordinal: run.current_step_ordinal,
        automation: { ...run.automation },
      },
    }
  }
}

function run(id: string, status: RunListItem['status'], auto_advance: boolean): RunListItem {
  return {
    run_instance_id: id,
    status,
    current_step_id: `${id}_step`,
    current_step_ordinal: 1,
    automation: {
      auto_pickup: true,
      auto_advance,
    },
    updated_at: '2026-06-26T00:00:00.000Z',
  }
}

test('driver does not start ready runs when auto_advance is disabled', async () => {
  const client = new FakeProtocolRunnerApiClient([run('run_a', 'ready', false)])
  const driver = new ProtocolRunnerDriver({ client })

  const decision = await driver.tick()

  assert.equal(decision.action, 'no_eligible_runs')
  assert.deepEqual(client.started, [])
})

test('driver skips waiting and blocked runs but starts another ready eligible run', async () => {
  const client = new FakeProtocolRunnerApiClient([
    run('run_a', 'waiting_for_completion_report', true),
    run('run_b', 'blocked', true),
    run('run_c', 'ready', true),
  ])
  const decisions: string[] = []
  const driver = new ProtocolRunnerDriver({
    client,
    onDecision: (decision) => decisions.push(`${decision.run_instance_id ?? '-'}:${decision.action}`),
  })

  const decision = await driver.tick()

  assert.equal(decision.action, 'activated')
  assert.equal(decision.run_instance_id, 'run_c')
  assert.deepEqual(client.started, ['run_c'])
  assert.deepEqual(decisions, [
    'run_a:skipped_not_ready',
    'run_b:skipped_not_ready',
    'run_c:activated',
  ])
})

test('driver schedules one eligible run per tick with round-robin order', async () => {
  const client = new FakeProtocolRunnerApiClient([
    run('run_a', 'ready', true),
    run('run_b', 'ready', true),
  ])
  const driver = new ProtocolRunnerDriver({ client })

  assert.equal((await driver.tick()).run_instance_id, 'run_a')
  client.runs[0]!.status = 'ready'
  assert.equal((await driver.tick()).run_instance_id, 'run_b')

  assert.deepEqual(client.started, ['run_a', 'run_b'])
})
