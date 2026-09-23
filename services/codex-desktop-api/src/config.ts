import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface CodexDesktopConfig {
  host: string
  port: number
  bearerToken: string
  artifactRoot: string
  logFilePath: string | null
  codexCliPath: string
  allowedWorkspaceRoot: string
  windowTitle: string
  maxShowMoreClicks: number
  operatorGateAutoAllowMs: number
  operatorGateAttentionEnabled: boolean
  operatorGateAttentionUrl: string
  operatorGateAttentionScriptPath: string
  helperScriptPath: string
  repoRoot: string
}

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(MODULE_DIR, '..', '..', '..')
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

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

function readLoopbackHost(env: NodeJS.ProcessEnv): string {
  const host = env.WORKSTATION_CONTROL_CODEX_DESKTOP_HOST?.trim() || '127.0.0.1'
  if (!LOOPBACK_HOSTS.has(host.toLowerCase())) {
    throw new Error(
      'WORKSTATION_CONTROL_CODEX_DESKTOP_HOST must be a loopback host (127.0.0.1, localhost, or ::1)',
    )
  }

  return host
}

export function readCodexDesktopConfig(env: NodeJS.ProcessEnv = process.env): CodexDesktopConfig {
  return {
    host: readLoopbackHost(env),
    port: readPositiveInt(env, 'WORKSTATION_CONTROL_CODEX_DESKTOP_PORT', 4825),
    bearerToken: readRequired(env, 'WORKSTATION_CONTROL_CODEX_DESKTOP_BEARER_TOKEN'),
    artifactRoot: path.resolve(
      env.WORKSTATION_CONTROL_CODEX_DESKTOP_ARTIFACT_ROOT ??
        path.join(REPO_ROOT, 'artifacts', 'workstation_control', 'codex_desktop'),
    ),
    logFilePath: env.WORKSTATION_CONTROL_CODEX_DESKTOP_LOG_FILE?.trim() || null,
    codexCliPath: path.resolve(readRequired(env, 'CODEX_CLI_PATH')),
    allowedWorkspaceRoot: path.resolve(
      env.WORKSTATION_CONTROL_CODEX_DESKTOP_ALLOWED_CWD ??
        env.WORKSTATION_CONTROL_ALLOWED_CWD ??
        path.join(REPO_ROOT),
    ),
    windowTitle: env.WORKSTATION_CONTROL_CODEX_DESKTOP_WINDOW_TITLE?.trim() || 'Codex',
    maxShowMoreClicks: readPositiveInt(env, 'WORKSTATION_CONTROL_CODEX_DESKTOP_MAX_SHOW_MORE_CLICKS', 16),
    operatorGateAutoAllowMs: readPositiveInt(env, 'WORKSTATION_CONTROL_CODEX_DESKTOP_OPERATOR_GATE_AUTO_ALLOW_MS', 15_000),
    operatorGateAttentionEnabled: readBool(env, 'WORKSTATION_CONTROL_CODEX_DESKTOP_OPERATOR_GATE_ATTENTION_ENABLED', true),
    operatorGateAttentionUrl:
      env.WORKSTATION_CONTROL_CODEX_DESKTOP_OPERATOR_GATE_ATTENTION_URL?.trim() ||
      'http://127.0.0.1:15174/?gate=1',
    operatorGateAttentionScriptPath: path.resolve(
      env.WORKSTATION_CONTROL_CODEX_DESKTOP_OPERATOR_GATE_ATTENTION_SCRIPT_PATH ??
        path.join(REPO_ROOT, 'ops', 'windows', 'show_protocol_runner_gate.ps1'),
    ),
    helperScriptPath: path.resolve(
      env.WORKSTATION_CONTROL_CODEX_DESKTOP_HELPER_SCRIPT_PATH ??
        path.join(REPO_ROOT, 'ops', 'windows', 'invoke_codex_desktop_action.ps1'),
    ),
    repoRoot: REPO_ROOT,
  }
}
