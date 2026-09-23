export interface DesktopThreadSummary {
  label: string
  group: 'pinned' | 'non_pinned' | 'unknown'
  visible: boolean
  turnState: 'idle' | 'working' | 'unknown'
  indicatorText: string | null
  indicatorReason: string | null
}

export interface DesktopAdapterState {
  available: boolean
  mode: 'stub' | 'api'
  windowTitle: string
  reason: string | null
}

export interface DesktopPromptResult {
  result: 'submitted' | 'refused' | 'unavailable'
  message: string | null
  desktopThreadLabel: string | null
}

export interface DesktopAdapter {
  getState(): Promise<DesktopAdapterState>
  listThreads(): Promise<DesktopThreadSummary[]>
  submitPrompt(args: { desktopThreadLabel: string; text: string }): Promise<DesktopPromptResult>
  createThread(args: { text: string }): Promise<DesktopPromptResult>
  bindCurrent(): Promise<DesktopPromptResult>
}

export interface CodexDesktopApiAdapterOptions {
  baseUrl: string
  bearerToken: string
  requestTimeoutMs: number
  actionMode: 'auto' | 'focus'
  windowTitle: string
}

interface HttpResponse {
  ok: boolean
  status: number
  body: unknown
  text: string
}

interface DesktopVisibleThreadRow {
  label: string
  turnState: 'idle' | 'working' | 'unknown'
  indicatorText: string | null
  indicatorReason: string | null
  isThreadRow: boolean
}

export class SafeStubDesktopAdapter implements DesktopAdapter {
  constructor(private readonly windowTitle: string) {}

  async getState(): Promise<DesktopAdapterState> {
    return {
      available: false,
      mode: 'stub',
      windowTitle: this.windowTitle,
      reason: 'desktop_api_adapter_not_enabled',
    }
  }

  async listThreads(): Promise<DesktopThreadSummary[]> {
    return []
  }

  async submitPrompt(args: { desktopThreadLabel: string }): Promise<DesktopPromptResult> {
    return {
      result: 'refused',
      message: 'Desktop prompt injection is not enabled.',
      desktopThreadLabel: args.desktopThreadLabel,
    }
  }

  async createThread(): Promise<DesktopPromptResult> {
    return {
      result: 'refused',
      message: 'Desktop new-thread automation is not enabled.',
      desktopThreadLabel: null,
    }
  }

  async bindCurrent(): Promise<DesktopPromptResult> {
    return {
      result: 'refused',
      message: 'Desktop current-thread binding is not enabled.',
      desktopThreadLabel: null,
    }
  }
}

export class CodexDesktopApiAdapter implements DesktopAdapter {
  private readonly baseUrl: string

  constructor(private readonly options: CodexDesktopApiAdapterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
  }

  async getState(): Promise<DesktopAdapterState> {
    const response = await this.get('/api/codex-desktop/state')
    const body = isRecord(response.body) ? response.body : {}
    return {
      available: response.ok && body.result === 'applied' && body.windowFound === true,
      mode: 'api',
      windowTitle: this.options.windowTitle,
      reason: response.ok && body.result === 'applied' ? null : statusMessage(response, 'desktop_api_unavailable'),
    }
  }

  async listThreads(): Promise<DesktopThreadSummary[]> {
    const response = await this.get('/api/codex-desktop/state')
    if (!response.ok || !isRecord(response.body)) {
      return []
    }

    const rows = Array.isArray(response.body.visibleThreadRows)
      ? response.body.visibleThreadRows.map(normalizeVisibleThreadRow)
      : []
    const seen = new Set<string>()
    const threads: DesktopThreadSummary[] = []
    for (const row of rows) {
      if (!row || !row.isThreadRow || !row.label || seen.has(row.label)) {
        continue
      }
      seen.add(row.label)
      threads.push({
        label: row.label,
        group: 'unknown',
        visible: true,
        turnState: row.turnState,
        indicatorText: row.indicatorText,
        indicatorReason: row.indicatorReason,
      })
    }

    return threads
  }

  async submitPrompt(args: { desktopThreadLabel: string; text: string }): Promise<DesktopPromptResult> {
    const response = await this.post('/api/codex-desktop/prompt', {
      threadTitle: args.desktopThreadLabel,
      text: args.text,
      mode: this.options.actionMode,
      caller: 'codex-discord-desktop-relay',
    })
    const body = isRecord(response.body) ? response.body : {}
    const selectedLabel = normalizeSelectedThreadLabel(optionalString(body.selectedSidebarThreadTitle))
    const delivered =
      response.ok &&
      body.result === 'applied' &&
      body.selectionConfirmed === true

    return {
      result: delivered ? 'submitted' : mapApiResult(response, body),
      message: delivered ? null : statusMessage(response, 'Desktop API did not confirm exact sidebar selection.'),
      desktopThreadLabel: selectedLabel ?? args.desktopThreadLabel,
    }
  }

  async createThread(args: { text: string }): Promise<DesktopPromptResult> {
    const response = await this.post('/api/codex-desktop/create-thread', {
      text: args.text,
      mode: this.options.actionMode,
      caller: 'codex-discord-desktop-relay',
    })
    const body = isRecord(response.body) ? response.body : {}
    const selectedLabel = normalizeSelectedThreadLabel(optionalString(body.selectedSidebarThreadTitle))
    const delivered = response.ok && body.result === 'applied'

    return {
      result: delivered ? 'submitted' : mapApiResult(response, body),
      message: delivered ? null : statusMessage(response, 'Desktop API did not confirm create-thread submission.'),
      desktopThreadLabel: selectedLabel,
    }
  }

  async bindCurrent(): Promise<DesktopPromptResult> {
    const response = await this.get('/api/codex-desktop/readback')
    const body = isRecord(response.body) ? response.body : {}
    const selectedLabel = normalizeSelectedThreadLabel(optionalString(body.selectedSidebarThreadTitle))
    if (response.ok && body.result === 'applied' && selectedLabel) {
      return {
        result: 'submitted',
        message: null,
        desktopThreadLabel: selectedLabel,
      }
    }

    return {
      result: mapApiResult(response, body),
      message: statusMessage(response, 'Codex desktop current thread label could not be read safely.'),
      desktopThreadLabel: selectedLabel,
    }
  }

  private async get(pathname: string): Promise<HttpResponse> {
    return this.request('GET', pathname)
  }

  private async post(pathname: string, body: Record<string, unknown>): Promise<HttpResponse> {
    return this.request('POST', pathname, body)
  }

  private async request(method: string, pathname: string, body?: Record<string, unknown>): Promise<HttpResponse> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.options.requestTimeoutMs)
    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${this.options.bearerToken}`,
    }
    if (body !== undefined) {
      headers['content-type'] = 'application/json'
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
        ok: response.ok,
        status: response.status,
        body: parsed,
        text,
      }
    } catch (error) {
      return {
        ok: false,
        status: 0,
        body: {
          result: 'unavailable',
          message: error instanceof Error ? error.message : String(error),
        },
        text: '',
      }
    } finally {
      clearTimeout(timeout)
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function normalizeVisibleThreadRow(value: unknown): DesktopVisibleThreadRow | null {
  if (!isRecord(value)) {
    return null
  }

  const label = optionalString(value.label)
  if (!label || /^show (more|less)$/i.test(label)) {
    return null
  }

  return {
    label,
    turnState:
      value.turnState === 'idle' || value.turnState === 'working' || value.turnState === 'unknown'
        ? value.turnState
        : 'unknown',
    indicatorText: optionalString(value.indicatorText),
    indicatorReason: optionalString(value.indicatorReason),
    isThreadRow: value.isThreadRow !== false,
  }
}

function normalizeSelectedThreadLabel(value: string | null): string | null {
  const normalized = value?.replace(/\s+/g, ' ').trim() ?? ''
  if (
    !normalized ||
    /^show (more|less)$/i.test(normalized) ||
    /^(new chat|new thread|chats|projects|pinned|settings)$/i.test(normalized)
  ) {
    return null
  }

  return normalized
}

function mapApiResult(
  response: HttpResponse,
  body: Record<string, unknown>,
): DesktopPromptResult['result'] {
  if (!response.ok) {
    return 'unavailable'
  }
  if (body.result === 'unavailable' || body.result === 'focus_required') {
    return 'unavailable'
  }
  return 'refused'
}

function statusMessage(response: HttpResponse, fallback: string): string {
  if (isRecord(response.body) && typeof response.body.message === 'string' && response.body.message.trim()) {
    return response.body.message.trim()
  }
  if (isRecord(response.body) && typeof response.body.error === 'string' && response.body.error.trim()) {
    return response.body.error.trim()
  }
  if (response.text.trim()) {
    return response.text.trim()
  }
  if (response.status) {
    return `HTTP ${response.status}`
  }
  return fallback
}
