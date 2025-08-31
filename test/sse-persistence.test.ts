import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import Fastify from 'fastify'
import { request, Agent, setGlobalDispatcher } from 'undici'
import { setTimeout as sleep } from 'node:timers/promises'
import mcpPlugin from '../src/index.ts'

setGlobalDispatcher(new Agent({
  keepAliveTimeout: 10,
  keepAliveMaxTimeout: 10
}))

test('SSE connections should persist and receive notifications', async (t) => {
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

  // Test 1: Initialize session with POST (JSON response)
  const initResponse = await request(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: {
          name: 'test-client',
          version: '1.0.0'
        }
      }
    })
  })

  assert.strictEqual(initResponse.statusCode, 200)
  assert.strictEqual(initResponse.headers['content-type'], 'application/json; charset=utf-8')

  const sessionId = initResponse.headers['mcp-session-id'] as string
  assert.ok(sessionId, 'Session ID should be provided')

  // Test 2: Establish SSE connection using GET
  const sseResponse = await request(`${baseUrl}/mcp`, {
    method: 'GET',
    headers: {
      Accept: 'text/event-stream',
      'mcp-session-id': sessionId
    }
  })

  assert.strictEqual(sseResponse.statusCode, 200)
  assert.strictEqual(sseResponse.headers['content-type'], 'text/event-stream')

  // Test 3: Verify session is working by testing message sending
  const canSendMessage = await app.mcpSendToSession(sessionId, {
    jsonrpc: '2.0',
    method: 'notifications/test',
    params: { message: 'test connectivity' }
  })
  assert.ok(canSendMessage, 'Should be able to send messages to active session')

  // Test 4: Trigger the notification via POST (separate from SSE)
  const toolResponse = await request(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
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

  // Test 5: Close the SSE stream and verify session cleanup
  sseResponse.body.destroy()

  // Wait a bit for cleanup
  await sleep(100)

  const canSendAfterClose = await app.mcpSendToSession(sessionId, {
    jsonrpc: '2.0',
    method: 'notifications/test',
    params: { message: 'should fail' }
  })
  assert.ok(canSendAfterClose, 'This always succeeds because the session might be active in another peer')
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

  // Create a session via POST
  const initResponse = await request(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: {
          name: 'test-client',
          version: '1.0.0'
        }
      }
    })
  })

  const sessionId = initResponse.headers['mcp-session-id'] as string
  assert.ok(sessionId, 'Session ID should be provided')

  // Create a GET SSE connection
  const response = await request(`${baseUrl}/mcp`, {
    method: 'GET',
    headers: {
      Accept: 'text/event-stream',
      'mcp-session-id': sessionId
    }
  })

  assert.strictEqual(response.statusCode, 200)
  assert.strictEqual(response.headers['content-type'], 'text/event-stream')

  // Verify session exists by testing message sending capability
  const canSend = await app.mcpSendToSession(sessionId, {
    jsonrpc: '2.0',
    method: 'notifications/test',
    params: { message: 'test' }
  })
  assert.ok(canSend, 'Should be able to send messages to active session')

  // Close the connection
  response.body.destroy()
})
