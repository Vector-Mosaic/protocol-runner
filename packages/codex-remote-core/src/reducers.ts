import {
  type CodexRawAgentMessage,
  type CodexRawItem,
  type CodexRawNotification,
  type CodexRawSystemMessage,
  type CodexRawThreadReadResult,
  type CodexRawThreadSummary,
  type CodexRawTurn,
  type CodexRawUserMessage,
  DEFAULT_TRANSCRIPT_WINDOW_LIMIT,
  MAX_TRANSCRIPT_WINDOW_LIMIT,
  type LiveAssistantItem,
  type PendingTranscriptItem,
  type PublicThreadStatus,
  type ThreadDetail,
  type ThreadEventAssistantDelta,
  type ThreadEventTurnStatus,
  type ThreadSummary,
  type TranscriptHistoryWindow,
  type TranscriptItem,
  type TranscriptViewItem,
  type TranscriptViewState,
  type TranscriptWindowRequest,
} from './types.js'
import { fromUnixSeconds, normalizeWorkspacePath } from './paths.js'

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function stringFromUnknown(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function getPath(value: unknown, path: Array<string | number>): unknown {
  let current: unknown = value
  for (const segment of path) {
    if (typeof segment === 'number') {
      if (!Array.isArray(current) || segment >= current.length) {
        return null
      }
      current = current[segment]
      continue
    }

    const record = asRecord(current)
    if (!record || !(segment in record)) {
      return null
    }
    current = record[segment]
  }

  return current
}

function firstStringPath(value: unknown, paths: Array<Array<string | number>>): string | null {
  for (const path of paths) {
    const candidate = stringFromUnknown(getPath(value, path))
    if (candidate) {
      return candidate
    }
  }

  return null
}

function findStringByKeys(value: unknown, keys: string[], maxDepth = 4): string | null {
  const queue: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  const seen = new Set<unknown>()

  while (queue.length > 0) {
    const next = queue.shift()
    if (!next || next.depth > maxDepth || seen.has(next.value)) {
      continue
    }
    seen.add(next.value)

    if (Array.isArray(next.value)) {
      for (const entry of next.value) {
        queue.push({ value: entry, depth: next.depth + 1 })
      }
      continue
    }

    const record = asRecord(next.value)
    if (!record) {
      continue
    }

    for (const key of keys) {
      const candidate = stringFromUnknown(record[key])
      if (candidate) {
        return candidate
      }
    }

    for (const child of Object.values(record)) {
      queue.push({ value: child, depth: next.depth + 1 })
    }
  }

  return null
}

function inferTitle(rawThread: CodexRawThreadSummary): string {
  const named = compactWhitespace(rawThread.name ?? '')
  if (named) {
    return named
  }

  const preview = compactWhitespace(rawThread.preview ?? '')
  if (preview) {
    return preview.slice(0, 96)
  }

  return rawThread.id
}

function inferPreview(rawThread: CodexRawThreadSummary): string {
  return compactWhitespace(rawThread.preview ?? rawThread.name ?? '') || 'No preview available.'
}

function rawStatusType(rawThread: CodexRawThreadSummary): string | null {
  if (!rawThread.status) {
    return null
  }

  if (typeof rawThread.status === 'string') {
    return rawThread.status
  }

  return rawThread.status.type ?? null
}

function hasTurnError(turn: CodexRawTurn | undefined): boolean {
  return Boolean(turn?.error) || turn?.status === 'failed'
}

function lastTurn(rawThread: CodexRawThreadSummary): CodexRawTurn | undefined {
  return rawThread.turns?.[rawThread.turns.length - 1]
}

function publicThreadStatusFromString(rawStatus: string | null): PublicThreadStatus | null {
  if (!rawStatus) {
    return null
  }

  const status = rawStatus.toLowerCase()
  if (status.includes('approval')) {
    return 'waiting_on_approval'
  }

  if (status.includes('error') || status.includes('failed')) {
    return 'error'
  }

  if (
    status === 'completed' ||
    status === 'complete' ||
    status === 'done' ||
    status === 'idle' ||
    status === 'loaded' ||
    status === 'notloaded'
  ) {
    return 'done'
  }

  return 'thinking'
}

function publicThreadStatusFromUnknown(value: unknown): PublicThreadStatus | null {
  if (typeof value === 'string') {
    return publicThreadStatusFromString(value)
  }

  const record = asRecord(value)
  if (!record) {
    return null
  }

  return publicThreadStatusFromString(stringFromUnknown(record.type) ?? stringFromUnknown(record.status))
}

export function reducePublicThreadStatus(rawThread: CodexRawThreadSummary): PublicThreadStatus {
  const turn = lastTurn(rawThread)
  if (hasTurnError(turn)) {
    return 'error'
  }

  const turnStatus = turn?.status?.toLowerCase()
  if (turnStatus) {
    if (turnStatus.includes('approval')) {
      return 'waiting_on_approval'
    }

    if (turnStatus === 'completed' || turnStatus === 'done' || turnStatus === 'idle') {
      return 'done'
    }

    if (turnStatus === 'failed' || turnStatus === 'error') {
      return 'error'
    }

    return 'thinking'
  }

  const status = rawStatusType(rawThread)?.toLowerCase()
  if (!status || status === 'notloaded' || status === 'loaded' || status === 'completed' || status === 'done') {
    return 'done'
  }

  if (status.includes('approval')) {
    return 'waiting_on_approval'
  }

  if (status.includes('error') || status.includes('failed')) {
    return 'error'
  }

  return 'thinking'
}

function flattenUserContent(item: Extract<CodexRawItem, { type: 'userMessage' }>): string {
  const parts = (item.content ?? [])
    .filter((entry) => entry.type === 'text' && typeof entry.text === 'string')
    .map((entry) => entry.text?.trim() ?? '')
    .filter(Boolean)

  return parts.join('\n\n')
}

function isUserMessage(item: CodexRawItem): item is CodexRawUserMessage {
  return item.type === 'userMessage'
}

function isAgentMessage(item: CodexRawItem): item is CodexRawAgentMessage {
  return item.type === 'agentMessage'
}

function reduceSystemItem(turn: CodexRawTurn, item: CodexRawSystemMessage): TranscriptItem | null {
  const systemText = compactWhitespace(item.text ?? item.title ?? item.type)
  if (!systemText) {
    return null
  }

  return {
    id: item.id ?? `${turn.id}:${item.type}`,
    turnId: turn.id,
    role: 'system',
    text: systemText,
    createdAt: null,
  }
}

function reduceItem(turn: CodexRawTurn, item: CodexRawItem): TranscriptItem | null {
  if (isUserMessage(item)) {
    const text = flattenUserContent(item)
    if (!text) {
      return null
    }

    return {
      id: item.id,
      turnId: turn.id,
      role: 'user',
      text,
      createdAt: null,
    }
  }

  if (isAgentMessage(item)) {
    const text = item.text?.trim()
    if (!text) {
      return null
    }

    return {
      id: item.id,
      turnId: turn.id,
      role: 'assistant',
      text,
      createdAt: null,
    }
  }

  return reduceSystemItem(turn, item)
}

export function reduceTranscriptItems(rawThread: CodexRawThreadSummary): TranscriptItem[] {
  const items: TranscriptItem[] = []
  for (const turn of rawThread.turns ?? []) {
    for (const item of turn.items ?? []) {
      const reduced = reduceItem(turn, item)
      if (reduced) {
        items.push(reduced)
      }
    }
  }

  return items
}

export function clampTranscriptWindowLimit(limit: number | null | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    return DEFAULT_TRANSCRIPT_WINDOW_LIMIT
  }

  const rounded = Math.floor(limit)
  if (rounded < 1) {
    return DEFAULT_TRANSCRIPT_WINDOW_LIMIT
  }

  return Math.min(rounded, MAX_TRANSCRIPT_WINDOW_LIMIT)
}

function alignToTurnStart(items: TranscriptItem[], index: number): number {
  if (index <= 0 || index >= items.length) {
    return Math.max(0, Math.min(index, items.length))
  }

  const turnId = items[index]?.turnId
  if (!turnId) {
    return index
  }

  let alignedIndex = index
  while (alignedIndex > 0 && items[alignedIndex - 1]?.turnId === turnId) {
    alignedIndex -= 1
  }

  return alignedIndex
}

export function windowTranscriptItems(
  items: TranscriptItem[],
  options: TranscriptWindowRequest = {},
): { items: TranscriptItem[]; history: TranscriptHistoryWindow } {
  const limit = clampTranscriptWindowLimit(options.limit)
  const beforeItemId = stringFromUnknown(options.beforeItemId) ?? null
  let end = items.length

  if (beforeItemId) {
    const beforeIndex = items.findIndex((item) => item.id === beforeItemId)
    if (beforeIndex !== -1) {
      end = alignToTurnStart(items, beforeIndex)
    }
  }

  const rawStart = Math.max(0, end - limit)
  const start = rawStart < end ? alignToTurnStart(items, rawStart) : rawStart
  const pageItems = items.slice(start, end)
  return {
    items: pageItems,
    history: {
      hasOlder: start > 0,
      nextBeforeItemId: start > 0 && pageItems[0] ? pageItems[0].id : null,
    },
  }
}

export function toThreadSummary(rawThread: CodexRawThreadSummary): ThreadSummary {
  return {
    id: rawThread.id,
    title: inferTitle(rawThread),
    preview: inferPreview(rawThread),
    cwd: normalizeWorkspacePath(rawThread.cwd),
    createdAt: fromUnixSeconds(rawThread.createdAt),
    updatedAt: fromUnixSeconds(rawThread.updatedAt),
    source: rawThread.source ?? null,
    status: reducePublicThreadStatus(rawThread),
  }
}

export function toThreadDetail(
  rawThread: CodexRawThreadReadResult | CodexRawThreadSummary,
  options: TranscriptWindowRequest = {},
): ThreadDetail {
  const thread = 'thread' in rawThread ? rawThread.thread : rawThread
  const windowed = windowTranscriptItems(reduceTranscriptItems(thread), options)
  return {
    thread: toThreadSummary(thread),
    items: windowed.items,
    history: windowed.history,
  }
}

export function summariseAgentMessage(item: CodexRawAgentMessage): string {
  return compactWhitespace(item.text ?? '')
}

export function mergeOlderTranscriptItems(currentItems: TranscriptItem[], olderItems: TranscriptItem[]): TranscriptItem[] {
  const seen = new Set(currentItems.map((item) => item.id))
  const prefix = olderItems.filter((item) => !seen.has(item.id))
  return [...prefix, ...currentItems]
}

export function mergeSnapshotTranscriptItems(currentItems: TranscriptItem[], snapshotItems: TranscriptItem[]): TranscriptItem[] {
  if (snapshotItems.length === 0) {
    return currentItems
  }

  const snapshotIds = new Set(snapshotItems.map((item) => item.id))
  const firstSnapshotIndex = currentItems.findIndex((item) => item.id === snapshotItems[0].id)
  const prefix =
    firstSnapshotIndex === -1
      ? currentItems.filter((item) => !snapshotIds.has(item.id))
      : currentItems.slice(0, firstSnapshotIndex).filter((item) => !snapshotIds.has(item.id))

  return [...prefix, ...snapshotItems]
}

export function createPendingTranscriptItem(
  threadId: string,
  text: string,
  turnId: string | null = null,
  status: PendingTranscriptItem['status'] = 'pending',
  createdAt = new Date().toISOString(),
): PendingTranscriptItem {
  return {
    id: `pending:${turnId ?? createdAt}:${compactWhitespace(text).slice(0, 24) || 'prompt'}`,
    threadId,
    turnId,
    text,
    createdAt,
    status,
  }
}

export function createLiveAssistantItem(
  threadId: string,
  text: string,
  turnId: string | null,
  itemId: string | null,
  done = false,
  createdAt = new Date().toISOString(),
): LiveAssistantItem {
  return {
    threadId,
    turnId,
    itemId,
    text,
    createdAt,
    done,
  }
}

function matchesPersistedPending(item: PendingTranscriptItem, persistedItems: TranscriptItem[]): boolean {
  if (item.turnId && persistedItems.some((persisted) => persisted.role === 'user' && persisted.turnId === item.turnId)) {
    return true
  }

  return persistedItems.some((persisted) => persisted.role === 'user' && persisted.text === item.text)
}

function matchesPersistedAssistant(item: LiveAssistantItem, persistedItems: TranscriptItem[]): boolean {
  if (item.turnId && persistedItems.some((persisted) => persisted.role === 'assistant' && persisted.turnId === item.turnId)) {
    return true
  }

  if (item.itemId && persistedItems.some((persisted) => persisted.role === 'assistant' && persisted.id === item.itemId)) {
    return true
  }

  return persistedItems.some((persisted) => persisted.role === 'assistant' && persisted.text === item.text)
}

export function buildTranscriptViewState(
  detail: ThreadDetail | null,
  pendingItems: PendingTranscriptItem[] = [],
  liveAssistant: LiveAssistantItem | null = null,
  overrideStatus: PublicThreadStatus | null = null,
): TranscriptViewState {
  const persistedItems = detail?.items ?? []
  const items: TranscriptViewItem[] = persistedItems.map((item) => ({ ...item, presentation: 'persisted' }))

  const unappliedPending = pendingItems.filter((item) => !matchesPersistedPending(item, persistedItems))
  for (const pending of unappliedPending) {
    items.push({
      id: pending.id,
      turnId: pending.turnId,
      role: 'user',
      text: pending.text,
      createdAt: pending.createdAt,
      presentation: 'pending',
    })
  }

  const includeLiveAssistant =
    liveAssistant && compactWhitespace(liveAssistant.text).length > 0 && !matchesPersistedAssistant(liveAssistant, persistedItems)
  if (includeLiveAssistant && liveAssistant) {
    items.push({
      id: liveAssistant.itemId ?? `live:${liveAssistant.turnId ?? liveAssistant.createdAt}`,
      turnId: liveAssistant.turnId,
      role: 'assistant',
      text: liveAssistant.text,
      createdAt: liveAssistant.createdAt,
      presentation: 'live',
    })
  }

  let status = overrideStatus ?? detail?.thread.status ?? 'done'
  const awaitingPersistence = unappliedPending.length > 0 || Boolean(includeLiveAssistant && !liveAssistant?.done)
  if (awaitingPersistence && status === 'done') {
    status = 'thinking'
  }

  return {
    items,
    status,
    awaitingPersistence,
  }
}

const TURN_STATUS_METHODS = new Set(['turn/started', 'turn/completed', 'thread/status/changed', 'codex/event/task_started', 'codex/event/task_complete'])
const ASSISTANT_DELTA_METHODS = new Set([
  'codex/event/agent_message_content_delta',
  'item/agentMessage/delta',
  'codex/event/agent_message_delta',
  'codex/event/agent_message',
])

export function extractNotificationThreadId(notification: CodexRawNotification): string | null {
  const params = asRecord(notification.params)
  if (!params) {
    return null
  }

  return (
    firstStringPath(params, [
      ['threadId'],
      ['thread', 'id'],
      ['turn', 'threadId'],
      ['item', 'threadId'],
      ['event', 'threadId'],
      ['message', 'threadId'],
      ['payload', 'threadId'],
    ]) ?? findStringByKeys(params, ['threadId'])
  )
}

export function extractNotificationTurnId(notification: CodexRawNotification): string | null {
  const params = asRecord(notification.params)
  if (!params) {
    return null
  }

  return (
    firstStringPath(params, [
      ['turnId'],
      ['turn', 'id'],
      ['item', 'turnId'],
      ['event', 'turnId'],
      ['message', 'turnId'],
      ['payload', 'turnId'],
    ]) ?? findStringByKeys(params, ['turnId'])
  )
}

export function extractNotificationItemId(notification: CodexRawNotification): string | null {
  const params = asRecord(notification.params)
  if (!params) {
    return null
  }

  return (
    firstStringPath(params, [
      ['itemId'],
      ['item', 'id'],
      ['message', 'id'],
      ['payload', 'itemId'],
    ]) ?? findStringByKeys(params, ['itemId'])
  )
}

function extractNotificationMessage(notification: CodexRawNotification): string | null {
  const params = asRecord(notification.params)
  if (!params) {
    return null
  }

  return firstStringPath(params, [
    ['message'],
    ['error', 'message'],
    ['turn', 'error', 'message'],
    ['statusMessage'],
  ])
}

function extractAssistantTextCandidate(notification: CodexRawNotification): string | null {
  const params = asRecord(notification.params)
  if (!params) {
    return null
  }

  return (
    firstStringPath(params, [
      ['delta'],
      ['textDelta'],
      ['contentDelta'],
      ['item', 'delta'],
      ['item', 'textDelta'],
      ['item', 'text'],
      ['message', 'delta'],
      ['message', 'text'],
      ['payload', 'delta'],
      ['payload', 'text'],
      ['text'],
    ]) ?? findStringByKeys(params, ['delta', 'textDelta', 'contentDelta', 'text'])
  )
}

function hasNotificationError(notification: CodexRawNotification): boolean {
  const params = asRecord(notification.params)
  if (!params) {
    return false
  }

  return Boolean(getPath(params, ['error']) ?? getPath(params, ['turn', 'error']))
}

function assistantEventIsFinal(method: string | null | undefined): boolean {
  return method === 'codex/event/agent_message'
}

function mergeAssistantText(previousText: string, nextChunk: string): string {
  if (!previousText) {
    return nextChunk
  }

  if (nextChunk.startsWith(previousText)) {
    return nextChunk
  }

  return `${previousText}${nextChunk}`
}

export function reduceCodexTurnStatusEvent(
  notification: CodexRawNotification,
  emittedAt = new Date().toISOString(),
): ThreadEventTurnStatus | null {
  const method = stringFromUnknown(notification.method)
  if (!method || !TURN_STATUS_METHODS.has(method)) {
    return null
  }

  const threadId = extractNotificationThreadId(notification)
  if (!threadId) {
    return null
  }

  const params = asRecord(notification.params)
  const status =
    method === 'turn/started' || method === 'codex/event/task_started'
      ? 'thinking'
      : method === 'turn/completed' || method === 'codex/event/task_complete'
        ? hasNotificationError(notification)
          ? 'error'
          : publicThreadStatusFromUnknown(getPath(params, ['status']) ?? getPath(params, ['turn', 'status'])) ?? 'done'
        : publicThreadStatusFromUnknown(
            getPath(params, ['status']) ?? getPath(params, ['turn', 'status']) ?? getPath(params, ['thread', 'status']),
          ) ?? 'thinking'

  return {
    type: 'turn_status',
    threadId,
    emittedAt,
    turnId: extractNotificationTurnId(notification),
    status,
    message: extractNotificationMessage(notification),
  }
}

export function reduceCodexAssistantDeltaEvent(
  notification: CodexRawNotification,
  previousText = '',
  emittedAt = new Date().toISOString(),
): ThreadEventAssistantDelta | null {
  const method = stringFromUnknown(notification.method)
  if (!method || !ASSISTANT_DELTA_METHODS.has(method)) {
    return null
  }

  const threadId = extractNotificationThreadId(notification)
  if (!threadId) {
    return null
  }

  const nextChunk = extractAssistantTextCandidate(notification)
  if (!nextChunk) {
    return null
  }

  return {
    type: 'assistant_delta',
    threadId,
    emittedAt,
    turnId: extractNotificationTurnId(notification),
    itemId: extractNotificationItemId(notification),
    text: mergeAssistantText(previousText, nextChunk),
    done: assistantEventIsFinal(method),
  }
}
