import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { parseLastJsonObjectLine, withCodexDesktopHelperLock, writeDesktopHelperFailureArtifact } from './index.js'

test('parseLastJsonObjectLine ignores diagnostic lines and parses the final JSON object', () => {
  const parsed = parseLastJsonObjectLine(['diagnostic before', '{"ok":true}', 'diagnostic after'].join('\n'))
  assert.deepEqual(parsed.payload, { ok: true })
  assert.equal(parsed.lineCount, 3)
  assert.equal(parsed.parsedLineIndex, 1)
})

test('withCodexDesktopHelperLock serializes concurrent helper actions on one lock file', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-helper-lock-test-'))
  const lockPath = path.join(tempDir, 'desktop-helper.lock')
  let active = 0
  let maxActive = 0

  try {
    await Promise.all([
      withCodexDesktopHelperLock({ owner: 'test-one', lockPath, pollMs: 5 }, async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await sleep(25)
        active -= 1
      }),
      withCodexDesktopHelperLock({ owner: 'test-two', lockPath, pollMs: 5 }, async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await sleep(10)
        active -= 1
      }),
    ])

    assert.equal(maxActive, 1)
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
})

test('writeDesktopHelperFailureArtifact redacts prompt text arguments', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-helper-artifact-test-'))
  try {
    const artifactPath = await writeDesktopHelperFailureArtifact({
      owner: 'test',
      action: 'prompt',
      reason: 'helper_json_parse',
      args: ['-Action', 'prompt', '-Text', 'secret prompt'],
      stdout: 'bad output',
      artifactRoot: tempDir,
    })

    assert.ok(artifactPath)
    const artifact = JSON.parse(await fs.readFile(artifactPath, 'utf8')) as { args: string[] }
    assert.deepEqual(artifact.args, ['-Action', 'prompt', '-Text', '[redacted prompt text]'])
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
})

test('writeDesktopHelperFailureArtifact retains one atomic latest failure per owner action', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-helper-latest-test-'))
  const configuredRoot = path.join(tempDir, 'configured', 'helper_failures')
  const unrelatedCwd = path.join(tempDir, 'unrelated-cwd')
  const originalCwd = process.cwd()
  await fs.mkdir(unrelatedCwd, { recursive: true })
  try {
    process.chdir(unrelatedCwd)
    const firstPath = await writeDesktopHelperFailureArtifact({
      owner: 'desktop api',
      action: 'state',
      reason: 'first',
      args: ['-Action', 'state'],
      stdout: `discarded-prefix-${'a'.repeat(16_000)}`,
      stderr: 'first stderr',
      artifactRoot: configuredRoot,
      now: () => new Date('2026-09-07T12:00:00.000Z'),
    })
    const stateTemp = path.join(configuredRoot, '.desktop-api-state.latest.json.tmp')
    await fs.writeFile(stateTemp, '{"partial":', 'utf8')
    const secondPath = await writeDesktopHelperFailureArtifact({
      owner: 'desktop api',
      action: 'state',
      reason: 'second',
      args: ['-Action', 'state'],
      stdout: 'second stdout',
      stderr: `discarded-prefix-${'b'.repeat(16_000)}`,
      artifactRoot: configuredRoot,
      now: () => new Date('2026-09-07T12:01:00.000Z'),
    })
    const promptPath = await writeDesktopHelperFailureArtifact({
      owner: 'desktop api',
      action: 'prompt',
      reason: 'prompt failure',
      artifactRoot: configuredRoot,
      now: () => new Date('2026-09-07T12:02:00.000Z'),
    })

    assert.equal(firstPath, secondPath)
    assert.notEqual(secondPath, promptPath)
    assert.ok(secondPath?.startsWith(`${path.resolve(configuredRoot)}${path.sep}`))
    const files = (await fs.readdir(configuredRoot)).sort()
    assert.deepEqual(files, ['desktop-api-prompt.latest.json', 'desktop-api-state.latest.json'])
    assert.equal(files.some((name) => name.endsWith('.tmp')), false)
    await assert.rejects(fs.access(stateTemp), { code: 'ENOENT' })
    const current = JSON.parse(await fs.readFile(secondPath!, 'utf8')) as {
      recorded_at: string
      reason: string
      stdout_tail: string
      stderr_tail: string
    }
    assert.equal(current.recorded_at, '2026-09-07T12:01:00.000Z')
    assert.equal(current.reason, 'second')
    assert.equal(current.stdout_tail, 'second stdout')
    assert.equal(current.stderr_tail, 'b'.repeat(16_000))
    await assert.rejects(fs.access(path.join(unrelatedCwd, 'artifacts')))
  } finally {
    process.chdir(originalCwd)
    await fs.rm(tempDir, { recursive: true, force: true })
  }
})

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
