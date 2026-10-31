import { describe } from 'node:test'
import assert from 'node:assert'
import fastify from 'fastify'
import { Type } from '@sinclair/typebox'
import mcpPlugin from '../src/index.ts'
import { RedisTaskStore } from '../src/stores/redis-task-store.ts'
import { testWithRedis } from './redis-test-utils.ts'
import { JSONRPC_VERSION, LATEST_LEGACY_PROTOCOL_VERSION, LATEST_PROTOCOL_VERSION, INVALID_PARAMS } from '../src/schema.ts'
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
    await a.register(mcpPlugin, { enableTasks: true, redis: redisOpts, requestStateSecret: 'test-request-state-secret-32-bytes!!' })
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
    await b.register(mcpPlugin, { enableTasks: true, redis: redisOpts, requestStateSecret: 'test-request-state-secret-32-bytes!!' })
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
    await a.register(mcpPlugin, { enableTasks: true, redis: redisOpts, requestStateSecret: 'test-request-state-secret-32-bytes!!' })
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
    await b.register(mcpPlugin, { enableTasks: true, redis: redisOpts, requestStateSecret: 'test-request-state-secret-32-bytes!!' })
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

  testWithRedis('tasks/update ignores a malformed unknown key and keeps the valid answer', async (redis, t) => {
    const redisOpts = {
      host: redis.options.host!,
      port: redis.options.port!,
      db: redis.options.db!
    }

    const app = fastify()
    t.after(() => app.close())
    await app.register(mcpPlugin, { enableTasks: true, redis: redisOpts, requestStateSecret: 'test-request-state-secret-32-bytes!!' })
    app.mcpAddTool({
      name: 'confirm',
      inputSchema: Type.Object({}),
      execution: { taskSupport: 'required' }
    } as any, async (_args: unknown, context: any): Promise<CallToolResult> => {
      if (!context.inputResponses?.q) {
        throw new InputRequired({ inputRequests: { q: elicitForm('?', { type: 'object', properties: {} }) } })
      }
      return { content: [{ type: 'text', text: 'answered' }] }
    })
    await app.ready()

    const taskId = (await modernCall(app, 'tools/call', { name: 'confirm', arguments: {} })).result.taskId
    let task: any
    for (let attempt = 0; attempt < 100 && task?.status !== 'input_required'; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10))
      task = (await modernCall(app, 'tasks/get', { taskId }, 2)).result
    }

    // A lone surrogate cannot be encoded for the store's script.
    const updated = await modernCall(app, 'tasks/update', {
      taskId,
      inputResponses: { '\ud800': { action: 'accept' }, q: { action: 'accept', content: {} } }
    }, 3)
    assert.strictEqual(updated.error, undefined, JSON.stringify(updated))

    for (let attempt = 0; attempt < 100 && task?.status !== 'completed'; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10))
      task = (await modernCall(app, 'tasks/get', { taskId }, 4)).result
    }
    assert.strictEqual(task.result?.content?.[0]?.text, 'answered')
  })

  testWithRedis('tasks/get on a second instance sees the terminal state', async (redis, t) => {
    const redisOpts = {
      host: redis.options.host!,
      port: redis.options.port!,
      db: redis.options.db!
    }

    const a = fastify()
    t.after(() => a.close())
    await a.register(mcpPlugin, { enableTasks: true, redis: redisOpts, requestStateSecret: 'test-request-state-secret-32-bytes!!' })
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
    await b.register(mcpPlugin, { enableTasks: true, redis: redisOpts, requestStateSecret: 'test-request-state-secret-32-bytes!!' })
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

  testWithRedis('an invalid task ttl is rejected and a valid one is stored', async (redis, t) => {
    const app = fastify()
    t.after(() => app.close())
    await app.register(mcpPlugin, {
      enableTasks: true,
      redis: { host: redis.options.host!, port: redis.options.port!, db: redis.options.db! },
      requestStateSecret: 'test-request-state-secret-32-bytes!!'
    })
    app.mcpAddTool({
      name: 'quick',
      description: 'Returns at once',
      inputSchema: Type.Object({}),
      execution: { taskSupport: 'optional' }
    } as any, async (): Promise<CallToolResult> => {
      return { content: [{ type: 'text', text: 'ok' }] }
    })
    await app.ready()

    // A non-numeric ttl used to reach `SET ... EX NaN` and throw
    for (const ttl of ['forever', -5, 1.5]) {
      const body = await call(app, 'tools/call', { name: 'quick', arguments: {}, task: { ttl } })
      assert.strictEqual(body.error.code, INVALID_PARAMS)
    }

    const created = await call(app, 'tools/call', { name: 'quick', arguments: {}, task: { ttl: 30_000 } })
    const taskId = (created.result as CreateTaskResult).task.taskId
    assert.strictEqual((created.result as CreateTaskResult).task.ttl, 30_000)
    const result = await call(app, 'tasks/result', { taskId })
    assert.strictEqual(result.result.content[0].text, 'ok')
  })

  testWithRedis('a task whose instance dies is reported failed by another instance', async (redis, t) => {
    const redisOpts = {
      host: redis.options.host!,
      port: redis.options.port!,
      db: redis.options.db!
    }
    const taskLeaseMs = 150

    // The tool on A never finishes on its own; A will go away mid-run.
    let release!: () => void
    const hang = new Promise<void>(resolve => { release = resolve })
    t.after(() => release())

    const a = fastify()
    t.after(() => a.close())
    await a.register(mcpPlugin, { enableTasks: true, redis: redisOpts, requestStateSecret: 'redis-task-integration-test-secret-0123456789', taskLeaseMs })
    a.mcpAddTool({
      name: 'hang',
      description: 'Runs until released',
      inputSchema: Type.Object({}),
      execution: { taskSupport: 'optional' }
    } as any, async (): Promise<CallToolResult> => {
      await hang
      return { content: [{ type: 'text', text: 'late' }] }
    })
    await a.ready()

    const b = fastify()
    t.after(() => b.close())
    await b.register(mcpPlugin, { enableTasks: true, redis: redisOpts, requestStateSecret: 'redis-task-integration-test-secret-0123456789', taskLeaseMs })
    await b.ready()

    const created = await call(a, 'tools/call', { name: 'hang', arguments: {}, task: { ttl: 60_000 } })
    const taskId = (created.result as CreateTaskResult).task.taskId

    // While A is alive it keeps renewing, so B sees the task as working
    await new Promise(resolve => setTimeout(resolve, taskLeaseMs * 2))
    assert.strictEqual((await call(b, 'tasks/get', { taskId })).result.status, 'working')

    // B starts waiting for the result, then A dies without finishing. A
    // graceful close would record the task failed itself; a crash only stops
    // the renewals.
    const started = Date.now()
    const pending = call(b, 'tasks/result', { taskId }, 2)
    t.mock.method(RedisTaskStore.prototype, 'renewLease', async () => 'working')

    // tasks/result answers long before the 60s ttl
    const result = await pending
    assert.ok(Date.now() - started < 5_000)
    assert.strictEqual(result.id, 2)
    assert.match(result.error.message, /Task owner lost/)

    const task = (await call(b, 'tasks/get', { taskId })).result
    assert.strictEqual(task.status, 'failed')
    assert.match(task.statusMessage, /Task owner lost/)
  })

  testWithRedis('tasks/get fails a task left behind with an expired lease', async (redis, t) => {
    const app = fastify()
    t.after(() => app.close())
    await app.register(mcpPlugin, {
      enableTasks: true,
      redis: { host: redis.options.host!, port: redis.options.port!, db: redis.options.db! },
      requestStateSecret: 'redis-task-integration-test-secret-0123456789'
    })
    await app.ready()

    // As written by an instance that died right after its last renewal
    const now = new Date().toISOString()
    await redis.set('mcp:task:v3:orphan', JSON.stringify({
      taskId: 'orphan',
      status: 'working',
      createdAt: now,
      lastUpdatedAt: now,
      ttl: 60_000,
      pollInterval: 1000,
      method: 'tools/call',
      leaseExpiresAt: Date.now() - 1
    }), 'EX', 60)

    const task = (await call(app, 'tasks/get', { taskId: 'orphan' })).result
    assert.strictEqual(task.status, 'failed')
    assert.match(task.statusMessage, /Task owner lost/)
    assert.strictEqual('leaseExpiresAt' in task, false)

    const result = await call(app, 'tasks/result', { taskId: 'orphan' }, 3)
    assert.strictEqual(result.id, 3)
    assert.match(result.error.message, /Task owner lost/)
  })

  testWithRedis('a reader whose clock runs behind Redis still fails an expired lease promptly', async (redis, t) => {
    const redisOpts = {
      host: redis.options.host!,
      port: redis.options.port!,
      db: redis.options.db!
    }
    const taskLeaseMs = 150

    let release!: () => void
    const hang = new Promise<void>(resolve => { release = resolve })
    t.after(() => release())

    const a = fastify()
    t.after(() => a.close())
    await a.register(mcpPlugin, { enableTasks: true, redis: redisOpts, requestStateSecret: 'redis-task-integration-test-secret-0123456789', taskLeaseMs })
    a.mcpAddTool({
      name: 'hang',
      description: 'Runs until released',
      inputSchema: Type.Object({}),
      execution: { taskSupport: 'optional' }
    } as any, async (): Promise<CallToolResult> => {
      await hang
      return { content: [{ type: 'text', text: 'late' }] }
    })
    await a.ready()

    const b = fastify()
    t.after(() => b.close())
    await b.register(mcpPlugin, { enableTasks: true, redis: redisOpts, requestStateSecret: 'redis-task-integration-test-secret-0123456789', taskLeaseMs })
    await b.ready()

    const first = (await call(a, 'tools/call', { name: 'hang', arguments: {}, task: { ttl: 60_000 } })).result.task.taskId
    const second = (await call(a, 'tools/call', { name: 'hang', arguments: {}, task: { ttl: 60_000 } })).result.task.taskId

    // A dies (its renewals stop); by the Redis clock both leases lapse within
    // taskLeaseMs
    t.mock.method(RedisTaskStore.prototype, 'renewLease', async () => 'working')
    await new Promise(resolve => setTimeout(resolve, taskLeaseMs * 3))

    // From here on the reader's clock runs five minutes behind Redis
    const realNow = Date.now.bind(Date)
    t.mock.method(Date, 'now', () => realNow() - 5 * 60_000)

    // tasks/result must not wait on the local clock to catch up
    let timer: ReturnType<typeof setTimeout> | undefined
    const result = await Promise.race([
      call(b, 'tasks/result', { taskId: first }, 2),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('tasks/result still blocked')), 3000)
      })
    ]).finally(() => clearTimeout(timer))
    assert.strictEqual(result.id, 2)
    assert.match(result.error.message, /Task owner lost/)

    const task = (await call(b, 'tasks/get', { taskId: second })).result
    assert.strictEqual(task.status, 'failed')
    assert.match(task.statusMessage, /Task owner lost/)
  })
})
