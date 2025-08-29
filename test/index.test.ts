import { test, describe } from 'node:test'
import type { TestContext } from 'node:test'
import Fastify from 'fastify'
import mcpPlugin from '../src/index.ts'
import type {
  JSONRPCRequest,
  JSONRPCResponse,
  JSONRPCError,
  JSONRPCNotification,
  InitializeResult,
  ListToolsResult,
  ListResourcesResult,
  ListPromptsResult
} from '../src/schema.ts'
import {
  JSONRPC_VERSION,
  LATEST_PROTOCOL_VERSION,
  METHOD_NOT_FOUND,
  INTERNAL_ERROR
} from '../src/schema.ts'

describe('MCP Fastify Plugin', () => {
  test('should register plugin successfully', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())

    await app.register(mcpPlugin)
    await app.ready()

    t.assert.ok(app.hasPlugin('@platformatic/mcp'))
  })

  test('should register plugin with custom options', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())

    await app.register(mcpPlugin, {
      serverInfo: { name: 'test-server', version: '2.0.0' },
      capabilities: { tools: { listChanged: true } },
      instructions: 'Test instructions'
    })
    await app.ready()

    t.assert.ok(app.hasPlugin('@platformatic/mcp'))
  })

  describe('MCP Protocol Handlers', () => {
    test('should handle initialize request', async (t: TestContext) => {
      const app = Fastify()
      t.after(() => app.close())

      await app.register(mcpPlugin, {
        serverInfo: { name: 'test-server', version: '1.0.0' },
        instructions: 'Test server for MCP'
      })
      await app.ready()

      const request: JSONRPCRequest = {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: { roots: {} },
          clientInfo: { name: 'test-client', version: '1.0.0' }
        }
      }

      const response = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload: request
      })

      t.assert.strictEqual(response.statusCode, 200)
      const body = response.json() as JSONRPCResponse
      t.assert.strictEqual(body.jsonrpc, JSONRPC_VERSION)
      t.assert.strictEqual(body.id, 1)

      const result = body.result as InitializeResult
      t.assert.strictEqual(result.protocolVersion, LATEST_PROTOCOL_VERSION)
      t.assert.strictEqual(result.serverInfo.name, 'test-server')
      t.assert.strictEqual(result.serverInfo.version, '1.0.0')
      t.assert.strictEqual(result.instructions, 'Test server for MCP')
      t.assert.ok(result.capabilities)
    })

    test('should handle ping request', async (t: TestContext) => {
      const app = Fastify()
      t.after(() => app.close())

      await app.register(mcpPlugin)
      await app.ready()

      const request: JSONRPCRequest = {
        jsonrpc: JSONRPC_VERSION,
        id: 2,
        method: 'ping'
      }

      const response = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload: request
      })

      t.assert.strictEqual(response.statusCode, 200)
      const body = response.json() as JSONRPCResponse
      t.assert.strictEqual(body.jsonrpc, JSONRPC_VERSION)
      t.assert.strictEqual(body.id, 2)
      t.assert.deepStrictEqual(body.result, {})
    })

    test('should handle tools/list request', async (t: TestContext) => {
      const app = Fastify()
      t.after(() => app.close())

      await app.register(mcpPlugin)
      await app.ready()

      const request: JSONRPCRequest = {
        jsonrpc: JSONRPC_VERSION,
        id: 3,
        method: 'tools/list'
      }

      const response = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload: request
      })

      t.assert.strictEqual(response.statusCode, 200)
      const body = response.json() as JSONRPCResponse
      const result = body.result as ListToolsResult
      t.assert.ok(Array.isArray(result.tools))
      t.assert.strictEqual(result.tools.length, 0)
    })

    test('should handle resources/list request', async (t: TestContext) => {
      const app = Fastify()
      t.after(() => app.close())

      await app.register(mcpPlugin)
      await app.ready()

      const request: JSONRPCRequest = {
        jsonrpc: JSONRPC_VERSION,
        id: 4,
        method: 'resources/list'
      }

      const response = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload: request
      })

      t.assert.strictEqual(response.statusCode, 200)
      const body = response.json() as JSONRPCResponse
      const result = body.result as ListResourcesResult
      t.assert.ok(Array.isArray(result.resources))
      t.assert.strictEqual(result.resources.length, 0)
    })

    test('should handle prompts/list request', async (t: TestContext) => {
      const app = Fastify()
      t.after(() => app.close())

      await app.register(mcpPlugin)
      await app.ready()

      const request: JSONRPCRequest = {
        jsonrpc: JSONRPC_VERSION,
        id: 5,
        method: 'prompts/list'
      }

      const response = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload: request
      })

      t.assert.strictEqual(response.statusCode, 200)
      const body = response.json() as JSONRPCResponse
      const result = body.result as ListPromptsResult
      t.assert.ok(Array.isArray(result.prompts))
      t.assert.strictEqual(result.prompts.length, 0)
    })

    test('should handle tools/call request for non-existent tool', async (t: TestContext) => {
      const app = Fastify()
      t.after(() => app.close())

      await app.register(mcpPlugin)
      await app.ready()

      const request: JSONRPCRequest = {
        jsonrpc: JSONRPC_VERSION,
        id: 6,
        method: 'tools/call',
        params: { name: 'test-tool', arguments: { arg1: 'value1' } }
      }

      const response = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload: request
      })

      t.assert.strictEqual(response.statusCode, 200)
      const body = response.json() as JSONRPCError
      t.assert.strictEqual(body.jsonrpc, JSONRPC_VERSION)
      t.assert.strictEqual(body.id, 6)
      t.assert.strictEqual(body.error.code, METHOD_NOT_FOUND)
      t.assert.ok(body.error.message.includes('test-tool'))
    })

    test('should handle resources/read request for non-existent resource', async (t: TestContext) => {
      const app = Fastify()
      t.after(() => app.close())

      await app.register(mcpPlugin)
      await app.ready()

      const request: JSONRPCRequest = {
        jsonrpc: JSONRPC_VERSION,
        id: 7,
        method: 'resources/read',
        params: { uri: 'file://test.txt' }
      }

      const response = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload: request
      })

      t.assert.strictEqual(response.statusCode, 200)
      const body = response.json() as JSONRPCError
      t.assert.strictEqual(body.jsonrpc, JSONRPC_VERSION)
      t.assert.strictEqual(body.id, 7)
      t.assert.strictEqual(body.error.code, METHOD_NOT_FOUND)
      t.assert.ok(body.error.message.includes('file://test.txt'))
    })

    test('should handle prompts/get request for non-existent prompt', async (t: TestContext) => {
      const app = Fastify()
      t.after(() => app.close())

      await app.register(mcpPlugin)
      await app.ready()

      const request: JSONRPCRequest = {
        jsonrpc: JSONRPC_VERSION,
        id: 8,
        method: 'prompts/get',
        params: { name: 'test-prompt' }
      }

      const response = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload: request
      })

      t.assert.strictEqual(response.statusCode, 200)
      const body = response.json() as JSONRPCError
      t.assert.strictEqual(body.jsonrpc, JSONRPC_VERSION)
      t.assert.strictEqual(body.id, 8)
      t.assert.strictEqual(body.error.code, METHOD_NOT_FOUND)
      t.assert.ok(body.error.message.includes('test-prompt'))
    })

    test('should return method not found for unknown method', async (t: TestContext) => {
      const app = Fastify()
      t.after(() => app.close())

      await app.register(mcpPlugin)
      await app.ready()

      const request: JSONRPCRequest = {
        jsonrpc: JSONRPC_VERSION,
        id: 9,
        method: 'unknown/method'
      }

      const response = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload: request
      })

      t.assert.strictEqual(response.statusCode, 200)
      const body = response.json() as JSONRPCError
      t.assert.strictEqual(body.jsonrpc, JSONRPC_VERSION)
      t.assert.strictEqual(body.id, 9)
      t.assert.strictEqual(body.error.code, METHOD_NOT_FOUND)
      t.assert.ok(body.error.message.includes('unknown/method'))
    })

    test('should handle notifications without response', async (t: TestContext) => {
      const app = Fastify()
      t.after(() => app.close())

      await app.register(mcpPlugin)
      await app.ready()

      const notification: JSONRPCNotification = {
        jsonrpc: JSONRPC_VERSION,
        method: 'notifications/initialized'
      }

      const response = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload: notification
      })

      t.assert.strictEqual(response.statusCode, 204)
    })

    test('should handle cancelled notification', async (t: TestContext) => {
      const app = Fastify()
      t.after(() => app.close())

      await app.register(mcpPlugin)
      await app.ready()

      const notification: JSONRPCNotification = {
        jsonrpc: JSONRPC_VERSION,
        method: 'notifications/cancelled',
        params: { requestId: 123, reason: 'User cancelled' }
      }

      const response = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload: notification
      })

      t.assert.strictEqual(response.statusCode, 204)
    })

    test('should handle invalid JSON-RPC message', async (t: TestContext) => {
      const app = Fastify()
      t.after(() => app.close())

      await app.register(mcpPlugin)
      await app.ready()

      const invalidMessage = { invalid: 'message' }

      const response = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload: invalidMessage
      })

      t.assert.strictEqual(response.statusCode, 500)
      const body = response.json() as JSONRPCError
      t.assert.strictEqual(body.jsonrpc, JSONRPC_VERSION)
      t.assert.strictEqual(body.error.code, INTERNAL_ERROR)
    })
  })

  describe('SSE Support', () => {
    test('should handle POST request with SSE support', async (t: TestContext) => {
      const app = Fastify()
      t.after(() => app.close())

      await app.register(mcpPlugin, { enableSSE: true })
      await app.ready()

      const request: JSONRPCRequest = {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'ping'
      }

      const response = await app.inject({
        method: 'POST',
        url: '/mcp',
        payloadAsStream: true,
        payload: request,
        headers: {
          accept: 'application/json, text/event-stream'
        }
      })

      // Critical: Destroy stream immediately after creation, before reading
      // This pattern works in the Redis integration tests
      response.stream().destroy()

      t.assert.strictEqual(response.statusCode, 200)
      t.assert.strictEqual(response.headers['content-type'], 'text/event-stream')
      t.assert.ok(response.headers['mcp-session-id'])

      // Note: We can't test payload content since we destroyed the stream,
      // but we can verify the SSE setup worked correctly based on headers
    })

    test('should return 405 for GET request when SSE is disabled', async (t: TestContext) => {
      const app = Fastify()
      t.after(() => app.close())

      await app.register(mcpPlugin, { enableSSE: false })
      await app.ready()

      const response = await app.inject({
        method: 'GET',
        url: '/mcp',
        headers: {
          accept: 'text/event-stream'
        }
      })

      t.assert.strictEqual(response.statusCode, 405)
    })

    test('should return 405 for GET request without SSE support', async (t: TestContext) => {
      const app = Fastify()
      t.after(() => app.close())

      await app.register(mcpPlugin, { enableSSE: true })
      await app.ready()

      const response = await app.inject({
        method: 'GET',
        url: '/mcp',
        headers: {
          accept: 'application/json'
        }
      })

      t.assert.strictEqual(response.statusCode, 405)
    })

    test('should handle regular JSON response when SSE not requested', async (t: TestContext) => {
      const app = Fastify()
      t.after(() => app.close())

      await app.register(mcpPlugin, { enableSSE: true })
      await app.ready()

      const request: JSONRPCRequest = {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'ping'
      }

      const response = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload: request,
        headers: {
          accept: 'application/json'
        }
      })

      t.assert.strictEqual(response.statusCode, 200)
      t.assert.strictEqual(response.headers['content-type'], 'application/json; charset=utf-8')
      const body = response.json() as JSONRPCResponse
      t.assert.strictEqual(body.jsonrpc, JSONRPC_VERSION)
      t.assert.strictEqual(body.id, 1)
    })

    test('should provide session management through interfaces', async (t: TestContext) => {
      const app = Fastify()
      t.after(() => app.close())

      await app.register(mcpPlugin, { enableSSE: true })
      await app.ready()

      // Session management is now internal, verify SSE endpoints exist
      t.assert.ok(typeof app.mcpBroadcastNotification === 'function')
      t.assert.ok(typeof app.mcpSendToSession === 'function')
    })

    test('should provide notification broadcasting decorators', async (t: TestContext) => {
      const app = Fastify()
      t.after(() => app.close())

      await app.register(mcpPlugin, { enableSSE: true })
      await app.ready()

      t.assert.ok(typeof app.mcpBroadcastNotification === 'function')
      t.assert.ok(typeof app.mcpSendToSession === 'function')

      // Test that they don't throw when called with no sessions
      await app.mcpBroadcastNotification({
        jsonrpc: JSONRPC_VERSION,
        method: 'notifications/message',
        params: { text: 'test' }
      })

      const result = await app.mcpSendToSession('nonexistent', {
        jsonrpc: JSONRPC_VERSION,
        method: 'notifications/message',
        params: { text: 'test' }
      })
      t.assert.strictEqual(result, false)
    })
  })

  describe('Plugin Decorators', () => {
    test('should provide mcpAddTool decorator', async (t: TestContext) => {
      const app = Fastify()
      t.after(() => app.close())

      await app.register(mcpPlugin)
      await app.ready()

      t.assert.ok(typeof app.mcpAddTool === 'function')

      const tool = {
        name: 'test-tool',
        description: 'A test tool',
        inputSchema: { type: 'object', properties: {} }
      }

      app.mcpAddTool(tool)

      const request: JSONRPCRequest = {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'tools/list'
      }

      const response = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload: request
      })

      const body = response.json() as JSONRPCResponse
      const result = body.result as ListToolsResult
      t.assert.strictEqual(result.tools.length, 1)
      t.assert.strictEqual(result.tools[0].name, 'test-tool')
    })

    test('should provide mcpAddResource decorator', async (t: TestContext) => {
      const app = Fastify()
      t.after(() => app.close())

      await app.register(mcpPlugin)
      await app.ready()

      t.assert.ok(typeof app.mcpAddResource === 'function')

      const resource = {
        uri: 'file://test.txt',
        name: 'Test Resource',
        description: 'A test resource'
      }

      app.mcpAddResource(resource)

      const request: JSONRPCRequest = {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'resources/list'
      }

      const response = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload: request
      })

      const body = response.json() as JSONRPCResponse
      const result = body.result as ListResourcesResult
      t.assert.strictEqual(result.resources.length, 1)
      t.assert.strictEqual(result.resources[0].name, 'Test Resource')
    })

    test('should provide mcpAddPrompt decorator', async (t: TestContext) => {
      const app = Fastify()
      t.after(() => app.close())

      await app.register(mcpPlugin)
      await app.ready()

      t.assert.ok(typeof app.mcpAddPrompt === 'function')

      const prompt = {
        name: 'test-prompt',
        description: 'A test prompt'
      }

      app.mcpAddPrompt(prompt)

      const request: JSONRPCRequest = {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'prompts/list'
      }

      const response = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload: request
      })

      const body = response.json() as JSONRPCResponse
      const result = body.result as ListPromptsResult
      t.assert.strictEqual(result.prompts.length, 1)
      t.assert.strictEqual(result.prompts[0].name, 'test-prompt')
    })
  })

  describe('Top-Level Exports', () => {
    test('should export stdio transport functions', async (t: TestContext) => {
      const { runStdioServer, createStdioTransport, StdioTransport } = await import('../src/index.ts')

      t.assert.ok(typeof runStdioServer === 'function', 'runStdioServer should be exported as a function')
      t.assert.ok(typeof createStdioTransport === 'function', 'createStdioTransport should be exported as a function')
      t.assert.ok(typeof StdioTransport === 'function', 'StdioTransport should be exported as a class/function')
    })

    test('should export plugin types', async (t: TestContext) => {
      // Test that TypeScript types are properly exported by importing them
      const module = await import('../src/index.ts')

      // We can't test types directly at runtime, but we can verify the module exports exist
      t.assert.ok(module.default, 'Default export (mcpPlugin) should exist')
      t.assert.ok(typeof module.default === 'function', 'Default export should be a function')
    })

    test('should export MCP protocol types', async (t: TestContext) => {
      // Test that we can import types from the main module
      const module = await import('../src/index.ts')

      // Verify that the main plugin export exists and is functional
      t.assert.ok(module.default, 'Default export should exist')
      t.assert.ok(typeof module.default === 'function', 'Default export should be a function')

      // Verify stdio exports are available
      t.assert.ok(module.runStdioServer, 'runStdioServer should be exported')
      t.assert.ok(module.createStdioTransport, 'createStdioTransport should be exported')
      t.assert.ok(module.StdioTransport, 'StdioTransport should be exported')
    })

    test('should allow importing with unified syntax', async (t: TestContext) => {
      // Test the new unified import syntax that was added in the refactor
      const { default: mcpPlugin, runStdioServer, createStdioTransport, StdioTransport } = await import('../src/index.ts')

      t.assert.ok(typeof mcpPlugin === 'function', 'Default export should be a function')
      t.assert.ok(typeof runStdioServer === 'function', 'runStdioServer should be exported')
      t.assert.ok(typeof createStdioTransport === 'function', 'createStdioTransport should be exported')
      t.assert.ok(typeof StdioTransport === 'function', 'StdioTransport should be exported')
    })

    test('should export mcpPlugin as a named export', async (t: TestContext) => {
      // Test that mcpPlugin is available as a named export in addition to default export
      const { mcpPlugin, default: defaultExport } = await import('../src/index.ts')

      t.assert.ok(typeof mcpPlugin === 'function', 'mcpPlugin should be exported as a named function')
      t.assert.ok(typeof defaultExport === 'function', 'Default export should be a function')
      t.assert.strictEqual(mcpPlugin, defaultExport, 'Named export should be the same as default export')
    })
  })
})
