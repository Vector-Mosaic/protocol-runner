import { randomUUID } from 'node:crypto'

export type DesktopQueueGateStatus = 'idle' | 'countdown' | 'held' | 'executing'
export type DesktopQueuedActionKind = 'select-thread' | 'prompt' | 'create-thread' | 'readback'

export interface DesktopQueuedActionSummary {
  kind: DesktopQueuedActionKind
  caller: string
  target_thread_id?: string | null
  target_thread_title?: string | null
  summary: string
}

export interface DesktopQueuedActionState extends DesktopQueuedActionSummary {
  action_id: string
  queued_at: string
}

export interface DesktopActionQueueState {
  gate_status: DesktopQueueGateStatus
  auto_allow_ms: number
  countdown_started_at: string | null
  held_since: string | null
  executing_since: string | null
  desktop_control_released_at: string | null
  pending_count: number
  executing_count: number
  last_snapshot_count: number
  pending_actions: DesktopQueuedActionState[]
  executing_actions: DesktopQueuedActionState[]
}

type CountdownStartedHandler = (state: DesktopActionQueueState) => void | Promise<void>

interface DesktopQueueItem<T> {
  state: DesktopQueuedActionState
  run: () => Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

export class DesktopActionQueue {
  private pending: Array<DesktopQueueItem<unknown>> = []
  private executing: DesktopQueuedActionState[] = []
  private gate_status: DesktopQueueGateStatus = 'idle'
  private countdown_started_at: string | null = null
  private held_since: string | null = null
  private executing_since: string | null = null
  private desktop_control_released_at: string | null = null
  private last_snapshot_count = 0
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly options: {
      auto_allow_ms: number
      now?: () => Date
      id_factory?: () => string
      on_countdown_started?: CountdownStartedHandler
    },
  ) {}

  enqueue<T>(summary: DesktopQueuedActionSummary, run: () => Promise<T>): Promise<T> {
    const state: DesktopQueuedActionState = {
      ...summary,
      action_id: this.options.id_factory?.() ?? randomUUID(),
      queued_at: this.nowIso(),
    }

    const promise = new Promise<T>((resolve, reject) => {
      this.pending.push({
        state,
        run,
        resolve: resolve as (value: unknown) => void,
        reject,
      })
    })

    this.ensureGate()
    return promise
  }

  state(): DesktopActionQueueState {
    return {
      gate_status: this.gate_status,
      auto_allow_ms: this.options.auto_allow_ms,
      countdown_started_at: this.countdown_started_at,
      held_since: this.held_since,
      executing_since: this.executing_since,
      desktop_control_released_at: this.desktop_control_released_at,
      pending_count: this.pending.length,
      executing_count: this.executing.length,
      last_snapshot_count: this.last_snapshot_count,
      pending_actions: this.pending.map((item) => item.state),
      executing_actions: [...this.executing],
    }
  }

  wait(): DesktopActionQueueState {
    if (this.pending.length === 0 && this.gate_status === 'idle') {
      return this.state()
    }

    if (this.gate_status === 'countdown' || this.gate_status === 'idle') {
      this.clearTimer()
      this.gate_status = 'held'
      this.countdown_started_at = null
      this.held_since = this.nowIso()
    }

    return this.state()
  }

  allowNow(): DesktopActionQueueState {
    if (this.gate_status === 'countdown' || this.gate_status === 'held') {
      void this.releaseSnapshot()
    }

    return this.state()
  }

  private ensureGate(): void {
    if (this.pending.length === 0 || this.gate_status !== 'idle') {
      return
    }

    this.desktop_control_released_at = null
    if (this.options.auto_allow_ms <= 0) {
      void this.releaseSnapshot()
      return
    }

    this.gate_status = 'countdown'
    this.countdown_started_at = this.nowIso()
    this.held_since = null
    this.notifyCountdownStarted()
    this.timer = setTimeout(() => {
      void this.releaseSnapshot()
    }, this.options.auto_allow_ms)
  }

  private notifyCountdownStarted(): void {
    try {
      void Promise.resolve(this.options.on_countdown_started?.(this.state())).catch(() => {})
    } catch {
      // Gate execution must not depend on the operator-attention side effect.
    }
  }

  private async releaseSnapshot(): Promise<void> {
    if (this.gate_status === 'executing') {
      return
    }

    this.clearTimer()
    const snapshot = this.pending
    this.pending = []
    this.executing = snapshot.map((item) => item.state)
    this.last_snapshot_count = snapshot.length
    this.gate_status = 'executing'
    this.countdown_started_at = null
    this.held_since = null
    this.executing_since = this.nowIso()

    for (const item of snapshot) {
      try {
        item.resolve(await item.run())
      } catch (error) {
        item.reject(error)
      } finally {
        this.executing = this.executing.filter((state) => state.action_id !== item.state.action_id)
      }
    }

    this.gate_status = 'idle'
    this.executing_since = null
    this.desktop_control_released_at = this.nowIso()
    this.ensureGate()
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private nowIso(): string {
    return (this.options.now ?? (() => new Date()))().toISOString()
  }
}
