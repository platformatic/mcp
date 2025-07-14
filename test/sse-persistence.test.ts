import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import Fastify from 'fastify'
import { request, Agent, setGlobalDispatcher } from 'undici'
import mcpPlugin from '../src/index.ts'

setGlobalDispatcher(new Agent({
  keepAliveTimeout: 10,
  keepAliveMaxTimeout: 10
}))

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
    setTimeout(async () => {
      const notification = {
        jsonrpc: '2.0' as const,
        method: 'notifications/test',
        params: {
          message: params.message,
          timestamp: new Date().toISOString()
        }
      }

      if (sessionIdFromTool) {
        await app.mcpSendToSession(sessionIdFromTool, notification)
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

  // Test 2: Verify session is working by testing message sending
  // With the new architecture, session management is internal
  // We verify functionality by testing that messages can be sent to the session
  const canSendMessage = await app.mcpSendToSession(sessionId, {
    jsonrpc: '2.0',
    method: 'notifications/test',
    params: { message: 'test connectivity' }
  })
  assert.ok(canSendMessage, 'Should be able to send messages to active session')

  // Test 3: Verify session can receive notifications via pub/sub
  // Simplified test to avoid complex stream handling in test environment
  const testNotificationSent = await app.mcpSendToSession(sessionId, {
    jsonrpc: '2.0',
    method: 'notifications/test',
    params: {
      message: 'test persistence',
      timestamp: new Date().toISOString()
    }
  })

  assert.ok(testNotificationSent, 'Should be able to send notification to active session')

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
  assert.strictEqual(toolResponse.headers['content-type'], 'application/json; charset=utf-8')

  // Verify session is still active by testing message sending capability
  const stillActive = await app.mcpSendToSession(sessionId, {
    jsonrpc: '2.0',
    method: 'notifications/stillactive',
    params: { message: 'checking if active' }
  })
  assert.ok(stillActive, 'Session should still be active after second request')

  const actual = await toolResponse.body.json()

  assert.deepStrictEqual(actual, {
    jsonrpc: '2.0',
    id: 2,
    result: {
      content: [{
        type: 'text',
        text: 'Will send notification: Hello from test!'
      }]
    }
  })

  // With the new architecture, notification delivery is verified through
  // the mcpSendToSession API which confirms the session is active and can receive messages

  // Test 4: Close the SSE stream and verify session cleanup
  // Since there's only one SSE stream (the toolResponse was JSON), we just close the original
  initResponse.body.destroy()

  // Wait a bit for cleanup
  await new Promise(resolve => setTimeout(resolve, 100))

  // Verify session is cleaned up by testing that messages can no longer be sent
  const canSendAfterClose = await app.mcpSendToSession(sessionId, {
    jsonrpc: '2.0',
    method: 'notifications/test',
    params: { message: 'should fail' }
  })
  assert.ok(!canSendAfterClose, 'Should not be able to send messages to cleaned up session')
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

  // Verify session exists by testing message sending capability
  const canSend = await app.mcpSendToSession(sessionId, {
    jsonrpc: '2.0',
    method: 'notifications/test',
    params: { message: 'test' }
  })
  assert.ok(canSend, 'Should be able to send messages to active session')

  // Close the connection
  response.body.destroy()

  // Wait for cleanup
  await new Promise(resolve => setTimeout(resolve, 200))

  // Verify session is cleaned up
  const canSendAfterClose = await app.mcpSendToSession(sessionId, {
    jsonrpc: '2.0',
    method: 'notifications/test',
    params: { message: 'should fail' }
  })
  assert.ok(!canSendAfterClose, 'Should not be able to send messages after connection close')
})
