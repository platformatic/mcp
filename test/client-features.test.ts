import { test } from 'node:test'
import * as assert from 'node:assert'
import Fastify from 'fastify'
import mcpPlugin from '../src/index.ts'
import type { SamplingMessage } from '../src/schema.ts'

test('Client Feature Support - Sampling and Roots', async (t) => {
  await t.test('should provide mcpRequestSampling decorator', async (_t) => {
    const app = Fastify()

    await app.register(mcpPlugin, {
      serverInfo: {
        name: 'test-server',
        version: '1.0.0'
      },
      capabilities: {
        tools: {}
      },
      enableSSE: true
    })

    // Verify decorator exists
    assert.ok(typeof app.mcpRequestSampling === 'function')

    await app.close()
  })

  await t.test('should provide mcpRequestRoots decorator', async (_t) => {
    const app = Fastify()

    await app.register(mcpPlugin, {
      serverInfo: {
        name: 'test-server',
        version: '1.0.0'
      },
      capabilities: {
        tools: {}
      },
      enableSSE: true
    })

    // Verify decorator exists
    assert.ok(typeof app.mcpRequestRoots === 'function')

    await app.close()
  })

  await t.test('mcpRequestSampling should handle basic sampling request', async (_t) => {
    const app = Fastify()

    await app.register(mcpPlugin, {
      serverInfo: {
        name: 'test-server',
        version: '1.0.0'
      },
      capabilities: {
        tools: {}
      },
      enableSSE: true
    })

    const messages: SamplingMessage[] = [
      {
        role: 'user',
        content: {
          type: 'text',
          text: 'Hello, can you help me?'
        }
      }
    ]

    // Should return false because session doesn't exist
    const result = await app.mcpRequestSampling('test-session-id', messages, {
      maxTokens: 100
    })

    assert.strictEqual(result, false)

    await app.close()
  })

  await t.test('mcpRequestSampling should handle sampling with tools', async (_t) => {
    const app = Fastify()

    await app.register(mcpPlugin, {
      serverInfo: {
        name: 'test-server',
        version: '1.0.0'
      },
      capabilities: {
        tools: {}
      },
      enableSSE: true
    })

    const messages: SamplingMessage[] = [
      {
        role: 'user',
        content: {
          type: 'text',
          text: 'What is the weather?'
        }
      }
    ]

    // Test with tool definitions
    const result = await app.mcpRequestSampling('test-session-id', messages, {
      maxTokens: 100,
      tools: [
        {
          name: 'get_weather',
          description: 'Get current weather for a location',
          inputSchema: {
            type: 'object',
            properties: {
              location: {
                type: 'string',
                description: 'City name'
              }
            },
            required: ['location']
          }
        }
      ],
      toolChoice: { mode: 'auto' }
    })

    // Should return false because session doesn't exist
    assert.strictEqual(result, false)

    await app.close()
  })

  await t.test('mcpRequestRoots should request roots from client', async (_t) => {
    const app = Fastify()

    await app.register(mcpPlugin, {
      serverInfo: {
        name: 'test-server',
        version: '1.0.0'
      },
      capabilities: {
        tools: {}
      },
      enableSSE: true
    })

    // Should return false because session doesn't exist
    const result = await app.mcpRequestRoots('test-session-id')

    assert.strictEqual(result, false)

    await app.close()
  })

  await t.test('should fail gracefully when SSE is disabled', async (_t) => {
    const app = Fastify()

    await app.register(mcpPlugin, {
      serverInfo: {
        name: 'test-server',
        version: '1.0.0'
      },
      capabilities: {
        tools: {}
      },
      enableSSE: false
    })

    const messages: SamplingMessage[] = [
      {
        role: 'user',
        content: {
          type: 'text',
          text: 'Hello'
        }
      }
    ]

    // Should return false when SSE is disabled
    const samplingResult = await app.mcpRequestSampling('test-session', messages, {
      maxTokens: 100
    })
    assert.strictEqual(samplingResult, false)

    const rootsResult = await app.mcpRequestRoots('test-session')
    assert.strictEqual(rootsResult, false)

    await app.close()
  })

  await t.test('mcpRequestSampling should support all sampling options', async (_t) => {
    const app = Fastify()

    await app.register(mcpPlugin, {
      serverInfo: {
        name: 'test-server',
        version: '1.0.0'
      },
      capabilities: {
        tools: {}
      },
      enableSSE: true
    })

    const messages: SamplingMessage[] = [
      {
        role: 'user',
        content: {
          type: 'text',
          text: 'Test message'
        }
      }
    ]

    // Test with all options
    const result = await app.mcpRequestSampling('test-session-id', messages, {
      maxTokens: 500,
      modelPreferences: {
        hints: [{ name: 'claude-3-sonnet' }],
        costPriority: 0.5,
        speedPriority: 0.5,
        intelligencePriority: 0.8
      },
      systemPrompt: 'You are a helpful assistant',
      includeContext: 'thisServer',
      temperature: 0.7,
      stopSequences: ['END'],
      metadata: {
        custom: 'value'
      }
    })

    // Should return false because session doesn't exist
    assert.strictEqual(result, false)

    await app.close()
  })
})
