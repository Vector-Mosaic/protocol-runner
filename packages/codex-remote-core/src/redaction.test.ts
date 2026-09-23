import test from 'node:test'
import assert from 'node:assert/strict'

import { redactForLog } from './index.js'

test('redacts prompt and transcript bodies from logs', () => {
  const redacted = redactForLog({
    prompt: 'top secret prompt',
    transcript: 'sensitive transcript',
    nested: {
      text: 'assistant output',
      cookie: 'abc123',
    },
  }) as Record<string, unknown>

  assert.equal(redacted.prompt, '[REDACTED:17]')
  assert.equal(redacted.transcript, '[REDACTED:20]')
  assert.deepEqual(redacted.nested, {
    text: '[REDACTED:16]',
    cookie: '[REDACTED:6]',
  })
})
