import fs from 'node:fs'
import path from 'node:path'

import { redactForLog } from '@workstation-control/remote-core'

type LogLevel = 'info' | 'warn' | 'error'

let fileStream: fs.WriteStream | null = null
let fileStreamState: 'uninitialized' | 'ready' | 'disabled' = 'uninitialized'

function getFileStream(): fs.WriteStream | null {
  if (fileStreamState === 'disabled') {
    return null
  }

  if (fileStreamState === 'ready') {
    return fileStream
  }

  const configuredPath = process.env.WORKSTATION_CONTROL_DISCORD_DESKTOP_RELAY_LOG_FILE?.trim()
  if (!configuredPath) {
    fileStreamState = 'disabled'
    return null
  }

  try {
    const resolvedPath = path.resolve(configuredPath)
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true })
    fileStream = fs.createWriteStream(resolvedPath, { flags: 'a' })
    fileStreamState = 'ready'
    return fileStream
  } catch {
    fileStreamState = 'disabled'
    return null
  }
}

function write(level: LogLevel, component: string, event: string, fields: Record<string, unknown> = {}): void {
  const safeFields = redactForLog(fields) as Record<string, unknown>
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    system: 'workstation_control',
    component,
    event,
    ...safeFields,
  })

  const target = level === 'error' ? process.stderr : process.stdout
  target.write(`${line}\n`)
  getFileStream()?.write(`${line}\n`)
}

export function createLogger(component: string) {
  return {
    info(event: string, fields?: Record<string, unknown>) {
      write('info', component, event, fields)
    },
    warn(event: string, fields?: Record<string, unknown>) {
      write('warn', component, event, fields)
    },
    error(event: string, fields?: Record<string, unknown>) {
      write('error', component, event, fields)
    },
  }
}
