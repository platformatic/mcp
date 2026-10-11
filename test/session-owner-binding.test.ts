import { describe, test } from 'node:test'
import type { TestContext } from 'node:test'
import Fastify from 'fastify'
import type { Redis } from 'ioredis'
import mcpPlugin from '../src/index.ts'
import { MemorySessionStore } from '../src/stores/memory-session-store.ts'
import { RedisSessionStore } from '../src/stores/redis-session-store.ts'
import { JSONRPC_VERSION, LATEST_PROTOCOL_VERSION } from '../src/schema.ts'
import { createTestJWT, setupMockAgent, generateMockJWKSResponse } from './auth-test-utils.ts'
import { testWithRedis } from './redis-test-utils.ts'

async function buildApp (t: TestContext, redis?: Redis) {
  const restoreMock = setupMockAgent({
    'https://auth.example.com/.well-known/jwks.json': generateMockJWKSResponse()
  })

  const app = Fastify({ logger: false })
  t.after(async () => {
    await app.close()
    restoreMock()
  })

  await app.register(mcpPlugin, {
    serverInfo: { name: 'test-server', version: '1.0.0' },
    capabilities: { tools: {} },
    enableSSE: true,
    authorization: {
      enabled: true,
      authorizationServers: ['https://auth.example.com'],
      resourceUri: 'https://mcp.example.com',
      tokenValidation: {
        jwksUri: 'https://auth.example.com/.well-known/jwks.json',
        validateAudience: true
      }
    },
    ...(redis
      ? { redis: { host: redis.options.host!, port: redis.options.port!, db: redis.options.db! } }
      : {})
  })

  app.mcpAddTool({
    name: 'whoami',
    description: 'Returns the caller subject',
    inputSchema: { type: 'object', properties: {} }
  }, async (_params: any, context: any) => ({
    content: [{ type: 'text', text: String(context.authContext?.userId) }]
  }))

  await app.ready()
  return app
}

async function initialize (app: Awaited<ReturnType<typeof buildApp>>, token: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      jsonrpc: JSONRPC_VERSION,
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' }
      }
    }
  })
  const sessionId = response.headers['mcp-session-id']
  if (response.statusCode !== 200 || typeof sessionId !== 'string') {
    throw new Error(`initialize failed: ${response.statusCode} ${response.body}`)
  }
  return sessionId
}

function callWhoami (app: Awaited<ReturnType<typeof buildApp>>, token: string, sessionId: string) {
  return app.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      authorization: `Bearer ${token}`,
      'mcp-session-id': sessionId,
      'mcp-protocol-version': LATEST_PROTOCOL_VERSION
    },
    payload: {
      jsonrpc: JSONRPC_VERSION,
      id: 2,
      method: 'tools/call',
      params: { name: 'whoami', arguments: {} }
    }
  })
}

async function assertHijackRejected (t: TestContext, redis?: Redis) {
  const app = await buildApp(t, redis)
  const alice = createTestJWT({ sub: 'alice' })
  const bob = createTestJWT({ sub: 'bob' })

  const sessionId = await initialize(app, alice)

  // Bob holds a perfectly valid token, just not Alice's. Her session ID must not
  // let him in on any of the three methods.
  const post = await callWhoami(app, bob, sessionId)
  t.assert.strictEqual(post.statusCode, 404)
  t.assert.deepStrictEqual(post.json(), { error: 'Session not found' })
  t.assert.strictEqual(post.headers['mcp-session-id'], undefined)

  const get = await app.inject({
    method: 'GET',
    url: '/mcp',
    headers: {
      authorization: `Bearer ${bob}`,
      accept: 'text/event-stream',
      'mcp-session-id': sessionId
    }
  })
  t.assert.strictEqual(get.statusCode, 404)

  const getViaQuery = await app.inject({
    method: 'GET',
    url: `/mcp?mcp-session-id=${sessionId}`,
    headers: { authorization: `Bearer ${bob}`, accept: 'text/event-stream' }
  })
  t.assert.strictEqual(getViaQuery.statusCode, 404)

  const del = await app.inject({
    method: 'DELETE',
    url: '/mcp',
    headers: { authorization: `Bearer ${bob}`, 'mcp-session-id': sessionId }
  })
  t.assert.strictEqual(del.statusCode, 404)

  // Alice's session survived all of that and is still hers.
  const own = await callWhoami(app, alice, sessionId)
  t.assert.strictEqual(own.statusCode, 200)
  t.assert.strictEqual(own.json().result.content[0].text, 'alice')

  const ownGet = await app.inject({
    method: 'GET',
    url: '/mcp',
    payloadAsStream: true,
    headers: {
      authorization: `Bearer ${alice}`,
      accept: 'text/event-stream',
      'mcp-session-id': sessionId
    }
  })
  t.assert.strictEqual(ownGet.statusCode, 200)
  ownGet.stream().destroy()

  const ownDelete = await app.inject({
    method: 'DELETE',
    url: '/mcp',
    headers: { authorization: `Bearer ${alice}`, 'mcp-session-id': sessionId }
  })
  t.assert.strictEqual(ownDelete.statusCode, 204)
}

describe('Session owner binding', () => {
  test('rejects another subject reusing a session ID (memory)', async (t: TestContext) => {
    await assertHijackRejected(t)
  })

  testWithRedis('rejects another subject reusing a session ID (redis)', async (redis, t: TestContext) => {
    await assertHijackRejected(t, redis)
  })

  test('a new token for the same subject can keep using the session', async (t: TestContext) => {
    const app = await buildApp(t)
    const sessionId = await initialize(app, createTestJWT({ sub: 'alice' }))

    const response = await callWhoami(app, createTestJWT({ sub: 'alice', iat: Math.floor(Date.now() / 1000) + 1 }), sessionId)
    t.assert.strictEqual(response.statusCode, 200)
    t.assert.strictEqual(response.json().result.content[0].text, 'alice')
  })

  test('sessions created without authorization are not bound', async (t: TestContext) => {
    const app = Fastify({ logger: false })
    t.after(() => app.close())
    await app.register(mcpPlugin, { enableSSE: true })
    await app.ready()

    const init = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' }
        }
      }
    })
    const sessionId = init.headers['mcp-session-id'] as string
    t.assert.ok(sessionId)

    const ping = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': LATEST_PROTOCOL_VERSION },
      payload: { jsonrpc: JSONRPC_VERSION, id: 2, method: 'ping' }
    })
    t.assert.strictEqual(ping.statusCode, 200)
  })

  test('memory session store keeps the owner', async (t: TestContext) => {
    const store = new MemorySessionStore()
    await store.create({ id: 's1', eventId: 0, createdAt: new Date(), lastActivity: new Date(), ownerSub: 'alice' })
    t.assert.strictEqual((await store.get('s1'))?.ownerSub, 'alice')
  })

  testWithRedis('redis session store keeps the owner', async (redis, t: TestContext) => {
    const store = new RedisSessionStore({ redis })
    await store.create({ id: 's1', eventId: 0, createdAt: new Date(), lastActivity: new Date(), ownerSub: 'alice' })
    await store.create({ id: 's2', eventId: 0, createdAt: new Date(), lastActivity: new Date() })
    t.assert.strictEqual((await store.get('s1'))?.ownerSub, 'alice')
    t.assert.strictEqual((await store.get('s2'))?.ownerSub, undefined)
  })
})
