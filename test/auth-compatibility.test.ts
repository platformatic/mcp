import { test, describe } from 'node:test'
import type { TestContext } from 'node:test'
import Fastify from 'fastify'
import mcpPlugin from '../src/index.ts'
import type { JSONRPCRequest, InitializeResult } from '../src/schema.ts'
import { JSONRPC_VERSION, LATEST_PROTOCOL_VERSION } from '../src/schema.ts'

describe('Authorization Compatibility Tests', () => {
  test('should work without authorization config (backward compatibility)', async (t: TestContext) => {
    const app = Fastify({ logger: false })
    t.after(async () => await app.close())

    await app.register(mcpPlugin, {
      serverInfo: { name: 'test-server', version: '1.0.0' }
    })
    await app.ready()

    const request: JSONRPCRequest = {
      jsonrpc: JSONRPC_VERSION,
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' }
      }
    }

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: request
    })

    t.assert.strictEqual(response.statusCode, 200)
    
    const body = response.json() as InitializeResult
    t.assert.strictEqual(body.jsonrpc, JSONRPC_VERSION)
    t.assert.strictEqual(body.id, 1)
    t.assert.ok(body.result)
  })

  test('should work with authorization explicitly disabled', async (t: TestContext) => {
    const app = Fastify({ logger: false })
    t.after(async () => await app.close())

    await app.register(mcpPlugin, {
      serverInfo: { name: 'test-server', version: '1.0.0' },
      authorization: { enabled: false }
    })
    await app.ready()

    const request: JSONRPCRequest = {
      jsonrpc: JSONRPC_VERSION,
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' }
      }
    }

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: request
    })

    t.assert.strictEqual(response.statusCode, 200)
    
    const body = response.json() as InitializeResult
    t.assert.strictEqual(body.jsonrpc, JSONRPC_VERSION)
    t.assert.strictEqual(body.id, 1)
    t.assert.ok(body.result)
  })

  test('should not serve well-known endpoints when authorization disabled', async (t: TestContext) => {
    const app = Fastify({ logger: false })
    t.after(async () => await app.close())

    await app.register(mcpPlugin, {
      authorization: { enabled: false }
    })
    await app.ready()

    const response = await app.inject({
      method: 'GET',
      url: '/.well-known/oauth-protected-resource'
    })

    t.assert.strictEqual(response.statusCode, 404)
  })

  test('should work with SSE when authorization disabled', async (t: TestContext) => {
    const app = Fastify({ logger: false })
    t.after(async () => await app.close())

    await app.register(mcpPlugin, {
      enableSSE: true,
      authorization: { enabled: false }
    })
    await app.ready()

    const response = await app.inject({
      method: 'GET',
      url: '/mcp',
      headers: {
        accept: 'text/event-stream'
      }
    })

    t.assert.strictEqual(response.statusCode, 200)
    t.assert.strictEqual(response.headers['content-type'], 'text/event-stream')
  })

  test('should handle tool registration when authorization disabled', async (t: TestContext) => {
    const app = Fastify({ logger: false })
    t.after(async () => await app.close())

    await app.register(mcpPlugin, {
      authorization: { enabled: false }
    })

    // Register a test tool
    app.mcpAddTool({
      name: 'test-tool',
      description: 'A test tool',
      inputSchema: {
        type: 'object',
        properties: {
          input: { type: 'string' }
        }
      }
    }, async (params) => {
      return {
        content: [{
          type: 'text',
          text: `Tool called with: ${params.input}`
        }]
      }
    })

    await app.ready()

    const listToolsRequest: JSONRPCRequest = {
      jsonrpc: JSONRPC_VERSION,
      id: 1,
      method: 'tools/list',
      params: {}
    }

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: listToolsRequest
    })

    t.assert.strictEqual(response.statusCode, 200)
    
    const body = response.json()
    t.assert.strictEqual(body.jsonrpc, JSONRPC_VERSION)
    t.assert.ok(body.result.tools)
    t.assert.strictEqual(body.result.tools.length, 1)
    t.assert.strictEqual(body.result.tools[0].name, 'test-tool')
  })

  test('should handle resource registration when authorization disabled', async (t: TestContext) => {
    const app = Fastify({ logger: false })
    t.after(async () => await app.close())

    await app.register(mcpPlugin, {
      authorization: { enabled: false }
    })

    // Register a test resource
    app.mcpAddResource({
      uriPattern: 'test://resource/{id}',
      name: 'test-resource',
      description: 'A test resource'
    }, async (uri) => {
      return {
        contents: [{
          uri,
          mimeType: 'text/plain',
          text: `Resource content for ${uri}`
        }]
      }
    })

    await app.ready()

    const listResourcesRequest: JSONRPCRequest = {
      jsonrpc: JSONRPC_VERSION,
      id: 1,
      method: 'resources/list',
      params: {}
    }

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: listResourcesRequest
    })

    t.assert.strictEqual(response.statusCode, 200)
    
    const body = response.json()
    t.assert.strictEqual(body.jsonrpc, JSONRPC_VERSION)
    t.assert.ok(body.result.resources)
    t.assert.strictEqual(body.result.resources.length, 1)
    t.assert.strictEqual(body.result.resources[0].name, 'test-resource')
  })

  test('should handle all MCP methods when authorization disabled', async (t: TestContext) => {
    const app = Fastify({ logger: false })
    t.after(async () => await app.close())

    await app.register(mcpPlugin, {
      authorization: { enabled: false }
    })
    await app.ready()

    const testCases = [
      {
        method: 'initialize',
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' }
        }
      },
      {
        method: 'ping',
        params: {}
      },
      {
        method: 'tools/list',
        params: {}
      },
      {
        method: 'resources/list',
        params: {}
      },
      {
        method: 'prompts/list',
        params: {}
      }
    ]

    for (const testCase of testCases) {
      const request: JSONRPCRequest = {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: testCase.method,
        params: testCase.params
      }

      const response = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload: request
      })

      t.assert.strictEqual(response.statusCode, 200, `${testCase.method} should return 200`)
      
      const body = response.json()
      t.assert.strictEqual(body.jsonrpc, JSONRPC_VERSION, `${testCase.method} should return valid JSON-RPC`)
      t.assert.strictEqual(body.id, 1, `${testCase.method} should return correct ID`)
      t.assert.ok(body.result !== undefined, `${testCase.method} should return result`)
    }
  })

  test('should maintain session functionality when authorization disabled', async (t: TestContext) => {
    const app = Fastify({ logger: false })
    t.after(async () => await app.close())

    await app.register(mcpPlugin, {
      enableSSE: true,
      authorization: { enabled: false }
    })
    await app.ready()

    // Test that session-specific functionality still works
    const sessionId = 'test-session-123'
    
    const request: JSONRPCRequest = {
      jsonrpc: JSONRPC_VERSION,
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' }
      }
    }

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: request,
      headers: {
        'mcp-session-id': sessionId
      }
    })

    t.assert.strictEqual(response.statusCode, 200)
    
    const body = response.json()
    t.assert.strictEqual(body.jsonrpc, JSONRPC_VERSION)
    t.assert.ok(body.result)
  })
})