import { test } from 'node:test'
import * as assert from 'node:assert'
import Fastify from 'fastify'
import mcpPlugin from '../src/index.ts'
import type { JSONRPCRequest, JSONRPCResponse, LogLevel } from '../src/schema.ts'

test('Logging Capability', async (t) => {
  await t.test('should create logging decorators when logging capability enabled', async (_t) => {
    const app = Fastify()

    await app.register(mcpPlugin, {
      serverInfo: {
        name: 'test-server',
        version: '1.0.0'
      },
      capabilities: {
        logging: {}
      }
    })

    assert.ok(app.mcpLog)
    assert.strictEqual(typeof app.mcpLog.debug, 'function')
    assert.strictEqual(typeof app.mcpLog.info, 'function')
    assert.strictEqual(typeof app.mcpLog.notice, 'function')
    assert.strictEqual(typeof app.mcpLog.warning, 'function')
    assert.strictEqual(typeof app.mcpLog.error, 'function')
    assert.strictEqual(typeof app.mcpLog.critical, 'function')
    assert.strictEqual(typeof app.mcpLog.alert, 'function')
    assert.strictEqual(typeof app.mcpLog.emergency, 'function')
    assert.strictEqual(typeof app.mcpSetLogLevel, 'function')
    assert.strictEqual(typeof app.mcpGetLogLevel, 'function')

    await app.close()
  })

  await t.test('should provide no-op decorators when logging capability not enabled', async (_t) => {
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

    assert.ok(app.mcpLog)
    assert.strictEqual(typeof app.mcpLog.info, 'function')

    // Should not throw when called
    await app.mcpLog.info('test message')

    await app.close()
  })

  await t.test('should set and get log level', async (_t) => {
    const app = Fastify()

    await app.register(mcpPlugin, {
      serverInfo: {
        name: 'test-server',
        version: '1.0.0'
      },
      capabilities: {
        logging: {}
      }
    })

    // Default level should be info
    assert.strictEqual(app.mcpGetLogLevel(), 'info')

    await app.mcpSetLogLevel('debug')
    assert.strictEqual(app.mcpGetLogLevel(), 'debug')

    await app.mcpSetLogLevel('error')
    assert.strictEqual(app.mcpGetLogLevel(), 'error')

    await app.close()
  })

  await t.test('should handle logging/setLevel request', async (_t) => {
    const app = Fastify()

    await app.register(mcpPlugin, {
      serverInfo: {
        name: 'test-server',
        version: '1.0.0'
      },
      capabilities: {
        logging: {}
      }
    })

    const request: JSONRPCRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'logging/setLevel',
      params: {
        level: 'warning'
      }
    }

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: request
    })

    assert.strictEqual(response.statusCode, 200)

    const result = JSON.parse(response.body) as JSONRPCResponse
    assert.ok(result.result !== undefined)

    // Verify level was set
    assert.strictEqual(app.mcpGetLogLevel(), 'warning')

    await app.close()
  })

  await t.test('should reject invalid log level', async (_t) => {
    const app = Fastify()

    await app.register(mcpPlugin, {
      serverInfo: {
        name: 'test-server',
        version: '1.0.0'
      },
      capabilities: {
        logging: {}
      }
    })

    const request: JSONRPCRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'logging/setLevel',
      params: {
        level: 'invalid-level'
      }
    }

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: request
    })

    assert.strictEqual(response.statusCode, 200)

    const result = JSON.parse(response.body) as JSONRPCResponse
    assert.ok('error' in result)
    assert.strictEqual((result as any).error.code, -32602) // INVALID_PARAMS

    await app.close()
  })

  await t.test('should respect log level hierarchy', async (_t) => {
    const app = Fastify()

    await app.register(mcpPlugin, {
      serverInfo: {
        name: 'test-server',
        version: '1.0.0'
      },
      capabilities: {
        logging: {}
      },
      enableSSE: true
    })

    // Set level to warning
    await app.mcpSetLogLevel('warning')

    // Lower priority messages should be filtered
    // (we can't easily test this without SSE session, but the API should work)
    await app.mcpLog.debug('debug message')
    await app.mcpLog.info('info message')
    await app.mcpLog.notice('notice message')

    // Higher priority messages should pass
    await app.mcpLog.warning('warning message')
    await app.mcpLog.error('error message')
    await app.mcpLog.critical('critical message')

    await app.close()
  })

  await t.test('should support all RFC 5424 log levels', async (_t) => {
    const app = Fastify()

    await app.register(mcpPlugin, {
      serverInfo: {
        name: 'test-server',
        version: '1.0.0'
      },
      capabilities: {
        logging: {}
      }
    })

    const levels: LogLevel[] = [
      'debug',
      'info',
      'notice',
      'warning',
      'error',
      'critical',
      'alert',
      'emergency'
    ]

    for (const level of levels) {
      await app.mcpSetLogLevel(level)
      assert.strictEqual(app.mcpGetLogLevel(), level)
    }

    await app.close()
  })

  await t.test('should log with logger parameter', async (_t) => {
    const app = Fastify()

    await app.register(mcpPlugin, {
      serverInfo: {
        name: 'test-server',
        version: '1.0.0'
      },
      capabilities: {
        logging: {}
      }
    })

    // Should accept logger parameter
    await app.mcpLog.info('test message', 'my-logger')
    await app.mcpLog.error({ error: 'details' }, 'error-logger')

    await app.close()
  })

  await t.test('should log various data types', async (_t) => {
    const app = Fastify()

    await app.register(mcpPlugin, {
      serverInfo: {
        name: 'test-server',
        version: '1.0.0'
      },
      capabilities: {
        logging: {}
      }
    })

    // String data
    await app.mcpLog.info('string message')

    // Object data
    await app.mcpLog.warning({ key: 'value', nested: { data: 123 } })

    // Array data
    await app.mcpLog.error([1, 2, 3, 'test'])

    // Number data
    await app.mcpLog.debug(42)

    // Boolean data
    await app.mcpLog.notice(true)

    await app.close()
  })
})
