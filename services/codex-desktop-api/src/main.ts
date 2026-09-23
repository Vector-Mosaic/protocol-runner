import { CodexAppServerBoundary } from '@workstation-control/codex-thread-core'

import { PowerShellDesktopAutomationController } from './desktop-controller.js'
import { readCodexDesktopConfig } from './config.js'
import { createLogger } from './logger.js'
import { CodexDesktopService } from './service.js'
import { startCodexDesktopServer } from './server.js'

const logger = createLogger('codex_desktop_main')

async function main() {
  const config = readCodexDesktopConfig()
  const boundary = new CodexAppServerBoundary(config.codexCliPath, config.allowedWorkspaceRoot)
  const controller = new PowerShellDesktopAutomationController(config)
  const service = new CodexDesktopService({
    config,
    boundary,
    controller,
  })

  await service.initialize()
  const server = await startCodexDesktopServer(service, config)
  logger.info('codex_desktop.server.started', {
    host: config.host,
    port: config.port,
  })

  const shutdown = async () => {
    logger.info('codex_desktop.server.stopping')
    server.close()
    await boundary.stop()
    process.exit(0)
  }

  process.on('SIGINT', () => {
    void shutdown()
  })
  process.on('SIGTERM', () => {
    void shutdown()
  })
}

void main().catch((error) => {
  logger.error('codex_desktop.server.failed', { message: error instanceof Error ? error.message : String(error) })
  process.exitCode = 1
})
