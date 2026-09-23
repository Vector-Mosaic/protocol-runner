import assert from 'node:assert/strict'
import test from 'node:test'

import type { CodexRawThreadReadResult } from '@workstation-control/remote-core'

import { getLatestAssistantTurn, hashAssistantItem, latestAssistantMirrorKey } from './latest.js'

const thread: CodexRawThreadReadResult = {
  thread: {
    id: 'thread-1',
    preview: 'Second prompt',
    cwd: 'C:\\dev\\protocol-runner',
    updatedAt: 1773065984,
    turns: [
      {
        id: 'turn-1',
        status: 'completed',
        items: [
          {
            type: 'userMessage',
            id: 'item-1',
            content: [{ type: 'text', text: 'First prompt' }],
          },
          {
            type: 'agentMessage',
            id: 'item-2',
            text: 'First answer',
          },
        ],
      },
      {
        id: 'turn-2',
        status: 'completed',
        items: [
          {
            type: 'userMessage',
            id: 'item-3',
            content: [{ type: 'text', text: 'Second prompt' }],
          },
          {
            type: 'agentMessage',
            id: 'item-4',
            text: 'Second answer',
          },
        ],
      },
    ],
  },
}

test('getLatestAssistantTurn returns the latest persisted assistant turn with stable hash', () => {
  const latest = getLatestAssistantTurn(thread)
  assert.ok(latest)
  assert.equal(latest?.threadId, 'thread-1')
  assert.equal(latest?.itemId, 'item-4')
  assert.equal(latest?.turnId, 'turn-2')
  assert.equal(latest?.text, 'Second answer')
  assert.equal(latest?.stableHash, hashAssistantItem('thread-1', { id: 'item-4', turnId: 'turn-2', text: 'Second answer' }))
  assert.equal(latestAssistantMirrorKey(latest!), 'item-4')
})

test('getLatestAssistantTurn returns null when no assistant item exists', () => {
  const noAssistant: CodexRawThreadReadResult = {
    thread: {
      id: 'thread-empty',
      turns: [
        {
          id: 'turn-1',
          status: 'completed',
          items: [
            {
              type: 'userMessage',
              id: 'item-1',
              content: [{ type: 'text', text: 'Only prompt' }],
            },
          ],
        },
      ],
    },
  }

  assert.equal(getLatestAssistantTurn(noAssistant), null)
})
