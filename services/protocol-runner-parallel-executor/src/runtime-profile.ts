import { promises as fs } from 'node:fs'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

import type { WorkerRuntimeProfile, WorkerRuntimeToolStatus } from './types.js'
import { sourceIntegrationCommand } from './source-workspace.js'

export interface WorkerRuntimeProfileConfig {
  profile_id: string
  path_prepend: string[]
  tools: {
    node_exe?: string
    pnpm_cmd?: string
    python_exe?: string
  }
}

const TOOL_ENV_VARS = {
  node_exe: 'NODE_EXE',
  pnpm_cmd: 'PNPM_CMD',
  python_exe: 'PYTHON_EXE',
} as const

type ToolName = keyof typeof TOOL_ENV_VARS

export async function resolveWorkerRuntimeProfile(
  config: WorkerRuntimeProfileConfig,
  sourceWriter?: { workspace_root: string; launcher_mode: 'fake' | 'codex_exec' },
): Promise<WorkerRuntimeProfile> {
  const tool_statuses = {
    node_exe: await toolStatus('node_exe', config.tools.node_exe),
    pnpm_cmd: await toolStatus('pnpm_cmd', config.tools.pnpm_cmd),
    python_exe: await toolStatus('python_exe', config.tools.python_exe),
  }
  const env: WorkerRuntimeProfile['env'] = {}
  for (const [toolName, status] of Object.entries(tool_statuses) as Array<[ToolName, WorkerRuntimeToolStatus]>) {
    if (status.usable_path !== undefined) {
      env[TOOL_ENV_VARS[toolName]] = status.usable_path
    }
  }

  const toolDirs = Object.values(env).map((toolPath) => path.dirname(toolPath))
  const path_prepend = uniqueNonEmptyPaths([...config.path_prepend, ...toolDirs])
  const capabilities: WorkerRuntimeProfile['capabilities'] = ['base']
  if (env.NODE_EXE !== undefined || env.PYTHON_EXE !== undefined) {
    capabilities.push('json_transform')
  }
  let source_writer_status: WorkerRuntimeProfile['source_writer_status']
  if (sourceWriter !== undefined) {
    source_writer_status = { available: false, reason: 'Source writers require a real launcher and explicit usable Python.' }
    if (sourceWriter.launcher_mode === 'codex_exec' && env.PYTHON_EXE !== undefined) {
      try {
        const root = await fs.realpath(sourceWriter.workspace_root)
        const execution = promisify(execFile)
        const gitRoot = await execution('git', ['-C', root, 'rev-parse', '--show-toplevel'], { windowsHide: true, timeout: 10000 })
        if (path.resolve(gitRoot.stdout.trim()) !== root) throw new Error('Executor cwd is not the exact repository root.')
        const usage = await execution(env.PYTHON_EXE, ['-B', sourceIntegrationCommand(), 'usage', '--format', 'json'],
          { windowsHide: true, timeout: 10000 })
        JSON.parse(usage.stdout)
        capabilities.push('source_writer')
        source_writer_status = { available: true, reason: 'Real launcher, explicit Python, Git repository and source-integration CLI are available; exact source is revalidated per launch.' }
      } catch (error) {
        source_writer_status = { available: false, reason: error instanceof Error ? error.message : String(error) }
      }
    }
  }

  return {
    profile_id: config.profile_id,
    capabilities,
    env,
    path_prepend,
    tool_statuses,
    ...(source_writer_status !== undefined ? { source_writer_status } : {}),
  }
}

export function buildWorkerProcessEnv(
  baseEnv: NodeJS.ProcessEnv,
  profile: WorkerRuntimeProfile | undefined,
): NodeJS.ProcessEnv {
  // Workers receive the user's Codex login/config and ordinary platform paths,
  // not API/service credentials or arbitrary inherited shell configuration.
  // In particular NODE_OPTIONS, PYTHONPATH and PROTOCOL_RUNNER_CONTROL_TOKEN
  // are not inherited. This reduces credential exposure; it is not a sandbox.
  const allowed = new Set([
    'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR',
    'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
    'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'PROGRAMDATA',
    'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM', 'COLORTERM',
    'CODEX_HOME', 'OPENAI_API_KEY', 'CODEX_API_KEY',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  ])
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(baseEnv)) {
    if (allowed.has(key.toUpperCase()) && value !== undefined) env[key] = value
  }
  if (profile === undefined) return env
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
  const currentPath = env[pathKey] ?? ''
  const pathEntries = uniqueNonEmptyPaths([
    ...profile.path_prepend,
    ...currentPath.split(path.delimiter).filter((entry) => entry.trim().length > 0),
  ])
  env[pathKey] = pathEntries.join(path.delimiter)
  env.PROTOCOL_RUNNER_WORKER_RUNTIME_PROFILE_ID = profile.profile_id
  env.PROTOCOL_RUNNER_WORKER_CAPABILITIES = profile.capabilities.join(',')
  for (const [key, value] of Object.entries(profile.env)) {
    if (value !== undefined) {
      env[key] = value
    }
  }
  return env
}

async function toolStatus(toolName: ToolName, configuredPath: string | undefined): Promise<WorkerRuntimeToolStatus> {
  const configured_path = configuredPath === undefined ? undefined : path.resolve(configuredPath)
  if (configured_path === undefined) {
    return {
      env_var: TOOL_ENV_VARS[toolName],
      exists: false,
    }
  }

  try {
    const stat = await fs.stat(configured_path)
    if (stat.isFile()) {
      return {
        env_var: TOOL_ENV_VARS[toolName],
        configured_path,
        usable_path: configured_path,
        exists: true,
      }
    }
    return {
      env_var: TOOL_ENV_VARS[toolName],
      configured_path,
      exists: false,
    }
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return {
        env_var: TOOL_ENV_VARS[toolName],
        configured_path,
        exists: false,
      }
    }
    throw error
  }
}

function uniqueNonEmptyPaths(paths: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const candidate of paths) {
    const trimmed = candidate.trim()
    if (trimmed.length === 0) {
      continue
    }
    const resolved = path.resolve(trimmed)
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    result.push(resolved)
  }
  return result
}
