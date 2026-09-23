import { spawn } from 'node:child_process'
import path from 'node:path'
import {
  parseLastJsonObjectLine,
  withCodexDesktopHelperLock,
  writeDesktopHelperFailureArtifact,
} from '@workstation-control/remote-core'

import type { CodexDesktopConfig } from './config.js'
import { createLogger } from './logger.js'
import type { DesktopActionMode, DesktopStateResult, DesktopVisibleThreadRow } from './types.js'

export interface DesktopAutomationController {
  state(): Promise<DesktopStateResult>
  selectThread(threadTitle: string, mode: DesktopActionMode): Promise<DesktopStateResult>
  promptThread(threadTitle: string, text: string, mode: DesktopActionMode): Promise<DesktopStateResult>
  createThread(text: string, mode: DesktopActionMode): Promise<DesktopStateResult>
  readback(expectedThreadTitle: string | null): Promise<DesktopStateResult>
}

const HELPER_TIMEOUT_MS = 60_000
const logger = createLogger('codex_desktop_controller')

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeVisibleThreadRow(value: unknown): DesktopVisibleThreadRow | null {
  if (!isRecord(value)) {
    return null
  }

  const label = typeof value.label === 'string' ? value.label.trim() : ''
  const title = typeof value.title === 'string' ? value.title.trim() : label
  if (!label && !title) {
    return null
  }

  return {
    title,
    label: label || title,
    rowName: typeof value.rowName === 'string' ? value.rowName.trim() : '',
    turnState:
      value.turnState === 'idle' || value.turnState === 'working' || value.turnState === 'unknown'
        ? value.turnState
        : 'unknown',
    indicatorText:
      typeof value.indicatorText === 'string' && value.indicatorText.trim() ? value.indicatorText.trim() : null,
    indicatorReason:
      typeof value.indicatorReason === 'string' && value.indicatorReason.trim()
        ? value.indicatorReason.trim()
        : null,
    isThreadRow: value.isThreadRow !== false,
  }
}

function normalizeHelperPayload(payload: unknown): DesktopStateResult {
  if (!isRecord(payload)) {
    return {
      result: 'error',
      message: 'Desktop helper returned no payload.',
      windowFound: false,
      threadListAccessible: false,
      visibleThreadCount: 0,
      composeAvailable: false,
      readbackAvailable: false,
      selectedSidebarThreadTitle: null,
      selectedSidebarThreadTitles: [],
      visibleThreadRows: [],
      visibleTranscriptLines: [],
      visibleTranscriptText: '',
      selectionConfirmed: null,
      expanded: null,
      composeDiagnostics: null,
    }
  }

  const record = payload
  const visibleThreadCount =
    typeof record.visibleThreadCount === 'number'
      ? record.visibleThreadCount
      : Number.isFinite(Number(record.visibleThreadCount))
        ? Number(record.visibleThreadCount)
        : 0
  const expanded =
    typeof record.expanded === 'number'
      ? record.expanded
      : Number.isFinite(Number(record.expanded))
        ? Number(record.expanded)
        : null
  return {
    result: (record.result as DesktopStateResult['result']) ?? 'error',
    message: typeof record.message === 'string' ? record.message : null,
    windowFound: Boolean(record.windowFound),
    threadListAccessible: Boolean(record.threadListAccessible),
    visibleThreadCount,
    composeAvailable: Boolean(record.composeAvailable),
    readbackAvailable: Boolean(record.readbackAvailable),
    selectedSidebarThreadTitle:
      typeof record.selectedSidebarThreadTitle === 'string' ? record.selectedSidebarThreadTitle : null,
    selectedSidebarThreadTitles: Array.isArray(record.selectedSidebarThreadTitles)
      ? record.selectedSidebarThreadTitles.filter((value): value is string => typeof value === 'string')
      : [],
    visibleThreadRows: Array.isArray(record.visibleThreadRows)
      ? record.visibleThreadRows
          .map((value) => normalizeVisibleThreadRow(value))
          .filter((value): value is DesktopVisibleThreadRow => value !== null)
      : [],
    visibleTranscriptLines: Array.isArray(record.visibleTranscriptLines)
      ? record.visibleTranscriptLines.filter((value): value is string => typeof value === 'string')
      : [],
    visibleTranscriptText: typeof record.visibleTranscriptText === 'string' ? record.visibleTranscriptText : '',
    selectionConfirmed:
      typeof record.selectionConfirmed === 'boolean' ? record.selectionConfirmed : null,
    expanded,
    composeDiagnostics: isRecord(record.composeDiagnostics) ? record.composeDiagnostics : null,
  }
}

export class PowerShellDesktopAutomationController implements DesktopAutomationController {
  constructor(private readonly config: CodexDesktopConfig) {}

  async state(): Promise<DesktopStateResult> {
    return this.runHelper(['-Action', 'state'])
  }

  async selectThread(threadTitle: string, mode: DesktopActionMode): Promise<DesktopStateResult> {
    return this.runHelper(['-Action', 'select', '-Mode', mode, '-ThreadTitle', threadTitle])
  }

  async promptThread(threadTitle: string, text: string, mode: DesktopActionMode): Promise<DesktopStateResult> {
    return this.runHelper(['-Action', 'prompt', '-Mode', mode, '-ThreadTitle', threadTitle, '-Text', text])
  }

  async createThread(text: string, mode: DesktopActionMode): Promise<DesktopStateResult> {
    return this.runHelper(['-Action', 'create', '-Mode', mode, '-Text', text])
  }

  async readback(expectedThreadTitle: string | null): Promise<DesktopStateResult> {
    const args = ['-Action', 'readback']
    if (expectedThreadTitle?.trim()) {
      args.push('-ThreadTitle', expectedThreadTitle.trim())
    }
    return this.runHelper(args)
  }

  private async runHelper(extraArgs: string[]): Promise<DesktopStateResult> {
    const startedAt = Date.now()
    const args = [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      this.config.helperScriptPath,
      '-WindowTitle',
      this.config.windowTitle,
      '-MaxShowMoreClicks',
      String(this.config.maxShowMoreClicks),
      '-AllowDirectDesktopControl',
      ...extraArgs,
    ]
    const action = helperAction(extraArgs)

    return withCodexDesktopHelperLock(
      {
        owner: 'codex-desktop-api',
        action,
      },
      () => this.runUnlockedHelper(args, startedAt, action),
    )
  }

  private async runUnlockedHelper(args: string[], startedAt: number, action: string): Promise<DesktopStateResult> {
    return new Promise<DesktopStateResult>((resolve) => {
      const child = spawn('powershell.exe', args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      let finished = false

      const finish = (payload: unknown, helperError: string | null = null) => {
        if (finished) {
          return
        }
        finished = true
        const response = normalizeHelperPayload(payload)
        logger.info('codex_desktop.helper_result', {
          result: response.result,
          duration_ms: Date.now() - startedAt,
          helper_error: helperError || undefined,
        })
        resolve(response)
      }

      const timeout = setTimeout(() => {
        child.kill()
        finish({ result: 'error', message: 'Desktop helper timed out.' }, 'helper_timeout')
      }, HELPER_TIMEOUT_MS)

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString()
      })
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString()
      })
      child.on('error', (error) => {
        clearTimeout(timeout)
        finish({ result: 'error', message: 'Desktop helper failed to start.' }, error.message)
      })
      child.on('close', async (code) => {
        if (finished) {
          return
        }
        clearTimeout(timeout)
        const parsed = parseLastJsonObjectLine(stdout)
        const payload = parsed.payload
        if (stdout.trim() && payload === null) {
          const artifactPath = await writeDesktopHelperFailureArtifact({
            owner: 'codex-desktop-api',
            action,
            reason: 'helper_json_parse',
            args,
            exitCode: code,
            stdout,
            stderr,
            artifactRoot: path.join(this.config.artifactRoot, 'helper_failures'),
          })
          logger.warn('codex_desktop.helper_parse_failure_artifact', {
            action,
            artifact_path: artifactPath,
            stdout_line_count: parsed.lineCount,
          })
        }
        if (code !== 0 && payload === null) {
          finish({ result: 'error', message: 'Desktop helper exited unexpectedly.' }, stderr.trim() || `helper_exit_${code}`)
          return
        }
        finish(payload, stderr.trim() || null)
      })
    })
  }
}

function helperAction(args: string[]): string {
  const index = args.findIndex((value) => /^-Action$/i.test(value))
  return index >= 0 ? args[index + 1] ?? 'unknown' : 'unknown'
}
