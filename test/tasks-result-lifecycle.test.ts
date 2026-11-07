import { test, describe } from 'node:test'
import type { TestContext } from 'node:test'
import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import Fastify from 'fastify'
import { Type } from '@sinclair/typebox'
import mcpPlugin from '../src/index.ts'
import { JSONRPC_VERSION, LATEST_PROTOCOL_VERSION, INTERNAL_ERROR } from '../src/schema.ts'
import type { CreateTaskResult, CallToolResult } from '../src/schema.ts'
import { MemoryTaskStore } from '../src/stores/memory-task-store.ts'
import { RedisTaskStore } from '../src/stores/redis-task-store.ts'
import { TaskWaiters } from '../src/stores/task-store.ts'
import { testWithRedis } from './redis-test-utils.ts'

async function call (app: any, method: string, params: unknown, id = 1) {
  const response = await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: { 'mcp-protocol-version': LATEST_PROTOCOL_VERSION },
    payload: { jsonrpc: JSONRPC_VERSION, id, method, params }
  })
  return response.json()
}

/** Send a JSON-RPC request over a real socket; resolves with the parsed body */
function post (port: number, method: string, params: unknown) {
  const payload = JSON.stringify({ jsonrpc: JSONRPC_VERSION, id: 1, method, params })
  const req = httpRequest({
    host: '127.0.0.1',
    port,
    method: 'POST',
    path: '/mcp',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
      'mcp-protocol-version': LATEST_PROTOCOL_VERSION
    }
  })
  const body = new Promise<any>((resolve, reject) => {
    req.on('response', (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        try {
          resolve(JSON.parse(data))
        } catch (err) {
          reject(err)
        }
      })
      res.on('error', reject)
    })
    req.on('error', reject)
  })
  req.end(payload)
  return { req, body }
}

/** A promise the test can release by hand */
function gate () {
  let open!: () => void
  const opened = new Promise<void>(resolve => { open = resolve })
  return { opened, open }
}

function addGatedTool (app: any, opened: Promise<void>) {
  app.mcpAddTool({
    name: 'gated',
    description: 'Finishes when the test opens the gate',
    inputSchema: Type.Object({}),
    execution: { taskSupport: 'optional' }
  } as any, async (): Promise<CallToolResult> => {
    await opened
    return { content: [{ type: 'text', text: 'done' }] }
  })
}

describe('legacy tasks/result lifecycle', () => {
  test('stops polling once the client disconnects', async (t: TestContext) => {
    const { opened, open } = gate()
    t.after(open)

    const getCalls: string[] = []
    const originalGet = MemoryTaskStore.prototype.get
    MemoryTaskStore.prototype.get = function (taskId: string) {
      getCalls.push(taskId)
      return originalGet.call(this, taskId)
    }
    t.after(() => { MemoryTaskStore.prototype.get = originalGet })

    const app = Fastify({ logger: false })
    t.after(() => app.close())
    await app.register(mcpPlugin, { enableTasks: true })
    addGatedTool(app, opened)
    await app.listen({ port: 0, host: '127.0.0.1' })
    const { port } = app.server.address() as AddressInfo

    const created = await call(app, 'tools/call', { name: 'gated', arguments: {}, task: {} })
    const taskId = (created.result as CreateTaskResult).task.taskId

    const { req, body } = post(port, 'tasks/result', { taskId })
    body.catch(() => {})
    await sleep(300)
    req.destroy()

    // Give the server a moment to notice, then make sure it stopped polling.
    await sleep(200)
    const afterDisconnect = getCalls.filter(id => id === taskId).length
    await sleep(2500)
    t.assert.strictEqual(getCalls.filter(id => id === taskId).length, afterDisconnect)
  })

  testWithRedis('does not leak waiters when the task completes on another instance', async (redis, t: TestContext) => {
    const redisOpts = { host: redis.options.host!, port: redis.options.port!, db: redis.options.db! }

    const instances = new Set<TaskWaiters>()
    const originalWait = TaskWaiters.prototype.wait
    TaskWaiters.prototype.wait = function (taskId: string, signal?: AbortSignal) {
      instances.add(this)
      return originalWait.call(this, taskId, signal)
    }
    t.after(() => { TaskWaiters.prototype.wait = originalWait })

    // A runs the tasks
    const a = Fastify({ logger: false })
    t.after(() => a.close())
    await a.register(mcpPlugin, { enableTasks: true, redis: redisOpts })
    a.mcpAddTool({
      name: 'quick',
      description: 'Finishes shortly',
      inputSchema: Type.Object({}),
      execution: { taskSupport: 'optional' }
    } as any, async (): Promise<CallToolResult> => {
      await sleep(50)
      return { content: [{ type: 'text', text: 'ok' }] }
    })
    await a.ready()

    // B only serves tasks/result
    const b = Fastify({ logger: false })
    t.after(() => b.close())
    await b.register(mcpPlugin, { enableTasks: true, redis: redisOpts })
    await b.ready()

    const results = await Promise.all(Array.from({ length: 5 }, async () => {
      const created = await call(a, 'tools/call', { name: 'quick', arguments: {}, task: {} })
      const taskId = (created.result as CreateTaskResult).task.taskId
      return call(b, 'tasks/result', { taskId })
    }))
    for (const result of results) {
      t.assert.strictEqual(result.result.content[0].text, 'ok')
    }

    t.assert.ok(instances.size > 0, 'tasks/result should have registered waiters')
    let pending = 0
    for (const waiters of instances) {
      pending += (waiters as any).waiters.size
    }
    t.assert.strictEqual(pending, 0)
  })

  testWithRedis('app.close() interrupts a tasks/result waiting on another instance', async (redis, t: TestContext) => {
    const redisOpts = { host: redis.options.host!, port: redis.options.port!, db: redis.options.db! }
    const { opened, open } = gate()
    // Bound the damage when the fix is missing: A's task ends after 8s.
    const release = setTimeout(open, 8000)
    t.after(() => clearTimeout(release))

    // A owns a task that will not finish until the test is over
    const a = Fastify({ logger: false })
    t.after(async () => {
      open()
      await a.close()
    })
    await a.register(mcpPlugin, { enableTasks: true, redis: redisOpts })
    addGatedTool(a, opened)
    await a.ready()

    const b = Fastify({ logger: false })
    let bClosed = false
    t.after(() => bClosed ? undefined : b.close())
    await b.register(mcpPlugin, { enableTasks: true, redis: redisOpts })
    await b.listen({ port: 0, host: '127.0.0.1' })
    const { port } = b.server.address() as AddressInfo

    const created = await call(a, 'tools/call', { name: 'gated', arguments: {}, task: {} })
    const taskId = (created.result as CreateTaskResult).task.taskId

    const { body } = post(port, 'tasks/result', { taskId })
    await sleep(300)

    const start = Date.now()
    await b.close()
    bClosed = true
    const elapsed = Date.now() - start

    // Without the shutdown signal this waits for A's task, i.e. forever here.
    t.assert.ok(elapsed < 3000, `close() took ${elapsed}ms`)

    const response = await body
    t.assert.strictEqual(response.id, 1)
    t.assert.strictEqual(response.error.code, INTERNAL_ERROR)
    t.assert.match(response.error.message, /shutting down/i)
  })
})

describe('TaskWaiters with an already-aborted signal', () => {
  test('rejects at once and registers nothing', async (t: TestContext) => {
    const waiters = new TaskWaiters()
    const controller = new AbortController()
    controller.abort()

    await t.assert.rejects(waiters.wait('task-1', controller.signal), /aborted/)
    t.assert.strictEqual((waiters as any).waiters.size, 0)
  })

  test('a waiter registered before the abort is removed by it', async (t: TestContext) => {
    const waiters = new TaskWaiters()
    const controller = new AbortController()

    const pending = waiters.wait('task-1', controller.signal)
    t.assert.strictEqual((waiters as any).waiters.size, 1)
    controller.abort()

    await t.assert.rejects(pending, /aborted/)
    t.assert.strictEqual((waiters as any).waiters.size, 0)
  })
})

/**
 * Send tasks/result, but tear the connection down on the server side right
 * after the handler has read the task, i.e. before it starts waiting. This is
 * the window in which handleTasksResult finds the response already destroyed.
 */
async function resultFromDisconnectedClient (t: TestContext, opts: Record<string, unknown>, Store: any) {
  const { opened, open } = gate()
  t.after(open)

  const instances = new Set<TaskWaiters>()
  const originalWait = TaskWaiters.prototype.wait
  TaskWaiters.prototype.wait = function (taskId: string, signal?: AbortSignal) {
    instances.add(this)
    return originalWait.call(this, taskId, signal)
  }
  t.after(() => { TaskWaiters.prototype.wait = originalWait })

  const app = Fastify({ logger: false })
  t.after(() => app.close())
  await app.register(mcpPlugin, { enableTasks: true, ...opts })
  addGatedTool(app, opened)
  await app.listen({ port: 0, host: '127.0.0.1' })
  const { port } = app.server.address() as AddressInfo

  const sockets = new Set<import('node:net').Socket>()
  app.server.on('connection', (socket) => sockets.add(socket))

  const created = await call(app, 'tools/call', { name: 'gated', arguments: {}, task: {} })
  const taskId = (created.result as CreateTaskResult).task.taskId

  let disconnected = false
  const originalGet = Store.prototype.get
  Store.prototype.get = async function (id: string) {
    const task = await originalGet.call(this, id)
    if (id === taskId && !disconnected) {
      disconnected = true
      for (const socket of sockets) socket.destroy()
    }
    return task
  }
  t.after(() => { Store.prototype.get = originalGet })

  const { body } = post(port, 'tasks/result', { taskId })
  await body.catch(() => {})
  await sleep(100)

  t.assert.strictEqual(disconnected, true)
  let pending = 0
  for (const waiters of instances) {
    pending += (waiters as any).waiters.size
  }
  // The task is still running here, so only a leak could leave a waiter behind
  t.assert.strictEqual(pending, 0)
}

describe('tasks/result from a client that already disconnected', () => {
  test('leaves no waiter behind (memory)', async (t: TestContext) => {
    await resultFromDisconnectedClient(t, {}, MemoryTaskStore)
  })

  testWithRedis('leaves no waiter behind (redis)', async (redis, t: TestContext) => {
    const redisOpts = { host: redis.options.host!, port: redis.options.port!, db: redis.options.db! }
    await resultFromDisconnectedClient(t, { redis: redisOpts }, RedisTaskStore)
  })
})
