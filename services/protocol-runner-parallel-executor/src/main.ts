import { createServer } from 'node:http'

import { HttpProtocolRunnerParallelApiClient, readControlToken } from './client.js'
import { readProtocolRunnerParallelExecutorConfig } from './config.js'
import { ProtocolRunnerParallelExecutor, runParallelExecutorLoop } from './executor.js'
import { CodexExecWorkerLauncher, FakeParallelWorkerLauncher } from './launcher.js'
import { resolveWorkerRuntimeProfile } from './runtime-profile.js'

// Register before startup I/O so an immediate parent shutdown cannot be lost.
let shutdownRequested = false
let shutdownHandler: (() => void) | undefined
const requestShutdown = () => {
  shutdownRequested = true
  shutdownHandler?.()
}
const onMessage = (message: unknown) => {
  if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'shutdown') requestShutdown()
}
process.on('message', onMessage)
process.once('disconnect', requestShutdown)
process.once('SIGINT', requestShutdown)
process.once('SIGTERM', requestShutdown)

const config = readProtocolRunnerParallelExecutorConfig()
const controlToken = await readControlToken()
const workerRuntimeProfile = await resolveWorkerRuntimeProfile(config.workerRuntimeProfile, {
  workspace_root: config.workspaceRoot, launcher_mode: config.launcherMode,
})
const once = process.argv.includes('--once')
const drain = process.argv.includes('--drain')
const startedAt = new Date().toISOString()
let tickCount = 0

const executor = new ProtocolRunnerParallelExecutor({
  client: new HttpProtocolRunnerParallelApiClient({
    baseUrl: config.apiBaseUrl,
    timeoutMs: config.apiTimeoutMs,
    controlToken,
  }),
  launcher:
    config.launcherMode === 'codex_exec'
      ? new CodexExecWorkerLauncher({
          executor_id: config.executorId,
          workspace_root: config.workspaceRoot,
          codex_command: config.codexCommand,
          codex_base_args: ['exec'],
          ...(config.codexModel !== undefined ? { model: config.codexModel } : {}),
          ...(config.codexProfile !== undefined ? { profile: config.codexProfile } : {}),
          ...(config.codexSandbox !== undefined ? { sandbox: config.codexSandbox } : {}),
          bypass_approvals_and_sandbox: config.codexBypassApprovalsAndSandbox,
          ...(config.hardTimeoutMs !== undefined ? { hard_timeout_ms: config.hardTimeoutMs } : {}),
          worker_runtime_profile: workerRuntimeProfile,
        })
      : new FakeParallelWorkerLauncher({
          executor_id: config.executorId,
          workspace_root: config.workspaceRoot,
        }),
  executor_id: config.executorId,
  capacity: config.capacity,
  launch_batch_size: config.launchBatchSize,
  launch_batch_interval_ms: config.launchBatchIntervalMs,
  lease_ttl_ms: config.leaseTtlMs,
  heartbeat_interval_ms: config.heartbeatIntervalMs,
  long_running_after_ms: config.longRunningAfterMs,
  possibly_stalled_after_ms: config.possiblyStalledAfterMs,
  worker_runtime_profile: workerRuntimeProfile,
  onDecision: (decision) => {
    tickCount += 1
    process.stdout.write(
      `${JSON.stringify({ ts: new Date().toISOString(), service: 'protocol-runner-parallel-executor', decision })}\n`,
    )
  },
})

shutdownHandler = () => executor.requestShutdown()
if (shutdownRequested) shutdownHandler()

if (once) {
  await executor.tick()
} else if (drain) {
  await executor.drain({ maxTicks: 100 })
} else {
  const abortController = new AbortController()
  const healthServer = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${config.healthHost}`)
    if (request.method === 'GET' && url.pathname === '/healthz') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          ok: true,
          service: 'protocol-runner-parallel-executor',
          mode: config.launcherMode,
          api_base_url: config.apiBaseUrl,
          executor_id: config.executorId,
          capacity: config.capacity,
          launch_batch_size: config.launchBatchSize,
          launch_batch_interval_ms: config.launchBatchIntervalMs,
          lease_ttl_ms: config.leaseTtlMs,
          heartbeat_interval_ms: config.heartbeatIntervalMs,
          started_at: startedAt,
          tick_count: tickCount,
        }),
      )
      return
    }

    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: false, error: 'not_found' }))
  })

  if (!shutdownRequested) healthServer.listen(config.healthPort, config.healthHost, () => {
    process.stdout.write(
      `${JSON.stringify({
        ts: new Date().toISOString(),
        service: 'protocol-runner-parallel-executor',
        event: 'health_listening',
        host: config.healthHost,
        port: config.healthPort,
        mode: config.launcherMode,
      })}\n`,
    )
  })

  const stop = () => {
    if (abortController.signal.aborted) return
    executor.requestShutdown()
    abortController.abort()
    healthServer.close()
  }
  shutdownHandler = stop
  if (shutdownRequested) stop()

  process.stdout.write(
    `protocol-runner-parallel-executor polling ${config.apiBaseUrl} every ${config.pollIntervalMs}ms in ${config.launcherMode} mode\n`,
  )
  await runParallelExecutorLoop({
    executor,
    pollIntervalMs: config.pollIntervalMs,
    signal: abortController.signal,
  })
}
process.off('message', onMessage)
process.off('disconnect', requestShutdown)
process.off('SIGINT', requestShutdown)
process.off('SIGTERM', requestShutdown)
if (process.connected) process.disconnect()
