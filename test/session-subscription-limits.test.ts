import { describe, test } from 'node:test'
import type { TestContext } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import mcpPlugin from '../src/index.ts'
import { MemorySessionStore } from '../src/stores/memory-session-store.ts'
import { RedisSessionStore } from '../src/stores/redis-session-store.ts'
import {
  SessionLimitError,
  SubscriptionLimitError,
  SESSION_LIMIT_REACHED,
  SUBSCRIPTION_LIMIT_REACHED
} from '../src/stores/session-store.ts'
import type { SessionMetadata } from '../src/stores/session-store.ts'
import { JSONRPC_VERSION } from '../src/schema.ts'
import { testWithRedis } from './redis-test-utils.ts'

function newSession (id: string, owner?: { ownerSub?: string, ownerIss?: string }): SessionMetadata {
  return {
    id,
    eventId: 0,
    createdAt: new Date(),
    lastActivity: new Date(),
    ...owner
  }
}

describe('MemorySessionStore session limit', () => {
  test('rejects a new session when the owner is at the cap', async (t: TestContext) => {
    const store = new MemorySessionStore(100, { maxSessionsPerPrincipal: 2 })
    await store.create(newSession('a', { ownerSub: 'alice', ownerIss: 'https://auth.example.com' }))
    await store.create(newSession('b', { ownerSub: 'alice', ownerIss: 'https://auth.example.com' }))

    await t.assert.rejects(
      store.create(newSession('c', { ownerSub: 'alice', ownerIss: 'https://auth.example.com' })),
      (err: unknown) => err instanceof SessionLimitError && err.limit === 2
    )
  })

  test('is isolated between principals', async (t: TestContext) => {
    const store = new MemorySessionStore(100, { maxSessionsPerPrincipal: 1 })
    await store.create(newSession('a', { ownerSub: 'alice', ownerIss: 'https://auth.example.com' }))

    // A different subject is a different bucket and is not blocked
    await store.create(newSession('b', { ownerSub: 'bob', ownerIss: 'https://auth.example.com' }))
    t.assert.strictEqual((await store.get('b'))?.id, 'b')

    // A different issuer for the same subject is also a different bucket
    await store.create(newSession('c', { ownerSub: 'alice', ownerIss: 'https://other.example.com' }))
    t.assert.strictEqual((await store.get('c'))?.id, 'c')

    // Same (issuer, subject) again is blocked
    await t.assert.rejects(
      store.create(newSession('d', { ownerSub: 'alice', ownerIss: 'https://auth.example.com' })),
      SessionLimitError
    )
  })

  test('anonymous sessions share one bucket', async (t: TestContext) => {
    const store = new MemorySessionStore(100, { maxSessionsPerPrincipal: 1 })
    await store.create(newSession('a'))

    await t.assert.rejects(
      store.create(newSession('b')),
      SessionLimitError
    )
  })

  test('expired sessions do not count against the cap', async (t: TestContext) => {
    const store = new MemorySessionStore(100, { sessionTtlMs: 1000, maxSessionsPerPrincipal: 1 })
    await store.create(newSession('a', { ownerSub: 'alice', ownerIss: 'https://auth.example.com' }))

    // Age the session past its TTL, then let the store observe it.
    const aged = (await store.get('a'))!
    aged.lastActivity = new Date(Date.now() - 5000)
    await store.update(aged)

    // The expired session no longer counts, so a new one fits
    await store.create(newSession('b', { ownerSub: 'alice', ownerIss: 'https://auth.example.com' }))
    t.assert.strictEqual((await store.get('b'))?.id, 'b')
  })

  test('rejects invalid limit values', (t: TestContext) => {
    t.assert.throws(() => new MemorySessionStore(100, { maxSessionsPerPrincipal: 0 }), TypeError)
    t.assert.throws(() => new MemorySessionStore(100, { maxResourceSubscriptionsPerSession: 1.5 }), TypeError)
  })
})

describe('MemorySessionStore subscription limit', () => {
  test('rejects a new URI when the session is at the cap, keeping duplicates idempotent', async (t: TestContext) => {
    const store = new MemorySessionStore(100, { maxResourceSubscriptionsPerSession: 2 })
    await store.create(newSession('s1'))

    await store.addResourceSubscription('s1', 'file:///a.txt')
    await store.addResourceSubscription('s1', 'file:///b.txt')

    // Duplicate is a no-op, not an error
    await store.addResourceSubscription('s1', 'file:///a.txt')

    // A third distinct URI is rejected
    await t.assert.rejects(
      store.addResourceSubscription('s1', 'file:///c.txt'),
      (err: unknown) => err instanceof SubscriptionLimitError && err.limit === 2
    )

    // The stored subscriptions still only hold the two accepted URIs
    t.assert.deepStrictEqual((await store.get('s1'))?.resourceSubscriptions, ['file:///a.txt', 'file:///b.txt'])
  })

  test('a removed URI frees a slot', async (t: TestContext) => {
    const store = new MemorySessionStore(100, { maxResourceSubscriptionsPerSession: 1 })
    await store.create(newSession('s1'))
    await store.addResourceSubscription('s1', 'file:///a.txt')
    await store.removeResourceSubscription('s1', 'file:///a.txt')
    await store.addResourceSubscription('s1', 'file:///b.txt')
    t.assert.deepStrictEqual((await store.get('s1'))?.resourceSubscriptions, ['file:///b.txt'])
  })
})

describe('RedisSessionStore session limit', () => {
  testWithRedis('rejects a new session when the owner is at the cap', async (redis, t: TestContext) => {
    const store = new RedisSessionStore({ redis, maxSessionsPerPrincipal: 2 })
    await store.create(newSession('a', { ownerSub: 'alice', ownerIss: 'https://auth.example.com' }))
    await store.create(newSession('b', { ownerSub: 'alice', ownerIss: 'https://auth.example.com' }))

    await t.assert.rejects(
      store.create(newSession('c', { ownerSub: 'alice', ownerIss: 'https://auth.example.com' })),
      (err: unknown) => err instanceof SessionLimitError && err.limit === 2
    )
  })

  testWithRedis('is isolated between principals', async (redis, t: TestContext) => {
    const store = new RedisSessionStore({ redis, maxSessionsPerPrincipal: 1 })
    await store.create(newSession('a', { ownerSub: 'alice', ownerIss: 'https://auth.example.com' }))

    await store.create(newSession('b', { ownerSub: 'bob', ownerIss: 'https://auth.example.com' }))
    await store.create(newSession('c', { ownerSub: 'alice', ownerIss: 'https://other.example.com' }))

    await t.assert.rejects(
      store.create(newSession('d', { ownerSub: 'alice', ownerIss: 'https://auth.example.com' })),
      SessionLimitError
    )
  })

  testWithRedis('concurrent creates cannot exceed the cap', async (redis, t: TestContext) => {
    const store = new RedisSessionStore({ redis, maxSessionsPerPrincipal: 3 })
    const attempts = Array.from({ length: 8 }, (_, i) =>
      store.create(newSession(`c${i}`, { ownerSub: 'alice', ownerIss: 'https://auth.example.com' }))
    )
    const results = await Promise.allSettled(attempts)

    const succeeded = results.filter(r => r.status === 'fulfilled')
    const failed = results.filter(r => r.status === 'rejected')
    // The Lua script is atomic, so exactly `cap` sessions survive
    t.assert.strictEqual(succeeded.length, 3)
    t.assert.strictEqual(failed.length, 5)
    for (const r of failed) {
      t.assert.ok(r.reason instanceof SessionLimitError)
    }
  })

  testWithRedis('deleting a session frees a slot for its owner', async (redis, t: TestContext) => {
    const store = new RedisSessionStore({ redis, maxSessionsPerPrincipal: 1 })
    await store.create(newSession('a', { ownerSub: 'alice', ownerIss: 'https://auth.example.com' }))
    await store.delete('a')
    await store.create(newSession('b', { ownerSub: 'alice', ownerIss: 'https://auth.example.com' }))
    t.assert.strictEqual((await store.get('b'))?.id, 'b')
  })

  testWithRedis('an expired session is pruned from the owner index', async (redis, t: TestContext) => {
    const store = new RedisSessionStore({ redis, maxSessionsPerPrincipal: 1, sessionTtlMs: 5000 })
    await store.create(newSession('a', { ownerSub: 'alice', ownerIss: 'https://auth.example.com' }))

    // Simulate expiry by removing the session key but leaving the owner index
    await redis.del('session:a')

    // The stale id must be pruned before the cap check, so a new session fits
    await store.create(newSession('b', { ownerSub: 'alice', ownerIss: 'https://auth.example.com' }))
    t.assert.strictEqual((await store.get('b'))?.id, 'b')
  })

  testWithRedis('anonymous sessions share one bucket, separate from owned sessions', async (redis, t: TestContext) => {
    const store = new RedisSessionStore({ redis, maxSessionsPerPrincipal: 1 })
    await store.create(newSession('anon'))

    // An owned session is a different bucket and is not blocked
    await store.create(newSession('owned', { ownerSub: 'alice', ownerIss: 'https://auth.example.com' }))

    // A second anonymous session is blocked
    await t.assert.rejects(store.create(newSession('anon2')), SessionLimitError)
  })
})

describe('RedisSessionStore subscription limit', () => {
  testWithRedis('rejects a new URI at the cap, keeping duplicates idempotent', async (redis, t: TestContext) => {
    const store = new RedisSessionStore({ redis, maxResourceSubscriptionsPerSession: 2 })
    await store.create(newSession('s1'))

    await store.addResourceSubscription('s1', 'file:///a.txt')
    await store.addResourceSubscription('s1', 'file:///b.txt')
    await store.addResourceSubscription('s1', 'file:///a.txt') // duplicate, idempotent

    await t.assert.rejects(
      store.addResourceSubscription('s1', 'file:///c.txt'),
      (err: unknown) => err instanceof SubscriptionLimitError && err.limit === 2
    )

    t.assert.deepStrictEqual(
      (await store.get('s1'))?.resourceSubscriptions?.sort(),
      ['file:///a.txt', 'file:///b.txt']
    )
  })

  testWithRedis('concurrent subscribes cannot exceed the cap', async (redis, t: TestContext) => {
    const store = new RedisSessionStore({ redis, maxResourceSubscriptionsPerSession: 3 })
    await store.create(newSession('s1'))

    const attempts = Array.from({ length: 8 }, (_, i) =>
      store.addResourceSubscription('s1', `file:///c${i}.txt`)
    )
    const results = await Promise.allSettled(attempts)
    const succeeded = results.filter(r => r.status === 'fulfilled')
    const failed = results.filter(r => r.status === 'rejected')
    t.assert.strictEqual(succeeded.length, 3)
    t.assert.strictEqual(failed.length, 5)
    for (const r of failed) {
      t.assert.ok(r.reason instanceof SubscriptionLimitError)
    }
  })
})

// Integration: the limits surface as stable protocol errors over HTTP
async function createApp (t: TestContext, pluginOptions: Record<string, unknown> = {}): Promise<FastifyInstance> {
  const app = fastify()
  t.after(() => app.close())
  await app.register(mcpPlugin, {
    serverInfo: { name: 'test', version: '1.0.0' },
    capabilities: { resources: { subscribe: true } },
    enableSSE: true,
    ...pluginOptions
  })
  app.mcpSetResourceSubscribeHandler(async () => ({}))
  app.mcpSetResourceUnsubscribeHandler(async () => ({}))
  return app
}

async function initialize (app: FastifyInstance): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    payload: {
      jsonrpc: JSONRPC_VERSION,
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' }
      }
    }
  })
  if (response.statusCode !== 200) {
    throw new Error(`initialize failed: ${response.statusCode} ${response.body}`)
  }
  return response.headers['mcp-session-id'] as string
}

describe('session and subscription limits over HTTP', () => {
  test('creating a session beyond the per-principal cap fails with a protocol error', async (t: TestContext) => {
    const app = await createApp(t, { maxSessionsPerPrincipal: 1 })
    await initialize(app)

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      payload: {
        jsonrpc: JSONRPC_VERSION,
        id: 7,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' }
        }
      }
    })

    t.assert.strictEqual(response.statusCode, 429)
    const body = response.json()
    t.assert.strictEqual(body.error.code, SESSION_LIMIT_REACHED)
    t.assert.strictEqual(body.id, 7)
  })

  test('opening an SSE stream beyond the per-principal cap fails without hanging', async (t: TestContext) => {
    const app = await createApp(t, { maxSessionsPerPrincipal: 1 })
    await initialize(app)

    const response = await app.inject({
      method: 'GET',
      url: '/mcp',
      headers: { accept: 'text/event-stream' },
      payloadAsStream: true
    })

    t.assert.strictEqual(response.statusCode, 429)
    t.assert.match(response.headers['content-type'] ?? '', /application\/json/)
    response.stream().destroy()
  })

  test('subscribing beyond the per-session cap fails with a protocol error', async (t: TestContext) => {
    const app = await createApp(t, { maxResourceSubscriptionsPerSession: 1 })
    const sessionId = await initialize(app)

    async function subscribe (uri: string) {
      return app.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'mcp-session-id': sessionId
        },
        payload: { jsonrpc: JSONRPC_VERSION, id: 2, method: 'resources/subscribe', params: { uri } }
      })
    }

    const first = await subscribe('file:///a.txt')
    t.assert.strictEqual(first.statusCode, 200)
    t.assert.strictEqual(first.json().error, undefined)

    const second = await subscribe('file:///b.txt')
    t.assert.strictEqual(second.statusCode, 200)
    t.assert.strictEqual(second.json().error.code, SUBSCRIPTION_LIMIT_REACHED)

    // A duplicate of the subscribed URI stays idempotent and succeeds
    const dup = await subscribe('file:///a.txt')
    t.assert.strictEqual(dup.statusCode, 200)
    t.assert.strictEqual(dup.json().error, undefined)
  })
})
