import { describe, test } from 'node:test'
import assert from 'node:assert'
import fastify from 'fastify'
import { Redis } from 'ioredis'
import mcpPlugin from '../src/index.ts'
import { isRedisClient } from '../src/redis-client.ts'
import { testWithRedis } from './redis-test-utils.ts'

async function initializeSession (app: ReturnType<typeof fastify>): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/mcp',
    payload: {
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' }
      },
      id: 1
    }
  })
  if (response.statusCode !== 200) {
    throw new Error(`initialize failed with ${response.statusCode}: ${response.payload}`)
  }
  const sessionId = response.headers['mcp-session-id']
  if (typeof sessionId !== 'string') {
    throw new Error('initialize did not return a session id')
  }
  return sessionId
}

describe('redis option: externally managed client', () => {
  testWithRedis('uses a provided ioredis client and does not quit it on close', async (redis, t) => {
    const client = new Redis({
      host: redis.options.host!,
      port: redis.options.port!,
      db: redis.options.db!
    })
    t.after(() => client.disconnect())

    const duplicates: Redis[] = []
    const duplicate = client.duplicate.bind(client)
    client.duplicate = (...args: Parameters<Redis['duplicate']>) => {
      const conn = duplicate(...args)
      duplicates.push(conn)
      return conn
    }
    const errorListeners = client.listenerCount('error')

    const app = fastify()
    await app.register(mcpPlugin, { enableSSE: true, redis: client })
    await app.ready()

    const sessionId = await initializeSession(app)
    assert.strictEqual(await redis.exists(`session:${sessionId}`), 1)

    await app.close()

    // The caller's client stays open and usable
    assert.strictEqual(client.status, 'ready')
    assert.strictEqual(await client.ping(), 'PONG')
    // The plugin did not leave its own listeners behind on the caller's client
    assert.strictEqual(client.listenerCount('error'), errorListeners)
    // Connections the plugin derived from the client (pub/sub) are closed
    assert.ok(duplicates.length > 0)
    for (const conn of duplicates) {
      assert.strictEqual(conn.status, 'end')
    }
  })

  testWithRedis('uses a provided client for the task store', async (redis, t) => {
    const client = new Redis({
      host: redis.options.host!,
      port: redis.options.port!,
      db: redis.options.db!
    })
    t.after(() => client.disconnect())

    const app = fastify()
    await app.register(mcpPlugin, { enableSSE: true, enableTasks: true, redis: client })
    await app.ready()
    await app.close()

    assert.strictEqual(client.status, 'ready')
  })

  testWithRedis('accepts a Redis URL string', async (redis, t) => {
    const url = `redis://${redis.options.host}:${redis.options.port}/${redis.options.db}`
    const app = fastify()
    t.after(() => app.close())

    await app.register(mcpPlugin, { enableSSE: true, redis: url })
    await app.ready()

    const sessionId = await initializeSession(app)
    // Stored in the database selected by the URL
    assert.strictEqual(await redis.exists(`session:${sessionId}`), 1)
  })

  testWithRedis('still accepts RedisOptions', async (redis, t) => {
    const app = fastify()
    t.after(() => app.close())

    await app.register(mcpPlugin, {
      enableSSE: true,
      redis: {
        host: redis.options.host!,
        port: redis.options.port!,
        db: redis.options.db!
      }
    })
    await app.ready()

    const sessionId = await initializeSession(app)
    assert.strictEqual(await redis.exists(`session:${sessionId}`), 1)
  })
})

describe('isRedisClient', () => {
  test('recognises an ioredis instance', (t) => {
    const client = new Redis({ lazyConnect: true })
    t.after(() => client.disconnect())
    assert.strictEqual(isRedisClient(client), true)
  })

  test('recognises a client from another copy of ioredis by shape', () => {
    const fn = () => {}
    const foreign = { duplicate: fn, quit: fn, disconnect: fn, on: fn, get: fn, hset: fn }
    assert.strictEqual(isRedisClient(foreign), true)
  })

  test('rejects options objects, strings and nullish values', () => {
    assert.strictEqual(isRedisClient({ host: 'localhost', port: 6379 }), false)
    assert.strictEqual(isRedisClient('redis://localhost:6379'), false)
    assert.strictEqual(isRedisClient(undefined), false)
    assert.strictEqual(isRedisClient(null), false)
  })
})
