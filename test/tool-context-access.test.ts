import { test, describe } from 'node:test'
import type { TestContext } from 'node:test'
import Fastify from 'fastify'
import mcpPlugin from '../src/index.ts'
import type {
  JSONRPCRequest,
  JSONRPCResponse,
  CallToolResult
} from '../src/schema.ts'
import { JSONRPC_VERSION } from '../src/schema.ts'

describe('Tool Context Access', () => {
  describe('Request Object Access', () => {
    test('should pass Fastify request object to tool handler', async (t: TestContext) => {
      const app = Fastify()
      t.after(() => app.close())

      await app.register(mcpPlugin)
      await app.ready()

      let capturedRequest: any = null

      // Add a tool that needs access to the request
      app.mcpAddTool({
        name: 'request-inspector',
        description: 'Inspects the HTTP request',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      }, async (params, context) => {
        // This should fail initially since request isn't passed
        capturedRequest = context?.request
        return {
          content: [{
            type: 'text',
            text: `Request URL: ${context?.request?.url || 'undefined'}`
          }]
        }
      })

      const request: JSONRPCRequest = {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'tools/call',
        params: {
          name: 'request-inspector',
          arguments: {}
        }
      }

      const response = await app.inject({
        method: 'POST',
        url: '/mcp?test=true',
        payload: request,
        headers: {
          'user-agent': 'test-agent',
          'x-custom-header': 'test-value'
        }
      })

      t.assert.strictEqual(response.statusCode, 200)
      const body = response.json() as JSONRPCResponse
      const result = body.result as CallToolResult

      // The test should pass when we have access to request object
      t.assert.ok(capturedRequest, 'Request object should be passed to handler')
      t.assert.strictEqual(capturedRequest.url, '/mcp?test=true', 'Request URL should be accessible')
      t.assert.strictEqual(capturedRequest.headers['user-agent'], 'test-agent', 'Request headers should be accessible')
      t.assert.strictEqual(capturedRequest.headers['x-custom-header'], 'test-value', 'Custom headers should be accessible')
      
      // Check that the result contains the expected content
      t.assert.ok(result.content[0].text.includes('/mcp?test=true'), 'Result should contain request URL')
    })

    test('should provide access to request query parameters in tool handler', async (t: TestContext) => {
      const app = Fastify()
      t.after(() => app.close())

      await app.register(mcpPlugin)
      await app.ready()

      let capturedQuery: any = null

      app.mcpAddTool({
        name: 'query-inspector',
        description: 'Inspects query parameters',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      }, async (params, context) => {
        capturedQuery = context?.request?.query
        return {
          content: [{
            type: 'text',
            text: `Query params: ${JSON.stringify(context?.request?.query || {})}`
          }]
        }
      })

      const request: JSONRPCRequest = {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'tools/call',
        params: {
          name: 'query-inspector',
          arguments: {}
        }
      }

      const response = await app.inject({
        method: 'POST',
        url: '/mcp?filter=active&limit=10',
        payload: request
      })

      t.assert.strictEqual(response.statusCode, 200)
      t.assert.ok(capturedQuery, 'Query object should be accessible')
      t.assert.strictEqual(capturedQuery.filter, 'active', 'Query filter should be accessible')
      t.assert.strictEqual(capturedQuery.limit, '10', 'Query limit should be accessible')
    })
  })

  describe('Reply Object Access', () => {
    test('should pass Fastify reply object to tool handler', async (t: TestContext) => {
      const app = Fastify()
      t.after(() => app.close())

      await app.register(mcpPlugin)
      await app.ready()

      let capturedReply: any = null

      app.mcpAddTool({
        name: 'reply-inspector',
        description: 'Inspects the HTTP reply context',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      }, async (params, context) => {
        capturedReply = context?.reply
        
        // Test that we can set a custom header via reply
        if (context?.reply) {
          context.reply.header('x-tool-processed', 'true')
        }

        return {
          content: [{
            type: 'text',
            text: 'Reply object accessed'
          }]
        }
      })

      const request: JSONRPCRequest = {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'tools/call',
        params: {
          name: 'reply-inspector',
          arguments: {}
        }
      }

      const response = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload: request
      })

      t.assert.strictEqual(response.statusCode, 200)
      t.assert.ok(capturedReply, 'Reply object should be passed to handler')
      t.assert.strictEqual(response.headers['x-tool-processed'], 'true', 'Tool should be able to set response headers')
    })

    test('should allow tool to set custom response headers', async (t: TestContext) => {
      const app = Fastify()
      t.after(() => app.close())

      await app.register(mcpPlugin)
      await app.ready()

      app.mcpAddTool({
        name: 'header-setter',
        description: 'Sets custom response headers',
        inputSchema: {
          type: 'object',
          properties: {
            headerName: { type: 'string' },
            headerValue: { type: 'string' }
          },
          required: ['headerName', 'headerValue']
        }
      }, async (params, context) => {
        const { headerName, headerValue } = params

        if (context?.reply) {
          context.reply.header(headerName, headerValue)
        }

        return {
          content: [{
            type: 'text',
            text: `Header ${headerName} set to ${headerValue}`
          }]
        }
      })

      const request: JSONRPCRequest = {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'tools/call',
        params: {
          name: 'header-setter',
          arguments: {
            headerName: 'x-custom-response',
            headerValue: 'custom-value'
          }
        }
      }

      const response = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload: request
      })

      t.assert.strictEqual(response.statusCode, 200)
      t.assert.strictEqual(response.headers['x-custom-response'], 'custom-value', 'Tool should set custom response header')
    })
  })

  describe('Backward Compatibility', () => {
    test('should work with existing tool handlers that do not use request/reply', async (t: TestContext) => {
      const app = Fastify()
      t.after(() => app.close())

      await app.register(mcpPlugin)
      await app.ready()

      // Add a traditional tool handler without request/reply access
      app.mcpAddTool({
        name: 'traditional-tool',
        description: 'Traditional tool without context access',
        inputSchema: {
          type: 'object',
          properties: {
            message: { type: 'string' }
          },
          required: ['message']
        }
      }, async (params) => {
        // This handler doesn't use the context parameter at all
        return {
          content: [{
            type: 'text',
            text: `Echo: ${params.message}`
          }]
        }
      })

      const request: JSONRPCRequest = {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'tools/call',
        params: {
          name: 'traditional-tool',
          arguments: {
            message: 'Hello World'
          }
        }
      }

      const response = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload: request
      })

      t.assert.strictEqual(response.statusCode, 200)
      const body = response.json() as JSONRPCResponse
      const result = body.result as CallToolResult
      t.assert.strictEqual(result.content[0].text, 'Echo: Hello World', 'Traditional handler should still work')
    })

    test('should work with tool handlers that use only sessionId context', async (t: TestContext) => {
      const app = Fastify()
      t.after(() => app.close())

      await app.register(mcpPlugin)
      await app.ready()

      // Add a tool that only uses sessionId from context
      app.mcpAddTool({
        name: 'session-tool',
        description: 'Tool that only uses sessionId',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      }, async (params, context) => {
        return {
          content: [{
            type: 'text',
            text: `Session: ${context?.sessionId || 'undefined'}`
          }]
        }
      })

      const request: JSONRPCRequest = {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'tools/call',
        params: {
          name: 'session-tool',
          arguments: {}
        }
      }

      const response = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload: request,
        headers: {
          'mcp-session-id': 'test-session-123'
        }
      })

      t.assert.strictEqual(response.statusCode, 200)
      const body = response.json() as JSONRPCResponse
      const result = body.result as CallToolResult
      t.assert.ok(result.content[0].text.includes('test-session-123'), 'SessionId should still be accessible')
    })
  })

  describe('SSE Context Access', () => {
    test('should provide request/reply access in SSE mode', async (t: TestContext) => {
      const app = Fastify()
      t.after(() => app.close())

      await app.register(mcpPlugin, { enableSSE: true })
      await app.ready()

      let capturedRequest: any = null

      app.mcpAddTool({
        name: 'sse-tool',
        description: 'Tool for SSE testing',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      }, async (params, context) => {
        capturedRequest = context?.request
        return {
          content: [{
            type: 'text',
            text: `SSE URL: ${context?.request?.url || 'undefined'}`
          }]
        }
      })

      const request: JSONRPCRequest = {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'tools/call',
        params: {
          name: 'sse-tool',
          arguments: {}
        }
      }

      const response = await app.inject({
        method: 'POST',
        url: '/mcp?sse=test',
        payloadAsStream: true,
        payload: request,
        headers: {
          accept: 'text/event-stream'
        }
      })

      t.assert.strictEqual(response.statusCode, 200)
      t.assert.strictEqual(response.headers['content-type'], 'text/event-stream')
      
      // For SSE, we need to clean up the stream
      response.stream().destroy()
      
      // The request should have been captured during the tool execution
      t.assert.ok(capturedRequest, 'Request should be accessible in SSE mode')
      t.assert.ok(capturedRequest.url.includes('sse=test'), 'Request URL should be accessible in SSE mode')
    })
  })
})