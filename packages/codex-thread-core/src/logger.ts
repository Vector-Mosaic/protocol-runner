import fs from 'node:fs'
import path from 'node:path'
import type { Writable } from 'node:stream'

import { redactForLog } from '@workstation-control/remote-core'

type LogLevel = 'info' | 'warn' | 'error'

type SinkName = 'stdout' | 'stderr' | 'file'
type SinkFailure = 'synchronous_write' | 'asynchronous_write' | 'closed_stream' | 'file_initialization'
type Sink = {
  name: SinkName
  stream: Writable
  disabled: boolean
  blocked: boolean
  skippedRecords: number
  skippedBytes: number
}

// No logger replay queue. This cap includes bytes already queued by the stream;
// it bounds what this logger admits, not other writers or OS-level stdio stalls.
const MAX_SINK_BUFFER_BYTES = 256 * 1024
const outputSinks = new Map<SinkName, Sink>()
let fileSink: Sink | null = null
let fileStreamState: 'uninitialized' | 'ready' | 'disabled' = 'uninitialized'

function record(level: LogLevel, component: string, event: string, fields: Record<string, unknown>): string {
  return `${JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    system: 'workstation_control',
    component,
    event,
    ...fields,
  })}\n`
}

function skip(sink: Sink, bytes: number): void {
  // Saturation keeps lifetime counters finite even in a permanently failed sink.
  sink.skippedRecords = Math.min(Number.MAX_SAFE_INTEGER, sink.skippedRecords + 1)
  sink.skippedBytes = Math.min(Number.MAX_SAFE_INTEGER, sink.skippedBytes + bytes)
}

function reportFailure(name: SinkName, reason: SinkFailure): void {
  const line = record('warn', 'logger', 'logger.sink_failed', {
    sink: name,
    failure: reason,
    accepted_delivery: 'uncertain',
  })
  // Direct attempts cannot recursively report failure. At most the two process
  // sinks receive a receipt; raw exception messages/paths never enter it.
  for (const destination of ['stderr', 'stdout'] as const) {
    if (destination === name) continue
    const sink = getOutputSink(destination)
    if (sink && admit(sink, line, false)) break
  }
}

function disable(sink: Sink, reason: SinkFailure, report: boolean): void {
  if (sink.disabled) return
  sink.disabled = true
  sink.blocked = false
  if (sink.name === 'file') {
    fileStreamState = 'disabled'
    try { sink.stream.destroy() } catch { /* the optional failed sink has no control authority */ }
  }
  if (report) reportFailure(sink.name, reason)
}

function makeSink(name: SinkName, stream: Writable): Sink {
  const sink: Sink = { name, stream, disabled: false, blocked: false, skippedRecords: 0, skippedBytes: 0 }
  // Install before the first write: fs open failures and Writable callback
  // errors normally arrive asynchronously after createWriteStream/write return.
  stream.on('error', () => disable(sink, 'asynchronous_write', true))
  stream.on('drain', () => { if (!sink.disabled) sink.blocked = false })
  stream.on('close', () => {
    if (!sink.disabled) disable(sink, 'closed_stream', !stream.writableFinished)
  })
  return sink
}

function getOutputSink(name: 'stdout' | 'stderr'): Sink | null {
  const existing = outputSinks.get(name)
  if (existing) return existing
  try {
    const sink = makeSink(name, process[name])
    outputSinks.set(name, sink)
    return sink
  } catch {
    // Do not make reporting an unavailable process output recursively depend
    // on constructing that same output.
    return null
  }
}

function admit(sink: Sink, line: string, report = true): boolean {
  const bytes = Buffer.byteLength(line, 'utf8')
  if (sink.disabled || sink.blocked) {
    skip(sink, bytes)
    return false
  }
  try {
    if (sink.stream.destroyed || sink.stream.writableEnded) {
      skip(sink, bytes)
      disable(sink, 'closed_stream', report)
      return false
    }
    let recovered = sink.skippedRecords > 0
      ? record('warn', 'logger', 'logger.sink_records_skipped', {
        sink: sink.name,
        skipped_records: sink.skippedRecords,
        skipped_bytes: sink.skippedBytes,
      })
      : ''
    let payload = recovered + line
    if (recovered && sink.stream.writableLength + Buffer.byteLength(payload, 'utf8') > MAX_SINK_BUFFER_BYTES
      && sink.stream.writableLength + bytes <= MAX_SINK_BUFFER_BYTES) {
      // A pending receipt must not permanently exclude otherwise admissible
      // near-cap records. Keep its bounded counters until a later record has
      // room; this record still reaches the sink without replay or truncation.
      recovered = ''
      payload = line
    }
    if (sink.stream.writableLength + Buffer.byteLength(payload, 'utf8') > MAX_SINK_BUFFER_BYTES) {
      skip(sink, bytes)
      return false
    }
    // false means this payload was accepted. It must not be retried or counted
    // as skipped; later records are skipped until drain, across all components.
    const ready = sink.stream.write(payload)
    if (recovered) {
      sink.skippedRecords = 0
      sink.skippedBytes = 0
    }
    if (!sink.disabled) sink.blocked = !ready
    return true
  } catch {
    // A throwing write may have submitted bytes before failing: delivery is
    // uncertain, so do not count this attempt as a proven skipped record.
    disable(sink, 'synchronous_write', report)
    return false
  }
}

function resolveLogPath(): string | null {
  const configured =
    process.env.WORKSTATION_CONTROL_RELAY_LOG_FILE?.trim() || process.env.WORKSTATION_CONTROL_LOG_FILE?.trim() || null
  return configured ? path.resolve(configured) : null
}

function getFileSink(): Sink | null {
  if (fileStreamState === 'disabled') {
    return null
  }

  if (fileStreamState === 'ready') {
    return fileSink
  }

  try {
    const resolvedPath = resolveLogPath()
    if (!resolvedPath) {
      fileStreamState = 'disabled'
      return null
    }
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true })
    fileSink = makeSink('file', fs.createWriteStream(resolvedPath, { flags: 'a' }))
    fileStreamState = 'ready'
    return fileSink
  } catch {
    fileStreamState = 'disabled'
    reportFailure('file', 'file_initialization')
    return null
  }
}

function write(level: LogLevel, component: string, event: string, fields: Record<string, unknown> = {}): void {
  let line: string
  try {
    line = record(level, component, event, redactForLog(fields) as Record<string, unknown>)
  } catch {
    // Logging must not replace a operation error with a BigInt,
    // circular-object, accessor, or redaction failure. No raw payload fallback.
    line = record('warn', 'logger', 'logger.record_serialization_failed', { original_level: level })
  }
  const output = getOutputSink(level === 'error' ? 'stderr' : 'stdout')
  if (output) admit(output, line)
  const file = getFileSink()
  if (file) admit(file, line)
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
