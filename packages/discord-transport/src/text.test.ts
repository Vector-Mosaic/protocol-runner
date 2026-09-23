import assert from 'node:assert/strict'
import test from 'node:test'

import { createStableDiscordThreadName, splitDiscordMessageText, truncateDiscordThreadName } from './text.js'

test('truncateDiscordThreadName compacts whitespace and preserves short names', () => {
  assert.equal(truncateDiscordThreadName('  Relay   Thread  '), 'Relay Thread')
})

test('truncateDiscordThreadName truncates long names with ellipsis', () => {
  const value = truncateDiscordThreadName('x'.repeat(120), 20)
  assert.equal(value.length, 20)
  assert.match(value, /\.\.\.$/)
})

test('createStableDiscordThreadName preserves a stable suffix when truncating', () => {
  const value = createStableDiscordThreadName('Relay thread '.repeat(20), 'abc123', 30)
  assert.equal(value.length, 30)
  assert.match(value, /\[abc123\]$/)
})

test('splitDiscordMessageText preserves small messages', () => {
  assert.deepEqual(splitDiscordMessageText('hello world', 10), ['hello', 'world'])
})

test('splitDiscordMessageText returns placeholder for empty text', () => {
  assert.deepEqual(splitDiscordMessageText('   '), ['(empty)'])
})
