import { test } from 'node:test'
import assert from 'node:assert'
import fastify from 'fastify'
import mcpPlugin from '../src/index.ts'
import { PassThrough } from 'node:stream'
import { createInterface } from 'node:readline'
import { LATEST_PROTOCOL_VERSION } from '../src/schema.ts'
import { META_PROTOCOL_VERSION, META_CLIENT_INFO, META_CLIENT_CAPABILITIES } from '../src/schema-2026.ts'
import { setTimeout as sleep } from 'node:timers/promises'
import { createStdioTransport, runStdioServer } from '../src/stdio.ts'

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

test('stdio transport - a 2026-07-28 message after a legacy initialize keeps its own version', async (t) => {
  const { send, stop } = await setupStdio()
  t.after(stop)

  await send(initialize(1, '2025-11-25'))
  const list = await send({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {
      _meta: {
        [META_PROTOCOL_VERSION]: LATEST_PROTOCOL_VERSION,
        [META_CLIENT_INFO]: { name: 'c', version: '1' },
        [META_CLIENT_CAPABILITIES]: {}
      }
    }
  })
  assert.strictEqual(list.error, undefined)
  assert.strictEqual(list.result.resultType, 'complete')
  assert.strictEqual(list.result.tools[0].name, 'iconic')
})

test('runStdioServer - resolves only after app.close() completes on input EOF', async () => {
  const app = fastify({ logger: false })

  await app.register(mcpPlugin, {
    serverInfo: {
      name: 'test-server',
      version: '1.0.0'
    }
  })

  let onCloseDone = false
  app.addHook('onClose', async () => {
    await sleep(200)
    onCloseDone = true
  })

  await app.ready()

  const input = new PassThrough()
  const running = runStdioServer(app, {
    input,
    output: new PassThrough(),
    error: new PassThrough()
  })
  input.end()

  await running
  assert.strictEqual(onCloseDone, true, 'onClose hook should complete before runStdioServer resolves')
})

test('stdio transport - concurrent stop() calls share the same close promise', async () => {
  const app = fastify({ logger: false })

  await app.register(mcpPlugin, {
    serverInfo: {
      name: 'test-server',
      version: '1.0.0'
    }
  })

  let onCloseDone = false
  app.addHook('onClose', async () => {
    await sleep(100)
    onCloseDone = true
  })

  await app.ready()

  const transport = createStdioTransport(app, {
    input: new PassThrough(),
    output: new PassThrough(),
    error: new PassThrough()
  })
  transport.start()

  const first = transport.stop()
  const second = transport.stop()
  assert.strictEqual(first, second, 'stop() should return the same promise')

  await second
  assert.strictEqual(onCloseDone, true, 'second stop() should wait for app.close()')
})
