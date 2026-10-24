import { test, type TestContext } from 'node:test'
import { Writable } from 'node:stream'
import Fastify from 'fastify'
import { request, Agent, setGlobalDispatcher } from 'undici'
import { setTimeout as sleep } from 'node:timers/promises'
import mcpPlugin from '../src/index.ts'
import { MemorySessionStore } from '../src/stores/memory-session-store.ts'

setGlobalDispatcher(new Agent({
  keepAliveTimeout: 10,
  keepAliveMaxTimeout: 10
}))

interface LogLine {
  level: number
  msg: string
  err?: { message: string }
}

async function setup (t: TestContext, openSSE: boolean) {
  const logs: LogLine[] = []
  const stream = new Writable({
    write (chunk, _encoding, callback) {
      for (const line of chunk.toString().split('\n')) {
        if (line) logs.push(JSON.parse(line))
      }
      callback()
    }
  })

  const app = Fastify({ logger: { level: 'error', stream } })

  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)

  let sseBody: { destroy: () => void } | undefined
  t.after(async () => {
    process.removeListener('unhandledRejection', onUnhandled)
    sseBody?.destroy()
    await app.close()
  })

  await app.register(mcpPlugin, {
    serverInfo: { name: 'test-server', version: '1.0.0' },
    enableSSE: true
  })

  await app.listen({ port: 0 })
  const address = app.server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const baseUrl = `http://localhost:${port}`

  const initResponse = await request(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' }
      }
    })
  })
  await initResponse.body.dump()
  const sessionId = initResponse.headers['mcp-session-id'] as string
  t.assert.ok(sessionId)

  if (openSSE) {
    const sseResponse = await request(`${baseUrl}/mcp`, {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        'mcp-session-id': sessionId
      }
    })
    t.assert.strictEqual(sseResponse.statusCode, 200)
    sseBody = sseResponse.body
  }

  return { app, logs, unhandled, sessionId }
}

// Let the first `skip` calls through, then reject, simulating a store outage
function failSessionStore (t: TestContext, skip = 0) {
  const originalGet = MemorySessionStore.prototype.get
  let calls = 0
  t.mock.method(MemorySessionStore.prototype, 'get', async function (this: MemorySessionStore, sessionId: string) {
    if (calls++ < skip) return originalGet.call(this, sessionId)
    throw new Error('session store unavailable')
  })
  t.mock.method(MemorySessionStore.prototype, 'addMessage', async () => {
    throw new Error('session store unavailable')
  })
}

test('broadcast notification does not cause an unhandled rejection when the session store fails', async (t: TestContext) => {
  const { app, logs, unhandled } = await setup(t, true)

  failSessionStore(t)

  await app.mcpBroadcastNotification({
    jsonrpc: '2.0',
    method: 'notifications/message',
    params: { level: 'info', data: 'hello' }
  })
  await sleep(100)

  t.assert.deepStrictEqual(unhandled, [])
  t.assert.ok(
    logs.some(l => l.err?.message === 'session store unavailable'),
    'error should be logged'
  )
})

test('session message does not cause an unhandled rejection when the session store fails (active stream)', async (t: TestContext) => {
  const { app, logs, unhandled, sessionId } = await setup(t, true)

  // mcpSendToSession looks the session up first, let that succeed
  failSessionStore(t, 1)

  const sent = await app.mcpSendToSession(sessionId, {
    jsonrpc: '2.0',
    method: 'notifications/message',
    params: { level: 'info', data: 'hello' }
  })
  // The message is stored by the sender, so a failing store is reported to the caller
  t.assert.strictEqual(sent, false)
  await sleep(100)

  t.assert.deepStrictEqual(unhandled, [])
  t.assert.ok(
    logs.some(l => l.err?.message === 'session store unavailable'),
    'error should be logged'
  )
})

test('session message does not cause an unhandled rejection when the session store fails (no stream)', async (t: TestContext) => {
  const { app, logs, unhandled, sessionId } = await setup(t, false)

  failSessionStore(t, 1)

  const sent = await app.mcpSendToSession(sessionId, {
    jsonrpc: '2.0',
    method: 'notifications/message',
    params: { level: 'info', data: 'hello' }
  })
  // The message is stored by the sender, so a failing store is reported to the caller
  t.assert.strictEqual(sent, false)
  await sleep(100)

  t.assert.deepStrictEqual(unhandled, [])
  t.assert.ok(
    logs.some(l => l.err?.message === 'session store unavailable'),
    'error should be logged'
  )
})
