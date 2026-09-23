import { HybridRunnerStore, JsonRunnerStore, SqliteRunnerStore } from './store.js'
import { FakeCodexDesktopAdapter, FakeDiscordRelayAdapter } from './adapters.js'
import { readProtocolRunnerApiConfig } from './config.js'
import { ProtocolRunnerController } from './controller.js'
import { HttpCodexDesktopAdapter, HttpDiscordRelayAdapter } from './http-adapters.js'
import { NoopRunnerAttentionNotifier, ShellRunnerAttentionNotifier } from './run-notifier.js'
import { createProtocolRunnerServer } from './server.js'
import { startProtocolRunnerListener } from './startup.js'

const config = readProtocolRunnerApiConfig()
const desktopAdapter =
  config.adapterMode === 'real'
    ? new HttpCodexDesktopAdapter({
        baseUrl: config.desktop.baseUrl,
        bearerToken: config.desktop.bearerToken,
        promptMode: config.desktop.promptMode,
      })
    : new FakeCodexDesktopAdapter()
const relayAdapter =
  config.adapterMode === 'real'
    ? new HttpDiscordRelayAdapter({
        baseUrl: config.relay.baseUrl,
        operatorBearerToken: config.relay.operatorBearerToken,
        publishBearerToken: config.relay.publishBearerToken,
      })
    : new FakeDiscordRelayAdapter()
const store =
  config.storeMode === 'json'
    ? new JsonRunnerStore({ runs_root: config.runsRoot ?? undefined })
    : new HybridRunnerStore({
        primary: new SqliteRunnerStore({
          runs_root: config.runsRoot ?? undefined,
          db_path: config.dbPath,
        }),
        legacy_json: new JsonRunnerStore({ runs_root: config.runsRoot ?? undefined }),
      })
const notificationNotifier = config.notification.enabled
  ? new ShellRunnerAttentionNotifier({
      scriptPath: config.notification.scriptPath,
      notifyUrl: config.notification.notifyUrl,
      repoRoot: config.notification.repoRoot,
    })
  : new NoopRunnerAttentionNotifier()

const controller = new ProtocolRunnerController({
  store,
  desktop_adapter: desktopAdapter,
  relay_adapter: relayAdapter,
  contract_root: config.contractRoot,
  report_commands: config.reportCommands,
  notification_notifier: notificationNotifier,
})
const server = createProtocolRunnerServer({ controller, security: config.security })

async function main(): Promise<void> {
  await startProtocolRunnerListener({
    store,
    server,
    port: config.port,
    host: config.host,
    onListening: () => {
      process.stdout.write(
        `protocol-runner-api listening on http://${config.host}:${config.port} adapter_mode=${config.adapterMode} store_mode=${config.storeMode}\n`,
      )
    },
  })
}

void main().catch((error: unknown) => {
  const errorClass = error instanceof Error ? error.name : 'UnknownError'
  process.stderr.write(`protocol-runner-api startup preflight failed error_class=${errorClass}\n`)
  process.exitCode = 1
})
