import { test, describe } from 'node:test'
import type { TestContext } from 'node:test'
import Fastify from 'fastify'
import { Type } from '@sinclair/typebox'
import mcpPlugin from '../src/index.ts'
import { JSONRPC_VERSION, LATEST_PROTOCOL_VERSION, METHOD_NOT_FOUND, INVALID_PARAMS } from '../src/schema.ts'
import type { Task, CreateTaskResult, ListTasksResult, CallToolResult } from '../src/schema.ts'
import { MemoryTaskStore } from '../src/stores/memory-task-store.ts'
import { canTransition, isTerminal, taskHasExpired, toWireTask, InvalidTaskCursorError, DEFAULT_TASK_PAGE_SIZE, TaskLimitError, TASK_LIMIT_REACHED, TaskLeases, TASK_OWNER_LOST } from '../src/stores/task-store.ts'
import type { TaskRecord } from '../src/stores/task-store.ts'
import { resolveTaskAugmentation, RELATED_TASK_META_KEY } from '../src/handlers.ts'

const ISS = 'https://auth.example.com'
import { createTestAuthConfig, createTestJWT, setupMockAgent, generateMockJWKSResponse } from './auth-test-utils.ts'

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

/** Calls as a compliant 2025-11-25 client, which must echo the negotiated revision */
async function call (app: any, method: string, params: unknown, id = 1) {
  const response = await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: { 'mcp-protocol-version': LATEST_PROTOCOL_VERSION },
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
    const wire = toWireTask(record({ authSubject: 'user-1', authIssuer: ISS, outcome: { jsonrpc: '2.0', id: 1, result: {} } }))
    t.assert.strictEqual('authSubject' in wire, false)
    t.assert.strictEqual('authIssuer' in wire, false)
    t.assert.strictEqual('method' in wire, false)
    t.assert.strictEqual('outcome' in wire, false)
    t.assert.strictEqual(wire.taskId, 'task-1')
  })

  test('toWireTask drops the lease', (t: TestContext) => {
    const wire = toWireTask(record({ leaseExpiresAt: Date.now() }))
    t.assert.strictEqual('leaseExpiresAt' in wire, false)
  })

  test('MemoryTaskStore fails a task whose lease has lapsed', async (t: TestContext) => {
    const store = new MemoryTaskStore()
    await store.create(record({ leaseExpiresAt: Date.now() - 1 }))
    const outcome = { jsonrpc: '2.0' as const, id: 1, error: { code: -32603, message: 'lost' } }

    const failed = await store.failExpiredLease('task-1', { statusMessage: 'Task owner lost', outcome })
    t.assert.strictEqual(failed?.status, 'failed')
    t.assert.strictEqual(failed?.statusMessage, 'Task owner lost')
    t.assert.deepStrictEqual((await store.get('task-1'))?.outcome, outcome)
    // Once terminal the lease can no longer be renewed
    t.assert.strictEqual(await store.renewLease('task-1', 1000), false)
  })

  test('MemoryTaskStore leaves tasks with a live or no lease alone', async (t: TestContext) => {
    const store = new MemoryTaskStore()
    const outcome = { jsonrpc: '2.0' as const, id: 1, error: { code: -32603, message: 'lost' } }
    await store.create(record({ taskId: 'live', leaseExpiresAt: Date.now() - 1 }))
    await store.create(record({ taskId: 'none' }))

    // A renewal that lands before the reaper wins
    t.assert.strictEqual(await store.renewLease('live', 60_000), true)
    t.assert.strictEqual((await store.failExpiredLease('live', { statusMessage: 'x', outcome }))?.status, 'working')
    t.assert.strictEqual((await store.failExpiredLease('none', { statusMessage: 'x', outcome }))?.status, 'working')
    t.assert.strictEqual(await store.failExpiredLease('missing', { statusMessage: 'x', outcome }), null)
  })

  test('TaskLeases renews until stopped and stops everything on close', async (t: TestContext) => {
    const store = new MemoryTaskStore()
    await store.create(record({ taskId: 'a' }))
    await store.create(record({ taskId: 'b' }))
    const leases = new TaskLeases(store, 30)
    t.after(() => leases.close())

    await leases.start('a')
    await leases.start('b')
    await new Promise(resolve => setTimeout(resolve, 100))
    // Renewals kept both leases in the future, well past the initial 30ms
    t.assert.ok((await store.get('a'))!.leaseExpiresAt! > Date.now())
    t.assert.ok((await store.get('b'))!.leaseExpiresAt! > Date.now())

    leases.stop('a')
    leases.close()
    await new Promise(resolve => setTimeout(resolve, 100))
    t.assert.ok((await store.get('a'))!.leaseExpiresAt! <= Date.now())
    t.assert.ok((await store.get('b'))!.leaseExpiresAt! <= Date.now())
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
    await store.create(record({ taskId: 'a', authSubject: 'user-1', authIssuer: ISS }))
    await store.create(record({ taskId: 'b', authSubject: 'user-2', authIssuer: ISS }))
    await store.create(record({ taskId: 'c' }))

    t.assert.deepStrictEqual((await store.list({ subject: 'user-1', issuer: ISS })).tasks.map(x => x.taskId), ['a'])
    t.assert.deepStrictEqual((await store.list({ subject: 'user-2', issuer: ISS })).tasks.map(x => x.taskId), ['b'])
    t.assert.deepStrictEqual((await store.list()).tasks.map(x => x.taskId), ['c'])
  })

  test('MemoryTaskStore isolates tasks by issuer as well as subject', async (t: TestContext) => {
    const store = new MemoryTaskStore()
    await store.create(record({ taskId: 'a', authSubject: '12345', authIssuer: 'https://idp-a.example.com' }))
    await store.create(record({ taskId: 'b', authSubject: '12345', authIssuer: 'https://idp-b.example.com' }))
    // Created before issuers were recorded
    await store.create(record({ taskId: 'legacy', authSubject: '12345' }))

    t.assert.deepStrictEqual((await store.list({ subject: '12345', issuer: 'https://idp-a.example.com' })).tasks.map(x => x.taskId), ['a'])
    t.assert.deepStrictEqual((await store.list({ subject: '12345', issuer: 'https://idp-b.example.com' })).tasks.map(x => x.taskId), ['b'])
  })

  test('MemoryTaskStore paginates list newest first with an opaque cursor', async (t: TestContext) => {
    const store = new MemoryTaskStore()
    const base = Date.now()
    // Two tasks share a creation time to exercise the id tie-break
    const times = [0, 1, 2, 2, 3]
    for (let i = 0; i < times.length; i++) {
      await store.create(record({ taskId: `t${i}`, authSubject: 'user-1', authIssuer: ISS, createdAt: new Date(base + times[i]).toISOString() }))
    }
    await store.create(record({ taskId: 'other', authSubject: 'user-2', authIssuer: ISS, createdAt: new Date(base + 10).toISOString() }))

    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const page = await store.list({ subject: 'user-1', issuer: ISS }, { cursor, limit: 2 })
      t.assert.ok(page.tasks.length <= 2)
      seen.push(...page.tasks.map(x => x.taskId))
      cursor = page.nextCursor
      pages++
    } while (cursor)

    t.assert.strictEqual(pages, 3)
    t.assert.deepStrictEqual(seen, ['t4', 't3', 't2', 't1', 't0'])
  })

  test('MemoryTaskStore omits nextCursor on the last page', async (t: TestContext) => {
    const store = new MemoryTaskStore()
    await store.create(record({ taskId: 'a', authSubject: 'user-1', authIssuer: ISS }))
    await store.create(record({ taskId: 'b', authSubject: 'user-1', authIssuer: ISS }))

    const page = await store.list({ subject: 'user-1', issuer: ISS }, { limit: 2 })
    t.assert.strictEqual(page.tasks.length, 2)
    t.assert.strictEqual(page.nextCursor, undefined)
  })

  test('MemoryTaskStore rejects an invalid cursor', async (t: TestContext) => {
    const store = new MemoryTaskStore()
    await t.assert.rejects(store.list({ subject: 'user-1', issuer: ISS }, { cursor: 'not-a-cursor' }), InvalidTaskCursorError)
    await t.assert.rejects(store.list({ subject: 'user-1', issuer: ISS }, { cursor: Buffer.from('{"t":"x"}').toString('base64url') }), InvalidTaskCursorError)
  })

  test('concurrent cancel and completion cannot overwrite each other', async (t: TestContext) => {
    // The core of the fix: a cancel racing a completion on the same working task
    // must leave exactly one winner, and a task that reached a terminal status
    // must not be moved out of it. updateStatus is atomic, so the second write
    // observes the first and rejects rather than clobbering it.
    const store = new MemoryTaskStore()
    await store.create(record())

    const results = await Promise.allSettled([
      store.updateStatus('task-1', 'cancelled'),
      store.updateStatus('task-1', 'completed')
    ])

    const fulfilled = results.filter(r => r.status === 'fulfilled')
    const rejected = results.filter(r => r.status === 'rejected')
    t.assert.strictEqual(fulfilled.length, 1, 'exactly one write should win')
    t.assert.strictEqual(rejected.length, 1, 'the loser should be rejected, not silently clobber')

    const final = await store.get('task-1')
    t.assert.ok(isTerminal(final!.status))
    // The stored status must equal the winner's — no lost update
    t.assert.strictEqual(final!.status, (fulfilled[0] as PromiseFulfilledResult<TaskRecord>).value.status)
  })

  test('a terminal task rejects any further transition', async (t: TestContext) => {
    const store = new MemoryTaskStore()
    await store.create(record())
    await store.updateStatus('task-1', 'cancelled')

    await t.assert.rejects(() => store.updateStatus('task-1', 'completed'), /terminal status/)
    t.assert.strictEqual((await store.get('task-1'))!.status, 'cancelled')
  })

  test('MemoryTaskStore counts finished tasks against the per-principal cap', async (t: TestContext) => {
    const store = new MemoryTaskStore({ maxTasksPerPrincipal: 2 })
    await store.create(record({ taskId: 'a', authSubject: 'user-1' }))
    await store.create(record({ taskId: 'b', authSubject: 'user-1' }))

    // Both still running: nothing can be evicted, so the third is refused
    await t.assert.rejects(
      () => store.create(record({ taskId: 'c', authSubject: 'user-1' })),
      (err: any) => err instanceof TaskLimitError && err.limit === 2
    )

    // Another caller is unaffected
    await store.create(record({ taskId: 'x', authSubject: 'user-2' }))
    t.assert.ok(await store.get('x'))
  })

  test('MemoryTaskStore evicts the caller\'s oldest finished task to make room', async (t: TestContext) => {
    const store = new MemoryTaskStore({ maxTasksPerPrincipal: 3 })
    await store.create(record({ taskId: 'a', authSubject: 'user-1' }))
    await store.create(record({ taskId: 'b', authSubject: 'user-1' }))
    await store.create(record({ taskId: 'c', authSubject: 'user-1' }))
    await store.updateStatus('b', 'completed')
    await store.updateStatus('c', 'failed')

    await store.create(record({ taskId: 'd', authSubject: 'user-1' }))

    // 'a' is older but still running, so the oldest finished task 'b' goes
    t.assert.ok(await store.get('a'))
    t.assert.strictEqual(await store.get('b'), null)
    t.assert.ok(await store.get('c'))
    t.assert.ok(await store.get('d'))
  })

  test('MemoryTaskStore fails orphaned tasks so they stop holding the caller\'s quota', async (t: TestContext) => {
    // 'a' was running on an instance that died: its lease lapsed, nobody polled it
    const store = new MemoryTaskStore({ maxTasksPerPrincipal: 2 })
    await store.create(record({ taskId: 'a', authSubject: 'user-1', leaseExpiresAt: Date.now() - 1 }))
    await store.create(record({ taskId: 'b', authSubject: 'user-1', leaseExpiresAt: Date.now() + 60_000 }))

    await store.create(record({ taskId: 'c', authSubject: 'user-1' }))

    t.assert.strictEqual(await store.get('a'), null)
    t.assert.strictEqual((await store.get('b'))?.status, 'working')
    t.assert.ok(await store.get('c'))

    // Live leases still count: 'b' and 'c' fill the quota
    await t.assert.rejects(
      () => store.create(record({ taskId: 'd', authSubject: 'user-1' })),
      (err: any) => err instanceof TaskLimitError
    )
  })

  test('MemoryTaskStore records orphaned tasks as failed when reclaiming quota', async (t: TestContext) => {
    const store = new MemoryTaskStore({ maxTasksPerPrincipal: 3 })
    await store.create(record({ taskId: 'a', authSubject: 'user-1' }))
    await store.updateStatus('a', 'completed')
    await store.create(record({ taskId: 'b', authSubject: 'user-1', leaseExpiresAt: Date.now() - 1 }))
    await store.create(record({ taskId: 'c', authSubject: 'user-1' }))

    await store.create(record({ taskId: 'd', authSubject: 'user-1' }))

    // The oldest finished task makes room; the orphan stays, now failed
    t.assert.strictEqual(await store.get('a'), null)
    const orphan = await store.get('b')
    t.assert.strictEqual(orphan?.status, 'failed')
    t.assert.strictEqual(orphan?.statusMessage, TASK_OWNER_LOST)
    t.assert.strictEqual((orphan?.outcome as any)?.error?.message, TASK_OWNER_LOST)
  })

  test('MemoryTaskStore frees store capacity held by another caller\'s finished tasks', async (t: TestContext) => {
    // The scenario from #249: one caller's finished tasks fill the whole store
    const store = new MemoryTaskStore({ maxTasks: 3, maxTasksPerPrincipal: 3 })
    for (const id of ['a', 'b', 'c']) {
      await store.create(record({ taskId: id, authSubject: 'user-1', ttl: 3600_000 }))
      await store.updateStatus(id, 'completed')
    }

    await store.create(record({ taskId: 'd', authSubject: 'user-2' }))
    t.assert.ok(await store.get('d'))
    t.assert.strictEqual(await store.get('a'), null)
    t.assert.ok(await store.get('b'))
  })

  test('MemoryTaskStore refuses when the store is full of running tasks', async (t: TestContext) => {
    const store = new MemoryTaskStore(2)
    await store.create(record({ taskId: 'a', authSubject: 'user-1' }))
    await store.create(record({ taskId: 'b', authSubject: 'user-2' }))

    await t.assert.rejects(
      () => store.create(record({ taskId: 'c', authSubject: 'user-3' })),
      /Task limit reached/
    )
  })

  test('MemoryTaskStore does not share one per-principal quota across anonymous callers', async (t: TestContext) => {
    // #320: without an identity every caller would otherwise be one owner, so
    // any of them could evict or lock out everyone else's tasks
    const store = new MemoryTaskStore({ maxTasks: 10, maxTasksPerPrincipal: 2 })
    await store.create(record({ taskId: 'a', ttl: 3600_000 }))
    await store.updateStatus('a', 'completed')

    // Other anonymous callers create more tasks than the per-principal cap
    for (const id of ['b', 'c', 'd']) {
      await store.create(record({ taskId: id }))
    }

    // A's finished task was not evicted before A collected it
    t.assert.strictEqual((await store.get('a'))?.status, 'completed')
    for (const id of ['b', 'c', 'd']) {
      t.assert.ok(await store.get(id))
    }
  })

  test('MemoryTaskStore bounds anonymous tasks by the anonymous cap', async (t: TestContext) => {
    const store = new MemoryTaskStore({ maxTasks: 10, maxTasksPerPrincipal: 1, maxAnonymousTasks: 3 })
    await store.create(record({ taskId: 'a' }))
    await store.create(record({ taskId: 'b' }))
    await store.create(record({ taskId: 'c' }))

    // All still running: nothing to evict
    await t.assert.rejects(
      () => store.create(record({ taskId: 'd' })),
      (err: any) => err instanceof TaskLimitError && err.limit === 3
    )

    // Once one finishes, the oldest finished anonymous task makes room
    await store.updateStatus('b', 'completed')
    await store.create(record({ taskId: 'd' }))
    t.assert.strictEqual(await store.get('b'), null)
    t.assert.ok(await store.get('a'))
    t.assert.ok(await store.get('d'))

    // Identified callers keep their own per-principal quota
    await store.create(record({ taskId: 'x', authSubject: 'user-1', authIssuer: ISS }))
    await t.assert.rejects(
      () => store.create(record({ taskId: 'y', authSubject: 'user-1', authIssuer: ISS })),
      (err: any) => err instanceof TaskLimitError && err.limit === 1
    )
  })

  test('MemoryTaskStore bounds anonymous tasks by the store-wide cap', async (t: TestContext) => {
    const store = new MemoryTaskStore({ maxTasks: 3, maxTasksPerPrincipal: 1 })
    await store.create(record({ taskId: 'a' }))
    await store.create(record({ taskId: 'b' }))
    await store.create(record({ taskId: 'c' }))

    await t.assert.rejects(
      () => store.create(record({ taskId: 'd' })),
      (err: any) => err instanceof TaskLimitError && err.limit === 3
    )
  })

  test('MemoryTaskStore validates maxAnonymousTasks', (t: TestContext) => {
    t.assert.throws(() => new MemoryTaskStore({ maxAnonymousTasks: 0 }), /maxAnonymousTasks must be a positive integer/)
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

  test('a task running longer than its lease keeps renewing it and completes', async (t: TestContext) => {
    const app = await buildApp(t, { taskLeaseMs: 30 })
    app.mcpAddTool({
      name: 'slower-than-lease',
      description: 'Outlives several lease periods',
      inputSchema: Type.Object({}),
      execution: { taskSupport: 'optional' }
    } as any, async (): Promise<CallToolResult> => {
      await new Promise(resolve => setTimeout(resolve, 200))
      return { content: [{ type: 'text', text: 'still alive' }] }
    })

    const created = await call(app, 'tools/call', { name: 'slower-than-lease', arguments: {}, task: {} })
    const taskId = (created.result as CreateTaskResult).task.taskId

    await new Promise(resolve => setTimeout(resolve, 100))
    t.assert.strictEqual((await call(app, 'tasks/get', { taskId })).result.status, 'working')

    const body = await call(app, 'tasks/result', { taskId })
    t.assert.strictEqual(body.result.content[0].text, 'still alive')
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

  for (const ttl of ['forever', -5, 1.5, Number.MAX_SAFE_INTEGER + 2, true, {}]) {
    test(`a task ttl of ${JSON.stringify(ttl)} is rejected as invalid params`, async (t: TestContext) => {
      const app = await buildApp(t)
      const body = await call(app, 'tools/call', { name: 'slow-add', arguments: { a: 1, b: 2 }, task: { ttl } })

      t.assert.strictEqual(body.error.code, INVALID_PARAMS)
      t.assert.match(body.error.message, /ttl/)
      t.assert.strictEqual(body.result, undefined)
    })
  }

  for (const task of [{}, { ttl: null }]) {
    test(`a task ${JSON.stringify(task)} gets the default ttl`, async (t: TestContext) => {
      const app = await buildApp(t, { taskDefaultTtlMs: 45_000 })
      const body = await call(app, 'tools/call', { name: 'slow-add', arguments: { a: 1, b: 2 }, task })

      const result = body.result as CreateTaskResult
      t.assert.strictEqual(result.task.ttl, 45_000)
      t.assert.strictEqual((await waitForTerminal(app, result.task.taskId)).status, 'completed')
    })
  }

  test('a valid task ttl is honoured and capped at the maximum', async (t: TestContext) => {
    const app = await buildApp(t, { taskMaxTtlMs: 90_000 })

    const honoured = await call(app, 'tools/call', { name: 'slow-add', arguments: { a: 1, b: 2 }, task: { ttl: 20_000 } })
    t.assert.strictEqual((honoured.result as CreateTaskResult).task.ttl, 20_000)

    const capped = await call(app, 'tools/call', { name: 'slow-add', arguments: { a: 1, b: 2 }, task: { ttl: 10 * 3600_000 } })
    t.assert.strictEqual((capped.result as CreateTaskResult).task.ttl, 90_000)
  })

  test('a task ttl of 0 is raised to a usable minimum', async (t: TestContext) => {
    const app = await buildApp(t)
    const body = await call(app, 'tools/call', { name: 'slow-add', arguments: { a: 1, b: 2 }, task: { ttl: 0 } })

    const result = body.result as CreateTaskResult
    t.assert.strictEqual(result.task.ttl, 1000)
    // The task is still reachable long enough to collect its result
    t.assert.strictEqual((await waitForTerminal(app, result.task.taskId)).status, 'completed')
    const final = await call(app, 'tasks/result', { taskId: result.task.taskId })
    t.assert.strictEqual(final.result.content[0].text, '3')
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

  test('tasks/list is refused without authorization', async (t: TestContext) => {
    // Without auth every task shares the undefined subject, so listing would
    // hand out every task's id — defeating the "random id is the capability"
    // model. The method must not exist, matching the un-advertised capability.
    const app = await buildApp(t)

    await call(app, 'tools/call', { name: 'slow-add', arguments: { a: 1, b: 1 }, task: {} })

    const body = await call(app, 'tasks/list', {})
    t.assert.strictEqual(body.error.code, METHOD_NOT_FOUND)

    const init = await call(app, 'initialize', { protocolVersion: '2025-11-25', capabilities: {} })
    t.assert.strictEqual(init.result.capabilities.tasks.list, undefined, 'list capability must not be advertised')
  })

  test('tasks/list is available and subject-scoped with authorization', async (t: TestContext) => {
    const restoreMock = setupMockAgent({
      'https://auth.example.com/.well-known/jwks.json': generateMockJWKSResponse()
    })
    t.after(() => restoreMock())

    const app = Fastify({ logger: false })
    t.after(() => app.close())
    await app.register(mcpPlugin, { enableTasks: true, authorization: createTestAuthConfig() })
    app.mcpAddTool({
      name: 'noop',
      description: 'x',
      inputSchema: Type.Object({}),
      execution: { taskSupport: 'optional' }
    } as any, async (): Promise<CallToolResult> => ({ content: [{ type: 'text', text: 'ok' }] }))
    await app.ready()

    const authedCall = async (token: string, method: string, params: unknown) => {
      const res = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { authorization: `Bearer ${token}`, 'mcp-protocol-version': LATEST_PROTOCOL_VERSION },
        payload: { jsonrpc: JSONRPC_VERSION, id: 1, method, params }
      })
      return res.json()
    }

    const tokenA = createTestJWT({ sub: 'user-a' })
    const tokenB = createTestJWT({ sub: 'user-b' })

    // With auth, the capability is advertised
    const init = await authedCall(tokenA, 'initialize', { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {} })
    t.assert.deepStrictEqual(init.result.capabilities.tasks.list, {})

    // Each subject creates a task
    const a = await authedCall(tokenA, 'tools/call', { name: 'noop', arguments: {}, task: {} })
    const b = await authedCall(tokenB, 'tools/call', { name: 'noop', arguments: {}, task: {} })
    const taskA = (a.result as CreateTaskResult).task.taskId
    const taskB = (b.result as CreateTaskResult).task.taskId

    // A sees only its own task, never B's
    const listA = (await authedCall(tokenA, 'tasks/list', {})).result as ListTasksResult
    t.assert.deepStrictEqual(listA.tasks.map(x => x.taskId), [taskA])
    t.assert.strictEqual(listA.tasks.some(x => x.taskId === taskB), false)

    // A cannot reach B's task by id either
    const cross = await authedCall(tokenA, 'tasks/get', { taskId: taskB })
    t.assert.strictEqual(cross.error.code, INVALID_PARAMS)
  })

  test('tasks/list paginates, stays subject-scoped across pages and rejects invalid cursors', async (t: TestContext) => {
    const restoreMock = setupMockAgent({
      'https://auth.example.com/.well-known/jwks.json': generateMockJWKSResponse()
    })
    t.after(() => restoreMock())

    const app = Fastify({ logger: false })
    t.after(() => app.close())
    await app.register(mcpPlugin, { enableTasks: true, authorization: createTestAuthConfig() })
    app.mcpAddTool({
      name: 'noop',
      description: 'x',
      inputSchema: Type.Object({}),
      execution: { taskSupport: 'optional' }
    } as any, async (): Promise<CallToolResult> => ({ content: [{ type: 'text', text: 'ok' }] }))
    await app.ready()

    const authedCall = async (token: string, method: string, params: unknown) => {
      const res = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { authorization: `Bearer ${token}`, 'mcp-protocol-version': LATEST_PROTOCOL_VERSION },
        payload: { jsonrpc: JSONRPC_VERSION, id: 1, method, params }
      })
      return res.json()
    }

    const tokenA = createTestJWT({ sub: 'user-a' })
    const tokenB = createTestJWT({ sub: 'user-b' })

    const created = new Set<string>()
    for (let i = 0; i < DEFAULT_TASK_PAGE_SIZE + 5; i++) {
      const res = await authedCall(tokenA, 'tools/call', { name: 'noop', arguments: {}, task: {} })
      created.add((res.result as CreateTaskResult).task.taskId)
    }
    const b = await authedCall(tokenB, 'tools/call', { name: 'noop', arguments: {}, task: {} })
    const taskB = (b.result as CreateTaskResult).task.taskId

    const first = (await authedCall(tokenA, 'tasks/list', {})).result as ListTasksResult
    t.assert.strictEqual(first.tasks.length, DEFAULT_TASK_PAGE_SIZE)
    t.assert.strictEqual(typeof first.nextCursor, 'string')

    const second = (await authedCall(tokenA, 'tasks/list', { cursor: first.nextCursor })).result as ListTasksResult
    t.assert.strictEqual(second.tasks.length, 5)
    t.assert.strictEqual(second.nextCursor, undefined)

    const all = [...first.tasks, ...second.tasks].map(x => x.taskId)
    t.assert.strictEqual(new Set(all).size, all.length, 'no task appears on two pages')
    t.assert.deepStrictEqual(new Set(all), created)
    t.assert.strictEqual(all.includes(taskB), false)

    // A's cursor positions B within B's own tasks only
    const crossPage = (await authedCall(tokenB, 'tasks/list', { cursor: first.nextCursor })).result as ListTasksResult
    t.assert.strictEqual(crossPage.tasks.some(x => created.has(x.taskId)), false)

    for (const cursor of ['garbage', 42, '']) {
      const bad = await authedCall(tokenA, 'tasks/list', { cursor })
      t.assert.strictEqual(bad.error.code, INVALID_PARAMS)
    }
  })

  test('a token without sub is rejected before it can create subject-less tasks', async (t: TestContext) => {
    const restoreMock = setupMockAgent({
      'https://auth.example.com/.well-known/jwks.json': generateMockJWKSResponse()
    })
    t.after(() => restoreMock())

    const app = Fastify({ logger: false })
    t.after(() => app.close())
    await app.register(mcpPlugin, { enableTasks: true, authorization: createTestAuthConfig() })
    app.mcpAddTool({
      name: 'noop',
      description: 'x',
      inputSchema: Type.Object({}),
      execution: { taskSupport: 'optional' }
    } as any, async (): Promise<CallToolResult> => ({ content: [{ type: 'text', text: 'ok' }] }))
    await app.ready()

    // Tokens without a `sub` claim are rejected outright, so two subject-less
    // callers can never end up sharing the same (undefined) task owner.
    const anonA = createTestJWT({ sub: undefined })

    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${anonA}`, 'mcp-protocol-version': LATEST_PROTOCOL_VERSION },
      payload: { jsonrpc: JSONRPC_VERSION, id: 1, method: 'tools/call', params: { name: 'noop', arguments: {}, task: {} } }
    })
    t.assert.strictEqual(res.statusCode, 401)
  })

  test('a caller over its task quota gets "Task limit reached", not an internal error', async (t: TestContext) => {
    const app = await buildApp(t, { taskMaxRetainedAnonymous: 1 })
    app.mcpAddTool({
      name: 'hang',
      description: 'Never finishes',
      inputSchema: Type.Object({}),
      execution: { taskSupport: 'optional' }
    } as any, () => new Promise<CallToolResult>(() => {}))

    const first = await call(app, 'tools/call', { name: 'hang', arguments: {}, task: {} })
    t.assert.ok(first.result.task.taskId)

    const second = await call(app, 'tools/call', { name: 'hang', arguments: {}, task: {} })
    t.assert.strictEqual(second.error.code, TASK_LIMIT_REACHED)
    t.assert.strictEqual(second.error.message, 'Task limit reached')
  })

  test('a finished task is evicted so the same caller can start another', async (t: TestContext) => {
    const app = await buildApp(t, { taskMaxRetainedAnonymous: 1 })

    const first = await call(app, 'tools/call', { name: 'slow-add', arguments: { a: 1, b: 2 }, task: { ttl: 3600_000 } })
    await waitForTerminal(app, first.result.task.taskId)

    const second = await call(app, 'tools/call', { name: 'slow-add', arguments: { a: 1, b: 2 }, task: { ttl: 3600_000 } })
    t.assert.ok(second.result.task.taskId)
    const gone = await call(app, 'tasks/get', { taskId: first.result.task.taskId })
    t.assert.strictEqual(gone.error.code, INVALID_PARAMS)
  })

  test('anonymous callers do not share the per-principal quota (#320)', async (t: TestContext) => {
    const app = await buildApp(t, { taskMaxRetainedPerPrincipal: 2 })

    // Client A's task completes
    const a = await call(app, 'tools/call', { name: 'slow-add', arguments: { a: 1, b: 2 }, task: { ttl: 3600_000 } })
    t.assert.strictEqual((await waitForTerminal(app, a.result.task.taskId)).status, 'completed')

    // Other anonymous callers create more tasks than the per-principal cap
    for (let i = 0; i < 3; i++) {
      const other = await call(app, 'tools/call', { name: 'slow-add', arguments: { a: i, b: i }, task: { ttl: 3600_000 } }, i + 2)
      t.assert.ok(other.result.task.taskId)
    }

    // A can still collect its result
    const got = await call(app, 'tasks/get', { taskId: a.result.task.taskId })
    t.assert.strictEqual(got.result.status, 'completed')
  })

  test('rejects an invalid taskMaxRetainedAnonymous', async (t: TestContext) => {
    const app = Fastify({ logger: false })
    t.after(() => app.close())
    await t.assert.rejects(
      async () => {
        await app.register(mcpPlugin, { enableTasks: true, taskMaxRetainedAnonymous: 0 })
        await app.ready()
      },
      /taskMaxRetainedAnonymous must be a positive integer/
    )
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
