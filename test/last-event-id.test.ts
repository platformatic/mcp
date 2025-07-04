import { test } from 'node:test'
import Fastify from 'fastify'
import mcpPlugin from '../src/index.ts'

test('Last-Event-ID Support', async (t) => {
  const app = Fastify()
  await app.register(mcpPlugin, {
    serverInfo: { name: 'test', version: '1.0.0' },
    enableSSE: true
  })
  await app.ready()

  await t.test('should replay messages from Last-Event-ID', async () => {
    // First, send a message to create session history
    const initResponse = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream'
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

    // Extract session ID from response
    const sessionId = initResponse.headers['mcp-session-id'] as string
    
    // Send a notification to create some history
    await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'Content-Type': 'application/json',
        'mcp-session-id': sessionId
      },
      payload: {
        jsonrpc: '2.0',
        method: 'initialized',
        params: {}
      }
    })

    // Broadcast a notification to create history
    app.mcpBroadcastNotification({
      jsonrpc: '2.0',
      method: 'notifications/message',
      params: { level: 'info', message: 'Test message' }
    })

    // Create a new GET request with Last-Event-ID
    const getResponse = await app.inject({
      method: 'GET',
      url: '/mcp',
      headers: {
        'Accept': 'text/event-stream',
        'mcp-session-id': sessionId,
        'Last-Event-ID': '1'
      }
    })

    // Should return 200 with SSE stream
    if (getResponse.statusCode !== 200) {
      throw new Error(`Expected 200, got ${getResponse.statusCode}`)
    }

    if (getResponse.headers['content-type'] !== 'text/event-stream') {
      throw new Error('Expected text/event-stream content type')
    }
  })

  await t.test('should handle invalid Last-Event-ID gracefully', async () => {
    const getResponse = await app.inject({
      method: 'GET',
      url: '/mcp',
      headers: {
        'Accept': 'text/event-stream',
        'Last-Event-ID': 'invalid-id'
      }
    })

    // Should still return 200 and create new session
    if (getResponse.statusCode !== 200) {
      throw new Error(`Expected 200, got ${getResponse.statusCode}`)
    }

    if (getResponse.headers['content-type'] !== 'text/event-stream') {
      throw new Error('Expected text/event-stream content type')
    }
  })
})