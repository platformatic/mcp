import { test } from 'node:test'
import * as assert from 'node:assert'
import Fastify from 'fastify'
import mcpPlugin from '../src/index.ts'
import type { JSONRPCRequest, JSONRPCResponse, IconResource } from '../src/schema.ts'
import { Type } from '@sinclair/typebox'

test('Icon Metadata Support', async (t) => {
  await t.test('should support icon metadata for tools', async (_t) => {
    const app = Fastify()

    await app.register(mcpPlugin, {
      serverInfo: {
        name: 'test-server',
        version: '1.0.0'
      },
      capabilities: {
        tools: {}
      }
    })

    const icons: IconResource[] = [
      {
        src: 'https://example.com/icons/calculator.png',
        mimeType: 'image/png',
        sizes: '32x32'
      },
      {
        src: 'https://example.com/icons/calculator.svg',
        mimeType: 'image/svg+xml'
      }
    ]

    app.mcpAddTool({
      name: 'calculator',
      description: 'Performs calculations',
      icons,
      inputSchema: Type.Object({
        operation: Type.String(),
        a: Type.Number(),
        b: Type.Number()
      })
    }, async (_input: any) => ({
      content: [{ type: 'text', text: 'Result: 42' }]
    }))

    const request: JSONRPCRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list'
    }

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: request
    })

    assert.strictEqual(response.statusCode, 200)

    const result = JSON.parse(response.body) as JSONRPCResponse
    assert.ok(result.result)
    assert.ok('tools' in result.result)

    const tools = (result.result as any).tools
    assert.strictEqual(tools.length, 1)
    assert.strictEqual(tools[0].name, 'calculator')
    assert.ok(tools[0].icons)
    assert.strictEqual(tools[0].icons.length, 2)
    assert.strictEqual(tools[0].icons[0].src, 'https://example.com/icons/calculator.png')
    assert.strictEqual(tools[0].icons[0].mimeType, 'image/png')
    assert.strictEqual(tools[0].icons[0].sizes, '32x32')
    assert.strictEqual(tools[0].icons[1].src, 'https://example.com/icons/calculator.svg')
    assert.strictEqual(tools[0].icons[1].mimeType, 'image/svg+xml')

    await app.close()
  })

  await t.test('should support icon metadata for resources', async (_t) => {
    const app = Fastify()

    await app.register(mcpPlugin, {
      serverInfo: {
        name: 'test-server',
        version: '1.0.0'
      },
      capabilities: {
        resources: {}
      }
    })

    const icons: IconResource[] = [
      {
        src: 'https://example.com/icons/file.png',
        mimeType: 'image/png'
      }
    ]

    app.mcpAddResource({
      uri: 'file:///documents/readme.txt',
      name: 'README',
      description: 'Project documentation',
      mimeType: 'text/plain',
      icons
    }, async () => ({
      contents: [{ uri: 'file:///documents/readme.txt', mimeType: 'text/plain', text: 'Hello' }]
    }))

    const request: JSONRPCRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'resources/list'
    }

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: request
    })

    assert.strictEqual(response.statusCode, 200)

    const result = JSON.parse(response.body) as JSONRPCResponse
    assert.ok(result.result)
    assert.ok('resources' in result.result)

    const resources = (result.result as any).resources
    assert.strictEqual(resources.length, 1)
    assert.strictEqual(resources[0].uri, 'file:///documents/readme.txt')
    assert.ok(resources[0].icons)
    assert.strictEqual(resources[0].icons.length, 1)
    assert.strictEqual(resources[0].icons[0].src, 'https://example.com/icons/file.png')
    assert.strictEqual(resources[0].icons[0].mimeType, 'image/png')

    await app.close()
  })

  await t.test('should support icon metadata for prompts', async (_t) => {
    const app = Fastify()

    await app.register(mcpPlugin, {
      serverInfo: {
        name: 'test-server',
        version: '1.0.0'
      },
      capabilities: {
        prompts: {}
      }
    })

    const icons: IconResource[] = [
      {
        src: 'https://example.com/icons/template.svg',
        mimeType: 'image/svg+xml'
      }
    ]

    app.mcpAddPrompt({
      name: 'greeting',
      description: 'Generates a greeting message',
      icons,
      argumentSchema: Type.Object({
        name: Type.String()
      })
    }, async (args: any) => ({
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: `Hello, ${args.name}!` }
        }
      ]
    }))

    const request: JSONRPCRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'prompts/list'
    }

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: request
    })

    assert.strictEqual(response.statusCode, 200)

    const result = JSON.parse(response.body) as JSONRPCResponse
    assert.ok(result.result)
    assert.ok('prompts' in result.result)

    const prompts = (result.result as any).prompts
    assert.strictEqual(prompts.length, 1)
    assert.strictEqual(prompts[0].name, 'greeting')
    assert.ok(prompts[0].icons)
    assert.strictEqual(prompts[0].icons.length, 1)
    assert.strictEqual(prompts[0].icons[0].src, 'https://example.com/icons/template.svg')
    assert.strictEqual(prompts[0].icons[0].mimeType, 'image/svg+xml')

    await app.close()
  })

  await t.test('should work without icon metadata (backward compatibility)', async (_t) => {
    const app = Fastify()

    await app.register(mcpPlugin, {
      serverInfo: {
        name: 'test-server',
        version: '1.0.0'
      },
      capabilities: {
        tools: {},
        resources: {},
        prompts: {}
      }
    })

    // Register without icons
    app.mcpAddTool({
      name: 'simple-tool',
      description: 'A simple tool',
      inputSchema: Type.Object({
        input: Type.String()
      })
    }, async () => ({ content: [{ type: 'text', text: 'ok' }] }))

    app.mcpAddResource({
      uri: 'test://resource',
      name: 'Test Resource',
      description: 'A test resource'
    }, async () => ({ contents: [{ uri: 'test://resource', text: 'data' }] }))

    app.mcpAddPrompt({
      name: 'simple-prompt',
      description: 'A simple prompt',
      argumentSchema: Type.Object({})
    }, async () => ({ messages: [] }))

    // Test tools/list
    let request: JSONRPCRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list'
    }

    let response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: request
    })

    assert.strictEqual(response.statusCode, 200)
    let result = JSON.parse(response.body) as JSONRPCResponse
    const tools = (result.result as any).tools
    assert.strictEqual(tools[0].icons, undefined)

    // Test resources/list
    request = {
      jsonrpc: '2.0',
      id: 2,
      method: 'resources/list'
    }

    response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: request
    })

    assert.strictEqual(response.statusCode, 200)
    result = JSON.parse(response.body) as JSONRPCResponse
    const resources = (result.result as any).resources
    assert.strictEqual(resources[0].icons, undefined)

    // Test prompts/list
    request = {
      jsonrpc: '2.0',
      id: 3,
      method: 'prompts/list'
    }

    response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: request
    })

    assert.strictEqual(response.statusCode, 200)
    result = JSON.parse(response.body) as JSONRPCResponse
    const prompts = (result.result as any).prompts
    assert.strictEqual(prompts[0].icons, undefined)

    await app.close()
  })
})
