import { createServer } from 'node:http'

import { HttpProtocolRunnerApiClient } from './client.js'
import { readProtocolRunnerDriverConfig } from './config.js'
import { ProtocolRunnerDriver, runDriverLoop } from './driver.js'

const config = readProtocolRunnerDriverConfig()
const once = process.argv.includes('--once')
const startedAt = new Date().toISOString()
let tickCount = 0

const driver = new ProtocolRunnerDriver({
  client: new HttpProtocolRunnerApiClient({
    baseUrl: config.apiBaseUrl,
    controlToken: config.controlToken,
    timeoutMs: config.apiTimeoutMs,
  }),
  onDecision: (decision) => {
    tickCount += 1
    process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), service: 'protocol-runner-driver', decision })}\n`)
  },
})

if (once) {
  await driver.tick()
} else {
  const abortController = new AbortController()
  const healthServer = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${config.healthHost}`)
    if (request.method === 'GET' && url.pathname === '/healthz') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          ok: true,
          service: 'protocol-runner-driver',
          started_at: startedAt,
          tick_count: tickCount,
        }),
      )
      return
    }

    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: false, error: 'not_found' }))
  })

  healthServer.listen(config.healthPort, config.healthHost, () => {
    process.stdout.write(
      `${JSON.stringify({
        ts: new Date().toISOString(),
        service: 'protocol-runner-driver',
        event: 'health_listening',
        host: config.healthHost,
        port: config.healthPort,
      })}\n`,
    )
  })

  const stop = () => {
    abortController.abort()
    healthServer.close()
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  process.stdout.write(
    `protocol-runner-driver polling ${config.apiBaseUrl} every ${config.pollIntervalMs}ms\n`,
  )
  await runDriverLoop({
    driver,
    pollIntervalMs: config.pollIntervalMs,
    signal: abortController.signal,
  })
}
