import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

import { ProtocolRunnerError } from './controller.js'

export type ProtocolRunnerSecurity =
  | { mode: 'test' }
  | {
      mode: 'token'
      controlToken: string
      allowedHost: string
      allowedOrigin: string
    }

export function requireControlToken(value: string | undefined): string {
  const token = value?.trim() ?? ''
  if (!/^[\x21-\x7e]{32,1024}$/.test(token)) {
    throw new Error('PROTOCOL_RUNNER_CONTROL_TOKEN must contain 32 to 1024 printable non-space ASCII characters. Start through scripts/run.mjs to create local credentials.')
  }
  return token
}

export function validateSecurityConfiguration(security: ProtocolRunnerSecurity): void {
  if (!security || (security.mode !== 'test' && security.mode !== 'token')) {
    throw new Error('An explicit Protocol Runner security configuration is required.')
  }
  if (security.mode === 'test') return
  requireControlToken(security.controlToken)
  const origin = new URL(security.allowedOrigin)
  if (
    origin.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) ||
    origin.origin !== security.allowedOrigin ||
    origin.host !== security.allowedHost
  ) {
    throw new Error('Protocol Runner security must name one exact loopback Host and Origin.')
  }
}

/** Returns false only for the deliberately minimal, unauthenticated health response. */
export function authorizeControlRequest(request: IncomingMessage, security: ProtocolRunnerSecurity): boolean {
  if (security.mode === 'test') return true
  const countHeader = (name: string) => request.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === name).length
  if (countHeader('host') !== 1 || request.headers.host?.toLowerCase() !== security.allowedHost) {
    throw new ProtocolRunnerError('control.host_rejected', 'Unexpected Host header.', 403)
  }
  if (countHeader('origin') > 1 || (request.headers.origin !== undefined && request.headers.origin !== security.allowedOrigin)) {
    throw new ProtocolRunnerError('control.origin_rejected', 'Unexpected Origin header.', 403)
  }
  const authorization = request.headers.authorization
  if (authorization === undefined && request.method === 'GET' && request.url === '/health') return false
  const expected = Buffer.from(`Bearer ${security.controlToken}`, 'utf8')
  const supplied = Buffer.from(authorization ?? '', 'utf8')
  if (countHeader('authorization') !== 1 || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new ProtocolRunnerError('control.unauthorized', 'A valid local control token is required.', 401)
  }
  return true
}
