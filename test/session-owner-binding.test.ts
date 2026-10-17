import { describe, test } from 'node:test'
import type { TestContext } from 'node:test'
import Fastify from 'fastify'
import type { Redis } from 'ioredis'
import mcpPlugin from '../src/index.ts'
import { MemorySessionStore } from '../src/stores/memory-session-store.ts'
import { RedisSessionStore } from '../src/stores/redis-session-store.ts'
import { JSONRPC_VERSION, LATEST_LEGACY_PROTOCOL_VERSION } from '../src/schema.ts'
import { createTestJWT, setupMockAgent, generateMockJWKSResponse } from './auth-test-utils.ts'
import { testWithRedis } from './redis-test-utils.ts'

interface BuildOptions {
  authorizationServers?: string[]
  introspectionEndpoint?: string
  introspectionResponse?: Record<string, unknown>
  protectedRoutes?: 'all' | 'mcp'
}

async function buildApp (t: TestContext, redis?: Redis, options: BuildOptions = {}) {
  const mocks: Record<string, any> = {
    'https://auth.example.com/.well-known/jwks.json': generateMockJWKSResponse()
  }
  if (options.introspectionEndpoint) {
    mocks[options.introspectionEndpoint] = options.introspectionResponse
  }
  const restoreMock = setupMockAgent(mocks)

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
      authorizationServers: options.authorizationServers ?? ['https://auth.example.com'],
      resourceUri: 'https://mcp.example.com',
      protectedRoutes: options.protectedRoutes,
      tokenValidation: {
        jwksUri: 'https://auth.example.com/.well-known/jwks.json',
        introspectionEndpoint: options.introspectionEndpoint,
        validateAudience: true
      }
    },
    ...(redis
      ? { redis: { host: redis.options.host!, port: redis.options.port!, db: redis.options.db! }, requestStateSecret: 'session-owner-binding-test-secret-0123456789' }
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
        protocolVersion: LATEST_LEGACY_PROTOCOL_VERSION,
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
      'mcp-protocol-version': LATEST_LEGACY_PROTOCOL_VERSION
    },
    payload: {
      jsonrpc: JSONRPC_VERSION,
      id: 2,
      method: 'tools/call',
      params: { name: 'whoami', arguments: {} }
    }
  })
}

async function assertHijackRejected (
  t: TestContext,
  redis?: Redis,
  buildOptions?: BuildOptions,
  aliceClaims: Record<string, unknown> = { sub: 'alice' },
  bobClaims: Record<string, unknown> = { sub: 'bob' }
) {
  const app = await buildApp(t, redis, buildOptions)
  const alice = createTestJWT(aliceClaims)
  const bob = createTestJWT(bobClaims)

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

  // Two trusted authorization servers both issue `sub: alice`, for two
  // different people. Owning a session takes the issuer and the subject.
  const twoIssuers: BuildOptions = {
    authorizationServers: ['https://auth.example.com', 'https://other.example.com']
  }
  const aliceA = { sub: 'alice', iss: 'https://auth.example.com' }
  const aliceB = { sub: 'alice', iss: 'https://other.example.com' }

  test('rejects the same subject from another issuer (memory)', async (t: TestContext) => {
    await assertHijackRejected(t, undefined, twoIssuers, aliceA, aliceB)
  })

  test('rejects the same subject from another issuer, the other way round (memory)', async (t: TestContext) => {
    await assertHijackRejected(t, undefined, twoIssuers, aliceB, aliceA)
  })

  testWithRedis('rejects the same subject from another issuer (redis)', async (redis, t: TestContext) => {
    await assertHijackRejected(t, redis, twoIssuers, aliceA, aliceB)
  })

  test('binding holds when authorization only covers the MCP routes', async (t: TestContext) => {
    await assertHijackRejected(t, undefined, { ...twoIssuers, protectedRoutes: 'mcp' }, aliceA, aliceB)
  })

  test('a trailing slash on iss does not change the owner', async (t: TestContext) => {
    const app = await buildApp(t, undefined, twoIssuers)
    const sessionId = await initialize(app, createTestJWT(aliceA))

    const response = await callWhoami(app, createTestJWT({ ...aliceA, iss: 'https://auth.example.com/' }), sessionId)
    t.assert.strictEqual(response.statusCode, 200)
  })

  async function assertIntrospectionBinding (t: TestContext, redis?: Redis) {
    // No `iss` in the response (RFC 7662 makes it optional): the owner's issuer
    // is the configured introspection endpoint.
    const introspectionEndpoint = 'https://auth.example.com/oauth/introspect'
    const app = await buildApp(t, redis, {
      introspectionEndpoint,
      introspectionResponse: { active: true, sub: 'alice', aud: 'https://mcp.example.com' }
    })

    const sessionId = await initialize(app, 'opaque-alice-token')

    const own = await callWhoami(app, 'opaque-alice-token-2', sessionId)
    t.assert.strictEqual(own.statusCode, 200)
    t.assert.strictEqual(own.json().result.content[0].text, 'alice')

    // A JWT for `alice` from the configured authorization server is a
    // different identity from what the introspection endpoint vouched for.
    const jwtAlice = createTestJWT({ sub: 'alice' })
    const post = await callWhoami(app, jwtAlice, sessionId)
    t.assert.strictEqual(post.statusCode, 404)

    const del = await app.inject({
      method: 'DELETE',
      url: '/mcp',
      headers: { authorization: `Bearer ${jwtAlice}`, 'mcp-session-id': sessionId }
    })
    t.assert.strictEqual(del.statusCode, 404)

    // And the other way round: an introspected `alice` cannot use a JWT session.
    const jwtSession = await initialize(app, jwtAlice)
    const cross = await callWhoami(app, 'opaque-alice-token', jwtSession)
    t.assert.strictEqual(cross.statusCode, 404)
  }

  test('introspection without iss still binds the session (memory)', async (t: TestContext) => {
    await assertIntrospectionBinding(t)
  })

  testWithRedis('introspection without iss still binds the session (redis)', async (redis, t: TestContext) => {
    await assertIntrospectionBinding(t, redis)
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
          protocolVersion: LATEST_LEGACY_PROTOCOL_VERSION,
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
      headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': LATEST_LEGACY_PROTOCOL_VERSION },
      payload: { jsonrpc: JSONRPC_VERSION, id: 2, method: 'ping' }
    })
    t.assert.strictEqual(ping.statusCode, 200)
  })

  test('with resolveAuthorizationContext, a session belongs to the resolved user', async (t: TestContext) => {
    const app = Fastify({ logger: false })
    t.after(() => app.close())
    await app.register(mcpPlugin, {
      capabilities: { tools: {} },
      enableSSE: true,
      resolveAuthorizationContext: async (request) => {
        const user = request.headers['x-user']
        return typeof user === 'string' ? { userId: user, authorizationServer: 'https://app.example.com' } : undefined
      }
    })
    await app.ready()
    const headers = (user: string, sessionId?: string) => ({
      'x-user': user,
      'mcp-protocol-version': LATEST_LEGACY_PROTOCOL_VERSION,
      ...(sessionId ? { 'mcp-session-id': sessionId } : {})
    })

    const init = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: headers('alice'),
      payload: { jsonrpc: JSONRPC_VERSION, id: 1, method: 'initialize', params: { protocolVersion: LATEST_LEGACY_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'c', version: '1' } } }
    })
    const sessionId = init.headers['mcp-session-id'] as string
    t.assert.ok(sessionId)

    const bobStream = await app.inject({ method: 'GET', url: '/mcp', payloadAsStream: true, headers: { ...headers('bob', sessionId), accept: 'text/event-stream' } })
    bobStream.stream().destroy()
    t.assert.strictEqual(bobStream.statusCode, 404)
    const bobPost = await app.inject({ method: 'POST', url: '/mcp', headers: headers('bob', sessionId), payload: { jsonrpc: JSONRPC_VERSION, id: 2, method: 'ping' } })
    t.assert.strictEqual(bobPost.statusCode, 404)
    const bobDelete = await app.inject({ method: 'DELETE', url: '/mcp', headers: headers('bob', sessionId) })
    t.assert.strictEqual(bobDelete.statusCode, 404)

    const alicePost = await app.inject({ method: 'POST', url: '/mcp', headers: headers('alice', sessionId), payload: { jsonrpc: JSONRPC_VERSION, id: 3, method: 'ping' } })
    t.assert.strictEqual(alicePost.statusCode, 200)
  })

  test('memory session store keeps the owner', async (t: TestContext) => {
    const store = new MemorySessionStore()
    await store.create({ id: 's1', eventId: 0, createdAt: new Date(), lastActivity: new Date(), ownerSub: 'alice', ownerIss: 'https://auth.example.com' })
    t.assert.strictEqual((await store.get('s1'))?.ownerSub, 'alice')
    t.assert.strictEqual((await store.get('s1'))?.ownerIss, 'https://auth.example.com')
  })

  testWithRedis('redis session store keeps the owner', async (redis, t: TestContext) => {
    const store = new RedisSessionStore({ redis })
    await store.create({ id: 's1', eventId: 0, createdAt: new Date(), lastActivity: new Date(), ownerSub: 'alice', ownerIss: 'https://auth.example.com' })
    await store.create({ id: 's2', eventId: 0, createdAt: new Date(), lastActivity: new Date() })
    t.assert.strictEqual((await store.get('s1'))?.ownerSub, 'alice')
    t.assert.strictEqual((await store.get('s1'))?.ownerIss, 'https://auth.example.com')
    t.assert.strictEqual((await store.get('s2'))?.ownerSub, undefined)
    t.assert.strictEqual((await store.get('s2'))?.ownerIss, undefined)
  })
})
