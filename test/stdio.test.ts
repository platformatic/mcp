import { test } from 'node:test'
import assert from 'node:assert'
import fastify from 'fastify'
import mcpPlugin from '../src/index.ts'
import { PassThrough } from 'node:stream'
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
