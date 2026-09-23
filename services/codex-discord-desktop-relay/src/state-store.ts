import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import type {
  RelayChannelMapping,
  RelayChannelStatus,
  RelayDesktopThreadList,
  RelayDesktopThreadListItem,
  RelayDesktopTurnState,
  RelayOrchestrationState,
  RelayState,
} from './types.js'

const STATE_FILENAME = 'state.json'
const PREVIOUS_STATE_FILENAME = 'state.previous.json'

export interface RelayStateFileHandle {
  writeFile(value: string): Promise<void>
  sync(): Promise<void>
  close(): Promise<void>
}

export interface RelayStateFileSystem {
  readFile(filePath: string): Promise<string>
  mkdir(directoryPath: string): Promise<void>
  openExclusive(filePath: string): Promise<RelayStateFileHandle>
  rename(sourcePath: string, destinationPath: string): Promise<void>
  remove(filePath: string): Promise<void>
}

interface RelayStateStoreOptions {
  fileSystem?: RelayStateFileSystem
  nonceFactory?: () => string
}

interface LoadedState {
  state: RelayState
  raw: string | null
  canonical: string
  exists: boolean
}

const nodeFileSystem: RelayStateFileSystem = {
  async readFile(filePath) {
    return fs.readFile(filePath, 'utf8')
  },
  async mkdir(directoryPath) {
    await fs.mkdir(directoryPath, { recursive: true })
  },
  async openExclusive(filePath) {
    const handle = await fs.open(filePath, 'wx', 0o600)
    return {
      async writeFile(value) {
        await handle.writeFile(value, 'utf8')
      },
      async sync() {
        await handle.sync()
      },
      async close() {
        await handle.close()
      },
    }
  },
  async rename(sourcePath, destinationPath) {
    await fs.rename(sourcePath, destinationPath)
  },
  async remove(filePath) {
    await fs.rm(filePath, { force: true })
  },
}

function nowIso(): string {
  return new Date().toISOString()
}

function createBindingId(): string {
  return `bind-${crypto.randomUUID()}`
}

function legacyBindingId(channelId: string): string {
  return `legacy-${crypto.createHash('sha256').update(channelId, 'utf8').digest('hex').slice(0, 24)}`
}

function normalizeCreatedBy(value: unknown, createdByCommandMessageId: string | null): RelayChannelMapping['createdBy'] {
  if (value === 'discord_command' || value === 'operator' || value === 'unknown') {
    return value
  }
  return createdByCommandMessageId ? 'discord_command' : 'unknown'
}

function normalizeTurnState(value: unknown): RelayDesktopTurnState | null {
  return value === 'idle' || value === 'working' || value === 'unknown' ? value : null
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function normalizeThreadList(value: unknown): RelayDesktopThreadList | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const record = value as Partial<RelayDesktopThreadList>
  const group = record.group === 'pinned' || record.group === 'non_pinned' || record.group === 'all' ? record.group : 'all'
  const items = Array.isArray(record.items)
    ? record.items
        .map((item, offset): RelayDesktopThreadListItem | null => {
          if (!item || typeof item !== 'object') {
            return null
          }
          const candidate = item as Partial<RelayDesktopThreadListItem>
          const label = typeof candidate.label === 'string' ? candidate.label.trim() : ''
          if (!label) {
            return null
          }
          const itemGroup =
            candidate.group === 'pinned' || candidate.group === 'non_pinned' || candidate.group === 'unknown'
              ? candidate.group
              : 'unknown'
          return {
            index: Math.max(1, Number(candidate.index) || offset + 1),
            label,
            group: itemGroup,
            visible: candidate.visible !== false,
            turnState: normalizeTurnState(candidate.turnState) ?? 'unknown',
            indicatorText:
              typeof candidate.indicatorText === 'string' && candidate.indicatorText.trim()
                ? candidate.indicatorText.trim()
                : null,
            indicatorReason:
              typeof candidate.indicatorReason === 'string' && candidate.indicatorReason.trim()
                ? candidate.indicatorReason.trim()
                : null,
          }
        })
        .filter((item): item is RelayDesktopThreadListItem => item !== null)
    : []
  return {
    group,
    sourceCommandMessageId:
      typeof record.sourceCommandMessageId === 'string' && record.sourceCommandMessageId.trim()
        ? record.sourceCommandMessageId
        : '',
    generatedAt: typeof record.generatedAt === 'string' && record.generatedAt.trim() ? record.generatedAt : nowIso(),
    items,
  }
}

function normalizeOrchestrationState(value: unknown): RelayOrchestrationState {
  if (!value || typeof value !== 'object') {
    return { activeRunId: null, lastRunId: null, updatedAt: null }
  }
  const record = value as Partial<RelayOrchestrationState>
  return {
    activeRunId: typeof record.activeRunId === 'string' && record.activeRunId.trim() ? record.activeRunId.trim() : null,
    lastRunId: typeof record.lastRunId === 'string' && record.lastRunId.trim() ? record.lastRunId.trim() : null,
    updatedAt: typeof record.updatedAt === 'string' && record.updatedAt.trim() ? record.updatedAt.trim() : null,
  }
}

function canonicalStateJson(state: RelayState): string {
  return `${JSON.stringify(state, null, 2)}\n`
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

export class RelayStateStore {
  private readonly fileSystem: RelayStateFileSystem
  private readonly nonceFactory: () => string
  private operationTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly stateDir: string,
    private readonly defaults: { guildId: string; commandChannelId: string },
    options: RelayStateStoreOptions = {},
  ) {
    this.fileSystem = options.fileSystem ?? nodeFileSystem
    this.nonceFactory = options.nonceFactory ?? (() => crypto.randomUUID())
  }

  private statePath(): string {
    return path.join(this.stateDir, STATE_FILENAME)
  }

  private previousStatePath(): string {
    return path.join(this.stateDir, PREVIOUS_STATE_FILENAME)
  }

  private emptyState(): RelayState {
    return {
      schemaVersion: 1,
      guildId: this.defaults.guildId,
      commandChannelId: this.defaults.commandChannelId,
      nextShortLabel: 1,
      lastCommandMessageId: null,
      lastDesktopThreadList: null,
      orchestration: { activeRunId: null, lastRunId: null, updatedAt: null },
      channels: {},
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation)
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private parseState(raw: string, sourceName: string): RelayState {
    let parsedValue: unknown
    try {
      parsedValue = JSON.parse(raw.replace(/^\uFEFF/, ''))
    } catch {
      throw new Error(`${sourceName} is not valid JSON.`)
    }
    if (!parsedValue || typeof parsedValue !== 'object' || Array.isArray(parsedValue)) {
      throw new Error(`${sourceName} does not contain a relay state object.`)
    }
    const parsed = parsedValue as Partial<RelayState>
    if (parsed.schemaVersion !== 1) {
      throw new Error(`Unsupported relay state schema version: ${String(parsed.schemaVersion)}`)
    }
    const rawChannels = parsed.channels && typeof parsed.channels === 'object' && !Array.isArray(parsed.channels)
      ? parsed.channels
      : {}
    const channels = Object.fromEntries(
      Object.entries(rawChannels).map(([channelId, mappingValue]) => {
        if (!mappingValue || typeof mappingValue !== 'object' || Array.isArray(mappingValue)) {
          throw new Error(`${sourceName} contains an invalid channel mapping.`)
        }
        const mapping = mappingValue as RelayChannelMapping
        return [
          channelId,
          {
            ...mapping,
            createdBy: normalizeCreatedBy(mapping.createdBy, mapping.createdByCommandMessageId ?? null),
            bindingId:
              typeof mapping.bindingId === 'string' && mapping.bindingId.trim()
                ? mapping.bindingId.trim()
                : legacyBindingId(channelId),
            bindingNoteStatus:
              mapping.bindingNoteStatus === 'pending' || mapping.bindingNoteStatus === 'injected'
                ? mapping.bindingNoteStatus
                : mapping.desktopThreadLabel
                  ? 'pending'
                  : 'injected',
            createdByCommandMessageId: mapping.createdByCommandMessageId ?? null,
            lastSeenMessageId: mapping.lastSeenMessageId ?? mapping.lastInboundMessageId ?? mapping.lastOutboundMessageId ?? null,
            lastDesktopTurnState: normalizeTurnState(mapping.lastDesktopTurnState),
            lastDesktopTurnStateAt: normalizeOptionalString(mapping.lastDesktopTurnStateAt),
            lastDesktopTurnStateChangedAt: normalizeOptionalString(mapping.lastDesktopTurnStateChangedAt),
            lastDesktopTurnStateRegistrySyncedAt: normalizeOptionalString(mapping.lastDesktopTurnStateRegistrySyncedAt),
          },
        ]
      }),
    )
    return {
      schemaVersion: 1,
      guildId: parsed.guildId || this.defaults.guildId,
      commandChannelId: parsed.commandChannelId || this.defaults.commandChannelId,
      nextShortLabel: Math.max(1, Number(parsed.nextShortLabel) || 1),
      lastCommandMessageId: parsed.lastCommandMessageId ?? null,
      lastDesktopThreadList: normalizeThreadList(parsed.lastDesktopThreadList),
      orchestration: normalizeOrchestrationState(parsed.orchestration),
      channels,
    }
  }

  private async previousStateCondition(): Promise<'validated' | 'missing' | 'invalid' | 'unreadable'> {
    try {
      this.parseState(await this.fileSystem.readFile(this.previousStatePath()), PREVIOUS_STATE_FILENAME)
      return 'validated'
    } catch (error) {
      if (isMissingFile(error)) {
        return 'missing'
      }
      if (
        error instanceof Error &&
        (error.message === `${PREVIOUS_STATE_FILENAME} is not valid JSON.` ||
          error.message === `${PREVIOUS_STATE_FILENAME} does not contain a relay state object.` ||
          error.message === `${PREVIOUS_STATE_FILENAME} contains an invalid channel mapping.` ||
          error.message.startsWith('Unsupported relay state schema version:'))
      ) {
        return 'invalid'
      }
      return 'unreadable'
    }
  }

  private async primaryStateFailure(issue: 'missing' | 'invalid', cause?: unknown): Promise<never> {
    const previousCondition = await this.previousStateCondition()
    const issueText = issue === 'missing' ? 'is missing' : 'is invalid'
    if (previousCondition === 'validated') {
      throw new Error(
        `${STATE_FILENAME} ${issueText}. A validated previous state exists at ${PREVIOUS_STATE_FILENAME}; automatic recovery is disabled to prevent command or binding replay.`,
        { cause },
      )
    }
    if (previousCondition === 'invalid') {
      throw new Error(`${STATE_FILENAME} ${issueText}, and ${PREVIOUS_STATE_FILENAME} is also invalid.`, { cause })
    }
    if (previousCondition === 'unreadable') {
      throw new Error(`${STATE_FILENAME} ${issueText}, and ${PREVIOUS_STATE_FILENAME} could not be read.`, { cause })
    }
    throw new Error(`${STATE_FILENAME} ${issueText}, and no validated previous state exists.`, { cause })
  }

  private async readPrimaryUnlocked(): Promise<LoadedState> {
    let raw: string
    try {
      raw = await this.fileSystem.readFile(this.statePath())
    } catch (error) {
      if (!isMissingFile(error)) {
        throw error
      }
      if ((await this.previousStateCondition()) !== 'missing') {
        return this.primaryStateFailure('missing', error)
      }
      const state = this.emptyState()
      return { state, raw: null, canonical: canonicalStateJson(state), exists: false }
    }
    try {
      const state = this.parseState(raw, STATE_FILENAME)
      return { state, raw, canonical: canonicalStateJson(state), exists: true }
    } catch (error) {
      return this.primaryStateFailure('invalid', error)
    }
  }

  private async replaceDurably(destinationPath: string, value: string): Promise<void> {
    await this.fileSystem.mkdir(path.dirname(destinationPath))
    const tempPath = `${destinationPath}.${process.pid}.${this.nonceFactory()}.tmp`
    let handle: RelayStateFileHandle | null = null
    try {
      handle = await this.fileSystem.openExclusive(tempPath)
      await handle.writeFile(value)
      await handle.sync()
      await handle.close()
      handle = null
      if ((await this.fileSystem.readFile(tempPath)) !== value) {
        throw new Error(`Durable relay state staging verification failed for ${path.basename(destinationPath)}.`)
      }
      await this.fileSystem.rename(tempPath, destinationPath)
      if ((await this.fileSystem.readFile(destinationPath)) !== value) {
        throw new Error(`Durable relay state replacement verification failed for ${path.basename(destinationPath)}.`)
      }
    } finally {
      if (handle) {
        await handle.close().catch(() => undefined)
      }
      await this.fileSystem.remove(tempPath).catch(() => undefined)
    }
  }

  private async commitUnlocked(current: LoadedState, candidate: RelayState): Promise<void> {
    const normalized = this.parseState(canonicalStateJson(candidate), 'candidate relay state')
    const nextRaw = canonicalStateJson(normalized)
    if (current.exists && current.raw === nextRaw) {
      return
    }
    if (current.exists && current.raw !== null) {
      await this.replaceDurably(this.previousStatePath(), current.raw)
    }
    await this.replaceDurably(this.statePath(), nextRaw)
  }

  private async mutate<T>(operation: (state: RelayState) => T): Promise<T> {
    return this.enqueue(async () => {
      const current = await this.readPrimaryUnlocked()
      const result = operation(current.state)
      await this.commitUnlocked(current, current.state)
      return result
    })
  }

  async initialize(): Promise<RelayState> {
    return this.enqueue(async () => {
      const current = await this.readPrimaryUnlocked()
      if (!current.exists || current.raw !== current.canonical) {
        await this.commitUnlocked(current, current.state)
      }
      return current.state
    })
  }

  async read(): Promise<RelayState> {
    return this.enqueue(async () => (await this.readPrimaryUnlocked()).state)
  }

  async write(state: RelayState): Promise<void> {
    await this.enqueue(async () => {
      await this.commitUnlocked(await this.readPrimaryUnlocked(), state)
    })
  }

  async ensureChannel(args: {
    discordChannelId: string
    discordChannelName?: string | null
    desktopThreadLabel?: string | null
    codexThreadId?: string | null
    status?: RelayChannelStatus
    createdBy?: RelayChannelMapping['createdBy']
    purpose?: RelayChannelMapping['purpose']
    createdByCommandMessageId?: string | null
    lastSeenMessageId?: string | null
    bindingNoteStatus?: RelayChannelMapping['bindingNoteStatus']
  }): Promise<RelayChannelMapping> {
    return this.mutate((state) => {
      const existing = state.channels[args.discordChannelId]
      const timestamp = nowIso()
      const nextDesktopThreadLabel = args.desktopThreadLabel ?? existing?.desktopThreadLabel ?? null
      const labelChanged = Boolean(existing) && args.desktopThreadLabel !== undefined && args.desktopThreadLabel !== existing?.desktopThreadLabel
      const mapping: RelayChannelMapping = existing
        ? {
            ...existing,
            discordChannelName: args.discordChannelName ?? existing.discordChannelName,
            createdBy: args.createdBy ?? existing.createdBy,
            purpose: args.purpose ?? existing.purpose ?? null,
            desktopThreadLabel: nextDesktopThreadLabel,
            codexThreadId: args.codexThreadId ?? existing.codexThreadId,
            bindingId: labelChanged ? createBindingId() : existing.bindingId,
            bindingNoteStatus: args.bindingNoteStatus ?? (labelChanged ? 'pending' : existing.bindingNoteStatus),
            status: args.status ?? existing.status,
            createdByCommandMessageId: args.createdByCommandMessageId ?? existing.createdByCommandMessageId,
            lastSeenMessageId: args.lastSeenMessageId ?? existing.lastSeenMessageId,
            updatedAt: timestamp,
          }
        : {
            discordChannelId: args.discordChannelId,
            discordChannelName: args.discordChannelName ?? null,
            shortLabel: state.nextShortLabel,
            createdBy: args.createdBy ?? (args.createdByCommandMessageId ? 'discord_command' : 'unknown'),
            purpose: args.purpose ?? null,
            desktopThreadLabel: nextDesktopThreadLabel,
            codexThreadId: args.codexThreadId ?? null,
            bindingId: createBindingId(),
            bindingNoteStatus: args.bindingNoteStatus ?? (nextDesktopThreadLabel ? 'pending' : 'injected'),
            status: args.status ?? 'needs_manual_binding',
            createdByCommandMessageId: args.createdByCommandMessageId ?? null,
            lastSeenMessageId: args.lastSeenMessageId ?? null,
            lastInboundMessageId: null,
            lastOutboundMessageId: null,
            lastRefusalReason: null,
            lastDesktopTurnState: null,
            lastDesktopTurnStateAt: null,
            lastDesktopTurnStateChangedAt: null,
            lastDesktopTurnStateRegistrySyncedAt: null,
            createdAt: timestamp,
            updatedAt: timestamp,
          }
      state.channels[args.discordChannelId] = mapping
      if (!existing) {
        state.nextShortLabel += 1
      }
      return mapping
    })
  }

  async markCommandSeen(messageId: string): Promise<void> {
    await this.mutate((state) => {
      state.lastCommandMessageId = messageId
    })
  }

  async setActiveOrchestrationRun(runId: string | null): Promise<RelayOrchestrationState> {
    return this.mutate((state) => {
      state.orchestration = {
        activeRunId: runId,
        lastRunId: runId ?? state.orchestration.lastRunId,
        updatedAt: nowIso(),
      }
      return state.orchestration
    })
  }

  async recordDesktopThreadList(args: {
    group: RelayDesktopThreadList['group']
    sourceCommandMessageId: string
    items: Array<Omit<RelayDesktopThreadListItem, 'index'>>
  }): Promise<RelayDesktopThreadList> {
    return this.mutate((state) => {
      const list: RelayDesktopThreadList = {
        group: args.group,
        sourceCommandMessageId: args.sourceCommandMessageId,
        generatedAt: nowIso(),
        items: args.items.map((item, offset) => ({
          index: offset + 1,
          label: item.label,
          group: item.group,
          visible: item.visible,
          turnState: item.turnState,
          indicatorText: item.indicatorText,
          indicatorReason: item.indicatorReason,
        })),
      }
      state.lastDesktopThreadList = list
      return list
    })
  }

  async markChannelSeen(channelId: string, messageId: string): Promise<RelayChannelMapping> {
    return this.mutate((state) => {
      const mapping = state.channels[channelId]
      if (!mapping) {
        throw new Error(`Discord channel is not mapped: ${channelId}`)
      }
      mapping.lastSeenMessageId = messageId
      mapping.updatedAt = nowIso()
      return mapping
    })
  }

  async bindChannel(args: {
    discordChannelId: string
    desktopThreadLabel: string
    codexThreadId?: string | null
    rotateBindingId?: boolean
  }): Promise<RelayChannelMapping> {
    return this.mutate((state) => {
      const mapping = state.channels[args.discordChannelId]
      if (!mapping) {
        throw new Error(`Discord channel is not mapped: ${args.discordChannelId}`)
      }
      const labelChanged = mapping.desktopThreadLabel !== args.desktopThreadLabel
      mapping.desktopThreadLabel = args.desktopThreadLabel
      mapping.codexThreadId = args.codexThreadId ?? mapping.codexThreadId
      if (labelChanged && args.rotateBindingId !== false) {
        mapping.bindingId = createBindingId()
        mapping.bindingNoteStatus = 'pending'
      } else if (!mapping.bindingId) {
        mapping.bindingId = createBindingId()
        mapping.bindingNoteStatus = 'pending'
      }
      mapping.status = 'ready'
      mapping.lastRefusalReason = null
      mapping.updatedAt = nowIso()
      return mapping
    })
  }

  async markInboundAccepted(channelId: string, messageId: string): Promise<RelayChannelMapping> {
    return this.mutate((state) => {
      const mapping = state.channels[channelId]
      if (!mapping) {
        throw new Error(`Discord channel is not mapped: ${channelId}`)
      }
      mapping.status = 'waiting_for_codex'
      mapping.lastSeenMessageId = messageId
      mapping.lastInboundMessageId = messageId
      mapping.lastRefusalReason = null
      mapping.updatedAt = nowIso()
      return mapping
    })
  }

  async markPublished(channelId: string, messageId: string, expectedBindingId?: string): Promise<RelayChannelMapping | null> {
    return this.mutate((state) => {
      const existing = state.channels[channelId]
      if (expectedBindingId && (!existing || existing.bindingId !== expectedBindingId)) {
        return null
      }
      if (!existing && channelId === state.commandChannelId) {
        return null
      }
      const timestamp = nowIso()
      const mapping = existing ?? ({
        discordChannelId: channelId,
        discordChannelName: null,
        shortLabel: state.nextShortLabel++,
        createdBy: 'unknown',
        desktopThreadLabel: null,
        codexThreadId: null,
        bindingId: createBindingId(),
        bindingNoteStatus: 'injected',
        status: 'ready',
        createdByCommandMessageId: null,
        lastSeenMessageId: null,
        lastInboundMessageId: null,
        lastOutboundMessageId: null,
        lastRefusalReason: null,
        lastDesktopTurnState: null,
        lastDesktopTurnStateAt: null,
        lastDesktopTurnStateChangedAt: null,
        lastDesktopTurnStateRegistrySyncedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      } satisfies RelayChannelMapping)
      mapping.status = 'ready'
      mapping.lastSeenMessageId = messageId || mapping.lastSeenMessageId
      mapping.lastOutboundMessageId = messageId
      mapping.lastRefusalReason = null
      mapping.updatedAt = timestamp
      state.channels[channelId] = mapping
      return mapping
    })
  }

  async markRefused(channelId: string, reason: string): Promise<RelayChannelMapping> {
    return this.mutate((state) => {
      const timestamp = nowIso()
      const mapping = state.channels[channelId] ?? ({
        discordChannelId: channelId,
        discordChannelName: null,
        shortLabel: state.nextShortLabel++,
        createdBy: 'unknown',
        desktopThreadLabel: null,
        codexThreadId: null,
        bindingId: createBindingId(),
        bindingNoteStatus: 'injected',
        status: 'error',
        createdByCommandMessageId: null,
        lastSeenMessageId: null,
        lastInboundMessageId: null,
        lastOutboundMessageId: null,
        lastRefusalReason: null,
        lastDesktopTurnState: null,
        lastDesktopTurnStateAt: null,
        lastDesktopTurnStateChangedAt: null,
        lastDesktopTurnStateRegistrySyncedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      } satisfies RelayChannelMapping)
      mapping.status = 'error'
      mapping.lastRefusalReason = reason
      mapping.updatedAt = timestamp
      state.channels[channelId] = mapping
      return mapping
    })
  }

  async deleteChannel(channelId: string): Promise<RelayChannelMapping | null> {
    return this.mutate((state) => {
      const mapping = state.channels[channelId] ?? null
      if (mapping) {
        delete state.channels[channelId]
      }
      return mapping
    })
  }

  async markBindingNoteStatus(channelId: string, bindingNoteStatus: RelayChannelMapping['bindingNoteStatus']): Promise<RelayChannelMapping> {
    return this.mutate((state) => {
      const mapping = state.channels[channelId]
      if (!mapping) {
        throw new Error(`Discord channel is not mapped: ${channelId}`)
      }
      mapping.bindingNoteStatus = bindingNoteStatus
      mapping.updatedAt = nowIso()
      return mapping
    })
  }

  async recordChannelTurnState(args: {
    channelId: string
    turnState: RelayDesktopTurnState
    observedAt?: string | null
  }): Promise<{ mapping: RelayChannelMapping; previousTurnState: RelayDesktopTurnState | null; changed: boolean }> {
    return this.mutate((state) => {
      const mapping = state.channels[args.channelId]
      if (!mapping) {
        throw new Error(`Discord channel is not mapped: ${args.channelId}`)
      }
      const timestamp = args.observedAt ?? nowIso()
      const previousTurnState = mapping.lastDesktopTurnState
      const changed = previousTurnState !== args.turnState
      mapping.lastDesktopTurnState = args.turnState
      mapping.lastDesktopTurnStateAt = timestamp
      if (changed) {
        mapping.lastDesktopTurnStateChangedAt = timestamp
      }
      mapping.updatedAt = timestamp
      return { mapping, previousTurnState, changed }
    })
  }

  async markChannelTurnStateRegistrySynced(channelId: string, syncedAt?: string | null): Promise<RelayChannelMapping> {
    return this.mutate((state) => {
      const mapping = state.channels[channelId]
      if (!mapping) {
        throw new Error(`Discord channel is not mapped: ${channelId}`)
      }
      mapping.lastDesktopTurnStateRegistrySyncedAt = syncedAt ?? nowIso()
      mapping.updatedAt = nowIso()
      return mapping
    })
  }
}
