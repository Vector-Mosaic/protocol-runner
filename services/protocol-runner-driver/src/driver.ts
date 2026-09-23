import type { DriverDecision, ProtocolRunnerApiClient, RunListItem } from './types.js'

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'closed'])

export class ProtocolRunnerDriver {
  private nextIndex = 0

  constructor(
    private readonly options: {
      client: ProtocolRunnerApiClient
      onDecision?: (decision: DriverDecision) => void
    },
  ) {}

  async tick(): Promise<DriverDecision> {
    let runs: RunListItem[]
    try {
      runs = await this.options.client.listRuns()
    } catch (error) {
      return this.emit({
        action: 'api_error',
        reason: 'Failed to list protocol-runner runs.',
        error: error instanceof Error ? error.message : String(error),
      })
    }

    if (runs.length === 0) {
      return this.emit({
        action: 'no_eligible_runs',
        reason: 'No protocol-runner runs exist.',
      })
    }

    const ordered = this.roundRobinOrder(runs)
    for (const run of ordered) {
      const decision = this.decisionForRun(run)
      if (decision.action !== 'activated') {
        this.emit(decision)
        continue
      }

      try {
        const updated = await this.options.client.startRun(run.run_instance_id)
        this.nextIndex = (runs.findIndex((candidate) => candidate.run_instance_id === run.run_instance_id) + 1) % runs.length
        return this.emit({
          ...decision,
          status: updated.state.status,
          current_step_id: updated.state.current_step_id,
          reason: `Activated current ready step for ${run.run_instance_id}.`,
        })
      } catch (error) {
        return this.emit({
          action: 'api_error',
          run_instance_id: run.run_instance_id,
          status: run.status,
          current_step_id: run.current_step_id,
          reason: 'Failed to start ready run through protocol-runner-api.',
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    return this.emit({
      action: 'no_eligible_runs',
      reason: 'No ready run with auto_advance=true was found.',
    })
  }

  private decisionForRun(run: RunListItem): DriverDecision {
    if (TERMINAL_STATUSES.has(run.status)) {
      return {
        action: 'skipped_terminal',
        run_instance_id: run.run_instance_id,
        status: run.status,
        current_step_id: run.current_step_id,
        reason: `Run status=${run.status} is terminal for driver scheduling.`,
      }
    }

    if (run.status !== 'ready') {
      return {
        action: 'skipped_not_ready',
        run_instance_id: run.run_instance_id,
        status: run.status,
        current_step_id: run.current_step_id,
        reason: `Run status=${run.status}; driver only sends ready runs.`,
      }
    }

    if (run.automation?.auto_advance !== true) {
      return {
        action: 'skipped_auto_advance_disabled',
        run_instance_id: run.run_instance_id,
        status: run.status,
        current_step_id: run.current_step_id,
        reason: 'Run is ready but auto_advance=false.',
      }
    }

    return {
      action: 'activated',
      run_instance_id: run.run_instance_id,
      status: run.status,
      current_step_id: run.current_step_id,
      reason: 'Run is ready and auto_advance=true.',
    }
  }

  private roundRobinOrder(runs: RunListItem[]): RunListItem[] {
    if (runs.length === 0) {
      return []
    }

    const start = this.nextIndex % runs.length
    return [...runs.slice(start), ...runs.slice(0, start)]
  }

  private emit(decision: DriverDecision): DriverDecision {
    this.options.onDecision?.(decision)
    return decision
  }
}

export async function runDriverLoop(options: {
  driver: ProtocolRunnerDriver
  pollIntervalMs: number
  signal?: AbortSignal
}): Promise<void> {
  while (options.signal?.aborted !== true) {
    await options.driver.tick()
    await sleep(options.pollIntervalMs, options.signal)
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve()
      return
    }
    const timeout = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout)
        resolve()
      },
      { once: true },
    )
  })
}
