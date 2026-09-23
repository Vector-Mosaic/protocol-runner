export type DesktopActionMode = 'auto' | 'focus'
export type DesktopActionResult =
  | 'applied'
  | 'focus_required'
  | 'thread_mismatch'
  | 'ambiguous_match'
  | 'unavailable'
  | 'unsupported'
  | 'error'

export interface DesktopVisibleThreadRow {
  title: string
  label: string
  rowName: string
  turnState: 'idle' | 'working' | 'unknown'
  indicatorText: string | null
  indicatorReason: string | null
  isThreadRow: boolean
}

export interface DesktopStatePayload {
  windowFound: boolean
  threadListAccessible: boolean
  visibleThreadCount: number
  composeAvailable: boolean
  readbackAvailable: boolean
  selectedSidebarThreadTitle: string | null
  selectedSidebarThreadTitles: string[]
  visibleThreadRows: DesktopVisibleThreadRow[]
  visibleTranscriptLines: string[]
  visibleTranscriptText: string
}

export interface DesktopStateResult extends DesktopStatePayload {
  result: DesktopActionResult
  message: string | null
  selectionConfirmed?: boolean | null
  expanded?: number | null
  composeDiagnostics?: Record<string, unknown> | null
  desktopActionQueue?: unknown
}

export interface DesktopThreadRequest {
  threadId?: string | null
  threadTitle?: string | null
  mode?: DesktopActionMode | null
  caller?: string | null
}

export interface DesktopPromptRequest extends DesktopThreadRequest {
  text?: string | null
}

export interface DesktopCreateRequest {
  text?: string | null
  mode?: DesktopActionMode | null
  caller?: string | null
}

export interface DesktopActionEnvelope extends DesktopStateResult {
  threadId: string | null
  threadTitle: string | null
  turnId: string | null
  itemId: string | null
  selectionConfirmed: boolean | null
  expanded: number | null
}
