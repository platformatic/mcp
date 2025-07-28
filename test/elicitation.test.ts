import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import Fastify from 'fastify'
import mcpPlugin from '../src/index.ts'

test('Elicitation Support', async (t) => {
  await t.test('should provide mcpElicit decorator when SSE is enabled', async () => {
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

    // Verify the decorator exists
    assert.ok(typeof app.mcpElicit === 'function')
  })

  await t.test('should warn and return false when SSE is disabled', async () => {
    const app = Fastify({ logger: false })

    t.after(async () => {
      await app.close()
    })

    await app.register(mcpPlugin, {
      serverInfo: {
        name: 'test-server',
        version: '1.0.0'
      },
      enableSSE: false
    })

    const result = await app.mcpElicit('test-session', 'Test message', {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'User name' }
      },
      required: ['name']
    })

    assert.strictEqual(result, false)
  })

  await t.test('should send elicitation request to valid session', async () => {
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

    // Create an SSE session first
    const response = await fetch(`${baseUrl}/mcp`, {
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
          protocolVersion: '2025-06-18',
          capabilities: { elicitation: {} },
          clientInfo: {
            name: 'test-client',
            version: '1.0.0'
          }
        }
      })
    })

    const sessionId = response.headers.get('mcp-session-id')
    assert.ok(sessionId, 'Session ID should be provided')

    // Now test elicitation
    const elicitResult = await app.mcpElicit(sessionId, 'Please enter your name', {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Your full name' },
        age: { type: 'number', description: 'Your age' }
      },
      required: ['name']
    })

    assert.strictEqual(elicitResult, true)

    // Clean up
    response.body?.cancel()
  })

  await t.test('should return false for non-existent session', async () => {
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

    const result = await app.mcpElicit('non-existent-session', 'Test message', {
      type: 'object',
      properties: {
        response: { type: 'string', description: 'User response' }
      }
    })

    assert.strictEqual(result, false)
  })

  await t.test('should generate request ID when not provided', async () => {
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

    // Create a session
    const response = await fetch(`${baseUrl}/mcp`, {
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
          protocolVersion: '2025-06-18',
          capabilities: { elicitation: {} },
          clientInfo: {
            name: 'test-client',
            version: '1.0.0'
          }
        }
      })
    })

    const sessionId = response.headers.get('mcp-session-id')
    assert.ok(sessionId)

    // Test without providing request ID
    const result1 = await app.mcpElicit(sessionId, 'Test 1', {
      type: 'object',
      properties: {
        answer: { type: 'string' }
      }
    })

    // Test with providing request ID
    const result2 = await app.mcpElicit(sessionId, 'Test 2', {
      type: 'object',
      properties: {
        answer: { type: 'string' }
      }
    }, 'custom-request-id')

    assert.strictEqual(result1, true)
    assert.strictEqual(result2, true)

    // Clean up
    response.body?.cancel()
  })

  await t.test('should handle complex elicitation schemas', async () => {
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

    // Create a session
    const response = await fetch(`${baseUrl}/mcp`, {
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
          protocolVersion: '2025-06-18',
          capabilities: { elicitation: {} },
          clientInfo: {
            name: 'test-client',
            version: '1.0.0'
          }
        }
      })
    })

    const sessionId = response.headers.get('mcp-session-id')
    assert.ok(sessionId)

    // Test complex schema
    const result = await app.mcpElicit(sessionId, 'Please fill out your profile', {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Your full name',
          minLength: 1,
          maxLength: 100
        },
        email: {
          type: 'string',
          description: 'Your email address',
          format: 'email'
        },
        age: {
          type: 'integer',
          description: 'Your age',
          minimum: 0,
          maximum: 150
        },
        active: {
          type: 'boolean',
          description: 'Are you currently active?',
          default: true
        },
        category: {
          type: 'string',
          description: 'Your category',
          enum: ['student', 'professional', 'retired']
        }
      },
      required: ['name', 'email']
    })

    assert.strictEqual(result, true)

    // Clean up
    response.body?.cancel()
  })
})
