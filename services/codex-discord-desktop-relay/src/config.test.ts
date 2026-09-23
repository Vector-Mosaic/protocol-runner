import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { readCodexDiscordDesktopRelayConfig } from './config.js'

function baseEnv(): NodeJS.ProcessEnv {
  return {
    WORKSTATION_CONTROL_DISCORD_DESKTOP_RELAY_PUBLISH_BEARER_TOKEN: 'publish-secret',
    WORKSTATION_CONTROL_DISCORD_DESKTOP_RELAY_BOT_TOKEN: 'bot-token',
    WORKSTATION_CONTROL_DISCORD_DESKTOP_RELAY_GUILD_ID: 'guild-1',
    WORKSTATION_CONTROL_DISCORD_DESKTOP_RELAY_COMMAND_CHANNEL_ID: 'command-1',
  }
}

test('readCodexDiscordDesktopRelayConfig supplies safe loopback defaults', () => {
  const config = readCodexDiscordDesktopRelayConfig({
    ...baseEnv(),
    LOCALAPPDATA: path.join(os.tmpdir(), 'local-app-data'),
  })

  assert.equal(config.host, '127.0.0.1')
  assert.equal(config.port, 4830)
  assert.equal(config.windowTitle, 'Codex')
  assert.equal(config.desktopAdapterMode, 'stub')
  assert.equal(config.desktopActionMode, 'focus')
  assert.equal(config.desktopApiBaseUrl, 'http://127.0.0.1:4825')
  assert.equal(config.desktopApiBearerToken, null)
  assert.equal(config.desktopApiTimeoutMs, 60000)
  assert.equal(config.pollIntervalMs, 2500)
  assert.equal(config.operatorEnabled, false)
  assert.equal(config.operatorBearerToken, null)
  assert.equal(config.orchestration.enabled, false)
  assert.equal(config.orchestration.pythonPath, 'python')
  assert.equal(config.orchestration.cliPath, '')
  assert.equal(config.orchestration.dbPath, null)
  assert.equal(config.orchestration.exportRoot, null)
  assert.equal(config.orchestration.timeoutMs, 30000)
  assert.equal(config.discord.apiBaseUrl, 'https://discord.com/api/v10')
  assert.equal(config.discord.guildId, 'guild-1')
  assert.equal(config.discord.commandChannelId, 'command-1')
  assert.equal(config.discord.channelNamePrefix, 'codex')
  assert.equal(config.discord.textChannelParentId, null)
  assert.match(config.stateDir, /codex-discord-desktop-relay$/)
})

test('readCodexDiscordDesktopRelayConfig rejects non-loopback hosts', () => {
  assert.throws(
    () =>
      readCodexDiscordDesktopRelayConfig({
        ...baseEnv(),
        WORKSTATION_CONTROL_DISCORD_DESKTOP_RELAY_HOST: '0.0.0.0',
      }),
    /loopback host/,
  )
})

test('readCodexDiscordDesktopRelayConfig rejects unknown or retired desktop adapter modes', () => {
  assert.throws(
    () =>
      readCodexDiscordDesktopRelayConfig({
        ...baseEnv(),
        WORKSTATION_CONTROL_DISCORD_DESKTOP_RELAY_DESKTOP_ADAPTER_MODE: 'uia',
      }),
    /DESKTOP_ADAPTER_MODE/,
  )
})

test('readCodexDiscordDesktopRelayConfig requires desktop API token in api mode', () => {
  assert.throws(
    () =>
      readCodexDiscordDesktopRelayConfig({
        ...baseEnv(),
        WORKSTATION_CONTROL_DISCORD_DESKTOP_RELAY_DESKTOP_ADAPTER_MODE: 'api',
      }),
    /CODEX_DESKTOP_BEARER_TOKEN/,
  )
})

test('readCodexDiscordDesktopRelayConfig reads desktop API settings', () => {
  const config = readCodexDiscordDesktopRelayConfig({
    ...baseEnv(),
    WORKSTATION_CONTROL_DISCORD_DESKTOP_RELAY_DESKTOP_ADAPTER_MODE: 'api',
    WORKSTATION_CONTROL_RELAY_CODEX_DESKTOP_BASE_URL: 'http://localhost:4825/',
    WORKSTATION_CONTROL_RELAY_CODEX_DESKTOP_BEARER_TOKEN: 'desktop-secret',
    WORKSTATION_CONTROL_RELAY_CODEX_DESKTOP_TIMEOUT_MS: '12000',
  })

  assert.equal(config.desktopAdapterMode, 'api')
  assert.equal(config.desktopApiBaseUrl, 'http://localhost:4825')
  assert.equal(config.desktopApiBearerToken, 'desktop-secret')
  assert.equal(config.desktopApiTimeoutMs, 12000)
})

test('readCodexDiscordDesktopRelayConfig expands Windows env tokens in state dir', () => {
  const config = readCodexDiscordDesktopRelayConfig({
    ...baseEnv(),
    LOCALAPPDATA: 'C:\\Users\\Example\\AppData\\Local',
    WORKSTATION_CONTROL_DISCORD_DESKTOP_RELAY_STATE_DIR:
      '%LOCALAPPDATA%\\ProtocolRunner\\relay',
  })

  assert.equal(config.stateDir, 'C:\\Users\\Example\\AppData\\Local\\ProtocolRunner\\relay')
})

test('readCodexDiscordDesktopRelayConfig preserves native and Windows absolute paths', () => {
  const posixStateDir = '/var/tmp/codex-discord-desktop-relay'
  const windowsAllowedCwd = 'C:\\dev\\protocol-runner'
  const config = readCodexDiscordDesktopRelayConfig({
    ...baseEnv(),
    WORKSTATION_CONTROL_DISCORD_DESKTOP_RELAY_STATE_DIR: posixStateDir,
    WORKSTATION_CONTROL_DISCORD_DESKTOP_RELAY_ALLOWED_CWD: windowsAllowedCwd,
  })

  assert.equal(config.stateDir, path.normalize(posixStateDir))
  assert.equal(config.allowedCwd, path.win32.normalize(windowsAllowedCwd))
  assert.equal(path.isAbsolute(config.stateDir), true)
  assert.equal(path.win32.isAbsolute(config.allowedCwd), true)
})

test('readCodexDiscordDesktopRelayConfig requires publish and Discord secrets', () => {
  assert.throws(() => readCodexDiscordDesktopRelayConfig({}), /PUBLISH_BEARER_TOKEN/)
})

test('readCodexDiscordDesktopRelayConfig reads explicit operator mode', () => {
  const config = readCodexDiscordDesktopRelayConfig({
    ...baseEnv(),
    WORKSTATION_CONTROL_DISCORD_DESKTOP_RELAY_OPERATOR_ENABLED: 'true',
    WORKSTATION_CONTROL_DISCORD_DESKTOP_RELAY_OPERATOR_BEARER_TOKEN: 'operator-secret',
  })

  assert.equal(config.operatorEnabled, true)
  assert.equal(config.operatorBearerToken, 'operator-secret')
})

test('readCodexDiscordDesktopRelayConfig reads orchestration overrides', () => {
  const config = readCodexDiscordDesktopRelayConfig({
    ...baseEnv(),
    WORKSTATION_CONTROL_DISCORD_DESKTOP_RELAY_ORCHESTRATION_ENABLED: 'false',
    WORKSTATION_CONTROL_CODEX_ORCHESTRATION_PYTHON: 'py',
    WORKSTATION_CONTROL_CODEX_ORCHESTRATION_CLI_PATH: 'C:\\tools\\codex_orchestrate.py',
    WORKSTATION_CONTROL_CODEX_ORCHESTRATION_DB_PATH: 'C:\\state\\orchestration.sqlite',
    WORKSTATION_CONTROL_CODEX_ORCHESTRATION_EXPORT_ROOT: 'C:\\state\\exports',
    WORKSTATION_CONTROL_CODEX_ORCHESTRATION_TIMEOUT_MS: '12000',
  })

  assert.equal(config.orchestration.enabled, false)
  assert.equal(config.orchestration.pythonPath, 'py')
  assert.equal(config.orchestration.cliPath, 'C:\\tools\\codex_orchestrate.py')
  assert.equal(config.orchestration.dbPath, 'C:\\state\\orchestration.sqlite')
  assert.equal(config.orchestration.exportRoot, 'C:\\state\\exports')
  assert.equal(config.orchestration.timeoutMs, 12000)
})

test('readCodexDiscordDesktopRelayConfig requires operator token when enabled', () => {
  assert.throws(
    () =>
      readCodexDiscordDesktopRelayConfig({
        ...baseEnv(),
        WORKSTATION_CONTROL_DISCORD_DESKTOP_RELAY_OPERATOR_ENABLED: 'true',
      }),
    /OPERATOR_BEARER_TOKEN/,
  )
})
