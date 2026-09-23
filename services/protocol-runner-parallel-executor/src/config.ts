import path from 'node:path'

import type { WorkerRuntimeProfileConfig } from './runtime-profile.js'

export interface ProtocolRunnerParallelExecutorConfig {
  apiBaseUrl: string
  apiTimeoutMs: number
  pollIntervalMs: number
  executorId: string
  capacity: number
  launchBatchSize: number
  launchBatchIntervalMs: number
  leaseTtlMs: number
  heartbeatIntervalMs: number
  longRunningAfterMs: number
  possiblyStalledAfterMs: number
  workspaceRoot: string
  launcherMode: 'fake' | 'codex_exec'
  codexCommand: string
  codexModel?: string
  codexProfile?: string
  codexSandbox?: string
  codexBypassApprovalsAndSandbox: boolean
  hardTimeoutMs?: number
  workerRuntimeProfile: WorkerRuntimeProfileConfig
  healthHost: string
  healthPort: number
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
export const DEFAULT_PARALLEL_LEASE_TTL_MS = 5 * 60 * 1000
export const DEFAULT_PARALLEL_HEARTBEAT_INTERVAL_MS = 30 * 1000

function readPositiveInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]?.trim()
  if (!raw) {
    return fallback
  }

  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${key} must be a positive integer.`)
  }

  return parsed
}

function readOptionalPositiveInt(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const raw = env[key]?.trim()
  if (!raw) {
    return undefined
  }

  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${key} must be a positive integer when set.`)
  }
  return parsed
}

function readSafeId(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const value = env[key]?.trim() || fallback
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) {
    throw new Error(`${key} must start with a letter or number and contain only letters, numbers, underscores, or hyphens.`)
  }
  return value
}

function readLoopbackUrl(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const raw = env[key]?.trim() || fallback
  const parsed = new URL(raw)
  if (parsed.protocol !== 'http:') {
    throw new Error(`${key} must use http.`)
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase())) {
    throw new Error(`${key} must target a loopback host.`)
  }
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(`${key} must be a loopback origin without credentials, path, query, or fragment.`)
  }
  return parsed.origin
}

function readLoopbackHost(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const host = env[key]?.trim() || fallback
  if (!LOOPBACK_HOSTS.has(host.toLowerCase())) {
    throw new Error(`${key} must be a loopback host.`)
  }
  return host
}

function readLauncherMode(env: NodeJS.ProcessEnv): 'fake' | 'codex_exec' {
  const value = env.PROTOCOL_RUNNER_PARALLEL_EXECUTOR_MODE?.trim() || 'fake'
  if (value !== 'fake' && value !== 'codex_exec') {
    throw new Error('PROTOCOL_RUNNER_PARALLEL_EXECUTOR_MODE must be fake or codex_exec.')
  }
  return value
}

function readOptionalString(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim()
  return value ? value : undefined
}

function readOptionalPath(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = readOptionalString(env, key)
  return value === undefined ? undefined : path.resolve(value)
}

function readPathPrepend(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PROTOCOL_RUNNER_PARALLEL_EXECUTOR_WORKER_PATH_PREPEND?.trim()
  if (!raw) {
    return []
  }
  return raw
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => path.resolve(entry))
}

function readBoolean(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const value = env[key]?.trim().toLowerCase()
  if (!value) {
    return fallback
  }
  if (['1', 'true', 'yes', 'on'].includes(value)) {
    return true
  }
  if (['0', 'false', 'no', 'off'].includes(value)) {
    return false
  }
  throw new Error(`${key} must be a boolean value.`)
}

export function readProtocolRunnerParallelExecutorConfig(
  env: NodeJS.ProcessEnv = process.env,
): ProtocolRunnerParallelExecutorConfig {
  const launcherMode = readLauncherMode(env)
  const workspaceRoot = env.PROTOCOL_RUNNER_PARALLEL_EXECUTOR_WORKSPACE_ROOT?.trim()
  if (launcherMode === 'codex_exec' && !workspaceRoot) {
    throw new Error('Live execution requires an explicit PROTOCOL_RUNNER_PARALLEL_EXECUTOR_WORKSPACE_ROOT.')
  }
  const codexSandbox = readOptionalString(env, 'PROTOCOL_RUNNER_PARALLEL_EXECUTOR_CODEX_SANDBOX') ?? 'workspace-write'
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(codexSandbox)) {
    throw new Error('PROTOCOL_RUNNER_PARALLEL_EXECUTOR_CODEX_SANDBOX must be read-only, workspace-write, or danger-full-access.')
  }
  const leaseTtlMs = readPositiveInt(
    env,
    'PROTOCOL_RUNNER_PARALLEL_EXECUTOR_LEASE_TTL_MS',
    DEFAULT_PARALLEL_LEASE_TTL_MS,
  )
  const heartbeatIntervalMs = readPositiveInt(
    env,
    'PROTOCOL_RUNNER_PARALLEL_EXECUTOR_HEARTBEAT_INTERVAL_MS',
    DEFAULT_PARALLEL_HEARTBEAT_INTERVAL_MS,
  )
  if (heartbeatIntervalMs >= leaseTtlMs) {
    throw new Error('PROTOCOL_RUNNER_PARALLEL_EXECUTOR_HEARTBEAT_INTERVAL_MS must be less than lease TTL.')
  }
  return {
    apiBaseUrl: readLoopbackUrl(env, 'PROTOCOL_RUNNER_API_URL', 'http://127.0.0.1:14831'),
    apiTimeoutMs: readPositiveInt(env, 'PROTOCOL_RUNNER_PARALLEL_EXECUTOR_API_TIMEOUT_MS', 90_000),
    pollIntervalMs: readPositiveInt(env, 'PROTOCOL_RUNNER_PARALLEL_EXECUTOR_POLL_INTERVAL_MS', 1_000),
    executorId: readSafeId(env, 'PROTOCOL_RUNNER_PARALLEL_EXECUTOR_ID', 'parallel_executor_local'),
    capacity: readPositiveInt(env, 'PROTOCOL_RUNNER_PARALLEL_EXECUTOR_CAPACITY', 1),
    launchBatchSize: readPositiveInt(env, 'PROTOCOL_RUNNER_PARALLEL_EXECUTOR_LAUNCH_BATCH_SIZE', 1),
    launchBatchIntervalMs: readPositiveInt(env, 'PROTOCOL_RUNNER_PARALLEL_EXECUTOR_LAUNCH_BATCH_INTERVAL_MS', 15_000),
    leaseTtlMs,
    heartbeatIntervalMs,
    longRunningAfterMs: readPositiveInt(env, 'PROTOCOL_RUNNER_PARALLEL_EXECUTOR_LONG_RUNNING_AFTER_MS', 1_200_000),
    possiblyStalledAfterMs: readPositiveInt(env, 'PROTOCOL_RUNNER_PARALLEL_EXECUTOR_POSSIBLY_STALLED_AFTER_MS', 1_200_000),
    workspaceRoot: path.resolve(workspaceRoot || process.cwd()),
    launcherMode,
    codexCommand: readOptionalString(env, 'PROTOCOL_RUNNER_PARALLEL_EXECUTOR_CODEX_COMMAND') ?? 'codex',
    codexModel: readOptionalString(env, 'PROTOCOL_RUNNER_PARALLEL_EXECUTOR_CODEX_MODEL'),
    codexProfile: readOptionalString(env, 'PROTOCOL_RUNNER_PARALLEL_EXECUTOR_CODEX_PROFILE'),
    codexSandbox,
    codexBypassApprovalsAndSandbox: readBoolean(
      env,
      'PROTOCOL_RUNNER_PARALLEL_EXECUTOR_CODEX_BYPASS_APPROVALS_AND_SANDBOX',
      false,
    ),
    hardTimeoutMs: readOptionalPositiveInt(env, 'PROTOCOL_RUNNER_PARALLEL_EXECUTOR_HARD_TIMEOUT_MS'),
    workerRuntimeProfile: {
      profile_id: readSafeId(
        env,
        'PROTOCOL_RUNNER_PARALLEL_EXECUTOR_WORKER_RUNTIME_PROFILE_ID',
        'local_default',
      ),
      path_prepend: readPathPrepend(env),
      tools: {
        node_exe: readOptionalPath(env, 'PROTOCOL_RUNNER_PARALLEL_EXECUTOR_WORKER_NODE_EXE'),
        pnpm_cmd: readOptionalPath(env, 'PROTOCOL_RUNNER_PARALLEL_EXECUTOR_WORKER_PNPM_CMD'),
        python_exe: readOptionalPath(env, 'PROTOCOL_RUNNER_PARALLEL_EXECUTOR_WORKER_PYTHON_EXE'),
      },
    },
    healthHost: readLoopbackHost(env, 'PROTOCOL_RUNNER_PARALLEL_EXECUTOR_HEALTH_HOST', '127.0.0.1'),
    healthPort: readPositiveInt(env, 'PROTOCOL_RUNNER_PARALLEL_EXECUTOR_HEALTH_PORT', 14_833),
  }
}
