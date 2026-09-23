import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2).filter((arg) => arg !== '--')
const command = args.shift() ?? 'start'
const live = args.includes('--live') || command === 'desktop'
const workspaceIndex = args.indexOf('--workspace')
const workspaceArg = workspaceIndex >= 0 ? args[workspaceIndex + 1] : undefined
if (!['start', 'demo', 'desktop'].includes(command)) throw new Error('Expected start, demo or desktop')
for (let i = 0; i < args.length; i++) {
  if (!['--live', '--workspace'].includes(args[i])) throw new Error(`Unknown argument: ${args[i]}`)
  if (args[i] === '--workspace') i++
}
if (command === 'demo' && live) throw new Error('The recovery demo uses simulated workers; live execution is a separate explicit command.')
if (live && (!workspaceArg || workspaceArg.startsWith('--'))) throw new Error('Live execution requires --workspace <directory>')
if (command === 'desktop' && process.platform !== 'win32') throw new Error('The optional Desktop integration requires Windows.')
const workspace = await fs.realpath(path.resolve(workspaceArg ?? root))
if (!(await fs.stat(workspace)).isDirectory()) throw new Error('Workspace must be an existing directory')
if (existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'))
if (command === 'desktop' && existsSync(path.join(root, '.env.desktop.local'))) process.loadEnvFile(path.join(root, '.env.desktop.local'))
const localRoot = path.join(root, '.protocol-runner')
const stateRoot = path.join(workspace, '.protocol-runner')
await fs.mkdir(localRoot, { recursive: true, mode: 0o700 })
await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 })
const tokenPath = path.join(localRoot, 'control-token')
let token = process.env.PROTOCOL_RUNNER_CONTROL_TOKEN?.trim()
if (!token) {
  try {
    const handle = await fs.open(tokenPath, 'wx', 0o600)
    await handle.writeFile(randomBytes(32).toString('hex') + '\n')
    await handle.close()
  } catch (error) { if (error.code !== 'EEXIST') throw error }
  if ((await fs.lstat(tokenPath)).isSymbolicLink()) throw new Error('Control-token file cannot be a symbolic link')
  token = (await fs.readFile(tokenPath, 'utf8')).trim()
}
if (token.length < 32) throw new Error('Local control token must have at least 32 characters')
function portValue(name, fallback) {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isInteger(value) || value < 1024 || value > 65533) throw new Error(`${name} must be a port between 1024 and 65533`)
  return value
}
const apiPort = portValue('PROTOCOL_RUNNER_API_PORT', 14831)
const uiPort = portValue('PROTOCOL_RUNNER_UI_PORT', 15174)
const baseUrl = `http://127.0.0.1:${apiPort}`
const env = {
  ...process.env,
  PROTOCOL_RUNNER_CONTROL_TOKEN: token,
  PROTOCOL_RUNNER_API_HOST: '127.0.0.1',
  PROTOCOL_RUNNER_API_PORT: String(apiPort), PROTOCOL_RUNNER_API_URL: baseUrl,
  PROTOCOL_RUNNER_UI_PORT: String(uiPort), PROTOCOL_RUNNER_UI_DEV_URL: `http://127.0.0.1:${uiPort}`,
  PROTOCOL_RUNNER_RUNS_ROOT: path.join(stateRoot, 'runs'),
  PROTOCOL_RUNNER_DB_PATH: path.join(stateRoot, 'protocol_runner.sqlite'),
  PROTOCOL_RUNNER_CONTRACT_ROOT: workspace,
  PROTOCOL_RUNNER_ADAPTER_MODE: command === 'desktop' ? 'real' : 'fake',
  PROTOCOL_RUNNER_NOTIFICATION_ENABLED: 'false',
  PROTOCOL_RUNNER_DRIVER_HEALTH_PORT: String(apiPort + 1),
  PROTOCOL_RUNNER_PARALLEL_EXECUTOR_HEALTH_PORT: String(apiPort + 2),
  PROTOCOL_RUNNER_PARALLEL_EXECUTOR_MODE: live ? 'codex_exec' : 'fake',
  PROTOCOL_RUNNER_PARALLEL_EXECUTOR_WORKSPACE_ROOT: workspace,
  PROTOCOL_RUNNER_PARALLEL_EXECUTOR_CAPACITY: process.env.PROTOCOL_RUNNER_PARALLEL_EXECUTOR_CAPACITY ?? '1',
  PROTOCOL_RUNNER_PARALLEL_EXECUTOR_LAUNCH_BATCH_SIZE: process.env.PROTOCOL_RUNNER_PARALLEL_EXECUTOR_LAUNCH_BATCH_SIZE ?? '1',
  PROTOCOL_RUNNER_PARALLEL_EXECUTOR_CODEX_SANDBOX: 'workspace-write',
  PROTOCOL_RUNNER_PARALLEL_EXECUTOR_CODEX_BYPASS_APPROVALS_AND_SANDBOX: 'false',
  PROTOCOL_RUNNER_PARALLEL_EXECUTOR_WORKER_NODE_EXE: process.execPath,
}
const children = []
let stopping = false
async function ensureFree(port) {
  await new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', () => reject(new Error(`Port ${port} is in use; choose different public Runner ports. No existing service was changed.`)))
    probe.listen(port, '127.0.0.1', () => probe.close(resolve))
  })
}
function launch(label, script, cwd = root) {
  if (!existsSync(script)) throw new Error(`Missing ${label} build/dependency. Run pnpm install and pnpm build first.`)
  const child = spawn(process.execPath, [script], { cwd, env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true })
  const record = { label, child, exit: null }
  record.exit = new Promise((resolve) => child.once('close', (code, signal) => {
    resolve({ code, signal })
    if (!stopping) {
      process.stderr.write(`${label} exited (${code ?? signal}). Stopping this Runner instance.\n`)
      process.exitCode = code || 1
      void stop()
    }
  }))
  child.once('error', (error) => { process.stderr.write(`${label}: ${error.message}\n`); process.exitCode = 1; void stop() })
  children.push(record)
  return record
}
async function stop() {
  if (stopping) return
  stopping = true
  // Executor owns workers: it settles them before the API is stopped.
  const executor = children.find((record) => record.label === 'executor')
  if (executor && executor.child.exitCode === null && executor.child.signalCode === null) {
    if (executor.child.connected) executor.child.send({ type: 'shutdown' })
    await executor.exit
  }
  for (const record of [...children].reverse()) {
    if (record === executor) continue
    if (record.child.exitCode === null && record.child.signalCode === null) record.child.kill('SIGTERM')
    await record.exit
  }
}
process.once('SIGINT', () => { void stop() })
process.once('SIGTERM', () => { void stop() })
try {
  await ensureFree(apiPort)
  if (command !== 'demo') for (const port of [apiPort + 1, apiPort + 2, uiPort]) await ensureFree(port)
  if (command === 'desktop') {
    const desktopPort = portValue('WORKSTATION_CONTROL_CODEX_DESKTOP_PORT', 14825)
    const relayPort = portValue('WORKSTATION_CONTROL_DISCORD_DESKTOP_RELAY_PORT', 14830)
    await ensureFree(desktopPort)
    await ensureFree(relayPort)
    env.WORKSTATION_CONTROL_CODEX_DESKTOP_PORT = String(desktopPort)
    env.WORKSTATION_CONTROL_DISCORD_DESKTOP_RELAY_PORT = String(relayPort)
    env.WORKSTATION_CONTROL_CODEX_DESKTOP_ALLOWED_CWD = workspace
    env.WORKSTATION_CONTROL_DISCORD_DESKTOP_RELAY_ALLOWED_CWD = workspace
    env.WORKSTATION_CONTROL_RELAY_CODEX_DESKTOP_BASE_URL = `http://127.0.0.1:${desktopPort}`
    env.PROTOCOL_RUNNER_CODEX_DESKTOP_BASE_URL = `http://127.0.0.1:${desktopPort}`
    env.PROTOCOL_RUNNER_DISCORD_RELAY_BASE_URL = `http://127.0.0.1:${relayPort}`
    env.WORKSTATION_CONTROL_CODEX_DESKTOP_OPERATOR_GATE_ATTENTION_URL = `http://127.0.0.1:${uiPort}/?gate=1`
    launch('desktop-api', path.join(root, 'services/codex-desktop-api/dist/main.js'))
    launch('desktop-relay', path.join(root, 'services/codex-discord-desktop-relay/dist/main.js'))
  }
  const api = launch('api', path.join(root, 'services/protocol-runner-api/dist/main.js'))
  let ready = false
  for (let attempt = 0; attempt < 100 && !stopping; attempt++) {
    if (api.child.exitCode !== null) break
    try {
      const response = await fetch(`${baseUrl}/health`, { headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(500) })
      if (response.ok) { ready = true; break }
    } catch { /* wait for this child to listen */ }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (!ready) throw new Error('This Runner API did not become ready; inspect its startup error above.')
  if (command === 'demo') {
    const { runRecoveryDemo } = await import('./demo.mjs')
    await runRecoveryDemo({ baseUrl, controlToken: token, workspaceRoot: workspace })
    await stop()
  } else {
    launch('driver', path.join(root, 'services/protocol-runner-driver/dist/main.js'))
    launch('executor', path.join(root, 'services/protocol-runner-parallel-executor/dist/main.js'))
    launch('dashboard', path.join(root, 'apps/protocol-runner-ui/node_modules/vite/bin/vite.js'), path.join(root, 'apps/protocol-runner-ui'))
    console.log(`\nProtocol Runner: http://127.0.0.1:${uiPort}\nAPI: ${baseUrl}\nWorkers: ${live ? 'REAL Codex CLI; workspace-write' : 'SIMULATED; no model calls'}\nWorkspace: ${workspace}\nCtrl+C stops this instance. Outputs and state are retained.`)
  }
} catch (error) {
  process.stderr.write(`Protocol Runner: ${error.message}\n`)
  process.exitCode = 1
  await stop()
}
