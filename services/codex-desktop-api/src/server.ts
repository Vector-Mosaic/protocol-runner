import http from 'node:http'

import express, { type Express, type Request, type Response } from 'express'

import { constantTimeSecretEqual, readBearerToken } from './auth.js'
import type { CodexDesktopConfig } from './config.js'
import { createLogger } from './logger.js'
import { CodexDesktopServiceError, type CodexDesktopService } from './service.js'
import type { DesktopCreateRequest, DesktopPromptRequest, DesktopThreadRequest } from './types.js'

export function createCodexDesktopApp(service: CodexDesktopService, config: CodexDesktopConfig): Express {
  const logger = createLogger('codex_desktop_http')
  const app = express()

  app.disable('x-powered-by')
  app.set('etag', false)
  app.use(express.json({ limit: '128kb' }))
  app.use((request, response, next) => {
    if (request.path.startsWith('/api/') || request.path === '/healthz') {
      response.setHeader('Cache-Control', 'no-store, max-age=0')
      response.setHeader('Pragma', 'no-cache')
      response.setHeader('Expires', '0')
    }

    next()
  })
  app.use((request, response, next) => {
    const started = Date.now()
    response.on('finish', () => {
      logger.info('http.request', {
        method: request.method,
        path: request.path,
        status: response.statusCode,
        duration_ms: Date.now() - started,
      })
    })
    next()
  })

  function requireBearer(request: Request, response: Response): boolean {
    const provided = readBearerToken(request.headers.authorization)
    if (!provided || !constantTimeSecretEqual(config.bearerToken, provided)) {
      response.status(401).json({ error: 'auth_required' })
      return false
    }

    return true
  }

  app.get('/healthz', (_request, response) => {
    response.json({ ok: true })
  })

  app.get('/api/codex-desktop/state', async (request, response) => {
    if (!requireBearer(request, response)) {
      return
    }

    response.json(await service.state())
  })

  app.get('/api/codex-desktop/operator-gate', (request, response) => {
    if (!requireBearer(request, response)) {
      return
    }

    response.json({ ok: true, gate: service.operatorGateState() })
  })

  app.post('/api/codex-desktop/operator-gate/wait', (request, response) => {
    if (!requireBearer(request, response)) {
      return
    }

    response.json({ ok: true, gate: service.operatorGateWait() })
  })

  app.post('/api/codex-desktop/operator-gate/allow-now', (request, response) => {
    if (!requireBearer(request, response)) {
      return
    }

    response.json({ ok: true, gate: service.operatorGateAllowNow() })
  })

  app.post('/api/codex-desktop/select-thread', async (request, response) => {
    if (!requireBearer(request, response)) {
      return
    }

    response.json(await service.selectThread((request.body ?? {}) as DesktopThreadRequest))
  })

  app.post('/api/codex-desktop/prompt', async (request, response) => {
    if (!requireBearer(request, response)) {
      return
    }

    response.json(await service.promptThread((request.body ?? {}) as DesktopPromptRequest))
  })

  app.post('/api/codex-desktop/create-thread', async (request, response) => {
    if (!requireBearer(request, response)) {
      return
    }

    response.json(await service.createThread((request.body ?? {}) as DesktopCreateRequest))
  })

  app.get('/api/codex-desktop/readback', async (request, response) => {
    if (!requireBearer(request, response)) {
      return
    }

    const query = request.query as Record<string, string | string[] | undefined>
    const threadId = typeof query.threadId === 'string' ? query.threadId : null
    const threadTitle = typeof query.threadTitle === 'string' ? query.threadTitle : null
    response.json(await service.readback({ threadId, threadTitle }))
  })

  app.use((error: unknown, _request: Request, response: Response, _next: () => void) => {
    void _next
    if (error instanceof CodexDesktopServiceError) {
      response.status(error.statusCode).json({ error: error.errorCode, message: error.message })
      return
    }

    logger.error('http.unhandled_error', { message: error instanceof Error ? error.message : String(error) })
    response.status(500).json({ error: 'internal_error' })
  })

  return app
}

export async function startCodexDesktopServer(service: CodexDesktopService, config: CodexDesktopConfig) {
  const app = createCodexDesktopApp(service, config)
  return new Promise<http.Server>((resolve) => {
    const server = app.listen(config.port, config.host, () => resolve(server))
  })
}
