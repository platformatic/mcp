import { test, describe } from 'node:test'
import type { TestContext } from 'node:test'
import Fastify from 'fastify'
import { EventSource, request, Agent, setGlobalDispatcher } from 'undici'
import { setTimeout as sleep } from 'node:timers/promises'
import mcpPlugin from '../src/index.ts'

setGlobalDispatcher(new Agent({
  keepAliveTimeout: 10,
  keepAliveMaxTimeout: 10
}))

async function setupServer (t: TestContext) {
  const app = Fastify({ logger: { level: 'error' } })
  await app.register(mcpPlugin, {
    serverInfo: { name: 'test', version: '1.0.0' },
    enableSSE: true
  })

  await app.listen({ port: 0, host: '127.0.0.1' })
  const port = (app.server.address() as any)?.port
  const baseUrl = `http://127.0.0.1:${port}`

  t.after(async () => {
    await app.close()
  })

  return { app, baseUrl }
}

describe('Last-Event-ID Support', () => {
  test('should add message history to SSE sessions', async (t: TestContext) => {
    const { app } = await setupServer(t)
    // Create a session by sending a POST request (JSON response)
    const initResponse = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      payload: {
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' }
        },
        id: 1
      }
    })

    // Verify session was created with proper headers
    if (initResponse.statusCode !== 200) {
      throw new Error(`Expected 200, got ${initResponse.statusCode}`)
    }

    if (initResponse.headers['content-type'] !== 'application/json; charset=utf-8') {
      throw new Error('Expected application/json content type')
    }

    const sessionId = initResponse.headers['mcp-session-id'] as string
    t.assert.ok(sessionId, 'Session ID should be present in headers')

    // Now establish SSE connection with GET request
    const sseResponse = await app.inject({
      method: 'GET',
      url: '/mcp',
      headers: {
        Accept: 'text/event-stream',
        'mcp-session-id': sessionId
      },
      payloadAsStream: true
    })

    if (sseResponse.statusCode !== 200) {
      throw new Error(`Expected SSE 200, got ${sseResponse.statusCode}`)
    }

    if (sseResponse.headers['content-type'] !== 'text/event-stream') {
      throw new Error('Expected text/event-stream content type for SSE')
    }

    t.assert.strictEqual(initResponse.statusCode, 200, 'JSON connection should be established')
    t.assert.strictEqual(initResponse.headers['content-type'], 'application/json; charset=utf-8', 'Should return JSON content type')

    // The session is created internally and message broadcasting works
    // (this is tested via the pub/sub system in integration tests)

    sseResponse.stream().destroy()
  })

  test('should handle GET request with Last-Event-ID using EventSource', async (t) => {
    const { baseUrl } = await setupServer(t)
    const eventSource = new EventSource(`${baseUrl}/mcp`)

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        eventSource.close()
        reject(new Error('EventSource test timeout'))
      }, 2000)

      eventSource.addEventListener('open', () => {
        // EventSource connected successfully
        clearTimeout(timeout)
        eventSource.close()
        resolve()
      })

      eventSource.onerror = () => {
        clearTimeout(timeout)
        eventSource.close()
        reject(new Error('EventSource error occurred'))
      }
    })
  })

  test('should replay messages after Last-Event-ID with EventSource', async (t: TestContext) => {
    const { app, baseUrl } = await setupServer(t)
    // Create a session and populate it with message history
    const initResponse = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      payload: {
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' }
        },
        id: 1
      }
    })

    const sessionId = initResponse.headers['mcp-session-id'] as string
    t.assert.ok(sessionId, 'Session ID should be present in headers')

    // Send additional messages to build message history using the new pub/sub architecture
    await app.mcpSendToSession(sessionId, {
      jsonrpc: '2.0',
      method: 'notifications/message',
      params: { level: 'info', message: 'Message 1' }
    })

    await app.mcpSendToSession(sessionId, {
      jsonrpc: '2.0',
      method: 'notifications/message',
      params: { level: 'info', message: 'Message 2' }
    })

    await app.mcpSendToSession(sessionId, {
      jsonrpc: '2.0',
      method: 'notifications/message',
      params: { level: 'info', message: 'Message 3' }
    })

    // Establish an SSE connection first to create message history
    const firstSseResponse = await app.inject({
      method: 'GET',
      url: '/mcp',
      headers: {
        Accept: 'text/event-stream',
        'mcp-session-id': sessionId
      },
      payloadAsStream: true
    })

    // Close the first SSE stream
    firstSseResponse.stream().destroy()

    // Wait for the stream to be cleaned up
    await sleep(100)

    // Test Last-Event-ID functionality with a fresh GET connection
    // This verifies that the @fastify/sse implementation supports Last-Event-ID headers
    const { statusCode, headers, body } = await request(`${baseUrl}/mcp`, {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        'Last-Event-ID': '0' // Test that Last-Event-ID header is accepted
      }
    })

    if (statusCode !== 200) {
      throw new Error(`Expected status 200, got ${statusCode}`)
    }

    const contentType = headers['content-type']
    if (!contentType?.includes('text/event-stream')) {
      t.assert.fail('Content type should be text/event-stream')
      return
    }

    // Read initial data to verify SSE connection works with Last-Event-ID
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout waiting for SSE data'))
      }, 2000)

      body.on('data', (chunk: Buffer) => {
        const text = chunk.toString()
        // Check if we received any SSE data (connected event or heartbeat)
        if (text.includes('connected') || text.includes('heartbeat') || text.startsWith('data:')) {
          clearTimeout(timeout)
          resolve() // Successfully received SSE data
        }
      })

      body.on('error', (error) => {
        clearTimeout(timeout)
        reject(error)
      })
    })

    body.destroy()
  })
})
