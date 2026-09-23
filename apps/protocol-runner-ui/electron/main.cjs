const path = require('node:path')

const { app, BrowserWindow, shell } = require('electron')

const DEFAULT_DEV_SERVER_URL = 'http://127.0.0.1:15174/'
const DASHBOARD_TITLE = 'Protocol Runner'
const GATE_TITLE = 'Protocol Runner Gate'
const NOTIFY_TITLE = 'Protocol Runner Notification'
const APP_USER_MODEL_ID = 'com.vectormosaic.protocolrunner'

let mainWindow = null

function hasGateFlag(argv = process.argv) {
  return argv.includes('--gate') || process.env.PROTOCOL_RUNNER_UI_GATE === '1'
}

function hasNotifyFlag(argv = process.argv) {
  return argv.includes('--notify') || process.env.PROTOCOL_RUNNER_UI_NOTIFY === '1'
}

function modeFromFlags(argv = process.argv, additionalData = {}) {
  if (additionalData?.gate === true || hasGateFlag(argv)) {
    return 'gate'
  }
  if (additionalData?.notify === true || hasNotifyFlag(argv)) {
    return 'notify'
  }
  return 'dashboard'
}

function titleForMode(mode) {
  if (mode === 'gate') {
    return GATE_TITLE
  }
  if (mode === 'notify') {
    return NOTIFY_TITLE
  }
  return DASHBOARD_TITLE
}

function logEvent(event, fields = {}) {
  process.stdout.write(`[protocol-runner-ui] ${JSON.stringify({ event, ...fields })}\n`)
}

function normalizeConsoleMessage(details, message, lineNumber, sourceId) {
  if (typeof details !== 'object' || details === null) {
    return {
      level: details,
      message,
      line: lineNumber,
      source_id: sourceId,
    }
  }

  return {
    level: details.level,
    message: details.message,
    line: details.lineNumber,
    source_id: details.sourceId,
  }
}

function shouldLogConsoleMessage(details) {
  return details.level === 'error' || details.level >= 3
}

function buildRendererUrl(mode) {
  const baseUrl =
    process.env.PROTOCOL_RUNNER_UI_DEV_URL || process.env.VITE_DEV_SERVER_URL || DEFAULT_DEV_SERVER_URL
  const url = new URL(baseUrl)
  url.searchParams.delete('gate')
  url.searchParams.delete('notify')
  if (mode === 'gate') {
    url.searchParams.set('gate', '1')
  } else if (mode === 'notify') {
    url.searchParams.set('notify', '1')
  }
  return url.toString()
}

function loadRenderer(window, mode) {
  window.setTitle(titleForMode(mode))
  window.webContents.once('did-finish-load', () => {
    logEvent('renderer_loaded', {
      mode,
      url: window.webContents.getURL(),
    })
    window.setTitle(titleForMode(mode))
  })

  if (!app.isPackaged) {
    const url = buildRendererUrl(mode)
    logEvent('renderer_load_requested', { mode, url })
    return window.loadURL(url)
  }

  return window.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), {
    query: mode === 'gate' ? { gate: '1' } : mode === 'notify' ? { notify: '1' } : {},
  })
}

function bringForward(window) {
  if (window.isMinimized()) {
    window.restore()
  }

  window.show()
  window.focus()

  try {
    window.setAlwaysOnTop(true)
    setTimeout(() => {
      if (!window.isDestroyed()) {
        window.setAlwaysOnTop(false)
      }
    }, 900)
  } catch {
    // Foreground attention is best-effort; the Windows helper also tries.
  }
}

function createWindow(mode) {
  const window = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 940,
    minHeight: 640,
    title: titleForMode(mode),
    backgroundColor: '#101417',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('console-message', (_event, details, message, lineNumber, sourceId) => {
    const normalized = normalizeConsoleMessage(details, message, lineNumber, sourceId)
    if (shouldLogConsoleMessage(normalized)) {
      logEvent('renderer_console', normalized)
    }
  })
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    logEvent('renderer_load_failed', {
      error_code: errorCode,
      error_description: errorDescription,
      url: validatedURL,
    })
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    logEvent('renderer_process_gone', details)
  })

  window.once('ready-to-show', () => bringForward(window))
  void loadRenderer(window, mode).catch(() => bringForward(window))

  return window
}

function openOrFocus(mode) {
  if (mainWindow === null || mainWindow.isDestroyed()) {
    mainWindow = createWindow(mode)
    return
  }

  void loadRenderer(mainWindow, mode).finally(() => bringForward(mainWindow))
}

app.setName(DASHBOARD_TITLE)
app.setPath('userData', path.join(app.getPath('appData'), 'VectorMosaic', 'ProtocolRunner'))
if (process.platform === 'win32') {
  app.setAppUserModelId(APP_USER_MODEL_ID)
}

const gotSingleInstanceLock = app.requestSingleInstanceLock({ gate: hasGateFlag(), notify: hasNotifyFlag() })

if (!gotSingleInstanceLock) {
  logEvent('second_instance_exit', { mode: modeFromFlags() })
  app.quit()
} else {
  app.on('second-instance', (_event, argv, _workingDirectory, additionalData) => {
    const mode = modeFromFlags(argv, additionalData)
    logEvent('second_instance_received', { mode })
    openOrFocus(mode)
  })

  app.whenReady().then(() => {
    const mode = modeFromFlags()
    logEvent('app_ready', { mode })
    openOrFocus(mode)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        openOrFocus('dashboard')
      } else if (mainWindow !== null && !mainWindow.isDestroyed()) {
        bringForward(mainWindow)
      }
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
