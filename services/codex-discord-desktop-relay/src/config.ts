import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface CodexDiscordDesktopRelayConfig {
  host: string
  port: number
  stateDir: string
  allowedCwd: string
  windowTitle: string
  desktopAdapterMode: 'stub' | 'api'
  desktopActionMode: 'auto' | 'focus'
  desktopApiBaseUrl: string
  desktopApiBearerToken: string | null
  desktopApiTimeoutMs: number
  pollIntervalMs: number
  publishBearerToken: string
  operatorEnabled: boolean
  operatorBearerToken: string | null
  logFilePath: string | null
  orchestration: {
    enabled: boolean
    pythonPath: string
    cliPath: string
    dbPath: string | null
    exportRoot: string | null
    timeoutMs: number
  }
  discord: {
    apiBaseUrl: string
    botToken: string
    guildId: string
    commandChannelId: string
    textChannelParentId: string | null
    channelNamePrefix: string
  }
}

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(MODULE_DIR, '..', '..', '..')
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const DESKTOP_ADAPTER_MODES = new Set(['stub', 'api'])
const DESKTOP_ACTION_MODES = new Set(['auto', 'focus'])

function readRequired(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim()
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`)
  }

  return value
}

function readPositiveInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]?.trim()
  if (!raw) {
    return fallback
  }

  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${key} must be a positive integer`)
  }

  return parsed
}

function readBoolean(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key]?.trim()
  if (!raw) {
    return fallback
  }

  const normalized = raw.toLowerCase()
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false
  }

  throw new Error(`${key} must be a boolean value`)
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
  const host = env.WORKSTATION_CONTROL_DISCORD_DESKTOP_RELAY_HOST?.trim() || '127.0.0.1'
  if (!LOOPBACK_HOSTS.has(host.toLowerCase())) {
    throw new Error(
      'WORKSTATION_CONTROL_DISCORD_DESKTOP_RELAY_HOST must be a loopback host (127.0.0.1, localhost, or ::1)',
    )
  }

  return host
}

function expandWindowsEnvTokens(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/%([^%]+)%/g, (_match, key: string) => env[key] ?? env[key.toUpperCase()] ?? '')
}

function resolveConfiguredPath(value: string): string {
  if (path.isAbsolute(value)) {
    return path.normalize(value)
  }

  if (path.win32.isAbsolute(value)) {
    return path.win32.normalize(value)
  }

  return path.resolve(value)
}

function defaultStateDir(env: NodeJS.ProcessEnv): string {
  const localAppData = env.LOCALAPPDATA?.trim()
  if (localAppData) {
    return path.join(localAppData, 'ProtocolRunner', 'codex-discord-desktop-relay')
  }

  return path.join(REPO_ROOT, 'artifacts', 'workstation_control', 'codex_discord_desktop_relay', 'state')
}

function readLoopbackUrl(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const raw = env[key]?.trim() || fallback
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`${key} must be a valid URL`)
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error(`${key} must target a loopback host`)
  }
  return parsed.toString().replace(/\/+$/, '')
}

function readAbsolutePath(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const raw = expandWindowsEnvTokens(env[key]?.trim() || fallback, env)
  const resolved = resolveConfiguredPath(raw)
  if (!path.isAbsolute(resolved) && !path.win32.isAbsolute(resolved)) {
    throw new Error(`${key} must resolve to an absolute path`)
  }

  return resolved
}

function readOptionalAbsolutePath(env: NodeJS.ProcessEnv, key: string): string | null {
  const raw = env[key]?.trim()
  if (!raw) {
    return null
  }

  const resolved = resolveConfiguredPath(expandWindowsEnvTokens(raw, env))
  if (!path.isAbsolute(resolved) && !path.win32.isAbsolute(resolved)) {
    throw new Error(`${key} must resolve to an absolute path`)
  }

  return resolved
}

export function readCodexDiscordDesktopRelayConfig(
  env: NodeJS.ProcessEnv = process.env,
): CodexDiscordDesktopRelayConfig {
  const orchestrationEnabled = readBoolean(env, 'WORKSTATION_CONTROL_DISCORD_DESKTOP_RELAY_ORCHESTRATION_ENABLED', false)
  if (orchestrationEnabled && !env.WORKSTATION_CONTROL_CODEX_ORCHESTRATION_CLI_PATH?.trim()) {
    throw new Error('External orchestration requires an explicit WORKSTATION_CONTROL_CODEX_ORCHESTRATION_CLI_PATH; no private orchestration runtime is bundled.')
  }
  const operatorEnabled = readBoolean(env, 'WORKSTATION_CONTROL_DISCORD_DESKTOP_RELAY_OPERATOR_ENABLED', false)
  const operatorBearerToken = env.WORKSTATION_CONTROL_DISCORD_DESKTOP_RELAY_OPERATOR_BEARER_TOKEN?.trim() || null
  const desktopAdapterMode = readEnum<'stub' | 'api'>(
    env,
    'WORKSTATION_CONTROL_DISCORD_DESKTOP_RELAY_DESKTOP_ADAPTER_MODE',
    'stub',
    DESKTOP_ADAPTER_MODES,
  )
  const desktopApiBearerToken =
    env.WORKSTATION_CONTROL_RELAY_CODEX_DESKTOP_BEARER_TOKEN?.trim() ||
    env.WORKSTATION_CONTROL_CODEX_DESKTOP_BEARER_TOKEN?.trim() ||
    null
  if (operatorEnabled && !operatorBearerToken) {
    throw new Error(
      'WORKSTATION_CONTROL_DISCORD_DESKTOP_RELAY_OPERATOR_BEARER_TOKEN is required when operator mode is enabled',
    )
  }
  if (desktopAdapterMode === 'api' && !desktopApiBearerToken) {
    throw new Error(
      'WORKSTATION_CONTROL_RELAY_CODEX_DESKTOP_BEARER_TOKEN or WORKSTATION_CONTROL_CODEX_DESKTOP_BEARER_TOKEN is required when the relay desktop adapter mode is api',
    )
  }

  return {
    host: readLoopbackHost(env),
    port: readPositiveInt(env, 'WORKSTATION_CONTROL_DISCORD_DESKTOP_RELAY_PORT', 4830),
    stateDir: readAbsolutePath(
      env,
      'WORKSTATION_CONTROL_DISCORD_DESKTOP_RELAY_STATE_DIR',
      defaultStateDir(env),
    ),
    allowedCwd: readAbsolutePath(
      env,
      'WORKSTATION_CONTROL_DISCORD_DESKTOP_RELAY_ALLOWED_CWD',
      REPO_ROOT,
    ),
    windowTitle: env.WORKSTATION_CONTROL_DISCORD_DESKTOP_RELAY_WINDOW_TITLE?.trim() || 'Codex',
    desktopAdapterMode,
    desktopActionMode: readEnum(
      env,
      'WORKSTATION_CONTROL_DISCORD_DESKTOP_RELAY_DESKTOP_ACTION_MODE',
      'focus',
      DESKTOP_ACTION_MODES,
    ),
    desktopApiBaseUrl: readLoopbackUrl(
      env,
      'WORKSTATION_CONTROL_RELAY_CODEX_DESKTOP_BASE_URL',
      'http://127.0.0.1:4825',
    ),
    desktopApiBearerToken,
    desktopApiTimeoutMs: readPositiveInt(env, 'WORKSTATION_CONTROL_RELAY_CODEX_DESKTOP_TIMEOUT_MS', 60_000),
    pollIntervalMs: readPositiveInt(env, 'WORKSTATION_CONTROL_DISCORD_DESKTOP_RELAY_POLL_INTERVAL_MS', 2_500),
    publishBearerToken: readRequired(env, 'WORKSTATION_CONTROL_DISCORD_DESKTOP_RELAY_PUBLISH_BEARER_TOKEN'),
    operatorEnabled,
    operatorBearerToken,
    logFilePath: env.WORKSTATION_CONTROL_DISCORD_DESKTOP_RELAY_LOG_FILE?.trim() || null,
    orchestration: {
      enabled: orchestrationEnabled,
      pythonPath: env.WORKSTATION_CONTROL_CODEX_ORCHESTRATION_PYTHON?.trim() || env.PYTHON?.trim() || 'python',
      cliPath: readOptionalAbsolutePath(env, 'WORKSTATION_CONTROL_CODEX_ORCHESTRATION_CLI_PATH') ?? '',
      dbPath: readOptionalAbsolutePath(env, 'WORKSTATION_CONTROL_CODEX_ORCHESTRATION_DB_PATH'),
      exportRoot: readOptionalAbsolutePath(env, 'WORKSTATION_CONTROL_CODEX_ORCHESTRATION_EXPORT_ROOT'),
      timeoutMs: readPositiveInt(env, 'WORKSTATION_CONTROL_CODEX_ORCHESTRATION_TIMEOUT_MS', 30_000),
    },
    discord: {
      apiBaseUrl: env.WORKSTATION_CONTROL_DISCORD_DESKTOP_RELAY_DISCORD_API_BASE?.trim() || 'https://discord.com/api/v10',
      botToken: readRequired(env, 'WORKSTATION_CONTROL_DISCORD_DESKTOP_RELAY_BOT_TOKEN'),
      guildId: readRequired(env, 'WORKSTATION_CONTROL_DISCORD_DESKTOP_RELAY_GUILD_ID'),
      commandChannelId: readRequired(env, 'WORKSTATION_CONTROL_DISCORD_DESKTOP_RELAY_COMMAND_CHANNEL_ID'),
      textChannelParentId:
        env.WORKSTATION_CONTROL_DISCORD_DESKTOP_RELAY_TEXT_CHANNEL_PARENT_ID?.trim() || null,
      channelNamePrefix: env.WORKSTATION_CONTROL_DISCORD_DESKTOP_RELAY_CHANNEL_NAME_PREFIX?.trim() || 'codex',
    },
  }
}
