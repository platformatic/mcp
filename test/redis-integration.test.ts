import { describe } from 'node:test'
import assert from 'node:assert'
import fastify from 'fastify'
import mcpPlugin from '../src/index.ts'
import { testWithRedis } from './redis-test-utils.ts'
import type { JSONRPCMessage } from '../src/schema.ts'
import { Redis } from 'ioredis'

describe('Redis Integration Tests', () => {
  testWithRedis('should initialize plugin with Redis configuration', async (redis, t) => {
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

    // Verify plugin is registered
    assert.ok(app.mcpAddTool)
    assert.ok(app.mcpAddResource)
    assert.ok(app.mcpAddPrompt)
    assert.ok(app.mcpBroadcastNotification)
    assert.ok(app.mcpSendToSession)
  })

  testWithRedis('should initialize plugin with a Redis client', async (redis, t) => {
    const app = fastify()

    const client = new Redis({
      host: redis.options.host!,
      port: redis.options.port!,
      db: redis.options.db!
    })

    t.after(() => {
      app.close()
      client.quit()
    })

    await app.register(mcpPlugin, {
      enableSSE: true,
      redis: client
    })

    // Verify plugin is registered
    assert.ok(app.mcpAddTool)
    assert.ok(app.mcpAddResource)
    assert.ok(app.mcpAddPrompt)
    assert.ok(app.mcpBroadcastNotification)
    assert.ok(app.mcpSendToSession)
  })

  testWithRedis('should initialize plugin with a Redis url', async (redis, t) => {
    const app = fastify()
    t.after(() => app.close())

    const url = `redis://${redis.options.host}:${redis.options.port}/${redis.options.db}`

    await app.register(mcpPlugin, {
      enableSSE: true,
      redis: url
    })

    // Verify plugin is registered
    assert.ok(app.mcpAddTool)
    assert.ok(app.mcpAddResource)
    assert.ok(app.mcpAddPrompt)
    assert.ok(app.mcpBroadcastNotification)
    assert.ok(app.mcpSendToSession)
  })

  testWithRedis('should handle MCP requests with Redis backend', async (redis, t) => {
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

    // Add a test tool
    app.mcpAddTool({
      name: 'test-tool',
      description: 'A test tool'
    }, async (params) => {
      return {
        content: [{
          type: 'text',
          text: `Tool called with params: ${JSON.stringify(params)}`
        }]
      }
    })

    const initResponse = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: {
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' }
        },
        id: 1
      }
    })

    assert.strictEqual(initResponse.statusCode, 200)
    const initResult = JSON.parse(initResponse.payload)
    assert.strictEqual(initResult.id, 1)
    assert.ok(initResult.result)

    const toolsResponse = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: {
        jsonrpc: '2.0',
        method: 'tools/list',
        id: 2
      }
    })

    assert.strictEqual(toolsResponse.statusCode, 200)
    const toolsResult = JSON.parse(toolsResponse.payload)
    assert.strictEqual(toolsResult.id, 2)
    assert.ok(Array.isArray(toolsResult.result.tools))
    assert.strictEqual(toolsResult.result.tools.length, 1)
    assert.strictEqual(toolsResult.result.tools[0].name, 'test-tool')
  })

  testWithRedis('should handle SSE sessions with Redis persistence', async (redis, t) => {
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

    // Create session via POST
    const initResponse = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'Content-Type': 'application/json',
        accept: 'application/json'
      },
      payload: {
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' }
        },
        id: 1
      }
    })

    assert.strictEqual(initResponse.statusCode, 200)
    assert.ok(initResponse.headers['mcp-session-id'])
    const sessionId = initResponse.headers['mcp-session-id'] as string

    // Make SSE request via GET
    const response = await app.inject({
      method: 'GET',
      url: '/mcp',
      headers: {
        accept: 'text/event-stream',
        'mcp-session-id': sessionId
      },
      payloadAsStream: true
    })

    response.stream().destroy() // Ensure we clean up the stream after test

    assert.strictEqual(response.statusCode, 200)
    assert.ok(response.headers['content-type']?.includes('text/event-stream'))

    // sessionId is already available from initResponse

    // Verify session exists in Redis
    const sessionExists = await redis.exists(`session:${sessionId}`)
    assert.strictEqual(sessionExists, 1)

    // Verify session has TTL
    const ttl = await redis.ttl(`session:${sessionId}`)
    assert.ok(ttl > 0)
  })

  testWithRedis('should handle message broadcasting across Redis instances', async (redis, t) => {
    const app1 = fastify()
    const app2 = fastify()
    t.after(() => app1.close())
    t.after(() => app2.close())

    await app1.register(mcpPlugin, {
      enableSSE: true,
      redis: {
        host: redis.options.host!,
        port: redis.options.port!,
        db: redis.options.db!
      }
    })

    await app2.register(mcpPlugin, {
      enableSSE: true,
      redis: {
        host: redis.options.host!,
        port: redis.options.port!,
        db: redis.options.db!
      }
    })

    // Create session on app1 via POST
    const initResponse1 = await app1.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'Content-Type': 'application/json',
        accept: 'application/json'
      },
      payload: {
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' }
        },
        id: 1
      }
    })

    const sessionId = initResponse1.headers['mcp-session-id'] as string
    assert.ok(sessionId)

    // Establish SSE connection on app1 via GET
    const sessionResponse = await app1.inject({
      method: 'GET',
      url: '/mcp',
      headers: {
        accept: 'text/event-stream',
        'mcp-session-id': sessionId
      },
      payloadAsStream: true
    })

    assert.strictEqual(sessionResponse.statusCode, 200)
    assert.ok(sessionResponse.headers['content-type']?.includes('text/event-stream'))

    // Send notification from app2 (should work across instances)
    const notification: JSONRPCMessage = {
      jsonrpc: '2.0',
      method: 'notifications/message',
      params: { message: 'Cross-instance notification' }
    }

    await app2.mcpBroadcastNotification(notification)

    for await (const chunk of sessionResponse.stream()) {
      const data = chunk.toString()
      if (data.includes('Cross-instance notification')) {
        // Verify the notification was received
        assert.ok(data.includes('Cross-instance notification'), 'Should receive cross-instance notification')
        break
      }
    }

    // Verify message was stored in session history
    const history = await redis.xrange(`session:${sessionId}:history`, '-', '+')
    assert.ok(history.length > 0)
  })

  testWithRedis('should handle session message sending with Redis', async (redis, t) => {
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

    // Create session via POST
    const initResponse = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'Content-Type': 'application/json',
        accept: 'application/json'
      },
      payload: {
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' }
        },
        id: 1
      }
    })

    const sessionId = initResponse.headers['mcp-session-id'] as string
    assert.ok(sessionId, 'Session ID should be present')

    // Establish SSE connection via GET
    const sessionResponse = await app.inject({
      method: 'GET',
      url: '/mcp',
      headers: {
        accept: 'text/event-stream',
        'mcp-session-id': sessionId
      },
      payloadAsStream: true
    })

    assert.strictEqual(sessionResponse.statusCode, 200)

    // Send message to session
    const message: JSONRPCMessage = {
      jsonrpc: '2.0',
      method: 'test-message',
      params: { data: 'test' },
      id: 2
    }

    const result: boolean = await app.mcpSendToSession(sessionId, message)
    assert.strictEqual(result, true)

    // Verify message was stored in session history
    for await (const chunk of sessionResponse.stream()) {
      const data = chunk.toString()
      if (data.includes('test-message')) {
        // Verify the message was received
        assert.ok(data.includes('test-message'))
        break
      }
    }
  })

  testWithRedis('should fallback to memory when Redis not configured', async (_, t) => {
    const app = fastify()
    t.after(() => app.close())

    await app.register(mcpPlugin, {
      enableSSE: true
      // No Redis configuration - should use memory backends
    })

    // Plugin should work normally with memory backends
    assert.ok(app.mcpAddTool)
    assert.ok(app.mcpBroadcastNotification)

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: {
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' }
        },
        id: 1
      }
    })

    assert.strictEqual(response.statusCode, 200)
    const result = JSON.parse(response.payload)
    assert.strictEqual(result.id, 1)
    assert.ok(result.result)
  })

  testWithRedis('should handle elicitation requests with Redis backend', async (redis, t) => {
    const app1 = fastify()
    const app2 = fastify()

    t.after(() => app1.close())
    t.after(() => app2.close())

    // Configure both apps with Redis
    const redisConfig = {
      host: redis.options.host!,
      port: redis.options.port!,
      db: redis.options.db!
    }

    await app1.register(mcpPlugin, {
      enableSSE: true,
      redis: redisConfig
    })

    await app2.register(mcpPlugin, {
      enableSSE: true,
      redis: redisConfig
    })

    // Create session via POST
    const initResponse = await app1.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'Content-Type': 'application/json',
        accept: 'application/json'
      },
      payload: {
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: { elicitation: {} },
          clientInfo: { name: 'test-client', version: '1.0.0' }
        },
        id: 1
      }
    })

    const sessionId = initResponse.headers['mcp-session-id'] as string
    assert.ok(sessionId, 'Session ID should be present')

    // Create SSE session on app1 via GET
    const sessionResponse = await app1.inject({
      method: 'GET',
      url: '/mcp',
      headers: {
        accept: 'text/event-stream',
        'mcp-session-id': sessionId
      },
      payloadAsStream: true
    })

    assert.strictEqual(sessionResponse.statusCode, 200)
    assert.ok(sessionResponse.headers['content-type']?.includes('text/event-stream'))

    // Give time for the session to be properly stored in Redis
    await new Promise(resolve => setTimeout(resolve, 50))

    // Verify mcpElicit decorator is available on both instances
    assert.ok(typeof app1.mcpElicit === 'function', 'app1 should have mcpElicit decorator')
    assert.ok(typeof app2.mcpElicit === 'function', 'app2 should have mcpElicit decorator')

    // Send elicitation request from app2 to session created on app1 (cross-instance)
    const elicitResult = await app2.mcpElicit(sessionId, 'Please enter your details', {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Your full name',
          minLength: 1
        },
        age: {
          type: 'integer',
          description: 'Your age',
          minimum: 0
        },
        category: {
          type: 'string',
          description: 'Your category',
          enum: ['student', 'professional', 'retired']
        }
      },
      required: ['name']
    }, 'test-elicit-123')

    assert.strictEqual(elicitResult, true, 'Elicitation request should succeed across Redis instances')

    // Give time for the message to propagate through Redis
    await new Promise(resolve => setTimeout(resolve, 100))

    // Verify the message was stored in Redis session history
    const history = await redis.xrange(`session:${sessionId}:history`, '-', '+')
    assert.ok(history.length > 0, 'Session history should contain messages')

    // Look for the elicitation request in the history
    const elicitMessage = history.find(([_, fields]) => {
      const messageField = fields.find((field, index) => index % 2 === 0 && field === 'message')
      if (messageField) {
        const messageIndex = fields.indexOf(messageField)
        const messageData = fields[messageIndex + 1]
        try {
          const message = JSON.parse(messageData)
          return message.method === 'elicitation/create' && message.id === 'test-elicit-123'
        } catch {
          return false
        }
      }
      return false
    })

    assert.ok(elicitMessage, 'Elicitation request should be stored in Redis session history')

    // Verify the elicitation message structure
    if (elicitMessage) {
      const messageField = elicitMessage[1].find((field, index) => index % 2 === 0 && field === 'message')
      if (messageField) {
        const messageIndex = elicitMessage[1].indexOf(messageField)
        const messageData = elicitMessage[1][messageIndex + 1]
        const message = JSON.parse(messageData)

        assert.strictEqual(message.jsonrpc, '2.0')
        assert.strictEqual(message.method, 'elicitation/create')
        assert.strictEqual(message.id, 'test-elicit-123')
        assert.strictEqual(message.params.message, 'Please enter your details')
        assert.ok(message.params.requestedSchema)
        assert.strictEqual(message.params.requestedSchema.type, 'object')
        assert.ok(message.params.requestedSchema.properties.name)
        assert.ok(message.params.requestedSchema.properties.age)
        assert.ok(message.params.requestedSchema.properties.category)
        assert.deepStrictEqual(message.params.requestedSchema.required, ['name'])
      }
    }
  })
})
