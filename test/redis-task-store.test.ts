import { test, describe, before, after, beforeEach } from 'node:test'
import type { TestContext } from 'node:test'
import type { Redis } from 'ioredis'
import { createTestRedis, cleanupRedis } from './redis-test-utils.ts'
import { RedisTaskStore } from '../src/stores/redis-task-store.ts'
import { TaskLimitError, TASK_OWNER_LOST } from '../src/stores/task-store.ts'
import type { TaskRecord } from '../src/stores/task-store.ts'
import { InvalidTaskCursorError } from '../src/stores/task-store.ts'

const ISS = 'https://idp-a.example.com:8443'
const USER_1_INDEX = `mcp:tasks:owner:${encodeURIComponent(ISS)}:user-1`

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
    await store.create(record({ authSubject: 'user-1', authIssuer: ISS }))

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

  test('treats a task whose key has expired as absent', async (t: TestContext) => {
    await store.create(record({ ttl: 1_000 }))
    await redis.pexpire('mcp:task:task-1', 1)
    await new Promise(resolve => setTimeout(resolve, 20))

    t.assert.strictEqual(await store.get('task-1'), null)
    // The stale index entry is pruned by the next list
    t.assert.deepStrictEqual((await store.list()).tasks, [])
    t.assert.strictEqual(await redis.zcard('mcp:tasks:anonymous'), 0)
  })

  test('does not delete a live task that looks expired by the local clock', async (t: TestContext) => {
    // Another instance with a slower clock created this task: by our clock it is
    // past its ttl, but its Redis key is still live, so Redis is authoritative.
    await store.create(record({ createdAt: new Date(Date.now() - 600_000).toISOString(), ttl: 60_000 }))

    const task = await store.get('task-1')
    t.assert.strictEqual(task?.taskId, 'task-1')
    t.assert.strictEqual(await redis.exists('mcp:task:task-1'), 1)
    t.assert.strictEqual(await redis.zcard('mcp:tasks:anonymous'), 1)
    t.assert.deepStrictEqual((await store.list()).tasks.map(x => x.taskId), ['task-1'])
  })

  test('list is scoped to the authorization subject', async (t: TestContext) => {
    await store.create(record({ taskId: 'a', authSubject: 'user-1', authIssuer: ISS }))
    await store.create(record({ taskId: 'b', authSubject: 'user-2', authIssuer: ISS }))
    await store.create(record({ taskId: 'c' }))

    t.assert.deepStrictEqual((await store.list({ subject: 'user-1', issuer: ISS })).tasks.map(x => x.taskId), ['a'])
    t.assert.deepStrictEqual((await store.list({ subject: 'user-2', issuer: ISS })).tasks.map(x => x.taskId), ['b'])
    t.assert.deepStrictEqual((await store.list()).tasks.map(x => x.taskId), ['c'])
  })

  test('list is scoped to the issuer as well as the subject', async (t: TestContext) => {
    await store.create(record({ taskId: 'a', authSubject: '12345', authIssuer: 'https://idp-a.example.com' }))
    await store.create(record({ taskId: 'b', authSubject: '12345', authIssuer: 'https://idp-b.example.com' }))
    // Created before issuers were recorded
    await store.create(record({ taskId: 'legacy', authSubject: '12345' }))

    t.assert.deepStrictEqual((await store.list({ subject: '12345', issuer: 'https://idp-a.example.com' })).tasks.map(x => x.taskId), ['a'])
    t.assert.deepStrictEqual((await store.list({ subject: '12345', issuer: 'https://idp-b.example.com' })).tasks.map(x => x.taskId), ['b'])
  })

  test('owner index keys cannot be confused when issuer or subject contain ":"', async (t: TestContext) => {
    await store.create(record({ taskId: 'x', authSubject: 'c', authIssuer: 'a:b' }))
    await store.create(record({ taskId: 'y', authSubject: 'b:c', authIssuer: 'a' }))

    t.assert.deepStrictEqual(await redis.zrange('mcp:tasks:owner:a%3Ab:c', 0, '-1'), ['x'])
    t.assert.deepStrictEqual(await redis.zrange('mcp:tasks:owner:a:b%3Ac', 0, '-1'), ['y'])
    t.assert.deepStrictEqual((await store.list({ subject: 'c', issuer: 'a:b' })).tasks.map(x => x.taskId), ['x'])
    t.assert.deepStrictEqual((await store.list({ subject: 'b:c', issuer: 'a' })).tasks.map(x => x.taskId), ['y'])

    await store.delete('x')
    t.assert.strictEqual(await redis.exists('mcp:tasks:owner:a%3Ab:c'), 0)
    t.assert.deepStrictEqual(await redis.zrange('mcp:tasks:owner:a:b%3Ac', 0, '-1'), ['y'])
  })

  test('delete removes the task and its owner index entry', async (t: TestContext) => {
    await store.create(record({ authSubject: 'user-1', authIssuer: ISS }))
    t.assert.strictEqual(await redis.zcard(USER_1_INDEX), 1)
    await store.delete('task-1')

    t.assert.strictEqual(await store.get('task-1'), null)
    t.assert.strictEqual(await redis.zcard(USER_1_INDEX), 0)
  })

  test('list prunes index entries whose task key has expired', async (t: TestContext) => {
    await store.create(record({ taskId: 'a', authSubject: 'user-1', authIssuer: ISS }))
    await store.create(record({ taskId: 'b', authSubject: 'user-1', authIssuer: ISS }))
    // Stand in for Redis expiring the task key on its own
    await redis.del('mcp:task:a')

    t.assert.deepStrictEqual((await store.list({ subject: 'user-1', issuer: ISS })).tasks.map(x => x.taskId), ['b'])
    t.assert.deepStrictEqual(await redis.zrange(USER_1_INDEX, 0, '-1'), ['b'])
  })

  test('owner index expires no earlier than its longest-lived task', async (t: TestContext) => {
    await store.create(record({ taskId: 'long', authSubject: 'user-1', authIssuer: ISS, ttl: 120_000 }))
    await store.create(record({ taskId: 'short', authSubject: 'user-1', authIssuer: ISS, ttl: 10_000 }))
    const ttl = await redis.ttl(USER_1_INDEX)
    t.assert.ok(ttl > 100 && ttl <= 120, `expected ~120s, got ${ttl}`)

    // A task with unlimited retention keeps the index alive indefinitely
    await store.create(record({ taskId: 'forever', authSubject: 'user-1', authIssuer: ISS, ttl: null }))
    t.assert.strictEqual(await redis.ttl(USER_1_INDEX), -1)
  })

  test('list paginates newest first across pages', async (t: TestContext) => {
    const base = Date.now()
    // Two tasks share a creation time to exercise the id tie-break
    const times = [0, 1, 2, 2, 3]
    for (let i = 0; i < times.length; i++) {
      await store.create(record({ taskId: `t${i}`, authSubject: 'user-1', authIssuer: ISS, createdAt: new Date(base + times[i]).toISOString() }))
    }
    await store.create(record({ taskId: 'other', authSubject: 'user-2', authIssuer: ISS, createdAt: new Date(base + 1).toISOString() }))

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

  test('list pages past many tasks sharing one creation time', async (t: TestContext) => {
    const createdAt = new Date().toISOString()
    const ids = Array.from({ length: 7 }, (_, i) => `same-${i}`)
    for (const taskId of ids) {
      await store.create(record({ taskId, authSubject: 'user-1', authIssuer: ISS, createdAt }))
    }

    const seen: string[] = []
    let cursor: string | undefined
    do {
      const page = await store.list({ subject: 'user-1', issuer: ISS }, { cursor, limit: 3 })
      seen.push(...page.tasks.map(x => x.taskId))
      cursor = page.nextCursor
    } while (cursor)

    t.assert.deepStrictEqual(seen, [...ids].reverse())
  })

  for (const tied of [false, true]) {
    test(`list does not skip live tasks when index entries are removed between batches${tied ? ' (same creation time)' : ''}`, async (t: TestContext) => {
      const base = Date.now()
      const ids = ['t0', 't1', 't2', 't3', 't4', 't5']
      for (let i = 0; i < ids.length; i++) {
        const createdAt = new Date(tied ? base : base + i).toISOString()
        await store.create(record({ taskId: ids[i], authSubject: 'user-1', authIssuer: ISS, createdAt }))
      }
      // The two newest tasks have expired, but their index entries remain, so
      // the first batch yields only one live task and a second batch is needed
      await redis.del('mcp:task:t5', 'mcp:task:t4')

      // Between the two batches another request prunes those stale entries, as
      // a concurrent list or delete would
      const original = redis.zrevrangebyscore.bind(redis)
      let calls = 0
      t.mock.method(redis, 'zrevrangebyscore', async (...args: any[]) => {
        if (++calls === 2) await redis.zrem(USER_1_INDEX, 't5', 't4')
        return (original as any)(...args)
      })

      const first = await store.list({ subject: 'user-1', issuer: ISS }, { limit: 2 })
      t.assert.ok(calls >= 2, 'the walk should have needed a second batch')
      t.assert.deepStrictEqual(first.tasks.map(x => x.taskId), ['t3', 't2'])
      t.assert.ok(first.nextCursor)

      const second = await store.list({ subject: 'user-1', issuer: ISS }, { cursor: first.nextCursor, limit: 2 })
      t.assert.deepStrictEqual(second.tasks.map(x => x.taskId), ['t1', 't0'])
      t.assert.strictEqual(second.nextCursor, undefined)
    })
  }

  test('list rejects an invalid cursor', async (t: TestContext) => {
    await t.assert.rejects(store.list({ subject: 'user-1', issuer: ISS }, { cursor: 'not-a-cursor' }), InvalidTaskCursorError)
  })

  test('list does not read other owners\' tasks', async (t: TestContext) => {
    for (let i = 0; i < 20; i++) {
      await store.create(record({ taskId: `other-${i}`, authSubject: 'user-2', authIssuer: ISS }))
    }
    await store.create(record({ taskId: 'mine', authSubject: 'user-1', authIssuer: ISS }))

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

    const page = await store.list({ subject: 'user-1', issuer: ISS })
    // MONITOR delivers asynchronously; a round trip flushes it
    await redis.ping()
    await new Promise(resolve => setTimeout(resolve, 50))

    t.assert.deepStrictEqual(page.tasks.map(x => x.taskId), ['mine'])
    t.assert.ok(touched.length > 0, 'monitor should have seen the list commands')
    t.assert.strictEqual(touched.some(arg => arg.includes('other-') || arg.includes('user-2')), false)
    t.assert.strictEqual(touched.some(arg => arg === 'mcp:tasks' || arg === '*'), false)
  })

  test('caps the tasks each caller retains, finished ones included', async (t: TestContext) => {
    store = new RedisTaskStore({ redis, maxTasksPerPrincipal: 2 })
    await store.create(record({ taskId: 'a', authSubject: 'user-1', authIssuer: ISS }))
    await store.create(record({ taskId: 'b', authSubject: 'user-1', authIssuer: ISS }))

    await t.assert.rejects(
      () => store.create(record({ taskId: 'c', authSubject: 'user-1', authIssuer: ISS })),
      (err: any) => err instanceof TaskLimitError && err.limit === 2
    )
    t.assert.strictEqual(await store.get('c'), null)
    t.assert.strictEqual(await redis.zcard(USER_1_INDEX), 2)

    // Another caller, and the anonymous bucket, have their own quota
    await store.create(record({ taskId: 'x', authSubject: 'user-2' }))
    await store.create(record({ taskId: 'y' }))
    t.assert.ok(await store.get('x'))
    t.assert.strictEqual(await redis.zcard('mcp:tasks:anonymous'), 1)
  })

  test('evicts the caller\'s oldest finished task to make room', async (t: TestContext) => {
    store = new RedisTaskStore({ redis, maxTasksPerPrincipal: 3 })
    const base = Date.now()
    const at = (ms: number) => new Date(base + ms).toISOString()
    await store.create(record({ taskId: 'a', authSubject: 'user-1', authIssuer: ISS, createdAt: at(0) }))
    await store.create(record({ taskId: 'b', authSubject: 'user-1', authIssuer: ISS, createdAt: at(1) }))
    await store.create(record({ taskId: 'c', authSubject: 'user-1', authIssuer: ISS, createdAt: at(2) }))
    await store.updateStatus('b', 'completed')
    await store.updateStatus('c', 'cancelled')

    await store.create(record({ taskId: 'd', authSubject: 'user-1', authIssuer: ISS, createdAt: at(3) }))

    t.assert.ok(await store.get('a'))
    t.assert.strictEqual(await store.get('b'), null)
    t.assert.ok(await store.get('c'))
    t.assert.ok(await store.get('d'))
    t.assert.deepStrictEqual(await redis.zrange(USER_1_INDEX, 0, '-1'), ['a', 'c', 'd'])
    // There is no global index, only the per-owner one
    t.assert.strictEqual(await redis.exists('mcp:tasks'), 0)
  })

  test('expired tasks no longer count against the quota', async (t: TestContext) => {
    store = new RedisTaskStore({ redis, maxTasksPerPrincipal: 1 })
    await store.create(record({ taskId: 'a', authSubject: 'user-1', authIssuer: ISS }))
    // Stand in for Redis expiring the task key
    await redis.del('mcp:task:a')

    await store.create(record({ taskId: 'b', authSubject: 'user-1', authIssuer: ISS }))
    t.assert.deepStrictEqual(await redis.zrange(USER_1_INDEX, 0, '-1'), ['b'])
  })

  test('fails orphaned tasks so they stop holding the caller\'s quota', async (t: TestContext) => {
    store = new RedisTaskStore({ redis, maxTasksPerPrincipal: 3 })
    const base = Date.now()
    const at = (ms: number) => new Date(base + ms).toISOString()
    // 'b' was running on an instance that died: its lease lapsed, nobody polled it
    await store.create(record({ taskId: 'a', authSubject: 'user-1', authIssuer: ISS, createdAt: at(0), leaseExpiresAt: base + 60_000 }))
    await store.create(record({ taskId: 'b', authSubject: 'user-1', authIssuer: ISS, createdAt: at(1), leaseExpiresAt: base - 1 }))
    await store.create(record({ taskId: 'c', authSubject: 'user-1', authIssuer: ISS, createdAt: at(2), leaseExpiresAt: base - 1 }))

    await store.create(record({ taskId: 'd', authSubject: 'user-1', authIssuer: ISS, createdAt: at(3) }))

    // 'b' was failed and, as the oldest finished task, evicted; 'c' stays, failed
    t.assert.strictEqual((await store.get('a'))?.status, 'working')
    t.assert.strictEqual(await store.get('b'), null)
    const orphan = await store.get('c')
    t.assert.strictEqual(orphan?.status, 'failed')
    t.assert.strictEqual(orphan?.statusMessage, TASK_OWNER_LOST)
    t.assert.strictEqual((orphan?.outcome as any)?.error?.message, TASK_OWNER_LOST)
    t.assert.ok(await redis.ttl('mcp:task:c') > 0)
    t.assert.ok(await store.get('d'))
  })

  test('tasks created on one store instance are visible from another', async (t: TestContext) => {
    await store.create(record({ authSubject: 'user-1', authIssuer: ISS }))

    // A second instance stands in for a second server in the cluster
    const other = new RedisTaskStore({ redis })
    const task = await other.get('task-1')

    t.assert.strictEqual(task?.taskId, 'task-1')
    t.assert.deepStrictEqual((await other.list({ subject: 'user-1', issuer: ISS })).tasks.map(x => x.taskId), ['task-1'])
  })

  test('fails a task whose lease has lapsed, keeping its retention', async (t: TestContext) => {
    await store.create(record({ leaseExpiresAt: Date.now() - 1 }))
    const ttlBefore = await redis.pttl('mcp:task:task-1')
    const outcome = { jsonrpc: '2.0' as const, id: 1, error: { code: -32603, message: 'lost' } }

    const failed = await store.failExpiredLease('task-1', { statusMessage: 'Task owner lost', outcome })
    t.assert.strictEqual(failed?.status, 'failed')
    t.assert.strictEqual(failed?.statusMessage, 'Task owner lost')
    t.assert.deepStrictEqual(failed?.outcome, outcome)
    t.assert.deepStrictEqual(await store.get('task-1'), failed)
    const ttlAfter = await redis.pttl('mcp:task:task-1')
    t.assert.ok(ttlAfter > 0 && ttlAfter <= ttlBefore)
    // Once terminal the lease can no longer be renewed
    t.assert.strictEqual(await store.renewLease('task-1', 1000), false)
  })

  test('a renewed lease is not reaped', async (t: TestContext) => {
    await store.create(record({ leaseExpiresAt: Date.now() - 1 }))
    const outcome = { jsonrpc: '2.0' as const, id: 1, error: { code: -32603, message: 'lost' } }

    t.assert.strictEqual(await store.renewLease('task-1', 60_000), true)
    const task = await store.get('task-1')
    t.assert.ok(task!.leaseExpiresAt! > Date.now())
    t.assert.strictEqual(task!.ttl, 60_000)

    const after = await store.failExpiredLease('task-1', { statusMessage: 'x', outcome })
    t.assert.strictEqual(after?.status, 'working')
  })

  test('tasks without a lease, terminal or missing tasks are not reaped', async (t: TestContext) => {
    const outcome = { jsonrpc: '2.0' as const, id: 1, error: { code: -32603, message: 'lost' } }
    await store.create(record({ taskId: 'none', ttl: null }))
    await store.create(record({ taskId: 'done', leaseExpiresAt: Date.now() - 1 }))
    await store.updateStatus('done', 'completed')

    const none = await store.failExpiredLease('none', { statusMessage: 'x', outcome })
    t.assert.strictEqual(none?.status, 'working')
    t.assert.strictEqual(none?.ttl, null)
    t.assert.strictEqual((await store.failExpiredLease('done', { statusMessage: 'x', outcome }))?.status, 'completed')
    t.assert.strictEqual(await store.failExpiredLease('missing', { statusMessage: 'x', outcome }), null)
    t.assert.strictEqual(await store.renewLease('missing', 1000), false)
  })
})
