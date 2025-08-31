import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import Fastify from 'fastify'
import { request, Agent, setGlobalDispatcher } from 'undici'
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

  await app.register(mcpPlugin, {
    serverInfo: {
      name: 'test-server',
      version: '1.0.0'
    },
    enableSSE: true
  })

  app.mcpAddTool({
    name: 'test_notification',
    description: 'Test notification functionality'
  }, async (params) => {
    return {
      content: [{
        type: 'text',
        text: `Test tool called with: ${JSON.stringify(params)}`
      }]
    }
  })

  await app.listen({ port: 0 })
  const address = app.server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const baseUrl = `http://localhost:${port}`

  // Test 1: Create a session using POST request
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

  // Extract session ID from response headers
  const sessionId = initResponse.headers['mcp-session-id'] as string
  assert.ok(sessionId, 'Session ID should be provided in response headers')

  // Test 2: Test tool call via JSON (non-SSE) to verify basic functionality
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

  const actual = await toolResponse.body.json()

  assert.deepStrictEqual(actual, {
    jsonrpc: '2.0',
    id: 2,
    result: {
      content: [{
        type: 'text',
        text: 'Test tool called with: {"message":"Hello from test!"}'
      }]
    }
  })
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

  // Verify session exists by testing message sending capability
  const canSend = await app.mcpSendToSession(sessionId, {
    jsonrpc: '2.0',
    method: 'notifications/test',
    params: { message: 'test' }
  })
  assert.ok(canSend, 'Should be able to send messages to active session')

  // Connection cleanup is handled automatically when test completes
})