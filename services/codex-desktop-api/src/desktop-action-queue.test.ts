import assert from 'node:assert/strict'
import test from 'node:test'

import { DesktopActionQueue } from './desktop-action-queue.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

test('operator gate wait holds the queue until allow-now releases the snapshot', async () => {
  const calls: string[] = []
  const queue = new DesktopActionQueue({
    auto_allow_ms: 50,
    now: () => new Date('2026-06-26T00:00:00.000Z'),
    id_factory: () => `action_${calls.length + 1}`,
  })

  const result = queue.enqueue(
    {
      kind: 'prompt',
      caller: 'test',
      summary: 'send prompt',
    },
    async () => {
      calls.push('executed')
      return 'done'
    },
  )
  queue.wait()

  assert.equal(queue.state().gate_status, 'held')
  assert.deepEqual(calls, [])

  queue.allowNow()
  assert.equal(await result, 'done')
  assert.deepEqual(calls, ['executed'])
  assert.equal(queue.state().gate_status, 'idle')
  assert.equal(queue.state().desktop_control_released_at, '2026-06-26T00:00:00.000Z')
})

test('operator gate notifies when countdown starts', async () => {
  const attentionStates: string[] = []
  const queue = new DesktopActionQueue({
    auto_allow_ms: 50,
    now: () => new Date('2026-06-26T00:00:00.000Z'),
    id_factory: () => 'action_attention',
    on_countdown_started: (state) => {
      attentionStates.push(`${state.gate_status}:${state.pending_count}:${state.pending_actions[0]?.action_id}`)
    },
  })

  const result = queue.enqueue(
    {
      kind: 'prompt',
      caller: 'test',
      summary: 'send prompt',
    },
    async () => 'done',
  )

  assert.deepEqual(attentionStates, ['countdown:1:action_attention'])
  queue.allowNow()
  assert.equal(await result, 'done')
})

test('snapshot execution defers actions that arrive after execution starts', async () => {
  const first = deferred<string>()
  const calls: string[] = []
  const queue = new DesktopActionQueue({
    auto_allow_ms: 0,
    now: () => new Date('2026-06-26T00:00:00.000Z'),
  })

  const firstResult = queue.enqueue(
    {
      kind: 'prompt',
      caller: 'test',
      summary: 'first',
    },
    async () => {
      calls.push('first-start')
      return first.promise
    },
  )

  await Promise.resolve()
  assert.equal(queue.state().gate_status, 'executing')
  const secondResult = queue.enqueue(
    {
      kind: 'prompt',
      caller: 'test',
      summary: 'second',
    },
    async () => {
      calls.push('second-start')
      return 'second-done'
    },
  )

  assert.equal(queue.state().pending_count, 1)
  assert.equal(queue.state().executing_count, 1)
  first.resolve('first-done')
  assert.equal(await firstResult, 'first-done')
  assert.equal(await secondResult, 'second-done')
  assert.deepEqual(calls, ['first-start', 'second-start'])
})
