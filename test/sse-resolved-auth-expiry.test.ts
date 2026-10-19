import { test, describe } from 'node:test'
import type { TestContext } from 'node:test'
import { once } from 'node:events'
import Fastify from 'fastify'
import mcpPlugin from '../src/index.ts'
import { MemorySessionStore } from '../src/stores/memory-session-store.ts'

// The stream's close timer is unref'd, so a ref'd timer has to keep the event
// loop alive while the test waits for it to fire
async function waitForEnd (stream: NodeJS.ReadableStream, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      once(stream, 'end').then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function buildApp (t: TestContext, expiresInMs: number) {
  const app = Fastify({ logger: false })
  t.after(() => app.close())
  await app.register(mcpPlugin, {
    enableSSE: true,
    resolveAuthorizationContext: async () => ({
      userId: 'alice',
      authorizationServer: 'https://app.example.com',
      expiresAt: new Date(Date.now() + expiresInMs)
    })
  })
  await app.ready()
  return app
}

describe('legacy SSE GET honours the resolved authorization context expiresAt', () => {
  test('the stream closes when the resolved expiresAt passes', async (t: TestContext) => {
    const app = await buildApp(t, 300)

    const response = await app.inject({
      method: 'GET',
      url: '/mcp',
      payloadAsStream: true,
      headers: { accept: 'text/event-stream' }
    })
    t.assert.strictEqual(response.statusCode, 200)

    const stream = response.stream()
    stream.resume()
    const ended = await waitForEnd(stream, 1500)
    if (!ended) stream.destroy()
    t.assert.ok(ended, 'the stream outlived the resolved expiresAt')
  })

  test('an already expired context is answered with 401 and no session', async (t: TestContext) => {
    const app = await buildApp(t, -1000)
    const create = t.mock.method(MemorySessionStore.prototype, 'create')

    const response = await app.inject({
      method: 'GET',
      url: '/mcp',
      payloadAsStream: true,
      headers: { accept: 'text/event-stream' }
    })
    response.stream().destroy()

    t.assert.strictEqual(response.statusCode, 401)
    t.assert.strictEqual(response.headers['content-type'], 'application/json; charset=utf-8')
    t.assert.strictEqual(response.headers['mcp-session-id'], undefined)
    t.assert.strictEqual(create.mock.callCount(), 0)
  })
})
