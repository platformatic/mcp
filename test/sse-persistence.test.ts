import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import Fastify from 'fastify'
import { request } from 'undici'
import { Readable } from 'node:stream'
import mcpPlugin from '../src/index.ts'

test('POST SSE connections should persist and receive notifications', async (t) => {
  const app = Fastify({ logger: false })

  t.after(async () => {
    await app.close()
  })

  // Register MCP plugin with SSE enabled
  await app.register(mcpPlugin, {
    serverInfo: {
      name: 'test-server',
      version: '1.0.0'
    },
    enableSSE: true
  })

  // Add a test tool that can trigger notifications
  let sessionIdFromTool: string | undefined
  app.mcpAddTool({
    name: 'test_notification',
    description: 'Test tool that triggers a notification',
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'Message to send as notification'
        }
      },
      required: ['message']
    }
  }, async (params, context) => {
    sessionIdFromTool = context?.sessionId

    // Send a notification after a short delay
    setTimeout(() => {
      const notification = {
        jsonrpc: '2.0' as const,
        method: 'notifications/test',
        params: {
          message: params.message,
          timestamp: new Date().toISOString()
        }
      }

      if (sessionIdFromTool) {
        app.mcpSendToSession(sessionIdFromTool, notification)
      }
    }, 100)

    return {
      content: [{
        type: 'text',
        text: `Will send notification: ${params.message}`
      }]
    }
  })

  await app.listen({ port: 0 })
  const address = app.server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const baseUrl = `http://localhost:${port}`

  // Test 1: Initialize session with POST SSE
  const initResponse = await request(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: {
          name: 'test-client',
          version: '1.0.0'
        }
      }
    })
  })

  assert.strictEqual(initResponse.statusCode, 200)
  assert.strictEqual(initResponse.headers['content-type'], 'text/event-stream')

  const sessionId = initResponse.headers['mcp-session-id'] as string
  assert.ok(sessionId, 'Session ID should be provided')

  // Test 2: Check that session has active streams
  const sessionExists = app.mcpSessions.has(sessionId)
  assert.ok(sessionExists, 'Session should exist')

  const session = app.mcpSessions.get(sessionId)
  assert.ok(session, 'Session should be retrievable')
  assert.strictEqual(session.streams.size, 1, 'Session should have 1 active stream')

  // Test 3: Set up stream reading for notifications
  const notificationPromise = new Promise<string>((resolve, reject) => {
    let receivedData = ''

    const timeout = setTimeout(() => {
      stream.destroy()
      reject(new Error('Timeout waiting for notification'))
    }, 5000)

    const stream = initResponse.body as Readable

    stream.on('data', (chunk) => {
      const data = chunk.toString()
      receivedData += data

      // Check if we received a notification
      if (data.includes('notifications/test')) {
        clearTimeout(timeout)
        resolve(receivedData)
      }
    })

    stream.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })
  })

  // Trigger the notification
  const toolResponse = await request(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'mcp-session-id': sessionId
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'test_notification',
        arguments: {
          message: 'Hello from test!'
        }
      }
    })
  })

  assert.strictEqual(toolResponse.statusCode, 200)
  assert.strictEqual(toolResponse.headers['content-type'], 'text/event-stream')

  // Check that session now has 2 active streams
  assert.strictEqual(session.streams.size, 2, 'Session should have 2 active streams after second request')

  // Wait for notification
  const notificationData = await notificationPromise

  // Verify notification was received
  assert.ok(notificationData.includes('notifications/test'), 'Should receive test notification')
  assert.ok(notificationData.includes('Hello from test!'), 'Should contain test message')

  // Test 4: Close one stream and verify session persists
  toolResponse.body.destroy()

  // Wait a bit for cleanup
  await new Promise(resolve => setTimeout(resolve, 100))

  // Session should still exist with 1 stream
  assert.ok(app.mcpSessions.has(sessionId), 'Session should still exist')
  assert.strictEqual(session.streams.size, 1, 'Session should have 1 active stream after closing one')

  // Close the other stream
  initResponse.body.destroy()

  // Wait a bit for cleanup
  await new Promise(resolve => setTimeout(resolve, 100))

  // Session should be cleaned up
  assert.ok(!app.mcpSessions.has(sessionId), 'Session should be cleaned up when no streams remain')
})

test('Session cleanup on connection close', async (t) => {
  const app = Fastify({ logger: false })

  t.after(async () => {
    await app.close()
  })

  await app.register(mcpPlugin, {
    serverInfo: {
      name: 'test-server',
      version: '1.0.0'
    },
    enableSSE: true
  })

  await app.listen({ port: 0 })
  const address = app.server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const baseUrl = `http://localhost:${port}`

  // Create a POST SSE connection
  const response = await request(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: {
          name: 'test-client',
          version: '1.0.0'
        }
      }
    })
  })

  const sessionId = response.headers['mcp-session-id'] as string
  assert.ok(sessionId, 'Session ID should be provided')

  // Verify session exists
  assert.ok(app.mcpSessions.has(sessionId), 'Session should exist')
  assert.strictEqual(app.mcpSessions.get(sessionId)?.streams.size, 1, 'Should have 1 active stream')

  // Close the connection
  response.body.destroy()

  // Wait for cleanup
  await new Promise(resolve => setTimeout(resolve, 200))

  // Session should be cleaned up
  assert.ok(!app.mcpSessions.has(sessionId), 'Session should be cleaned up after connection close')
})
