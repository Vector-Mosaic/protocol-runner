export type RelayChannelStatus = 'ready' | 'waiting_for_codex' | 'needs_manual_binding' | 'error'
export type RelayDesktopTurnState = 'idle' | 'working' | 'unknown'

export interface RelayChannelMapping {
  discordChannelId: string
  discordChannelName: string | null
  shortLabel: number
  createdBy: 'discord_command' | 'operator' | 'unknown'
  purpose?: 'protocol_runner' | null
  desktopThreadLabel: string | null
  codexThreadId: string | null
  bindingId: string
  bindingNoteStatus: 'pending' | 'injected'
  status: RelayChannelStatus
  createdByCommandMessageId: string | null
  lastSeenMessageId: string | null
  lastInboundMessageId: string | null
  lastOutboundMessageId: string | null
  lastRefusalReason: string | null
  lastDesktopTurnState: RelayDesktopTurnState | null
  lastDesktopTurnStateAt: string | null
  lastDesktopTurnStateChangedAt: string | null
  lastDesktopTurnStateRegistrySyncedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface RelayDesktopThreadListItem {
  index: number
  label: string
  group: 'pinned' | 'non_pinned' | 'unknown'
  visible: boolean
  turnState: RelayDesktopTurnState
  indicatorText: string | null
  indicatorReason: string | null
}

export interface RelayDesktopThreadList {
  group: 'all' | 'pinned' | 'non_pinned'
  sourceCommandMessageId: string
  generatedAt: string
  items: RelayDesktopThreadListItem[]
}

export interface RelayOrchestrationState {
  activeRunId: string | null
  lastRunId: string | null
  updatedAt: string | null
}

export interface RelayState {
  schemaVersion: 1
  guildId: string
  commandChannelId: string
  nextShortLabel: number
  lastCommandMessageId: string | null
  lastDesktopThreadList: RelayDesktopThreadList | null
  orchestration: RelayOrchestrationState
  channels: Record<string, RelayChannelMapping>
}

export interface PublishRequest {
  channelId: string
  bindingId: string
  text: string
  source?: string
  correlationId?: string
}

export interface PublishResult {
  ok: true
  channelId: string
  messageIds: string[]
  chunkCount: number
  textSha256: string
}
