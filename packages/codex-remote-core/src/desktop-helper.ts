import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export interface CodexDesktopHelperLockOptions {
  owner: string
  action?: string | null
  lockPath?: string
  acquireTimeoutMs?: number
  staleLockMs?: number
  pollMs?: number
  now?: () => Date
}

export interface HelperJsonParseResult {
  payload: unknown | null
  parsedLineIndex: number | null
  lineCount: number
}

export interface HelperFailureArtifactInput {
  owner: string
  action?: string | null
  reason: string
  args?: string[]
  exitCode?: number | null
  stdout?: string
  stderr?: string
  artifactRoot: string
  now?: () => Date
}

const DEFAULT_ACQUIRE_TIMEOUT_MS = 120_000
const DEFAULT_STALE_LOCK_MS = 180_000
const DEFAULT_POLL_MS = 250
const MAX_DEBUG_TEXT_LENGTH = 16_000

export function defaultCodexDesktopHelperLockPath(): string {
  return (
    process.env.WORKSTATION_CONTROL_CODEX_DESKTOP_HELPER_LOCK_PATH?.trim() ||
    path.join(os.tmpdir(), 'workstation-control-codex-desktop-helper.lock')
  )
}

export async function withCodexDesktopHelperLock<T>(
  options: CodexDesktopHelperLockOptions,
  run: () => Promise<T>,
): Promise<T> {
  const lockPath = options.lockPath ?? defaultCodexDesktopHelperLockPath()
  const acquireTimeoutMs = options.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS
  const staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS
  const startedAt = Date.now()
  let handle: fs.FileHandle | null = null

  await fs.mkdir(path.dirname(lockPath), { recursive: true })
  while (!handle) {
    try {
      handle = await fs.open(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY)
      await handle.writeFile(
        JSON.stringify(
          {
            owner: options.owner,
            action: options.action ?? null,
            pid: process.pid,
            acquired_at: (options.now ?? (() => new Date()))().toISOString(),
          },
          null,
          2,
        ),
        'utf8',
      )
      break
    } catch (error) {
      if (!isNodeErrorCode(error, 'EEXIST')) {
        throw error
      }
      await removeStaleLock(lockPath, staleLockMs)
      if (Date.now() - startedAt >= acquireTimeoutMs) {
        throw new Error(`Timed out waiting for Codex Desktop helper lock: ${lockPath}`)
      }
      await sleep(pollMs)
    }
  }

  try {
    return await run()
  } finally {
    await handle.close().catch(() => {})
    await fs.rm(lockPath, { force: true }).catch(() => {})
  }
}

export function parseLastJsonObjectLine(stdout: string): HelperJsonParseResult {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? ''
    if (!line.startsWith('{') || !line.endsWith('}')) {
      continue
    }
    try {
      return {
        payload: JSON.parse(line) as unknown,
        parsedLineIndex: index,
        lineCount: lines.length,
      }
    } catch {
      continue
    }
  }

  return {
    payload: null,
    parsedLineIndex: null,
    lineCount: lines.length,
  }
}

export async function writeDesktopHelperFailureArtifact(input: HelperFailureArtifactInput): Promise<string | null> {
  const artifactRoot = path.resolve(input.artifactRoot)
  const recordedAt = (input.now ?? (() => new Date()))().toISOString()
  const artifactPath = path.join(
    artifactRoot,
    `${sanitizeSlug(input.owner)}-${sanitizeSlug(input.action ?? 'helper')}.latest.json`,
  )
  const temporaryPath = path.join(
    artifactRoot,
    `.${path.basename(artifactPath)}.tmp`,
  )
  try {
    await fs.mkdir(artifactRoot, { recursive: true })
    // The owning helper lock serializes writers. Recover the one fixed
    // crash-residue slot before publishing the next complete latest record.
    await fs.rm(temporaryPath, { force: true })
    const handle = await fs.open(
      temporaryPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    )
    try {
      await handle.writeFile(
      JSON.stringify(
        {
          recorded_at: recordedAt,
          owner: input.owner,
          action: input.action ?? null,
          reason: input.reason,
          exit_code: input.exitCode ?? null,
          args: input.args ? redactHelperArgs(input.args) : [],
          stdout_tail: tailText(input.stdout ?? ''),
          stderr_tail: tailText(input.stderr ?? ''),
        },
        null,
        2,
      ),
      'utf8',
      )
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(temporaryPath, artifactPath)
    return artifactPath
  } catch {
    await fs.rm(temporaryPath, { force: true }).catch(() => {})
    return null
  }
}

function redactHelperArgs(args: string[]): string[] {
  const redacted: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index] ?? ''
    redacted.push(value)
    if (/^-Text$/i.test(value) && index + 1 < args.length) {
      redacted.push('[redacted prompt text]')
      index += 1
    }
  }
  return redacted
}

function tailText(value: string): string {
  if (value.length <= MAX_DEBUG_TEXT_LENGTH) {
    return value
  }
  return value.slice(value.length - MAX_DEBUG_TEXT_LENGTH)
}

async function removeStaleLock(lockPath: string, staleLockMs: number): Promise<void> {
  try {
    const stat = await fs.stat(lockPath)
    if (Date.now() - stat.mtimeMs >= staleLockMs) {
      await fs.rm(lockPath, { force: true })
    }
  } catch {
    // Lock acquisition will keep polling or surface the real open error.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function sanitizeSlug(value: string): string {
  return value.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'helper'
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code
}
