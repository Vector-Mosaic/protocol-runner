export type PublicThreadStatus = 'thinking' | 'done' | 'waiting_on_approval' | 'error'
export const DEFAULT_TRANSCRIPT_WINDOW_LIMIT = 40
export const MAX_TRANSCRIPT_WINDOW_LIMIT = 200

export interface SessionState {
  authenticated: boolean
  csrfToken: string | null
  expiresAt: string | null
}

export interface ThreadSummary {
  id: string
  title: string
  preview: string
  cwd: string | null
  createdAt: string | null
  updatedAt: string | null
  source: string | null
  status: PublicThreadStatus
}

export interface TranscriptItem {
  id: string
  turnId: string | null
  role: 'user' | 'assistant' | 'system'
  text: string
  createdAt: string | null
}

export interface TranscriptHistoryWindow {
  hasOlder: boolean
  nextBeforeItemId: string | null
}

export interface ThreadDetail {
  thread: ThreadSummary
  items: TranscriptItem[]
  history: TranscriptHistoryWindow
}

export interface TranscriptWindowRequest {
  limit?: number | null
  beforeItemId?: string | null
}

export interface ThreadEventSnapshot {
  type: 'snapshot'
  threadId: string
  emittedAt: string
  detail: ThreadDetail
}

export interface ThreadEventTurnStatus {
  type: 'turn_status'
  threadId: string
  emittedAt: string
  turnId: string | null
  status: PublicThreadStatus
  message: string | null
}

export interface ThreadEventAssistantDelta {
  type: 'assistant_delta'
  threadId: string
  emittedAt: string
  turnId: string | null
  itemId: string | null
  text: string
  done: boolean
}

export type ThreadEvent = ThreadEventSnapshot | ThreadEventTurnStatus | ThreadEventAssistantDelta

export interface CreateThreadRequest {
  prompt: string
}

export interface CreateThreadResponse {
  threadId: string
  turnId: string | null
}

export interface SubmitPromptRequest {
  prompt: string
}

export interface SubmitPromptResponse {
  threadId: string
  turnId: string | null
}

export type DesktopSyncMode = 'auto' | 'focus'
export type DesktopSyncReason = 'select' | 'prompt' | 'create'
export type DesktopSyncResult =
  | 'applied'
  | 'focus_required'
  | 'ambiguous_match'
  | 'unavailable'
  | 'unsupported'
  | 'error'

export interface DesktopSyncRequest {
  threadId: string
  mode?: DesktopSyncMode
  reason?: DesktopSyncReason
  expectedVisibleText?: string | null
}

export interface DesktopSyncResponse {
  result: DesktopSyncResult
  message: string | null
}

export interface HealthResponse {
  ok: boolean
}

export interface ReadyResponse {
  ok: boolean
  ready: boolean
  reason: string | null
}

export interface PendingTranscriptItem {
  id: string
  threadId: string
  turnId: string | null
  text: string
  createdAt: string
  status: 'pending' | 'delayed'
}

export interface LiveAssistantItem {
  threadId: string
  turnId: string | null
  itemId: string | null
  text: string
  createdAt: string
  done: boolean
}

export interface TranscriptViewItem extends TranscriptItem {
  presentation: 'persisted' | 'pending' | 'live'
}

export interface TranscriptViewState {
  items: TranscriptViewItem[]
  status: PublicThreadStatus
  awaitingPersistence: boolean
}

export interface CodexRawStatusObject {
  type?: string | null
}

export interface CodexRawNotification {
  method?: string | null
  params?: Record<string, unknown> | null
}

export interface CodexRawThreadSummary {
  id: string
  preview?: string | null
  createdAt?: number | null
  updatedAt?: number | null
  status?: CodexRawStatusObject | string | null
  cwd?: string | null
  source?: string | null
  name?: string | null
  turns?: CodexRawTurn[] | null
}

export interface CodexRawThreadReadResult {
  thread: CodexRawThreadSummary
}

export interface CodexRawTurn {
  id: string
  status?: string | null
  error?: unknown
  items?: CodexRawItem[] | null
}

export type CodexRawItem = CodexRawUserMessage | CodexRawAgentMessage | CodexRawSystemMessage

export interface CodexRawUserMessage {
  type: 'userMessage'
  id: string
  content?: Array<{ type?: string; text?: string | null }> | null
}

export interface CodexRawAgentMessage {
  type: 'agentMessage'
  id: string
  text?: string | null
}

export interface CodexRawSystemMessage {
  type: string
  id?: string
  text?: string | null
  title?: string | null
}
