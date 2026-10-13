import type { Redis } from 'ioredis'
import type { TaskStatus } from '../schema.ts'
import type { TaskStore, TaskRecord, TaskOutcome, TaskListOptions, TaskListPage, TaskCursorPosition } from './task-store.ts'
import {
  DEFAULT_TASK_MAX_PER_PRINCIPAL,
  TaskLimitError,
  canTransition,
  decodeTaskCursor,
  encodeTaskCursor,
  isTerminal,
  taskPageLimit,
  validateTaskLimit
} from './task-store.ts'

const TASK_KEY_PREFIX = 'mcp:task:'
const OWNER_INDEX_PREFIX = 'mcp:tasks:owner:'
const ANONYMOUS_INDEX_KEY = 'mcp:tasks:anonymous'

// Store a task while enforcing its owner's retention cap, atomically so that
// concurrent creates on different instances cannot overshoot it.
//
// KEYS: task key, owner index
// ARGV: task JSON, expiry seconds (-1 = none), score, task id, cap, task key prefix
//
// The owner index is a sorted set of task ids scored by creation time (the same
// one `list` pages through). Ids whose task key has expired are pruned first;
// then, at the cap, the oldest finished tasks are evicted. Returns 0 (storing
// nothing) when the owner is at the cap with nothing finished to evict. Task
// keys are derived from index members, so this needs a standalone Redis (or
// every key in one slot).
const CREATE_SCRIPT = `
local prefix = ARGV[6]
local cap = tonumber(ARGV[5])
local live = {}
for _, id in ipairs(redis.call('ZRANGE', KEYS[2], 0, -1)) do
  if redis.call('EXISTS', prefix .. id) == 1 then
    table.insert(live, id)
  else
    redis.call('ZREM', KEYS[2], id)
  end
end

local need = #live - cap + 1
if need > 0 then
  local victims = {}
  for _, id in ipairs(live) do
    if #victims >= need then break end
    local ok, cur = pcall(cjson.decode, redis.call('GET', prefix .. id))
    local s = ok and type(cur) == 'table' and cur.status
    if s == 'completed' or s == 'failed' or s == 'cancelled' then
      table.insert(victims, id)
    end
  end
  if #victims < need then return 0 end
  for _, id in ipairs(victims) do
    redis.call('DEL', prefix .. id)
    redis.call('ZREM', KEYS[2], id)
  end
end

local secs = tonumber(ARGV[2])
if secs < 0 then
  redis.call('SET', KEYS[1], ARGV[1])
else
  redis.call('SET', KEYS[1], ARGV[1], 'EX', secs)
end

-- Stretch the owner index's expiry so it outlives every task it references,
-- and never expire it while it holds a task that never expires.
local existed = redis.call('EXISTS', KEYS[2])
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[4])
if secs < 0 then
  redis.call('PERSIST', KEYS[2])
elseif existed == 0 then
  redis.call('EXPIRE', KEYS[2], secs)
else
  local current = redis.call('TTL', KEYS[2])
  if current >= 0 and current < secs then
    redis.call('EXPIRE', KEYS[2], secs)
  end
end
return 1
`

/**
 * Order task ids the way Redis orders members that share a score: by their
 * bytes, not by UTF-16 code units as `<` on strings would.
 */
function compareIds (a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b))
}

/**
 * Redis-backed task store, so tasks created on one instance can be polled from
 * any other. Task retention is enforced with Redis key expiry, which means an
 * expired task disappears without us having to sweep it.
 */
export class RedisTaskStore implements TaskStore {
  private redis: Redis
  private readonly defaultTtlMs: number
  private readonly maxTasksPerPrincipal: number

  constructor (options: { redis: Redis, defaultTtlMs?: number, maxTasksPerPrincipal?: number }) {
    this.redis = options.redis
    this.defaultTtlMs = options.defaultTtlMs ?? 3600_000
    this.maxTasksPerPrincipal = options.maxTasksPerPrincipal ?? DEFAULT_TASK_MAX_PER_PRINCIPAL
    validateTaskLimit('maxTasksPerPrincipal', this.maxTasksPerPrincipal)
  }

  private key (taskId: string): string {
    return `${TASK_KEY_PREFIX}${taskId}`
  }

  /**
   * Per-owner index of task ids scored by creation time, so `list` only ever
   * touches the caller's own tasks and `create` can enforce the retention cap.
   * Subject-less tasks get a separate key that cannot collide with any subject's.
   */
  private indexKey (authSubject?: string): string {
    return authSubject === undefined ? ANONYMOUS_INDEX_KEY : `${OWNER_INDEX_PREFIX}${authSubject}`
  }

  private expirySeconds (task: TaskRecord): number {
    const ttl = task.ttl ?? this.defaultTtlMs
    return Math.max(1, Math.ceil(ttl / 1000))
  }

  async create (task: TaskRecord): Promise<void> {
    // A null ttl means unlimited retention (matching taskHasExpired and the
    // memory store), so write the key without an expiry rather than falling back
    // to the default and silently expiring it.
    // The owner index lets `list` enumerate one owner's tasks without a keyspace
    // scan. Task keys expire independently, so stale ids are pruned here and on read.
    const stored = await this.redis.eval(
      CREATE_SCRIPT,
      2,
      this.key(task.taskId),
      this.indexKey(task.authSubject),
      JSON.stringify(task),
      task.ttl === null ? -1 : this.expirySeconds(task),
      new Date(task.createdAt).getTime(),
      task.taskId,
      this.maxTasksPerPrincipal,
      TASK_KEY_PREFIX
    )
    if (stored !== 1) {
      throw new TaskLimitError(this.maxTasksPerPrincipal)
    }
  }

  async get (taskId: string): Promise<TaskRecord | null> {
    const raw = await this.redis.get(this.key(taskId))
    if (!raw) return null

    // Retention is enforced by the key expiry alone. Re-checking createdAt + ttl
    // here would compare another instance's timestamp with our clock, and a
    // fast clock would then hide (or delete) tasks that are still live.
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
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

  async renewLease (taskId: string, leaseMs: number): Promise<boolean> {
    // The expiry is computed from the Redis server clock, as is the check in
    // failExpiredLease, so clock skew between instances cannot fail a live task.
    const result = await this.redis.eval(
      `local raw = redis.call('GET', KEYS[1])
       if not raw then return 0 end
       local ok, cur = pcall(cjson.decode, raw)
       if not ok then return 0 end
       local s = cur.status
       if s == 'completed' or s == 'failed' or s == 'cancelled' then return 0 end
       local t = redis.call('TIME')
       cur.leaseExpiresAt = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000) + tonumber(ARGV[1])
       redis.call('SET', KEYS[1], cjson.encode(cur), 'KEEPTTL')
       return 1`,
      1,
      this.key(taskId),
      String(leaseMs)
    )
    return result === 1
  }

  async failExpiredLease (
    taskId: string,
    options: { statusMessage: string, outcome: TaskOutcome }
  ): Promise<TaskRecord | null> {
    // Compare-and-set in one script: only a non-terminal task whose lease has
    // lapsed is failed, so a renewal (or completion) that lands first wins.
    const raw = await this.redis.eval(
      `local raw = redis.call('GET', KEYS[1])
       if not raw then return false end
       local ok, cur = pcall(cjson.decode, raw)
       if not ok then return false end
       local s = cur.status
       if s == 'completed' or s == 'failed' or s == 'cancelled' then return raw end
       if type(cur.leaseExpiresAt) ~= 'number' then return raw end
       local t = redis.call('TIME')
       local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
       if cur.leaseExpiresAt > now then return raw end
       cur.status = 'failed'
       cur.statusMessage = ARGV[1]
       cur.outcome = cjson.decode(ARGV[2])
       cur.lastUpdatedAt = ARGV[3]
       local updated = cjson.encode(cur)
       redis.call('SET', KEYS[1], updated, 'KEEPTTL')
       return updated`,
      1,
      this.key(taskId),
      options.statusMessage,
      JSON.stringify(options.outcome),
      new Date().toISOString()
    ) as string | null

    if (!raw) return null
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  }

  async list (authSubject?: string, options: TaskListOptions = {}): Promise<TaskListPage> {
    const limit = taskPageLimit(options.limit)
    const indexKey = this.indexKey(authSubject)

    // Walk the owner's index newest first. Each batch resumes from the last
    // (score, id) pair scanned, never from an offset, so entries removed by a
    // concurrent request between batches cannot make the walk skip live tasks.
    // One extra live task is fetched to know whether another page follows.
    let position: TaskCursorPosition | undefined =
      options.cursor === undefined ? undefined : decodeTaskCursor(options.cursor)
    // Whether the members sharing the position's score still have to be read
    let tiesPending = position !== undefined
    const tasks: TaskRecord[] = []
    const stale: string[] = []

    while (tasks.length <= limit) {
      let ids: string[]
      if (position && tiesPending) {
        // Members with the same score sort by id, which a score range cannot
        // express, so read the whole same-millisecond group and keep the ids
        // after the position. Such groups are small: one owner's tasks created
        // within a single millisecond.
        const tied = await this.redis.zrevrangebyscore(indexKey, position.createdAt, position.createdAt)
        const after = position.taskId
        ids = tied.filter(id => compareIds(id, after) < 0)
        tiesPending = false
      } else {
        const count = limit + 1 - tasks.length
        const max = position ? `(${position.createdAt}` : '+inf'
        const entries = await this.redis.zrevrangebyscore(indexKey, max, '-inf', 'WITHSCORES', 'LIMIT', 0, count)
        if (entries.length === 0) break
        ids = []
        for (let i = 0; i < entries.length; i += 2) ids.push(entries[i])
        // The batch may stop part way through a same-score group; the next
        // iteration picks up the rest of it before moving to older scores.
        position = { createdAt: Number(entries[entries.length - 1]), taskId: ids[ids.length - 1] }
        tiesPending = true
      }
      if (ids.length === 0) continue

      const raws = await this.redis.mget(ids.map(id => this.key(id)))
      for (let i = 0; i < ids.length; i++) {
        const raw = raws[i]
        if (!raw) {
          // Expiry is decided by Redis alone (see get), so only a missing key is stale
          stale.push(ids[i])
          continue
        }
        let task: TaskRecord
        try {
          task = JSON.parse(raw)
        } catch {
          continue
        }
        // The index is per owner, but never trust it over the record itself
        if (task.authSubject !== authSubject) continue
        tasks.push(task)
      }
    }

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
