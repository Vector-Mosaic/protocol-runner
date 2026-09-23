import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { startProtocolRunnerListener } from './startup.js'

describe('Protocol Runner startup readiness boundary', () => {
  it('finishes store initialization and reconciliation before listening', async () => {
    const events: string[] = []

    await startProtocolRunnerListener({
      store: {
        async getDiagnostics() {
          events.push('store-ready')
          return { mode: 'json' }
        },
      },
      server: {
        listen(_port, _host, onListening) {
          events.push('listen')
          onListening()
        },
      },
      port: 4831,
      host: '127.0.0.1',
      onListening() {
        events.push('listening')
      },
    })

    assert.deepEqual(events, ['store-ready', 'listen', 'listening'])
  })

  it('does not open the listener when store readiness fails', async () => {
    let listened = false

    await assert.rejects(
      startProtocolRunnerListener({
        store: {
          async getDiagnostics() {
            throw new Error('store unavailable')
          },
        },
        server: {
          listen() {
            listened = true
          },
        },
        port: 4831,
        host: '127.0.0.1',
        onListening() {},
      }),
      /store unavailable/,
    )

    assert.equal(listened, false)
  })
})
