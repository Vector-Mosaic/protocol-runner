import { promises as fs } from 'node:fs'
import path from 'node:path'

import {
  DEFAULT_PARALLEL_HEARTBEAT_INTERVAL_MS,
  DEFAULT_PARALLEL_LEASE_TTL_MS,
} from './config.js'
import type {
  ParallelAttemptWarning,
  ParallelAttemptWarningCode,
  ParallelExecutorDecision,
  ParallelGroupState,
  ParallelLeasePacket,
  ParallelWorkerLauncher,
  ProtocolRunnerParallelApiClient,
  RunDiagnostics,
  WorkerCapability,
  WorkerRuntimeProfile,
} from './types.js'

const LEASEABLE_GROUP_STATUSES = new Set(['ready_to_lease', 'running', 'leasing'])
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'closed'])
const DEFAULT_SOFT_WARNING_MS = 20 * 60 * 1000
const DEFAULT_LAUNCH_BATCH_SIZE = 1
const DEFAULT_LAUNCH_BATCH_INTERVAL_MS = 15_000

type LaunchOutcome = { status: string } | { error: unknown }

interface LaunchBatchRunResult {
  results: string[]
  launched_count: number
  launch_batch_count: number
}

interface HeartbeatSchedule {
  last_attempt_at: number
  retry_not_before: number
}

export class ProtocolRunnerParallelExecutor {
  private readonly shutdown = new AbortController()
  private readonly activeLaunches = new Set<AbortController>()

  /** Stop accepting leases and cancel only processes launched by this instance. */
  requestShutdown(): void {
    this.shutdown.abort()
    for (const launch of this.activeLaunches) launch.abort()
  }

  constructor(
    private readonly options: {
      client: ProtocolRunnerParallelApiClient
      launcher: ParallelWorkerLauncher
      executor_id: string
      capacity: number
      launch_batch_size?: number
      launch_batch_interval_ms?: number
      lease_ttl_ms?: number
      heartbeat_interval_ms?: number
      control_poll_interval_ms?: number
      long_running_after_ms?: number
      possibly_stalled_after_ms?: number
      worker_runtime_profile?: WorkerRuntimeProfile
      sleep?: (ms: number) => Promise<void>
      onDecision?: (decision: ParallelExecutorDecision) => void
    },
  ) {}

  async tick(): Promise<ParallelExecutorDecision> {
    if (this.shutdown.signal.aborted) {
      return this.emit({ action: 'no_eligible_groups', reason: 'Executor shutdown requested; no new work is accepted.' })
    }
    let diagnostics: RunDiagnostics[]
    try {
      diagnostics = await this.discoverRunDiagnostics()
    } catch (error) {
      return this.emit({
        action: 'api_error',
        reason: 'Failed to discover protocol-runner parallel groups.',
        error: error instanceof Error ? error.message : String(error),
      })
    }

    const staleCandidate = diagnostics
      .flatMap((diagnostic) => diagnostic.parallel_groups.map((group) => ({ diagnostic, group })))
      .find((candidate) => this.hasExpiredActiveLease(candidate.group))
    if (staleCandidate !== undefined) {
      try {
        const recovery = await this.options.client.recoverStaleLeases(
          staleCandidate.diagnostic.run_instance_id,
          staleCandidate.group.group_id,
        )
        const recovered_count = recovery.recovered_count ?? recovery.stale_lease_ids?.length ?? 0
        return this.emit({
          action: 'stale_leases_recovered',
          run_instance_id: staleCandidate.diagnostic.run_instance_id,
          group_id: staleCandidate.group.group_id,
          recovered_count,
          stale_lease_ids: recovery.stale_lease_ids,
          stale_attempt_ids: recovery.stale_attempt_ids,
          stale_item_ids: recovery.stale_item_ids,
          requeued_lease_ids: recovery.requeued_lease_ids,
          requeued_attempt_ids: recovery.requeued_attempt_ids,
          requeued_item_ids: recovery.requeued_item_ids,
          attention_lease_ids: recovery.attention_lease_ids,
          attention_attempt_ids: recovery.attention_attempt_ids,
          attention_item_ids: recovery.attention_item_ids,
          reason: `Parallel executor asked the API to recover ${recovered_count} stale lease(s).`,
        })
      } catch (error) {
        return this.emit({
          action: 'api_error',
          run_instance_id: staleCandidate.diagnostic.run_instance_id,
          group_id: staleCandidate.group.group_id,
          reason: 'Failed to recover stale parallel leases through protocol-runner-api.',
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const candidate = diagnostics
      .flatMap((diagnostic) => this.eligibleGroups(diagnostic).map((group) => ({ diagnostic, group })))
      .at(0)

    if (candidate === undefined) {
      return this.emit({
        action: 'no_eligible_groups',
        reason: 'No preflight-passed leaseable parallel group was found.',
      })
    }

    const missingCapabilities = this.missingRequiredCapabilities(candidate.group)
    if (missingCapabilities.length > 0) {
      const requiredCapabilities = this.requiredCapabilities(candidate.group)
      const availableCapabilities = this.availableCapabilities()
      const reason = `Parallel group ${candidate.group.group_id} requires worker capabilities [${requiredCapabilities.join(', ')}], but executor ${this.options.executor_id} profile provides [${availableCapabilities.join(', ')}]; missing [${missingCapabilities.join(', ')}].`
      try {
        await this.options.client.controlParallelGroup(candidate.diagnostic.run_instance_id, candidate.group.group_id, 'stop', {
          reason,
        })
      } catch (error) {
        return this.emit({
          action: 'api_error',
          run_instance_id: candidate.diagnostic.run_instance_id,
          group_id: candidate.group.group_id,
          required_worker_capabilities: requiredCapabilities,
          available_worker_capabilities: availableCapabilities,
          missing_worker_capabilities: missingCapabilities,
          reason: 'Failed to stop parallel group after missing required worker capability preflight.',
          error: error instanceof Error ? error.message : String(error),
        })
      }
      return this.emit({
        action: 'missing_required_capabilities',
        run_instance_id: candidate.diagnostic.run_instance_id,
        group_id: candidate.group.group_id,
        required_worker_capabilities: requiredCapabilities,
        available_worker_capabilities: availableCapabilities,
        missing_worker_capabilities: missingCapabilities,
        reason,
      })
    }

    try {
      const available = this.availableCapacity(candidate.group)
      if (available < 1) {
        return this.emit({
          action: 'no_leases_granted',
          run_instance_id: candidate.diagnostic.run_instance_id,
          group_id: candidate.group.group_id,
          reason: `Parallel group ${candidate.group.group_id} has no local/API capacity available.`,
        })
      }

      const launchBatchResult = await this.launchAvailableCapacity(candidate.diagnostic, candidate.group, available)
      if (launchBatchResult.launched_count === 0) {
        return this.emit({
          action: 'no_leases_granted',
          run_instance_id: candidate.diagnostic.run_instance_id,
          group_id: candidate.group.group_id,
          reason: `API granted zero leases for ${candidate.group.group_id}.`,
        })
      }

      return this.emit({
        action: 'launched',
        run_instance_id: candidate.diagnostic.run_instance_id,
        group_id: candidate.group.group_id,
        launched_count: launchBatchResult.launched_count,
        launch_batch_count: launchBatchResult.launch_batch_count,
        launch_batch_size: this.launchBatchSize(),
        launch_batch_interval_ms: this.launchBatchIntervalMs(),
        completed_count: launchBatchResult.results.filter((result) => result === 'completed').length,
        blocked_count: launchBatchResult.results.filter((result) => result === 'blocked').length,
        needs_attention_count: launchBatchResult.results.filter((result) => result !== 'completed' && result !== 'blocked').length,
        reason: `Parallel executor launched and reported ${launchBatchResult.launched_count} lease(s).`,
      })
    } catch (error) {
      return this.emit({
        action: 'launcher_error',
        run_instance_id: candidate.diagnostic.run_instance_id,
        group_id: candidate.group.group_id,
        reason: 'Failed to launch or report a fake parallel worker attempt.',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async drain(options: { maxTicks: number }): Promise<ParallelExecutorDecision[]> {
    const decisions: ParallelExecutorDecision[] = []
    for (let index = 0; index < options.maxTicks; index += 1) {
      const decision = await this.tick()
      decisions.push(decision)
      if (decision.action !== 'launched') {
        break
      }
    }
    return decisions
  }

  private async discoverRunDiagnostics(): Promise<RunDiagnostics[]> {
    const runs = await this.options.client.listRuns()
    const candidates = runs.filter((run) => !TERMINAL_RUN_STATUSES.has(run.status))
    const diagnostics: RunDiagnostics[] = []
    for (const run of candidates) {
      diagnostics.push(await this.options.client.getRunDiagnostics(run.run_instance_id))
    }
    return diagnostics
  }

  private eligibleGroups(diagnostic: RunDiagnostics): ParallelGroupState[] {
    if (TERMINAL_RUN_STATUSES.has(diagnostic.status)) {
      return []
    }
    return diagnostic.parallel_groups.filter((group) => {
      if (group.preflight_status !== 'passed') {
        return false
      }
      if (!LEASEABLE_GROUP_STATUSES.has(group.status)) {
        return false
      }
      return this.availableCapacity(group) > 0
    })
  }

  private availableCapacity(group: ParallelGroupState): number {
    const activeLeases = group.leases.filter((lease) => lease.status === 'active').length
    return Math.max(0, Math.min(this.options.capacity, group.max_concurrency - activeLeases))
  }

  private requiredCapabilities(group: ParallelGroupState): WorkerCapability[] {
    return group.required_worker_capabilities ?? []
  }

  private availableCapabilities(): WorkerCapability[] {
    return this.options.worker_runtime_profile?.capabilities ?? ['base']
  }

  private missingRequiredCapabilities(group: ParallelGroupState): WorkerCapability[] {
    const available = new Set(this.availableCapabilities())
    return this.requiredCapabilities(group).filter((capability) => !available.has(capability))
  }

  private async launchAvailableCapacity(
    diagnostic: RunDiagnostics,
    group: ParallelGroupState,
    available: number,
  ): Promise<LaunchBatchRunResult> {
    const launchPromises: Promise<LaunchOutcome>[] = []
    let launched_count = 0
    let launch_batch_count = 0
    let launchSetupError: unknown

    try {
      while (launched_count < available && !this.shutdown.signal.aborted) {
        const requestedCapacity = Math.min(this.launchBatchSize(), available - launched_count)
        const granted = await this.options.client.grantLeases(diagnostic.run_instance_id, group.group_id, {
          executor_id: this.options.executor_id,
          capacity: requestedCapacity,
          lease_ttl_ms: this.leaseTtlMs(),
        })
        const leases = granted.leases ?? []
        if (leases.length === 0) {
          break
        }

        launch_batch_count += 1
        launched_count += leases.length
        launchPromises.push(
          ...leases.map((lease) =>
            this.launchAndSubmit(lease).then(
              (status) => ({ status }),
              (error: unknown) => ({ error }),
            ),
          ),
        )

        if (leases.length < requestedCapacity || launched_count >= available) {
          break
        }
        await this.sleep(this.launchBatchIntervalMs())
      }
    } catch (error) {
      launchSetupError = error
    }

    const outcomes = await Promise.all(launchPromises)
    const failed = outcomes.find((outcome): outcome is { error: unknown } => 'error' in outcome)
    if (failed !== undefined) {
      throw failed.error
    }
    if (launchSetupError !== undefined) {
      throw launchSetupError
    }

    return {
      results: outcomes.map((outcome) => ('status' in outcome ? outcome.status : 'failed')),
      launched_count,
      launch_batch_count,
    }
  }

  private hasExpiredActiveLease(group: ParallelGroupState): boolean {
    const now = Date.now()
    return group.leases.some((lease) => {
      if (lease.status !== 'active') {
        return false
      }
      const expiresAt =
        lease.expires_at === null
          ? Date.parse(lease.heartbeat_at ?? lease.leased_at) + this.leaseTtlMs()
          : Date.parse(lease.expires_at)
      return !Number.isNaN(expiresAt) && expiresAt <= now
    })
  }

  private async launchAndSubmit(lease: ParallelLeasePacket): Promise<string> {
    if (this.shutdown.signal.aborted) {
      await this.options.client.submitAttemptResult(lease.run_instance_id, lease.group_id, lease.attempt_id, {
        lease_id: lease.lease_id, attempt_id: lease.attempt_id, launcher_status: 'cancelled',
        summary: 'Executor shutdown requested before worker launch.',
      })
      return 'cancelled'
    }
    // Prove the API still recognizes this lease before creating any evidence.
    // If the API is unreachable, leave the directory absent so bounded stale
    // recovery can safely reacquire work that never entered launch/setup.
    await this.options.client.heartbeat(lease.run_instance_id, lease.group_id, lease.lease_id)
    try {
      // Directory existence is the durable boundary between a never-started lease and
      // any launch/setup work. Stale recovery may automatically reuse only the former.
      await assertSafeAttemptDirectorySetup(lease.run_dir, lease.attempt_dir)
      await fs.mkdir(lease.attempt_dir, { recursive: true })
      await assertSafeAttemptDirectorySetup(lease.run_dir, lease.attempt_dir)
      // Revalidate after establishing the evidence boundary so recovery cannot
      // expire/requeue the lease between the first heartbeat and launcher entry.
      await this.options.client.heartbeat(lease.run_instance_id, lease.group_id, lease.lease_id)
    } catch (error) {
      await this.reportLauncherFailure(lease, error)
      return 'failed'
    }
    if (this.shutdown.signal.aborted) {
      await this.options.client.submitAttemptResult(lease.run_instance_id, lease.group_id, lease.attempt_id, {
        lease_id: lease.lease_id, attempt_id: lease.attempt_id, launcher_status: 'cancelled',
        summary: 'Executor shutdown requested during worker setup; no process was launched.',
      })
      return 'cancelled'
    }
    const launchAbort = new AbortController()
    this.activeLaunches.add(launchAbort)
    if (this.shutdown.signal.aborted) launchAbort.abort()
    let launchFinished = false
    const reportedWarningCodes = new Set<ParallelAttemptWarningCode>()
    const monitor = this.monitorLeaseControl(lease, launchAbort, () => launchFinished, reportedWarningCodes)
    let result: Awaited<ReturnType<ParallelWorkerLauncher['launch']>> | undefined
    let launchError: unknown
    try {
      result = await this.options.launcher.launch(lease, { signal: launchAbort.signal })
    } catch (error) {
      launchError = error
    } finally {
      launchFinished = true
      this.activeLaunches.delete(launchAbort)
    }
    await monitor
    if (launchAbort.signal.aborted && !this.shutdown.signal.aborted) {
      return 'cancelled'
    }
    if (launchError !== undefined || result === undefined) {
      await this.reportLauncherFailure(lease, launchError ?? new Error('Parallel worker launcher returned no result.'))
      return 'failed'
    }
    await this.options.client.submitAttemptResult(lease.run_instance_id, lease.group_id, lease.attempt_id, {
      lease_id: lease.lease_id,
      attempt_id: lease.attempt_id,
      launcher_status: result.launcher_status,
      ...(result.status_report !== undefined ? { status_report: result.status_report } : {}),
      process: result.process,
      ...(result.result_file.status_report_path !== undefined
        ? { status_report_path: result.result_file.status_report_path }
        : {}),
      ...(result.result_file.sealed_output_path !== undefined
        ? { sealed_output_path: result.result_file.sealed_output_path }
        : {}),
      result_path: lease.result_path,
      summary: result.result_file.summary,
    })
    return result.launcher_status
  }

  private async reportLauncherFailure(lease: ParallelLeasePacket, error: unknown): Promise<void> {
    const summary = error instanceof Error ? error.message : String(error)
    await this.options.client.submitAttemptResult(lease.run_instance_id, lease.group_id, lease.attempt_id, {
      lease_id: lease.lease_id,
      attempt_id: lease.attempt_id,
      launcher_status: 'failed',
      summary: `Parallel worker launch/setup failed before a launcher result was produced: ${summary}`,
    })
  }

  private async monitorLeaseControl(
    lease: ParallelLeasePacket,
    launchAbort: AbortController,
    isLaunchFinished: () => boolean,
    reportedWarningCodes: Set<ParallelAttemptWarningCode>,
  ): Promise<void> {
    const pollIntervalMs = this.options.control_poll_interval_ms ?? 250
    let heartbeatSchedule: HeartbeatSchedule = {
      last_attempt_at: Date.now(),
      retry_not_before: 0,
    }
    while (!isLaunchFinished() && !launchAbort.signal.aborted) {
      await sleep(pollIntervalMs, launchAbort.signal)
      if (isLaunchFinished() || launchAbort.signal.aborted) {
        return
      }
      heartbeatSchedule = await this.heartbeatLeaseIfDue(lease, reportedWarningCodes, heartbeatSchedule)
      let group: ParallelGroupState
      try {
        group = (await this.options.client.getParallelGroup(lease.run_instance_id, lease.group_id)).group
      } catch {
        continue
      }
      if (this.launchShouldAbort(lease, group)) {
        launchAbort.abort()
        return
      }
    }
  }

  private launchShouldAbort(lease: ParallelLeasePacket, group: ParallelGroupState): boolean {
    if (group.status === 'stopped' || group.status === 'cancelled') {
      return true
    }
    const leaseState = group.leases.find((candidate) => candidate.lease_id === lease.lease_id)
    if (leaseState !== undefined && leaseState.status !== 'active') {
      return true
    }
    const attemptState = group.attempts.find((candidate) => candidate.attempt_id === lease.attempt_id)
    return attemptState?.status === 'cancelled' || attemptState?.status === 'stale'
  }

  private async heartbeatLeaseIfDue(
    lease: ParallelLeasePacket,
    reportedWarningCodes: Set<ParallelAttemptWarningCode>,
    schedule: HeartbeatSchedule,
  ): Promise<HeartbeatSchedule> {
    const observedAt = Date.now()
    const attempt_warnings = await this.collectDueAttemptWarnings(lease, reportedWarningCodes)
    if (observedAt < schedule.retry_not_before) {
      return schedule
    }
    if (attempt_warnings.length === 0 && observedAt - schedule.last_attempt_at < this.heartbeatIntervalMs()) {
      return schedule
    }
    try {
      await this.options.client.heartbeat(lease.run_instance_id, lease.group_id, lease.lease_id, {
        ...(attempt_warnings.length > 0 ? { attempt_warnings } : {}),
      })
      for (const warning of attempt_warnings) {
        reportedWarningCodes.add(warning.code)
      }
      return {
        last_attempt_at: observedAt,
        retry_not_before: 0,
      }
    } catch {
      // A transient heartbeat failure must not become a hidden cancellation path;
      // keep retries interval-bounded while API-owned expiry/recovery remains
      // the authority if the grace window closes.
      return {
        last_attempt_at: observedAt,
        retry_not_before: observedAt + this.heartbeatIntervalMs(),
      }
    }
  }

  private async collectDueAttemptWarnings(
    lease: ParallelLeasePacket,
    reportedWarningCodes: Set<ParallelAttemptWarningCode>,
  ): Promise<ParallelAttemptWarning[]> {
    const now = Date.now()
    const observed_at = new Date(now).toISOString()
    const leasedAt = Date.parse(lease.leased_at)
    const startedAt = Number.isNaN(leasedAt) ? now : leasedAt
    const elapsed_ms = Math.max(0, now - startedAt)
    const warnings: ParallelAttemptWarning[] = []
    const longRunningAfter = this.options.long_running_after_ms ?? DEFAULT_SOFT_WARNING_MS
    const possiblyStalledAfter = this.options.possibly_stalled_after_ms ?? DEFAULT_SOFT_WARNING_MS

    if (!reportedWarningCodes.has('long_running') && elapsed_ms >= longRunningAfter) {
      warnings.push({
        code: 'long_running',
        severity: 'warning',
        message: `Parallel worker attempt ${lease.attempt_id} has been active for ${elapsed_ms}ms.`,
        observed_at,
        threshold_ms: longRunningAfter,
        elapsed_ms,
        details: {
          lease_id: lease.lease_id,
          process_active: true,
        },
      })
    }

    if (!reportedWarningCodes.has('possibly_stalled')) {
      const lastEvidenceMs = Math.floor((await latestAttemptEvidenceMtimeMs(lease.attempt_dir)) ?? startedAt)
      const quiet_ms = Math.max(0, Math.floor(now - lastEvidenceMs))
      if (quiet_ms >= possiblyStalledAfter) {
        warnings.push({
          code: 'possibly_stalled',
          severity: 'warning',
          message: `Parallel worker attempt ${lease.attempt_id} has no new attempt evidence for ${quiet_ms}ms.`,
          observed_at,
          threshold_ms: possiblyStalledAfter,
          elapsed_ms,
          quiet_ms,
          last_observed_evidence_at: new Date(lastEvidenceMs).toISOString(),
          details: {
            lease_id: lease.lease_id,
            process_active: true,
          },
        })
      }
    }

    return warnings
  }

  private emit(decision: ParallelExecutorDecision): ParallelExecutorDecision {
    this.options.onDecision?.(decision)
    return decision
  }

  private launchBatchSize(): number {
    return this.options.launch_batch_size ?? DEFAULT_LAUNCH_BATCH_SIZE
  }

  private launchBatchIntervalMs(): number {
    return this.options.launch_batch_interval_ms ?? DEFAULT_LAUNCH_BATCH_INTERVAL_MS
  }

  private leaseTtlMs(): number {
    return this.options.lease_ttl_ms ?? DEFAULT_PARALLEL_LEASE_TTL_MS
  }

  private heartbeatIntervalMs(): number {
    return this.options.heartbeat_interval_ms ?? DEFAULT_PARALLEL_HEARTBEAT_INTERVAL_MS
  }

  private sleep(ms: number): Promise<void> {
    return this.options.sleep?.(ms) ?? sleep(ms, this.shutdown.signal)
  }
}

async function assertSafeAttemptDirectorySetup(run_dir: string, attempt_dir: string): Promise<void> {
  const resolvedRunDir = path.resolve(run_dir)
  const resolvedAttemptDir = path.resolve(attempt_dir)
  if (resolvedAttemptDir === resolvedRunDir || !pathIsInside(resolvedRunDir, resolvedAttemptDir)) {
    throw new Error(`Attempt directory escapes its runner-owned run directory: ${resolvedAttemptDir}`)
  }

  let physicalRunDir: string
  try {
    physicalRunDir = await fs.realpath(resolvedRunDir)
    if (!(await fs.stat(physicalRunDir)).isDirectory()) {
      throw new Error('Runner-owned run path is not a directory.')
    }
  } catch (error) {
    throw new Error(`Cannot establish the physical runner-owned run directory: ${String(error)}`)
  }

  const relativeParts = path.relative(resolvedRunDir, resolvedAttemptDir).split(path.sep).filter(Boolean)
  let current = resolvedRunDir
  for (const part of relativeParts) {
    current = path.join(current, part)
    let entry: Awaited<ReturnType<typeof fs.lstat>>
    try {
      entry = await fs.lstat(current)
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
        return
      }
      throw new Error(`Cannot inspect attempt-directory ancestor ${current}: ${String(error)}`)
    }
    if (entry.isSymbolicLink()) {
      throw new Error(`Attempt-directory ancestor is a symbolic link or junction: ${current}`)
    }
    if (!entry.isDirectory()) {
      throw new Error(`Attempt-directory ancestor is not a directory: ${current}`)
    }
    let physicalCurrent: string
    try {
      physicalCurrent = await fs.realpath(current)
    } catch (error) {
      throw new Error(`Cannot resolve attempt-directory ancestor ${current}: ${String(error)}`)
    }
    if (!pathIsInside(physicalRunDir, physicalCurrent)) {
      throw new Error(`Attempt-directory ancestor resolves outside its runner-owned run directory: ${current}`)
    }
  }
}

function pathIsInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

async function latestAttemptEvidenceMtimeMs(root: string): Promise<number | null> {
  let latest: number | null = null

  async function walk(current: string): Promise<void> {
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
        return
      }
      throw error
    }

    for (const entry of entries) {
      const entryPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(entryPath)
        continue
      }
      if (!entry.isFile()) {
        continue
      }
      const stat = await fs.stat(entryPath)
      latest = Math.max(latest ?? 0, stat.mtimeMs)
    }
  }

  await walk(root)
  return latest
}

export async function runParallelExecutorLoop(options: {
  executor: ProtocolRunnerParallelExecutor
  pollIntervalMs: number
  signal?: AbortSignal
}): Promise<void> {
  while (options.signal?.aborted !== true) {
    await options.executor.tick()
    await sleep(options.pollIntervalMs, options.signal)
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve()
      return
    }
    const onAbort = () => {
      clearTimeout(timeout)
      resolve()
    }
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
