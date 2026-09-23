import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { RelayStateStore, type RelayStateFileSystem } from './state-store.js'

function realFileSystem(overrides: Partial<RelayStateFileSystem> = {}): RelayStateFileSystem {
  const base: RelayStateFileSystem = {
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
  return { ...base, ...overrides }
}

async function assertNoOwnedTemps(stateDir: string): Promise<void> {
  const names = await fs.readdir(stateDir)
  assert.deepEqual(names.filter((name) => name.endsWith('.tmp')), [])
}

test('RelayStateStore persists mappings and allocates stable short labels', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-state-'))
  const store = new RelayStateStore(stateDir, { guildId: 'guild-1', commandChannelId: 'command-1' })

  try {
    const first = await store.ensureChannel({
      discordChannelId: 'channel-1',
      discordChannelName: 'codex-one',
      desktopThreadLabel: 'Thread One',
      status: 'ready',
    })
    assert.equal(first.shortLabel, 1)
    assert.equal(first.status, 'ready')
    assert.equal(first.createdBy, 'unknown')
    assert.match(first.bindingId, /^bind-/)
    assert.equal(first.bindingNoteStatus, 'pending')

    const second = await store.ensureChannel({
      discordChannelId: 'channel-2',
      desktopThreadLabel: 'Thread Two',
      status: 'needs_manual_binding',
      createdBy: 'operator',
    })
    assert.equal(second.shortLabel, 2)
    assert.equal(second.createdBy, 'operator')

    const firstBindingId = first.bindingId
    const rebound = await store.ensureChannel({
      discordChannelId: 'channel-1',
      desktopThreadLabel: 'Thread One Renamed',
    })
    assert.equal(rebound.shortLabel, 1)
    assert.equal(rebound.desktopThreadLabel, 'Thread One Renamed')
    assert.notEqual(rebound.bindingId, firstBindingId)
    assert.equal(rebound.bindingNoteStatus, 'pending')

    const reloaded = new RelayStateStore(stateDir, { guildId: 'guild-1', commandChannelId: 'command-1' })
    const state = await reloaded.read()
    assert.equal(state.nextShortLabel, 3)
    assert.equal(Object.keys(state.channels).length, 2)
    assert.equal(state.channels['channel-1']?.desktopThreadLabel, 'Thread One Renamed')
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('RelayStateStore marks inbound, published, and refused channel state', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-flags-'))
  const store = new RelayStateStore(stateDir, { guildId: 'guild-1', commandChannelId: 'command-1' })

  try {
    await store.ensureChannel({ discordChannelId: 'channel-1', desktopThreadLabel: 'Thread One', status: 'ready' })
    const inbound = await store.markInboundAccepted('channel-1', 'message-in')
    assert.equal(inbound.status, 'waiting_for_codex')
    assert.equal(inbound.lastInboundMessageId, 'message-in')

    const injected = await store.markBindingNoteStatus('channel-1', 'injected')
    assert.equal(injected.bindingNoteStatus, 'injected')

    const published = await store.markPublished('channel-1', 'message-out')
    assert.ok(published)
    assert.equal(published.status, 'ready')
    assert.equal(published.lastOutboundMessageId, 'message-out')

    const refused = await store.markRefused('channel-1', 'desktop unavailable')
    assert.equal(refused.status, 'error')
    assert.equal(refused.lastRefusalReason, 'desktop unavailable')
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('RelayStateStore can preserve a binding id across first desktop label bind', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-bind-preserve-'))
  const store = new RelayStateStore(stateDir, { guildId: 'guild-1', commandChannelId: 'command-1' })

  try {
    const created = await store.ensureChannel({
      discordChannelId: 'channel-1',
      discordChannelName: 'codex-new',
      status: 'needs_manual_binding',
    })
    assert.equal(created.bindingNoteStatus, 'injected')

    const bound = await store.bindChannel({
      discordChannelId: 'channel-1',
      desktopThreadLabel: 'Fresh desktop thread',
      rotateBindingId: false,
    })
    assert.equal(bound.bindingId, created.bindingId)
    assert.equal(bound.bindingNoteStatus, 'injected')

    const rebound = await store.bindChannel({
      discordChannelId: 'channel-1',
      desktopThreadLabel: 'Different desktop thread',
    })
    assert.notEqual(rebound.bindingId, created.bindingId)
    assert.equal(rebound.bindingNoteStatus, 'pending')
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('RelayStateStore deletes mapped channels without reusing short labels', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-delete-'))
  const store = new RelayStateStore(stateDir, { guildId: 'guild-1', commandChannelId: 'command-1' })

  try {
    await store.ensureChannel({ discordChannelId: 'channel-1', desktopThreadLabel: 'Thread One', status: 'ready' })
    const deleted = await store.deleteChannel('channel-1')
    assert.equal(deleted?.desktopThreadLabel, 'Thread One')
    assert.equal((await store.read()).channels['channel-1'], undefined)

    const next = await store.ensureChannel({ discordChannelId: 'channel-2', desktopThreadLabel: 'Thread Two', status: 'ready' })
    assert.equal(next.shortLabel, 2)
    assert.equal(await store.deleteChannel('missing-channel'), null)
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('RelayStateStore persists the last displayed desktop thread list', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-thread-list-'))
  const store = new RelayStateStore(stateDir, { guildId: 'guild-1', commandChannelId: 'command-1' })

  try {
    const list = await store.recordDesktopThreadList({
      group: 'all',
      sourceCommandMessageId: 'message-list',
      items: [
        {
          label: 'Thread One',
          group: 'unknown',
          visible: true,
          turnState: 'idle',
          indicatorText: '1h',
          indicatorReason: 'relative_age_indicator',
        },
        {
          label: 'Thread Two',
          group: 'unknown',
          visible: true,
          turnState: 'working',
          indicatorText: null,
          indicatorReason: 'sidebar_context_progress_indicator_likely',
        },
      ],
    })
    assert.equal(list.items[0]?.index, 1)
    assert.equal(list.items[1]?.index, 2)

    const reloaded = new RelayStateStore(stateDir, { guildId: 'guild-1', commandChannelId: 'command-1' })
    const state = await reloaded.read()
    assert.equal(state.lastDesktopThreadList?.sourceCommandMessageId, 'message-list')
    assert.deepEqual(
      state.lastDesktopThreadList?.items.map((item) => `${item.index}:${item.label}`),
      ['1:Thread One', '2:Thread Two'],
    )
    assert.equal(state.lastDesktopThreadList?.items[1]?.turnState, 'working')
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('RelayStateStore persists active orchestration run state', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-orchestration-state-'))
  const store = new RelayStateStore(stateDir, { guildId: 'guild-1', commandChannelId: 'command-1' })

  try {
    const active = await store.setActiveOrchestrationRun('run-1')
    assert.equal(active.activeRunId, 'run-1')
    assert.equal(active.lastRunId, 'run-1')
    assert.ok(active.updatedAt)

    const cleared = await store.setActiveOrchestrationRun(null)
    assert.equal(cleared.activeRunId, null)
    assert.equal(cleared.lastRunId, 'run-1')

    const reloaded = new RelayStateStore(stateDir, { guildId: 'guild-1', commandChannelId: 'command-1' })
    const state = await reloaded.read()
    assert.equal(state.orchestration.activeRunId, null)
    assert.equal(state.orchestration.lastRunId, 'run-1')
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('RelayStateStore records desktop turn-state observations per channel', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-turn-state-'))
  const store = new RelayStateStore(stateDir, { guildId: 'guild-1', commandChannelId: 'command-1' })

  try {
    await store.ensureChannel({ discordChannelId: 'channel-1', desktopThreadLabel: 'Thread One', status: 'ready' })

    const first = await store.recordChannelTurnState({
      channelId: 'channel-1',
      turnState: 'working',
      observedAt: '2026-05-08T03:00:00.000Z',
    })
    assert.equal(first.previousTurnState, null)
    assert.equal(first.changed, true)
    assert.equal(first.mapping.lastDesktopTurnState, 'working')
    assert.equal(first.mapping.lastDesktopTurnStateChangedAt, '2026-05-08T03:00:00.000Z')

    const second = await store.recordChannelTurnState({
      channelId: 'channel-1',
      turnState: 'working',
      observedAt: '2026-05-08T03:00:30.000Z',
    })
    assert.equal(second.previousTurnState, 'working')
    assert.equal(second.changed, false)
    assert.equal(second.mapping.lastDesktopTurnStateAt, '2026-05-08T03:00:30.000Z')
    assert.equal(second.mapping.lastDesktopTurnStateChangedAt, '2026-05-08T03:00:00.000Z')

    const synced = await store.markChannelTurnStateRegistrySynced('channel-1', '2026-05-08T03:01:00.000Z')
    assert.equal(synced.lastDesktopTurnStateRegistrySyncedAt, '2026-05-08T03:01:00.000Z')

    const reloaded = new RelayStateStore(stateDir, { guildId: 'guild-1', commandChannelId: 'command-1' })
    const mapping = (await reloaded.read()).channels['channel-1']
    assert.equal(mapping?.lastDesktopTurnState, 'working')
    assert.equal(mapping?.lastDesktopTurnStateRegistrySyncedAt, '2026-05-08T03:01:00.000Z')
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('RelayStateStore serializes concurrent channel creation without losing mappings or labels', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-concurrent-channels-'))
  const store = new RelayStateStore(stateDir, { guildId: 'guild-1', commandChannelId: 'command-1' })

  try {
    const mappings = await Promise.all(
      Array.from({ length: 32 }, (_, offset) =>
        store.ensureChannel({
          discordChannelId: `channel-${String(offset + 1).padStart(2, '0')}`,
          desktopThreadLabel: `Thread ${offset + 1}`,
          status: 'ready',
        }),
      ),
    )
    assert.deepEqual(
      mappings.map((mapping) => mapping.shortLabel),
      Array.from({ length: 32 }, (_, offset) => offset + 1),
    )

    const state = await store.read()
    assert.equal(Object.keys(state.channels).length, 32)
    assert.equal(state.nextShortLabel, 33)
    await assertNoOwnedTemps(stateDir)
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('RelayStateStore preserves concurrent mutations to disjoint state sections', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-concurrent-fields-'))
  const store = new RelayStateStore(stateDir, { guildId: 'guild-1', commandChannelId: 'command-1' })

  try {
    await Promise.all([
      store.markCommandSeen('command-message-1'),
      store.setActiveOrchestrationRun('run-1'),
      store.ensureChannel({ discordChannelId: 'channel-1', desktopThreadLabel: 'Thread One', status: 'ready' }),
      store.recordDesktopThreadList({
        group: 'all',
        sourceCommandMessageId: 'list-message-1',
        items: [
          {
            label: 'Thread One',
            group: 'unknown',
            visible: true,
            turnState: 'idle',
            indicatorText: null,
            indicatorReason: null,
          },
        ],
      }),
    ])

    const state = await store.read()
    assert.equal(state.lastCommandMessageId, 'command-message-1')
    assert.equal(state.orchestration.activeRunId, 'run-1')
    assert.equal(state.channels['channel-1']?.desktopThreadLabel, 'Thread One')
    assert.equal(state.lastDesktopThreadList?.sourceCommandMessageId, 'list-message-1')
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('RelayStateStore initialization is idempotent and does not rotate a previous state', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-initialize-'))
  const statePath = path.join(stateDir, 'state.json')
  const previousPath = path.join(stateDir, 'state.previous.json')
  const store = new RelayStateStore(stateDir, { guildId: 'guild-1', commandChannelId: 'command-1' })

  try {
    await store.initialize()
    const initial = await fs.readFile(statePath, 'utf8')
    await assert.rejects(fs.access(previousPath), { code: 'ENOENT' })

    await store.initialize()
    assert.equal(await fs.readFile(statePath, 'utf8'), initial)
    await assert.rejects(fs.access(previousPath), { code: 'ENOENT' })
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('RelayStateStore rotates exactly one validated previous generation', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-previous-'))
  const statePath = path.join(stateDir, 'state.json')
  const previousPath = path.join(stateDir, 'state.previous.json')
  const store = new RelayStateStore(stateDir, { guildId: 'guild-1', commandChannelId: 'command-1' })

  try {
    await store.initialize()
    const emptyState = await fs.readFile(statePath, 'utf8')
    await store.markCommandSeen('message-1')
    const firstState = await fs.readFile(statePath, 'utf8')
    assert.equal(await fs.readFile(previousPath, 'utf8'), emptyState)

    await store.markCommandSeen('message-2')
    assert.equal(await fs.readFile(previousPath, 'utf8'), firstState)
    assert.equal(JSON.parse(await fs.readFile(statePath, 'utf8')).lastCommandMessageId, 'message-2')
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('RelayStateStore preserves the primary and recovers its queue after replacement failure', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-primary-failure-'))
  const statePath = path.join(stateDir, 'state.json')
  let failPrimaryReplace = false
  const fileSystem = realFileSystem({
    async rename(sourcePath, destinationPath) {
      if (failPrimaryReplace && destinationPath === statePath) {
        failPrimaryReplace = false
        throw new Error('injected primary replacement failure')
      }
      await fs.rename(sourcePath, destinationPath)
    },
  })
  const store = new RelayStateStore(
    stateDir,
    { guildId: 'guild-1', commandChannelId: 'command-1' },
    { fileSystem },
  )

  try {
    await store.initialize()
    const before = await fs.readFile(statePath, 'utf8')
    failPrimaryReplace = true
    await assert.rejects(store.markCommandSeen('failed-message'), /injected primary replacement failure/)
    assert.equal(await fs.readFile(statePath, 'utf8'), before)
    await assertNoOwnedTemps(stateDir)

    await store.markCommandSeen('successful-message')
    assert.equal((await store.read()).lastCommandMessageId, 'successful-message')
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('RelayStateStore leaves the primary untouched when previous-state replacement fails', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-previous-failure-'))
  const statePath = path.join(stateDir, 'state.json')
  const previousPath = path.join(stateDir, 'state.previous.json')
  let failPreviousReplace = false
  const fileSystem = realFileSystem({
    async rename(sourcePath, destinationPath) {
      if (failPreviousReplace && destinationPath === previousPath) {
        failPreviousReplace = false
        throw new Error('injected previous replacement failure')
      }
      await fs.rename(sourcePath, destinationPath)
    },
  })
  const store = new RelayStateStore(
    stateDir,
    { guildId: 'guild-1', commandChannelId: 'command-1' },
    { fileSystem },
  )

  try {
    await store.initialize()
    const before = await fs.readFile(statePath, 'utf8')
    failPreviousReplace = true
    await assert.rejects(store.markCommandSeen('failed-message'), /injected previous replacement failure/)
    assert.equal(await fs.readFile(statePath, 'utf8'), before)
    await assertNoOwnedTemps(stateDir)

    await store.markCommandSeen('successful-message')
    assert.equal((await store.read()).lastCommandMessageId, 'successful-message')
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('RelayStateStore uses unique flushed temporary files for durable replacements', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-durable-temp-'))
  const events: string[] = []
  const openedPaths: string[] = []
  const base = realFileSystem()
  const fileSystem = realFileSystem({
    async openExclusive(filePath) {
      openedPaths.push(filePath)
      events.push(`open:${filePath}`)
      const handle = await base.openExclusive(filePath)
      return {
        writeFile: (value) => handle.writeFile(value),
        async sync() {
          events.push(`sync:${filePath}`)
          await handle.sync()
        },
        close: () => handle.close(),
      }
    },
    async rename(sourcePath, destinationPath) {
      events.push(`rename:${sourcePath}`)
      const syncIndex = events.indexOf(`sync:${sourcePath}`)
      assert.notEqual(syncIndex, -1)
      assert.ok(syncIndex < events.length - 1)
      await fs.rename(sourcePath, destinationPath)
    },
  })
  let nonce = 0
  const store = new RelayStateStore(
    stateDir,
    { guildId: 'guild-1', commandChannelId: 'command-1' },
    { fileSystem, nonceFactory: () => `nonce-${++nonce}` },
  )

  try {
    await store.initialize()
    await store.markCommandSeen('message-1')
    assert.equal(new Set(openedPaths).size, openedPaths.length)
    assert.ok(openedPaths.every((filePath) => /state(?:\.previous)?\.json\.\d+\.nonce-\d+\.tmp$/.test(filePath)))
    await assertNoOwnedTemps(stateDir)
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('RelayStateStore fails closed on corrupt primary even when a valid previous state exists', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-corrupt-primary-'))
  const statePath = path.join(stateDir, 'state.json')
  const previousPath = path.join(stateDir, 'state.previous.json')
  const store = new RelayStateStore(stateDir, { guildId: 'guild-1', commandChannelId: 'command-1' })

  try {
    await store.initialize()
    await store.markCommandSeen('message-1')
    const previous = await fs.readFile(previousPath, 'utf8')
    await fs.writeFile(statePath, '\u0000\u0000\u0000', 'utf8')
    const corrupt = await fs.readFile(statePath, 'utf8')

    await assert.rejects(store.read(), /validated previous state exists.*automatic recovery is disabled/)
    assert.equal(await fs.readFile(statePath, 'utf8'), corrupt)
    assert.equal(await fs.readFile(previousPath, 'utf8'), previous)
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('RelayStateStore fails closed when both primary and previous state are corrupt', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-corrupt-both-'))
  const statePath = path.join(stateDir, 'state.json')
  const previousPath = path.join(stateDir, 'state.previous.json')
  const store = new RelayStateStore(stateDir, { guildId: 'guild-1', commandChannelId: 'command-1' })

  try {
    await fs.writeFile(statePath, '{not-json', 'utf8')
    await fs.writeFile(previousPath, '{also-not-json', 'utf8')
    await assert.rejects(store.read(), /state\.json is invalid, and state\.previous\.json is also invalid/)
    assert.equal(await fs.readFile(statePath, 'utf8'), '{not-json')
    assert.equal(await fs.readFile(previousPath, 'utf8'), '{also-not-json')
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('RelayStateStore fails closed when the primary is missing but a valid previous state remains', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-missing-primary-'))
  const statePath = path.join(stateDir, 'state.json')
  const previousPath = path.join(stateDir, 'state.previous.json')
  const store = new RelayStateStore(stateDir, { guildId: 'guild-1', commandChannelId: 'command-1' })

  try {
    await store.initialize()
    await store.markCommandSeen('message-1')
    const previous = await fs.readFile(previousPath, 'utf8')
    await fs.rm(statePath)

    await assert.rejects(store.read(), /state\.json is missing.*validated previous state exists/)
    await assert.rejects(fs.access(statePath), { code: 'ENOENT' })
    assert.equal(await fs.readFile(previousPath, 'utf8'), previous)
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('RelayStateStore rejects unsupported schema versions without rewriting state', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-schema-version-'))
  const statePath = path.join(stateDir, 'state.json')
  const unsupported = `${JSON.stringify({ schemaVersion: 2, channels: {} }, null, 2)}\n`
  const store = new RelayStateStore(stateDir, { guildId: 'guild-1', commandChannelId: 'command-1' })

  try {
    await fs.writeFile(statePath, unsupported, 'utf8')
    await assert.rejects(store.initialize(), /state\.json is invalid, and no validated previous state exists/)
    assert.equal(await fs.readFile(statePath, 'utf8'), unsupported)
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('RelayStateStore normalizes legacy schema-v1 state once while preserving the original generation', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-legacy-'))
  const statePath = path.join(stateDir, 'state.json')
  const previousPath = path.join(stateDir, 'state.previous.json')
  const legacy = `\uFEFF${JSON.stringify({
    schemaVersion: 1,
    guildId: 'guild-1',
    commandChannelId: 'command-1',
    nextShortLabel: 2,
    lastCommandMessageId: null,
    channels: {
      'channel-1': {
        discordChannelId: 'channel-1',
        discordChannelName: 'codex-one',
        shortLabel: 1,
        desktopThreadLabel: 'Thread One',
        codexThreadId: null,
        status: 'ready',
        createdByCommandMessageId: 'command-message-1',
        lastInboundMessageId: 'message-in',
        lastOutboundMessageId: null,
        lastRefusalReason: null,
        createdAt: '2026-05-08T00:00:00.000Z',
        updatedAt: '2026-05-08T00:00:00.000Z',
      },
    },
  })}`
  const store = new RelayStateStore(stateDir, { guildId: 'guild-1', commandChannelId: 'command-1' })

  try {
    await fs.writeFile(statePath, legacy, 'utf8')
    const initialized = await store.initialize()
    assert.equal(initialized.channels['channel-1']?.createdBy, 'discord_command')
    assert.match(initialized.channels['channel-1']?.bindingId ?? '', /^legacy-/)
    assert.equal(initialized.channels['channel-1']?.bindingNoteStatus, 'pending')
    assert.equal(initialized.channels['channel-1']?.lastSeenMessageId, 'message-in')
    assert.equal(await fs.readFile(previousPath, 'utf8'), legacy)

    const canonical = await fs.readFile(statePath, 'utf8')
    await store.initialize()
    assert.equal(await fs.readFile(statePath, 'utf8'), canonical)
    assert.equal(await fs.readFile(previousPath, 'utf8'), legacy)
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('RelayStateStore does not resurrect a closed or rebound mapping after publish', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discord-relay-publish-cas-'))
  const store = new RelayStateStore(stateDir, { guildId: 'guild-1', commandChannelId: 'command-1' })

  try {
    const original = await store.ensureChannel({
      discordChannelId: 'channel-1',
      desktopThreadLabel: 'Thread One',
      status: 'waiting_for_codex',
    })
    await store.deleteChannel('channel-1')
    assert.equal(await store.markPublished('channel-1', 'message-out', original.bindingId), null)
    assert.equal((await store.read()).channels['channel-1'], undefined)

    const rebound = await store.ensureChannel({
      discordChannelId: 'channel-1',
      desktopThreadLabel: 'Thread Two',
      status: 'waiting_for_codex',
    })
    assert.equal(await store.markPublished('channel-1', 'message-stale', original.bindingId), null)
    const current = (await store.read()).channels['channel-1']
    assert.equal(current?.bindingId, rebound.bindingId)
    assert.equal(current?.lastOutboundMessageId, null)
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})
