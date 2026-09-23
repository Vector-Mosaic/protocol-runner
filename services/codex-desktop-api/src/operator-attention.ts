import { spawn } from 'node:child_process'

import type { DesktopActionQueueState } from './desktop-action-queue.js'
import { createLogger } from './logger.js'

export interface OperatorGateAttentionConfig {
  enabled: boolean
  scriptPath: string
  gateUrl: string
}

export class OperatorGateAttention {
  private readonly logger = createLogger('codex_desktop_operator_attention')

  constructor(private readonly config: OperatorGateAttentionConfig) {}

  notifyGateCountdown(state: DesktopActionQueueState): void {
    if (!this.config.enabled) {
      return
    }

    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        this.config.scriptPath,
        '-Url',
        this.config.gateUrl,
        '-PendingCount',
        String(state.pending_count),
      ],
      {
        stdio: 'ignore',
        windowsHide: true,
      },
    )

    child.on('error', (error) => {
      this.logger.warn('operator_gate.attention_failed', {
        message: error instanceof Error ? error.message : String(error),
        script_path: this.config.scriptPath,
      })
    })

    child.on('exit', (code) => {
      if (code !== 0) {
        this.logger.warn('operator_gate.attention_exited_nonzero', {
          code,
          script_path: this.config.scriptPath,
        })
        return
      }

      this.logger.info('operator_gate.attention_requested', {
        pending_count: state.pending_count,
        gate_url: this.config.gateUrl,
      })
    })
  }
}
