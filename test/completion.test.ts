import { test } from 'node:test'
import * as assert from 'node:assert'
import Fastify from 'fastify'
import mcpPlugin from '../src/index.ts'
import type { JSONRPCRequest, JSONRPCResponse } from '../src/schema.ts'
import { Type } from '@sinclair/typebox'

test('Completion Capability', async (t) => {
  await t.test('should provide completion decorators when enabled', async (_t) => {
    const app = Fastify()

    await app.register(mcpPlugin, {
      serverInfo: {
        name: 'test-server',
        version: '1.0.0'
      },
      capabilities: {
        completions: {}
      }
    })

    assert.ok(app.mcpRegisterPromptCompletion)
    assert.ok(app.mcpRegisterResourceCompletion)
    assert.strictEqual(typeof app.mcpRegisterPromptCompletion, 'function')
    assert.strictEqual(typeof app.mcpRegisterResourceCompletion, 'function')

    await app.close()
  })

  await t.test('should provide no-op decorators when disabled', async (_t) => {
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

    assert.ok(app.mcpRegisterPromptCompletion)
    assert.ok(app.mcpRegisterResourceCompletion)

    // Should not throw
    app.mcpRegisterPromptCompletion('test', async () => [])

    await app.close()
  })

  await t.test('should register and use prompt completion provider', async (_t) => {
    const app = Fastify()

    await app.register(mcpPlugin, {
      serverInfo: {
        name: 'test-server',
        version: '1.0.0'
      },
      capabilities: {
        prompts: {},
        completions: {}
      }
    })

    // Register a prompt
    app.mcpAddPrompt({
      name: 'greeting',
      description: 'Generate a greeting',
      argumentSchema: Type.Object({
        name: Type.String(),
        language: Type.String()
      })
    }, async () => ({ messages: [] }))

    // Register completion provider for language argument
    app.mcpRegisterPromptCompletion('greeting', async (argumentName, _argumentValue, _context) => {
      if (argumentName === 'language') {
        return ['English', 'Spanish', 'French', 'German', 'Italian']
      }
      return []
    })

    const request: JSONRPCRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'completion/complete',
      params: {
        ref: {
          type: 'ref/prompt',
          name: 'greeting'
        },
        argument: {
          name: 'language',
          value: ''
        }
      }
    }

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: request
    })

    assert.strictEqual(response.statusCode, 200)

    const result = JSON.parse(response.body) as JSONRPCResponse
    assert.ok(result.result)
    assert.ok('completion' in result.result)
    const completion = (result.result as any).completion
    assert.ok(Array.isArray(completion.values))
    assert.strictEqual(completion.values.length, 5)
    assert.ok(completion.values.includes('English'))
    assert.ok(completion.values.includes('Spanish'))

    await app.close()
  })

  await t.test('should register and use resource completion provider', async (_t) => {
    const app = Fastify()

    await app.register(mcpPlugin, {
      serverInfo: {
        name: 'test-server',
        version: '1.0.0'
      },
      capabilities: {
        resources: {},
        completions: {}
      }
    })

    // Register a resource template
    app.mcpAddResource({
      uri: 'file:///{path}',
      name: 'File',
      description: 'Access a file'
    }, async () => ({ contents: [] }))

    // Register completion provider for path parameter
    app.mcpRegisterResourceCompletion('file:///{path}', async (argumentName, _argumentValue, _context) => {
      if (argumentName === 'path') {
        return ['/home/user/file1.txt', '/home/user/file2.txt', '/home/user/docs/']
      }
      return []
    })

    const request: JSONRPCRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'completion/complete',
      params: {
        ref: {
          type: 'ref/resource',
          uri: 'file:///{path}'
        },
        argument: {
          name: 'path',
          value: '/home/user/'
        }
      }
    }

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: request
    })

    assert.strictEqual(response.statusCode, 200)

    const result = JSON.parse(response.body) as JSONRPCResponse
    assert.ok(result.result)
    const completion = (result.result as any).completion
    assert.ok(Array.isArray(completion.values))
    assert.strictEqual(completion.values.length, 3)

    await app.close()
  })

  await t.test('should return empty completions when no provider registered', async (_t) => {
    const app = Fastify()

    await app.register(mcpPlugin, {
      serverInfo: {
        name: 'test-server',
        version: '1.0.0'
      },
      capabilities: {
        prompts: {},
        completions: {}
      }
    })

    // Register a prompt without completion provider
    app.mcpAddPrompt({
      name: 'test',
      description: 'Test prompt',
      argumentSchema: Type.Object({
        arg: Type.String()
      })
    }, async () => ({ messages: [] }))

    const request: JSONRPCRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'completion/complete',
      params: {
        ref: {
          type: 'ref/prompt',
          name: 'test'
        },
        argument: {
          name: 'arg',
          value: 'test'
        }
      }
    }

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: request
    })

    assert.strictEqual(response.statusCode, 200)

    const result = JSON.parse(response.body) as JSONRPCResponse
    const completion = (result.result as any).completion
    assert.strictEqual(completion.values.length, 0)
    assert.strictEqual(completion.total, 0)
    assert.strictEqual(completion.hasMore, false)

    await app.close()
  })

  await t.test('should use context in completion provider', async (_t) => {
    const app = Fastify()

    await app.register(mcpPlugin, {
      serverInfo: {
        name: 'test-server',
        version: '1.0.0'
      },
      capabilities: {
        prompts: {},
        completions: {}
      }
    })

    app.mcpAddPrompt({
      name: 'search',
      description: 'Search with context',
      argumentSchema: Type.Object({
        category: Type.String(),
        query: Type.String()
      })
    }, async () => ({ messages: [] }))

    // Provider that uses context from other arguments
    app.mcpRegisterPromptCompletion('search', async (argumentName, _argumentValue, context) => {
      if (argumentName === 'query') {
        const category = context?.arguments?.category
        if (category === 'tech') {
          return ['JavaScript', 'TypeScript', 'Python']
        } else if (category === 'science') {
          return ['Physics', 'Chemistry', 'Biology']
        }
      }
      return []
    })

    const request: JSONRPCRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'completion/complete',
      params: {
        ref: {
          type: 'ref/prompt',
          name: 'search'
        },
        argument: {
          name: 'query',
          value: ''
        },
        context: {
          arguments: {
            category: 'tech'
          }
        }
      }
    }

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: request
    })

    assert.strictEqual(response.statusCode, 200)

    const result = JSON.parse(response.body) as JSONRPCResponse
    const completion = (result.result as any).completion
    assert.strictEqual(completion.values.length, 3)
    assert.ok(completion.values.includes('JavaScript'))

    await app.close()
  })

  await t.test('should limit completions to 100 items', async (_t) => {
    const app = Fastify()

    await app.register(mcpPlugin, {
      serverInfo: {
        name: 'test-server',
        version: '1.0.0'
      },
      capabilities: {
        prompts: {},
        completions: {}
      }
    })

    app.mcpAddPrompt({
      name: 'many',
      description: 'Many completions',
      argumentSchema: Type.Object({
        item: Type.String()
      })
    }, async () => ({ messages: [] }))

    // Provider that returns more than 100 items
    app.mcpRegisterPromptCompletion('many', async () => {
      const items: string[] = []
      for (let i = 0; i < 200; i++) {
        items.push(`item-${i}`)
      }
      return items
    })

    const request: JSONRPCRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'completion/complete',
      params: {
        ref: {
          type: 'ref/prompt',
          name: 'many'
        },
        argument: {
          name: 'item',
          value: ''
        }
      }
    }

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: request
    })

    assert.strictEqual(response.statusCode, 200)

    const result = JSON.parse(response.body) as JSONRPCResponse
    const completion = (result.result as any).completion
    assert.strictEqual(completion.values.length, 100)
    assert.strictEqual(completion.total, 200)
    assert.strictEqual(completion.hasMore, true)

    await app.close()
  })

  await t.test('should support async completion providers', async (_t) => {
    const app = Fastify()

    await app.register(mcpPlugin, {
      serverInfo: {
        name: 'test-server',
        version: '1.0.0'
      },
      capabilities: {
        prompts: {},
        completions: {}
      }
    })

    app.mcpAddPrompt({
      name: 'async',
      description: 'Async completions',
      argumentSchema: Type.Object({
        value: Type.String()
      })
    }, async () => ({ messages: [] }))

    app.mcpRegisterPromptCompletion('async', async (argumentName, _argumentValue) => {
      // Simulate async operation
      await new Promise(resolve => setTimeout(resolve, 10))

      if (argumentName === 'value') {
        return ['async-value-1', 'async-value-2']
      }
      return []
    })

    const request: JSONRPCRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'completion/complete',
      params: {
        ref: {
          type: 'ref/prompt',
          name: 'async'
        },
        argument: {
          name: 'value',
          value: 'a'
        }
      }
    }

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: request
    })

    assert.strictEqual(response.statusCode, 200)

    const result = JSON.parse(response.body) as JSONRPCResponse
    const completion = (result.result as any).completion
    assert.strictEqual(completion.values.length, 2)
    assert.ok(completion.values.includes('async-value-1'))

    await app.close()
  })
})
