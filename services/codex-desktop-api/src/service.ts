import type { CodexBoundary } from '@workstation-control/codex-thread-core'
import {
  matchesWorkspaceRoot,
  toThreadSummary,
  type ThreadSummary,
} from '@workstation-control/remote-core'

import type { CodexDesktopConfig } from './config.js'
import { DesktopActionQueue } from './desktop-action-queue.js'
import type { DesktopAutomationController } from './desktop-controller.js'
import { createLogger } from './logger.js'
import { OperatorGateAttention } from './operator-attention.js'
import type {
  DesktopActionEnvelope,
  DesktopActionMode,
  DesktopCreateRequest,
  DesktopPromptRequest,
  DesktopStateResult,
  DesktopThreadRequest,
} from './types.js'

interface ResolvedDesktopThread {
  thread: ThreadSummary
  desktopThreadTitle: string
  reconcile: boolean
}

export class CodexDesktopServiceError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly errorCode: string,
  ) {
    super(message)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function assertNoRetiredDeliveryMode(request: object): void {
  if (Object.prototype.hasOwnProperty.call(request, 'deliveryMode')) {
    throw new CodexDesktopServiceError(
      'deliveryMode is retired. Codex Desktop prompt/create actions always use the visible Desktop path.',
      400,
      'delivery_mode_retired',
    )
  }
}

function defaultEnvelope(result: DesktopStateResult, thread: ThreadSummary | null): DesktopActionEnvelope {
  return {
    ...result,
    threadId: thread?.id ?? null,
    threadTitle: thread?.title ?? null,
    turnId: null,
    itemId: null,
    selectionConfirmed: result.selectionConfirmed ?? null,
    expanded: result.expanded ?? null,
  }
}

export class CodexDesktopService {
  private readonly logger = createLogger('codex_desktop')
  private readonly actionQueue: DesktopActionQueue
  private readonly operatorAttention: OperatorGateAttention

  constructor(
    private readonly deps: {
      config: CodexDesktopConfig
      boundary: CodexBoundary
      controller: DesktopAutomationController
    },
  ) {
    this.operatorAttention = new OperatorGateAttention({
      enabled: deps.config.operatorGateAttentionEnabled,
      gateUrl: deps.config.operatorGateAttentionUrl,
      scriptPath: deps.config.operatorGateAttentionScriptPath,
    })
    this.actionQueue = new DesktopActionQueue({
      auto_allow_ms: deps.config.operatorGateAutoAllowMs,
      on_countdown_started: (state) => {
        this.operatorAttention.notifyGateCountdown(state)
      },
    })
  }

  async initialize(): Promise<void> {
    await this.deps.boundary.start()
    await this.deps.boundary.sanityCheck()
  }

  async state(): Promise<DesktopStateResult> {
    const state = await this.deps.controller.state()
    return {
      ...state,
      desktopActionQueue: this.actionQueue.state(),
    } as DesktopStateResult
  }

  async selectThread(request: DesktopThreadRequest): Promise<DesktopActionEnvelope> {
    return this.actionQueue.enqueue(
      this.queueSummary('select-thread', request, 'Select Codex Desktop thread.'),
      async () => {
        const target = await this.resolveThread(request)
        const result = await this.deps.controller.selectThread(target.desktopThreadTitle, this.readMode(request.mode))
        return {
          ...defaultEnvelope(result, target.thread),
          selectionConfirmed: result.result === 'applied',
        }
      },
    )
  }

  async promptThread(request: DesktopPromptRequest): Promise<DesktopActionEnvelope> {
    assertNoRetiredDeliveryMode(request)
    const text = request.text?.trim() || ''
    if (!text) {
      throw new CodexDesktopServiceError('Prompt text is required.', 400, 'prompt_required')
    }

    return this.actionQueue.enqueue(
      this.queueSummary('prompt', request, `Send prompt (${text.length} chars).`),
      async () => this.promptDesktopThread(request, text),
    )
  }

  private async promptDesktopThread(
    request: DesktopPromptRequest,
    text: string,
  ): Promise<DesktopActionEnvelope> {
    const threadTitle = request.threadTitle?.trim() || null
    if (!threadTitle) {
      throw new CodexDesktopServiceError(
        'threadTitle is required for visible Codex Desktop prompt delivery.',
        400,
        'thread_title_required',
      )
    }

    const thread = this.desktopOnlyThread(request.threadId?.trim() || `visible-sidebar:${threadTitle}`, threadTitle)
    const result = await this.deps.controller.promptThread(threadTitle, text, this.readMode(request.mode))
    return {
      ...defaultEnvelope(
        {
          ...result,
          message: result.message ?? 'Prompt submitted through the visible Codex Desktop sidebar boundary.',
        },
        thread,
      ),
      selectionConfirmed: result.selectionConfirmed ?? null,
    }
  }

  async createThread(request: DesktopCreateRequest): Promise<DesktopActionEnvelope> {
    assertNoRetiredDeliveryMode(request)
    const text = request.text?.trim() || ''
    if (!text) {
      throw new CodexDesktopServiceError('Prompt text is required.', 400, 'prompt_required')
    }

    return this.actionQueue.enqueue(
      {
        kind: 'create-thread',
        caller: request.caller?.trim() || 'codex-desktop-api',
        summary: `Create Codex Desktop thread (${text.length} chars).`,
      },
      async () => {
        const beforeThreads = await this.listWorkspaceThreads()
        const beforeIds = new Set(beforeThreads.map((thread) => thread.id))
        const result = await this.deps.controller.createThread(text, this.readMode(request.mode))
        const reconciledThread = await this.reconcileCreatedThread(beforeIds, result.selectedSidebarThreadTitle)
        const visibleTitle = result.selectedSidebarThreadTitle ?? 'created-thread'
        return {
          ...defaultEnvelope(
            {
              ...result,
              message: result.message ?? 'Thread created through the visible Codex Desktop sidebar boundary.',
            },
            reconciledThread ?? this.desktopOnlyThread(`visible-sidebar:${visibleTitle}`, visibleTitle),
          ),
          selectionConfirmed: result.selectionConfirmed ?? null,
        }
      },
    )
  }

  async readback(request: DesktopThreadRequest): Promise<DesktopActionEnvelope> {
    return this.actionQueue.enqueue(
      this.queueSummary('readback', request, 'Read visible Codex Desktop state.'),
      async () => {
        const target = request.threadId || request.threadTitle ? await this.resolveThread(request) : null
        const result = await this.deps.controller.readback(target?.desktopThreadTitle ?? null)
        return {
          ...defaultEnvelope(result, target?.thread ?? null),
          selectionConfirmed: result.result === 'applied',
        }
      },
    )
  }

  operatorGateState() {
    return this.actionQueue.state()
  }

  operatorGateWait() {
    return this.actionQueue.wait()
  }

  operatorGateAllowNow() {
    return this.actionQueue.allowNow()
  }

  private readMode(mode: DesktopActionMode | null | undefined): DesktopActionMode {
    return mode === 'auto' ? 'auto' : 'focus'
  }

  private async listWorkspaceThreads() {
    const threads = await this.deps.boundary.listThreads()
    return threads
      .filter((thread) => matchesWorkspaceRoot(thread.cwd, this.deps.config.allowedWorkspaceRoot))
      .map((thread) => toThreadSummary(thread))
  }

  private async resolveThread(request: DesktopThreadRequest): Promise<ResolvedDesktopThread> {
    const threadId = request.threadId?.trim() || null
    const threadTitle = request.threadTitle?.trim() || null
    if (!threadId && !threadTitle) {
      throw new CodexDesktopServiceError('threadId or threadTitle is required.', 400, 'thread_selector_required')
    }

    const threads = await this.listWorkspaceThreads()
    if (threadId) {
      const match =
        threads.find((thread) => thread.id === threadId) ??
        (await this.readWorkspaceThread(threadId)) ??
        (await this.resumeAndReadWorkspaceThread(threadId))
      if (!match) {
        if (threadTitle) {
          this.logger.warn('codex_desktop.resolve_thread_desktop_only', {
            thread_id: threadId,
            thread_title: threadTitle,
          })
          return {
            thread: this.desktopOnlyThread(threadId, threadTitle),
            desktopThreadTitle: threadTitle,
            reconcile: false,
          }
        }
        throw new CodexDesktopServiceError(`Unknown worker thread: ${threadId}`, 404, 'thread_not_found')
      }
      return {
        thread: match,
        desktopThreadTitle: threadTitle ?? match.title,
        reconcile: true,
      }
    }

    const matches = threads.filter((thread) => thread.title === threadTitle)
    if (matches.length === 0) {
      throw new CodexDesktopServiceError(`Unknown worker thread title: ${threadTitle}`, 404, 'thread_not_found')
    }
    if (matches.length > 1) {
      throw new CodexDesktopServiceError(`Thread title is ambiguous: ${threadTitle}`, 409, 'thread_title_ambiguous')
    }
    return {
      thread: matches[0]!,
      desktopThreadTitle: matches[0]!.title,
      reconcile: true,
    }
  }

  private async resumeAndReadWorkspaceThread(threadId: string): Promise<ThreadSummary | null> {
    try {
      await this.deps.boundary.resumeThread(threadId)
    } catch (error) {
      this.logger.warn('codex_desktop.resolve_thread_resume_failed', {
        thread_id: threadId,
        message: error instanceof Error ? error.message : String(error),
      })
      return null
    }

    return this.readWorkspaceThread(threadId)
  }

  private async readWorkspaceThread(threadId: string): Promise<ThreadSummary | null> {
    try {
      const read = await this.deps.boundary.readThread(threadId)
      if (!matchesWorkspaceRoot(read.thread.cwd, this.deps.config.allowedWorkspaceRoot)) {
        return null
      }
      return toThreadSummary(read.thread)
    } catch (error) {
      this.logger.warn('codex_desktop.resolve_thread_read_fallback_failed', {
        thread_id: threadId,
        message: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  }

  private desktopOnlyThread(threadId: string, threadTitle: string): ThreadSummary {
    return {
      id: threadId,
      title: threadTitle,
      preview: threadTitle,
      cwd: this.deps.config.allowedWorkspaceRoot,
      createdAt: null,
      updatedAt: null,
      source: 'desktop-only',
      status: 'done',
    }
  }

  private queueSummary(
    kind: 'select-thread' | 'prompt' | 'readback',
    request: DesktopThreadRequest,
    summary: string,
  ) {
    return {
      kind,
      caller: request.caller?.trim() || 'codex-desktop-api',
      target_thread_id: request.threadId ?? null,
      target_thread_title: request.threadTitle ?? null,
      summary,
    }
  }

  private async reconcileCreatedThread(beforeIds: Set<string>, selectedThreadTitle: string | null): Promise<ThreadSummary | null> {
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const threads = await this.listWorkspaceThreads()
      const unseen = threads.filter((thread) => !beforeIds.has(thread.id))
      if (unseen.length === 1) {
        return unseen[0]!
      }
      if (unseen.length > 1 && selectedThreadTitle?.trim()) {
        const match = unseen.find((thread) => normalizeText(thread.title).startsWith(normalizeText(selectedThreadTitle)))
        if (match) {
          return match
        }
      }
      if (unseen.length > 0) {
        return unseen
          .slice()
          .sort((left, right) => (right.updatedAt || '').localeCompare(left.updatedAt || ''))[0] ?? null
      }

      await sleep(350)
    }

    this.logger.warn('codex_desktop.create_reconcile_timeout')
    return null
  }
}
