import assert from 'node:assert/strict'
import { test } from 'node:test'

import { HttpProtocolRunnerParallelApiClient } from './client.js'

test('executor API client refuses destinations that could receive its control token', () => {
  for (const baseUrl of ['https://localhost:14831', 'http://example.com', 'http://user:pass@localhost',
    'http://localhost/path', 'http://localhost?redirect=other', 'http://localhost#fragment']) {
    assert.throws(() => new HttpProtocolRunnerParallelApiClient({ baseUrl }), /loopback origin/)
  }
})

test('executor API client authenticates reads and writes and refuses redirects', async (context) => {
  const requests: RequestInit[] = []
  context.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push(init ?? {})
    return new Response(JSON.stringify({ runs: [] }), { status: 200 })
  })
  const client = new HttpProtocolRunnerParallelApiClient({
    baseUrl: 'http://127.0.0.1:14831', controlToken: 'test-control-token-that-is-long-enough',
  })
  await client.listRuns()
  await client.grantLeases('run', 'group', { executor_id: 'executor', capacity: 1 })
  assert.equal(requests.length, 2)
  for (const request of requests) {
    assert.equal(new Headers(request.headers).get('authorization'), 'Bearer test-control-token-that-is-long-enough')
    assert.equal(request.redirect, 'error')
  }
  assert.equal(new Headers(requests[1]!.headers).get('content-type'), 'application/json')
})
