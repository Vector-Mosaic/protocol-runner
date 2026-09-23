import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const loggerUrl = new URL('./logger.js', import.meta.url).href

/** An isolated child exercises the real logger and Node streams without
 * replacing the test runner's stdout or retaining module-global sink state. */
function runFixture(body: string, env: Record<string, string> = {}): void {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict'
    import fs from 'node:fs'
    import { Writable } from 'node:stream'
    import { once } from 'node:events'
    const stdoutLines = [], stderrLines = []
    const capture = (lines) => new Writable({ write(chunk, encoding, callback) { lines.push(String(chunk)); callback() } })
    Object.defineProperty(process, 'stdout', { value: capture(stdoutLines), configurable: true })
    Object.defineProperty(process, 'stderr', { value: capture(stderrLines), configurable: true })
    const rows = (lines) => lines.join('').trim().split('\\n').filter(Boolean).map((line) => JSON.parse(line))
    const { createLogger } = await import(${JSON.stringify(loggerUrl)})
    ${body}
    fs.writeSync(1, 'fixture_complete')
  `], {
    encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, WORKSTATION_CONTROL_LOG_FILE: '', WORKSTATION_CONTROL_RELAY_LOG_FILE: '', ...env },
  })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, 'fixture_complete')
}

test('healthy logger preserves JSON schema, redaction, routing and optional file precedence', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-logger-success-'))
  const logPath = path.join(directory, 'relay.jsonl')
  const fallbackPath = path.join(directory, 'fallback.jsonl')
  try {
    runFixture(`
      let file
      const original = fs.createWriteStream
      fs.createWriteStream = (...args) => (file = original(...args))
      const logger = createLogger('fixture')
      logger.info('started', { request_id: 'request-1', prompt: 'project prompt' })
      logger.warn('waiting', { queue: 2 })
      logger.error('contained', { code: 'fixture_failure' })
      await new Promise((resolve, reject) => { file.once('error', reject); file.end(resolve) })
      const output = rows(stdoutLines), errors = rows(stderrLines)
      assert.deepEqual(output.map((row) => row.event), ['started', 'waiting'])
      assert.equal(errors[0].event, 'contained')
      assert.equal(output[0].level, 'info')
      assert.equal(output[1].level, 'warn')
      assert.equal(errors[0].level, 'error')
      assert.equal(output[0].prompt, '[REDACTED:14]')
      assert.equal(output[0].system, 'workstation_control')
      assert.equal(output[0].component, 'fixture')
      assert.equal(output[0].request_id, 'request-1')
      assert.ok(Number.isFinite(Date.parse(output[0].timestamp)))
      assert.deepEqual(Object.keys(output[0]), ['timestamp', 'level', 'system', 'component', 'event', 'request_id', 'prompt'])
      assert.deepEqual(rows([fs.readFileSync(process.env.WORKSTATION_CONTROL_RELAY_LOG_FILE, 'utf8')]), [...output, ...errors])
      assert.equal(fs.existsSync(process.env.WORKSTATION_CONTROL_LOG_FILE), false)
    `, { WORKSTATION_CONTROL_RELAY_LOG_FILE: logPath, WORKSTATION_CONTROL_LOG_FILE: fallbackPath })
  } finally {
    if (fs.existsSync(logPath)) fs.unlinkSync(logPath)
    if (fs.existsSync(fallbackPath)) fs.unlinkSync(fallbackPath)
    fs.rmdirSync(directory)
  }
})

test('synchronous process sink exceptions are isolated and not copied into diagnostics', () => {
  runFixture(`
    let attempts = 0
    const bad = new Writable({ write(chunk, encoding, callback) { callback() } })
    bad.write = () => { attempts += 1; throw new Error('fixture-private-error-text') }
    Object.defineProperty(process, 'stdout', { value: bad })
    const logger = createLogger('fixture')
    assert.doesNotThrow(() => logger.info('ordinary'))
    assert.doesNotThrow(() => logger.info('later'))
    assert.doesNotThrow(() => logger.error('containment_completed'))
    assert.equal(attempts, 1)
    assert.deepEqual(rows(stderrLines).map((row) => row.event), ['logger.sink_failed', 'containment_completed'])
    assert.equal(rows(stderrLines)[0].failure, 'synchronous_write')
    assert.equal(rows(stderrLines)[0].accepted_delivery, 'uncertain')
    assert.equal(stderrLines.join('').includes('fixture-private-error-text'), false)
  `)
})

test('actual Writable asynchronous errors cannot become uncaught operation failures', () => {
  runFixture(`
    const bad = new Writable({ write(chunk, encoding, callback) { callback(new Error('fixture-async-private-error')) } })
    Object.defineProperty(process, 'stdout', { value: bad })
    const failed = once(bad, 'error')
    const logger = createLogger('fixture')
    logger.info('before_error')
    await failed
    logger.info('after_error')
    logger.error('containment_completed')
    assert.deepEqual(rows(stderrLines).map((row) => row.event), ['logger.sink_failed', 'containment_completed'])
    assert.equal(rows(stderrLines)[0].failure, 'asynchronous_write')
    assert.equal(stderrLines.join('').includes('fixture-async-private-error'), false)
  `)
})

test('actual asynchronous file-open errors disable only the optional sink', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-logger-file-failure-'))
  try {
    runFixture(`
      let file, opens = 0
      const original = fs.createWriteStream
      fs.createWriteStream = (...args) => { opens += 1; return (file = original(...args)) }
      const logger = createLogger('fixture')
      logger.info('before_file_error')
      await once(file, 'error')
      logger.info('after_file_error')
      logger.error('containment_completed')
      assert.equal(opens, 1)
      assert.equal(file.destroyed, true)
      assert.deepEqual(rows(stdoutLines).map((row) => row.event), ['before_file_error', 'after_file_error'])
      assert.deepEqual(rows(stderrLines).map((row) => row.event), ['logger.sink_failed', 'containment_completed'])
      assert.equal(rows(stderrLines)[0].sink, 'file')
      assert.equal(rows(stderrLines)[0].failure, 'asynchronous_write')
      assert.equal(stderrLines.join('').includes(process.env.WORKSTATION_CONTROL_LOG_FILE), false)
    `, { WORKSTATION_CONTROL_LOG_FILE: directory })
  } finally {
    fs.rmdirSync(directory)
  }
})

test('simultaneous process failures and synchronous file initialization failure do not recurse', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-logger-all-failed-'))
  const blocker = path.join(directory, 'parent-is-file')
  fs.writeFileSync(blocker, 'fixture')
  try {
    runFixture(`
      let attempts = 0, opens = 0
      const bad = () => {
        const target = capture([])
        target.write = () => { attempts += 1; throw new Error('fixture-closed-pipe') }
        return target
      }
      Object.defineProperty(process, 'stdout', { value: bad() })
      Object.defineProperty(process, 'stderr', { value: bad() })
      fs.createWriteStream = () => { opens += 1; throw new Error('should-not-open') }
      const logger = createLogger('fixture')
      assert.doesNotThrow(() => logger.info('before_containment'))
      assert.doesNotThrow(() => logger.error('containment_completed'))
      assert.equal(attempts, 2)
      assert.equal(opens, 0)
    `, { WORKSTATION_CONTROL_LOG_FILE: path.join(blocker, 'log.jsonl') })
  } finally {
    fs.unlinkSync(blocker)
    fs.rmdirSync(directory)
  }
})

test('backpressure is shared across logger instances, bounded, and counted without replay', () => {
  runFixture(`
    const accepted = [], callbacks = []
    const slow = new Writable({ highWaterMark: 1, write(chunk, encoding, callback) { accepted.push(String(chunk)); callbacks.push(callback) } })
    Object.defineProperty(process, 'stdout', { value: slow })
    const first = createLogger('first'), second = createLogger('second')
    first.info('accepted_first')
    for (let index = 0; index < 1000; index += 1) second.info('skipped')
    first.error('stderr_is_independent')
    assert.equal(accepted.length, 1)
    assert.ok(slow.writableLength <= 256 * 1024)
    assert.equal(rows(stderrLines)[0].event, 'stderr_is_independent')
    const drained = once(slow, 'drain'); callbacks.shift()(); await drained
    second.info('accepted_second')
    assert.equal(accepted.length, 2)
    assert.deepEqual(rows([accepted[1]]).map((row) => row.event), ['logger.sink_records_skipped', 'accepted_second'])
    assert.equal(rows([accepted[1]])[0].skipped_records, 1000)
    first.info('one_more_skipped')
    const again = once(slow, 'drain'); callbacks.shift()(); await again
    first.info('accepted_third')
    assert.equal(rows([accepted[2]])[0].skipped_records, 1)
    assert.equal(rows(accepted).filter((row) => row.event === 'accepted_first').length, 1)
    callbacks.shift()()
  `)
})

test('UTF-8 cap refusal does not wait for a drain event from a write that never happened', () => {
  runFixture(`
    const logger = createLogger('fixture')
    logger.info('oversized', { payload: 'Ã©'.repeat(150_000) })
    assert.equal(stdoutLines.length, 0)
    logger.info('small_record_after_cap')
    const output = rows(stdoutLines)
    assert.deepEqual(output.map((row) => row.event), ['logger.sink_records_skipped', 'small_record_after_cap'])
    assert.equal(output[0].skipped_records, 1)
    assert.ok(output[0].skipped_bytes > 256 * 1024)
    assert.ok(Buffer.byteLength(stdoutLines.join('')) <= 256 * 1024)
  `)
})

test('pending skip receipts cannot starve subsequent records that fit the sink cap alone', () => {
  runFixture(`
    const logger = createLogger('fixture')
    logger.info('oversized', { payload: 'x'.repeat(300_000) })
    for (let index = 0; index < 3; index += 1) {
      logger.info('near_cap', { payload: 'x'.repeat(261_900) })
      await new Promise(setImmediate)
    }
    logger.info('room_for_receipt')
    const output = rows(stdoutLines)
    assert.deepEqual(output.map((row) => row.event), [
      'near_cap', 'near_cap', 'near_cap', 'logger.sink_records_skipped', 'room_for_receipt',
    ])
    assert.equal(output[3].skipped_records, 1)
    assert.ok(stdoutLines.every((line) => Buffer.byteLength(line) <= 256 * 1024))
  `)
})

test('serialization failures use closed metadata while normal records continue', () => {
  runFixture(`
    const logger = createLogger('fixture')
    const circular = {}; circular.self = circular
    logger.info('bad_bigint', { value: 1n })
    logger.warn('bad_cycle', circular)
    logger.info('bad_getter', { get value() { throw new Error('fixture-private-getter') } })
    logger.info('still_running', { phase: 'work' })
    assert.deepEqual(rows(stdoutLines).map((row) => row.event), [
      'logger.record_serialization_failed', 'logger.record_serialization_failed',
      'logger.record_serialization_failed', 'still_running',
    ])
    assert.equal(stdoutLines.join('').includes('fixture-private-getter'), false)
  `)
})
