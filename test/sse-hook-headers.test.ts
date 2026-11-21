import { test, describe } from 'node:test'
import type { TestContext } from 'node:test'
import Fastify from 'fastify'
import { request } from 'undici'
import mcpPlugin from '../src/index.ts'
import { MemorySessionStore } from '../src/stores/memory-session-store.ts'

async function buildApp (t: TestContext) {
  const app = Fastify({ logger: false })
  t.after(() => app.close())
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('access-control-allow-origin', 'https://client.example.com')
    reply.header('access-control-expose-headers', 'Mcp-Session-Id')
  })
  await app.register(mcpPlugin, { enableSSE: true })
  return app
}

describe('legacy SSE GET keeps headers set by hooks', () => {
  test('the stream response carries hook headers next to the SSE ones', async (t: TestContext) => {
    const app = await buildApp(t)
    await app.ready()

    const response = await app.inject({
      method: 'GET',
      url: '/mcp',
      payloadAsStream: true,
      headers: { accept: 'text/event-stream' }
    })
    response.stream().destroy()

    t.assert.strictEqual(response.statusCode, 200)
    t.assert.strictEqual(response.headers['content-type'], 'text/event-stream')
    t.assert.strictEqual(response.headers['access-control-allow-origin'], 'https://client.example.com')
    t.assert.strictEqual(response.headers['access-control-expose-headers'], 'Mcp-Session-Id')
    t.assert.ok(response.headers['mcp-session-id'])
  })

  // After hijack Fastify no longer sends replies, so this needs a real
  // connection: the old error path never answered at all
  test('a failure while opening the stream answers 500 with hook headers', async (t: TestContext) => {
    const app = await buildApp(t)
    await app.listen({ port: 0, host: '127.0.0.1' })
    const address = app.server.address() as { port: number }

    t.mock.method(MemorySessionStore.prototype, 'create', async () => {
      throw new Error('store down')
    })

    const response = await request(`http://127.0.0.1:${address.port}/mcp`, {
      method: 'GET',
      headers: { accept: 'text/event-stream' },
      headersTimeout: 2000,
      bodyTimeout: 2000
    })
    const body = await response.body.json()

    t.assert.strictEqual(response.statusCode, 500)
    t.assert.strictEqual(response.headers['content-type'], 'application/json')
    t.assert.strictEqual(response.headers['access-control-allow-origin'], 'https://client.example.com')
    t.assert.deepStrictEqual(body, { error: 'Internal server error' })
  })
})
