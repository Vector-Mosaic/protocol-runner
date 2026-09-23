import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes, randomInt } from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// A bounded Linux qualification of the public launcher and local HTTP boundary.
// Run only after building the standalone checkout; no real workers are selected.
if (process.platform !== 'linux') throw new Error('startup-check.mjs runs only on the Linux qualification host.')

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const started = Date.now()
const deadline = started + 60_000
const token = randomBytes(32).toString('hex')
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'protocol-runner-startup-check-'))
let launcher
let launcherExit
let exitResult
let ports = []
let output = ''
let closed = false

function remaining(maximum) {
  const milliseconds = Math.min(maximum, deadline - Date.now())
  if (milliseconds <= 0) throw new Error('Standalone startup check exceeded its 60-second deadline.')
  return milliseconds
}

async function within(promise, milliseconds, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out.`)), milliseconds) }),
    ])
  } finally { clearTimeout(timer) }
}

async function choosePorts() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const first = randomInt(20_000, 59_000)
    const reservations = []
    try {
      for (const port of [first, first + 1, first + 2, first + 3]) {
        const server = net.createServer()
        reservations.push(server)
        await new Promise((resolve, reject) => {
          server.once('error', reject)
          server.listen(port, '127.0.0.1', resolve)
        })
      }
      return [first, first + 1, first + 2, first + 3]
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error
    } finally {
      await Promise.all(reservations.map((server) => new Promise((resolve) => server.close(resolve))))
    }
  }
  throw new Error('Could not reserve four consecutive unused loopback ports.')
}

function request(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method: 'GET', headers,
      agent: false,
    }, (response) => {
      const chunks = []
      let bytes = 0
      response.on('data', (chunk) => {
        bytes += chunk.length
        if (bytes > 100_000) req.destroy(new Error('Unexpectedly large startup-check response.'))
        else chunks.push(chunk)
      })
      response.on('error', reject)
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    const timer = setTimeout(() => req.destroy(new Error('Local startup-check request timed out.')), remaining(1_000))
    req.once('close', () => clearTimeout(timer))
    req.once('error', reject)
    req.end()
  })
}

function listening(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', (error) => {
      socket.destroy()
      if (error.code === 'ECONNREFUSED') resolve(false)
      else reject(error)
    })
    socket.setTimeout(500, () => { socket.destroy(); reject(new Error('Loopback port-close observation timed out.')) })
  })
}

async function waitForPortsClosed(until) {
  while (Date.now() < until) {
    if ((await Promise.all(ports.map(listening))).every((value) => !value)) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

function killOwnedGroup(signal) {
  if (!launcher?.pid) return
  // detached:true creates a process group owned only by this check's launcher
  // and its children. Never discover or terminate another process by port/name.
  try { process.kill(-launcher.pid, signal) } catch (error) { if (error.code !== 'ESRCH') throw error }
}

try {
  ports = await choosePorts()
  const [apiPort, driverPort, executorPort, uiPort] = ports
  const uiOrigin = `http://127.0.0.1:${uiPort}`
  launcher = spawn(process.execPath, [path.join(root, 'scripts', 'run.mjs'), 'start', '--workspace', workspace], {
    cwd: root,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PROTOCOL_RUNNER_CONTROL_TOKEN: token,
      PROTOCOL_RUNNER_API_PORT: String(apiPort),
      PROTOCOL_RUNNER_UI_PORT: String(uiPort),
      PROTOCOL_RUNNER_PARALLEL_EXECUTOR_CAPACITY: '1',
      PROTOCOL_RUNNER_PARALLEL_EXECUTOR_LAUNCH_BATCH_SIZE: '1',
    },
  })
  const capture = (chunk) => { output = (output + chunk.toString('utf8').replaceAll(token, '[redacted]')).slice(-16_000) }
  launcher.stdout.on('data', capture)
  launcher.stderr.on('data', capture)
  launcherExit = new Promise((resolve, reject) => {
    launcher.once('error', reject)
    launcher.once('exit', (code, signal) => { exitResult = { code, signal }; resolve(exitResult) })
  })
  // Attach a rejection observer immediately while readiness probes are running.
  void launcherExit.catch(() => {})
  const readinessDeadline = started + 40_000
  let ready = false
  while (Date.now() < readinessDeadline && !ready) {
    if (exitResult) throw new Error(`Launcher exited before readiness (${exitResult.code ?? exitResult.signal}).`)
    try {
      const responses = await Promise.all([
        request(apiPort, '/health'), request(driverPort, '/healthz'),
        request(executorPort, '/healthz'), request(uiPort, '/'),
      ])
      ready = responses.every((response) => response.status === 200)
    } catch { /* the exact new child may still be starting */ }
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.ok(ready, 'All four services must become ready within 40 seconds.')
  const dashboard = await request(uiPort, '/')
  assert.equal(dashboard.status, 200)
  assert.match(dashboard.text, /id=["']root["']/)
  const runs = await request(uiPort, '/runner-api/api/runs', { origin: uiOrigin, 'sec-fetch-site': 'same-origin' })
  assert.equal(runs.status, 200, 'The dashboard proxy must authenticate its API request.')
  assert.deepEqual(JSON.parse(runs.text).runs, [], 'The isolated workspace must have no existing runs.')
  assert.equal((await request(apiPort, '/api/runs')).status, 401, 'Direct API reads require the control token.')
  for (const pathname of ['/', '/runner-api/api/runs']) {
    assert.equal((await request(uiPort, pathname, { origin: 'https://cross-site.invalid', 'sec-fetch-site': 'cross-site' })).status, 403)
  }
  assert.equal((await request(uiPort, '/', { host: 'untrusted.invalid' })).status, 403)
  assert.match(output, /SIMULATED; no model calls/)

  launcher.kill('SIGINT')
  const result = await within(launcherExit, remaining(10_000), 'Graceful launcher shutdown')
  assert.deepEqual(result, { code: 0, signal: null })
  closed = await waitForPortsClosed(Math.min(deadline - 2_000, Date.now() + 5_000))
  assert.ok(closed, 'API, driver, executor, and dashboard ports must close after SIGINT.')
  console.log(JSON.stringify({
    ok: true,
    check: 'standalone-startup',
    mode: 'simulated',
    assertions: ['dashboard-served', 'same-origin-proxy-authenticated', 'direct-api-refused', 'cross-site-refused', 'host-refused', 'sigint-exit', 'all-service-ports-closed'],
    elapsed_ms: Date.now() - started,
  }))
} catch (error) {
  process.stderr.write(`Standalone startup check failed: ${error.message}\n${output.replaceAll(token, '[redacted]')}\n`)
  process.exitCode = 1
} finally {
  if (!closed && launcher?.pid) {
    killOwnedGroup('SIGTERM')
    closed = await waitForPortsClosed(Math.min(deadline - 1_000, Date.now() + 2_000)).catch(() => false)
    if (!closed || !exitResult) {
      killOwnedGroup('SIGKILL')
      if (launcherExit) await within(launcherExit.catch(() => {}), 1_000, 'Owned launcher cleanup').catch(() => {})
      closed = await waitForPortsClosed(Date.now() + 1_000).catch(() => false)
    }
  }
  if (!launcher?.pid || closed) await fs.rm(workspace, { recursive: true, force: true })
  else {
    process.stderr.write(`Startup-check cleanup could not confirm closed ports; retained isolated workspace: ${workspace}\n`)
    process.exitCode = 1
  }
}
