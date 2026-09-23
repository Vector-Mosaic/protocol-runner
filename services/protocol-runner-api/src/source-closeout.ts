import { promises as fs } from 'node:fs'
import path from 'node:path'

interface SourceGroup {
  group_id: string
  leases: Array<{ status: string }>
  attempts: Array<{ item_id: string; attempt_id: string }>
}

async function present(target: string): Promise<boolean> {
  return fs.lstat(target).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false
    throw error
  })
}

/** Hold new launches before checking existing attempt-owned source resources. */
export async function requireReleasedSourceHandoffs(
  runId: string, runDir: string, groups: SourceGroup[], acknowledgements: string[],
): Promise<void> {
  const marker = path.join(runDir, 'source_close_requested')
  await fs.writeFile(marker, 'Source-aware closeout requested.\n', { flag: 'a' })
  try {
    for (const group of groups) {
      if (group.leases.some((lease) => lease.status === 'active')) throw new Error(`Source group ${group.group_id} still has active leases.`)
      for (const attempt of group.attempts) {
        if (![group.group_id, attempt.item_id, attempt.attempt_id].every((id) => /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id))) {
          throw new Error('Source attempt identity cannot resolve an owned evidence directory.')
        }
        const attemptDir = path.join(runDir, 'parallel_groups', group.group_id, 'items', attempt.item_id, 'attempts', attempt.attempt_id)
        const workspace = path.join(attemptDir, 'source-workspace')
        if (await present(workspace)) throw new Error(`Source workspace ${attempt.attempt_id} still exists; retain it until safe handoff and cleanup.`)
        const statePath = path.join(attemptDir, 'source_workspace.json')
        if (!await present(statePath)) {
          if (await present(path.join(attemptDir, 'process_started.json'))) throw new Error(`Source attempt ${attempt.attempt_id} has unaccounted process evidence.`)
          continue
        }
        const state = JSON.parse(await fs.readFile(statePath, 'utf8')) as Record<string, unknown>
        const handoff = JSON.parse(await fs.readFile(path.join(attemptDir, 'source_handoff.json'), 'utf8')) as Record<string, unknown>
        if (state.state !== 'handed_off' || state.run_instance_id !== runId || state.group_id !== group.group_id
          || state.item_id !== attempt.item_id || state.attempt_id !== attempt.attempt_id
          || handoff.run_instance_id !== runId || handoff.group_id !== group.group_id || handoff.item_id !== attempt.item_id
          || handoff.attempt_id !== attempt.attempt_id || handoff.process_stopped !== true
          || typeof handoff.commit !== 'string' || !/^[0-9a-f]{40}$/.test(handoff.commit)) {
          throw new Error(`Source attempt ${attempt.attempt_id} is not a complete stopped-worker handoff.`)
        }
        if (!acknowledgements.includes(`${attempt.attempt_id}@${handoff.commit}`)) {
          throw new Error(`Coordinator must preserve/integrate source then acknowledge ${attempt.attempt_id}@${handoff.commit}.`)
        }
      }
    }
  } catch (error) {
    await fs.rm(marker, { force: true })
    throw error
  }
}
