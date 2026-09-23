import crypto from 'node:crypto'

import {
  reduceTranscriptItems,
  toThreadSummary,
  type CodexRawThreadReadResult,
  type CodexRawThreadSummary,
  type ThreadSummary,
  type TranscriptItem,
} from '@workstation-control/remote-core'

export interface LatestAssistantTurn {
  threadId: string
  threadTitle: string
  threadSummary: ThreadSummary
  itemId: string | null
  turnId: string | null
  text: string
  stableHash: string
}

function resolveThread(rawThread: CodexRawThreadReadResult | CodexRawThreadSummary): CodexRawThreadSummary {
  return 'thread' in rawThread ? rawThread.thread : rawThread
}

function hashLatestAssistantValue(parts: Record<string, string | null>): string {
  const hash = crypto.createHash('sha256')
  hash.update(JSON.stringify({ version: 1, ...parts }))
  return hash.digest('hex')
}

export function hashAssistantItem(
  threadId: string,
  item: Pick<TranscriptItem, 'id' | 'turnId' | 'text'>,
): string {
  return hashLatestAssistantValue({
    threadId,
    itemId: item.id,
    turnId: item.turnId,
    text: item.text,
  })
}

export function latestAssistantMirrorKey(value: Pick<LatestAssistantTurn, 'itemId' | 'stableHash'>): string {
  return value.itemId || value.stableHash
}

export function getLatestAssistantTurn(rawThread: CodexRawThreadReadResult | CodexRawThreadSummary): LatestAssistantTurn | null {
  const resolved = resolveThread(rawThread)
  const threadSummary = toThreadSummary(resolved)
  const latestAssistant = [...reduceTranscriptItems(resolved)].reverse().find((item) => item.role === 'assistant') ?? null
  if (!latestAssistant) {
    return null
  }

  return {
    threadId: resolved.id,
    threadTitle: threadSummary.title,
    threadSummary,
    itemId: latestAssistant.id ?? null,
    turnId: latestAssistant.turnId ?? null,
    text: latestAssistant.text,
    stableHash: hashAssistantItem(resolved.id, latestAssistant),
  }
}
