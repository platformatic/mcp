import { test, describe } from 'node:test'
import type { TestContext } from 'node:test'
import http from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import Fastify from 'fastify'
import mcpPlugin from '../src/index.ts'
import { MemorySessionStore } from '../src/stores/memory-session-store.ts'

async function setupServer (t: TestContext, options: { sessionTtlMs?: number } = {}) {
  const app = Fastify({ logger: false })
  t.after(() => app.close())
  await app.register(mcpPlugin, { enableSSE: true, ...options })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const { port } = app.server.address() as { port: number }

  const init = await app.inject({
    method: 'POST',
    url: '/mcp',
    payload: {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } }
    }
  })
  const sessionId = init.headers['mcp-session-id'] as string
  return { app, port, sessionId }
}

// Open a GET and give up on it after `abortAfterMs`, as a client that goes
// away while the server is still setting the stream up
function openAndAbort (port: number, headers: http.OutgoingHttpHeaders, abortAfterMs: number): Promise<void> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/mcp', headers })
    req.on('error', () => {})
    req.on('response', (res) => res.resume())
    setTimeout(() => {
      req.destroy()
      resolve()
    }, abortAfterMs)
  })
}

// Status of a fresh GET for the session; the stream is closed right away
function getStatus (port: number, sessionId: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: '127.0.0.1',
      port,
      path: '/mcp',
      headers: { accept: 'text/event-stream', 'mcp-session-id': sessionId }
    })
    req.setTimeout(2000, () => req.destroy(new Error('no response within 2s')))
    req.on('error', reject)
    req.on('response', (res) => {
      resolve(res.statusCode!)
      req.destroy()
    })
  })
}

describe('a client that leaves while the SSE stream is being set up', () => {
  test('leaving during the Last-Event-ID replay does not leave a stream behind', async (t: TestContext) => {
    const { port, sessionId } = await setupServer(t)

    // Stand in for Redis XRANGE latency
    const original = MemorySessionStore.prototype.getMessagesFrom
    t.mock.method(MemorySessionStore.prototype, 'getMessagesFrom', async function (this: MemorySessionStore, ...args: Parameters<typeof original>) {
      await sleep(300)
      return original.apply(this, args)
    })

    await openAndAbort(port, {
      accept: 'text/event-stream',
      'mcp-session-id': sessionId,
      'last-event-id': '0'
    }, 100)
    await sleep(400)

    t.assert.strictEqual(await getStatus(port, sessionId), 200)
  })

  test('leaving before the stream is registered does not leave a stream behind', async (t: TestContext) => {
    const { port, sessionId } = await setupServer(t)

    const original = MemorySessionStore.prototype.touch
    t.mock.method(MemorySessionStore.prototype, 'touch', async function (this: MemorySessionStore, ...args: Parameters<typeof original>) {
      await sleep(300)
      return original.apply(this, args)
    })

    await openAndAbort(port, {
      accept: 'text/event-stream',
      'mcp-session-id': sessionId
    }, 100)
    await sleep(400)
    t.mock.restoreAll()

    t.assert.strictEqual(await getStatus(port, sessionId), 200)
  })

  test('no heartbeat keeps refreshing the session of a stream that left during replay', async (t: TestContext) => {
    // Heartbeats run every sessionTtlMs / 2
    const { port, sessionId } = await setupServer(t, { sessionTtlMs: 1000 })

    const original = MemorySessionStore.prototype.getMessagesFrom
    t.mock.method(MemorySessionStore.prototype, 'getMessagesFrom', async function (this: MemorySessionStore, ...args: Parameters<typeof original>) {
      await sleep(300)
      return original.apply(this, args)
    })

    await openAndAbort(port, {
      accept: 'text/event-stream',
      'mcp-session-id': sessionId,
      'last-event-id': '0'
    }, 100)
    const touch = t.mock.method(MemorySessionStore.prototype, 'touch')
    await sleep(1200)

    t.assert.strictEqual(touch.mock.callCount(), 0)
  })
})
