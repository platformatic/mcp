import { test, describe } from 'node:test'
import type { TestContext } from 'node:test'
import type { Readable } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { Agent, request as undiciRequest } from 'undici'
import type { Redis } from 'ioredis'
import mcpPlugin from '../src/index.ts'
import { RedisSessionStore } from '../src/stores/redis-session-store.ts'
import { RedisMessageBroker } from '../src/brokers/redis-message-broker.ts'
import { SessionTopicSubscriptions } from '../src/session-topic.ts'
import type { MCPPluginOptions } from '../src/types.ts'
import { JSONRPC_VERSION, LATEST_PROTOCOL_VERSION } from '../src/schema.ts'
import type { JSONRPCNotification } from '../src/schema.ts'
import { testWithRedis } from './redis-test-utils.ts'

type RedisConfig = { host: string, port: number, db: number }

function redisConfig (redis: Redis): RedisConfig {
  return { host: redis.options.host!, port: redis.options.port!, db: redis.options.db! }
}

interface TestServer {
  app: FastifyInstance
  baseUrl: string
  /** Resolves once the server has seen `count` GET streams close in total */
  waitForStreamCloses (count: number): Promise<void>
}

// All client connections go through one agent, destroyed before any app is
// closed: a server cannot finish closing while a client still holds a socket
// open, and SSE streams keep theirs open indefinitely
let agent = new Agent()
function request (url: string, options: Parameters<typeof undiciRequest>[1] = {}) {
  return undiciRequest(url, { ...options, dispatcher: agent })
}

async function startServer (t: TestContext, opts: Partial<MCPPluginOptions> = {}): Promise<TestServer> {
  const app = Fastify({ logger: false })
  t.after(async () => {
    const current = agent
    agent = new Agent()
    await current.destroy()
    await app.close()
  })

  await app.register(mcpPlugin, {
    serverInfo: { name: 'test-server', version: '1.0.0' },
    enableSSE: true,
    ...opts
  })

  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  const port = typeof address === 'object' && address ? address.port : 0

  // Our listener is added after Fastify's, so by the time it runs the plugin's
  // own close handler for the stream has run too
  let closes = 0
  const waiters: Array<() => void> = []
  app.server.on('request', (req, res) => {
    if (req.method !== 'GET') return
    res.on('close', () => {
      closes++
      for (const wake of waiters.splice(0)) wake()
    })
  })

  async function waitForStreamCloses (count: number): Promise<void> {
    if (closes >= count) return
    await new Promise<void>(resolve => waiters.push(resolve))
    return waitForStreamCloses(count)
  }

  return { app, baseUrl: `http://127.0.0.1:${port}`, waitForStreamCloses }
}

async function initialize (baseUrl: string): Promise<string> {
  const response = await request(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      jsonrpc: JSONRPC_VERSION,
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' }
      }
    })
  })
  await response.body.text()
  const sessionId = response.headers['mcp-session-id'] as string
  if (!sessionId) throw new Error('initialize did not return a session id')
  return sessionId
}

async function openStream (t: TestContext, baseUrl: string, sessionId: string, lastEventId?: string): Promise<Readable> {
  const headers: Record<string, string> = {
    accept: 'text/event-stream',
    'mcp-session-id': sessionId,
    'mcp-protocol-version': LATEST_PROTOCOL_VERSION
  }
  if (lastEventId) headers['last-event-id'] = lastEventId
  const response = await request(`${baseUrl}/mcp`, { method: 'GET', headers })
  t.assert.strictEqual(response.statusCode, 200)
  return response.body
}

// Reads SSE data until `marker` shows up, or fails after `timeoutMs`
function readUntil (stream: Readable, marker: string, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    const cleanup = () => {
      clearTimeout(timer)
      stream.off('data', onData)
      stream.off('error', onError)
      stream.pause()
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for ${marker}; received: ${JSON.stringify(data)}`))
    }, timeoutMs)
    const onData = (chunk: Buffer) => {
      data += chunk.toString()
      if (data.includes(marker)) {
        cleanup()
        resolve(data)
      }
    }
    const onError = (err: Error) => {
      cleanup()
      reject(err)
    }
    stream.on('data', onData)
    stream.on('error', onError)
    stream.resume()
  })
}

// Resolves when the server ends the stream, or 'timeout'
function waitForEnd (stream: Readable, timeoutMs = 3000): Promise<'ended' | 'timeout'> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve('timeout'), timeoutMs)
    stream.on('end', () => {
      clearTimeout(timer)
      resolve('ended')
    })
    stream.on('error', () => {
      clearTimeout(timer)
      resolve('ended')
    })
    stream.resume()
  })
}

function note (text: string): JSONRPCNotification {
  return { jsonrpc: JSONRPC_VERSION, method: 'notifications/message', params: { level: 'info', data: text } }
}

function eventIds (data: string): string[] {
  return [...data.matchAll(/^id: (\S+)$/gm)].map(match => match[1])
}

async function subscriberCount (redis: Redis, sessionId: string): Promise<number> {
  const [, count] = await redis.pubsub('NUMSUB', `mcp/session/${sessionId}/message`) as [string, number]
  return Number(count)
}

async function waitUntil (predicate: () => Promise<boolean>, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await sleep(25)
  }
  return predicate()
}

/**
 * Close the first stream, send while no stream is open, then reconnect with
 * Last-Event-ID: the message sent in the gap must be replayed, and the new
 * stream must receive live messages again.
 */
async function reconnectScenario (t: TestContext, redis?: RedisConfig) {
  const server = await startServer(t, { redis })
  const { app, baseUrl } = server
  const sessionId = await initialize(baseUrl)

  const first = await openStream(t, baseUrl, sessionId)
  t.assert.strictEqual(await app.mcpSendToSession(sessionId, note('msg-1')), true)
  const firstData = await readUntil(first, 'msg-1')
  t.assert.deepStrictEqual(eventIds(firstData), ['1'])

  first.destroy()
  await server.waitForStreamCloses(1)

  t.assert.strictEqual(await app.mcpSendToSession(sessionId, note('msg-2')), true)

  const second = await openStream(t, baseUrl, sessionId, '1')
  const replayed = await readUntil(second, 'msg-2')
  t.assert.deepStrictEqual(eventIds(replayed), ['2'])

  t.assert.strictEqual(await app.mcpSendToSession(sessionId, note('msg-3')), true)
  const live = await readUntil(second, 'msg-3')
  t.assert.deepStrictEqual(eventIds(live), ['3'])
}

describe('legacy SSE session subscriptions (#327)', () => {
  test('messages sent after the first stream closes are kept and delivered on reconnect', async (t: TestContext) => {
    await reconnectScenario(t)
  })

  testWithRedis('Redis: messages sent after the first stream closes are kept and delivered on reconnect', async (redis, t: TestContext) => {
    await reconnectScenario(t, redisConfig(redis))
  })

  test('messages sent before any stream is opened are replayed', async (t: TestContext) => {
    const { app, baseUrl } = await startServer(t)
    const sessionId = await initialize(baseUrl)

    await app.mcpSendToSession(sessionId, note('early-1'))
    await app.mcpSendToSession(sessionId, note('early-2'))

    // Event 1 is acknowledged, so only event 2 is replayed
    const stream = await openStream(t, baseUrl, sessionId, '1')
    const data = await readUntil(stream, 'early-2')
    t.assert.ok(!data.includes('early-1'))
    t.assert.deepStrictEqual(eventIds(data), ['2'])
  })
})

describe('legacy SSE sessions across Redis instances (#328)', () => {
  testWithRedis('a stream on another instance receives per-session messages sent from either instance', async (redis, t: TestContext) => {
    const a = await startServer(t, { redis: redisConfig(redis) })
    const b = await startServer(t, { redis: redisConfig(redis) })

    const sessionId = await initialize(a.baseUrl)
    const stream = await openStream(t, b.baseUrl, sessionId)

    t.assert.strictEqual(await a.app.mcpSendToSession(sessionId, note('from-a')), true)
    t.assert.strictEqual(await b.app.mcpSendToSession(sessionId, note('from-b')), true)

    const data = await readUntil(stream, 'from-b')
    t.assert.ok(data.includes('from-a'), 'message sent from the other instance must be delivered')
    t.assert.deepStrictEqual(eventIds(data), ['1', '2'])

    // Each message is recorded in history exactly once
    const store = new RedisSessionStore({ redis })
    const history = await store.getMessagesFrom(sessionId, '0')
    t.assert.deepStrictEqual(history.map(entry => entry.eventId), ['1', '2'])
  })

  testWithRedis('DELETE on one instance closes the stream held by another', async (redis, t: TestContext) => {
    const a = await startServer(t, { redis: redisConfig(redis) })
    const b = await startServer(t, { redis: redisConfig(redis) })

    const sessionId = await initialize(a.baseUrl)
    const stream = await openStream(t, b.baseUrl, sessionId)
    const ended = waitForEnd(stream)

    const response = await request(`${a.baseUrl}/mcp`, {
      method: 'DELETE',
      headers: { 'mcp-session-id': sessionId }
    })
    await response.body.dump()
    t.assert.strictEqual(response.statusCode, 204)

    t.assert.strictEqual(await ended, 'ended')
    t.assert.ok(await waitUntil(async () => await subscriberCount(redis, sessionId) === 0),
      'no instance may stay subscribed to a deleted session')
  })
})

describe('legacy SSE session subscriptions do not leak (#329)', () => {
  testWithRedis('expired sessions leave no broker subscription behind', async (redis, t: TestContext) => {
    const { baseUrl } = await startServer(t, { redis: redisConfig(redis), sessionTtlMs: 200 })

    const sessionIds: string[] = []
    for (let i = 0; i < 10; i++) {
      sessionIds.push(await initialize(baseUrl))
    }

    await sleep(600)

    for (const sessionId of sessionIds) {
      t.assert.strictEqual(await redis.exists(`session:${sessionId}`), 0)
      t.assert.strictEqual(await subscriberCount(redis, sessionId), 0)
    }
  })

  testWithRedis('a closed stream leaves no broker subscription behind', async (redis, t: TestContext) => {
    const server = await startServer(t, { redis: redisConfig(redis) })
    const sessionId = await initialize(server.baseUrl)

    const stream = await openStream(t, server.baseUrl, sessionId)
    t.assert.strictEqual(await subscriberCount(redis, sessionId), 1)

    stream.destroy()
    await server.waitForStreamCloses(1)
    t.assert.ok(await waitUntil(async () => await subscriberCount(redis, sessionId) === 0))
  })

  testWithRedis('a stream whose session disappears is closed and unsubscribed by the sweep', async (redis, t: TestContext) => {
    const server = await startServer(t, { redis: redisConfig(redis), sessionTtlMs: 300 })
    const sessionId = await initialize(server.baseUrl)

    const stream = await openStream(t, server.baseUrl, sessionId)
    const ended = waitForEnd(stream)

    // Simulate the key vanishing (eviction, flush) while the stream is open
    await redis.del(`session:${sessionId}`)

    t.assert.strictEqual(await ended, 'ended')
    t.assert.ok(await waitUntil(async () => await subscriberCount(redis, sessionId) === 0))
  })
})

describe('SessionTopicSubscriptions', () => {
  test('a stream attaching while the last one detaches keeps the subscription', async (t: TestContext) => {
    const calls: string[] = []
    const active = new Set<string>()
    let releaseUnsubscribe!: () => void
    const broker = {
      async publish () {},
      async subscribe (topic: string) {
        calls.push(`subscribe ${topic}`)
        active.add(topic)
      },
      async unsubscribe (topic: string) {
        calls.push(`unsubscribe ${topic}`)
        // A slow UNSUBSCRIBE must not win over the subscribe queued after it
        await new Promise<void>(resolve => { releaseUnsubscribe = resolve })
        active.delete(topic)
      },
      async close () {}
    }
    let streams = 1
    const subscriptions = new SessionTopicSubscriptions(broker, () => streams > 0, () => {})

    await subscriptions.sync('s1')
    streams = 0
    const detached = subscriptions.sync('s1')
    // Let the unsubscribe start before the next stream attaches
    await sleep(5)
    t.assert.strictEqual(typeof releaseUnsubscribe, 'function')
    streams = 1
    const attached = subscriptions.sync('s1')
    await sleep(10)
    releaseUnsubscribe()
    await Promise.all([detached, attached])

    t.assert.deepStrictEqual(calls, [
      'subscribe mcp/session/s1/message',
      'unsubscribe mcp/session/s1/message',
      'subscribe mcp/session/s1/message'
    ])
    t.assert.ok(active.has('mcp/session/s1/message'))
    t.assert.strictEqual(subscriptions.isSubscribed('s1'), true)
  })

  testWithRedis('RedisMessageBroker.unsubscribe releases the Redis channel', async (redis, t: TestContext) => {
    const broker = new RedisMessageBroker(redis)
    t.after(() => broker.close())

    await broker.subscribe('mcp/session/numsub-check/message', () => {})
    t.assert.strictEqual(await subscriberCount(redis, 'numsub-check'), 1)

    await broker.unsubscribe('mcp/session/numsub-check/message')
    t.assert.strictEqual(await subscriberCount(redis, 'numsub-check'), 0)

    // And it can subscribe again afterwards
    await broker.subscribe('mcp/session/numsub-check/message', () => {})
    t.assert.strictEqual(await subscriberCount(redis, 'numsub-check'), 1)
  })
})
