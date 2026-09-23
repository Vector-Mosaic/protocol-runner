import { spawn } from 'node:child_process'
import type { ChildProcess, ChildProcessWithoutNullStreams } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import type {
  CodexExecLauncherOptions,
  FakeLauncherOptions,
  FakeLaunchResult,
  LauncherStatus,
  ParallelAttemptProcessRecord,
  ParallelAttemptResultFile,
  ParallelAttemptStatusReport,
  ParallelLeasePacket,
  ParallelWorkerLaunchContext,
  ParallelWorkerLaunchResult,
  ParallelWorkerLauncher,
  WorkerReportedStatus,
  WorkerRuntimeProfile,
} from './types.js'
import { buildWorkerProcessEnv } from './runtime-profile.js'
import { exportSourceOutput, handoffSourceWorkspace, markSourceRunning, prepareSourceWorkspace, sourceWriterProcessStopped } from './source-workspace.js'

export class FakeParallelWorkerLauncher implements ParallelWorkerLauncher {
  constructor(private readonly options: FakeLauncherOptions) {}

  async launch(lease: ParallelLeasePacket): Promise<FakeLaunchResult> {
    if (lease.source_writer !== undefined) throw new Error('Fake launcher does not establish source-writer execution; use an isolated real worker or a focused source-workspace test.')
    const started_at = this.nowIso()
    await fs.mkdir(lease.attempt_dir, { recursive: true })
    await fs.writeFile(lease.worker_packet_path, `${JSON.stringify({ lease, mode: 'fake' }, null, 2)}\n`, 'utf8')
    await fs.writeFile(lease.prompt_path, renderParallelWorkerPrompt(lease), 'utf8')

    const override = this.options.item_status_overrides?.[lease.item_id]
    const launcher_status = this.launcherStatusForOverride(override)
    const sealed_output_absolute_path = this.resolveWorkspacePath(lease.sealed_output_path)
    let status_report: ParallelAttemptStatusReport | undefined

    if (launcher_status === 'completed') {
      await fs.mkdir(path.dirname(sealed_output_absolute_path), { recursive: true })
      await fs.writeFile(sealed_output_absolute_path, this.renderSealedOutput(lease), 'utf8')
      status_report = this.statusReport(lease, 'completed')
      await fs.writeFile(lease.status_report_path, `${JSON.stringify(status_report, null, 2)}\n`, 'utf8')
    } else if (launcher_status === 'blocked') {
      status_report = this.statusReport(lease, 'blocked')
      await fs.writeFile(lease.status_report_path, `${JSON.stringify(status_report, null, 2)}\n`, 'utf8')
    }

    const completed_at = this.nowIso()
    const process: ParallelAttemptProcessRecord = {
      executor_id: this.options.executor_id,
      mode: 'fake',
      run_instance_id: lease.run_instance_id,
      group_id: lease.group_id,
      item_id: lease.item_id,
      attempt_id: lease.attempt_id,
      lease_id: lease.lease_id,
      started_at,
      completed_at,
      exit_code: launcher_status === 'failed' ? 1 : 0,
    }
    const result_file: ParallelAttemptResultFile = {
      launcher_status,
      summary: `fake launcher reported ${launcher_status} for ${lease.item_id}`,
      ...(status_report !== undefined ? { status_report_path: lease.status_report_path } : {}),
      ...(launcher_status === 'completed' ? { sealed_output_path: lease.sealed_output_path } : {}),
    }

    await fs.writeFile(lease.process_path, `${JSON.stringify(process, null, 2)}\n`, 'utf8')
    await fs.writeFile(lease.result_path, `${JSON.stringify(result_file, null, 2)}\n`, 'utf8')

    return {
      lease,
      launcher_status,
      ...(status_report !== undefined ? { status_report } : {}),
      process,
      result_file,
    }
  }

  private launcherStatusForOverride(
    override:
      | WorkerReportedStatus
      | 'cancelled'
      | 'timed_out'
      | 'evidence_missing'
      | 'output_missing'
      | 'status_invalid'
      | 'failed'
      | undefined,
  ): LauncherStatus {
    if (override === undefined) {
      return 'completed'
    }
    return override
  }

  private statusReport(lease: ParallelLeasePacket, status: WorkerReportedStatus): ParallelAttemptStatusReport {
    return {
      run_instance_id: lease.run_instance_id,
      step_id: lease.step_id,
      group_id: lease.group_id,
      item_id: lease.item_id,
      attempt_id: lease.attempt_id,
      status,
      sealed_output_path: lease.sealed_output_path,
      summary: `fake worker ${status} for ${lease.item_id}`,
      notes: `fake worker ${status} for ${lease.item_id}`,
    }
  }

  private renderSealedOutput(lease: ParallelLeasePacket): string {
    return [
      `# Fake Parallel Worker Output: ${lease.item_id}`,
      '',
      `run_instance_id: ${lease.run_instance_id}`,
      `step_id: ${lease.step_id}`,
      `group_id: ${lease.group_id}`,
      `item_id: ${lease.item_id}`,
      `attempt_id: ${lease.attempt_id}`,
      `contract_ref: ${lease.contract_ref}`,
      `input_ref: ${lease.input_ref}`,
      '',
      'This is fake executor output for the Protocol Runner parallel lane smoke path.',
      '',
    ].join('\n')
  }

  private resolveWorkspacePath(value: string): string {
    return resolveWorkspacePath(this.options.workspace_root, value)
  }

  private nowIso(): string {
    return (this.options.now?.() ?? new Date()).toISOString()
  }
}

export class CodexExecWorkerLauncher implements ParallelWorkerLauncher {
  constructor(private readonly options: CodexExecLauncherOptions) {}

  async launch(lease: ParallelLeasePacket, context: ParallelWorkerLaunchContext = {}): Promise<ParallelWorkerLaunchResult> {
    const started_at = this.nowIso()
    await fs.mkdir(lease.attempt_dir, { recursive: true })
    await fs.writeFile(
      lease.worker_packet_path,
      `${JSON.stringify(
        {
          lease,
          mode: 'codex_exec',
          ...(this.options.worker_runtime_profile !== undefined
            ? { worker_runtime_profile: this.options.worker_runtime_profile }
            : {}),
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
    const sourceWorkspace = lease.source_writer === undefined ? undefined : await prepareSourceWorkspace(
      lease, this.options.workspace_root, this.options.worker_runtime_profile?.env.PYTHON_EXE ?? globalThis.process.env.PYTHON_EXE ?? 'python',
    )
    const workspaceRoot = sourceWorkspace?.workspace ?? this.options.workspace_root
    const invocationLease = sourceWorkspace === undefined ? lease : {
      ...lease,
      contract_ref: resolveWorkspacePath(sourceWorkspace.artifact_root, lease.contract_ref),
      input_ref: resolveWorkspacePath(sourceWorkspace.artifact_root, lease.input_ref),
    }
    const prompt = renderParallelWorkerPrompt(invocationLease, this.options.worker_runtime_profile)
    await fs.writeFile(lease.prompt_path, prompt, 'utf8')

    const stderr_path = path.join(lease.attempt_dir, 'stderr.log')
    const codex_exec_jsonl_path = path.join(lease.attempt_dir, 'codex_exec.jsonl')
    const stdout_path = codex_exec_jsonl_path
    const final_message_path = path.join(lease.attempt_dir, 'final_message.md')
    const process_started_path = path.join(lease.attempt_dir, 'process_started.json')
    const resolvedCommand = await resolveSpawnCommand(this.options.codex_command)
    const args = [...resolvedCommand.argsPrefix, ...this.codexArgs(final_message_path, workspaceRoot, sourceWorkspace?.attempt_dir)]
    if (sourceWorkspace !== undefined) await markSourceRunning(sourceWorkspace)
    const processResult = await this.runCodexExec(args, prompt, {
      command: resolvedCommand.command,
      stderr_path,
      codex_exec_jsonl_path,
      process_started_path,
      workspace_root: workspaceRoot,
      source_writer: sourceWorkspace !== undefined,
      signal: context.signal,
    })
    const completed_at = this.nowIso()
    const process: ParallelAttemptProcessRecord = {
      executor_id: this.options.executor_id,
      mode: 'codex_exec',
      run_instance_id: lease.run_instance_id,
      group_id: lease.group_id,
      item_id: lease.item_id,
      attempt_id: lease.attempt_id,
      lease_id: lease.lease_id,
      started_at,
      completed_at,
      exit_code: processResult.exit_code,
      ...(processResult.pid !== undefined ? { pid: processResult.pid } : {}),
      ...(processResult.signal !== undefined ? { signal: processResult.signal } : {}),
      command: resolvedCommand.command,
      args,
      ...(this.options.worker_runtime_profile !== undefined
        ? { worker_runtime_profile: this.options.worker_runtime_profile }
        : {}),
      ...(processResult.error !== undefined ? { error: processResult.error } : {}),
      ...(processResult.killed_by_runner ? { killed_by_runner: true } : {}),
      ...(processResult.kill_reason !== undefined ? { kill_reason: processResult.kill_reason } : {}),
      ...(processResult.kill_error !== undefined ? { kill_error: processResult.kill_error } : {}),
    }

    let evidence = await this.inspectWorkerEvidence(lease, processResult, workspaceRoot)
    if (sourceWorkspace !== undefined) {
      process.source_workspace = sourceWorkspace.workspace
      try {
        const stopped = processResult.kill_error === undefined && await sourceWriterProcessStopped(processResult.pid)
        if (!stopped) await handoffSourceWorkspace(sourceWorkspace, false)
        if (evidence.launcher_status === 'completed') await exportSourceOutput(sourceWorkspace)
        process.source_handoff_path = await handoffSourceWorkspace(sourceWorkspace, true)
      } catch (error) {
        evidence = { ...evidence, launcher_status: 'failed', summary: `Source handoff requires recovery: ${error instanceof Error ? error.message : String(error)}` }
      }
    }
    const result_file: ParallelAttemptResultFile = {
      launcher_status: evidence.launcher_status,
      summary: evidence.summary,
      stdout_path,
      stderr_path,
      codex_exec_jsonl_path,
      final_message_path,
      process_started_path,
      ...(evidence.status_report_exists ? { status_report_path: lease.status_report_path } : {}),
      ...(evidence.sealed_output_exists ? { sealed_output_path: lease.sealed_output_path } : {}),
      ...(processResult.kill_reason !== undefined ? { kill_reason: processResult.kill_reason } : {}),
      ...(processResult.kill_error !== undefined ? { kill_error: processResult.kill_error } : {}),
    }

    await fs.writeFile(lease.process_path, `${JSON.stringify(process, null, 2)}\n`, 'utf8')
    await fs.writeFile(lease.result_path, `${JSON.stringify(result_file, null, 2)}\n`, 'utf8')

    return {
      lease,
      launcher_status: evidence.launcher_status,
      ...(evidence.status_report !== undefined ? { status_report: evidence.status_report } : {}),
      process,
      result_file,
    }
  }

  private codexArgs(final_message_path: string, workspace_root: string, source_attempt_dir?: string): string[] {
    return [
      ...this.options.codex_base_args,
      '--json',
      '-c',
      'approval_policy="never"',
      '--output-last-message',
      final_message_path,
      '-C',
      path.resolve(workspace_root),
      // Source writers run inside their own Git worktree, but their status
      // report belongs to the enclosing, API-owned attempt directory.
      ...(source_attempt_dir === undefined ? [] : ['--add-dir', source_attempt_dir]),
      ...(this.options.model !== undefined ? ['--model', this.options.model] : []),
      ...(this.options.profile !== undefined ? ['--profile', this.options.profile] : []),
      ...(this.options.bypass_approvals_and_sandbox === true ? [] : ['--sandbox', this.options.sandbox ?? 'workspace-write']),
      ...(this.options.bypass_approvals_and_sandbox === true ? ['--dangerously-bypass-approvals-and-sandbox'] : []),
      '-',
    ]
  }

  private runCodexExec(
    args: string[],
    prompt: string,
    paths: {
      command: string
      stderr_path: string
      codex_exec_jsonl_path: string
      process_started_path: string
      workspace_root: string
      source_writer: boolean
      signal?: AbortSignal
    },
  ): Promise<{
    exit_code: number
    pid?: number
    signal?: string | null
    error?: string
    timed_out: boolean
    cancelled: boolean
    killed_by_runner: boolean
    kill_reason?: string
    kill_error?: string
  }> {
    return new Promise((resolve) => {
      let child: ChildProcessWithoutNullStreams
      try {
        child = spawn(paths.command, args, {
          cwd: path.resolve(paths.workspace_root),
          windowsHide: true,
          detached: globalThis.process.platform !== 'win32',
          env: buildWorkerProcessEnv(process.env, this.options.worker_runtime_profile),
        })
      } catch (error) {
        resolve({
          exit_code: -1,
          error: error instanceof Error ? error.message : String(error),
          timed_out: false,
          cancelled: false,
          killed_by_runner: false,
        })
        return
      }

      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      let processError: string | undefined
      const processStarted = fs.writeFile(
        paths.process_started_path,
        `${JSON.stringify(
          {
            pid: child.pid,
            command: paths.command,
            args,
            ...(this.options.worker_runtime_profile !== undefined
              ? { worker_runtime_profile: this.options.worker_runtime_profile }
              : {}),
          },
          null,
          2,
        )}\n`,
        'utf8',
      )
        .catch((error: unknown) => {
          processError = error instanceof Error ? error.message : String(error)
          stderrChunks.push(Buffer.from(`${processError}\n`, 'utf8'))
        })
      let timed_out = false
      let cancelled = false
      let killed_by_runner = false
      let killReason: string | undefined
      let killError: string | undefined
      let killPromise: Promise<void> | undefined
      const requestKill = (reason: 'cancelled' | 'hard_timeout') => {
        if (child.exitCode !== null || child.killed) {
          return
        }
        if (killReason === undefined) {
          killReason = reason
          killed_by_runner = true
          if (reason === 'cancelled') {
            cancelled = true
          } else {
            timed_out = true
          }
        }
        killPromise ??= terminateChildProcessTree(child)
          .then((result) => {
            if (!result.ok) {
              killError = result.error
              stderrChunks.push(Buffer.from(`${result.error}\n`, 'utf8'))
            }
          })
          .catch((error: unknown) => {
            killError = error instanceof Error ? error.message : String(error)
            stderrChunks.push(Buffer.from(`${killError}\n`, 'utf8'))
          })
      }
      const timeout =
        this.options.hard_timeout_ms === undefined
          ? undefined
          : setTimeout(() => {
              requestKill('hard_timeout')
            }, this.options.hard_timeout_ms)
      const abortListener = () => requestKill('cancelled')
      if (paths.signal?.aborted === true) {
        requestKill('cancelled')
      } else {
        paths.signal?.addEventListener('abort', abortListener, { once: true })
      }

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutChunks.push(chunk)
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderrChunks.push(chunk)
      })
      child.on('error', (error) => {
        processError = error.message
        stderrChunks.push(Buffer.from(`${error.message}\n`, 'utf8'))
      })
      child.on('close', (code, signal) => {
        if (timeout !== undefined) {
          clearTimeout(timeout)
        }
        paths.signal?.removeEventListener('abort', abortListener)
        const stdout = Buffer.concat(stdoutChunks)
        const stderr = Buffer.concat(stderrChunks)
        void Promise.resolve(killPromise)
          .then(() => processStarted)
          .then(() =>
            Promise.all([
              fs.writeFile(paths.codex_exec_jsonl_path, stdout),
              fs.writeFile(paths.stderr_path, stderr),
            ]),
          )
          .then(() => {
            resolve({
              exit_code: code ?? (timed_out ? -1 : 1),
              pid: child.pid,
              signal,
              ...(processError !== undefined ? { error: processError } : {}),
              timed_out,
              cancelled,
              killed_by_runner,
              ...(killReason !== undefined ? { kill_reason: killReason } : {}),
              ...(killError !== undefined ? { kill_error: killError } : {}),
            })
          })
          .catch((error: unknown) => {
            resolve({
              exit_code: -1,
              pid: child.pid,
              signal,
              error: error instanceof Error ? error.message : String(error),
              timed_out,
              cancelled,
              killed_by_runner,
              ...(killReason !== undefined ? { kill_reason: killReason } : {}),
              ...(killError !== undefined ? { kill_error: killError } : {}),
            })
          })
      })

      child.stdin.on('error', (error) => {
        processError = error.message
        stderrChunks.push(Buffer.from(`${error.message}\n`, 'utf8'))
      })
      child.stdin.end(prompt)
    })
  }

  private async inspectWorkerEvidence(
    lease: ParallelLeasePacket,
    processResult: { exit_code: number; error?: string; timed_out: boolean; cancelled: boolean },
    workspace_root: string,
  ): Promise<{
    launcher_status: LauncherStatus
    summary: string
    status_report?: ParallelAttemptStatusReport
    status_report_exists: boolean
    sealed_output_exists: boolean
  }> {
    const statusReportRead = await readStatusReport(lease.status_report_path)
    const sealed_output_exists = await fileExists(resolveWorkspacePath(workspace_root, lease.sealed_output_path))
    if (processResult.cancelled) {
      return {
        launcher_status: 'cancelled',
        summary: `codex exec was cancelled for ${lease.item_id}.`,
        ...(statusReportRead.status_report !== undefined ? { status_report: statusReportRead.status_report } : {}),
        status_report_exists: statusReportRead.exists,
        sealed_output_exists,
      }
    }
    if (processResult.timed_out) {
      return {
        launcher_status: 'timed_out',
        summary: `codex exec timed out for ${lease.item_id}.`,
        ...(statusReportRead.status_report !== undefined ? { status_report: statusReportRead.status_report } : {}),
        status_report_exists: statusReportRead.exists,
        sealed_output_exists,
      }
    }
    if (processResult.error !== undefined || processResult.exit_code !== 0) {
      return {
        launcher_status: 'failed',
        summary: processResult.error ?? `codex exec exited with code ${processResult.exit_code} for ${lease.item_id}.`,
        ...(statusReportRead.status_report !== undefined ? { status_report: statusReportRead.status_report } : {}),
        status_report_exists: statusReportRead.exists,
        sealed_output_exists,
      }
    }
    if (!statusReportRead.exists) {
      return {
        launcher_status: 'evidence_missing',
        summary: `status_report.json was not written for ${lease.item_id}.`,
        status_report_exists: false,
        sealed_output_exists,
      }
    }
    if (statusReportRead.error !== undefined || statusReportRead.status_report === undefined) {
      return {
        launcher_status: 'status_invalid',
        summary: statusReportRead.error ?? `status_report.json was invalid for ${lease.item_id}.`,
        status_report_exists: true,
        sealed_output_exists,
      }
    }
    if (!statusReportMatchesLease(statusReportRead.status_report, lease)) {
      return {
        launcher_status: 'status_invalid',
        summary: `status_report.json identity did not match lease ${lease.lease_id}.`,
        status_report: statusReportRead.status_report,
        status_report_exists: true,
        sealed_output_exists,
      }
    }
    if (statusReportRead.status_report.status === 'blocked') {
      return {
        launcher_status: 'blocked',
        summary: statusReportRead.status_report.notes ?? statusReportRead.status_report.summary ?? `worker blocked ${lease.item_id}.`,
        status_report: statusReportRead.status_report,
        status_report_exists: true,
        sealed_output_exists,
      }
    }
    if (!sealed_output_exists) {
      return {
        launcher_status: 'output_missing',
        summary: `sealed output was not written for completed worker item ${lease.item_id}.`,
        status_report: statusReportRead.status_report,
        status_report_exists: true,
        sealed_output_exists: false,
      }
    }
    return {
      launcher_status: 'completed',
      summary: statusReportRead.status_report.notes ?? statusReportRead.status_report.summary ?? `worker completed ${lease.item_id}.`,
      status_report: statusReportRead.status_report,
      status_report_exists: true,
      sealed_output_exists: true,
    }
  }

  private nowIso(): string {
    return (this.options.now?.() ?? new Date()).toISOString()
  }
}

function renderParallelWorkerPrompt(lease: ParallelLeasePacket, workerRuntimeProfile?: WorkerRuntimeProfile): string {
  const workerVisibleItem = {
    item_id: lease.item_id,
    input_ref: lease.input_ref,
    contract_ref: lease.contract_ref,
    variables: lease.variables,
    sealed_output_path: lease.sealed_output_path,
    status_report_path: lease.status_report_path,
    required_worker_capabilities: lease.required_worker_capabilities ?? [],
    ...(lease.source_writer !== undefined ? { source_writer: lease.source_writer } : {}),
  }
  const workerRuntimeSection =
    workerRuntimeProfile === undefined
      ? []
      : [
          'Worker runtime profile:',
          '```json',
          JSON.stringify(
            {
              profile_id: workerRuntimeProfile.profile_id,
              capabilities: workerRuntimeProfile.capabilities,
              env: workerRuntimeProfile.env,
              path_prepend: workerRuntimeProfile.path_prepend,
              tool_statuses: workerRuntimeProfile.tool_statuses,
            },
            null,
            2,
          ),
          '```',
          '',
          'When this item requires a listed runtime capability, use the explicit environment variables from the worker runtime profile. For JSON or structured-file transformations, prefer `NODE_EXE` or `PYTHON_EXE` when present; do not assume bare `node`, `python`, or `py` commands are available unless the profile and contract make that safe.',
          '',
        ]
  return [
    'This is a protocol-runner invocation for one bounded parallel worker item.',
    '',
    `Run instance: ${lease.run_instance_id}`,
    `Step: ${lease.step_id}`,
    'Step kind: parallel_group',
    `Parallel group: ${lease.group_id}`,
    `Worker item: ${lease.item_id}`,
    `Attempt: ${lease.attempt_id}`,
    '',
    `We are executing ${lease.contract_ref} for this worker item only. The authoritative framework/contract is defined at:`,
    '',
    lease.contract_ref,
    '',
    'Read the referenced framework/contract in full before starting work. Do not treat this invocation prompt as a substitute for, summary of, or modification to that framework/contract.',
    '',
    'The work for this invocation is to apply the referenced framework/contract to this worker item only:',
    '',
    'Worker item:',
    lease.item_id,
    '',
    'Worker-visible item packet:',
    '```json',
    JSON.stringify(workerVisibleItem, null, 2),
    '```',
    '',
    ...workerRuntimeSection,
    ...(lease.source_writer === undefined ? [] : [
      'This source-writer attempt runs in its own Runner-owned Git worktree. Change only source_writer.owned_paths in this cwd. The absolute contract/input references are read-only canonical inputs; never write into their shared checkout.',
      'Save your assigned source files normally. Do not push, integrate, remove the worktree, or create source backups. The launcher returns a Git source contribution with this attempt; the coordinator owns integration. Write only the declared sealed output plus status report outside those source files, and leave no running child processes.',
      '',
    ]),
    `Follow the grounding rules and grounding sequence defined in ${lease.contract_ref}. Ground on the files/information it identifies, in the order and timing it requires. Ground according to the contract before starting work, and continue following its grounding instructions during the work process.`,
    '',
    `Instructions for output content, output shape, completion requirements, and any work-specific reporting are defined in ${lease.contract_ref}.`,
    '',
    'Write the sealed output for this worker item at:',
    '',
    lease.sealed_output_path,
    '',
    'Before exiting this attempt, write the procedural status report at:',
    '',
    lease.status_report_path,
    '',
    'The status report must be valid JSON with this shape:',
    '',
    '```json',
    JSON.stringify(
      {
        run_instance_id: lease.run_instance_id,
        step_id: lease.step_id,
        group_id: lease.group_id,
        item_id: lease.item_id,
        attempt_id: lease.attempt_id,
        status: 'completed',
        sealed_output_path: lease.sealed_output_path,
        notes: '<optional short procedural note>',
      },
      null,
      2,
    ),
    '```',
    '',
    'Write `status_report.json` as UTF-8 without BOM. On Windows PowerShell 5.1, do not use `Set-Content -Encoding UTF8` for this file because it writes a BOM that older JSON parsers reject.',
    'Safe PowerShell write pattern for the status report:',
    '',
    '```powershell',
    '$json = $status | ConvertTo-Json -Depth 4',
    '[System.IO.File]::WriteAllText($statusPath, $json + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))',
    '```',
    '',
    'Allowed worker-reported statuses are only `completed` and `blocked`.',
    '',
    'Use `status: "blocked"` only if you cannot complete this worker item under the referenced framework/contract. Include a short procedural blocker in `notes`.',
    '',
    'Do only this worker item.',
    'Do not continue to later steps.',
    'Do not process unassigned sibling items. Use only the exact input refs assigned to this item by its concrete contract.',
    'Do not inspect, infer, or reconstruct the hidden ordered work plan.',
    'Do not batch, script, compress, or generalize across multiple worker items.',
    'Do not inspect or synthesize across unassigned sealed outputs; use only the exact sealed-output inputs assigned to this item by its concrete contract.',
    'Do not write to shared final project files unless the assigned concrete contract explicitly authorizes exact named shared paths as this item\'s bounded work. When it does, touch only those paths and follow its ownership and conflict checks.',
    'Do not change the workflow topology.',
    '',
    'This file-based status report is the runner handoff for this worker attempt. Do not call `protocol-runner-api` or `protocol_runner_return.py` directly. The launcher will submit the attempt result to the runner after this process exits.',
    '',
  ].join('\n')
}

function resolveWorkspacePath(workspace_root: string, value: string): string {
  const resolved = path.isAbsolute(value) ? path.resolve(value) : path.resolve(workspace_root, value)
  const root = path.resolve(workspace_root)
  const relative = path.relative(root, resolved)
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return resolved
  }
  throw new Error(`sealed output path escapes workspace root: ${value}`)
}

async function readStatusReport(filePath: string): Promise<{
  exists: boolean
  status_report?: ParallelAttemptStatusReport
  error?: string
}> {
  let body: string
  try {
    body = await fs.readFile(filePath, 'utf8')
  } catch (error) {
    if (isNotFound(error)) {
      return { exists: false }
    }
    return { exists: false, error: error instanceof Error ? error.message : String(error) }
  }

  try {
    const parsed = JSON.parse(stripLeadingBom(body)) as Partial<ParallelAttemptStatusReport>
    if (
      typeof parsed.run_instance_id !== 'string' ||
      typeof parsed.step_id !== 'string' ||
      typeof parsed.group_id !== 'string' ||
      typeof parsed.item_id !== 'string' ||
      typeof parsed.attempt_id !== 'string' ||
      (parsed.status !== 'completed' && parsed.status !== 'blocked') ||
      typeof parsed.sealed_output_path !== 'string'
    ) {
      return { exists: true, error: 'status_report.json has invalid shape.' }
    }
    return {
      exists: true,
      status_report: {
        run_instance_id: parsed.run_instance_id,
        step_id: parsed.step_id,
        group_id: parsed.group_id,
        item_id: parsed.item_id,
        attempt_id: parsed.attempt_id,
        status: parsed.status,
        sealed_output_path: parsed.sealed_output_path,
        ...(typeof parsed.notes === 'string' ? { notes: parsed.notes } : {}),
        ...(typeof parsed.summary === 'string' ? { summary: parsed.summary } : {}),
      },
    }
  } catch (error) {
    return { exists: true, error: error instanceof Error ? error.message : String(error) }
  }
}

function stripLeadingBom(body: string): string {
  return body.charCodeAt(0) === 0xfeff ? body.slice(1) : body
}

function statusReportMatchesLease(status_report: ParallelAttemptStatusReport, lease: ParallelLeasePacket): boolean {
  return (
    status_report.run_instance_id === lease.run_instance_id &&
    status_report.step_id === lease.step_id &&
    status_report.group_id === lease.group_id &&
    status_report.item_id === lease.item_id &&
    status_report.attempt_id === lease.attempt_id
  )
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath)
    return stat.isFile()
  } catch (error) {
    if (isNotFound(error)) {
      return false
    }
    throw error
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

async function resolveSpawnCommand(command: string): Promise<{ command: string; argsPrefix: string[] }> {
  if (process.platform !== 'win32' || path.extname(command) !== '' || path.isAbsolute(command)) {
    return resolveWindowsShim(command)
  }
  const pathValue = process.env.PATH ?? ''
  const pathExts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((ext) => ext.trim().toLowerCase())
    .filter(Boolean)
  const candidates: string[] = []
  for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const ext of ['.cmd', '.exe', '.bat', '.ps1', ...pathExts]) {
      candidates.push(path.join(dir, `${command}${ext}`))
    }
  }
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate)
      if (stat.isFile()) {
        return resolveWindowsShim(candidate)
      }
    } catch (error) {
      if (!isNotFound(error)) {
        throw error
      }
    }
  }
  return { command, argsPrefix: [] }
}

async function resolveWindowsShim(command: string): Promise<{ command: string; argsPrefix: string[] }> {
  if (process.platform !== 'win32') {
    return { command, argsPrefix: [] }
  }
  const parsed = path.parse(command)
  if (parsed.ext.toLowerCase() !== '.cmd' && parsed.ext !== '') {
    return { command, argsPrefix: [] }
  }
  const commandDir = parsed.dir
  const nodePath = path.join(commandDir, 'node.exe')
  const codexJsPath = path.join(commandDir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
  if (parsed.name.toLowerCase() === 'codex' && (await fileExists(nodePath)) && (await fileExists(codexJsPath))) {
    return {
      command: nodePath,
      argsPrefix: [codexJsPath],
    }
  }
  return { command, argsPrefix: [] }
}

async function terminateChildProcessTree(child: ChildProcess): Promise<{ ok: boolean; error?: string }> {
  if (child.pid === undefined) {
    return { ok: false, error: 'Cannot terminate child process because pid is unavailable.' }
  }
  if (process.platform === 'win32') {
    const result = await runTaskkill(child.pid)
    const exited = await waitForChildExit(child, 2_000)
    if (exited) {
      return { ok: true }
    }
    return result.ok ? { ok: false, error: `Child process ${child.pid} did not exit after taskkill.` } : result
  }

  try { process.kill(-child.pid, 'SIGTERM') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return { ok: false, error: String(error) }
  }
  const exited = await waitForChildExit(child, 2_000)
  // A worker can exit before its tool subprocesses. The detached process group
  // belongs only to this launch, so terminate surviving group members as well.
  try { process.kill(-child.pid, 'SIGKILL') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return { ok: false, error: String(error) }
  }
  const killed = exited || await waitForChildExit(child, 2_000)
  return killed ? { ok: true } : { ok: false, error: `Child process ${child.pid} did not exit after SIGKILL.` }
}

function runTaskkill(pid: number): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const taskkill = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
    })
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    taskkill.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk))
    taskkill.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk))
    taskkill.on('error', (error) => {
      resolve({ ok: false, error: error.message })
    })
    taskkill.on('close', (code) => {
      if (code === 0) {
        resolve({ ok: true })
        return
      }
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim()
      const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim()
      resolve({ ok: false, error: stderr || stdout || `taskkill exited with code ${code}.` })
    })
  })
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true)
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      cleanup()
      resolve(false)
    }, timeoutMs)
    const onClose = () => {
      cleanup()
      resolve(true)
    }
    const cleanup = () => {
      clearTimeout(timeout)
      child.removeListener('close', onClose)
    }
    child.once('close', onClose)
  })
}
