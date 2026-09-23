import http, { type IncomingMessage, type RequestListener, type ServerResponse } from 'node:http'
import { URL } from 'node:url'
import { authorizeControlRequest, validateSecurityConfiguration, type ProtocolRunnerSecurity } from './control-auth.js'

import {
  ProtocolRunnerController,
  ProtocolRunnerError,
  controllerErrorToHttp,
  type BindRunRequest,
  type CloseRunRequest,
  type CreateRunRequest,
  type ParallelAttemptResultRequest,
  type ParallelCancelRequest,
  type ParallelGroupControlRequest,
  type ParallelHeartbeatRequest,
  type ParallelLeaseRequest,
  type ParallelRecoverStaleRequest,
  type ParallelRetryRequest,
  type ReturnRunRequest,
  type SetAutomationRequest,
  type StepStartReportRequest,
} from './controller.js'

export interface ProtocolRunnerServerOptions {
  controller: ProtocolRunnerController
  security: ProtocolRunnerSecurity
}

export function createProtocolRunnerRequestHandler(options: ProtocolRunnerServerOptions): RequestListener {
  const { controller, security } = options
  validateSecurityConfiguration(security)

  return async (request, response) => {
    try {
      response.setHeader('cache-control', 'no-store')
      response.setHeader('x-content-type-options', 'nosniff')
      if (!authorizeControlRequest(request, security)) {
        sendJson(response, 200, { ok: true, service: 'protocol-runner-api' })
        return
      }
      await routeRequest(controller, request, response)
    } catch (error) {
      const converted = controllerErrorToHttp(error)
      sendJson(response, converted.status, converted.body)
    }
  }
}

export function createProtocolRunnerServer(options: ProtocolRunnerServerOptions): http.Server {
  return http.createServer(createProtocolRunnerRequestHandler(options))
}

async function routeRequest(
  controller: ProtocolRunnerController,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const method = request.method ?? 'GET'
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  const segments = url.pathname
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => decodeURIComponent(segment))

  if (method === 'GET' && segments.length === 1 && segments[0] === 'health') {
    sendJson(response, 200, await controller.health())
    return
  }

  if (segments[0] !== 'api') {
    throw new ProtocolRunnerError('route.not_found', `No route for ${method} ${url.pathname}.`, 404)
  }

  if (method === 'GET' && segments.length === 2 && segments[1] === 'diagnostics') {
    sendJson(response, 200, await controller.diagnostics())
    return
  }

  if (segments.length >= 2 && segments[1] === 'desktop-operator-gate') {
    if (method === 'GET' && segments.length === 2) {
      sendJson(response, 200, await controller.desktopOperatorGate())
      return
    }
    if (method === 'POST' && segments.length === 3 && segments[2] === 'wait') {
      sendJson(response, 200, await controller.desktopOperatorGateWait())
      return
    }
    if (method === 'POST' && segments.length === 3 && segments[2] === 'allow-now') {
      sendJson(response, 200, await controller.desktopOperatorGateAllowNow())
      return
    }
  }

  if (segments.length === 2 && segments[1] === 'runs') {
    if (method === 'GET') {
      sendJson(response, 200, { ok: true, ...(await controller.listRuns()) })
      return
    }

    if (method === 'POST') {
      const body = (await readJsonBody(request)) as CreateRunRequest
      sendJson(response, 201, { ok: true, run: await controller.createRun(body) })
      return
    }
  }

  if (segments.length < 3 || segments[1] !== 'runs') {
    throw new ProtocolRunnerError('route.not_found', `No route for ${method} ${url.pathname}.`, 404)
  }

  const run_instance_id = segments[2]
  if (method === 'GET' && segments.length === 3) {
    sendJson(response, 200, { ok: true, run: await controller.getRun(run_instance_id) })
    return
  }

  const action = segments[3]
  if (method === 'POST' && segments.length === 4) {
    await routeRunPost(controller, run_instance_id, action, request, response)
    return
  }

  if (method === 'GET' && segments.length === 4 && action === 'events') {
    const limitParam = url.searchParams.get('limit')
    const limit = limitParam === null ? undefined : Number.parseInt(limitParam, 10)
    sendJson(response, 200, { ok: true, ...(await controller.getEvents(run_instance_id, limit)) })
    return
  }

  if (method === 'GET' && segments.length === 4 && action === 'diagnostics') {
    sendJson(response, 200, { ok: true, diagnostics: await controller.getRunDiagnostics(run_instance_id) })
    return
  }

  if (
    segments.length >= 5 &&
    action === 'parallel-groups' &&
    (method === 'GET' || method === 'POST')
  ) {
    await routeParallelGroup(controller, run_instance_id, segments.slice(4), method, request, response)
    return
  }

  if (method === 'GET' && segments.length === 6 && action === 'files') {
    const file = await controller.readRunFile(run_instance_id, segments[4], segments[5])
    sendText(response, 200, file.content_type, file.text)
    return
  }

  throw new ProtocolRunnerError('route.not_found', `No route for ${method} ${url.pathname}.`, 404)
}

async function routeParallelGroup(
  controller: ProtocolRunnerController,
  run_instance_id: string,
  segments: string[],
  method: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const group_id = segments[0]
  if (method === 'GET' && segments.length === 1) {
    sendJson(response, 200, { ok: true, ...(await controller.parallelEnvelope(run_instance_id, group_id)) })
    return
  }

  if (method === 'POST' && segments.length === 2 && segments[1] === 'preflight') {
    sendJson(response, 200, { ok: true, ...(await controller.preflightParallelGroup(run_instance_id, group_id)) })
    return
  }

  if (method === 'POST' && segments.length === 2 && segments[1] === 'leases') {
    const body = (await readJsonBody(request)) as ParallelLeaseRequest
    sendJson(response, 200, { ok: true, ...(await controller.grantParallelLeases(run_instance_id, group_id, body)) })
    return
  }

  if (method === 'POST' && segments.length === 3 && segments[1] === 'leases' && segments[2] === 'recover-stale') {
    const body = (await readJsonBody(request)) as ParallelRecoverStaleRequest
    sendJson(response, 200, {
      ok: true,
      ...(await controller.recoverStaleParallelLeases(run_instance_id, group_id, body)),
    })
    return
  }

  if (method === 'POST' && segments.length === 4 && segments[1] === 'leases' && segments[3] === 'heartbeat') {
    const body = (await readJsonBody(request)) as ParallelHeartbeatRequest
    sendJson(response, 200, {
      ok: true,
      ...(await controller.heartbeatParallelLease(run_instance_id, group_id, segments[2], body)),
    })
    return
  }

  if (method === 'POST' && segments.length === 4 && segments[1] === 'attempts' && segments[3] === 'result') {
    const body = (await readJsonBody(request)) as ParallelAttemptResultRequest
    sendJson(response, 200, {
      ok: true,
      ...(await controller.acceptParallelAttemptResult(run_instance_id, group_id, segments[2], body)),
    })
    return
  }

  if (method === 'POST' && segments.length === 4 && segments[1] === 'items' && segments[3] === 'retry') {
    const body = (await readJsonBody(request)) as ParallelRetryRequest
    sendJson(response, 200, {
      ok: true,
      ...(await controller.retryParallelItem(run_instance_id, group_id, segments[2], body)),
    })
    return
  }

  if (method === 'POST' && segments.length === 2 && (segments[1] === 'pause' || segments[1] === 'stop')) {
    const body = (await readJsonBody(request)) as ParallelGroupControlRequest
    sendJson(response, 200, {
      ok: true,
      ...(await controller.controlParallelGroup(run_instance_id, group_id, segments[1], body)),
    })
    return
  }

  if (method === 'POST' && segments.length === 4 && segments[1] === 'attempts' && segments[3] === 'cancel') {
    const body = (await readJsonBody(request)) as ParallelCancelRequest
    sendJson(response, 200, {
      ok: true,
      ...(await controller.cancelParallelAttempt(run_instance_id, group_id, segments[2], body)),
    })
    return
  }

  throw new ProtocolRunnerError('route.not_found', `No parallel group route for ${method}.`, 404)
}

async function routeRunPost(
  controller: ProtocolRunnerController,
  run_instance_id: string,
  action: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (action === 'validate') {
    sendJson(response, 200, { ok: true, validation: await controller.validateRun(run_instance_id) })
    return
  }

  if (action === 'bind') {
    const body = (await readJsonBody(request)) as BindRunRequest
    sendJson(response, 200, { ok: true, run: await controller.bindRun(run_instance_id, body) })
    return
  }

  if (action === 'automation') {
    const body = (await readJsonBody(request)) as SetAutomationRequest
    sendJson(response, 200, { ok: true, run: await controller.setAutomation(run_instance_id, body) })
    return
  }

  if (action === 'start') {
    sendJson(response, 200, { ok: true, ...(await controller.startRun(run_instance_id)) })
    return
  }

  if (action === 'pause') {
    sendJson(response, 200, { ok: true, run: await controller.pauseRun(run_instance_id) })
    return
  }

  if (action === 'resume') {
    sendJson(response, 200, { ok: true, ...(await controller.resumeRun(run_instance_id)) })
    return
  }

  if (action === 'retry-current') {
    sendJson(response, 200, { ok: true, ...(await controller.retryCurrent(run_instance_id)) })
    return
  }

  if (action === 'fail') {
    const body = await readJsonBody(request)
    const reason = typeof body.reason === 'string' ? body.reason : 'Manual fail requested.'
    sendJson(response, 200, { ok: true, run: await controller.failRun(run_instance_id, reason) })
    return
  }

  if (action === 'close') {
    const body = (await readJsonBody(request)) as CloseRunRequest
    sendJson(response, 200, { ok: true, closeout: await controller.closeRun(run_instance_id, body) })
    return
  }

  if (action === 'start-report') {
    const body = (await readJsonBody(request)) as StepStartReportRequest
    sendJson(response, 200, { ok: true, ...(await controller.acceptStartReport(run_instance_id, body)) })
    return
  }

  if (action === 'return') {
    const body = (await readJsonBody(request)) as ReturnRunRequest
    sendJson(response, 200, { ok: true, ...(await controller.acceptReturn(run_instance_id, body)) })
    return
  }

  throw new ProtocolRunnerError('route.not_found', `No run action route: ${action}.`, 404)
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 1024 * 1024) {
      throw new ProtocolRunnerError('request.body_too_large', 'Request body exceeds 1 MiB.', 413)
    }
    chunks.push(buffer)
  }

  if (chunks.length === 0) {
    return {}
  }

  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.trim().length === 0) {
    return {}
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new ProtocolRunnerError('request.invalid_json', `Invalid JSON request body: ${String(error)}`)
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ProtocolRunnerError('request.invalid_json', 'JSON request body must be an object.')
  }

  return parsed as Record<string, unknown>
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body, null, 2)}\n`
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  })
  response.end(text)
}

function sendText(response: ServerResponse, status: number, content_type: string, text: string): void {
  response.writeHead(status, {
    'content-type': content_type,
    'content-length': Buffer.byteLength(text),
  })
  response.end(text)
}
