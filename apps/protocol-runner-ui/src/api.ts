import type {
  ApiHealth,
  DesktopOperatorGateState,
  EvidenceKind,
  GlobalDiagnostics,
  ParallelGroupState,
  RunDiagnostics,
  RunListItem,
  RunView,
  RunnerEvent,
  RunnerManualAction,
  ValidationResult,
} from './types'

interface RunEnvelope {
  ok: boolean
  run: RunView
}

interface RunsEnvelope {
  ok: boolean
  runs: RunListItem[]
}

interface DiagnosticsEnvelope {
  ok: boolean
  diagnostics: RunDiagnostics
}

interface EventsEnvelope {
  ok: boolean
  events: RunnerEvent[]
}

interface ValidationEnvelope {
  ok: boolean
  validation: ValidationResult
}

interface DesktopOperatorGateEnvelope {
  ok: boolean
  gate: DesktopOperatorGateState
}

interface ParallelGroupEnvelope {
  ok: boolean
  group: ParallelGroupState
}

type JsonBody = Record<string, unknown>

function endpoint(path: string): string {
  // The local server proxy adds the control token; it is never browser configuration.
  return `/runner-api${path}`
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text()
  const parsed = text.length > 0 ? (JSON.parse(text) as unknown) : {}

  if (!response.ok) {
    const error = parsed as { error?: { message?: string; code?: string } }
    const message = error.error?.message ?? `Request failed with HTTP ${response.status}.`
    throw new Error(message)
  }

  return parsed as T
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(endpoint(path), {
    ...init,
    redirect: 'error',
    credentials: 'omit',
    headers: {
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...init.headers,
    },
  })
  return readJsonResponse<T>(response)
}

export async function getHealth(): Promise<ApiHealth> {
  return requestJson<ApiHealth>('/health')
}

export async function getGlobalDiagnostics(): Promise<GlobalDiagnostics> {
  return requestJson<GlobalDiagnostics>('/api/diagnostics')
}

export async function listRuns(): Promise<RunListItem[]> {
  const result = await requestJson<RunsEnvelope>('/api/runs')
  return result.runs
}

export async function getRun(runInstanceId: string): Promise<RunView> {
  const result = await requestJson<RunEnvelope>(`/api/runs/${encodeURIComponent(runInstanceId)}`)
  return result.run
}

export async function getRunDiagnostics(runInstanceId: string): Promise<RunDiagnostics> {
  const result = await requestJson<DiagnosticsEnvelope>(`/api/runs/${encodeURIComponent(runInstanceId)}/diagnostics`)
  return result.diagnostics
}

export async function getRunEvents(runInstanceId: string, limit = 20): Promise<RunnerEvent[]> {
  const result = await requestJson<EventsEnvelope>(
    `/api/runs/${encodeURIComponent(runInstanceId)}/events?limit=${encodeURIComponent(String(limit))}`,
  )
  return result.events
}

export async function validateRun(runInstanceId: string): Promise<ValidationResult> {
  const result = await requestJson<ValidationEnvelope>(`/api/runs/${encodeURIComponent(runInstanceId)}/validate`, {
    method: 'POST',
  })
  return result.validation
}

export async function getDesktopOperatorGate(): Promise<DesktopOperatorGateState> {
  const result = await requestJson<DesktopOperatorGateEnvelope>('/api/desktop-operator-gate')
  return result.gate
}

export async function waitDesktopOperatorGate(): Promise<DesktopOperatorGateState> {
  const result = await requestJson<DesktopOperatorGateEnvelope>('/api/desktop-operator-gate/wait', {
    method: 'POST',
  })
  return result.gate
}

export async function allowDesktopOperatorGateNow(): Promise<DesktopOperatorGateState> {
  const result = await requestJson<DesktopOperatorGateEnvelope>('/api/desktop-operator-gate/allow-now', {
    method: 'POST',
  })
  return result.gate
}

export async function postRunAction(
  runInstanceId: string,
  action: Exclude<RunnerManualAction, 'validate' | 'bind-thread' | 'accept-return' | 'refresh'>,
  body?: JsonBody,
): Promise<unknown> {
  return requestJson<unknown>(`/api/runs/${encodeURIComponent(runInstanceId)}/${action}`, {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

export async function preflightParallelGroup(runInstanceId: string, groupId: string): Promise<unknown> {
  return requestJson<unknown>(
    `/api/runs/${encodeURIComponent(runInstanceId)}/parallel-groups/${encodeURIComponent(groupId)}/preflight`,
    {
      method: 'POST',
    },
  )
}

export async function controlParallelGroup(
  runInstanceId: string,
  groupId: string,
  action: 'pause' | 'stop',
): Promise<ParallelGroupState> {
  const result = await requestJson<ParallelGroupEnvelope>(
    `/api/runs/${encodeURIComponent(runInstanceId)}/parallel-groups/${encodeURIComponent(groupId)}/${action}`,
    {
      method: 'POST',
    },
  )
  return result.group
}

export async function retryParallelItem(runInstanceId: string, groupId: string, itemId: string): Promise<unknown> {
  return requestJson<unknown>(
    `/api/runs/${encodeURIComponent(runInstanceId)}/parallel-groups/${encodeURIComponent(groupId)}/items/${encodeURIComponent(
      itemId,
    )}/retry`,
    {
      method: 'POST',
      body: JSON.stringify({
        requested_by: 'protocol-runner-ui',
        reason: 'Manual retry requested from Protocol Runner dashboard.',
      }),
    },
  )
}

export async function cancelParallelAttempt(
  runInstanceId: string,
  groupId: string,
  attemptId: string,
  leaseId: string,
): Promise<unknown> {
  return requestJson<unknown>(
    `/api/runs/${encodeURIComponent(runInstanceId)}/parallel-groups/${encodeURIComponent(
      groupId,
    )}/attempts/${encodeURIComponent(attemptId)}/cancel`,
    {
      method: 'POST',
      body: JSON.stringify({
        lease_id: leaseId,
        reason: 'Manual cancel requested from Protocol Runner dashboard.',
      }),
    },
  )
}

export async function readRunFile(runInstanceId: string, fileKind: EvidenceKind, fileName: string): Promise<string> {
  const response = await fetch(
    endpoint(
      `/api/runs/${encodeURIComponent(runInstanceId)}/files/${encodeURIComponent(fileKind)}/${encodeURIComponent(
        fileName,
      )}`,
    ),
    { redirect: 'error', credentials: 'omit' },
  )
  if (!response.ok) {
    throw new Error(`Evidence read failed with HTTP ${response.status}.`)
  }

  return response.text()
}

export function basenameFromEvidencePath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}
