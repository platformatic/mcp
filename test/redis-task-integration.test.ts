import { describe } from 'node:test'
import assert from 'node:assert'
import fastify from 'fastify'
import { Type } from '@sinclair/typebox'
import mcpPlugin from '../src/index.ts'
import { testWithRedis } from './redis-test-utils.ts'
import { JSONRPC_VERSION, LATEST_PROTOCOL_VERSION } from '../src/schema.ts'
import type { CreateTaskResult, CallToolResult } from '../src/schema.ts'

async function call (app: any, method: string, params: unknown, id = 1) {
  const response = await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: { 'mcp-protocol-version': LATEST_PROTOCOL_VERSION },
    payload: { jsonrpc: JSONRPC_VERSION, id, method, params }
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
