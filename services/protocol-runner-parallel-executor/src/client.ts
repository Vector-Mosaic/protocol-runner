import { promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type {
  ParallelGroupEnvelope,
  ParallelAttemptWarning,
  ProtocolRunnerParallelApiClient,
  RunDiagnostics,
  RunListItem,
} from './types.js'

type JsonRecord = Record<string, unknown>

export async function readControlToken(): Promise<string> {
  let token = process.env.PROTOCOL_RUNNER_CONTROL_TOKEN?.trim()
  if (!token) {
    const tokenPath = process.env.PROTOCOL_RUNNER_CONTROL_TOKEN_FILE?.trim()
      || fileURLToPath(new URL('../../../.protocol-runner/control-token', import.meta.url))
    try { token = (await fs.readFile(tokenPath, 'utf8')).trim() }
    catch { throw new Error('Protocol Runner control token is unavailable. Start the local API through the repository launcher or set PROTOCOL_RUNNER_CONTROL_TOKEN.') }
  }
  if (token.length < 32) throw new Error('Protocol Runner control token must contain at least 32 characters.')
  return token
}

function validateApiBaseUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname.toLowerCase())
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Protocol Runner API URL must be an HTTP loopback origin without credentials, path, query, or fragment.')
  }
  return url.origin
}

export class ProtocolRunnerParallelExecutorApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'ProtocolRunnerParallelExecutorApiError'
  }
}

export class HttpProtocolRunnerParallelApiClient implements ProtocolRunnerParallelApiClient {
  private readonly baseUrl: string
  constructor(private readonly options: { baseUrl: string; timeoutMs?: number; controlToken?: string }) {
    this.baseUrl = validateApiBaseUrl(options.baseUrl)
  }

  async listRuns(): Promise<RunListItem[]> {
    const response = await this.request('GET', '/api/runs')
    return Array.isArray(response.runs) ? (response.runs as RunListItem[]) : []
  }

  async getRunDiagnostics(run_instance_id: string): Promise<RunDiagnostics> {
    const response = await this.request('GET', `/api/runs/${encodeURIComponent(run_instance_id)}/diagnostics`)
    return response.diagnostics as RunDiagnostics
  }

  async getParallelGroup(run_instance_id: string, group_id: string): Promise<ParallelGroupEnvelope> {
    return (await this.request(
      'GET',
      `/api/runs/${encodeURIComponent(run_instance_id)}/parallel-groups/${encodeURIComponent(group_id)}`,
    )) as unknown as ParallelGroupEnvelope
  }

  async grantLeases(
    run_instance_id: string,
    group_id: string,
    input: { executor_id: string; capacity: number; lease_ttl_ms?: number },
  ): Promise<ParallelGroupEnvelope> {
    return (await this.request(
      'POST',
      `/api/runs/${encodeURIComponent(run_instance_id)}/parallel-groups/${encodeURIComponent(group_id)}/leases`,
      input,
    )) as unknown as ParallelGroupEnvelope
  }

  async heartbeat(
    run_instance_id: string,
    group_id: string,
    lease_id: string,
    input: { attempt_warnings?: ParallelAttemptWarning[] } = {},
  ): Promise<ParallelGroupEnvelope> {
    return (await this.request(
      'POST',
      `/api/runs/${encodeURIComponent(run_instance_id)}/parallel-groups/${encodeURIComponent(group_id)}/leases/${encodeURIComponent(lease_id)}/heartbeat`,
      input,
    )) as unknown as ParallelGroupEnvelope
  }

  async recoverStaleLeases(
    run_instance_id: string,
    group_id: string,
    input: { observed_at?: string } = {},
  ): Promise<ParallelGroupEnvelope> {
    return (await this.request(
      'POST',
      `/api/runs/${encodeURIComponent(run_instance_id)}/parallel-groups/${encodeURIComponent(group_id)}/leases/recover-stale`,
      input,
    )) as unknown as ParallelGroupEnvelope
  }

  async controlParallelGroup(
    run_instance_id: string,
    group_id: string,
    action: 'pause' | 'stop',
    input: { reason?: string } = {},
  ): Promise<ParallelGroupEnvelope> {
    return (await this.request(
      'POST',
      `/api/runs/${encodeURIComponent(run_instance_id)}/parallel-groups/${encodeURIComponent(group_id)}/${action}`,
      input,
    )) as unknown as ParallelGroupEnvelope
  }

  async submitAttemptResult(
    run_instance_id: string,
    group_id: string,
    attempt_id: string,
    input: JsonRecord,
  ): Promise<ParallelGroupEnvelope> {
    return (await this.request(
      'POST',
      `/api/runs/${encodeURIComponent(run_instance_id)}/parallel-groups/${encodeURIComponent(group_id)}/attempts/${encodeURIComponent(attempt_id)}/result`,
      input,
    )) as unknown as ParallelGroupEnvelope
  }

  private async request(method: 'GET' | 'POST', path: string, body?: JsonRecord): Promise<JsonRecord> {
    const token = this.options.controlToken?.trim() || await readControlToken()
    if (token.length < 32) throw new Error('Protocol Runner control token must contain at least 32 characters.')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 90_000)
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        redirect: 'error',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined
          ? {}
          : {
              body: JSON.stringify(body),
            }),
      })
      const text = await response.text()
      const parsed = text.trim().length === 0 ? {} : (JSON.parse(text) as JsonRecord)
      if (!response.ok) {
        throw new ProtocolRunnerParallelExecutorApiError(
          typeof parsed.error === 'object' && parsed.error !== null && 'message' in parsed.error
            ? String(parsed.error.message)
            : `protocol-runner-api returned HTTP ${response.status}.`,
          response.status,
        )
      }
      return parsed
    } finally {
      clearTimeout(timeout)
    }
  }
}
