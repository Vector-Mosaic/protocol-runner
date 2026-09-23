import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import { exportSourceOutput, handoffSourceWorkspace, prepareSourceWorkspace, safeSourcePath, sourceWriterProcessStopped } from './source-workspace.js'
import type { ParallelLeasePacket } from './types.js'

const exec = promisify(execFile)
async function git(root: string, ...args: string[]): Promise<string> {
  return (await exec('git', ['-C', root, ...args], { windowsHide: true })).stdout.trim()
}

async function fixture(): Promise<{ root: string; repository: string; base: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-source-participation-'))
  const repository = path.join(root, 'repo')
  await fs.mkdir(repository)
  await git(repository, 'init')
  await git(repository, 'config', 'user.name', 'Test')
  await git(repository, 'config', 'user.email', 'test@localhost')
  await fs.writeFile(path.join(repository, 'owned.bin'), Buffer.from([1, 2, 3]))
  await fs.writeFile(path.join(repository, 'delete.md'), 'old source')
  await fs.writeFile(path.join(repository, 'other.md'), 'untouched base')
  await fs.writeFile(path.join(repository, '.gitignore'), 'artifacts/\n')
  await git(repository, 'add', '.')
  await git(repository, 'commit', '-m', 'base')
  return { root, repository, base: await git(repository, 'rev-parse', 'HEAD') }
}

async function packet(root: string, repository: string, base: string, item = 'one'): Promise<ParallelLeasePacket> {
  const run_dir = path.join(root, 'runs', 'run-one')
  const attempt_id = `group_${item}_attempt_001`
  const attempt_dir = path.join(run_dir, 'parallel_groups', 'group', 'items', item, 'attempts', attempt_id)
  await fs.mkdir(attempt_dir, { recursive: true })
  return {
    run_instance_id: 'run-one', step_id: 'work', group_id: 'group', item_id: item, attempt_id,
    lease_id: `${attempt_id}_lease`, executor_id: 'executor-one', status: 'active',
    leased_at: '2026-09-20T00:00:00Z', expires_at: null, heartbeat_at: null,
    created_at: '2026-09-20T00:00:00Z', updated_at: '2026-09-20T00:00:00Z',
    run_dir, attempt_dir, prompt_path: path.join(attempt_dir, 'prompt.md'),
    worker_packet_path: path.join(attempt_dir, 'worker_packet.json'),
    status_report_path: path.join(attempt_dir, 'status_report.json'),
    process_path: path.join(attempt_dir, 'process.json'), result_path: path.join(attempt_dir, 'result.json'),
    sealed_output_path: `artifacts/results/${item}.md`, input_ref: 'other.md', contract_ref: 'other.md', variables: {},
    required_worker_capabilities: ['source_writer'],
    source_writer: { base_commit: base, owned_paths: ['owned.bin', 'new.md', 'delete.md'], artifact_root: repository },
  }
}

async function dispose(root: string): Promise<void> {
  const absolute = path.resolve(root)
  assert.ok(absolute.startsWith(path.join(os.tmpdir(), 'runner-source-participation-')))
  await fs.rm(absolute, { recursive: true, force: true })
}

test('source attempts isolate writes and return binary/new/deleted files through a usable Git bundle', async () => {
  const { root, repository, base } = await fixture()
  try {
    await fs.writeFile(path.join(repository, 'other.md'), 'another task is editing this')
    const indexBefore = await fs.readFile(path.join(repository, '.git', 'index'))
    const lease = await packet(root, repository, base)
    let boundOwner = ''
    const state = await prepareSourceWorkspace(lease, repository, 'unused', async (binding) => { boundOwner = binding.owner_id })
    const sibling = await prepareSourceWorkspace(await packet(root, repository, base, 'two'), repository, 'unused', async () => {})
    assert.notEqual(state.workspace, sibling.workspace)
    assert.equal(boundOwner, 'run-one/group/one/group_one_attempt_001')
    await fs.writeFile(path.join(state.workspace, 'owned.bin'), Buffer.from([0, 255, 19, 44]))
    await fs.writeFile(path.join(state.workspace, 'new.md'), 'new source')
    await fs.rm(path.join(state.workspace, 'delete.md'))
    assert.deepEqual(await fs.readFile(path.join(sibling.workspace, 'owned.bin')), Buffer.from([1, 2, 3]))
    const output = path.join(state.workspace, lease.sealed_output_path)
    await fs.mkdir(path.dirname(output), { recursive: true })
    await fs.writeFile(output, 'sealed result')
    await exportSourceOutput(state)
    assert.equal(await fs.readFile(path.join(repository, lease.sealed_output_path), 'utf8'), 'sealed result')
    await assert.rejects(exportSourceOutput(state), /EEXIST/)
    let released = false
    const handoffPath = await handoffSourceWorkspace(state, true, async () => { released = true })
    const handoff = JSON.parse(await fs.readFile(handoffPath, 'utf8')) as { bundle: string; ref: string; commit: string; partial_output_path: string }
    assert.equal(await fs.readFile(handoff.partial_output_path, 'utf8'), 'sealed result')
    assert.equal(released, true)
    await assert.rejects(fs.access(state.workspace), /ENOENT/)
    const receiver = path.join(root, 'receiver')
    await exec('git', ['clone', '--no-local', repository, receiver], { windowsHide: true })
    await git(receiver, 'fetch', handoff.bundle, handoff.ref)
    assert.equal(await git(receiver, 'rev-parse', 'FETCH_HEAD'), handoff.commit)
    const binary = await exec('git', ['-C', receiver, 'show', 'FETCH_HEAD:owned.bin'], { encoding: 'buffer', windowsHide: true })
    assert.deepEqual(binary.stdout, Buffer.from([0, 255, 19, 44]))
    assert.equal(await git(receiver, 'show', 'FETCH_HEAD:new.md'), 'new source')
    await assert.rejects(git(receiver, 'show', 'FETCH_HEAD:delete.md'))
    assert.equal(await fs.readFile(path.join(repository, 'other.md'), 'utf8'), 'another task is editing this')
    assert.deepEqual(await fs.readFile(path.join(repository, '.git', 'index')), indexBefore)
  } finally { await dispose(root) }
})

test('uncertain worker lifetime and out-of-scope changes retain source without cleanup', async () => {
  const { root, repository, base } = await fixture()
  try {
    const lease = await packet(root, repository, base)
    const state = await prepareSourceWorkspace(lease, repository, 'unused', async () => {})
    await fs.writeFile(path.join(state.workspace, 'owned.bin'), 'unfinished')
    await assert.rejects(handoffSourceWorkspace(state, false), /lifetime is uncertain/)
    assert.equal(await fs.readFile(path.join(state.workspace, 'owned.bin'), 'utf8'), 'unfinished')
    await fs.writeFile(path.join(state.workspace, 'other.md'), 'outside assignment')
    await assert.rejects(handoffSourceWorkspace(state, true), /Undeclared source changes/)
    await fs.access(state.workspace)
    await fs.writeFile(path.join(state.workspace, 'other.md'), 'untouched base')
    await fs.mkdir(path.join(state.workspace, 'artifacts'), { recursive: true })
    await fs.writeFile(path.join(state.workspace, 'artifacts', 'unassigned.data'), 'ignored does not mean disposable')
    await assert.rejects(handoffSourceWorkspace(state, true), /Undeclared source changes/)
    assert.equal(await fs.readFile(path.join(state.workspace, 'artifacts', 'unassigned.data'), 'utf8'), 'ignored does not mean disposable')
    await assert.rejects(prepareSourceWorkspace(lease, repository, 'unused', async () => {}), /EEXIST/)
  } finally { await dispose(root) }
})

test('source cleanup does not mistake a live worker process for stopped work', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    windowsHide: true, detached: process.platform !== 'win32', stdio: 'ignore',
  })
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  try {
    assert.equal(await sourceWriterProcessStopped(child.pid), false)
  } finally {
    child.kill()
    await exited
  }
  assert.equal(await sourceWriterProcessStopped(child.pid), true)
})

test('source paths reject escaping/link targets and closeout blocks a late source launch', async () => {
  const { root, repository, base } = await fixture()
  try {
    await assert.rejects(safeSourcePath(repository, '../outside'), /Unsafe source path/)
    await assert.rejects(safeSourcePath(repository, ':(glob)**'), /Unsafe source path/)
    const outside = path.join(root, 'outside')
    await fs.mkdir(outside)
    await fs.symlink(outside, path.join(repository, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(safeSourcePath(repository, 'linked/file'), /crosses a link/)
    const lease = await packet(root, repository, base)
    await fs.writeFile(path.join(lease.run_dir, 'source_close_requested'), 'closing')
    await assert.rejects(prepareSourceWorkspace(lease, repository, 'unused', async () => {}), /closeout has reserved/)
    await assert.rejects(fs.access(path.join(lease.attempt_dir, 'source-workspace')), /ENOENT/)
  } finally { await dispose(root) }
})
