import type { Redis } from 'ioredis'
import type { TaskStatus } from '../schema.ts'
import type { TaskStore, TaskRecord, TaskOutcome, TaskListOptions, TaskListPage } from './task-store.ts'
import {
  canTransition,
  decodeTaskCursor,
  encodeTaskCursor,
  isAfterTaskCursor,
  isTerminal,
  taskHasExpired,
  taskPageLimit
} from './task-store.ts'

const TASK_KEY_PREFIX = 'mcp:task:'
const OWNER_INDEX_PREFIX = 'mcp:tasks:owner:'
const ANONYMOUS_INDEX_KEY = 'mcp:tasks:anonymous'

// Add a task to its owner's index and stretch the index's expiry so it outlives
// every task it references. A negative expiry means the task never expires, so
// the index must not either.
const INDEX_ADD_SCRIPT = `
local existed = redis.call('EXISTS', KEYS[1])
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
local secs = tonumber(ARGV[3])
if secs < 0 then
  redis.call('PERSIST', KEYS[1])
elseif existed == 0 then
  redis.call('EXPIRE', KEYS[1], secs)
else
  local current = redis.call('TTL', KEYS[1])
  if current >= 0 and current < secs then
    redis.call('EXPIRE', KEYS[1], secs)
  end
end
return 1
`

/**
 * Redis-backed task store, so tasks created on one instance can be polled from
 * any other. Task retention is enforced with Redis key expiry, which means an
 * expired task disappears without us having to sweep it.
 */
export class RedisTaskStore implements TaskStore {
  private redis: Redis
  private readonly defaultTtlMs: number

  constructor (options: { redis: Redis, defaultTtlMs?: number }) {
    this.redis = options.redis
    this.defaultTtlMs = options.defaultTtlMs ?? 3600_000
  }

  private key (taskId: string): string {
    return `${TASK_KEY_PREFIX}${taskId}`
  }

  /**
   * Per-owner index of task ids scored by creation time, so `list` only ever
   * touches the caller's own tasks. Subject-less tasks get a separate key that
   * cannot collide with any subject's.
   */
  private indexKey (authSubject?: string): string {
    return authSubject === undefined ? ANONYMOUS_INDEX_KEY : `${OWNER_INDEX_PREFIX}${authSubject}`
  }

  private expirySeconds (task: TaskRecord): number {
    const ttl = task.ttl ?? this.defaultTtlMs
    return Math.max(1, Math.ceil(ttl / 1000))
  }

  async create (task: TaskRecord): Promise<void> {
    const key = this.key(task.taskId)
    const multi = this.redis.multi()
    // A null ttl means unlimited retention (matching taskHasExpired and the
    // memory store), so write the key without an expiry rather than falling back
    // to the default and silently expiring it.
    if (task.ttl === null) {
      multi.set(key, JSON.stringify(task))
    } else {
      multi.set(key, JSON.stringify(task), 'EX', this.expirySeconds(task))
    }
    // The index lets `list` enumerate one owner's tasks without a keyspace scan.
    // Task keys expire independently, so stale ids are pruned on read.
    multi.eval(
      INDEX_ADD_SCRIPT,
      1,
      this.indexKey(task.authSubject),
      new Date(task.createdAt).getTime(),
      task.taskId,
      task.ttl === null ? -1 : this.expirySeconds(task)
    )
    await multi.exec()
  }

  async get (taskId: string): Promise<TaskRecord | null> {
    const raw = await this.redis.get(this.key(taskId))
    if (!raw) return null

    let task: TaskRecord
    try {
      task = JSON.parse(raw)
    } catch {
      return null
    }

    if (taskHasExpired(task)) {
      await this.delete(taskId)
      return null
    }
    return task
  }

  async updateStatus (
    taskId: string,
    status: TaskStatus,
    options: { statusMessage?: string, outcome?: TaskOutcome } = {}
  ): Promise<TaskRecord | null> {
    const task = await this.get(taskId)
    if (!task) return null

    if (task.status !== status) {
      if (isTerminal(task.status)) {
        throw new Error(`Task ${taskId} is already in terminal status '${task.status}'`)
      }
      if (!canTransition(task.status, status)) {
        throw new Error(`Invalid task transition '${task.status}' -> '${status}'`)
      }
    }

    const updated: TaskRecord = {
      ...task,
      status,
      lastUpdatedAt: new Date().toISOString()
    }
    if (options.statusMessage !== undefined) {
      updated.statusMessage = options.statusMessage
    }
    if (options.outcome !== undefined) {
      updated.outcome = options.outcome
    }

    // The read above and this write are two round trips, so a concurrent write
    // can slip between them. Re-check the stored status atomically in Lua and
    // refuse if it has since become terminal, so a cancel and a completion
    // racing on the same task cannot overwrite each other — the spec requires a
    // cancelled task to stay cancelled. KEEPTTL preserves retention-from-creation.
    const result = await this.redis.eval(
      `local raw = redis.call('GET', KEYS[1])
       if not raw then return false end
       local ok, cur = pcall(cjson.decode, raw)
       if not ok then return false end
       local s = cur.status
       if s == 'completed' or s == 'failed' or s == 'cancelled' then return s end
       redis.call('SET', KEYS[1], ARGV[1], 'KEEPTTL')
       return 'OK'`,
      1,
      this.key(taskId),
      JSON.stringify(updated)
    )

    if (result === null) return null
    if (result !== 'OK') {
      // A terminal status was written concurrently; `result` is that status
      throw new Error(`Task ${taskId} is already in terminal status '${result}'`)
    }
    return updated
  }

  async list (authSubject?: string, options: TaskListOptions = {}): Promise<TaskListPage> {
    const after = options.cursor === undefined ? undefined : decodeTaskCursor(options.cursor)
    const limit = taskPageLimit(options.limit)
    const indexKey = this.indexKey(authSubject)

    // Walk the owner's index newest first from the cursor's score. Entries that
    // share the cursor's score but sort at or before it are skipped by id. One
    // extra live task is fetched to know whether another page follows.
    const max = after ? after.createdAt : '+inf'
    const tasks: TaskRecord[] = []
    const stale: string[] = []
    let offset = 0

    while (tasks.length <= limit) {
      const count = limit + 1 - tasks.length
      const entries = await this.redis.zrevrangebyscore(indexKey, max, '-inf', 'WITHSCORES', 'LIMIT', offset, count)
      if (entries.length === 0) break
      offset += entries.length / 2

      const ids: string[] = []
      for (let i = 0; i < entries.length; i += 2) {
        const id = entries[i]
        if (after && !isAfterTaskCursor(Number(entries[i + 1]), id, after)) continue
        ids.push(id)
      }
      if (ids.length === 0) continue

      const raws = await this.redis.mget(ids.map(id => this.key(id)))
      for (let i = 0; i < ids.length; i++) {
        const raw = raws[i]
        if (!raw) {
          stale.push(ids[i])
          continue
        }
        let task: TaskRecord
        try {
          task = JSON.parse(raw)
        } catch {
          continue
        }
        if (taskHasExpired(task)) {
          stale.push(ids[i])
          continue
        }
        // The index is per owner, but never trust it over the record itself
        if (task.authSubject !== authSubject) continue
        tasks.push(task)
      }
    }

    // Pruned after the walk so removals do not shift the offsets used above
    if (stale.length > 0) {
      await this.redis.zrem(indexKey, ...stale)
    }

    const page: TaskListPage = { tasks: tasks.slice(0, limit) }
    if (tasks.length > limit) {
      page.nextCursor = encodeTaskCursor(page.tasks[page.tasks.length - 1])
    }
    return page
  }

  async delete (taskId: string): Promise<void> {
    const key = this.key(taskId)
    const raw = await this.redis.get(key)
    let authSubject: string | undefined
    try {
      authSubject = raw ? (JSON.parse(raw) as TaskRecord).authSubject : undefined
    } catch {}

    const multi = this.redis.multi().del(key)
    // Without the record we cannot tell which index holds the id; `list` prunes
    // it lazily instead.
    if (raw) multi.zrem(this.indexKey(authSubject), taskId)
    await multi.exec()
  }

  async cleanup (): Promise<void> {
    // Task keys and owner indexes both expire on their own, and stale index
    // entries are pruned whenever an owner lists. Sweeping every owner's index
    // here would mean scanning the keyspace, so there is nothing to do.
  }
}
