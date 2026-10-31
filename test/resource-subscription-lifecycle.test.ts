import { test, describe } from 'node:test'
import type { TestContext } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import type { Redis } from 'ioredis'
import mcpPlugin from '../src/index.ts'
import type { MCPPluginOptions } from '../src/types.ts'
import { JSONRPC_VERSION, LATEST_PROTOCOL_VERSION } from '../src/schema.ts'
import { testWithRedis } from './redis-test-utils.ts'

interface HandlerCall {
  uri: string
  sessionId?: string
}

interface TestApp {
  app: FastifyInstance
  subscribed: HandlerCall[]
  unsubscribed: HandlerCall[]
}

async function createApp (t: TestContext, opts: Partial<MCPPluginOptions> = {}): Promise<TestApp> {
  const app = Fastify({ logger: false })
  t.after(() => app.close())

  await app.register(mcpPlugin, {
    serverInfo: { name: 'test', version: '1.0.0' },
    capabilities: { resources: { subscribe: true } },
    enableSSE: true,
    ...opts
  })

  const subscribed: HandlerCall[] = []
  const unsubscribed: HandlerCall[] = []
  app.mcpSetResourceSubscribeHandler(async ({ uri }, { sessionId }) => {
    subscribed.push({ uri, sessionId })
    return {}
  })
  app.mcpSetResourceUnsubscribeHandler(async ({ uri }, { sessionId }) => {
    unsubscribed.push({ uri, sessionId })
    return {}
  })

  await app.ready()
  return { app, subscribed, unsubscribed }
}

function redisOpts (redis: Redis): Partial<MCPPluginOptions> {
  return { redis: { host: redis.options.host!, port: redis.options.port!, db: redis.options.db! } }
}

async function initSession (app: FastifyInstance): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    payload: {
      jsonrpc: JSONRPC_VERSION,
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
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
      'mcp-session-id': sessionId,
      'mcp-protocol-version': LATEST_PROTOCOL_VERSION
    },
    payload: { jsonrpc: JSONRPC_VERSION, id: 2, method, params: { uri } }
  })
  const body = response.json()
  if (body.error) throw new Error(body.error.message)
}

async function deleteSession (app: FastifyInstance, sessionId: string): Promise<void> {
  const response = await app.inject({
    method: 'DELETE',
    url: '/mcp',
    headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': LATEST_PROTOCOL_VERSION }
  })
  if (response.statusCode !== 204) throw new Error(`DELETE answered ${response.statusCode}`)
}

async function waitFor (predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) {
    await sleep(20)
  }
}

describe('resource unsubscribe handler runs when a legacy session ends (#337)', () => {
  test('DELETE calls the unsubscribe handler for every URI the session held', async (t: TestContext) => {
    const { app, unsubscribed } = await createApp(t)
    const sessionId = await initSession(app)
    await rpc(app, sessionId, 'resources/subscribe', 'file:///a.txt')
    await rpc(app, sessionId, 'resources/subscribe', 'file:///b.txt')

    await deleteSession(app, sessionId)

    t.assert.deepStrictEqual(
      unsubscribed.sort((x, y) => x.uri.localeCompare(y.uri)),
      [{ uri: 'file:///a.txt', sessionId }, { uri: 'file:///b.txt', sessionId }]
    )
  })

  test('DELETE releases subscriptions when SSE is disabled too', async (t: TestContext) => {
    const { app, unsubscribed } = await createApp(t, { enableSSE: false })
    const sessionId = await initSession(app)
    await rpc(app, sessionId, 'resources/subscribe', 'file:///a.txt')

    await deleteSession(app, sessionId)

    t.assert.deepStrictEqual(unsubscribed, [{ uri: 'file:///a.txt', sessionId }])
  })

  test('expiry calls the unsubscribe handler', async (t: TestContext) => {
    const { app, unsubscribed } = await createApp(t, { sessionTtlMs: 150 })
    const sessionId = await initSession(app)
    await rpc(app, sessionId, 'resources/subscribe', 'file:///a.txt')

    await waitFor(() => unsubscribed.length > 0)

    t.assert.deepStrictEqual(unsubscribed, [{ uri: 'file:///a.txt', sessionId }])
  })

  test('the handler runs only when the last session holding a URI ends', async (t: TestContext) => {
    const { app, unsubscribed } = await createApp(t)
    const first = await initSession(app)
    const second = await initSession(app)
    await rpc(app, first, 'resources/subscribe', 'file:///shared.txt')
    await rpc(app, second, 'resources/subscribe', 'file:///shared.txt')

    await deleteSession(app, first)
    t.assert.deepStrictEqual(unsubscribed, [], 'another session still holds the URI')

    await deleteSession(app, second)
    t.assert.deepStrictEqual(unsubscribed, [{ uri: 'file:///shared.txt', sessionId: second }])
  })

  test('a URI already unsubscribed explicitly is not released again', async (t: TestContext) => {
    const { app, unsubscribed } = await createApp(t)
    const sessionId = await initSession(app)
    await rpc(app, sessionId, 'resources/subscribe', 'file:///a.txt')
    await rpc(app, sessionId, 'resources/unsubscribe', 'file:///a.txt')
    t.assert.strictEqual(unsubscribed.length, 1)

    await deleteSession(app, sessionId)
    t.assert.strictEqual(unsubscribed.length, 1)
  })

  testWithRedis('Redis: expiry through the key TTL calls the unsubscribe handler', async (redis, t: TestContext) => {
    const { app, unsubscribed } = await createApp(t, { ...redisOpts(redis), sessionTtlMs: 200 })
    const sessionId = await initSession(app)
    await rpc(app, sessionId, 'resources/subscribe', 'file:///a.txt')

    await waitFor(() => unsubscribed.length > 0)

    t.assert.strictEqual(await redis.exists(`session:${sessionId}`), 0)
    t.assert.deepStrictEqual(unsubscribed, [{ uri: 'file:///a.txt', sessionId }])
  })

  testWithRedis('Redis: the instance that ran the subscribe handler releases it when another deletes the session', async (redis, t: TestContext) => {
    const a = await createApp(t, { ...redisOpts(redis), sessionTtlMs: 400 })
    const b = await createApp(t, { ...redisOpts(redis), sessionTtlMs: 400 })
    const sessionId = await initSession(a.app)
    await rpc(b.app, sessionId, 'resources/subscribe', 'file:///a.txt')
    t.assert.strictEqual(b.subscribed.length, 1)

    await deleteSession(a.app, sessionId)

    await waitFor(() => b.unsubscribed.length > 0)
    t.assert.deepStrictEqual(b.unsubscribed, [{ uri: 'file:///a.txt', sessionId }])
    t.assert.deepStrictEqual(a.unsubscribed, [], 'instance A never ran the subscribe handler')
  })

  testWithRedis('Redis: an explicit unsubscribe on another instance is released where the subscribe ran', async (redis, t: TestContext) => {
    const a = await createApp(t, { ...redisOpts(redis), sessionTtlMs: 400 })
    const b = await createApp(t, { ...redisOpts(redis), sessionTtlMs: 400 })
    const sessionId = await initSession(a.app)
    await rpc(b.app, sessionId, 'resources/subscribe', 'file:///a.txt')

    await rpc(a.app, sessionId, 'resources/unsubscribe', 'file:///a.txt')
    t.assert.deepStrictEqual(a.unsubscribed, [{ uri: 'file:///a.txt', sessionId }])

    await waitFor(() => b.unsubscribed.length > 0)
    t.assert.deepStrictEqual(b.unsubscribed, [{ uri: 'file:///a.txt', sessionId }])
  })
})
