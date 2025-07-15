import { describe } from 'node:test'
import assert from 'node:assert'
import fastify from 'fastify'
import mcpPlugin from '../src/index.ts'
import { testWithRedis } from './redis-test-utils.ts'
import type { JSONRPCMessage } from '../src/schema.ts'

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

    // Make SSE request
    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        accept: 'text/event-stream'
      },
      payloadAsStream: true,
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

    response.stream().destroy() // Ensure we clean up the stream after test

    assert.strictEqual(response.statusCode, 200)
    assert.ok(response.headers['content-type']?.includes('text/event-stream'))
    assert.ok(response.headers['mcp-session-id'])

    const sessionId = response.headers['mcp-session-id'] as string

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

    // Create session on app1
    const sessionResponse = await app1.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        accept: 'text/event-stream'
      },
      payloadAsStream: true,
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

    const sessionId = sessionResponse.headers['mcp-session-id'] as string
    assert.ok(sessionId)

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
        (t.assert.ok as (value: unknown, message?: string) => void)(data.includes('Cross-instance notification'), 'Should receive cross-instance notification')
        break
      }
    }

    // Verify message was stored in session history
    const history = await redis.xrange(`session:${sessionId}:history`, '-', '+')
    assert.ok(history.length > 0)
  })

  testWithRedis('should handle session message sending with Redis', async (redis, t) => {
    t.plan(3) // Expect two assertions

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

    // Create session
    const sessionResponse = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        accept: 'text/event-stream'
      },
      payloadAsStream: true,
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

    const sessionId = sessionResponse.headers['mcp-session-id'] as string
    (t.assert.ok as (value: unknown, message?: string) => void)(sessionId, 'Session ID should be present')

    // Send message to session
    const message: JSONRPCMessage = {
      jsonrpc: '2.0',
      method: 'test-message',
      params: { data: 'test' },
      id: 2
    }

    const result: boolean = await app.mcpSendToSession(sessionId, message);
    (t.assert.strictEqual as (actual: unknown, expected: unknown, message?: string) => void)(result, true, 'Message should be sent successfully')

    // Verify message was stored in session history
    for await (const chunk of sessionResponse.stream()) {
      const data = chunk.toString()
      if (data.includes('test-message')) {
        // Verify the message was received
        (t.assert.ok as (value: unknown, message?: string) => void)(data.includes('test-message'), 'Should receive test message')
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
})
