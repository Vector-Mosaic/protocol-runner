import { spawn } from 'node:child_process'

export type RunnerAttentionOutcome = 'finished' | 'needs_attention'

export interface RunnerAttentionNotification {
  run_instance_id: string
  outcome: RunnerAttentionOutcome
  status: string
  current_step_id: string | null
  reason: string
  blocked_reason?: string
  occurred_at: string
}

export interface RunnerAttentionNotifier {
  notify(notification: RunnerAttentionNotification): void | Promise<void>
}

export class NoopRunnerAttentionNotifier implements RunnerAttentionNotifier {
  notify(): void {
    // Intentionally empty for tests and disabled local installs.
  }
}

export interface ShellRunnerAttentionNotifierOptions {
  scriptPath: string
  notifyUrl: string
  repoRoot: string
}

export class ShellRunnerAttentionNotifier implements RunnerAttentionNotifier {
  constructor(private readonly options: ShellRunnerAttentionNotifierOptions) {}

  notify(notification: RunnerAttentionNotification): void {
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        this.options.scriptPath,
        '-Url',
        this.options.notifyUrl,
        '-WindowTitlePattern',
        'Protocol Runner Notification',
        '-RepoRoot',
        this.options.repoRoot,
      ],
      {
        stdio: 'ignore',
        windowsHide: true,
      },
    )

    child.on('error', (error) => {
      process.stderr.write(
        `[protocol-runner-api] notification_failed ${JSON.stringify({
          run_instance_id: notification.run_instance_id,
          outcome: notification.outcome,
          message: error instanceof Error ? error.message : String(error),
        })}\n`,
      )
    })
  }
}
