import type { DriverRunView, ProtocolRunnerApiClient, RunListItem } from './types.js'

type JsonRecord = Record<string, unknown>

export class ProtocolRunnerDriverApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'ProtocolRunnerDriverApiError'
  }
}

export class HttpProtocolRunnerApiClient implements ProtocolRunnerApiClient {
  constructor(private readonly options: { baseUrl: string; controlToken: string; timeoutMs?: number }) {
    const url = new URL(options.baseUrl)
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('Protocol Runner API must be one loopback HTTP origin.')
    }
    if (!/^[\x21-\x7e]{32,1024}$/.test(options.controlToken)) {
      throw new Error('A valid local Protocol Runner control token is required.')
    }
  }

  async listRuns(): Promise<RunListItem[]> {
    const response = await this.request('GET', '/api/runs')
    return Array.isArray(response.runs) ? (response.runs as RunListItem[]) : []
  }

  async getRun(run_instance_id: string): Promise<DriverRunView> {
    const response = await this.request('GET', `/api/runs/${encodeURIComponent(run_instance_id)}`)
    return response.run as DriverRunView
  }

  async startRun(run_instance_id: string): Promise<DriverRunView> {
    const response = await this.request('POST', `/api/runs/${encodeURIComponent(run_instance_id)}/start`, {})
    return response.run as DriverRunView
  }

  private async request(method: 'GET' | 'POST', path: string, body?: JsonRecord): Promise<JsonRecord> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 90_000)
    try {
      const response = await fetch(`${this.options.baseUrl.replace(/\/$/, '')}${path}`, {
        method,
        redirect: 'error',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.options.controlToken}`,
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
        throw new ProtocolRunnerDriverApiError(
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
