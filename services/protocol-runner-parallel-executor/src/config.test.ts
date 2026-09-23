import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { readProtocolRunnerParallelExecutorConfig } from './config.js'
import { buildWorkerProcessEnv, resolveWorkerRuntimeProfile } from './runtime-profile.js'

test('parallel executor defaults to a single fake worker without sandbox bypass', () => {
  const config = readProtocolRunnerParallelExecutorConfig({})

  assert.equal(config.launcherMode, 'fake')
  assert.equal(config.capacity, 1)
  assert.equal(config.launchBatchSize, 1)
  assert.equal(config.codexSandbox, 'workspace-write')
  assert.equal(config.codexBypassApprovalsAndSandbox, false)
  assert.equal(config.leaseTtlMs, 300_000)
  assert.equal(config.heartbeatIntervalMs, 30_000)
  assert.ok(config.heartbeatIntervalMs < config.leaseTtlMs)
})

test('parallel executor rejects a heartbeat interval that cannot renew before lease expiry', () => {
  assert.throws(
    () =>
      readProtocolRunnerParallelExecutorConfig({
        PROTOCOL_RUNNER_PARALLEL_EXECUTOR_LEASE_TTL_MS: '30000',
        PROTOCOL_RUNNER_PARALLEL_EXECUTOR_HEARTBEAT_INTERVAL_MS: '30000',
      }),
    /heartbeat.*less than lease TTL/i,
  )
})

test('parallel executor live execution requires an explicit workspace', () => {
  assert.throws(() => readProtocolRunnerParallelExecutorConfig({
    PROTOCOL_RUNNER_PARALLEL_EXECUTOR_MODE: 'codex_exec',
  }), /explicit.*WORKSPACE_ROOT/)
  const config = readProtocolRunnerParallelExecutorConfig({
    PROTOCOL_RUNNER_PARALLEL_EXECUTOR_MODE: 'codex_exec',
    PROTOCOL_RUNNER_PARALLEL_EXECUTOR_WORKSPACE_ROOT: 'fixtures/explicit-workspace',
  })

  assert.equal(config.launcherMode, 'codex_exec')
  assert.equal(config.workspaceRoot, path.resolve('fixtures/explicit-workspace'))
})

test('worker environment keeps Codex and platform configuration without service credentials', () => {
  const sourceEnv = {
    PATH: 'tools', HOME: '/home/example', CODEX_HOME: '/home/example/.codex',
    OPENAI_API_KEY: 'provider-key', PROTOCOL_RUNNER_CONTROL_TOKEN: 'service-token',
    GITHUB_TOKEN: 'github-secret', DATABASE_URL: 'database-secret',
    NODE_OPTIONS: '--require injected.js', PYTHONPATH: 'injected',
  }
  assert.deepEqual(buildWorkerProcessEnv(sourceEnv, undefined), {
    PATH: 'tools', HOME: '/home/example', CODEX_HOME: '/home/example/.codex', OPENAI_API_KEY: 'provider-key',
  })
  assert.equal(sourceEnv.PROTOCOL_RUNNER_CONTROL_TOKEN, 'service-token')
})

test('parallel executor rejects API URL credentials and non-origin components', () => {
  for (const url of ['http://user:password@localhost:4831', 'http://localhost:4831/path', 'http://localhost:4831?x=1', 'http://example.com:4831']) {
    assert.throws(() => readProtocolRunnerParallelExecutorConfig({ PROTOCOL_RUNNER_API_URL: url }))
  }
})

test('parallel executor reads explicit worker runtime profile config', () => {
  const nodeDir = path.join('fixtures', 'worker-runtime', 'node')
  const pythonDir = path.join('fixtures', 'worker-runtime', 'python')
  const nodePath = path.join(nodeDir, process.platform === 'win32' ? 'node.exe' : 'node')
  const pnpmPath = path.join(nodeDir, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')
  const pythonPath = path.join(pythonDir, process.platform === 'win32' ? 'python.exe' : 'python')
  const config = readProtocolRunnerParallelExecutorConfig({
    PROTOCOL_RUNNER_PARALLEL_EXECUTOR_WORKER_RUNTIME_PROFILE_ID: 'nuc_dev',
    PROTOCOL_RUNNER_PARALLEL_EXECUTOR_WORKER_PATH_PREPEND: [nodeDir, pythonDir].join(path.delimiter),
    PROTOCOL_RUNNER_PARALLEL_EXECUTOR_WORKER_NODE_EXE: nodePath,
    PROTOCOL_RUNNER_PARALLEL_EXECUTOR_WORKER_PNPM_CMD: pnpmPath,
    PROTOCOL_RUNNER_PARALLEL_EXECUTOR_WORKER_PYTHON_EXE: pythonPath,
  })

  assert.equal(config.workerRuntimeProfile.profile_id, 'nuc_dev')
  assert.deepEqual(config.workerRuntimeProfile.path_prepend, [
    path.resolve(nodeDir),
    path.resolve(pythonDir),
  ])
  assert.equal(config.workerRuntimeProfile.tools.node_exe, path.resolve(nodePath))
  assert.equal(config.workerRuntimeProfile.tools.pnpm_cmd, path.resolve(pnpmPath))
  assert.equal(config.workerRuntimeProfile.tools.python_exe, path.resolve(pythonPath))
})

test('worker runtime profile proves json_transform only from usable explicit tools', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'protocol-runner-runtime-profile-'))
  try {
    const nodePath = path.join(tempRoot, process.platform === 'win32' ? 'node.exe' : 'node')
    await fs.writeFile(nodePath, '', 'utf8')

    const profile = await resolveWorkerRuntimeProfile({
      profile_id: 'test_profile',
      path_prepend: [tempRoot],
      tools: {
        node_exe: nodePath,
        python_exe: path.join(tempRoot, 'missing-python.exe'),
      },
    })

    assert.deepEqual(profile.capabilities, ['base', 'json_transform'])
    assert.equal(profile.env.NODE_EXE, nodePath)
    assert.equal(profile.env.PYTHON_EXE, undefined)
    assert.equal(profile.tool_statuses.node_exe.exists, true)
    assert.equal(profile.tool_statuses.python_exe.exists, false)
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
})

test('worker process env injects runtime profile vars and path prepends', () => {
  const existingPath = path.resolve('fixtures', 'worker-runtime', 'existing')
  const nodeDir = path.resolve('fixtures', 'worker-runtime', 'node')
  const nodePath = path.join(nodeDir, process.platform === 'win32' ? 'node.exe' : 'node')
  const env = buildWorkerProcessEnv(
    {
      PATH: existingPath,
    },
    {
      profile_id: 'test_profile',
      capabilities: ['base', 'json_transform'],
      env: {
        NODE_EXE: nodePath,
      },
      path_prepend: [nodeDir],
      tool_statuses: {
        node_exe: {
          env_var: 'NODE_EXE',
          configured_path: nodePath,
          usable_path: nodePath,
          exists: true,
        },
        pnpm_cmd: { env_var: 'PNPM_CMD', exists: false },
        python_exe: { env_var: 'PYTHON_EXE', exists: false },
      },
    },
  )

  assert.equal(env.PROTOCOL_RUNNER_WORKER_RUNTIME_PROFILE_ID, 'test_profile')
  assert.equal(env.PROTOCOL_RUNNER_WORKER_CAPABILITIES, 'base,json_transform')
  assert.equal(env.NODE_EXE, nodePath)
  assert.equal(env.PATH, [nodeDir, existingPath].join(path.delimiter))
})
