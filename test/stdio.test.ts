import { test } from 'node:test'
import assert from 'node:assert'
import fastify from 'fastify'
import mcpPlugin from '../src/index.ts'
import { createStdioTransport } from '../src/stdio.ts'

// Note: These tests are placeholders.
// The actual stdio functionality is tested in stdio-simple.test.ts using subprocess integration.

test('stdio transport - can be created', async () => {
  const app = fastify({ logger: false })

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

  await app.ready()

  // Test that we can create a stdio transport without errors
  const transport = createStdioTransport(app, {
    debug: false
  })

  assert(transport, 'Should create transport')
  assert(typeof transport.start === 'function', 'Should have start method')
  assert(typeof transport.stop === 'function', 'Should have stop method')
})

test('stdio transport - example server has correct methods', async () => {
  const app = fastify({ logger: false })

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

  // Test that we can register tools/resources/prompts
  app.mcpAddTool({
    name: 'test-tool',
    description: 'A test tool',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' }
      }
    }
  }, async (args) => {
    return {
      content: [{
        type: 'text',
        text: args.text
      }]
    }
  })

  await app.ready()

  // Test that stdio transport can be created with registered tools
  const transport = createStdioTransport(app, {
    debug: false
  })

  assert(transport, 'Should create transport with registered tools')
})
