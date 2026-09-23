import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildTranscriptViewState,
  createPendingTranscriptItem,
  matchesWorkspaceRoot,
  mergeOlderTranscriptItems,
  mergeSnapshotTranscriptItems,
  reduceCodexAssistantDeltaEvent,
  reduceCodexTurnStatusEvent,
  reducePublicThreadStatus,
  toThreadDetail,
  toThreadSummary,
  windowTranscriptItems,
} from './index.js'

test('matches workspace roots across normalized Windows path variants', () => {
  assert.equal(matchesWorkspaceRoot('\\\\?\\C:\\dev\\protocol-runner', 'C:/dev/protocol-runner'), true)
})

test('reduces completed turns into done', () => {
  const summary = toThreadSummary({
    id: 'thread-1',
    preview: 'Prompt preview',
    cwd: '\\\\?\\C:\\dev\\protocol-runner',
    turns: [{ id: 'turn-1', status: 'completed', items: [] }],
  })

  assert.equal(summary.status, 'done')
})

test('reduces active turns into thinking', () => {
  assert.equal(
    reducePublicThreadStatus({
      id: 'thread-2',
      turns: [{ id: 'turn-2', status: 'in_progress', items: [] }],
    }),
    'thinking',
  )
})

test('reduces approval states into waiting_on_approval', () => {
  assert.equal(
    reducePublicThreadStatus({
      id: 'thread-3',
      status: { type: 'waitingForApproval' },
    }),
    'waiting_on_approval',
  )
})

test('maps thread reads into transcript items', () => {
  const detail = toThreadDetail({
    thread: {
      id: 'thread-4',
      preview: 'Preview',
      turns: [
        {
          id: 'turn-4',
          status: 'completed',
          items: [
            {
              type: 'userMessage',
              id: 'item-1',
              content: [{ type: 'text', text: 'hello world' }],
            },
            {
              type: 'agentMessage',
              id: 'item-2',
              text: 'WC_G1_OK',
            },
          ],
        },
      ],
    },
  })

  assert.deepEqual(
    detail.items.map((item) => ({ id: item.id, role: item.role, text: item.text })),
    [
      { id: 'item-1', role: 'user', text: 'hello world' },
      { id: 'item-2', role: 'assistant', text: 'WC_G1_OK' },
    ],
  )
  assert.deepEqual(detail.history, {
    hasOlder: false,
    nextBeforeItemId: null,
  })
})

test('returns a recent-first transcript window with an older-history cursor', () => {
  const windowed = windowTranscriptItems(
    Array.from({ length: 5 }, (_, index) => ({
      id: `item-${index + 1}`,
      turnId: `turn-${index + 1}`,
      role: 'assistant' as const,
      text: `message-${index + 1}`,
      createdAt: null,
    })),
    { limit: 2 },
  )

  assert.deepEqual(
    windowed.items.map((item) => item.id),
    ['item-4', 'item-5'],
  )
  assert.deepEqual(windowed.history, {
    hasOlder: true,
    nextBeforeItemId: 'item-4',
  })
})

test('keeps complete turns together when a transcript window would otherwise start mid-turn', () => {
  const items = [
    { id: 'item-1', turnId: 'turn-1', role: 'user' as const, text: 'prompt 1', createdAt: null },
    { id: 'item-2', turnId: 'turn-1', role: 'assistant' as const, text: 'answer 1', createdAt: null },
    { id: 'item-3', turnId: 'turn-2', role: 'user' as const, text: 'prompt 2', createdAt: null },
    { id: 'item-4', turnId: 'turn-2', role: 'assistant' as const, text: 'answer 2a', createdAt: null },
    { id: 'item-5', turnId: 'turn-2', role: 'assistant' as const, text: 'answer 2b', createdAt: null },
    { id: 'item-6', turnId: 'turn-3', role: 'user' as const, text: 'prompt 3', createdAt: null },
    { id: 'item-7', turnId: 'turn-3', role: 'assistant' as const, text: 'answer 3a', createdAt: null },
    { id: 'item-8', turnId: 'turn-3', role: 'assistant' as const, text: 'answer 3b', createdAt: null },
  ]

  const recent = windowTranscriptItems(items, { limit: 2 })
  assert.deepEqual(
    recent.items.map((item) => item.id),
    ['item-6', 'item-7', 'item-8'],
  )
  assert.deepEqual(recent.history, {
    hasOlder: true,
    nextBeforeItemId: 'item-6',
  })

  const older = windowTranscriptItems(items, { limit: 2, beforeItemId: 'item-7' })
  assert.deepEqual(
    older.items.map((item) => item.id),
    ['item-3', 'item-4', 'item-5'],
  )
  assert.deepEqual(older.history, {
    hasOlder: true,
    nextBeforeItemId: 'item-3',
  })
})

test('prepends older transcript pages without duplicating items', () => {
  const merged = mergeOlderTranscriptItems(
    [
      { id: 'item-3', turnId: 'turn-3', role: 'assistant', text: 'three', createdAt: null },
      { id: 'item-4', turnId: 'turn-4', role: 'assistant', text: 'four', createdAt: null },
    ],
    [
      { id: 'item-1', turnId: 'turn-1', role: 'assistant', text: 'one', createdAt: null },
      { id: 'item-2', turnId: 'turn-2', role: 'assistant', text: 'two', createdAt: null },
      { id: 'item-3', turnId: 'turn-3', role: 'assistant', text: 'three', createdAt: null },
    ],
  )

  assert.deepEqual(
    merged.map((item) => item.id),
    ['item-1', 'item-2', 'item-3', 'item-4'],
  )
})

test('replaces the recent transcript tail while preserving older loaded history', () => {
  const merged = mergeSnapshotTranscriptItems(
    [
      { id: 'item-1', turnId: 'turn-1', role: 'assistant', text: 'one', createdAt: null },
      { id: 'item-2', turnId: 'turn-2', role: 'assistant', text: 'two', createdAt: null },
      { id: 'item-3', turnId: 'turn-3', role: 'assistant', text: 'stale-three', createdAt: null },
    ],
    [
      { id: 'item-2', turnId: 'turn-2', role: 'assistant', text: 'two', createdAt: null },
      { id: 'item-3', turnId: 'turn-3', role: 'assistant', text: 'fresh-three', createdAt: null },
      { id: 'item-4', turnId: 'turn-4', role: 'assistant', text: 'four', createdAt: null },
    ],
  )

  assert.deepEqual(
    merged.map((item) => ({ id: item.id, text: item.text })),
    [
      { id: 'item-1', text: 'one' },
      { id: 'item-2', text: 'two' },
      { id: 'item-3', text: 'fresh-three' },
      { id: 'item-4', text: 'four' },
    ],
  )
})

test('builds a transcript view that includes local pending items until persisted state catches up', () => {
  const view = buildTranscriptViewState(
    {
      thread: {
        id: 'thread-5',
        title: 'Prompt thread',
        preview: 'preview',
        cwd: 'C:\\dev\\protocol-runner',
        createdAt: null,
        updatedAt: null,
        source: 'vscode',
        status: 'done',
      },
      items: [{ id: 'item-1', turnId: 'turn-1', role: 'assistant', text: 'Existing answer', createdAt: null }],
      history: { hasOlder: false, nextBeforeItemId: null },
    },
    [createPendingTranscriptItem('thread-5', 'Need a follow-up', 'turn-2')],
  )

  assert.equal(view.status, 'thinking')
  assert.equal(view.awaitingPersistence, true)
  assert.deepEqual(
    view.items.map((item) => ({ role: item.role, text: item.text, presentation: item.presentation })),
    [
      { role: 'assistant', text: 'Existing answer', presentation: 'persisted' },
      { role: 'user', text: 'Need a follow-up', presentation: 'pending' },
    ],
  )
})

test('normalizes turn status notifications into public status events', () => {
  const event = reduceCodexTurnStatusEvent({
    method: 'turn/started',
    params: {
      threadId: 'thread-6',
      turnId: 'turn-6',
    },
  })

  assert.deepEqual(event, {
    type: 'turn_status',
    threadId: 'thread-6',
    emittedAt: event?.emittedAt,
    turnId: 'turn-6',
    status: 'thinking',
    message: null,
  })
})

test('normalizes assistant delta notifications into cumulative live text', () => {
  const first = reduceCodexAssistantDeltaEvent(
    {
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-7',
        turnId: 'turn-7',
        item: {
          id: 'item-7',
          delta: 'Hello',
        },
      },
    },
    '',
  )
  const second = reduceCodexAssistantDeltaEvent(
    {
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-7',
        turnId: 'turn-7',
        item: {
          id: 'item-7',
          delta: ', world',
        },
      },
    },
    first?.text ?? '',
  )

  assert.equal(first?.text, 'Hello')
  assert.equal(second?.text, 'Hello, world')
  assert.equal(second?.done, false)
})
