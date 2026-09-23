export interface ProtocolRunnerDriverConfig {
  apiBaseUrl: string
  controlToken: string
  pollIntervalMs: number
  apiTimeoutMs: number
  healthHost: string
  healthPort: number
}

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

function readLoopbackUrl(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const raw = env[key]?.trim() || fallback
  const parsed = new URL(raw)
  if (parsed.protocol !== 'http:') {
    throw new Error(`${key} must use http.`)
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname.toLowerCase())) {
    throw new Error(`${key} must target a loopback host.`)
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
    throw new Error(`${key} must be a loopback origin without credentials, path, query, or fragment.`)
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '')
  parsed.search = ''
  parsed.hash = ''
  return parsed.toString().replace(/\/$/, '')
}

function readLoopbackHost(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const host = env[key]?.trim() || fallback
  if (!['127.0.0.1', 'localhost', '::1'].includes(host.toLowerCase())) {
    throw new Error(`${key} must be a loopback host.`)
  }
  return host
}

export function readProtocolRunnerDriverConfig(env: NodeJS.ProcessEnv = process.env): ProtocolRunnerDriverConfig {
  const controlToken = env.PROTOCOL_RUNNER_CONTROL_TOKEN?.trim() ?? ''
  if (!/^[\x21-\x7e]{32,1024}$/.test(controlToken)) {
    throw new Error('PROTOCOL_RUNNER_CONTROL_TOKEN must contain 32 to 1024 printable non-space ASCII characters.')
  }
  return {
    apiBaseUrl: readLoopbackUrl(env, 'PROTOCOL_RUNNER_API_URL', 'http://127.0.0.1:4831'),
    controlToken,
    pollIntervalMs: readPositiveInt(env, 'PROTOCOL_RUNNER_DRIVER_POLL_INTERVAL_MS', 1_000),
    apiTimeoutMs: readPositiveInt(env, 'PROTOCOL_RUNNER_DRIVER_API_TIMEOUT_MS', 90_000),
    healthHost: readLoopbackHost(env, 'PROTOCOL_RUNNER_DRIVER_HEALTH_HOST', '127.0.0.1'),
    healthPort: readPositiveInt(env, 'PROTOCOL_RUNNER_DRIVER_HEALTH_PORT', 4_832),
  }
}
