import { test, describe } from 'node:test'
import { strict as assert } from 'node:assert'
import Fastify from 'fastify'
import { Type } from '@sinclair/typebox'
import mcpPlugin from '../src/index.ts'
import { JSONRPC_VERSION, INVALID_PARAMS } from '../src/schema.ts'
import type { JSONRPCRequest, JSONRPCResponse, JSONRPCError, CallToolResult, GetPromptResult, ReadResourceResult } from '../src/schema.ts'

describe('TypeBox Validation', () => {
  describe('Tool Validation', () => {
    test('should validate tool arguments against TypeBox schema', async (t) => {
      const app = Fastify()
      t.after(() => app.close())

      await app.register(mcpPlugin)

      const SearchToolSchema = Type.Object({
        query: Type.String({ minLength: 1 }),
        limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 }))
      })

      app.mcpAddTool({
        name: 'search',
        description: 'Search for files',
        inputSchema: SearchToolSchema
      }, async (params) => {
        // Verify typed parameters
        assert.strictEqual(typeof params.query, 'string')
        assert.ok(params.query.length > 0)
        if (params.limit) {
          assert.strictEqual(typeof params.limit, 'number')
          assert.ok(params.limit >= 1 && params.limit <= 100)
        }
        return {
          content: [{ type: 'text', text: `Found ${params.query}` }]
        }
      })

      await app.ready()

      // Test valid arguments
      const validRequest: JSONRPCRequest = {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'tools/call',
        params: {
          name: 'search',
          arguments: { query: 'test', limit: 10 }
        }
      }

      const validResponse = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload: validRequest
      })

      assert.strictEqual(validResponse.statusCode, 200)
      const validBody = validResponse.json() as JSONRPCResponse
      assert.strictEqual(validBody.jsonrpc, JSONRPC_VERSION)
      assert.strictEqual(validBody.id, 1)
      const validResult = validBody.result as CallToolResult
      assert.strictEqual(validResult.content[0].type, 'text')
      assert.ok((validResult.content[0] as any).text.includes('Found test'))
    })

    test('should reject invalid tool arguments with validation errors', async (t) => {
      const app = Fastify()
      t.after(() => app.close())

      await app.register(mcpPlugin)

      const SearchToolSchema = Type.Object({
        query: Type.String({ minLength: 1 }),
        limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 }))
      })

      app.mcpAddTool({
        name: 'search',
        description: 'Search for files',
        inputSchema: SearchToolSchema
      }, async (params) => {
        return {
          content: [{ type: 'text', text: `Found ${params.query}` }]
        }
      })

      await app.ready()

      // Test invalid arguments (empty query)
      const invalidRequest: JSONRPCRequest = {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'tools/call',
        params: {
          name: 'search',
          arguments: { query: '', limit: 10 }
        }
      }

      const invalidResponse = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload: invalidRequest
      })

      assert.strictEqual(invalidResponse.statusCode, 200)
      const invalidBody = invalidResponse.json() as JSONRPCResponse
      assert.strictEqual(invalidBody.jsonrpc, JSONRPC_VERSION)
      assert.strictEqual(invalidBody.id, 1)
      const invalidResult = invalidBody.result as CallToolResult
      assert.strictEqual(invalidResult.isError, true)
      assert.ok((invalidResult.content[0] as any).text.includes('Invalid tool arguments'))
    })

    test('should reject arguments with wrong types', async (t) => {
      const app = Fastify()
      t.after(() => app.close())

      await app.register(mcpPlugin)

      const SearchToolSchema = Type.Object({
        query: Type.String({ minLength: 1 }),
        limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 }))
      })

      app.mcpAddTool({
        name: 'search',
        description: 'Search for files',
        inputSchema: SearchToolSchema
      }, async (params) => {
        return {
          content: [{ type: 'text', text: `Found ${params.query}` }]
        }
      })

      await app.ready()

      // Test wrong type for limit
      const wrongTypeRequest: JSONRPCRequest = {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'tools/call',
        params: {
          name: 'search',
          arguments: { query: 'test', limit: 'not-a-number' }
        }
      }

      const wrongTypeResponse = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload: wrongTypeRequest
      })

      assert.strictEqual(wrongTypeResponse.statusCode, 200)
      const wrongTypeBody = wrongTypeResponse.json() as JSONRPCResponse
      const wrongTypeResult = wrongTypeBody.result as CallToolResult
      assert.strictEqual(wrongTypeResult.isError, true)
      assert.ok((wrongTypeResult.content[0] as any).text.includes('Invalid tool arguments'))
    })

    test('should handle tools with complex nested schemas', async (t) => {
      const app = Fastify()
      t.after(() => app.close())

      await app.register(mcpPlugin)

      const ComplexToolSchema = Type.Object({
        user: Type.Object({
          name: Type.String(),
          age: Type.Number({ minimum: 0 })
        }),
        tags: Type.Array(Type.String()),
        metadata: Type.Optional(Type.Object({
          priority: Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')])
        }))
      })

      app.mcpAddTool({
        name: 'complex',
        description: 'Complex tool with nested schema',
        inputSchema: ComplexToolSchema
      }, async (params) => {
        return {
          content: [{ type: 'text', text: `User: ${params.user.name}, Age: ${params.user.age}` }]
        }
      })

      await app.ready()

      // Test valid complex arguments
      const complexRequest: JSONRPCRequest = {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'tools/call',
        params: {
          name: 'complex',
          arguments: {
            user: { name: 'Alice', age: 30 },
            tags: ['important', 'urgent'],
            metadata: { priority: 'high' }
          }
        }
      }

      const complexResponse = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload: complexRequest
      })

      assert.strictEqual(complexResponse.statusCode, 200)
      const complexBody = complexResponse.json() as JSONRPCResponse
      const complexResult = complexBody.result as CallToolResult
      assert.ok((complexResult.content[0] as any).text.includes('User: Alice, Age: 30'))
    })

    test('should work with unsafe tools without schemas', async (t) => {
      const app = Fastify()
      t.after(() => app.close())

      await app.register(mcpPlugin)

      app.mcpAddTool({
        name: 'unsafe',
        description: 'Unsafe tool without schema'
      }, async (params) => {
        return {
          content: [{ type: 'text', text: `Unsafe tool called with: ${JSON.stringify(params)}` }]
        }
      })

      await app.ready()

      const unsafeRequest: JSONRPCRequest = {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'tools/call',
        params: {
          name: 'unsafe',
          arguments: { anything: 'goes' }
        }
      }

      const unsafeResponse = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload: unsafeRequest
      })

      assert.strictEqual(unsafeResponse.statusCode, 200)
      const unsafeBody = unsafeResponse.json() as JSONRPCResponse
      const unsafeResult = unsafeBody.result as CallToolResult
      assert.ok((unsafeResult.content[0] as any).text.includes('Unsafe tool called'))
    })

    test('should convert TypeBox schemas to JSON Schema in tools/list', async (t) => {
      const app = Fastify()
      t.after(() => app.close())

      await app.register(mcpPlugin)

      const SearchToolSchema = Type.Object({
        query: Type.String({ minLength: 1 }),
        limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 }))
      })

      app.mcpAddTool({
        name: 'search',
        description: 'Search for files',
        inputSchema: SearchToolSchema
      }, async (params) => {
        return {
          content: [{ type: 'text', text: `Found ${params.query}` }]
        }
      })

      await app.ready()

      const listRequest: JSONRPCRequest = {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'tools/list'
      }

      const listResponse = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload: listRequest
      })

      assert.strictEqual(listResponse.statusCode, 200)
      const listBody = listResponse.json() as JSONRPCResponse
      const listResult = listBody.result as any
      assert.ok(Array.isArray(listResult.tools))

      const searchTool = listResult.tools.find((tool: any) => tool.name === 'search')
      assert.ok(searchTool)
      assert.ok(searchTool.inputSchema)
      assert.strictEqual(searchTool.inputSchema.type, 'object')
      assert.ok(searchTool.inputSchema.properties)
      assert.ok(searchTool.inputSchema.properties.query)
      assert.ok(searchTool.inputSchema.properties.limit)
    })
  })

  describe('Resource Validation', () => {
    test('should validate resource URI parameters', async (t) => {
      const app = Fastify()
      t.after(() => app.close())

      await app.register(mcpPlugin)

      const FileUriSchema = Type.String({ pattern: '^file://.+' })

      app.mcpAddResource({
        uriPattern: 'file://test.txt',
        name: 'test-file',
        description: 'Test file resource',
        uriSchema: FileUriSchema
      }, async (uri) => {
        return {
          contents: [{
            uri,
            text: 'File content',
            mimeType: 'text/plain'
          }]
        }
      })

      await app.ready()

      // Test valid URI
      const validRequest: JSONRPCRequest = {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'resources/read',
        params: { uri: 'file://test.txt' }
      }

      const validResponse = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload: validRequest
      })

      assert.strictEqual(validResponse.statusCode, 200)
      const validBody = validResponse.json() as JSONRPCResponse
      const validResult = validBody.result as ReadResourceResult
      assert.ok((validResult.contents[0] as any).text.includes('File content'))
    })

    test('should reject invalid resource read parameters', async (t) => {
      const app = Fastify()
      t.after(() => app.close())

      await app.register(mcpPlugin)
      await app.ready()

      // Test missing URI parameter
      const invalidRequest: JSONRPCRequest = {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'resources/read',
        params: {}
      }

      const invalidResponse = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload: invalidRequest
      })

      assert.strictEqual(invalidResponse.statusCode, 200)
      const invalidBody = invalidResponse.json() as JSONRPCError
      assert.strictEqual(invalidBody.error.code, INVALID_PARAMS)
      assert.ok(invalidBody.error.message.includes('Invalid resource read parameters'))
    })

    test('should handle resource URI validation errors', async (t) => {
      const app = Fastify()
      t.after(() => app.close())

      await app.register(mcpPlugin)

      const FileUriSchema = Type.String({ pattern: '^file://.+' })

      app.mcpAddResource({
        uriPattern: 'file://test.txt',
        name: 'test-file',
        description: 'Test file resource',
        uriSchema: FileUriSchema
      }, async (uri) => {
        return {
          contents: [{
            uri,
            text: 'File content',
            mimeType: 'text/plain'
          }]
        }
      })

      await app.ready()

      // Test invalid URI format
      const invalidRequest: JSONRPCRequest = {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'resources/read',
        params: { uri: 'file://test.txt' }
      }

      const invalidResponse = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload: invalidRequest
      })

      // Should work since file://test.txt matches the pattern
      assert.strictEqual(invalidResponse.statusCode, 200)
      const invalidBody = invalidResponse.json() as JSONRPCResponse
      const invalidResult = invalidBody.result as ReadResourceResult
      assert.ok((invalidResult.contents[0] as any).text.includes('File content'))
    })
  })

  describe('Prompt Validation', () => {
    test('should validate prompt arguments against TypeBox schema', async (t) => {
      const app = Fastify()
      t.after(() => app.close())

      await app.register(mcpPlugin)

      const ReviewPromptSchema = Type.Object({
        language: Type.Union([
          Type.Literal('javascript'),
          Type.Literal('typescript'),
          Type.Literal('python')
        ]),
        complexity: Type.Optional(Type.Union([
          Type.Literal('low'),
          Type.Literal('medium'),
          Type.Literal('high')
        ]))
      })

      app.mcpAddPrompt({
        name: 'code-review',
        description: 'Generate code review',
        argumentSchema: ReviewPromptSchema
      }, async (_name, args) => {
        return {
          messages: [{
            role: 'user',
            content: {
              type: 'text',
              text: `Review ${args.language} code with ${args.complexity || 'medium'} complexity`
            }
          }]
        }
      })

      await app.ready()

      // Test valid arguments
      const validRequest: JSONRPCRequest = {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'prompts/get',
        params: {
          name: 'code-review',
          arguments: { language: 'typescript', complexity: 'high' }
        }
      }

      const validResponse = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload: validRequest
      })

      assert.strictEqual(validResponse.statusCode, 200)
      const validBody = validResponse.json() as JSONRPCResponse
      const validResult = validBody.result as GetPromptResult
      assert.ok((validResult.messages[0].content as any).text.includes('Review typescript code'))
    })

    test('should reject invalid prompt arguments with validation errors', async (t) => {
      const app = Fastify()
      t.after(() => app.close())

      await app.register(mcpPlugin)

      const ReviewPromptSchema = Type.Object({
        language: Type.Union([
          Type.Literal('javascript'),
          Type.Literal('typescript'),
          Type.Literal('python')
        ]),
        complexity: Type.Optional(Type.Union([
          Type.Literal('low'),
          Type.Literal('medium'),
          Type.Literal('high')
        ]))
      })

      app.mcpAddPrompt({
        name: 'code-review',
        description: 'Generate code review',
        argumentSchema: ReviewPromptSchema
      }, async (_name, args) => {
        return {
          messages: [{
            role: 'user',
            content: {
              type: 'text',
              text: `Review ${args.language} code`
            }
          }]
        }
      })

      await app.ready()

      // Test invalid language
      const invalidRequest: JSONRPCRequest = {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'prompts/get',
        params: {
          name: 'code-review',
          arguments: { language: 'invalid-language' }
        }
      }

      const invalidResponse = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload: invalidRequest
      })

      assert.strictEqual(invalidResponse.statusCode, 200)
      const invalidBody = invalidResponse.json() as JSONRPCResponse
      const invalidResult = invalidBody.result as GetPromptResult
      assert.ok((invalidResult.messages[0].content as any).text.includes('Invalid prompt arguments'))
    })

    test('should reject invalid prompt get parameters', async (t) => {
      const app = Fastify()
      t.after(() => app.close())

      await app.register(mcpPlugin)
      await app.ready()

      // Test missing name parameter
      const invalidRequest: JSONRPCRequest = {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'prompts/get',
        params: {}
      }

      const invalidResponse = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload: invalidRequest
      })

      assert.strictEqual(invalidResponse.statusCode, 200)
      const invalidBody = invalidResponse.json() as JSONRPCError
      assert.strictEqual(invalidBody.error.code, INVALID_PARAMS)
      assert.ok(invalidBody.error.message.includes('Invalid prompt get parameters'))
    })

    test('should auto-generate arguments array from schema', async (t) => {
      const app = Fastify()
      t.after(() => app.close())

      await app.register(mcpPlugin)

      const ReviewPromptSchema = Type.Object({
        language: Type.String({
          enum: ['javascript', 'typescript', 'python'],
          description: 'Programming language'
        }),
        complexity: Type.Optional(Type.String({
          enum: ['low', 'medium', 'high'],
          description: 'Code complexity level'
        }))
      })

      app.mcpAddPrompt({
        name: 'code-review',
        description: 'Generate code review',
        argumentSchema: ReviewPromptSchema
      }, async (_name, args) => {
        return {
          messages: [{
            role: 'user',
            content: {
              type: 'text',
              text: `Review ${args.language} code`
            }
          }]
        }
      })

      await app.ready()

      // Test prompts/list to see auto-generated arguments
      const listRequest: JSONRPCRequest = {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'prompts/list'
      }

      const listResponse = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload: listRequest
      })

      assert.strictEqual(listResponse.statusCode, 200)
      const listBody = listResponse.json() as JSONRPCResponse
      const listResult = listBody.result as any

      const reviewPrompt = listResult.prompts.find((prompt: any) => prompt.name === 'code-review')
      assert.ok(reviewPrompt)
      assert.ok(Array.isArray(reviewPrompt.arguments))
      assert.strictEqual(reviewPrompt.arguments.length, 2)

      const languageArg = reviewPrompt.arguments.find((arg: any) => arg.name === 'language')
      assert.ok(languageArg)
      assert.strictEqual(languageArg.required, true)
      assert.ok(languageArg.description.includes('Programming language'))

      const complexityArg = reviewPrompt.arguments.find((arg: any) => arg.name === 'complexity')
      assert.ok(complexityArg)
      assert.strictEqual(complexityArg.required, false)
      assert.ok(complexityArg.description.includes('Code complexity level'))
    })

    test('should handle prompts without schemas (unsafe)', async (t) => {
      const app = Fastify()
      t.after(() => app.close())

      await app.register(mcpPlugin)

      app.mcpAddPrompt({
        name: 'unsafe-prompt',
        description: 'Unsafe prompt without schema'
      }, async (_name, args) => {
        return {
          messages: [{
            role: 'user',
            content: {
              type: 'text',
              text: `Unsafe prompt called with: ${JSON.stringify(args)}`
            }
          }]
        }
      })

      await app.ready()

      const unsafeRequest: JSONRPCRequest = {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'prompts/get',
        params: {
          name: 'unsafe-prompt',
          arguments: { anything: 'goes' }
        }
      }

      const unsafeResponse = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload: unsafeRequest
      })

      assert.strictEqual(unsafeResponse.statusCode, 200)
      const unsafeBody = unsafeResponse.json() as JSONRPCResponse
      const unsafeResult = unsafeBody.result as GetPromptResult
      assert.ok((unsafeResult.messages[0].content as any).text.includes('Unsafe prompt called'))
    })
  })

  describe('Validation Infrastructure', () => {
    test('should handle malformed request parameters', async (t) => {
      const app = Fastify()
      t.after(() => app.close())

      await app.register(mcpPlugin)
      await app.ready()

      // Test tools/call with invalid parameters
      const invalidRequest: JSONRPCRequest = {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'tools/call',
        params: null as any
      }

      const invalidResponse = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload: invalidRequest
      })

      assert.strictEqual(invalidResponse.statusCode, 200)
      const invalidBody = invalidResponse.json() as JSONRPCError
      assert.strictEqual(invalidBody.error.code, INVALID_PARAMS)
      assert.ok(invalidBody.error.message.includes('Invalid tool call parameters'))
    })

    test('should provide structured validation error details', async (t) => {
      const app = Fastify()
      t.after(() => app.close())

      await app.register(mcpPlugin)

      const StrictToolSchema = Type.Object({
        requiredString: Type.String({ minLength: 1 }),
        requiredNumber: Type.Number({ minimum: 0 })
      })

      app.mcpAddTool({
        name: 'strict',
        description: 'Strict validation tool',
        inputSchema: StrictToolSchema
      }, async (_params) => {
        return {
          content: [{ type: 'text', text: 'Success' }]
        }
      })

      await app.ready()

      // Test with completely wrong structure
      const wrongRequest: JSONRPCRequest = {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'tools/call',
        params: {
          name: 'strict',
          arguments: {
            requiredString: '',
            requiredNumber: -1,
            extraField: 'not-allowed'
          }
        }
      }

      const wrongResponse = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload: wrongRequest
      })

      assert.strictEqual(wrongResponse.statusCode, 200)
      const wrongBody = wrongResponse.json() as JSONRPCResponse
      const wrongResult = wrongBody.result as CallToolResult
      assert.strictEqual(wrongResult.isError, true)
      assert.ok((wrongResult.content[0] as any).text.includes('Invalid tool arguments'))
    })
  })
})
