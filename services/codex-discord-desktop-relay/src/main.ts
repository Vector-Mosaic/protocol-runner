import { DiscordBotClient } from '@workstation-control/discord-transport'

import { readCodexDiscordDesktopRelayConfig } from './config.js'
import {
  CodexDesktopApiAdapter,
  SafeStubDesktopAdapter,
  type DesktopAdapter,
} from './desktop-adapter.js'
import { DiscordPublisher } from './discord-publisher.js'
import { createLogger } from './logger.js'
import { OrchestrationCliClient } from './orchestration-client.js'
import { CodexDiscordDesktopRelayService } from './relay-service.js'
import { startCodexDiscordDesktopRelayServer } from './server.js'
import { RelayStateStore } from './state-store.js'

const logger = createLogger('codex_discord_desktop_relay_main')

function createDesktopAdapter(config: ReturnType<typeof readCodexDiscordDesktopRelayConfig>): DesktopAdapter {
  if (config.desktopAdapterMode === 'api') {
    if (!config.desktopApiBearerToken) {
      throw new Error('Codex Desktop API bearer token is required for the relay API desktop adapter.')
    }
    return new CodexDesktopApiAdapter({
      windowTitle: config.windowTitle,
      baseUrl: config.desktopApiBaseUrl,
      bearerToken: config.desktopApiBearerToken,
      requestTimeoutMs: config.desktopApiTimeoutMs,
      actionMode: config.desktopActionMode,
    })
  }

  return new SafeStubDesktopAdapter(config.windowTitle)
}

async function main() {
  const config = readCodexDiscordDesktopRelayConfig()

  const discord = new DiscordBotClient({
    apiBaseUrl: config.discord.apiBaseUrl,
    botToken: config.discord.botToken,
    guildId: config.discord.guildId,
  })
  await discord.initialize()

  const store = new RelayStateStore(config.stateDir, {
    guildId: config.discord.guildId,
    commandChannelId: config.discord.commandChannelId,
  })
  await store.initialize()
  const desktop = createDesktopAdapter(config)
  const relay = new CodexDiscordDesktopRelayService({
    config,
    desktop,
    discord,
    orchestration: config.orchestration.enabled
      ? new OrchestrationCliClient({
          pythonPath: config.orchestration.pythonPath,
          cliPath: config.orchestration.cliPath,
          cwd: config.allowedCwd,
          dbPath: config.orchestration.dbPath,
          exportRoot: config.orchestration.exportRoot,
          timeoutMs: config.orchestration.timeoutMs,
        })
      : null,
    store,
  })
  await relay.start()

  const server = await startCodexDiscordDesktopRelayServer({
    config,
    desktop,
    publisher: new DiscordPublisher(discord),
    relay,
    store,
  })

  logger.info('relay.server.started', {
    host: config.host,
    port: config.port,
    state_dir: config.stateDir,
    command_channel_id: config.discord.commandChannelId,
  })

  let shutdownPromise: Promise<never> | null = null

  const shutdown = async (reason: string): Promise<never> => {
    if (shutdownPromise) {
      return shutdownPromise
    }

    shutdownPromise = (async () => {
      logger.info('relay.server.stopping', { reason })
      relay.stop()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error)
            return
          }

          resolve()
        })
      })
      process.exit(0)
    })().catch((error) => {
      logger.error('relay.server.stop_failed', {
        reason,
        message: error instanceof Error ? error.message : String(error),
      })
      process.exit(1)
    })

    return shutdownPromise
  }


  process.on('SIGINT', () => {
    void shutdown('sigint')
  })
  process.on('SIGTERM', () => {
    void shutdown('sigterm')
  })
}

void main().catch((error) => {
  logger.error('relay.server.failed', { message: error instanceof Error ? error.message : String(error) })
  process.exitCode = 1
})
