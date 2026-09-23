import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { RunArtifactLifecycle } from './run-artifact-lifecycle.js'

let tempRoot = ''
let transactionCounter = 0

function makeLifecycle(): RunArtifactLifecycle {
  return new RunArtifactLifecycle({
    runs_root: tempRoot,
    transaction_id_factory: () => `transaction_${++transactionCounter}`,
  })
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate)
    return true
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

beforeEach(async () => {
  transactionCounter = 0
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'protocol-runner-artifact-lifecycle-'))
})

afterEach(async () => {
  if (tempRoot.length > 0) {
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
})

describe('RunArtifactLifecycle interrupted-operation reconciliation', () => {
  it('finalizes a staged create only when matching committed run state exists', async () => {
    const lifecycle = makeLifecycle()
    const transaction = await lifecycle.beginCreate('run_committed_create')
    await fs.writeFile(path.join(transaction.staged_run_dir, 'work_plan.json'), '{}\n', 'utf8')

    const report = await lifecycle.reconcile((run_instance_id) => run_instance_id === 'run_committed_create')

    assert.equal(report.transactions_found, 1)
    assert.equal(report.create_finalized, 1)
    assert.equal(await exists(transaction.transaction_dir), false)
    assert.equal(await exists(path.join(transaction.final_run_dir, 'work_plan.json')), true)
  })

  it('removes abandoned staged create material when no committed run exists', async () => {
    const lifecycle = makeLifecycle()
    const transaction = await lifecycle.beginCreate('run_abandoned_create')
    await fs.writeFile(path.join(transaction.staged_run_dir, 'partial.txt'), 'partial', 'utf8')

    const report = await lifecycle.reconcile(() => false)

    assert.equal(report.transactions_found, 1)
    assert.equal(report.create_abandoned, 1)
    assert.equal(await exists(transaction.transaction_dir), false)
    assert.equal(await exists(transaction.final_run_dir), false)
  })

  it('restores an interrupted retirement when committed run state still exists', async () => {
    const lifecycle = makeLifecycle()
    const finalRunDir = path.join(tempRoot, 'run_restore_retire')
    await fs.mkdir(finalRunDir, { recursive: true })
    await fs.writeFile(path.join(finalRunDir, 'state.json'), '{}\n', 'utf8')
    const transaction = await lifecycle.beginRetire('run_restore_retire')

    const report = await lifecycle.reconcile((run_instance_id) => run_instance_id === 'run_restore_retire')

    assert.equal(report.transactions_found, 1)
    assert.equal(report.retire_restored, 1)
    assert.equal(await exists(transaction.transaction_dir), false)
    assert.equal(await exists(path.join(finalRunDir, 'state.json')), true)
  })

  it('finishes an interrupted retirement when committed run state is already gone', async () => {
    const lifecycle = makeLifecycle()
    const finalRunDir = path.join(tempRoot, 'run_finish_retire')
    await fs.mkdir(finalRunDir, { recursive: true })
    await fs.writeFile(path.join(finalRunDir, 'state.json'), '{}\n', 'utf8')
    const transaction = await lifecycle.beginRetire('run_finish_retire')

    const report = await lifecycle.reconcile(() => false)

    assert.equal(report.transactions_found, 1)
    assert.equal(report.retire_finished, 1)
    assert.equal(await exists(transaction.transaction_dir), false)
    assert.equal(await exists(finalRunDir), false)
  })
})
