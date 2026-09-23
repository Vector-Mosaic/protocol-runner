import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Exercise the real authenticated API/store/executor with explicitly simulated workers.
 * The caller owns API startup/shutdown. No other run is eligible for this executor.
 */
export async function runRecoveryDemo({ baseUrl, controlToken, workspaceRoot = repositoryRoot, runId }) {
  const endpoint = new URL(baseUrl)
  assert.equal(endpoint.protocol, 'http:', 'The demo expects a local HTTP API.')
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname), 'The demo API must use loopback.')
  assert.ok(typeof controlToken === 'string' && controlToken.length >= 32, 'A control token of at least 32 characters is required.')
  const root = path.resolve(workspaceRoot)
  const id = runId ?? `recovery_${Date.now()}_${randomUUID().slice(0, 8)}`
  assert.match(id, /^[A-Za-z0-9][A-Za-z0-9_-]*$/)
  const demoRelative = `.protocol-runner/demos/${id}`
  const demoRoot = path.join(root, demoRelative)
  // A unique directory avoids reusing or overwriting earlier outputs.
  await fs.mkdir(path.dirname(demoRoot), { recursive: true })
  await fs.mkdir(demoRoot)
  const request = async (method, resource, body) => {
    const response = await fetch(new URL(resource, endpoint), {
      method,
      headers: { authorization: `Bearer ${controlToken}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`${method} ${resource}: HTTP ${response.status}: ${text}`)
    return JSON.parse(text)
  }
  const save = async (name, value) => fs.writeFile(path.join(demoRoot, name), `${JSON.stringify(value, null, 2)}\n`)
  const runPath = `/api/runs/${encodeURIComponent(id)}`
  const groupPath = `${runPath}/parallel-groups/reviews`
  const backend = await request('GET', '/api/diagnostics')
  const plan = JSON.parse(await fs.readFile(path.join(root, 'examples/recovery/work_plan.json'), 'utf8'))
  plan.steps[0].sealed_output_defaults.base_dir = `${demoRelative}/outputs`
  await fs.mkdir(path.join(demoRoot, 'outputs'))
  await save('work_plan.json', plan)

  const { HttpProtocolRunnerParallelApiClient, ProtocolRunnerParallelExecutor, FakeParallelWorkerLauncher } =
    await import('../services/protocol-runner-parallel-executor/dist/index.js')
  class DemoClient extends HttpProtocolRunnerParallelApiClient {
    async listRuns() { return (await super.listRuns()).filter((run) => run.run_instance_id === id) }
  }
  const client = new DemoClient({ baseUrl: endpoint.origin, timeoutMs: 30_000, controlToken })
  const tick = async (overrides) => {
    const executor = new ProtocolRunnerParallelExecutor({
      client,
      launcher: new FakeParallelWorkerLauncher({
        executor_id: `demo_${id}`,
        workspace_root: root,
        item_status_overrides: overrides,
      }),
      executor_id: `demo_${id}`,
      capacity: 2,
      launch_batch_size: 2,
      lease_ttl_ms: 30_000,
      heartbeat_interval_ms: 5_000,
    })
    const decision = await executor.tick()
    assert.equal(decision.action, 'launched', JSON.stringify(decision))
    return decision
  }
  const diagnostics = async () => (await request('GET', `${runPath}/diagnostics`)).diagnostics
  const group = (state) => {
    const value = state.parallel_groups.find((entry) => entry.group_id === 'reviews')
    assert.ok(value, 'The API must retain the reviews group.')
    return value
  }
  const item = (state, itemId) => {
    const value = group(state).items.find((entry) => entry.item_id === itemId)
    assert.ok(value, `Missing ${itemId}`)
    return value
  }
  const digestOutput = async (state, itemId) => {
    const target = path.resolve(root, item(state, itemId).sealed_output_target)
    assert.ok(target.startsWith(`${demoRoot}${path.sep}`), 'Output must remain inside this demo directory.')
    return createHash('sha256').update(await fs.readFile(target)).digest('hex')
  }

  console.log('Simulation: the actual API and executor will complete alpha and inject a timeout for beta.')
  await request('POST', '/api/runs', { run_instance_id: id, work_plan: plan })
  await request('POST', `${runPath}/bind`, { binding_kind: 'parallel_only' })
  const initialPreflight = await request('POST', `${groupPath}/preflight`, {})
  assert.equal(initialPreflight.preflight.passed, true, JSON.stringify(initialPreflight.preflight))
  const firstDecision = await tick({ beta: 'timed_out' })
  const before = await diagnostics()
  await save('01-interrupted.json', before)
  assert.equal(before.status, 'blocked')
  assert.equal(item(before, 'alpha').status, 'completed')
  assert.equal(item(before, 'beta').status, 'needs_recovery')
  assert.equal(group(before).attempts.length, 2)
  const originalAlphaAttempt = item(before, 'alpha').latest_attempt_id
  const interruptedBetaAttempt = item(before, 'beta').latest_attempt_id
  const alphaHashBefore = await digestOutput(before, 'alpha')
  assert.equal(group(before).attempts.find((attempt) => attempt.attempt_id === interruptedBetaAttempt)?.status, 'timed_out')
  console.log('Observed: alpha completed; beta needs recovery; the timed-out attempt remains inspectable.')

  const retry = await request('POST', `${groupPath}/items/beta/retry`, {
    requested_by: 'recovery_demo', reason: 'Retry only the deliberately timed-out item.',
  })
  assert.notEqual(retry.attempt.attempt_id, interruptedBetaAttempt)
  const started = await request('POST', `${runPath}/start`, {})
  assert.equal(started.preflight.passed, true, JSON.stringify(started.preflight))
  assert.equal(started.preflight.launchable_item_count, 1)
  assert.equal(await digestOutput(await diagnostics(), 'alpha'), alphaHashBefore)
  const secondDecision = await tick({})
  assert.equal(secondDecision.launched_count, 1)
  const after = await diagnostics()
  await save('02-recovered.json', after)
  assert.equal(after.status, 'completed')
  assert.equal(item(after, 'alpha').latest_attempt_id, originalAlphaAttempt)
  assert.equal(item(after, 'beta').latest_attempt_id, retry.attempt.attempt_id)
  assert.equal(item(after, 'beta').status, 'completed')
  assert.equal(group(after).attempts.length, 3)
  assert.equal(group(after).attempts.find((attempt) => attempt.attempt_id === interruptedBetaAttempt)?.status, 'timed_out')
  const alphaHashAfter = await digestOutput(after, 'alpha')
  assert.equal(alphaHashAfter, alphaHashBefore)
  const summary = {
    schema_version: 'protocol_runner.recovery_demo.v1',
    mode: 'simulated_workers_real_api_executor_store',
    generated_at: new Date().toISOString(),
    passed: true,
    run_instance_id: id,
    checks: {
      completed_sibling_not_relaunched: true,
      completed_output_sha256_unchanged: true,
      retry_has_new_attempt_identity: true,
      timed_out_attempt_preserved: true,
      only_one_item_relaunched: true,
      final_run_completed: true,
    },
    completed_output_sha256: alphaHashAfter,
    attempts: { alpha: originalAlphaAttempt, beta_interrupted: interruptedBetaAttempt, beta_recovered: retry.attempt.attempt_id },
    decisions: [firstDecision, secondDecision],
    api_store_mode: backend.store.mode,
    limitation: 'The failure is injected by the fake launcher. This is not a live model, process-kill, semantic-quality, or performance evaluation.',
  }
  await save('summary.json', summary)
  console.log('PASS: beta retried with a new attempt; alpha stayed unchanged; both items completed.')
  console.log(`Evidence: ${path.join(demoRoot, 'summary.json')}`)
  return { summary, evidenceRoot: demoRoot }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length !== 2 || args[0] !== '--base-url') {
    console.error('Usage: node scripts/demo.mjs --base-url http://127.0.0.1:<port>')
    process.exitCode = 2
  } else {
    const controlToken = process.env.PROTOCOL_RUNNER_CONTROL_TOKEN?.trim()
      || (await fs.readFile(path.join(repositoryRoot, '.protocol-runner/control-token'), 'utf8')).trim()
    await runRecoveryDemo({ baseUrl: args[1], controlToken })
  }
}
