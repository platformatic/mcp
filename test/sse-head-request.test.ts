import { test, describe } from 'node:test'
import type { TestContext } from 'node:test'
import Fastify from 'fastify'
import { request } from 'undici'
import mcpPlugin from '../src/index.ts'
import { MemorySessionStore } from '../src/stores/memory-session-store.ts'

// HEAD hangs if it reaches the SSE handler, which only shows on a real
// connection: inject would just wait forever
describe('HEAD /mcp', () => {
  test('with SSE enabled, answers 405 with Allow instead of opening a stream', async (t: TestContext) => {
    const app = Fastify({ logger: false })
    t.after(() => app.close())
    await app.register(mcpPlugin, { enableSSE: true })
    await app.listen({ port: 0, host: '127.0.0.1' })
    const address = app.server.address() as { port: number }

    const response = await request(`http://127.0.0.1:${address.port}/mcp`, {
      method: 'HEAD',
      headers: { accept: 'text/event-stream' },
      headersTimeout: 2000
    })
    await response.body.dump()

    t.assert.strictEqual(response.statusCode, 405)
    t.assert.strictEqual(response.headers.allow, 'GET, POST, DELETE')
    t.assert.strictEqual(response.headers['mcp-session-id'], undefined)
  })

  test('with SSE enabled, does not create a session', async (t: TestContext) => {
    const app = Fastify({ logger: false })
    t.after(() => app.close())
    await app.register(mcpPlugin, { enableSSE: true })
    await app.listen({ port: 0, host: '127.0.0.1' })
    const address = app.server.address() as { port: number }

    const create = t.mock.method(MemorySessionStore.prototype, 'create')

    const response = await request(`http://127.0.0.1:${address.port}/mcp`, {
      method: 'HEAD',
      headers: { accept: 'text/event-stream' },
      headersTimeout: 2000
    })
    await response.body.dump()
    t.assert.strictEqual(response.statusCode, 405)
    t.assert.strictEqual(create.mock.callCount(), 0)
  })

  test('with SSE disabled, answers 405 with Allow', async (t: TestContext) => {
    const app = Fastify({ logger: false })
    t.after(() => app.close())
    await app.register(mcpPlugin, { enableSSE: false })
    await app.ready()

    const response = await app.inject({ method: 'HEAD', url: '/mcp', headers: { accept: 'text/event-stream' } })
    t.assert.strictEqual(response.statusCode, 405)
    t.assert.strictEqual(response.headers.allow, 'POST, DELETE')
  })
})
