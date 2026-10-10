import { test, describe } from 'node:test'
import type { TestContext } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import type { Readable } from 'node:stream'
import mcpPlugin from '../src/index.ts'
import { MemorySessionStore } from '../src/stores/memory-session-store.ts'
import { RedisSessionStore } from '../src/stores/redis-session-store.ts'
import { testWithRedis } from './redis-test-utils.ts'

async function createApp (t: TestContext, redis?: { host: string, port: number, db: number }): Promise<FastifyInstance> {
  const app = fastify()
  t.after(() => app.close())

  await app.register(mcpPlugin, {
    serverInfo: { name: 'test', version: '1.0.0' },
    capabilities: { resources: { subscribe: true } },
    enableSSE: true,
    redis
  })

  app.mcpSetResourceSubscribeHandler(async () => ({}))
  app.mcpSetResourceUnsubscribeHandler(async () => ({}))

  return app
}

async function initSession (app: FastifyInstance): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    payload: {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' }
      }
    }
  })
  return response.headers['mcp-session-id'] as string
}

async function rpc (app: FastifyInstance, sessionId: string, method: string, uri: string): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'mcp-session-id': sessionId
    },
    payload: { jsonrpc: '2.0', id: 2, method, params: { uri } }
  })
  const body = response.json()
  if (body.error) throw new Error(body.error.message)
}

async function openStream (t: TestContext, app: FastifyInstance, sessionId: string): Promise<Readable> {
  const response = await app.inject({
    method: 'GET',
    url: '/mcp',
    headers: { accept: 'text/event-stream', 'mcp-session-id': sessionId },
    payloadAsStream: true
  })
  t.assert.strictEqual(response.statusCode, 200)
  const stream = response.stream()
  t.after(() => stream.destroy())
  return stream
}

// Read SSE data until `marker` shows up, returning everything seen so far.
// Listens for 'data' instead of using for-await so the stream stays open.
function readUntil (stream: Readable, marker: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    const onData = (chunk: Buffer) => {
      data += chunk.toString()
      if (data.includes(marker)) {
        stream.off('data', onData)
        stream.off('error', reject)
        stream.pause()
        resolve(data)
      }
    }
    stream.on('data', onData)
    stream.on('error', reject)
    stream.resume()
  })
}

function resourceUpdated (uri: string) {
  return {
    jsonrpc: '2.0' as const,
    method: 'notifications/resources/updated',
    params: { uri }
  }
}

describe('resources/updated broadcasts respect subscriptions', () => {
  test('only subscribed sessions receive resources/updated', async (t: TestContext) => {
    const app = await createApp(t)

    const subscribed = await initSession(app)
    const other = await initSession(app)
    await rpc(app, subscribed, 'resources/subscribe', 'file:///secret.txt')
    await rpc(app, other, 'resources/subscribe', 'file:///marker.txt')

    const subscribedStream = await openStream(t, app, subscribed)
    const otherStream = await openStream(t, app, other)

    await app.mcpBroadcastNotification(resourceUpdated('file:///secret.txt'))
    await app.mcpBroadcastNotification(resourceUpdated('file:///marker.txt'))

    const subscribedData = await readUntil(subscribedStream, 'file:///secret.txt')
    t.assert.ok(subscribedData.includes('file:///secret.txt'))

    const otherData = await readUntil(otherStream, 'file:///marker.txt')
    t.assert.ok(!otherData.includes('file:///secret.txt'), 'unsubscribed session must not receive the update')
  })

  test('unsubscribe stops delivery', async (t: TestContext) => {
    const app = await createApp(t)

    const sessionId = await initSession(app)
    await rpc(app, sessionId, 'resources/subscribe', 'file:///a.txt')
    await rpc(app, sessionId, 'resources/subscribe', 'file:///marker.txt')
    const stream = await openStream(t, app, sessionId)

    await app.mcpBroadcastNotification(resourceUpdated('file:///a.txt'))
    await readUntil(stream, 'file:///a.txt')

    await rpc(app, sessionId, 'resources/unsubscribe', 'file:///a.txt')

    await app.mcpBroadcastNotification(resourceUpdated('file:///a.txt'))
    await app.mcpBroadcastNotification(resourceUpdated('file:///marker.txt'))

    const data = await readUntil(stream, 'file:///marker.txt')
    t.assert.ok(!data.includes('file:///a.txt'), 'update after unsubscribe must not be delivered')
  })

  test('other broadcast notifications still reach every session', async (t: TestContext) => {
    const app = await createApp(t)

    const sessionId = await initSession(app)
    const stream = await openStream(t, app, sessionId)

    await app.mcpBroadcastNotification({
      jsonrpc: '2.0',
      method: 'notifications/resources/list_changed'
    })

    const data = await readUntil(stream, 'notifications/resources/list_changed')
    t.assert.ok(data.includes('notifications/resources/list_changed'))
  })

  test('MemorySessionStore tracks resource subscriptions', async (t: TestContext) => {
    const store = new MemorySessionStore()
    const now = new Date()
    await store.create({ id: 's1', eventId: 0, createdAt: now, lastActivity: now })

    await store.addResourceSubscription('s1', 'file:///a.txt')
    await store.addResourceSubscription('s1', 'file:///a.txt')
    await store.addResourceSubscription('s1', 'file:///b.txt')
    t.assert.deepStrictEqual((await store.get('s1'))?.resourceSubscriptions, ['file:///a.txt', 'file:///b.txt'])

    await store.removeResourceSubscription('s1', 'file:///a.txt')
    t.assert.deepStrictEqual((await store.get('s1'))?.resourceSubscriptions, ['file:///b.txt'])

    // No-op for unknown sessions
    await store.addResourceSubscription('missing', 'file:///a.txt')
    t.assert.strictEqual(await store.get('missing'), null)
  })
})

describe('resources/updated subscriptions with Redis', () => {
  testWithRedis('subscription made on one instance filters broadcasts from another', async (redis, t: TestContext) => {
    const config = { host: redis.options.host!, port: redis.options.port!, db: redis.options.db! }
    const app1 = await createApp(t, config)
    const app2 = await createApp(t, config)

    const subscribed = await initSession(app1)
    const other = await initSession(app1)

    // Subscribe through the other instance: the subscription must be shared
    await rpc(app2, subscribed, 'resources/subscribe', 'file:///secret.txt')
    await rpc(app2, other, 'resources/subscribe', 'file:///marker.txt')

    const subscribedStream = await openStream(t, app1, subscribed)
    const otherStream = await openStream(t, app1, other)

    await app2.mcpBroadcastNotification(resourceUpdated('file:///secret.txt'))
    await app2.mcpBroadcastNotification(resourceUpdated('file:///marker.txt'))

    const subscribedData = await readUntil(subscribedStream, 'file:///secret.txt')
    t.assert.ok(subscribedData.includes('file:///secret.txt'))

    const otherData = await readUntil(otherStream, 'file:///marker.txt')
    t.assert.ok(!otherData.includes('file:///secret.txt'), 'unsubscribed session must not receive the update')
  })

  testWithRedis('RedisSessionStore tracks resource subscriptions', async (redis, t: TestContext) => {
    const store = new RedisSessionStore({ redis })
    const now = new Date()
    await store.create({ id: 's1', eventId: 0, createdAt: now, lastActivity: now })

    await store.addResourceSubscription('s1', 'file:///a.txt')
    await store.addResourceSubscription('s1', 'file:///b.txt')
    t.assert.deepStrictEqual((await store.get('s1'))?.resourceSubscriptions?.sort(), ['file:///a.txt', 'file:///b.txt'])

    await store.removeResourceSubscription('s1', 'file:///a.txt')
    t.assert.deepStrictEqual((await store.get('s1'))?.resourceSubscriptions, ['file:///b.txt'])

    // Must not recreate a missing session
    await store.addResourceSubscription('missing', 'file:///a.txt')
    t.assert.strictEqual(await redis.exists('session:missing'), 0)
  })
})
