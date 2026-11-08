import { test, describe } from 'node:test'
import type { TestContext } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import Fastify from 'fastify'
import type { Redis } from 'ioredis'
import mcpPlugin from '../src/index.ts'
import { JSONRPC_VERSION, LATEST_PROTOCOL_VERSION } from '../src/schema.ts'
import { testWithRedis } from './redis-test-utils.ts'

// The Streamable HTTP transport: once a session is terminated or expired the
// server MUST answer requests carrying its ID with 404, so the client knows to
// start over with a fresh `initialize`.

const initializeRequest = {
  jsonrpc: JSONRPC_VERSION,
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' }
  }
}

const whoamiCall = {
  jsonrpc: JSONRPC_VERSION,
  id: 2,
  method: 'tools/call',
  params: { name: 'whoami', arguments: {} }
}

const sessionNotFound = {
  jsonrpc: JSONRPC_VERSION,
  id: null,
  error: { code: -32001, message: 'Session not found' }
}

const STALE_ID = 'f0d1a2b3-0000-4000-8000-000000000000'

async function buildApp (t: TestContext, opts: { enableSSE: boolean, sessionTtlMs?: number, redis?: Redis }) {
  const app = Fastify({ logger: false })
  t.after(() => app.close())

  const { redis, ...rest } = opts
  await app.register(mcpPlugin, {
    serverInfo: { name: 'test-server', version: '1.0.0' },
    ...rest,
    ...(redis ? { redis: { host: redis.options.host!, port: redis.options.port!, db: redis.options.db! } } : {})
  })

  const calls: string[] = []
  app.mcpAddTool({
    name: 'whoami',
    description: 'Returns the session id the tool ran under'
  }, async (_params, { sessionId }) => {
    calls.push(sessionId ?? 'none')
    return { content: [{ type: 'text', text: sessionId ?? 'none' }] }
  })

  await app.ready()
  return { app, calls }
}

function post (app: Awaited<ReturnType<typeof buildApp>>['app'], payload: unknown, sessionId?: string) {
  return app.inject({
    method: 'POST',
    url: '/mcp',
    headers: sessionId ? { 'mcp-session-id': sessionId } : {},
    payload: payload as any
  })
}

for (const enableSSE of [true, false]) {
  describe(`unknown Mcp-Session-Id (enableSSE: ${enableSSE})`, () => {
    test('a request with an unknown session id is answered 404 and not served', async (t: TestContext) => {
      const { app, calls } = await buildApp(t, { enableSSE })

      const response = await post(app, whoamiCall, STALE_ID)

      t.assert.strictEqual(response.statusCode, 404)
      t.assert.deepStrictEqual(response.json(), sessionNotFound)
      t.assert.strictEqual(response.headers['mcp-session-id'], undefined, 'no new session is handed out')
      t.assert.deepStrictEqual(calls, [], 'the tool must not run')
    })

    test('a notification with an unknown session id is answered 404', async (t: TestContext) => {
      const { app } = await buildApp(t, { enableSSE })

      const response = await post(app, { jsonrpc: JSONRPC_VERSION, method: 'notifications/initialized' }, STALE_ID)

      t.assert.strictEqual(response.statusCode, 404)
      t.assert.deepStrictEqual(response.json(), sessionNotFound)
      t.assert.strictEqual(response.headers['mcp-session-id'], undefined)
    })

    test('initialize with a stale session id starts a fresh session', async (t: TestContext) => {
      const { app } = await buildApp(t, { enableSSE })

      const response = await post(app, initializeRequest, STALE_ID)

      t.assert.strictEqual(response.statusCode, 200)
      const sessionId = response.headers['mcp-session-id']
      t.assert.ok(sessionId)
      t.assert.notStrictEqual(sessionId, STALE_ID)

      const follow = await post(app, whoamiCall, sessionId as string)
      t.assert.strictEqual(follow.statusCode, 200)
      t.assert.strictEqual(follow.json().result.content[0].text, sessionId)
    })

    test('a terminated session is answered 404 afterwards', async (t: TestContext) => {
      const { app } = await buildApp(t, { enableSSE })

      const init = await post(app, initializeRequest)
      const sessionId = init.headers['mcp-session-id'] as string
      t.assert.ok(sessionId)

      const del = await app.inject({ method: 'DELETE', url: '/mcp', headers: { 'mcp-session-id': sessionId } })
      t.assert.strictEqual(del.statusCode, 204)

      const response = await post(app, whoamiCall, sessionId)
      t.assert.strictEqual(response.statusCode, 404)
      t.assert.deepStrictEqual(response.json(), sessionNotFound)
    })

    test('an expired session is answered 404 and the client can re-initialize', async (t: TestContext) => {
      const { app } = await buildApp(t, { enableSSE, sessionTtlMs: 50 })

      const init = await post(app, initializeRequest)
      const sessionId = init.headers['mcp-session-id'] as string
      t.assert.ok(sessionId)

      await sleep(120)

      const response = await post(app, whoamiCall, sessionId)
      t.assert.strictEqual(response.statusCode, 404)
      t.assert.deepStrictEqual(response.json(), sessionNotFound)

      const reinit = await post(app, initializeRequest)
      t.assert.strictEqual(reinit.statusCode, 200)
      t.assert.ok(reinit.headers['mcp-session-id'])
      t.assert.notStrictEqual(reinit.headers['mcp-session-id'], sessionId)
    })

    test('requests without a session id keep working', async (t: TestContext) => {
      const { app } = await buildApp(t, { enableSSE })

      const response = await post(app, whoamiCall)

      t.assert.strictEqual(response.statusCode, 200)
      const sessionId = response.headers['mcp-session-id']
      if (enableSSE) {
        t.assert.ok(sessionId, 'with SSE a session is still created on demand')
        t.assert.strictEqual(response.json().result.content[0].text, sessionId)
      } else {
        t.assert.strictEqual(sessionId, undefined, 'without SSE the request is served statelessly')
        t.assert.strictEqual(response.json().result.content[0].text, 'none')
      }
    })
  })
}

describe('unknown Mcp-Session-Id on GET /mcp', () => {
  test('is answered 404 instead of opening a stream on a new session', async (t: TestContext) => {
    const { app } = await buildApp(t, { enableSSE: true })

    const viaHeader = await app.inject({
      method: 'GET',
      url: '/mcp',
      headers: { accept: 'text/event-stream', 'mcp-session-id': STALE_ID }
    })
    t.assert.strictEqual(viaHeader.statusCode, 404)
    t.assert.deepStrictEqual(viaHeader.json(), { error: 'Session not found' })
    t.assert.strictEqual(viaHeader.headers['mcp-session-id'], undefined)

    const viaQuery = await app.inject({
      method: 'GET',
      url: `/mcp?mcp-session-id=${STALE_ID}`,
      headers: { accept: 'text/event-stream' }
    })
    t.assert.strictEqual(viaQuery.statusCode, 404)
    t.assert.strictEqual(viaQuery.headers['mcp-session-id'], undefined)
  })

  test('without a session id still opens a stream on a new session', async (t: TestContext) => {
    const { app } = await buildApp(t, { enableSSE: true })

    const response = await app.inject({
      method: 'GET',
      url: '/mcp',
      payloadAsStream: true,
      headers: { accept: 'text/event-stream' }
    })
    t.assert.strictEqual(response.statusCode, 200)
    t.assert.ok(response.headers['mcp-session-id'])
    response.stream().destroy()
  })
})

describe('unknown Mcp-Session-Id (redis)', () => {
  testWithRedis('POST and GET answer 404 for a session redis does not know', async (redis, t: TestContext) => {
    const { app, calls } = await buildApp(t, { enableSSE: true, redis })

    const response = await post(app, whoamiCall, STALE_ID)
    t.assert.strictEqual(response.statusCode, 404)
    t.assert.deepStrictEqual(response.json(), sessionNotFound)
    t.assert.deepStrictEqual(calls, [])

    const get = await app.inject({
      method: 'GET',
      url: '/mcp',
      headers: { accept: 'text/event-stream', 'mcp-session-id': STALE_ID }
    })
    t.assert.strictEqual(get.statusCode, 404)

    const init = await post(app, initializeRequest, STALE_ID)
    t.assert.strictEqual(init.statusCode, 200)
    t.assert.notStrictEqual(init.headers['mcp-session-id'], STALE_ID)
  })
})
