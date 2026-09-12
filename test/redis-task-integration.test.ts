import { describe } from 'node:test'
import assert from 'node:assert'
import fastify from 'fastify'
import { Type } from '@sinclair/typebox'
import mcpPlugin from '../src/index.ts'
import { testWithRedis } from './redis-test-utils.ts'
import { JSONRPC_VERSION, LATEST_LEGACY_PROTOCOL_VERSION, LATEST_PROTOCOL_VERSION } from '../src/schema.ts'
import { InputRequired, elicitForm } from '../src/modern/input-required.ts'
import { META_CLIENT_CAPABILITIES, META_PROTOCOL_VERSION, TASKS_EXTENSION } from '../src/schema-2026.ts'
import type { CreateTaskResult, CallToolResult } from '../src/schema.ts'

async function call (app: any, method: string, params: unknown, id = 1) {
  const response = await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: { 'mcp-protocol-version': LATEST_LEGACY_PROTOCOL_VERSION },
    payload: { jsonrpc: JSONRPC_VERSION, id, method, params }
  })
  return response.json()
}

async function modernCall (app: any, method: string, params: Record<string, unknown>, id = 1) {
  const capabilities = {
    extensions: { [TASKS_EXTENSION]: {} },
    elicitation: { form: {} }
  }
  const response = await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
      'mcp-method': method,
      ...(typeof params.name === 'string' ? { 'mcp-name': params.name } : {})
    },
    payload: {
      jsonrpc: JSONRPC_VERSION,
      id,
      method,
      params: {
        ...params,
        _meta: {
          [META_PROTOCOL_VERSION]: LATEST_PROTOCOL_VERSION,
          [META_CLIENT_CAPABILITIES]: capabilities
        }
      }
    }
  })
  return response.json()
}

describe('Redis task integration (multi-instance)', () => {
  testWithRedis('a task created on one instance is retrievable from another', async (redis, t) => {
    const redisOpts = {
      host: redis.options.host!,
      port: redis.options.port!,
      db: redis.options.db!
    }

    // Instance A owns the tool and will execute the task.
    const a = fastify()
    t.after(() => a.close())
    await a.register(mcpPlugin, { enableTasks: true, redis: redisOpts })
    a.mcpAddTool({
      name: 'slow-add',
      description: 'Adds two numbers, slowly',
      inputSchema: Type.Object({ a: Type.Number(), b: Type.Number() }),
      execution: { taskSupport: 'optional' }
    } as any, async (params: any): Promise<CallToolResult> => {
      await new Promise(resolve => setTimeout(resolve, 50))
      return { content: [{ type: 'text', text: String(params.a + params.b) }] }
    })
    await a.ready()

    // Instance B shares the same Redis but has no tool; it only reads the store.
    const b = fastify()
    t.after(() => b.close())
    await b.register(mcpPlugin, { enableTasks: true, redis: redisOpts })
    await b.ready()

    // Create the task on A
    const created = await call(a, 'tools/call', {
      name: 'slow-add',
      arguments: { a: 40, b: 2 },
      task: { ttl: 30_000 }
    })
    const taskId = (created.result as CreateTaskResult).task.taskId
    assert.ok(taskId)

    // Ask B for the result. Its in-process waiter will never fire, so this
    // exercises the polling path against the shared store.
    const result = await call(b, 'tasks/result', { taskId })
    assert.strictEqual(result.result.content[0].text, '42')
  })

  testWithRedis('modern task input published on one instance reaches the owning instance', async (redis, t) => {
    const redisOpts = {
      host: redis.options.host!,
      port: redis.options.port!,
      db: redis.options.db!
    }

    const a = fastify()
    t.after(() => a.close())
    await a.register(mcpPlugin, { enableTasks: true, redis: redisOpts })
    a.mcpAddTool({
      name: 'confirm',
      inputSchema: Type.Object({}),
      execution: { taskSupport: 'required' }
    } as any, async (_args: unknown, context: any): Promise<CallToolResult> => {
      const answer = context.inputResponses?.confirmation
      if (!answer) {
        throw new InputRequired({
          inputRequests: {
            confirmation: elicitForm('Confirm?', {
              type: 'object',
              properties: { value: { type: 'string' } },
              required: ['value']
            })
          }
        })
      }
      return { content: [{ type: 'text', text: answer.content.value }] }
    })
    await a.ready()

    const b = fastify()
    t.after(() => b.close())
    await b.register(mcpPlugin, { enableTasks: true, redis: redisOpts })
    await b.ready()

    const created = await modernCall(a, 'tools/call', { name: 'confirm', arguments: {} })
    const taskId = created.result.taskId

    let task: any
    for (let attempt = 0; attempt < 100; attempt++) {
      task = (await modernCall(b, 'tasks/get', { taskId }, 2)).result
      if (task.status === 'input_required') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.strictEqual(task.status, 'input_required')

    const updated = await modernCall(b, 'tasks/update', {
      taskId,
      inputResponses: { confirmation: { action: 'accept', content: { value: 'yes' } } }
    }, 3)
    assert.strictEqual(updated.result.resultType, 'complete')

    for (let attempt = 0; attempt < 100; attempt++) {
      task = (await modernCall(b, 'tasks/get', { taskId }, 4)).result
      if (task.status === 'completed') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.strictEqual(task.status, 'completed')
    assert.strictEqual(task.result.content[0].text, 'yes')
  })

  testWithRedis('tasks/get on a second instance sees the terminal state', async (redis, t) => {
    const redisOpts = {
      host: redis.options.host!,
      port: redis.options.port!,
      db: redis.options.db!
    }

    const a = fastify()
    t.after(() => a.close())
    await a.register(mcpPlugin, { enableTasks: true, redis: redisOpts })
    a.mcpAddTool({
      name: 'quick',
      description: 'Returns at once',
      inputSchema: Type.Object({}),
      execution: { taskSupport: 'optional' }
    } as any, async (): Promise<CallToolResult> => {
      return { content: [{ type: 'text', text: 'ok' }] }
    })
    await a.ready()

    const b = fastify()
    t.after(() => b.close())
    await b.register(mcpPlugin, { enableTasks: true, redis: redisOpts })
    await b.ready()

    const created = await call(a, 'tools/call', { name: 'quick', arguments: {}, task: {} })
    const taskId = (created.result as CreateTaskResult).task.taskId

    // Poll B until it observes A's completion via the shared store
    let status = 'working'
    for (let i = 0; i < 100 && status === 'working'; i++) {
      const body = await call(b, 'tasks/get', { taskId })
      status = body.result.status
      if (status === 'working') await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.strictEqual(status, 'completed')

    // B can also read the full result across instances
    const result = await call(b, 'tasks/result', { taskId })
    assert.strictEqual(result.result.content[0].text, 'ok')
  })
})
