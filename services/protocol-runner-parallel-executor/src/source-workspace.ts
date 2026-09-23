import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import type { ParallelLeasePacket } from './types.js'

const exec = promisify(execFile)

/** The integration helper belongs to Runner, not to the worker's target repository. */
export function sourceIntegrationCommand(): string {
  return process.env.PROTOCOL_RUNNER_SOURCE_INTEGRATION_COMMAND?.trim()
    || fileURLToPath(new URL('../../../scripts/tools/concurrent_development.py', import.meta.url))
}

/** A closed launcher process alone is not evidence that its children stopped. */
export async function sourceWriterProcessStopped(pid: number | undefined): Promise<boolean> {
  if (pid === undefined) return true // Spawn failed before a worker existed.
  if (process.platform !== 'win32') {
    try { process.kill(-pid, 0); return false } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' }
  }
  try {
    const result = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'],
    { windowsHide: true, timeout: 10000, maxBuffer: 2 * 1024 * 1024 })
    const rows = JSON.parse(result.stdout) as Array<{ ProcessId: number; ParentProcessId: number }>
    // The parent has exited; retained PPID identifies any surviving direct child.
    return Array.isArray(rows) && !rows.some((row) => row.ProcessId === pid || row.ParentProcessId === pid)
  } catch { return false }
}

export interface SourceWorkspace {
  workspace: string
  repository: string
  binding_id: string
  owner_id: string
  base_commit: string
  owned_paths: string[]
  attempt_dir: string
  artifact_root: string
  sealed_output_path: string
  run_instance_id: string
  group_id: string
  item_id: string
  attempt_id: string
  lease_id: string
  python_command: string
  state: 'prepared' | 'running' | 'handed_off' | 'retained'
}

async function git(root: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const result = await exec('git', ['-C', root, ...args], { windowsHide: true, maxBuffer: 16 * 1024 * 1024, env })
  return result.stdout.trim()
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
}

export async function safeSourcePath(root: string, relative: string): Promise<string> {
  if (!relative || relative !== relative.trim() || /[\\:*?\[\]\x00-\x1f]/.test(relative) || relative.startsWith('/')
    || relative.split('/').some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
    throw new Error(`Unsafe source path: ${relative}`)
  }
  const target = path.resolve(root, relative)
  if (!inside(root, target)) throw new Error('Source path escaped its owner.')
  let current = root
  for (const part of relative.split('/')) {
    current = path.join(current, part)
    try {
      const stat = await fs.lstat(current)
      if (stat.isSymbolicLink()) throw new Error(`Source path crosses a link: ${relative}`)
      if (current === target && !stat.isFile()) throw new Error(`Source path is not a regular file: ${relative}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return target
}

async function writeState(state: SourceWorkspace): Promise<void> {
  const target = path.join(state.attempt_dir, 'source_workspace.json')
  const temporary = `${target}.tmp`
  await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  await fs.rename(temporary, target)
}

/** The exact attempt owns this workspace; a stale lease never permits its reuse. */
export async function prepareSourceWorkspace(
  lease: ParallelLeasePacket,
  repository: string,
  pythonCommand: string,
  bind?: (state: SourceWorkspace) => Promise<void>,
): Promise<SourceWorkspace> {
  const source = lease.source_writer
  if (source === undefined || !/^[0-9a-f]{40}$/.test(source.base_commit) || source.owned_paths.length === 0) {
    throw new Error('Source-writer lease is missing its exact base and owned source files.')
  }
  repository = await fs.realpath(repository)
  if (path.resolve(await git(repository, ['rev-parse', '--show-toplevel'])) !== repository) {
    throw new Error('Source-writer executor root must be the exact Git repository root.')
  }
  if (await git(repository, ['rev-parse', `${source.base_commit}^{commit}`]) !== source.base_commit) {
    throw new Error('Source base is not the exact available commit.')
  }
  const attempt_dir = await fs.realpath(lease.attempt_dir)
  const workspace = path.join(attempt_dir, 'source-workspace')
  const owner_id = `${lease.run_instance_id}/${lease.group_id}/${lease.item_id}/${lease.attempt_id}`
  const binding_id = `runner-${createHash('sha256').update(`${attempt_dir}\0${owner_id}`).digest('hex').slice(0, 32)}`
  const state: SourceWorkspace = {
    workspace, repository, binding_id, owner_id, base_commit: source.base_commit,
    owned_paths: [...source.owned_paths], attempt_dir, artifact_root: await fs.realpath(source.artifact_root),
    sealed_output_path: lease.sealed_output_path, run_instance_id: lease.run_instance_id,
    group_id: lease.group_id, item_id: lease.item_id, attempt_id: lease.attempt_id, lease_id: lease.lease_id, python_command: pythonCommand, state: 'prepared',
  }
  // Exclusive reservation prevents duplicate launch or reuse of a previous attempt.
  await fs.writeFile(path.join(attempt_dir, 'source_workspace.json'), `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx' })
  try {
    await fs.lstat(path.join(lease.run_dir, 'source_close_requested'))
    throw new Error('Run closeout has reserved source cleanup; this attempt cannot launch.')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await fs.access(path.join(attempt_dir, 'source_workspace.json'))
  await git(repository, ['worktree', 'add', '--detach', workspace, source.base_commit])
  for (const sourcePath of source.owned_paths) {
    await safeSourcePath(workspace, sourcePath)
    try {
      await git(workspace, ['check-ignore', '--no-index', '--', sourcePath])
      throw new Error(`Ignored files cannot enter source handoff: ${sourcePath}`)
    } catch (error) {
      if ((error as { code?: unknown }).code !== 1) throw error
    }
  }
  await safeSourcePath(workspace, lease.sealed_output_path)
  if (await git(workspace, ['ls-files', '--', lease.sealed_output_path])) {
    throw new Error('A sealed output cannot overwrite a tracked source file.')
  }
  const command = sourceIntegrationCommand()
  if (bind !== undefined) await bind(state)
  else await exec(pythonCommand, [command, '--root', workspace, 'bind', '--binding-id', binding_id,
      '--owner-id', owner_id, '--base', source.base_commit, '--lifecycle-owner', 'runner',
      ...source.owned_paths.flatMap((sourcePath) => ['--owned-path', sourcePath])], { windowsHide: true })
  return state
}

export async function markSourceRunning(state: SourceWorkspace): Promise<void> {
  state.state = 'running'
  await writeState(state)
}

/** Export only after launcher evidence establishes a completed sealed output. */
export async function exportSourceOutput(state: SourceWorkspace): Promise<void> {
  const from = await safeSourcePath(state.workspace, state.sealed_output_path)
  const to = await safeSourcePath(state.artifact_root, state.sealed_output_path)
  await fs.mkdir(path.dirname(to), { recursive: true })
  await safeSourcePath(state.artifact_root, state.sealed_output_path)
  // A raced or earlier output belongs to its current owner; never overwrite it.
  await fs.copyFile(from, to, constants.COPYFILE_EXCL)
  const [source, destination] = await Promise.all([fs.readFile(from), fs.readFile(to)])
  if (!source.equals(destination)) throw new Error('Sealed-output export readback did not match.')
}

/** A normal Git bundle is the source contribution in the existing attempt handoff. */
export async function handoffSourceWorkspace(state: SourceWorkspace, stopped: boolean, releaseBinding?: (state: SourceWorkspace) => Promise<void>): Promise<string> {
  if (!stopped) {
    state.state = 'retained'
    await writeState(state)
    throw new Error('Worker lifetime is uncertain; retain its source workspace and do not capture or remove it.')
  }
  const index = path.join(state.attempt_dir, 'source-index')
  const env = { ...process.env, GIT_INDEX_FILE: index, GIT_LITERAL_PATHSPECS: '1' }
  const owned = new Set(state.owned_paths)
  const tracked = (await git(state.workspace, ['diff', '--name-only', '-z', state.base_commit])).split('\0').filter(Boolean)
  const untracked = (await git(state.workspace, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean)
  const ignored = (await git(state.workspace, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])).split('\0').filter(Boolean)
  const unexpected = [...tracked, ...untracked, ...ignored].filter((name) => !owned.has(name) && name !== state.sealed_output_path)
  if (unexpected.length > 0) {
    state.state = 'retained'
    await writeState(state)
    throw new Error(`Undeclared source changes need coordinator disposition; workspace retained: ${unexpected.join(', ')}`)
  }
  for (const sourcePath of state.owned_paths) await safeSourcePath(state.workspace, sourcePath)
  await git(state.workspace, ['read-tree', state.base_commit], env)
  // Exact paths only; no real index mutation or broad staging.
  for (const sourcePath of state.owned_paths) {
    const exists = await fs.lstat(path.join(state.workspace, sourcePath)).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false
      throw error
    })
    const wasTracked = await git(state.workspace, ['ls-tree', '--name-only', state.base_commit, '--', sourcePath])
    if (exists || wasTracked) await git(state.workspace, ['add', '-A', '--', sourcePath], env)
  }
  const tree = await git(state.workspace, ['write-tree'], env)
  const commit = await git(state.workspace, ['-c', 'user.name=Protocol Runner', '-c', 'user.email=protocol-runner@localhost',
    'commit-tree', tree, '-p', state.base_commit, '-m', `Source contribution ${state.owner_id}`])
  const ref = `refs/protocol-runner/handoffs/${state.binding_id}`
  const bundle = path.join(state.attempt_dir, 'source.bundle')
  await git(state.repository, ['update-ref', ref, commit, '0000000000000000000000000000000000000000'])
  await git(state.repository, ['bundle', 'create', bundle, ref, `^${state.base_commit}`])
  await git(state.repository, ['bundle', 'verify', bundle])
  const bundle_sha256 = createHash('sha256').update(await fs.readFile(bundle)).digest('hex')
  // Blocked/failed workers can still have a useful partial output. Keep it in
  // the same attempt handoff without promoting it to canonical sealed output.
  let partial_output_path: string | undefined
  try {
    const localOutput = await safeSourcePath(state.workspace, state.sealed_output_path)
    const bytes = await fs.readFile(localOutput)
    partial_output_path = path.join(state.attempt_dir, 'source_output.partial')
    await fs.writeFile(partial_output_path, bytes, { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const handoff = path.join(state.attempt_dir, 'source_handoff.json')
  await fs.writeFile(handoff, `${JSON.stringify({ ...state, commit, tree, bundle, bundle_sha256, ref,
    partial_output_path, process_stopped: true, coordinator_acknowledgement_required: true }, null, 2)}\n`, { flag: 'wx' })
  // Removal is bounded to the exact attempt worktree after the complete contribution exists.
  if (await fs.realpath(state.workspace) !== path.join(await fs.realpath(state.attempt_dir), 'source-workspace')) {
    throw new Error('Source workspace ownership changed before cleanup.')
  }
  if (releaseBinding !== undefined) await releaseBinding(state)
  else await exec(state.python_command, [sourceIntegrationCommand(),
    '--root', state.workspace, 'release-binding', '--binding-id', state.binding_id, '--owner-id', state.owner_id], { windowsHide: true })
  await git(state.repository, ['worktree', 'remove', '--force', state.workspace])
  await git(state.repository, ['update-ref', '-d', ref, commit])
  await fs.rm(index, { force: true })
  state.state = 'handed_off'
  await writeState(state)
  return handoff
}
