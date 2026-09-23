import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { requireReleasedSourceHandoffs } from './source-closeout.js'

test('source closeout protects live and retained work, then requires exact coordinator handoff acknowledgement', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-source-closeout-'))
  try {
    const groups = [{ group_id: 'group', leases: [{ status: 'active' }], attempts: [{ item_id: 'item', attempt_id: 'attempt' }] }]
    await assert.rejects(requireReleasedSourceHandoffs('run', root, groups, []), /active leases/)
    groups[0].leases[0].status = 'expired'
    const attempt = path.join(root, 'parallel_groups/group/items/item/attempts/attempt')
    const workspace = path.join(attempt, 'source-workspace')
    await fs.mkdir(workspace, { recursive: true })
    await fs.writeFile(path.join(workspace, 'source.md'), 'unfinished')
    await assert.rejects(requireReleasedSourceHandoffs('run', root, groups, []), /still exists/)
    assert.equal(await fs.readFile(path.join(workspace, 'source.md'), 'utf8'), 'unfinished')
    await fs.rm(workspace, { recursive: true })
    const identity = { run_instance_id: 'run', group_id: 'group', item_id: 'item', attempt_id: 'attempt' }
    await fs.writeFile(path.join(attempt, 'source_workspace.json'), JSON.stringify({ ...identity, state: 'handed_off' }))
    await fs.writeFile(path.join(attempt, 'source_handoff.json'), JSON.stringify({ ...identity, process_stopped: true, commit: 'a'.repeat(40) }))
    await assert.rejects(requireReleasedSourceHandoffs('run', root, groups, [`attempt@${'b'.repeat(40)}`]), /Coordinator must/)
    await requireReleasedSourceHandoffs('run', root, groups, [`attempt@${'a'.repeat(40)}`])
    await fs.access(path.join(root, 'source_close_requested'))
  } finally {
    assert.ok(path.resolve(root).startsWith(path.join(os.tmpdir(), 'runner-source-closeout-')))
    await fs.rm(root, { recursive: true, force: true })
  }
})
