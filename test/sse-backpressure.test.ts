import { test, describe } from 'node:test'
import type { TestContext } from 'node:test'
import net from 'node:net'
import http from 'node:http'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import Fastify from 'fastify'
import mcpPlugin from '../src/index.ts'

const MB = 1024 * 1024
const BIG = 'x'.repeat(64 * 1024)

function bigNotification (i: number) {
  return { jsonrpc: '2.0' as const, method: 'notifications/message', params: { level: 'info' as const, data: { i, payload: BIG } } }
}

async function setupServer (t: TestContext) {
  const app = Fastify({ logger: false })
  const sockets: net.Socket[] = []
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await app.close()
  })
  await app.register(mcpPlugin, { enableSSE: true })

  // The raw responses of the GET streams, to see what the server buffers
  const responses: http.ServerResponse[] = []
  app.addHook('onRequest', async (request, reply) => {
    if (request.method === 'GET') responses.push(reply.raw)
  })

  await app.listen({ port: 0, host: '127.0.0.1' })
  const { port } = app.server.address() as { port: number }
  return { app, port, responses, sockets }
}

async function initialize (app: Awaited<ReturnType<typeof setupServer>>['app']): Promise<string> {
  const init = await app.inject({
    method: 'POST',
    url: '/mcp',
    payload: {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } }
    }
  })
  return init.headers['mcp-session-id'] as string
}

// A client that opens the stream and then stops reading
async function openStalledStream (sockets: net.Socket[], port: number, headers: Record<string, string> = {}): Promise<net.Socket> {
  const socket = net.connect(port, '127.0.0.1')
  sockets.push(socket)
  socket.on('error', () => {})
  await once(socket, 'connect')
  const extra = Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join('')
  socket.write(`GET /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: text/event-stream\r\n${extra}\r\n`)
  // Wait for the head, then stop reading
  await once(socket, 'data')
  socket.pause()
  return socket
}

describe('legacy SSE streams bound what they buffer for a slow reader', () => {
  test('a stream that stops reading is closed once its buffer is full', async (t: TestContext) => {
    const { app, port, responses, sockets } = await setupServer(t)
    const socket = await openStalledStream(sockets, port)
    const closed = once(socket, 'close')

    for (let i = 0; i < 400; i++) {
      await app.mcpBroadcastNotification(bigNotification(i))
    }
    await sleep(100)

    const raw = responses[0]
    t.assert.ok(raw.destroyed, 'the stalled stream should be destroyed')
    t.assert.ok(raw.writableLength <= 2 * MB, `server still buffers ${(raw.writableLength / MB).toFixed(1)} MB`)

    // The client sees the connection end once it reads again
    socket.resume()
    await Promise.race([
      closed,
      sleep(5000).then(() => { throw new Error('the stalled stream was not closed') })
    ])
  })

  test('the session accepts a new stream after the slow one was closed', async (t: TestContext) => {
    const { app, port, sockets } = await setupServer(t)
    const sessionId = await initialize(app)
    await openStalledStream(sockets, port, { 'mcp-session-id': sessionId })

    for (let i = 0; i < 100; i++) {
      await app.mcpSendToSession(sessionId, bigNotification(i))
    }
    await sleep(100)

    const response = await app.inject({
      method: 'GET',
      url: '/mcp',
      payloadAsStream: true,
      headers: { accept: 'text/event-stream', 'mcp-session-id': sessionId, 'last-event-id': '1' }
    })
    response.stream().destroy()
    t.assert.strictEqual(response.statusCode, 200)
  })

  test('a Last-Event-ID replay larger than the buffer limit reaches a reader that keeps up', async (t: TestContext) => {
    const { app, port } = await setupServer(t)
    const sessionId = await initialize(app)

    // No stream yet, so these all go to the history. Event ids start at 1,
    // and resuming from 1 replays the other 49: about 3 MB.
    for (let i = 0; i < 50; i++) {
      await app.mcpSendToSession(sessionId, bigNotification(i))
    }
    await sleep(100)

    const received = await new Promise<number>((resolve, reject) => {
      const req = http.get({
        host: '127.0.0.1',
        port,
        path: '/mcp',
        headers: { accept: 'text/event-stream', 'mcp-session-id': sessionId, 'last-event-id': '1' }
      })
      req.setTimeout(5000, () => req.destroy(new Error('replay did not complete within 5s')))
      req.on('error', reject)
      req.on('response', (res) => {
        let buffered = ''
        let events = 0
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          buffered += chunk
          let end
          while ((end = buffered.indexOf('\n\n')) !== -1) {
            if (buffered.slice(0, end).startsWith('id: ')) events++
            buffered = buffered.slice(end + 2)
          }
          if (events === 49) {
            req.destroy()
            resolve(events)
          }
        })
        res.on('close', () => reject(new Error(`stream closed after ${events} events`)))
      })
    })
    t.assert.strictEqual(received, 49)
  })

  test('a Last-Event-ID replay to a reader that stops reading is not buffered whole', async (t: TestContext) => {
    const { app, port, responses, sockets } = await setupServer(t)
    const sessionId = await initialize(app)

    for (let i = 0; i < 50; i++) {
      await app.mcpSendToSession(sessionId, bigNotification(i))
    }
    await sleep(100)

    await openStalledStream(sockets, port, { 'mcp-session-id': sessionId, 'last-event-id': '1' })
    await sleep(200)

    const raw = responses[0]
    t.assert.ok(raw.writableLength <= 2 * MB, `server buffers ${(raw.writableLength / MB).toFixed(1)} MB of replay`)
  })
})
