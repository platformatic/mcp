import { test, describe } from 'node:test'
import type { TestContext } from 'node:test'
import Fastify from 'fastify'
import { Type } from '@sinclair/typebox'
import mcpPlugin from '../src/index.ts'
import { JSONRPC_VERSION, METHOD_NOT_FOUND, INVALID_PARAMS } from '../src/schema.ts'
import type { Task, CreateTaskResult, ListTasksResult, CallToolResult } from '../src/schema.ts'
import { MemoryTaskStore } from '../src/stores/memory-task-store.ts'
import { canTransition, isTerminal, taskHasExpired, toWireTask } from '../src/stores/task-store.ts'
import type { TaskRecord } from '../src/stores/task-store.ts'
import { resolveTaskAugmentation, RELATED_TASK_META_KEY } from '../src/handlers.ts'

function record (overrides: Partial<TaskRecord> = {}): TaskRecord {
  const now = new Date().toISOString()
  return {
    taskId: 'task-1',
    status: 'working',
    createdAt: now,
    lastUpdatedAt: now,
    ttl: 60_000,
    method: 'tools/call',
    ...overrides
  }
}

async function call (app: any, method: string, params: unknown, id = 1) {
  const response = await app.inject({
    method: 'POST',
    url: '/mcp',
    payload: { jsonrpc: JSONRPC_VERSION, id, method, params }
  })
  return response.json()
}

/** Poll tasks/get until the task leaves the `working` state */
async function waitForTerminal (app: any, taskId: string): Promise<Task> {
  for (let i = 0; i < 100; i++) {
    const body = await call(app, 'tasks/get', { taskId })
    if (body.result && isTerminal(body.result.status)) {
      return body.result
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('task never reached a terminal status')
}

async function buildApp (t: TestContext, opts: Record<string, unknown> = {}) {
  const app = Fastify({ logger: false })
  t.after(() => app.close())
  await app.register(mcpPlugin, { enableTasks: true, ...opts })

  app.mcpAddTool({
    name: 'slow-add',
    description: 'Adds two numbers, slowly',
    inputSchema: Type.Object({ a: Type.Number(), b: Type.Number() }),
    execution: { taskSupport: 'optional' }
  } as any, async (params: any): Promise<CallToolResult> => {
    await new Promise(resolve => setTimeout(resolve, 20))
    return { content: [{ type: 'text', text: String(params.a + params.b) }] }
  })

  app.mcpAddTool({
    name: 'task-only',
    description: 'Must be invoked as a task',
    inputSchema: Type.Object({}),
    execution: { taskSupport: 'required' }
  } as any, async (): Promise<CallToolResult> => {
    return { content: [{ type: 'text', text: 'done' }] }
  })

  app.mcpAddTool({
    name: 'plain',
    description: 'No task support',
    inputSchema: Type.Object({})
  } as any, async (): Promise<CallToolResult> => {
    return { content: [{ type: 'text', text: 'plain' }] }
  })

  app.mcpAddTool({
    name: 'boom',
    description: 'Always fails',
    inputSchema: Type.Object({}),
    execution: { taskSupport: 'optional' }
  } as any, async (): Promise<CallToolResult> => {
    return { content: [{ type: 'text', text: 'nope' }], isError: true }
  })

  await app.ready()
  return app
}

describe('task store', () => {
  test('rejects transitions out of a terminal status', (t: TestContext) => {
    t.assert.strictEqual(canTransition('working', 'completed'), true)
    t.assert.strictEqual(canTransition('working', 'input_required'), true)
    t.assert.strictEqual(canTransition('input_required', 'working'), true)
    t.assert.strictEqual(canTransition('completed', 'working'), false)
    t.assert.strictEqual(canTransition('cancelled', 'completed'), false)
  })

  test('identifies terminal statuses', (t: TestContext) => {
    t.assert.strictEqual(isTerminal('completed'), true)
    t.assert.strictEqual(isTerminal('failed'), true)
    t.assert.strictEqual(isTerminal('cancelled'), true)
    t.assert.strictEqual(isTerminal('working'), false)
    t.assert.strictEqual(isTerminal('input_required'), false)
  })

  test('expires tasks once ttl has elapsed since creation', (t: TestContext) => {
    const created = new Date(Date.now() - 10_000).toISOString()
    t.assert.strictEqual(taskHasExpired(record({ createdAt: created, ttl: 5_000 })), true)
    t.assert.strictEqual(taskHasExpired(record({ createdAt: created, ttl: 60_000 })), false)
    // A null ttl means unlimited retention
    t.assert.strictEqual(taskHasExpired(record({ createdAt: created, ttl: null })), false)
  })

  test('toWireTask drops storage-only fields', (t: TestContext) => {
    const wire = toWireTask(record({ authSubject: 'user-1', outcome: { jsonrpc: '2.0', id: 1, result: {} } }))
    t.assert.strictEqual('authSubject' in wire, false)
    t.assert.strictEqual('method' in wire, false)
    t.assert.strictEqual('outcome' in wire, false)
    t.assert.strictEqual(wire.taskId, 'task-1')
  })

  test('MemoryTaskStore enforces the status machine', async (t: TestContext) => {
    const store = new MemoryTaskStore()
    await store.create(record())

    const working = await store.updateStatus('task-1', 'input_required')
    t.assert.strictEqual(working?.status, 'input_required')

    await store.updateStatus('task-1', 'completed')
    await t.assert.rejects(
      () => store.updateStatus('task-1', 'working'),
      /terminal status/
    )
  })

  test('MemoryTaskStore treats expired tasks as absent', async (t: TestContext) => {
    const store = new MemoryTaskStore()
    await store.create(record({ createdAt: new Date(Date.now() - 10_000).toISOString(), ttl: 1_000 }))
    t.assert.strictEqual(await store.get('task-1'), null)
  })

  test('MemoryTaskStore isolates tasks by authorization subject', async (t: TestContext) => {
    const store = new MemoryTaskStore()
    await store.create(record({ taskId: 'a', authSubject: 'user-1' }))
    await store.create(record({ taskId: 'b', authSubject: 'user-2' }))
    await store.create(record({ taskId: 'c' }))

    t.assert.deepStrictEqual((await store.list('user-1')).map(x => x.taskId), ['a'])
    t.assert.deepStrictEqual((await store.list('user-2')).map(x => x.taskId), ['b'])
    t.assert.deepStrictEqual((await store.list()).map(x => x.taskId), ['c'])
  })
})

describe('task augmentation rules', () => {
  const tool = (taskSupport?: string) => ({
    definition: { name: 't', ...(taskSupport ? { execution: { taskSupport } } : {}) }
  }) as any

  test('forbidden by default', (t: TestContext) => {
    t.assert.deepStrictEqual(resolveTaskAugmentation(tool(), false), { mode: 'direct' })
    t.assert.ok('error' in resolveTaskAugmentation(tool(), true))
  })

  test('optional allows either form', (t: TestContext) => {
    t.assert.deepStrictEqual(resolveTaskAugmentation(tool('optional'), true), { mode: 'task' })
    t.assert.deepStrictEqual(resolveTaskAugmentation(tool('optional'), false), { mode: 'direct' })
  })

  test('required rejects a direct call', (t: TestContext) => {
    t.assert.deepStrictEqual(resolveTaskAugmentation(tool('required'), true), { mode: 'task' })
    t.assert.ok('error' in resolveTaskAugmentation(tool('required'), false))
  })
})

describe('tasks over the wire', () => {
  test('capabilities advertise tasks, without list when unauthenticated', async (t: TestContext) => {
    const app = await buildApp(t)
    const body = await call(app, 'initialize', { protocolVersion: '2025-11-25', capabilities: {} })

    t.assert.deepStrictEqual(body.result.capabilities.tasks, {
      cancel: {},
      requests: { tools: { call: {} } }
    })
  })

  test('tools/list exposes execution.taskSupport', async (t: TestContext) => {
    const app = await buildApp(t)
    const body = await call(app, 'tools/list', {})
    const tools = body.result.tools as any[]

    t.assert.strictEqual(tools.find(x => x.name === 'slow-add').execution.taskSupport, 'optional')
    t.assert.strictEqual(tools.find(x => x.name === 'plain').execution, undefined)
  })

  test('a task-augmented call returns CreateTaskResult, then the real result', async (t: TestContext) => {
    const app = await buildApp(t)

    const created = await call(app, 'tools/call', {
      name: 'slow-add',
      arguments: { a: 2, b: 3 },
      task: { ttl: 30_000 }
    })

    const result = created.result as CreateTaskResult
    t.assert.ok(result.task.taskId)
    t.assert.strictEqual(result.task.status, 'working')
    t.assert.strictEqual(result.task.ttl, 30_000)
    t.assert.ok(result.task.createdAt)
    t.assert.ok(result.task.lastUpdatedAt)
    // The tool result is deliberately absent from the creation response
    t.assert.strictEqual('content' in result, false)

    const finished = await waitForTerminal(app, result.task.taskId)
    t.assert.strictEqual(finished.status, 'completed')

    const body = await call(app, 'tasks/result', { taskId: result.task.taskId })
    t.assert.strictEqual(body.result.content[0].text, '5')
    t.assert.deepStrictEqual(body.result._meta[RELATED_TASK_META_KEY], { taskId: result.task.taskId })
  })

  test('tasks/result blocks until the task is terminal', async (t: TestContext) => {
    const app = await buildApp(t)

    const created = await call(app, 'tools/call', {
      name: 'slow-add',
      arguments: { a: 1, b: 1 },
      task: {}
    })
    const taskId = (created.result as CreateTaskResult).task.taskId

    // Asked for immediately, while the tool is still sleeping
    const body = await call(app, 'tasks/result', { taskId })
    t.assert.strictEqual(body.result.content[0].text, '2')
  })

  test('a tool returning isError makes the task fail', async (t: TestContext) => {
    const app = await buildApp(t)

    const created = await call(app, 'tools/call', { name: 'boom', arguments: {}, task: {} })
    const taskId = (created.result as CreateTaskResult).task.taskId

    const finished = await waitForTerminal(app, taskId)
    t.assert.strictEqual(finished.status, 'failed')
    t.assert.ok(finished.statusMessage)

    // tasks/result still returns exactly what the call would have returned
    const body = await call(app, 'tasks/result', { taskId })
    t.assert.strictEqual(body.result.isError, true)
  })

  test('a tool with taskSupport required refuses a direct call', async (t: TestContext) => {
    const app = await buildApp(t)
    const body = await call(app, 'tools/call', { name: 'task-only', arguments: {} })

    t.assert.strictEqual(body.error.code, METHOD_NOT_FOUND)
    t.assert.match(body.error.message, /requires task-augmented execution/)
  })

  test('a tool without task support refuses a task-augmented call', async (t: TestContext) => {
    const app = await buildApp(t)
    const body = await call(app, 'tools/call', { name: 'plain', arguments: {}, task: {} })

    t.assert.strictEqual(body.error.code, METHOD_NOT_FOUND)
    t.assert.match(body.error.message, /does not support task-augmented execution/)
  })

  test('tasks/cancel moves a task to cancelled and then refuses', async (t: TestContext) => {
    const app = await buildApp(t)

    const created = await call(app, 'tools/call', { name: 'slow-add', arguments: { a: 1, b: 2 }, task: {} })
    const taskId = (created.result as CreateTaskResult).task.taskId

    const cancelled = await call(app, 'tasks/cancel', { taskId })
    t.assert.strictEqual(cancelled.result.status, 'cancelled')

    const again = await call(app, 'tasks/cancel', { taskId })
    t.assert.strictEqual(again.error.code, INVALID_PARAMS)
    t.assert.match(again.error.message, /terminal status/)
  })

  test('unknown task ids are invalid params, not internal errors', async (t: TestContext) => {
    const app = await buildApp(t)

    for (const method of ['tasks/get', 'tasks/result', 'tasks/cancel']) {
      const body = await call(app, method, { taskId: 'does-not-exist' })
      t.assert.strictEqual(body.error.code, INVALID_PARAMS, `${method} should return INVALID_PARAMS`)
    }
  })

  test('a missing taskId is rejected', async (t: TestContext) => {
    const app = await buildApp(t)
    const body = await call(app, 'tasks/get', {})
    t.assert.strictEqual(body.error.code, INVALID_PARAMS)
  })

  test('tasks/list returns created tasks', async (t: TestContext) => {
    const app = await buildApp(t)

    await call(app, 'tools/call', { name: 'slow-add', arguments: { a: 1, b: 1 }, task: {} })
    await call(app, 'tools/call', { name: 'slow-add', arguments: { a: 2, b: 2 }, task: {} })

    const body = await call(app, 'tasks/list', {})
    const result = body.result as ListTasksResult
    t.assert.strictEqual(result.tasks.length, 2)
    // Storage-only fields must never reach the wire
    t.assert.strictEqual('outcome' in result.tasks[0], false)
  })

  test('task methods are unavailable when tasks are disabled', async (t: TestContext) => {
    const app = Fastify({ logger: false })
    t.after(() => app.close())
    await app.register(mcpPlugin)
    await app.ready()

    const body = await call(app, 'tasks/get', { taskId: 'x' })
    t.assert.strictEqual(body.error.code, METHOD_NOT_FOUND)

    const init = await call(app, 'initialize', { protocolVersion: '2025-11-25', capabilities: {} })
    t.assert.strictEqual(init.result.capabilities.tasks, undefined)
  })
})
