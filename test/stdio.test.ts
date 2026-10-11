import { test } from 'node:test'
import assert from 'node:assert'
import fastify from 'fastify'
import mcpPlugin from '../src/index.ts'
import { createStdioTransport } from '../src/stdio.ts'
import { PassThrough } from 'node:stream'
import { createInterface } from 'node:readline'

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

async function setupStdio () {
  const app = fastify({ logger: false })
  await app.register(mcpPlugin, {
    serverInfo: { name: 'test-server', version: '1.0.0' },
    capabilities: { tools: {} }
  })
  app.mcpAddTool({
    name: 'iconic',
    description: 'A tool with icons',
    icons: [{ src: 'https://example.com/icon.png', mimeType: 'image/png' }],
    inputSchema: { type: 'object', properties: {} }
  }, async () => ({ content: [{ type: 'text', text: 'ok' }] }))
  await app.ready()

  const input = new PassThrough()
  const output = new PassThrough()
  const error = new PassThrough()
  const transport = createStdioTransport(app, { input, output, error })
  transport.start()

  const lines = createInterface({ input: output })[Symbol.asyncIterator]()
  async function send (message: unknown): Promise<any> {
    input.write(JSON.stringify(message) + '\n')
    const { value } = await lines.next()
    return JSON.parse(value as string)
  }

  return { send, stop: () => transport.stop() }
}

function initialize (id: number, protocolVersion: string) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: { protocolVersion, capabilities: {}, clientInfo: { name: 'c', version: '1' } }
  }
}

test('stdio transport - later requests use the version negotiated in initialize', async (t) => {
  const { send, stop } = await setupStdio()
  t.after(stop)

  const init = await send(initialize(1, '2025-11-25'))
  assert.strictEqual(init.result.protocolVersion, '2025-11-25')

  const list = await send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  const tool = list.result.tools[0]
  assert.deepStrictEqual(tool.icons, [{ src: 'https://example.com/icon.png', mimeType: 'image/png' }])
  assert.strictEqual(tool.inputSchema.$schema, 'https://json-schema.org/draft/2020-12/schema')

  // Batched requests carry the negotiated version too
  const batch = await send([{ jsonrpc: '2.0', id: 3, method: 'tools/list' }])
  assert.strictEqual(batch[0].result.tools[0].inputSchema.$schema, 'https://json-schema.org/draft/2020-12/schema')
})

test('stdio transport - re-initialize switches the negotiated version', async (t) => {
  const { send, stop } = await setupStdio()
  t.after(stop)

  await send(initialize(1, '2025-11-25'))
  const init = await send(initialize(2, '2025-06-18'))
  assert.strictEqual(init.result.protocolVersion, '2025-06-18')

  const list = await send({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
  const tool = list.result.tools[0]
  assert.strictEqual(tool.icons, undefined)
  assert.strictEqual(tool.inputSchema.$schema, undefined)
})
