import { test, describe, before, after, beforeEach } from 'node:test'
import type { TestContext } from 'node:test'
import type { Redis } from 'ioredis'
import { createTestRedis, cleanupRedis } from './redis-test-utils.ts'
import { RedisTaskStore } from '../src/stores/redis-task-store.ts'
import type { TaskRecord } from '../src/stores/task-store.ts'
import { InvalidTaskCursorError } from '../src/stores/task-store.ts'

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

  test('a cancelled task cannot be overwritten by a concurrent completion', async (t: TestContext) => {
    await store.create(record())

    // Both start from `working`; the Lua guard must let only one win and reject
    // the other, so the task never leaves the terminal status it first reached.
    const results = await Promise.allSettled([
      store.updateStatus('task-1', 'cancelled'),
      store.updateStatus('task-1', 'completed')
    ])

    const fulfilled = results.filter(r => r.status === 'fulfilled')
    const rejected = results.filter(r => r.status === 'rejected')
    t.assert.strictEqual(fulfilled.length, 1, 'exactly one write should win')
    t.assert.strictEqual(rejected.length, 1, 'the loser must be rejected, not clobber the winner')

    const final = await store.get('task-1')
    t.assert.strictEqual(final?.status, (fulfilled[0] as PromiseFulfilledResult<any>).value.status)
  })

  test('a terminal task rejects any further transition', async (t: TestContext) => {
    await store.create(record())
    await store.updateStatus('task-1', 'cancelled')

    await t.assert.rejects(() => store.updateStatus('task-1', 'completed'), /terminal status/)
    t.assert.strictEqual((await store.get('task-1'))?.status, 'cancelled')
  })

  test('a status change does not extend the retention window', async (t: TestContext) => {
    await store.create(record({ ttl: 60_000 }))
    const before = await redis.ttl('mcp:task:task-1')

    await store.updateStatus('task-1', 'completed')
    const after = await redis.ttl('mcp:task:task-1')

    t.assert.ok(after <= before, `ttl should not grow: ${before} -> ${after}`)
    t.assert.ok(after > 0, 'task should still be retained')
  })

  test('a null ttl means unlimited retention, not the default expiry', async (t: TestContext) => {
    await store.create(record({ ttl: null }))

    // -1 is Redis for "key exists but has no expiry"; the default must not apply
    t.assert.strictEqual(await redis.ttl('mcp:task:task-1'), -1)
    t.assert.strictEqual((await store.get('task-1'))?.ttl, null)
  })

  test('treats a task past its ttl as absent', async (t: TestContext) => {
    await store.create(record({ createdAt: new Date(Date.now() - 10_000).toISOString(), ttl: 1_000 }))
    t.assert.strictEqual(await store.get('task-1'), null)
  })

  test('list is scoped to the authorization subject', async (t: TestContext) => {
    await store.create(record({ taskId: 'a', authSubject: 'user-1' }))
    await store.create(record({ taskId: 'b', authSubject: 'user-2' }))
    await store.create(record({ taskId: 'c' }))

    t.assert.deepStrictEqual((await store.list('user-1')).tasks.map(x => x.taskId), ['a'])
    t.assert.deepStrictEqual((await store.list('user-2')).tasks.map(x => x.taskId), ['b'])
    t.assert.deepStrictEqual((await store.list()).tasks.map(x => x.taskId), ['c'])
  })

  test('delete removes the task and its owner index entry', async (t: TestContext) => {
    await store.create(record({ authSubject: 'user-1' }))
    t.assert.strictEqual(await redis.zcard('mcp:tasks:owner:user-1'), 1)
    await store.delete('task-1')

    t.assert.strictEqual(await store.get('task-1'), null)
    t.assert.strictEqual(await redis.zcard('mcp:tasks:owner:user-1'), 0)
  })

  test('list prunes index entries whose task key has expired', async (t: TestContext) => {
    await store.create(record({ taskId: 'a', authSubject: 'user-1' }))
    await store.create(record({ taskId: 'b', authSubject: 'user-1' }))
    // Stand in for Redis expiring the task key on its own
    await redis.del('mcp:task:a')

    t.assert.deepStrictEqual((await store.list('user-1')).tasks.map(x => x.taskId), ['b'])
    t.assert.deepStrictEqual(await redis.zrange('mcp:tasks:owner:user-1', 0, -1), ['b'])
  })

  test('owner index expires no earlier than its longest-lived task', async (t: TestContext) => {
    await store.create(record({ taskId: 'long', authSubject: 'user-1', ttl: 120_000 }))
    await store.create(record({ taskId: 'short', authSubject: 'user-1', ttl: 10_000 }))
    const ttl = await redis.ttl('mcp:tasks:owner:user-1')
    t.assert.ok(ttl > 100 && ttl <= 120, `expected ~120s, got ${ttl}`)

    // A task with unlimited retention keeps the index alive indefinitely
    await store.create(record({ taskId: 'forever', authSubject: 'user-1', ttl: null }))
    t.assert.strictEqual(await redis.ttl('mcp:tasks:owner:user-1'), -1)
  })

  test('list paginates newest first across pages', async (t: TestContext) => {
    const base = Date.now()
    // Two tasks share a creation time to exercise the id tie-break
    const times = [0, 1, 2, 2, 3]
    for (let i = 0; i < times.length; i++) {
      await store.create(record({ taskId: `t${i}`, authSubject: 'user-1', createdAt: new Date(base + times[i]).toISOString() }))
    }
    await store.create(record({ taskId: 'other', authSubject: 'user-2', createdAt: new Date(base + 1).toISOString() }))

    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const page = await store.list('user-1', { cursor, limit: 2 })
      t.assert.ok(page.tasks.length <= 2)
      seen.push(...page.tasks.map(x => x.taskId))
      cursor = page.nextCursor
      pages++
    } while (cursor)

    t.assert.strictEqual(pages, 3)
    t.assert.deepStrictEqual(seen, ['t4', 't3', 't2', 't1', 't0'])
  })

  test('list pages past many tasks sharing one creation time', async (t: TestContext) => {
    const createdAt = new Date().toISOString()
    const ids = Array.from({ length: 7 }, (_, i) => `same-${i}`)
    for (const taskId of ids) {
      await store.create(record({ taskId, authSubject: 'user-1', createdAt }))
    }

    const seen: string[] = []
    let cursor: string | undefined
    do {
      const page = await store.list('user-1', { cursor, limit: 3 })
      seen.push(...page.tasks.map(x => x.taskId))
      cursor = page.nextCursor
    } while (cursor)

    t.assert.deepStrictEqual(seen, [...ids].reverse())
  })

  test('list rejects an invalid cursor', async (t: TestContext) => {
    await t.assert.rejects(store.list('user-1', { cursor: 'not-a-cursor' }), InvalidTaskCursorError)
  })

  test('list does not read other owners\' tasks', async (t: TestContext) => {
    for (let i = 0; i < 20; i++) {
      await store.create(record({ taskId: `other-${i}`, authSubject: 'user-2' }))
    }
    await store.create(record({ taskId: 'mine', authSubject: 'user-1' }))

    // Record every key a read command touches while listing
    const monitor = await redis.monitor()
    const touched: string[] = []
    // MONITOR spans every database on the server, so ignore other test runs
    const db = String(redis.options.db ?? 0)
    monitor.on('monitor', (_time: string, args: string[], _source: string, database: string) => {
      if (database !== db) return
      const [command, ...rest] = args
      if (/^(get|mget|zrange|zrevrange|zrevrangebyscore|zrangebyscore|scan|keys)$/i.test(command)) {
        touched.push(...rest)
      }
    })
    t.after(() => monitor.disconnect())

    const page = await store.list('user-1')
    // MONITOR delivers asynchronously; a round trip flushes it
    await redis.ping()
    await new Promise(resolve => setTimeout(resolve, 50))

    t.assert.deepStrictEqual(page.tasks.map(x => x.taskId), ['mine'])
    t.assert.ok(touched.length > 0, 'monitor should have seen the list commands')
    t.assert.strictEqual(touched.some(arg => arg.includes('other-') || arg.includes('user-2')), false)
    t.assert.strictEqual(touched.some(arg => arg === 'mcp:tasks' || arg === '*'), false)
  })

  test('tasks created on one store instance are visible from another', async (t: TestContext) => {
    await store.create(record({ authSubject: 'user-1' }))

    // A second instance stands in for a second server in the cluster
    const other = new RedisTaskStore({ redis })
    const task = await other.get('task-1')

    t.assert.strictEqual(task?.taskId, 'task-1')
    t.assert.deepStrictEqual((await other.list('user-1')).tasks.map(x => x.taskId), ['task-1'])
  })
})
