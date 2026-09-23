import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

import type { CodexBoundary } from '@workstation-control/codex-thread-core'
import type { CodexRawThreadReadResult } from '@workstation-control/remote-core'

import type { CodexDesktopConfig } from './config.js'
import type { DesktopAutomationController } from './desktop-controller.js'
import { CodexDesktopService } from './service.js'
import { createCodexDesktopApp } from './server.js'
import type { DesktopActionMode, DesktopStateResult } from './types.js'

class FakeBoundary implements CodexBoundary {
  readonly createdPrompts: Array<{ threadId: string; prompt: string }> = []
  readonly hiddenFromListThreadIds = new Set<string>()
  readonly readRequiresResumeThreadIds = new Set<string>()
  readonly resumedThreadIds = new Set<string>()
  readonly skipSubmitAppendThreadIds = new Set<string>()

  constructor(readonly threads: CodexRawThreadReadResult[]) {}

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  isReady(): boolean {
    return true
  }

  getReadyReason(): string | null {
    return null
  }

  async sanityCheck(): Promise<void> {}

  async listThreads() {
    return this.threads
      .filter((entry) => !this.hiddenFromListThreadIds.has(entry.thread.id))
      .map((entry) => structuredClone(entry.thread))
  }

  async readThread(threadId: string) {
    if (this.readRequiresResumeThreadIds.has(threadId) && !this.resumedThreadIds.has(threadId)) {
      throw new Error('thread not loaded')
    }
    const match = this.threads.find((entry) => entry.thread.id === threadId)
    if (!match) {
      throw new Error('thread not found')
    }
    return structuredClone(match)
  }

  async resumeThread(threadId: string): Promise<void> {
    this.resumedThreadIds.add(threadId)
  }

  async createThread(prompt: string): Promise<{ threadId: string; turnId: string | null }> {
    this.appendThread('thread-created', 'Created sacrificial thread', prompt)
    return { threadId: 'thread-created', turnId: 'turn-created-1' }
  }

  async submitPrompt(threadId: string, prompt: string): Promise<{ threadId: string; turnId: string | null }> {
    this.createdPrompts.push({ threadId, prompt })
    if (!this.skipSubmitAppendThreadIds.has(threadId)) {
      this.appendPrompt(threadId, prompt)
    }
    return { threadId, turnId: 'turn-submit' }
  }

  subscribe(_listener: (message: any) => void): () => void {
    void _listener
    return () => {}
  }

  appendPrompt(threadId: string, prompt: string) {
    const match = this.threads.find((entry) => entry.thread.id === threadId)
    if (!match) {
      throw new Error('thread not found')
    }

    const suffix = match.thread.turns?.length ?? 0
    match.thread.turns = match.thread.turns ?? []
    match.thread.turns.push({
      id: `turn-${suffix + 1}`,
      status: 'completed',
      items: [
        {
          type: 'userMessage',
          id: `item-user-${suffix + 1}`,
          content: [{ type: 'text', text: prompt }],
        },
      ],
    })
    match.thread.updatedAt = (match.thread.updatedAt ?? 1773065984) + 1
  }

  appendThread(id: string, title: string, prompt: string) {
    this.threads.unshift({
      thread: {
        id,
        name: title,
        preview: title,
        cwd: '\\\\?\\C:\\dev\\protocol-runner',
        updatedAt: 1773065985,
        turns: [
          {
            id: 'turn-created-1',
            status: 'completed',
            items: [
              {
                type: 'userMessage',
                id: `item-user-${id}`,
                content: [{ type: 'text', text: prompt }],
              },
            ],
          },
        ],
      },
    })
  }
}

class FakeController implements DesktopAutomationController {
  readonly selectedTitles: string[] = []
  readonly prompted: Array<{ threadTitle: string; text: string; mode: DesktopActionMode }> = []
  readonly created: Array<{ text: string; mode: DesktopActionMode }> = []
  readonly readbackTitles: Array<string | null> = []
  readonly desktopOnlyTitles = new Set<string>()
  readonly skipAppendTitles = new Set<string>()
  readonly promptResultsByTitle = new Map<string, DesktopStateResult>()

  constructor(private readonly boundary: FakeBoundary) {}

  async state(): Promise<DesktopStateResult> {
    return stateResult()
  }

  async selectThread(threadTitle: string, _mode: DesktopActionMode): Promise<DesktopStateResult> {
    void _mode
    this.selectedTitles.push(threadTitle)
    return {
      ...stateResult(),
      selectedSidebarThreadTitle: threadTitle,
      selectedSidebarThreadTitles: [threadTitle],
      selectionConfirmed: true,
    }
  }

  async promptThread(threadTitle: string, text: string, mode: DesktopActionMode): Promise<DesktopStateResult> {
    this.prompted.push({ threadTitle, text, mode })
    const configuredResult = this.promptResultsByTitle.get(threadTitle)
    if (configuredResult) {
      return configuredResult
    }
    const thread = this.boundary.threads.find(
      (entry) => entry.thread.name === threadTitle || entry.thread.preview === threadTitle,
    )
    if (!thread) {
      if (!this.desktopOnlyTitles.has(threadTitle)) {
        throw new Error('thread not found')
      }
      return {
        ...stateResult(),
        selectedSidebarThreadTitle: threadTitle,
        selectedSidebarThreadTitles: [threadTitle],
        selectionConfirmed: true,
        visibleTranscriptLines: [text],
        visibleTranscriptText: text,
      }
    }
    if (!this.skipAppendTitles.has(threadTitle)) {
      this.boundary.appendPrompt(thread.thread.id, text)
    }
    return {
      ...stateResult(),
      selectedSidebarThreadTitle: threadTitle,
      selectedSidebarThreadTitles: [threadTitle],
      selectionConfirmed: true,
      visibleTranscriptLines: [text],
      visibleTranscriptText: text,
    }
  }

  async createThread(text: string, mode: DesktopActionMode): Promise<DesktopStateResult> {
    this.created.push({ text, mode })
    this.boundary.appendThread('thread-created', 'Created sacrificial thread', text)
    return {
      ...stateResult(),
      selectedSidebarThreadTitle: 'Created sacrificial thread',
      selectedSidebarThreadTitles: ['Created sacrificial thread'],
      selectionConfirmed: true,
      visibleTranscriptLines: [text],
      visibleTranscriptText: text,
    }
  }

  async readback(expectedThreadTitle: string | null): Promise<DesktopStateResult> {
    this.readbackTitles.push(expectedThreadTitle)
    return {
      ...stateResult(),
      selectedSidebarThreadTitle: expectedThreadTitle,
      selectedSidebarThreadTitles: expectedThreadTitle ? [expectedThreadTitle] : [],
      selectionConfirmed: true,
    }
  }
}

function stateResult(): DesktopStateResult {
  return {
    result: 'applied',
    message: null,
    windowFound: true,
    threadListAccessible: true,
    visibleThreadCount: 2,
    composeAvailable: true,
    readbackAvailable: true,
    selectedSidebarThreadTitle: null,
    selectedSidebarThreadTitles: [],
    visibleThreadRows: [],
    visibleTranscriptLines: [],
    visibleTranscriptText: '',
    selectionConfirmed: null,
    expanded: 0,
  }
}

function config(): CodexDesktopConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    bearerToken: 'desktop-secret',
    artifactRoot: 'C:\\tmp\\codex-desktop',
    logFilePath: null,
    codexCliPath: 'C:\\nvm4w\\nodejs\\codex.cmd',
    allowedWorkspaceRoot: 'C:\\dev\\protocol-runner',
    windowTitle: 'Codex',
    maxShowMoreClicks: 16,
    operatorGateAutoAllowMs: 0,
    operatorGateAttentionEnabled: false,
    operatorGateAttentionUrl: 'http://127.0.0.1:5174/?gate=1',
    operatorGateAttentionScriptPath: 'C:\\dev\\protocol-runner\\ops\\windows\\show_protocol_runner_gate.ps1',
    helperScriptPath: 'C:\\dev\\protocol-runner\\ops\\windows\\invoke_codex_desktop_action.ps1',
    repoRoot: 'C:\\dev\\protocol-runner',
  }
}

async function createTestServer(boundary: FakeBoundary, controller: DesktopAutomationController) {
  const service = new CodexDesktopService({
    config: config(),
    boundary,
    controller,
  })
  await service.initialize()

  const app = createCodexDesktopApp(service, config())
  const server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('codex desktop test server did not bind')
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

function authHeaders() {
  return {
    Authorization: 'Bearer desktop-secret',
    'Content-Type': 'application/json',
  }
}

function makeThread(id: string, title: string, answer: string): CodexRawThreadReadResult {
  return {
    thread: {
      id,
      name: title,
      preview: title,
      cwd: '\\\\?\\C:\\dev\\protocol-runner',
      updatedAt: 1773065984,
      turns: [
        {
          id: 'turn-1',
          status: 'completed',
          items: [
            {
              type: 'userMessage',
              id: `item-user-${id}`,
              content: [{ type: 'text', text: `${title} prompt` }],
            },
            {
              type: 'agentMessage',
              id: `item-assistant-${id}`,
              text: answer,
            },
          ],
        },
      ],
    },
  }
}

test('healthz is open and desktop routes require bearer auth', async () => {
  const boundary = new FakeBoundary([makeThread('thread-1', 'Relay Candidate', 'First answer')])
  const controller = new FakeController(boundary)
  const server = await createTestServer(boundary, controller)

  try {
    const health = await fetch(`${server.baseUrl}/healthz`)
    assert.equal(health.status, 200)

    const unauthorized = await fetch(`${server.baseUrl}/api/codex-desktop/state`)
    assert.equal(unauthorized.status, 401)
  } finally {
    await server.close()
  }
})

test('prompt endpoint sends through the visible desktop controller', async () => {
  const boundary = new FakeBoundary([makeThread('thread-1', 'Relay Candidate', 'First answer')])
  const controller = new FakeController(boundary)
  const server = await createTestServer(boundary, controller)

  try {
    const response = await fetch(`${server.baseUrl}/api/codex-desktop/prompt`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        threadId: 'thread-1',
        threadTitle: 'Relay Candidate',
        text: 'Reply exactly: desktop lane works',
      }),
    })

    assert.equal(response.status, 200)
    const payload = (await response.json()) as {
      result: string
      threadId: string
      threadTitle: string
      turnId: string | null
      itemId: string | null
      selectionConfirmed: boolean
    }
    assert.equal(payload.result, 'applied')
    assert.equal(payload.threadId, 'thread-1')
    assert.equal(payload.threadTitle, 'Relay Candidate')
    assert.equal(payload.turnId, null)
    assert.equal(payload.itemId, null)
    assert.equal(payload.selectionConfirmed, true)
    assert.deepEqual(controller.prompted, [
      {
        threadTitle: 'Relay Candidate',
        text: 'Reply exactly: desktop lane works',
        mode: 'focus',
      },
    ])
    assert.deepEqual(boundary.createdPrompts, [])
  } finally {
    await server.close()
  }
})

test('prompt endpoint preserves supplied thread id metadata while using the visible title', async () => {
  const rawThread = makeThread('thread-1', 'Canonical app-server title', 'First answer')
  rawThread.thread.preview = 'Visible desktop label'
  const boundary = new FakeBoundary([rawThread])
  const controller = new FakeController(boundary)
  const server = await createTestServer(boundary, controller)

  try {
    const response = await fetch(`${server.baseUrl}/api/codex-desktop/prompt`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        threadId: 'thread-1',
        threadTitle: 'Visible desktop label',
        text: 'Reply exactly: desktop override works',
      }),
    })

    assert.equal(response.status, 200)
    const payload = (await response.json()) as {
      result: string
      threadId: string
      threadTitle: string
      turnId: string | null
      itemId: string | null
      selectionConfirmed: boolean
    }
    assert.equal(payload.result, 'applied')
    assert.equal(payload.threadId, 'thread-1')
    assert.equal(payload.threadTitle, 'Visible desktop label')
    assert.equal(payload.turnId, null)
    assert.equal(payload.itemId, null)
    assert.equal(payload.selectionConfirmed, true)
    assert.deepEqual(controller.prompted, [
      {
        threadTitle: 'Visible desktop label',
        text: 'Reply exactly: desktop override works',
        mode: 'focus',
      },
    ])
    assert.deepEqual(boundary.createdPrompts, [])
  } finally {
    await server.close()
  }
})

test('thread id resolution falls back to readThread when listThreads has not materialized the thread yet', async () => {
  const boundary = new FakeBoundary([makeThread('thread-hidden', 'Hidden app-server title', 'Ready')])
  boundary.hiddenFromListThreadIds.add('thread-hidden')
  const controller = new FakeController(boundary)
  const server = await createTestServer(boundary, controller)

  try {
    const response = await fetch(`${server.baseUrl}/api/codex-desktop/select-thread`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        threadId: 'thread-hidden',
        threadTitle: 'Visible hidden-thread label',
      }),
    })

    assert.equal(response.status, 200)
    const payload = (await response.json()) as {
      result: string
      threadId: string
      threadTitle: string
      selectionConfirmed: boolean
    }
    assert.equal(payload.result, 'applied')
    assert.equal(payload.threadId, 'thread-hidden')
    assert.equal(payload.threadTitle, 'Hidden app-server title')
    assert.equal(payload.selectionConfirmed, true)
    assert.deepEqual(controller.selectedTitles, ['Visible hidden-thread label'])
  } finally {
    await server.close()
  }
})

test('prompt endpoint can target a desktop-only visible thread label', async () => {
  const boundary = new FakeBoundary([makeThread('thread-1', 'Relay Candidate', 'First answer')])
  const controller = new FakeController(boundary)
  controller.desktopOnlyTitles.add('PRWC3Q')
  const server = await createTestServer(boundary, controller)

  try {
    const response = await fetch(`${server.baseUrl}/api/codex-desktop/prompt`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        threadId: 'unresolved-thread-metadata',
        threadTitle: 'PRWC3Q',
        text: 'Reply exactly: visible desktop delivery works',
      }),
    })

    assert.equal(response.status, 200)
    const payload = (await response.json()) as {
      result: string
      threadId: string
      threadTitle: string
      turnId: string | null
      itemId: string | null
      selectionConfirmed: boolean
      message: string
    }
    assert.equal(payload.result, 'applied')
    assert.equal(payload.threadId, 'unresolved-thread-metadata')
    assert.equal(payload.threadTitle, 'PRWC3Q')
    assert.equal(payload.turnId, null)
    assert.equal(payload.itemId, null)
    assert.equal(payload.selectionConfirmed, true)
    assert.match(payload.message, /visible Codex Desktop sidebar/)
    assert.deepEqual(controller.prompted, [
      {
        threadTitle: 'PRWC3Q',
        text: 'Reply exactly: visible desktop delivery works',
        mode: 'focus',
      },
    ])
    assert.deepEqual(boundary.createdPrompts, [])
  } finally {
    await server.close()
  }
})

test('prompt endpoint fails closed without a visible title', async () => {
  const boundary = new FakeBoundary([makeThread('thread-1', 'Relay Candidate', 'First answer')])
  const controller = new FakeController(boundary)
  const server = await createTestServer(boundary, controller)

  try {
    const response = await fetch(`${server.baseUrl}/api/codex-desktop/prompt`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        threadId: 'unresolved-thread-metadata',
        text: 'Reply exactly: missing title should fail',
      }),
    })

    assert.equal(response.status, 400)
    const payload = (await response.json()) as { error: string; message: string }
    assert.equal(payload.error, 'thread_title_required')
    assert.match(payload.message, /threadTitle is required/)
    assert.deepEqual(controller.prompted, [])
    assert.deepEqual(boundary.createdPrompts, [])
  } finally {
    await server.close()
  }
})

test('prompt endpoint rejects retired deliveryMode field', async () => {
  const boundary = new FakeBoundary([makeThread('thread-1', 'Relay Candidate', 'First answer')])
  const controller = new FakeController(boundary)
  const server = await createTestServer(boundary, controller)

  try {
    const response = await fetch(`${server.baseUrl}/api/codex-desktop/prompt`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        threadTitle: 'Relay Candidate',
        deliveryMode: 'retired',
        text: 'Reply exactly: retired delivery mode should fail',
      }),
    })

    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), {
      error: 'delivery_mode_retired',
      message: 'deliveryMode is retired. Codex Desktop prompt/create actions always use the visible Desktop path.',
    })
    assert.deepEqual(controller.prompted, [])
    assert.deepEqual(boundary.createdPrompts, [])
  } finally {
    await server.close()
  }
})

test('prompt endpoint preserves helper refusal evidence', async () => {
  const boundary = new FakeBoundary([makeThread('thread-1', 'Relay Candidate', 'First answer')])
  const controller = new FakeController(boundary)
  controller.promptResultsByTitle.set('PRBADQ', {
    ...stateResult(),
    result: 'thread_mismatch',
    message: 'Wrong visible thread selected.',
    selectedSidebarThreadTitle: 'PRBADQ',
    selectedSidebarThreadTitles: ['PRBADQ'],
    selectionConfirmed: false,
  })
  const server = await createTestServer(boundary, controller)

  try {
    const response = await fetch(`${server.baseUrl}/api/codex-desktop/prompt`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        threadId: 'unresolved-thread-metadata',
        threadTitle: 'PRBADQ',
        text: 'Reply exactly: refusal should propagate',
      }),
    })

    assert.equal(response.status, 200)
    const payload = (await response.json()) as {
      result: string
      threadId: string
      threadTitle: string
      selectionConfirmed: boolean
      message: string
    }
    assert.equal(payload.result, 'thread_mismatch')
    assert.equal(payload.threadId, 'unresolved-thread-metadata')
    assert.equal(payload.threadTitle, 'PRBADQ')
    assert.equal(payload.selectionConfirmed, false)
    assert.match(payload.message, /Wrong visible thread/)
    assert.deepEqual(controller.prompted, [
      {
        threadTitle: 'PRBADQ',
        text: 'Reply exactly: refusal should propagate',
        mode: 'focus',
      },
    ])
    assert.deepEqual(boundary.createdPrompts, [])
  } finally {
    await server.close()
  }
})

test('create-thread endpoint uses the desktop controller', async () => {
  const boundary = new FakeBoundary([makeThread('thread-1', 'Relay Candidate', 'First answer')])
  const controller = new FakeController(boundary)
  const server = await createTestServer(boundary, controller)

  try {
    const response = await fetch(`${server.baseUrl}/api/codex-desktop/create-thread`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        text: 'Create a visible desktop thread',
      }),
    })
    assert.equal(response.status, 200)

    const payload = (await response.json()) as {
      result: string
      threadId: string | null
      threadTitle: string | null
      selectionConfirmed: boolean | null
    }
    assert.equal(payload.result, 'applied')
    assert.equal(payload.threadId, 'thread-created')
    assert.equal(payload.threadTitle, 'Created sacrificial thread')
    assert.equal(payload.selectionConfirmed, true)
    assert.deepEqual(controller.created, [{ text: 'Create a visible desktop thread', mode: 'focus' }])
  } finally {
    await server.close()
  }
})

test('create-thread endpoint rejects retired deliveryMode field', async () => {
  const boundary = new FakeBoundary([makeThread('thread-1', 'Relay Candidate', 'First answer')])
  const controller = new FakeController(boundary)
  const server = await createTestServer(boundary, controller)

  try {
    const response = await fetch(`${server.baseUrl}/api/codex-desktop/create-thread`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        deliveryMode: 'retired',
        mode: 'focus',
        text: 'Create should fail on retired delivery mode',
      }),
    })
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), {
      error: 'delivery_mode_retired',
      message: 'deliveryMode is retired. Codex Desktop prompt/create actions always use the visible Desktop path.',
    })
    assert.deepEqual(controller.created, [])
  } finally {
    await server.close()
  }
})

test('select-thread keeps exact title semantics and ambiguous titles return 409', async () => {
  const boundary = new FakeBoundary([
    makeThread('thread-1', 'Shared Title', 'Answer one'),
    makeThread('thread-2', 'Shared Title', 'Answer two'),
  ])
  const controller = new FakeController(boundary)
  const server = await createTestServer(boundary, controller)

  try {
    const response = await fetch(`${server.baseUrl}/api/codex-desktop/select-thread`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        threadTitle: 'Shared Title',
      }),
    })
    assert.equal(response.status, 409)
    assert.deepEqual(await response.json(), {
      error: 'thread_title_ambiguous',
      message: 'Thread title is ambiguous: Shared Title',
    })
  } finally {
    await server.close()
  }
})
