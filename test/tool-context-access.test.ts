import { test, describe } from 'node:test'
import type { TestContext } from 'node:test'
import Fastify from 'fastify'
import mcpPlugin from '../src/index.ts'
import type {
  JSONRPCRequest,
  JSONRPCResponse,
  CallToolResult,
  ReadResourceResult,
  GetPromptResult
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
        // Request is now always passed
        capturedRequest = context.request
        return {
          content: [{
            type: 'text',
            text: `Request URL: ${context.request.url}`
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
      const textContent = result.content[0] as { type: 'text', text: string }
      t.assert.ok(textContent.text.includes('/mcp?test=true'), 'Result should contain request URL')
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
        capturedQuery = context.request.query
        return {
          content: [{
            type: 'text',
            text: `Query params: ${JSON.stringify(context.request.query || {})}`
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
        capturedReply = context.reply

        // Test that we can set a custom header via reply
        context.reply.header('x-tool-processed', 'true')

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

        context.reply.header(headerName, headerValue)

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
      const textContent = result.content[0] as { type: 'text', text: string }
      t.assert.strictEqual(textContent.text, 'Echo: Hello World', 'Traditional handler should still work')
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
            text: `Session: ${context.sessionId || 'undefined'}`
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
      const textContent = result.content[0] as { type: 'text', text: string }
      t.assert.ok(textContent.text.includes('test-session-123'), 'SessionId should still be accessible')
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
        capturedRequest = context.request
        return {
          content: [{
            type: 'text',
            text: `SSE URL: ${context.request.url}`
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

  describe('Resource Handler Context Access', () => {
    test('should pass Fastify request/reply context to resource handler', async (t: TestContext) => {
      const app = Fastify()
      t.after(() => app.close())

      await app.register(mcpPlugin)
      await app.ready()

      let capturedContext: any = null

      // Register a resource that captures the context
      app.mcpAddResource({
        uri: 'test://resource',
        name: 'Test Resource',
        description: 'Resource that captures HTTP context'
      }, async (uri, context) => {
        capturedContext = context

        const userAgent = context.request.headers['user-agent'] || 'unknown'
        const queryParam = context.request.query?.test || 'none'

        context.reply.header('x-resource-processed', 'true')

        return {
          contents: [{
            uri,
            text: `Resource processed by ${userAgent}, query: ${queryParam}`,
            mimeType: 'text/plain'
          }]
        }
      })

      const request: JSONRPCRequest = {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'resources/read',
        params: {
          uri: 'test://resource'
        }
      }

      const response = await app.inject({
        method: 'POST',
        url: '/mcp?test=resource',
        headers: {
          'user-agent': 'test-resource-agent',
          'x-custom-header': 'resource-value',
          'content-type': 'application/json'
        },
        payload: request
      })

      t.assert.strictEqual(response.statusCode, 200)
      t.assert.strictEqual(response.headers['x-resource-processed'], 'true')

      const body = response.json() as JSONRPCResponse
      const result = body.result as ReadResourceResult

      // Verify context was passed correctly
      t.assert.ok(capturedContext, 'Context should be passed to resource handler')
      t.assert.ok(capturedContext.request, 'Request object should be available')
      t.assert.ok(capturedContext.reply, 'Reply object should be available')
      t.assert.strictEqual(capturedContext.request.headers['user-agent'], 'test-resource-agent')
      t.assert.strictEqual(capturedContext.request.query.test, 'resource')

      // Verify result content
      const firstContent = result.contents[0]
      t.assert.ok('text' in firstContent && firstContent.text.includes('test-resource-agent'))
      t.assert.ok('text' in firstContent && firstContent.text.includes('query: resource'))
    })

    test('should work without context parameter in resource handler (backward compatibility)', async (t: TestContext) => {
      const app = Fastify()
      t.after(() => app.close())

      await app.register(mcpPlugin)
      await app.ready()

      // Register a resource handler that doesn't use context (legacy style)
      app.mcpAddResource({
        uri: 'test://legacy-resource',
        name: 'Legacy Resource',
        description: 'Resource without context parameter'
      }, async (uri) => {
        return {
          contents: [{
            uri,
            text: 'Legacy resource content',
            mimeType: 'text/plain'
          }]
        }
      })

      const request: JSONRPCRequest = {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'resources/read',
        params: {
          uri: 'test://legacy-resource'
        }
      }

      const response = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { 'content-type': 'application/json' },
        payload: request
      })

      t.assert.strictEqual(response.statusCode, 200)

      const body = response.json() as JSONRPCResponse
      const result = body.result as ReadResourceResult
      const firstContent = result.contents[0]
      t.assert.strictEqual('text' in firstContent ? firstContent.text : '', 'Legacy resource content')
    })
  })

  describe('Prompt Handler Context Access', () => {
    test('should pass Fastify request/reply context to prompt handler', async (t: TestContext) => {
      const app = Fastify()
      t.after(() => app.close())

      await app.register(mcpPlugin)
      await app.ready()

      let capturedContext: any = null

      // Register a prompt that captures the context
      app.mcpAddPrompt({
        name: 'context-prompt',
        description: 'Prompt that captures HTTP context',
        arguments: [{
          name: 'topic',
          description: 'Discussion topic',
          required: true
        }]
      }, async (_name, args, context) => {
        capturedContext = context

        const userAgent = context.request.headers['user-agent'] || 'unknown'
        const queryParam = context.request.query?.mode || 'default'

        context.reply.header('x-prompt-processed', 'true')

        return {
          messages: [{
            role: 'user',
            content: {
              type: 'text',
              text: `Discuss ${args.topic} (requested by ${userAgent} in ${queryParam} mode)`
            }
          }]
        }
      })

      const request: JSONRPCRequest = {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'prompts/get',
        params: {
          name: 'context-prompt',
          arguments: {
            topic: 'AI development'
          }
        }
      }

      const response = await app.inject({
        method: 'POST',
        url: '/mcp?mode=advanced',
        headers: {
          'user-agent': 'test-prompt-agent',
          'content-type': 'application/json'
        },
        payload: request
      })

      t.assert.strictEqual(response.statusCode, 200)
      t.assert.strictEqual(response.headers['x-prompt-processed'], 'true')

      const body = response.json() as JSONRPCResponse
      const result = body.result as GetPromptResult

      // Verify context was passed correctly
      t.assert.ok(capturedContext, 'Context should be passed to prompt handler')
      t.assert.ok(capturedContext.request, 'Request object should be available')
      t.assert.ok(capturedContext.reply, 'Reply object should be available')
      t.assert.strictEqual(capturedContext.request.headers['user-agent'], 'test-prompt-agent')
      t.assert.strictEqual(capturedContext.request.query.mode, 'advanced')

      // Verify result content
      t.assert.strictEqual(result.messages[0].content.type, 'text')
      if (result.messages[0].content.type === 'text') {
        t.assert.ok(result.messages[0].content.text.includes('test-prompt-agent'))
        t.assert.ok(result.messages[0].content.text.includes('advanced mode'))
      }
    })

    test('should work without context parameter in prompt handler (backward compatibility)', async (t: TestContext) => {
      const app = Fastify()
      t.after(() => app.close())

      await app.register(mcpPlugin)
      await app.ready()

      // Register a prompt handler that doesn't use context (legacy style)
      app.mcpAddPrompt({
        name: 'legacy-prompt',
        description: 'Prompt without context parameter',
        arguments: [{
          name: 'message',
          description: 'Message to include',
          required: true
        }]
      }, async (_name, args) => {
        return {
          messages: [{
            role: 'user',
            content: {
              type: 'text',
              text: `Legacy prompt: ${args.message}`
            }
          }]
        }
      })

      const request: JSONRPCRequest = {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'prompts/get',
        params: {
          name: 'legacy-prompt',
          arguments: {
            message: 'Hello World'
          }
        }
      }

      const response = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { 'content-type': 'application/json' },
        payload: request
      })

      t.assert.strictEqual(response.statusCode, 200)

      const body = response.json() as JSONRPCResponse
      const result = body.result as GetPromptResult
      t.assert.strictEqual(result.messages[0].content.type, 'text')
      if (result.messages[0].content.type === 'text') {
        t.assert.strictEqual(result.messages[0].content.text, 'Legacy prompt: Hello World')
      }
    })
  })
})
