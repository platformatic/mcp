import { test, describe } from 'node:test'
import type { TestContext } from 'node:test'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import type { Readable } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'
import { request, Agent, setGlobalDispatcher } from 'undici'
import mcpPlugin from '../src/index.ts'
import { testWithRedis, defaultRedisConfig } from './redis-test-utils.ts'

const BROADCASTS = 4

setGlobalDispatcher(new Agent({
  keepAliveTimeout: 10,
  keepAliveMaxTimeout: 10
}))

async function openSession (app: FastifyInstance): Promise<string> {
  const init = await app.inject({
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
        clientInfo: { name: 'test', version: '1.0.0' }
      }
    }
  })
  return init.headers['mcp-session-id'] as string
}

// Read SSE events from the stream until `count` events carrying an id arrive
function collectEventIds (stream: Readable, count: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const ids: string[] = []
    const timer = setTimeout(() => reject(new Error(`timed out, got ids ${JSON.stringify(ids)}`)), 3000)
    stream.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      let sep: number
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        const idLine = event.split('\n').find(line => line.startsWith('id: '))
        if (idLine && event.includes('notifications/test')) ids.push(idLine.slice(4))
      }
      if (ids.length >= count) {
        clearTimeout(timer)
        resolve(ids)
      }
    })
    stream.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

async function assertDistinctIdsOnConcurrentBroadcast (t: TestContext, app: FastifyInstance): Promise<void> {
  const sessionId = await openSession(app)
  t.assert.ok(sessionId)

  await app.listen({ port: 0, host: '127.0.0.1' })
  const port = (app.server.address() as any).port
  const url = `http://127.0.0.1:${port}/mcp`

  const sse = await request(url, {
    headers: { accept: 'text/event-stream', 'mcp-session-id': sessionId }
  })
  t.assert.strictEqual(sse.statusCode, 200)
  const stream = sse.body

  let ids: string[]
  try {
    const collected = collectEventIds(stream, BROADCASTS)

    await Promise.all(Array.from({ length: BROADCASTS }, (_, i) => app.mcpBroadcastNotification({
      jsonrpc: '2.0',
      method: 'notifications/test',
      params: { i }
    })))

    ids = await collected
  } finally {
    stream.destroy()
  }

  t.assert.strictEqual(new Set(ids).size, BROADCASTS, `event ids must be unique, got ${JSON.stringify(ids)}`)
  t.assert.deepStrictEqual([...ids].sort((a, b) => Number(a) - Number(b)), ['1', '2', '3', '4'])

  // Only one stream per session is allowed, so let the server see the close
  await sleep(50)

  // Every event must also be in the history so Last-Event-ID resumption replays it
  const replayed = await request(url, {
    headers: { accept: 'text/event-stream', 'mcp-session-id': sessionId, 'last-event-id': '1' }
  })
  const replayStream = replayed.body
  try {
    t.assert.strictEqual(replayed.statusCode, 200)
    const replayedIds = await collectEventIds(replayStream, BROADCASTS - 1)
    t.assert.deepStrictEqual(replayedIds, ['2', '3', '4'])
  } finally {
    replayStream.destroy()
  }
}

describe('concurrent broadcasts allocate distinct SSE event ids (#317)', () => {
  test('memory backend', async (t: TestContext) => {
    const app = Fastify({ logger: false })
    t.after(() => app.close())
    await app.register(mcpPlugin, { serverInfo: { name: 'test', version: '1.0.0' }, enableSSE: true })
    await app.ready()

    await assertDistinctIdsOnConcurrentBroadcast(t, app)
  })

  testWithRedis('redis backend', async (_redis, t) => {
    const app = Fastify({ logger: false })
    t.after(() => app.close())
    await app.register(mcpPlugin, {
      serverInfo: { name: 'test', version: '1.0.0' },
      enableSSE: true,
      redis: defaultRedisConfig
    })
    await app.ready()

    await assertDistinctIdsOnConcurrentBroadcast(t, app)
  })
})
