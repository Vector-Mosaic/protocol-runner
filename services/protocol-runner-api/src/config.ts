import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { requireControlToken, type ProtocolRunnerSecurity } from './control-auth.js'
import type { SerialReportCommands } from '../../../packages/protocol-runner-core/dist/index.js'

export type ProtocolRunnerAdapterMode = 'fake' | 'real'
export type ProtocolRunnerDesktopPromptMode = 'auto' | 'focus'
export type ProtocolRunnerStoreMode = 'sqlite' | 'json'

export interface ProtocolRunnerApiConfig {
  host: string
  port: number
  security: ProtocolRunnerSecurity
  reportCommands: SerialReportCommands
  runsRoot: string | null
  dbPath: string
  storeMode: ProtocolRunnerStoreMode
  contractRoot: string
  adapterMode: ProtocolRunnerAdapterMode
  desktop: {
    baseUrl: string
    bearerToken: string | null
    promptMode: ProtocolRunnerDesktopPromptMode
  }
  relay: {
    baseUrl: string
    publishBearerToken: string | null
    operatorBearerToken: string | null
  }
  notification: {
    enabled: boolean
    scriptPath: string
    notifyUrl: string
    repoRoot: string
  }
}

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(MODULE_DIR, '..', '..', '..')
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const ADAPTER_MODES = new Set(['fake', 'real'])
const PROMPT_MODES = new Set(['auto', 'focus'])
const STORE_MODES = new Set(['sqlite', 'json'])

function readPositiveInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]?.trim()
  if (!raw) {
    return fallback
  }

  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${key} must be an integer from 1 to 65535`)
  }

  return parsed
}

function readEnum<T extends string>(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: T,
  allowed: ReadonlySet<string>,
): T {
  const raw = env[key]?.trim() || fallback
  if (!allowed.has(raw)) {
    throw new Error(`${key} must be one of: ${Array.from(allowed).join(', ')}`)
  }

  return raw as T
}

function readLoopbackHost(env: NodeJS.ProcessEnv): string {
  const host = env.PROTOCOL_RUNNER_API_HOST?.trim() || '127.0.0.1'
  if (!LOOPBACK_HOSTS.has(host.toLowerCase())) {
    throw new Error('PROTOCOL_RUNNER_API_HOST must be a loopback host (127.0.0.1, localhost, or ::1)')
  }

  return host
}

function readLoopbackBaseUrl(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const raw = env[key]?.trim() || fallback
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch (error) {
    throw new Error(`${key} must be a valid URL: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (parsed.protocol !== 'http:') {
    throw new Error(`${key} must use http for loopback service access`)
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${key} must not contain URL credentials`)
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase().replace(/^\[|\]$/g, ''))) {
    throw new Error(`${key} must target a loopback host (127.0.0.1, localhost, or ::1)`)
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/, '')
  parsed.search = ''
  parsed.hash = ''
  return parsed.toString().replace(/\/$/, '')
}

function readLoopbackUrl(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const raw = env[key]?.trim() || fallback
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch (error) {
    throw new Error(`${key} must be a valid URL: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (parsed.protocol !== 'http:') {
    throw new Error(`${key} must use http for loopback service access`)
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase().replace(/^\[|\]$/g, ''))) {
    throw new Error(`${key} must target a loopback host (127.0.0.1, localhost, or ::1)`)
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${key} must not contain URL credentials`)
  }

  return parsed.toString()
}

function readOptionalAbsolutePath(env: NodeJS.ProcessEnv, key: string): string | null {
  const raw = env[key]?.trim()
  if (!raw) {
    return null
  }

  return path.resolve(raw)
}

function readRequiredSecret(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim()
  if (!value) {
    throw new Error(`${key} is required when PROTOCOL_RUNNER_ADAPTER_MODE=real`)
  }

  return value
}

function readBool(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key]?.trim().toLowerCase()
  if (!raw) {
    return fallback
  }

  if (raw === '1' || raw === 'true' || raw === 'yes') {
    return true
  }
  if (raw === '0' || raw === 'false' || raw === 'no') {
    return false
  }

  throw new Error(`${key} must be true/false, yes/no, or 1/0`)
}

export function readProtocolRunnerApiConfig(env: NodeJS.ProcessEnv = process.env): ProtocolRunnerApiConfig {
  const adapterMode = readEnum<ProtocolRunnerAdapterMode>(env, 'PROTOCOL_RUNNER_ADAPTER_MODE', 'fake', ADAPTER_MODES)
  const host = readLoopbackHost(env)
  const port = readPositiveInt(env, 'PROTOCOL_RUNNER_API_PORT', 4831)
  const origin = new URL(`http://${host === '::1' ? '[::1]' : host}:${port}`)
  const pythonExecutable = env.PROTOCOL_RUNNER_PYTHON_EXECUTABLE?.trim() || (process.platform === 'win32' ? 'python' : 'python3')
  const reportShell = readEnum<SerialReportCommands['shell']>(
    env, 'PROTOCOL_RUNNER_REPORT_SHELL', process.platform === 'win32' ? 'powershell' : 'posix',
    new Set(['powershell', 'posix']),
  )
  const runsRoot =
    readOptionalAbsolutePath(env, 'PROTOCOL_RUNNER_RUNS_ROOT') ??
    path.join(REPO_ROOT, '.protocol-runner', 'runs')

  return {
    host,
    port,
    security: {
      mode: 'token',
      controlToken: requireControlToken(env.PROTOCOL_RUNNER_CONTROL_TOKEN),
      allowedHost: origin.host,
      allowedOrigin: origin.origin,
    },
    reportCommands: {
      shell: reportShell,
      start_report: [pythonExecutable, path.join(REPO_ROOT, 'scripts', 'tools', 'protocol_runner_step_start.py'), '--base-url', origin.origin],
      status_report: [pythonExecutable, path.join(REPO_ROOT, 'scripts', 'tools', 'protocol_runner_return.py'), '--base-url', origin.origin],
    },
    runsRoot,
    dbPath:
      readOptionalAbsolutePath(env, 'PROTOCOL_RUNNER_DB_PATH') ??
      path.join(path.dirname(runsRoot), 'protocol_runner.sqlite'),
    storeMode: readEnum<ProtocolRunnerStoreMode>(env, 'PROTOCOL_RUNNER_STORE_MODE', 'sqlite', STORE_MODES),
    contractRoot: readOptionalAbsolutePath(env, 'PROTOCOL_RUNNER_CONTRACT_ROOT') ?? REPO_ROOT,
    adapterMode,
    desktop: {
      baseUrl: readLoopbackBaseUrl(env, 'PROTOCOL_RUNNER_CODEX_DESKTOP_BASE_URL', 'http://127.0.0.1:4825'),
      bearerToken:
        adapterMode === 'real' ? readRequiredSecret(env, 'PROTOCOL_RUNNER_CODEX_DESKTOP_BEARER_TOKEN') : null,
      promptMode: readEnum<ProtocolRunnerDesktopPromptMode>(
        env,
        'PROTOCOL_RUNNER_CODEX_DESKTOP_PROMPT_MODE',
        'focus',
        PROMPT_MODES,
      ),
    },
    relay: {
      baseUrl: readLoopbackBaseUrl(env, 'PROTOCOL_RUNNER_DISCORD_RELAY_BASE_URL', 'http://127.0.0.1:4830'),
      publishBearerToken:
        adapterMode === 'real' ? readRequiredSecret(env, 'PROTOCOL_RUNNER_DISCORD_RELAY_PUBLISH_BEARER_TOKEN') : null,
      operatorBearerToken:
        adapterMode === 'real' ? readRequiredSecret(env, 'PROTOCOL_RUNNER_DISCORD_RELAY_OPERATOR_BEARER_TOKEN') : null,
    },
    notification: {
      enabled: readBool(env, 'PROTOCOL_RUNNER_NOTIFICATION_ENABLED', false),
      scriptPath: path.resolve(
        env.PROTOCOL_RUNNER_NOTIFICATION_SCRIPT_PATH ??
          path.join(REPO_ROOT, 'ops', 'windows', 'show_protocol_runner_gate.ps1'),
      ),
      notifyUrl: readLoopbackUrl(env, 'PROTOCOL_RUNNER_NOTIFICATION_URL', 'http://127.0.0.1:5174/?notify=1'),
      repoRoot: REPO_ROOT,
    },
  }
}
