import { test, describe } from 'node:test'
import Fastify from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  ListToolsResultSchema,
  CallToolResultSchema,
  ListResourcesResultSchema,
  ReadResourceResultSchema,
  ListPromptsResultSchema,
  GetPromptResultSchema
} from '@modelcontextprotocol/sdk/types.js'
import mcpPlugin from '../src/index.ts'

describe('MCP Integration Tests', () => {
  test('should handle full MCP workflow with SDK client', async (t) => {
    // Create Fastify server with MCP plugin
    const app = Fastify({ logger: false })

    // Register MCP plugin with tools, resources, and prompts
    await app.register(mcpPlugin, {
      serverInfo: { name: 'test-server', version: '1.0.0' },
      capabilities: {
        tools: { listChanged: true },
        resources: { subscribe: true },
        prompts: {}
      },
      instructions: 'Test MCP server for integration testing'
    })

    // Add a calculator tool with handler
    app.mcpAddTool({
      name: 'calculator',
      description: 'Performs basic arithmetic operations',
      inputSchema: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['add', 'subtract', 'multiply', 'divide'] },
          a: { type: 'number' },
          b: { type: 'number' }
        },
        required: ['operation', 'a', 'b']
      }
    }, async (params) => {
      const { operation, a, b } = params
      let result: number
      switch (operation) {
        case 'add': result = a + b; break
        case 'subtract': result = a - b; break
        case 'multiply': result = a * b; break
        case 'divide': result = a / b; break
        default: throw new Error('Invalid operation')
      }
      return {
        content: [{ type: 'text', text: `Result: ${result}` }]
      }
    })

    // Add a config resource with handler
    app.mcpAddResource({
      uri: 'config://settings.json',
      name: 'App Settings',
      description: 'Application configuration',
      mimeType: 'application/json'
    }, async (uri) => {
      const config = { mode: 'test', debug: true, version: '1.0.0' }
      return {
        contents: [{
          uri,
          text: JSON.stringify(config, null, 2),
          mimeType: 'application/json'
        }]
      }
    })

    // Add a code review prompt with handler
    app.mcpAddPrompt({
      name: 'code-review',
      description: 'Generates code review prompts',
      arguments: [{
        name: 'language',
        description: 'Programming language',
        required: true
      }]
    }, async (name, args) => {
      const language = args?.language || 'javascript'
      return {
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: `Please review this ${language} code for best practices and potential issues.`
          }
        }]
      }
    })

    await app.ready()

    // Start the server
    await app.listen({ port: 0, host: '127.0.0.1' })
    const port = (app.server.address() as any)?.port

    t.after(async () => {
      await app.close()
    })

    // Create MCP client using SDK
    const client = new Client({
      name: 'test-client',
      version: '1.0.0'
    }, {
      capabilities: {
        roots: {}
      }
    })

    // Create StreamableHTTP transport
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`)
    )

    // Connect the client
    await client.connect(transport)

    t.after(async () => {
      await client.close()
    })

    try {
      // Test tools listing
      const toolsResult = await client.request({
        method: 'tools/list',
        params: {}
      }, ListToolsResultSchema)

      t.assert.strictEqual(toolsResult.tools.length, 1)
      t.assert.strictEqual(toolsResult.tools[0].name, 'calculator')

      // Test tool execution
      const calcResult = await client.request({
        method: 'tools/call',
        params: {
          name: 'calculator',
          arguments: { operation: 'add', a: 5, b: 3 }
        }
      }, CallToolResultSchema)

      t.assert.strictEqual(calcResult.content[0].type, 'text')
      t.assert.strictEqual(calcResult.content[0].text, 'Result: 8')
      t.assert.strictEqual(calcResult.isError, undefined)

      // Test tool execution with division
      const divResult = await client.request({
        method: 'tools/call',
        params: {
          name: 'calculator',
          arguments: { operation: 'divide', a: 10, b: 2 }
        }
      }, CallToolResultSchema)

      t.assert.strictEqual(divResult.content[0].text, 'Result: 5')

      // Test tool execution with error
      const errorResult = await client.request({
        method: 'tools/call',
        params: {
          name: 'calculator',
          arguments: { operation: 'invalid', a: 1, b: 2 }
        }
      }, CallToolResultSchema)

      t.assert.strictEqual(errorResult.isError, true)
      t.assert.ok(errorResult.content[0].text.includes('Invalid operation'))

      // Test resources listing
      const resourcesResult = await client.request({
        method: 'resources/list',
        params: {}
      }, ListResourcesResultSchema)

      t.assert.strictEqual(resourcesResult.resources.length, 1)
      t.assert.strictEqual(resourcesResult.resources[0].uri, 'config://settings.json')

      // Test resource reading
      const configResult = await client.request({
        method: 'resources/read',
        params: { uri: 'config://settings.json' }
      }, ReadResourceResultSchema)

      t.assert.strictEqual(configResult.contents[0].uri, 'config://settings.json')
      t.assert.strictEqual(configResult.contents[0].mimeType, 'application/json')
      const config = JSON.parse(configResult.contents[0].text)
      t.assert.strictEqual(config.mode, 'test')
      t.assert.strictEqual(config.debug, true)

      // Test prompts listing
      const promptsResult = await client.request({
        method: 'prompts/list',
        params: {}
      }, ListPromptsResultSchema)

      t.assert.strictEqual(promptsResult.prompts.length, 1)
      t.assert.strictEqual(promptsResult.prompts[0].name, 'code-review')

      // Test prompt execution
      const promptResult = await client.request({
        method: 'prompts/get',
        params: {
          name: 'code-review',
          arguments: { language: 'typescript' }
        }
      }, GetPromptResultSchema)

      t.assert.strictEqual(promptResult.messages.length, 1)
      t.assert.strictEqual(promptResult.messages[0].role, 'user')
      t.assert.ok(promptResult.messages[0].content.text.includes('typescript'))
    } catch (error) {
      t.assert.fail(`MCP SDK integration test failed: ${error}`)
    }
  })

  test('should handle errors properly with SDK client', async (t) => {
    const app = Fastify({ logger: false })

    await app.register(mcpPlugin)
    await app.ready()

    await app.listen({ port: 0, host: '127.0.0.1' })
    const port = (app.server.address() as any)?.port

    t.after(async () => {
      await app.close()
    })

    // Create MCP client using SDK
    const client = new Client({
      name: 'test-client',
      version: '1.0.0'
    }, {
      capabilities: { roots: {} }
    })

    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`)
    )

    await client.connect(transport)

    t.after(async () => {
      await client.close()
    })

    // Test calling non-existent tool
    try {
      await client.request({
        method: 'tools/call',
        params: { name: 'nonexistent-tool' }
      }, CallToolResultSchema)
      t.assert.fail('Should have thrown an error')
    } catch (error: any) {
      t.assert.ok(error.message.includes('nonexistent-tool'))
    }

    // Test reading non-existent resource
    try {
      await client.request({
        method: 'resources/read',
        params: { uri: 'nonexistent://resource' }
      }, ReadResourceResultSchema)
      t.assert.fail('Should have thrown an error')
    } catch (error: any) {
      t.assert.ok(error.message.includes('nonexistent://resource'))
    }

    // Test getting non-existent prompt
    try {
      await client.request({
        method: 'prompts/get',
        params: { name: 'nonexistent-prompt' }
      }, GetPromptResultSchema)
      t.assert.fail('Should have thrown an error')
    } catch (error: any) {
      t.assert.ok(error.message.includes('nonexistent-prompt'))
    }
  })

  test('should handle tools without handlers using SDK client', async (t) => {
    const app = Fastify({ logger: false })

    await app.register(mcpPlugin)

    // Add tool without handler
    app.mcpAddTool({
      name: 'no-handler-tool',
      description: 'A tool without handler',
      inputSchema: { type: 'object' }
    })

    await app.ready()

    await app.listen({ port: 0, host: '127.0.0.1' })
    const port = (app.server.address() as any)?.port

    t.after(async () => {
      await app.close()
    })

    // Create MCP client using SDK
    const client = new Client({
      name: 'test-client',
      version: '1.0.0'
    }, {
      capabilities: { roots: {} }
    })

    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`)
    )

    await client.connect(transport)

    t.after(async () => {
      await client.close()
    })

    // Tool should be listed
    const toolsResult = await client.request({
      method: 'tools/list',
      params: {}
    }, ListToolsResultSchema)

    t.assert.strictEqual(toolsResult.tools.length, 1)
    t.assert.strictEqual(toolsResult.tools[0].name, 'no-handler-tool')

    // But calling it should return a "no handler" response
    const callResult = await client.request({
      method: 'tools/call',
      params: { name: 'no-handler-tool' }
    }, CallToolResultSchema)

    t.assert.strictEqual(callResult.isError, true)
    t.assert.ok(callResult.content[0].text.includes('no handler implementation'))
  })
})
