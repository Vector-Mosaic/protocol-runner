import type { BindingMetadata } from '../../../packages/protocol-runner-core/dist/index.js'

import type { ProtocolRunnerDesktopPromptMode } from './config.js'
import type {
  AdapterHealth,
  BindRunInput,
  CloseRunBindingInput,
  CodexDesktopAdapter,
  CodexReadbackResult,
  DesktopOperatorGateResult,
  DiscordRelayAdapter,
  PromptSendResult,
  RelayCloseResult,
  RelayPublishInput,
  RelayPublishResult,
  SendPromptInput,
  ThreadSelector,
} from './adapters.js'

type JsonRecord = Record<string, unknown>

interface HttpClientOptions {
  baseUrl: string
  bearerToken?: string | null
  timeoutMs?: number
}

interface HttpResponse {
  status: number
  ok: boolean
  body: unknown
  text: string
}

interface RelayBindResponse {
  ok: true
  channelId: string
  channelName: string
  channelUrl: string | null
  shortLabel: number
  bindingId: string
  status: string
  bindingNoteStatus: string
  desktopThreadLabel: string | null
  codexThreadId: string | null
}

const DEFAULT_HTTP_TIMEOUT_MS = 120_000

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function optionalBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function optionalRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

function statusMessage(response: HttpResponse, fallback: string): string {
  if (isRecord(response.body) && typeof response.body.message === 'string') {
    return response.body.message
  }
  if (isRecord(response.body) && typeof response.body.error === 'string') {
    return response.body.error
  }
  if (response.text.trim()) {
    return response.text.trim()
  }
  return fallback
}

class JsonHttpClient {
  private readonly baseUrl: string
  private readonly bearerToken: string | null
  private readonly timeoutMs: number

  constructor(options: HttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.bearerToken = options.bearerToken ?? null
    this.timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS
  }

  async get(pathname: string, auth = true): Promise<HttpResponse> {
    return this.request('GET', pathname, undefined, auth)
  }

  async post(pathname: string, body: JsonRecord, auth = true): Promise<HttpResponse> {
    return this.request('POST', pathname, body, auth)
  }

  private async request(method: string, pathname: string, body?: JsonRecord, auth = true): Promise<HttpResponse> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    const headers: Record<string, string> = {
      accept: 'application/json',
    }
    if (body !== undefined) {
      headers['content-type'] = 'application/json'
    }
    if (auth && this.bearerToken) {
      headers.authorization = `Bearer ${this.bearerToken}`
    }

    try {
      const response = await fetch(`${this.baseUrl}${pathname}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      const text = await response.text()
      let parsed: unknown = text
      if ((response.headers.get('content-type') ?? '').includes('application/json') && text.trim()) {
        parsed = JSON.parse(text) as unknown
      }
      return {
        status: response.status,
        ok: response.ok,
        body: parsed,
        text,
      }
    } finally {
      clearTimeout(timeout)
    }
  }
}

function healthFromHttp(
  adapter: string,
  response: HttpResponse,
  message: string,
  mode: AdapterHealth['mode'] = 'real',
): AdapterHealth {
  const bodyOk = !isRecord(response.body) || response.body.ok !== false
  return {
    ok: response.ok && bodyOk,
    adapter,
    mode,
    message: response.ok && bodyOk ? message : statusMessage(response, `HTTP ${response.status}`),
    details: {
      status: response.status,
      body: isRecord(response.body) ? response.body : undefined,
    },
  }
}

export class HttpCodexDesktopAdapter implements CodexDesktopAdapter {
  private readonly client: JsonHttpClient
  private readonly promptMode: ProtocolRunnerDesktopPromptMode

  constructor(options: HttpClientOptions & { promptMode: ProtocolRunnerDesktopPromptMode }) {
    this.client = new JsonHttpClient(options)
    this.promptMode = options.promptMode
  }

  async health(): Promise<AdapterHealth> {
    try {
      const response = await this.client.get('/healthz', false)
      return healthFromHttp('codex_desktop', response, 'Codex Desktop API is reachable.')
    } catch (error) {
      return {
        ok: false,
        adapter: 'codex_desktop',
        mode: 'real',
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async getState(): Promise<Record<string, unknown>> {
    try {
      const response = await this.client.get('/api/codex-desktop/state')
      return isRecord(response.body)
        ? { ok: response.ok, status: response.status, ...response.body }
        : { ok: false, status: response.status, raw_text: response.text }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async operatorGateState(): Promise<DesktopOperatorGateResult> {
    return this.operatorGateRequest('GET', '/api/codex-desktop/operator-gate')
  }

  async operatorGateWait(): Promise<DesktopOperatorGateResult> {
    return this.operatorGateRequest('POST', '/api/codex-desktop/operator-gate/wait')
  }

  async operatorGateAllowNow(): Promise<DesktopOperatorGateResult> {
    return this.operatorGateRequest('POST', '/api/codex-desktop/operator-gate/allow-now')
  }

  async sendPrompt(input: SendPromptInput): Promise<PromptSendResult> {
    const response = await this.client.post('/api/codex-desktop/prompt', {
      threadTitle: input.thread_binding.visible_thread_label ?? null,
      text: input.prompt,
      mode: this.promptMode,
      caller: `protocol-runner:${input.run_instance_id}:${input.step_id}`,
    })

    if (!isRecord(response.body)) {
      return {
        send_status: response.ok ? 'unknown' : 'not_sent',
        desktop_result: response.ok ? 'invalid_desktop_response' : `http_${response.status}`,
        message: response.text.trim() || 'Desktop API returned a non-JSON response.',
        thread_id: null,
        thread_title: input.thread_binding.visible_thread_label ?? null,
      }
    }

    const desktopResult = typeof response.body.result === 'string' ? response.body.result : `http_${response.status}`
    const turnId = optionalString(response.body.turnId)
    const itemId = optionalString(response.body.itemId)
    const selectionConfirmed = optionalBoolean(response.body.selectionConfirmed)
    const deliveryConfirmed = selectionConfirmed === true
    const appliedWithoutDeliveryConfirmation = response.ok && desktopResult === 'applied' && !deliveryConfirmed
    const sendStatus =
      response.ok && desktopResult === 'applied' && deliveryConfirmed
        ? 'sent'
        : appliedWithoutDeliveryConfirmation
          ? 'unknown'
          : 'not_sent'
    return {
      send_status: sendStatus,
      desktop_result: desktopResult,
      message: appliedWithoutDeliveryConfirmation
        ? statusMessage(
            response,
            'Desktop API performed the UI action, but did not return exact sidebar selection confirmation.',
          )
        : statusMessage(response, response.ok ? 'Desktop API response did not confirm prompt submission.' : ''),
      thread_id: null,
      thread_title: optionalString(response.body.threadTitle) ?? input.thread_binding.visible_thread_label ?? null,
      turn_id: turnId,
      item_id: itemId,
      selection_confirmed: selectionConfirmed,
      desktop_diagnostics: optionalRecord(response.body.composeDiagnostics),
    }
  }

  async readback(input: ThreadSelector): Promise<CodexReadbackResult> {
    const query = new URLSearchParams({ threadId: input.thread_id })
    if (input.thread_label) {
      query.set('threadTitle', input.thread_label)
    }
    const response = await this.client.get(`/api/codex-desktop/readback?${query.toString()}`)
    const body = isRecord(response.body) ? response.body : {}
    return {
      ok: response.ok && body.result === 'applied',
      thread_id: optionalString(body.threadId) ?? input.thread_id,
      text: optionalString(body.visibleTranscriptText) ?? '',
    }
  }

  private async operatorGateRequest(method: 'GET' | 'POST', path: string): Promise<DesktopOperatorGateResult> {
    const response = method === 'GET' ? await this.client.get(path) : await this.client.post(path, {})
    const body = isRecord(response.body) ? response.body : {}
    const gate = isRecord(body.gate) ? body.gate : {}
    return {
      ok: response.ok && gate !== undefined,
      gate,
    }
  }
}

export class HttpDiscordRelayAdapter implements DiscordRelayAdapter {
  private readonly operatorClient: JsonHttpClient
  private readonly publishClient: JsonHttpClient

  constructor(options: {
    baseUrl: string
    operatorBearerToken?: string | null
    publishBearerToken?: string | null
    timeoutMs?: number
  }) {
    this.operatorClient = new JsonHttpClient({
      baseUrl: options.baseUrl,
      bearerToken: options.operatorBearerToken,
      timeoutMs: options.timeoutMs,
    })
    this.publishClient = new JsonHttpClient({
      baseUrl: options.baseUrl,
      bearerToken: options.publishBearerToken,
      timeoutMs: options.timeoutMs,
    })
  }

  async health(): Promise<AdapterHealth> {
    try {
      const response = await this.operatorClient.get('/healthz', false)
      return healthFromHttp('discord_relay', response, 'Discord relay API is reachable.')
    } catch (error) {
      return {
        ok: false,
        adapter: 'discord_relay',
        mode: 'real',
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async ready(): Promise<AdapterHealth> {
    try {
      const response = await this.operatorClient.get('/readyz', false)
      return healthFromHttp('discord_relay_ready', response, 'Discord relay API is ready.')
    } catch (error) {
      return {
        ok: false,
        adapter: 'discord_relay_ready',
        mode: 'real',
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async getState(): Promise<Record<string, unknown>> {
    try {
      const response = await this.operatorClient.get('/api/operator/state')
      return isRecord(response.body)
        ? { ok: response.ok, status: response.status, ...response.body }
        : { ok: false, status: response.status, raw_text: response.text }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async bindRun(input: BindRunInput): Promise<BindingMetadata> {
    if (input.binding_kind === 'parallel_only') {
      return {
        binding_kind: 'parallel_only',
        cleanup_state: 'active',
      }
    }

    const response = await this.operatorClient.post('/api/operator/protocol-runner/bind-channel', {
      runInstanceId: input.run_instance_id,
      threadTitle: input.visible_thread_label ?? null,
      channelName: input.relay_channel_name ?? null,
      correlationId: `protocol-runner-${input.run_instance_id}`,
    })

    if (!response.ok || !isRelayBindResponse(response.body)) {
      throw new Error(statusMessage(response, `Relay bind-channel failed with HTTP ${response.status}.`))
    }

    return {
      binding_kind: 'serial_desktop',
      visible_thread_label: response.body.desktopThreadLabel ?? input.visible_thread_label,
      relay_channel_id: response.body.channelId,
      relay_channel_name: response.body.channelName,
      binding_id: response.body.bindingId,
      cleanup_state: 'active',
    }
  }

  async publish(input: RelayPublishInput): Promise<RelayPublishResult> {
    const response = await this.publishClient.post('/api/publish', {
      channelId: input.channel_id,
      bindingId: input.binding_id,
      text: input.text,
      source: input.source ?? 'protocol_runner',
      correlationId: input.correlation_id ?? null,
    })

    if (!response.ok || !isRecord(response.body)) {
      return {
        ok: false,
        channel_id: input.channel_id,
        message_ids: [],
        chunk_count: 0,
        message: statusMessage(response, `Relay publish failed with HTTP ${response.status}.`),
      }
    }

    return {
      ok: response.body.ok === true,
      channel_id: optionalString(response.body.channelId) ?? input.channel_id,
      message_ids: Array.isArray(response.body.messageIds)
        ? response.body.messageIds.filter((messageId): messageId is string => typeof messageId === 'string')
        : [],
      chunk_count: typeof response.body.chunkCount === 'number' ? response.body.chunkCount : 0,
      text_sha256: optionalString(response.body.textSha256) ?? undefined,
      message: response.body.ok === true ? undefined : statusMessage(response, 'Relay publish did not succeed.'),
    }
  }

  async closeRunBinding(input: CloseRunBindingInput): Promise<RelayCloseResult> {
    const response = await this.operatorClient.post('/api/operator/close-channel', {
      channelId: input.channel_id,
      force: input.force === true,
      correlationId: input.correlation_id ?? null,
    })

    if (!response.ok || !isRecord(response.body)) {
      return {
        ok: false,
        channel_id: input.channel_id,
        cleanup_state: 'cleanup_failed',
        message: statusMessage(response, `Relay cleanup failed with HTTP ${response.status}.`),
      }
    }

    return {
      ok: response.body.ok === true,
      channel_id: optionalString(response.body.channelId) ?? input.channel_id,
      cleanup_state: response.body.ok === true ? 'cleaned_up' : 'cleanup_failed',
      message: response.body.ok === true ? undefined : statusMessage(response, 'Relay cleanup did not succeed.'),
    }
  }
}

function isRelayBindResponse(value: unknown): value is RelayBindResponse {
  if (!isRecord(value) || value.ok !== true) {
    return false
  }

  return (
    typeof value.channelId === 'string' &&
    typeof value.channelName === 'string' &&
    typeof value.shortLabel === 'number' &&
    typeof value.bindingId === 'string' &&
    typeof value.status === 'string' &&
    typeof value.bindingNoteStatus === 'string' &&
    (typeof value.codexThreadId === 'string' || value.codexThreadId === null) &&
    (typeof value.desktopThreadLabel === 'string' || value.desktopThreadLabel === null) &&
    (typeof value.channelUrl === 'string' || value.channelUrl === null)
  )
}
