import { test, describe, before, after, beforeEach } from 'node:test'
import type { TestContext } from 'node:test'
import type { Redis } from 'ioredis'
import { createTestRedis, cleanupRedis } from './redis-test-utils.ts'
import { RedisTaskStore } from '../src/stores/redis-task-store.ts'
import type { TaskRecord } from '../src/stores/task-store.ts'

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

describe('RedisTaskStore', () => {
  let redis: Redis
  let store: RedisTaskStore

  before(async () => {
    redis = await createTestRedis()
  })

  after(async () => {
    await cleanupRedis(redis)
  })

  beforeEach(async () => {
    await redis.flushdb()
    store = new RedisTaskStore({ redis })
  })

  test('round-trips a task', async (t: TestContext) => {
    await store.create(record({ authSubject: 'user-1' }))

    const task = await store.get('task-1')
    t.assert.strictEqual(task?.taskId, 'task-1')
    t.assert.strictEqual(task?.status, 'working')
    t.assert.strictEqual(task?.authSubject, 'user-1')
    t.assert.strictEqual(task?.method, 'tools/call')
  })

  test('returns null for an unknown task', async (t: TestContext) => {
    t.assert.strictEqual(await store.get('nope'), null)
  })

  test('records a terminal outcome', async (t: TestContext) => {
    await store.create(record())

    const outcome = { jsonrpc: '2.0' as const, id: 1, result: { content: [{ type: 'text', text: 'hi' }] } }
    const updated = await store.updateStatus('task-1', 'completed', { statusMessage: 'ok', outcome })

    t.assert.strictEqual(updated?.status, 'completed')
    t.assert.strictEqual(updated?.statusMessage, 'ok')
    t.assert.deepStrictEqual((await store.get('task-1'))?.outcome, outcome)
  })

  test('rejects transitions out of a terminal status', async (t: TestContext) => {
    await store.create(record())
    await store.updateStatus('task-1', 'completed')

    await t.assert.rejects(() => store.updateStatus('task-1', 'working'), /terminal status/)
  })

  test('a status change does not extend the retention window', async (t: TestContext) => {
    await store.create(record({ ttl: 60_000 }))
    const before = await redis.ttl('mcp:task:task-1')

    await store.updateStatus('task-1', 'completed')
    const after = await redis.ttl('mcp:task:task-1')

    t.assert.ok(after <= before, `ttl should not grow: ${before} -> ${after}`)
    t.assert.ok(after > 0, 'task should still be retained')
  })

  test('treats a task past its ttl as absent', async (t: TestContext) => {
    await store.create(record({ createdAt: new Date(Date.now() - 10_000).toISOString(), ttl: 1_000 }))
    t.assert.strictEqual(await store.get('task-1'), null)
  })

  test('list is scoped to the authorization subject', async (t: TestContext) => {
    await store.create(record({ taskId: 'a', authSubject: 'user-1' }))
    await store.create(record({ taskId: 'b', authSubject: 'user-2' }))
    await store.create(record({ taskId: 'c' }))

    t.assert.deepStrictEqual((await store.list('user-1')).map(x => x.taskId), ['a'])
    t.assert.deepStrictEqual((await store.list('user-2')).map(x => x.taskId), ['b'])
    t.assert.deepStrictEqual((await store.list()).map(x => x.taskId), ['c'])
  })

  test('delete removes the task and its index entry', async (t: TestContext) => {
    await store.create(record())
    await store.delete('task-1')

    t.assert.strictEqual(await store.get('task-1'), null)
    t.assert.strictEqual(await redis.zcard('mcp:tasks'), 0)
  })

  test('cleanup prunes index entries whose task key is gone', async (t: TestContext) => {
    await store.create(record())
    await redis.del('mcp:task:task-1')
    t.assert.strictEqual(await redis.zcard('mcp:tasks'), 1)

    await store.cleanup()
    t.assert.strictEqual(await redis.zcard('mcp:tasks'), 0)
  })

  test('tasks created on one store instance are visible from another', async (t: TestContext) => {
    await store.create(record({ authSubject: 'user-1' }))

    // A second instance stands in for a second server in the cluster
    const other = new RedisTaskStore({ redis })
    const task = await other.get('task-1')

    t.assert.strictEqual(task?.taskId, 'task-1')
    t.assert.deepStrictEqual((await other.list('user-1')).map(x => x.taskId), ['task-1'])
  })
})
