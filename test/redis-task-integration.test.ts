import { describe } from 'node:test'
import assert from 'node:assert'
import fastify from 'fastify'
import { Type } from '@sinclair/typebox'
import mcpPlugin from '../src/index.ts'
import { testWithRedis } from './redis-test-utils.ts'
import { JSONRPC_VERSION, LATEST_PROTOCOL_VERSION, INVALID_PARAMS } from '../src/schema.ts'
import type { CreateTaskResult, CallToolResult } from '../src/schema.ts'
import { RedisTaskStore } from '../src/stores/redis-task-store.ts'
import { createTestAuthConfig, createTestJWT, setupMockAgent, generateMockJWKSResponse } from './auth-test-utils.ts'

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

  testWithRedis('an invalid task ttl is rejected and a valid one is stored', async (redis, t) => {
    const app = fastify()
    t.after(() => app.close())
    await app.register(mcpPlugin, {
      enableTasks: true,
      redis: { host: redis.options.host!, port: redis.options.port!, db: redis.options.db! }
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
    await a.register(mcpPlugin, { enableTasks: true, redis: redisOpts, taskLeaseMs })
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
    await b.register(mcpPlugin, { enableTasks: true, redis: redisOpts, taskLeaseMs })
    await b.ready()

    const created = await call(a, 'tools/call', { name: 'hang', arguments: {}, task: { ttl: 60_000 } })
    const taskId = (created.result as CreateTaskResult).task.taskId

    // While A is alive it keeps renewing, so B sees the task as working
    await new Promise(resolve => setTimeout(resolve, taskLeaseMs * 2))
    assert.strictEqual((await call(b, 'tasks/get', { taskId })).result.status, 'working')

    // B starts waiting for the result, then A goes away without finishing
    const started = Date.now()
    const pending = call(b, 'tasks/result', { taskId }, 2)
    await a.close()

    // tasks/result answers long before the 60s ttl
    const result = await pending
    assert.ok(Date.now() - started < 5_000)
    assert.strictEqual(result.id, 2)
    assert.match(result.error.message, /Task owner lost/)

    const task = (await call(b, 'tasks/get', { taskId })).result
    assert.strictEqual(task.status, 'failed')
    assert.match(task.statusMessage, /Task owner lost/)
  })

  testWithRedis('tasks/list reports a task whose instance died as failed', async (redis, t) => {
    const restoreMock = setupMockAgent({
      'https://auth.example.com/.well-known/jwks.json': generateMockJWKSResponse()
    })
    t.after(() => restoreMock())

    const redisOpts = {
      host: redis.options.host!,
      port: redis.options.port!,
      db: redis.options.db!
    }
    const taskLeaseMs = 150

    let release!: () => void
    const hang = new Promise<void>(resolve => { release = resolve })
    t.after(() => release())

    const app = fastify()
    t.after(() => app.close())
    await app.register(mcpPlugin, { enableTasks: true, redis: redisOpts, taskLeaseMs, authorization: createTestAuthConfig() })
    app.mcpAddTool({
      name: 'hang',
      description: 'Runs until released',
      inputSchema: Type.Object({}),
      execution: { taskSupport: 'optional' }
    } as any, async (): Promise<CallToolResult> => {
      await hang
      return { content: [{ type: 'text', text: 'late' }] }
    })
    await app.ready()

    const token = createTestJWT({ sub: 'user-330' })
    const authedCall = async (method: string, params: unknown) => {
      const res = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { authorization: `Bearer ${token}`, 'mcp-protocol-version': LATEST_PROTOCOL_VERSION },
        payload: { jsonrpc: JSONRPC_VERSION, id: 1, method, params }
      })
      return res.json()
    }

    const created = await authedCall('tools/call', { name: 'hang', arguments: {}, task: { ttl: 60_000 } })
    const taskId = (created.result as CreateTaskResult).task.taskId

    // Simulate the owning instance crashing: its renewals stop landing
    t.mock.method(RedisTaskStore.prototype, 'renewLease', async () => true)
    await new Promise(resolve => setTimeout(resolve, taskLeaseMs * 4))

    const list = (await authedCall('tasks/list', {})).result
    assert.deepStrictEqual(list.tasks.map((x: any) => [x.taskId, x.status]), [[taskId, 'failed']])
    assert.match(list.tasks[0].statusMessage, /Task owner lost/)
    assert.strictEqual('leaseExpiresAt' in list.tasks[0], false)
  })

  testWithRedis('tasks/get fails a task left behind with an expired lease', async (redis, t) => {
    const app = fastify()
    t.after(() => app.close())
    await app.register(mcpPlugin, {
      enableTasks: true,
      redis: { host: redis.options.host!, port: redis.options.port!, db: redis.options.db! }
    })
    await app.ready()

    // As written by an instance that died right after its last renewal
    const now = new Date().toISOString()
    await redis.set('mcp:task:orphan', JSON.stringify({
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
    await a.register(mcpPlugin, { enableTasks: true, redis: redisOpts, taskLeaseMs })
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
    await b.register(mcpPlugin, { enableTasks: true, redis: redisOpts, taskLeaseMs })
    await b.ready()

    const first = (await call(a, 'tools/call', { name: 'hang', arguments: {}, task: { ttl: 60_000 } })).result.task.taskId
    const second = (await call(a, 'tools/call', { name: 'hang', arguments: {}, task: { ttl: 60_000 } })).result.task.taskId

    // A goes away; by the Redis clock both leases lapse within taskLeaseMs
    await a.close()
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
