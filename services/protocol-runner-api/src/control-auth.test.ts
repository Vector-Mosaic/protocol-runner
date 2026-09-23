import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { it } from 'node:test'

import { readProtocolRunnerApiConfig } from './config.js'
import { type ProtocolRunnerSecurity } from './control-auth.js'
import { type ProtocolRunnerController } from './controller.js'
import { createProtocolRunnerServer } from './server.js'

const token = 'public-boundary-test-token-never-a-real-credential'
const security = {
  mode: 'token' as const,
  controlToken: token,
  allowedHost: '127.0.0.1:4831',
  allowedOrigin: 'http://127.0.0.1:4831',
}

it('requires production control credentials and explicit injected test mode', () => {
  assert.throws(() => readProtocolRunnerApiConfig({}), /PROTOCOL_RUNNER_CONTROL_TOKEN/)
  assert.throws(() => readProtocolRunnerApiConfig({ PROTOCOL_RUNNER_CONTROL_TOKEN: 'short' }), /PROTOCOL_RUNNER_CONTROL_TOKEN/)
  assert.throws(() => createProtocolRunnerServer({
    controller: {} as ProtocolRunnerController,
    security: undefined as unknown as ProtocolRunnerSecurity,
  }), /explicit Protocol Runner security/)
  const config = readProtocolRunnerApiConfig({ PROTOCOL_RUNNER_CONTROL_TOKEN: token })
  assert.deepEqual(config.security, security)
  assert.equal(config.notification.enabled, false)
})

it('protects reads and mutations before dispatch while exposing only minimal unauthenticated health', async () => {
  let dispatches = 0
  const controller = {
    health: async () => { dispatches += 1; return { ok: true, private_detail: 'authenticated' } },
    listRuns: async () => { dispatches += 1; return { runs: [] } },
  } as unknown as ProtocolRunnerController
  const server = createProtocolRunnerServer({ controller, security })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const request = (pathname: string, headers: Record<string, string | string[]> = {}, method = 'GET') =>
    new Promise<{ status: number; body: Record<string, unknown>; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      const outgoing = http.request({
        host: '127.0.0.1', port, path: pathname, method,
        headers: { host: security.allowedHost, ...headers },
      }, (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => resolve({
          status: response.statusCode ?? 0,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
          headers: response.headers,
        }))
      })
      outgoing.on('error', reject)
      outgoing.end()
    })
  try {
    const health = await request('/health')
    assert.equal(health.status, 200)
    assert.deepEqual(health.body, { ok: true, service: 'protocol-runner-api' })
    assert.equal(health.headers['cache-control'], 'no-store')
    assert.equal(dispatches, 0)
    assert.equal((await request('/api/runs')).status, 401)
    assert.equal((await request('/api/runs', {}, 'POST')).status, 401)
    assert.equal((await request('/api/runs', { authorization: 'Bearer wrong' })).status, 401)
    assert.equal((await request('/health', { authorization: 'Bearer wrong' })).status, 401)
    assert.equal((await request('/api/runs', { authorization: [`Bearer ${token}`, `Bearer ${token}`] })).status, 401)
    assert.equal((await request('/api/runs', { authorization: `Bearer ${token}`, host: 'attacker.example:4831' })).status, 403)
    assert.equal((await request('/health', { host: 'attacker.example:4831' })).status, 403)
    assert.equal((await request('/api/runs', { authorization: `Bearer ${token}`, origin: 'http://attacker.example' })).status, 403)
    assert.equal((await request('/api/runs', { authorization: `Bearer ${token}`, origin: 'null' })).status, 403)
    assert.equal(dispatches, 0)
    assert.equal((await request('/api/runs', { authorization: `Bearer ${token}` })).status, 200)
    const authenticated = await request('/health', { authorization: `Bearer ${token}`, origin: security.allowedOrigin })
    assert.equal(authenticated.status, 200)
    assert.equal(authenticated.body.private_detail, 'authenticated')
    assert.equal(authenticated.headers['access-control-allow-origin'], undefined)
    assert.equal(dispatches, 2)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})
