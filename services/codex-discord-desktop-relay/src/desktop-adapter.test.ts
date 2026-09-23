import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

import { CodexDesktopApiAdapter } from './desktop-adapter.js'

interface CapturedRequest {
  method: string
  url: string
  body: Record<string, unknown> | null
}

async function withDesktopApiServer(
  handler: (request: CapturedRequest) => { status?: number; body: Record<string, unknown> },
  run: (baseUrl: string, requests: CapturedRequest[]) => Promise<void>,
) {
  const requests: CapturedRequest[] = []
  const server = http.createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => {
      raw += chunk.toString()
    })
    request.on('end', () => {
      const captured: CapturedRequest = {
        method: request.method ?? 'GET',
        url: request.url ?? '/',
        body: raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : null,
      }
      requests.push(captured)
      const result = handler(captured)
      response.statusCode = result.status ?? 200
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(result.body))
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  assert(address && typeof address === 'object')
  try {
    await run(`http://127.0.0.1:${address.port}`, requests)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })
  }
}

function createAdapter(baseUrl: string): CodexDesktopApiAdapter {
  return new CodexDesktopApiAdapter({
    baseUrl,
    bearerToken: 'desktop-secret',
    requestTimeoutMs: 5000,
    actionMode: 'focus',
    windowTitle: 'Codex',
  })
}

test('CodexDesktopApiAdapter reports state and visible thread labels through codex-desktop-api', async () => {
  await withDesktopApiServer(
    () => ({
      body: {
        result: 'applied',
        windowFound: true,
        visibleThreadRows: [
          {
            label: 'Alpha',
            turnState: 'idle',
            indicatorText: '1d',
            indicatorReason: 'relative_age_indicator',
            isThreadRow: true,
          },
          {
            label: 'Busy thread',
            turnState: 'working',
            indicatorText: null,
            indicatorReason: 'sidebar_context_progress_indicator_likely',
            isThreadRow: true,
          },
          {
            label: 'Project header',
            turnState: 'unknown',
            indicatorText: null,
            indicatorReason: 'not_a_thread_row',
            isThreadRow: false,
          },
        ],
      },
    }),
    async (baseUrl) => {
      const adapter = createAdapter(baseUrl)
      const state = await adapter.getState()
      const threads = await adapter.listThreads()

      assert.equal(state.available, true)
      assert.equal(state.mode, 'api')
      assert.deepEqual(
        threads.map((thread) => thread.label),
        ['Alpha', 'Busy thread'],
      )
      assert.equal(threads[1]?.turnState, 'working')
    },
  )
})

test('CodexDesktopApiAdapter submits prompts through the visible desktop API path', async () => {
  await withDesktopApiServer(
    (request) => {
      assert.equal(request.url, '/api/codex-desktop/prompt')
      assert.equal('deliveryMode' in (request.body ?? {}), false)
      assert.equal(request.body?.threadTitle, 'Existing thread')
      assert.equal(request.body?.text, 'hello from discord')
      return {
        body: {
          result: 'applied',
          selectedSidebarThreadTitle: 'Existing thread',
          selectionConfirmed: true,
        },
      }
    },
    async (baseUrl) => {
      const result = await createAdapter(baseUrl).submitPrompt({
        desktopThreadLabel: 'Existing thread',
        text: 'hello from discord',
      })

      assert.equal(result.result, 'submitted')
      assert.equal(result.desktopThreadLabel, 'Existing thread')
      assert.equal(result.message, null)
    },
  )
})

test('CodexDesktopApiAdapter refuses prompt delivery without exact sidebar selection', async () => {
  await withDesktopApiServer(
    () => ({
      body: {
        result: 'applied',
        message: 'Prompt action lacked exact sidebar selection.',
        selectedSidebarThreadTitle: 'Existing thread',
        selectionConfirmed: false,
      },
    }),
    async (baseUrl) => {
      const result = await createAdapter(baseUrl).submitPrompt({
        desktopThreadLabel: 'Existing thread',
        text: 'hello from discord',
      })

      assert.equal(result.result, 'refused')
      assert.match(result.message ?? '', /sidebar selection/)
    },
  )
})

test('CodexDesktopApiAdapter creates threads through the visible desktop API path', async () => {
  await withDesktopApiServer(
    (request) => {
      assert.equal(request.url, '/api/codex-desktop/create-thread')
      assert.equal('deliveryMode' in (request.body ?? {}), false)
      assert.equal(request.body?.text, 'hello from orchestration')
      return {
        body: {
          result: 'applied',
          selectedSidebarThreadTitle: 'Fresh worker title',
        },
      }
    },
    async (baseUrl) => {
      const result = await createAdapter(baseUrl).createThread({ text: 'hello from orchestration' })

      assert.equal(result.result, 'submitted')
      assert.equal(result.desktopThreadLabel, 'Fresh worker title')
    },
  )
})

test('CodexDesktopApiAdapter binds the current visible thread through desktop API readback', async () => {
  await withDesktopApiServer(
    (request) => {
      assert.equal(request.url, '/api/codex-desktop/readback')
      return {
        body: {
          result: 'applied',
          selectedSidebarThreadTitle: 'Current worker title',
        },
      }
    },
    async (baseUrl) => {
      const result = await createAdapter(baseUrl).bindCurrent()

      assert.equal(result.result, 'submitted')
      assert.equal(result.desktopThreadLabel, 'Current worker title')
    },
  )
})
