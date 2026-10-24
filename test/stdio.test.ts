import { test } from 'node:test'
import assert from 'node:assert'
import fastify from 'fastify'
import mcpPlugin from '../src/index.ts'
import { PassThrough } from 'node:stream'
import { createInterface } from 'node:readline'
import { setTimeout as sleep } from 'node:timers/promises'
import { createStdioTransport, runStdioServer } from '../src/stdio.ts'
import { MemoryMessageBroker } from '../src/brokers/memory-message-broker.ts'

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
  async function sendRaw (line: string): Promise<any> {
    input.write(line + '\n')
    const { value } = await lines.next()
    return JSON.parse(value as string)
  }
  function send (message: unknown): Promise<any> {
    return sendRaw(JSON.stringify(message))
  }

  return { send, sendRaw, stop: () => transport.stop() }
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

test('stdio transport - rejects a numeric id that is not a safe integer', async (t) => {
  const { sendRaw, stop } = await setupStdio()
  t.after(stop)

  // JSON.parse turns 9007199254740993 into 9007199254740992, so answering it
  // would echo a different id than the client sent
  const response = await sendRaw('{"jsonrpc":"2.0","id":9007199254740993,"method":"tools/list"}')
  assert.strictEqual(response.id, null)
  assert.strictEqual(response.error.code, -32600)
  assert.strictEqual(response.result, undefined)

  // 1e400 parses to Infinity, which would be re-serialized as null
  const infinite = await sendRaw('{"jsonrpc":"2.0","id":1e400,"method":"tools/list"}')
  assert.strictEqual(infinite.id, null)
  assert.strictEqual(infinite.error.code, -32600)
})

test('stdio transport - rejects request ids that are not a string or an integer (#318)', async (t) => {
  const { send, sendRaw, stop } = await setupStdio()
  t.after(stop)

  for (const id of [null, true, false, { a: 1 }, [1], 1.5]) {
    const response = await send({ jsonrpc: '2.0', id, method: 'ping' })
    assert.strictEqual(response.id, null, `id ${JSON.stringify(id)}`)
    assert.strictEqual(response.error.code, -32600)
    assert.strictEqual(response.result, undefined)
  }

  // A notification (no id at all) gets no reply, so the next line on the
  // output answers the ping that follows it
  const notification = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
  const ping = JSON.stringify({ jsonrpc: '2.0', id: 'after', method: 'ping' })
  const response = await sendRaw(notification + '\n' + ping)
  assert.strictEqual(response.id, 'after')
  assert.deepStrictEqual(response.result, {})

  for (const id of [0, 7, 'abc']) {
    const ok = await send({ jsonrpc: '2.0', id, method: 'ping' })
    assert.strictEqual(ok.id, id)
    assert.deepStrictEqual(ok.result, {})
  }
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

  const sigintBaseline = process.listenerCount('SIGINT')
  const sigtermBaseline = process.listenerCount('SIGTERM')

  const input = new PassThrough()
  const running = runStdioServer(app, {
    input,
    output: new PassThrough(),
    error: new PassThrough()
  })
  input.end()

  await running
  assert.strictEqual(onCloseDone, true, 'onClose hook should complete before runStdioServer resolves')
  assert.strictEqual(process.listenerCount('SIGINT'), sigintBaseline, 'SIGINT listeners should be removed')
  assert.strictEqual(process.listenerCount('SIGTERM'), sigtermBaseline, 'SIGTERM listeners should be removed')
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

test('stdio transport - does not create SSE sessions when enableSSE is on', async (t) => {
  const subscriptions: string[] = []
  const original = MemoryMessageBroker.prototype.subscribe
  t.mock.method(MemoryMessageBroker.prototype, 'subscribe', function (this: MemoryMessageBroker, topic: string, handler: any) {
    subscriptions.push(topic)
    return original.call(this, topic, handler)
  })

  const app = fastify({ logger: false })
  await app.register(mcpPlugin, {
    serverInfo: { name: 'test-server', version: '1.0.0' },
    capabilities: { tools: {} },
    enableSSE: true
  })
  await app.ready()

  const input = new PassThrough()
  const output = new PassThrough()
  const transport = createStdioTransport(app, { input, output, error: new PassThrough() })
  transport.start()
  t.after(() => transport.stop())

  const lines = createInterface({ input: output })[Symbol.asyncIterator]()
  async function send (message: unknown): Promise<any> {
    input.write(JSON.stringify(message) + '\n')
    const { value } = await lines.next()
    return JSON.parse(value as string)
  }

  const init = await send(initialize(1, '2025-06-18'))
  assert.ok(init.result)
  for (let i = 0; i < 50; i++) {
    const pong = await send({ jsonrpc: '2.0', id: i + 2, method: 'ping' })
    assert.deepStrictEqual(pong.result, {})
  }

  const sessionTopics = subscriptions.filter(topic => topic.startsWith('mcp/session/'))
  assert.deepStrictEqual(sessionTopics, [])
})

test('stdio transport - the stdio marker header alone does not skip SSE sessions', async (t) => {
  const app = fastify({ logger: false })
  await app.register(mcpPlugin, {
    serverInfo: { name: 'test-server', version: '1.0.0' },
    capabilities: { tools: {} },
    enableSSE: true
  })
  t.after(() => app.close())

  // Any HTTP client can send this header, so it must not be trusted on its own
  const response = await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      'content-type': 'application/json',
      'x-platformatic-mcp-transport': 'stdio'
    },
    payload: { jsonrpc: '2.0', id: 1, method: 'ping' }
  })
  assert.strictEqual(response.statusCode, 200)
  assert.ok(response.headers['mcp-session-id'])
})

test('stdio transport - stop() removes the SIGINT/SIGTERM listeners', async () => {
  const sigintBaseline = process.listenerCount('SIGINT')
  const sigtermBaseline = process.listenerCount('SIGTERM')

  const transports = []
  for (let i = 0; i < 3; i++) {
    const app = fastify({ logger: false })
    await app.register(mcpPlugin, {
      serverInfo: {
        name: 'test-server',
        version: '1.0.0'
      }
    })
    await app.ready()

    const transport = createStdioTransport(app, {
      input: new PassThrough(),
      output: new PassThrough(),
      error: new PassThrough()
    })
    transport.start()
    transports.push(transport)
  }

  assert.strictEqual(process.listenerCount('SIGINT'), sigintBaseline + 3)
  assert.strictEqual(process.listenerCount('SIGTERM'), sigtermBaseline + 3)

  for (const transport of transports) {
    await transport.stop()
  }

  assert.strictEqual(process.listenerCount('SIGINT'), sigintBaseline)
  assert.strictEqual(process.listenerCount('SIGTERM'), sigtermBaseline)
})

test('stdio transport - a signal removes both signal listeners', async () => {
  const sigintBaseline = process.listenerCount('SIGINT')
  const sigtermBaseline = process.listenerCount('SIGTERM')

  const app = fastify({ logger: false })
  await app.register(mcpPlugin, {
    serverInfo: {
      name: 'test-server',
      version: '1.0.0'
    }
  })
  await app.ready()

  const transport = createStdioTransport(app, {
    input: new PassThrough(),
    output: new PassThrough(),
    error: new PassThrough()
  })
  transport.start()

  // Invoke the transport's own SIGINT handler directly rather than sending a
  // real signal to the test runner
  const handler = process.listeners('SIGINT').at(-1) as () => void
  handler()

  assert.strictEqual(process.listenerCount('SIGINT'), sigintBaseline)
  assert.strictEqual(process.listenerCount('SIGTERM'), sigtermBaseline)

  await transport.stop()
})
