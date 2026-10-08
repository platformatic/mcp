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

  test('tool and client data survive status and input updates unchanged', async (t: TestContext) => {
    // Lua's cjson would turn [] into {} and round past 14 significant digits.
    const data = { items: [], nested: { list: [[]] }, big: 1234567890123456, small: 0.1 + 0.2 }
    await store.create(record({ status: 'working' }))

    const parked = await store.updateStatus('task-1', 'input_required', {
      inputRequests: { pick: { method: 'elicitation/create', params: { requestedSchema: { required: [] } } } },
      incrementInputRequestRound: true
    })
    t.assert.deepStrictEqual(parked?.inputRequests, {
      pick: { method: 'elicitation/create', params: { requestedSchema: { required: [] } } }
    })

    const staged = await store.updateInputResponses('task-1', { pick: { action: 'accept', content: data } }, 'delivery-1')
    t.assert.deepStrictEqual(staged?.responses, { pick: { action: 'accept', content: data } })
    t.assert.deepStrictEqual((await store.get('task-1'))?.pendingInputResponses, {
      pick: { action: 'accept', content: data }
    })

    const outcome = { jsonrpc: '2.0', id: 1, result: { content: [], structuredContent: data } } as any
    const completed = await store.updateStatus('task-1', 'completed', { outcome })
    t.assert.deepStrictEqual(completed?.outcome, outcome)
    t.assert.deepStrictEqual((await store.get('task-1'))?.outcome, outcome)
  })

  test('answering the last outstanding key moves the task to working', async (t: TestContext) => {
    await store.create(record({
      status: 'input_required',
      inputRequests: { a: { method: 'elicitation/create' }, b: { method: 'elicitation/create' } }
    }))

    await store.updateInputResponses('task-1', { a: 'yes' }, 'delivery-1')
    t.assert.strictEqual((await store.get('task-1'))?.status, 'input_required')

    await store.updateInputResponses('task-1', { b: 'yes' }, 'delivery-2')
    const task = await store.get('task-1')
    t.assert.strictEqual(task?.status, 'working')
    t.assert.strictEqual(task?.inputRequests, undefined)
  })

  test('a null statusMessage clears the stale one', async (t: TestContext) => {
    await store.create(record({ status: 'working', statusMessage: 'Confirm?' }))
    const updated = await store.updateStatus('task-1', 'completed', { statusMessage: null })
    t.assert.strictEqual(updated?.statusMessage, undefined)
    t.assert.strictEqual((await store.get('task-1'))?.statusMessage, undefined)
  })

  test('a lapsed lease fails the task by the Redis clock', async (t: TestContext) => {
    await store.create(record({ status: 'working' }))
    t.assert.strictEqual(await store.renewLease('task-1', 60_000), 'working')
    const outcome = { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'lost' } } as any
    t.assert.strictEqual(await store.expireStaleLease('task-1', 'lost', outcome), null, 'lease still live')

    t.assert.strictEqual(await store.renewLease('task-1', 1), 'working')
    await new Promise(resolve => setTimeout(resolve, 20))
    const failed = await store.expireStaleLease('task-1', 'lost', outcome)
    t.assert.strictEqual(failed?.status, 'failed')
    t.assert.deepStrictEqual((await store.get('task-1'))?.outcome, outcome)
    // A terminal task is never renewed or failed again.
    t.assert.strictEqual(await store.renewLease('task-1', 60_000), 'failed')
    t.assert.strictEqual(await store.expireStaleLease('task-1', 'lost', outcome), null)
  })

  test('records live under a versioned keyspace', async (t: TestContext) => {
    await store.create(record())
    t.assert.strictEqual(await redis.exists('mcp:task:v2:task-1'), 1)
    t.assert.strictEqual(await redis.exists('mcp:task:task-1'), 0)
  })

  test('a lone surrogate in a status message does not break the Lua scripts', async (t: TestContext) => {
    await store.create(record({ status: 'working' }))
    const updated = await store.updateStatus('task-1', 'input_required', {
      statusMessage: 'Confirm for \ud83d',
      inputRequests: { ok: { method: 'elicitation/create' } }
    })
    t.assert.strictEqual(updated?.status, 'input_required')
    t.assert.strictEqual((await store.updateInputResponses('task-1', { ok: 'yes' }, 'd1'))?.task.status, 'working')
  })

  test('retries staged input until broker publication is accepted', async (t: TestContext) => {
    await store.create(record({
      status: 'input_required',
      inputRequests: { confirmation: { method: 'elicitation/create' } }
    }))

    const first = await store.updateInputResponses('task-1', { confirmation: 'yes' }, 'delivery-1')
    t.assert.deepStrictEqual(first?.responses, { confirmation: 'yes' })
    t.assert.deepStrictEqual((await store.get('task-1'))?.pendingInputResponses, { confirmation: 'yes' })

    const retry = await store.updateInputResponses('task-1', { confirmation: 'changed replay' }, 'delivery-2')
    t.assert.deepStrictEqual(retry?.responses, { confirmation: 'yes' })
    t.assert.deepStrictEqual(retry?.responseIds, { confirmation: 'delivery-1' })

    await store.acknowledgeInputResponses('task-1', { confirmation: 'wrong-delivery' })
    t.assert.deepStrictEqual((await store.get('task-1'))?.pendingInputResponses, { confirmation: 'yes' })

    await store.acknowledgeInputResponses('task-1', { confirmation: 'delivery-1' })
    t.assert.strictEqual((await store.get('task-1'))?.pendingInputResponses, undefined)
    t.assert.deepStrictEqual(
      (await store.updateInputResponses('task-1', { confirmation: 'yes' }, 'delivery-3'))?.responses,
      {}
    )
  })

  test('republishes outbox entries created before input rounds were recorded', async (t: TestContext) => {
    await store.create(record({
      status: 'input_required',
      pendingInputResponses: { confirmation: 'legacy' },
      pendingInputResponseIds: { confirmation: 'delivery-1' },
      answeredInputKeys: ['confirmation']
    }))

    const retry = await store.updateInputResponses('task-1', { confirmation: 'retry' }, 'delivery-2')
    t.assert.deepStrictEqual(retry?.responses, { confirmation: 'legacy' })
    t.assert.deepStrictEqual(retry?.responseIds, { confirmation: 'delivery-1' })
  })

  test('a status update cannot clobber concurrently staged input', async (t: TestContext) => {
    for (let index = 0; index < 20; index++) {
      const taskId = `race-${index}`
      await store.create(record({
        taskId,
        status: 'input_required',
        inputRequests: { confirmation: { method: 'elicitation/create' } }
      }))

      await Promise.all([
        store.updateStatus(taskId, 'working'),
        store.updateInputResponses(taskId, { confirmation: 'yes' }, `delivery-${index}`)
      ])

      const task = await store.get(taskId)
      t.assert.deepStrictEqual(task?.pendingInputResponses, { confirmation: 'yes' })
      t.assert.deepStrictEqual(task?.pendingInputResponseIds, { confirmation: `delivery-${index}` })
    }
  })

  test('a status change does not extend the retention window', async (t: TestContext) => {
    await store.create(record({ ttl: 60_000 }))
    const before = await redis.ttl('mcp:task:v2:task-1')

    await store.updateStatus('task-1', 'completed')
    const after = await redis.ttl('mcp:task:v2:task-1')

    t.assert.ok(after <= before, `ttl should not grow: ${before} -> ${after}`)
    t.assert.ok(after > 0, 'task should still be retained')
  })

  test('a null ttl means unlimited retention, not the default expiry', async (t: TestContext) => {
    await store.create(record({ ttl: null }))

    // -1 is Redis for "key exists but has no expiry"; the default must not apply
    t.assert.strictEqual(await redis.ttl('mcp:task:v2:task-1'), -1)
    t.assert.strictEqual((await store.get('task-1'))?.ttl, null)
  })

  test('retention follows the Redis key expiry, not the reading instance\'s clock', async (t: TestContext) => {
    // As seen by an instance whose clock runs 10s ahead of the creator's.
    await store.create(record({ createdAt: new Date(Date.now() - 10_000).toISOString(), ttl: 1_000 }))
    t.assert.ok(await store.get('task-1'), 'a skewed clock must not delete a live task')
    t.assert.ok(await redis.exists('mcp:task:v2:task-1'))

    await new Promise(resolve => setTimeout(resolve, 1_100))
    t.assert.strictEqual(await store.get('task-1'), null, 'gone once Redis expires the key')
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
    t.assert.strictEqual(await redis.zcard('mcp:tasks:v2'), 0)
  })

  test('cleanup prunes index entries whose task key is gone', async (t: TestContext) => {
    await store.create(record())
    await redis.del('mcp:task:v2:task-1')
    t.assert.strictEqual(await redis.zcard('mcp:tasks:v2'), 1)

    await store.cleanup()
    t.assert.strictEqual(await redis.zcard('mcp:tasks:v2'), 0)
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
