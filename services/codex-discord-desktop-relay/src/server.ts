import http from 'node:http'

import express, { type Express, type Request, type Response } from 'express'

import { constantTimeSecretEqual, readBearerToken } from './auth.js'
import type { CodexDiscordDesktopRelayConfig } from './config.js'
import type { DesktopAdapter } from './desktop-adapter.js'
import { createLogger } from './logger.js'
import { type DiscordPublisher, sha256Text } from './discord-publisher.js'
import type {
  CodexDiscordDesktopRelayService,
  OperatorCloseChannelRequest,
  OperatorCloseChannelResult,
  OperatorProtocolRunnerBindChannelRequest,
  OperatorRecoverPublishRequest,
  OperatorRecoverPublishResult,
  OperatorStartThreadRequest,
} from './relay-service.js'
import type { RelayStateStore } from './state-store.js'
import type { PublishRequest } from './types.js'

export interface CodexDiscordDesktopRelayServerContext {
  config: CodexDiscordDesktopRelayConfig
  desktop: DesktopAdapter
  publisher: DiscordPublisher
  relay?: CodexDiscordDesktopRelayService
  store: RelayStateStore
}

function requestAuthorized(request: Request, secret: string): boolean {
  return constantTimeSecretEqual(secret, readBearerToken(request.header('authorization')) ?? '')
}

function requestIp(request: Request): string {
  return request.ip || request.socket.remoteAddress || 'unknown'
}

function requestIsLoopback(request: Request): boolean {
  const candidates = [request.ip, request.socket.remoteAddress].filter((value): value is string => Boolean(value))
  return candidates.some((value) => {
    const normalized = value.toLowerCase()
    return normalized === '127.0.0.1' || normalized === '::1' || normalized === '::ffff:127.0.0.1' || normalized === 'localhost'
  })
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function createCodexDiscordDesktopRelayApp(context: CodexDiscordDesktopRelayServerContext): Express {
  const app = express()
  const logger = createLogger('codex_discord_desktop_relay_http')

  app.disable('x-powered-by')
  app.set('etag', false)
  app.use(express.json({ limit: '512kb' }))
  app.use((request, response, next) => {
    response.setHeader('Cache-Control', 'no-store, max-age=0')
    response.setHeader('Pragma', 'no-cache')
    response.setHeader('Expires', '0')
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

  function requireAuth(request: Request, response: Response): boolean {
    if (requestAuthorized(request, context.config.publishBearerToken)) {
      return true
    }

    logger.warn('auth.failure', { ip: requestIp(request), path: request.path })
    response.status(401).json({ ok: false, error: 'auth_required' })
    return false
  }

  function requireOperatorAuth(request: Request, response: Response): boolean {
    if (!context.config.operatorEnabled || !context.config.operatorBearerToken) {
      response.status(403).json({ ok: false, error: 'operator_disabled' })
      return false
    }

    if (!requestIsLoopback(request)) {
      logger.warn('operator.auth.failure', { ip: requestIp(request), path: request.path, reason: 'non_loopback' })
      response.status(403).json({ ok: false, error: 'operator_requires_loopback' })
      return false
    }

    if (requestAuthorized(request, context.config.operatorBearerToken)) {
      return true
    }

    logger.warn('operator.auth.failure', { ip: requestIp(request), path: request.path, reason: 'auth_required' })
    response.status(401).json({ ok: false, error: 'auth_required' })
    return false
  }

  app.get('/healthz', (_request, response) => {
    response.json({
      ok: true,
      service: 'codex-discord-desktop-relay',
      stateDir: context.config.stateDir,
      commandChannelId: context.config.discord.commandChannelId,
    })
  })

  app.get('/readyz', async (_request, response, next) => {
    try {
      const desktop = await context.desktop.getState()
      const ok = desktop.available
      response.status(ok ? 200 : 503).json({
        ok,
        service: 'codex-discord-desktop-relay',
        discord: {
          configured: true,
          guildId: context.config.discord.guildId,
          commandChannelId: context.config.discord.commandChannelId,
        },
        desktop,
      })
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/state', async (request, response, next) => {
    if (!requireAuth(request, response)) {
      return
    }

    try {
      response.json(await context.store.read())
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/poll', async (request, response, next) => {
    if (!requireAuth(request, response)) {
      return
    }
    if (!context.relay) {
      response.status(409).json({ ok: false, error: 'poller_unavailable' })
      return
    }

    try {
      response.json(await context.relay.pollOnce())
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/publish', async (request, response, next) => {
    if (!requireAuth(request, response)) {
      return
    }

    const body = (request.body ?? {}) as Partial<PublishRequest>
    if (!isNonEmptyString(body.channelId)) {
      response.status(400).json({ ok: false, error: 'channel_id_required' })
      return
    }
    if (!isNonEmptyString(body.bindingId)) {
      response.status(400).json({ ok: false, error: 'binding_id_required' })
      return
    }
    if (!isNonEmptyString(body.text)) {
      response.status(400).json({ ok: false, error: 'text_required' })
      return
    }

    const publishRequest: PublishRequest = {
      channelId: body.channelId.trim(),
      bindingId: body.bindingId.trim(),
      text: body.text,
      source: isNonEmptyString(body.source) ? body.source.trim() : undefined,
      correlationId: isNonEmptyString(body.correlationId) ? body.correlationId.trim() : undefined,
    }

    try {
      const state = await context.store.read()
      const mapping = state.channels[publishRequest.channelId]
      if (!mapping) {
        logger.warn('relay.publish.rejected', {
          channel_id: publishRequest.channelId,
          binding_id: publishRequest.bindingId,
          reason: 'binding_not_active',
          source: publishRequest.source ?? null,
          correlation_id: publishRequest.correlationId ?? null,
        })
        response.status(409).json({ ok: false, error: 'binding_not_active' })
        return
      }
      if (mapping.bindingId !== publishRequest.bindingId) {
        logger.warn('relay.publish.rejected', {
          channel_id: publishRequest.channelId,
          binding_id: publishRequest.bindingId,
          reason: 'binding_mismatch',
          source: publishRequest.source ?? null,
          correlation_id: publishRequest.correlationId ?? null,
        })
        response.status(409).json({ ok: false, error: 'binding_mismatch' })
        return
      }
      logger.info('relay.publish.received', {
        channel_id: publishRequest.channelId,
        binding_id: publishRequest.bindingId,
        text_length: publishRequest.text.length,
        text_sha256: sha256Text(publishRequest.text),
        source: publishRequest.source ?? null,
        correlation_id: publishRequest.correlationId ?? null,
      })
      const result = await context.publisher.publish(publishRequest)
      const publishedMapping = await context.store.markPublished(
        publishRequest.channelId,
        result.messageIds.at(-1) ?? '',
        publishRequest.bindingId,
      )
      if (!publishedMapping) {
        logger.warn('relay.publish.state_not_recorded', {
          channel_id: publishRequest.channelId,
          binding_id: publishRequest.bindingId,
          reason: 'binding_changed_after_publish',
          source: publishRequest.source ?? null,
          correlation_id: publishRequest.correlationId ?? null,
        })
      }
      logger.info('relay.publish.posted', {
        channel_id: result.channelId,
        binding_id: publishRequest.bindingId,
        chunk_count: result.chunkCount,
        message_count: result.messageIds.length,
        text_sha256: result.textSha256,
        source: publishRequest.source ?? null,
        correlation_id: publishRequest.correlationId ?? null,
      })
      response.status(201).json(result)
    } catch (error) {
      logger.error('relay.publish.failed', {
        channel_id: publishRequest.channelId,
        binding_id: publishRequest.bindingId,
        text_length: publishRequest.text.length,
        text_sha256: sha256Text(publishRequest.text),
        message: error instanceof Error ? error.message : String(error),
      })
      next(error)
    }
  })

  app.get('/api/operator/state', async (request, response, next) => {
    if (!requireOperatorAuth(request, response)) {
      return
    }

    try {
      response.json(await context.store.read())
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/operator/start-thread', async (request, response, next) => {
    if (!requireOperatorAuth(request, response)) {
      return
    }
    if (!context.relay) {
      response.status(409).json({ ok: false, error: 'operator_relay_unavailable' })
      return
    }

    const body = (request.body ?? {}) as Partial<OperatorStartThreadRequest>
    const operatorRequest: OperatorStartThreadRequest = {
      title: isNonEmptyString(body.title) ? body.title.trim() : undefined,
      prompt: isNonEmptyString(body.prompt) ? body.prompt : undefined,
      correlationId: isNonEmptyString(body.correlationId) ? body.correlationId.trim() : undefined,
    }

    try {
      const result = await context.relay.operatorStartThread(operatorRequest)
      response.status(201).json(result)
    } catch (error) {
      logger.error('relay.operator.start_thread.failed', {
        title_length: operatorRequest.title?.length ?? 0,
        prompt_length: operatorRequest.prompt?.length ?? 0,
        prompt_sha256: operatorRequest.prompt ? sha256Text(operatorRequest.prompt) : null,
        message: error instanceof Error ? error.message : String(error),
      })
      next(error)
    }
  })

  app.post('/api/operator/protocol-runner/bind-channel', async (request, response, next) => {
    if (!requireOperatorAuth(request, response)) {
      return
    }
    if (!context.relay) {
      response.status(409).json({ ok: false, error: 'operator_relay_unavailable' })
      return
    }

    const body = (request.body ?? {}) as Partial<OperatorProtocolRunnerBindChannelRequest>
    if (!isNonEmptyString(body.runInstanceId)) {
      response.status(400).json({ ok: false, error: 'run_instance_id_required' })
      return
    }
    if (!isNonEmptyString(body.threadTitle)) {
      response.status(400).json({ ok: false, error: 'thread_title_required' })
      return
    }

    const operatorRequest: OperatorProtocolRunnerBindChannelRequest = {
      runInstanceId: body.runInstanceId.trim(),
      threadId: isNonEmptyString(body.threadId) ? body.threadId.trim() : undefined,
      threadTitle: body.threadTitle.trim(),
      channelName: isNonEmptyString(body.channelName) ? body.channelName.trim() : undefined,
      correlationId: isNonEmptyString(body.correlationId) ? body.correlationId.trim() : undefined,
    }

    try {
      const result = await context.relay.operatorProtocolRunnerBindChannel(operatorRequest)
      response.status(201).json(result)
    } catch (error) {
      logger.error('relay.operator.protocol_runner.bind_channel.failed', {
        run_instance_id: operatorRequest.runInstanceId,
        thread_id: operatorRequest.threadId ?? null,
        thread_title: operatorRequest.threadTitle ?? null,
        channel_name: operatorRequest.channelName ?? null,
        message: error instanceof Error ? error.message : String(error),
      })
      next(error)
    }
  })

  app.post('/api/operator/close-channel', async (request, response, next) => {
    if (!requireOperatorAuth(request, response)) {
      return
    }
    if (!context.relay) {
      response.status(409).json({ ok: false, error: 'operator_relay_unavailable' })
      return
    }

    const body = (request.body ?? {}) as Partial<OperatorCloseChannelRequest>
    const shortLabel =
      typeof body.shortLabel === 'number' || typeof body.shortLabel === 'string' ? body.shortLabel : undefined
    const operatorRequest: OperatorCloseChannelRequest = {
      channelId: isNonEmptyString(body.channelId) ? body.channelId.trim() : undefined,
      shortLabel,
      desktopThreadLabel: isNonEmptyString(body.desktopThreadLabel) ? body.desktopThreadLabel.trim() : undefined,
      force: body.force === true,
      correlationId: isNonEmptyString(body.correlationId) ? body.correlationId.trim() : undefined,
    }

    try {
      const result = await context.relay.operatorCloseChannel(operatorRequest)
      response.status(operatorCloseStatus(result)).json(result)
    } catch (error) {
      logger.error('relay.operator.close_channel.failed', {
        channel_id: operatorRequest.channelId ?? null,
        short_label: operatorRequest.shortLabel ?? null,
        desktop_thread_label: operatorRequest.desktopThreadLabel ?? null,
        force: operatorRequest.force === true,
        message: error instanceof Error ? error.message : String(error),
      })
      next(error)
    }
  })

  app.post('/api/operator/recover-publish', async (request, response, next) => {
    if (!requireOperatorAuth(request, response)) {
      return
    }
    if (!context.relay) {
      response.status(409).json({ ok: false, error: 'operator_relay_unavailable' })
      return
    }

    const body = (request.body ?? {}) as Partial<OperatorRecoverPublishRequest>
    const shortLabel =
      typeof body.shortLabel === 'number' || typeof body.shortLabel === 'string' ? body.shortLabel : undefined
    const operatorRequest: OperatorRecoverPublishRequest = {
      channelId: isNonEmptyString(body.channelId) ? body.channelId.trim() : undefined,
      shortLabel,
      desktopThreadLabel: isNonEmptyString(body.desktopThreadLabel) ? body.desktopThreadLabel.trim() : undefined,
      correlationId: isNonEmptyString(body.correlationId) ? body.correlationId.trim() : undefined,
    }

    try {
      const result = await context.relay.operatorRecoverPublish(operatorRequest)
      response.status(operatorRecoverStatus(result)).json(result)
    } catch (error) {
      logger.error('relay.operator.recover_publish.failed', {
        channel_id: operatorRequest.channelId ?? null,
        short_label: operatorRequest.shortLabel ?? null,
        desktop_thread_label: operatorRequest.desktopThreadLabel ?? null,
        message: error instanceof Error ? error.message : String(error),
      })
      next(error)
    }
  })

  app.use((error: unknown, _request: Request, response: Response, _next: () => void) => {
    void _next
    logger.error('http.unhandled_error', {
      message: error instanceof Error ? error.message : String(error),
    })
    response.status(500).json({ ok: false, error: 'internal_error' })
  })

  return app
}

function operatorCloseStatus(result: OperatorCloseChannelResult): number {
  if (result.ok) {
    return 200
  }

  switch (result.error) {
    case 'selector_required':
      return 400
    case 'mapping_not_found':
      return 404
    case 'ambiguous_selector':
    case 'waiting_for_codex':
      return 409
    case 'discord_delete_failed':
      return 502
  }
}

function operatorRecoverStatus(result: OperatorRecoverPublishResult): number {
  if (result.ok) {
    return 202
  }

  switch (result.error) {
    case 'selector_required':
      return 400
    case 'mapping_not_found':
      return 404
    case 'ambiguous_selector':
    case 'not_waiting_for_codex':
    case 'missing_desktop_thread_label':
    case 'desktop_unavailable':
    case 'desktop_thread_not_found':
    case 'desktop_thread_ambiguous':
    case 'desktop_thread_not_idle':
    case 'desktop_submit_refused':
      return 409
  }
}

export async function startCodexDiscordDesktopRelayServer(context: CodexDiscordDesktopRelayServerContext) {
  const app = createCodexDiscordDesktopRelayApp(context)
  return new Promise<http.Server>((resolve) => {
    const server = app.listen(context.config.port, context.config.host, () => resolve(server))
  })
}
