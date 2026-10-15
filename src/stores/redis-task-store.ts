import type { Redis } from 'ioredis'
import type { TaskStatus } from '../schema.ts'
import type {
  TaskStore,
  TaskRecord,
  TaskUpdateOptions,
  TaskInputUpdate,
  TaskOutcome,
  TaskListOptions,
  TaskListPage,
  TaskCursorPosition
} from './task-store.ts'
import {
  DEFAULT_TASK_MAX_PER_PRINCIPAL,
  TaskLimitError,
  TASK_OWNER_LOST,
  applyInputRequestUpdates,
  canTransition,
  decodeTaskCursor,
  encodeTaskCursor,
  isTerminal,
  matchesTaskEra,
  ownerLostOutcome,
  taskPageLimit,
  validateTaskLimit
} from './task-store.ts'

// Versioned: records here store opaque fields as JSON strings, which earlier
// releases cannot read. A separate keyspace keeps old and new instances from
// misreading each other's tasks during a rolling deploy or a rollback.
const TASK_KEY_PREFIX = 'mcp:task:v2:'
const OWNER_INDEX_PREFIX = 'mcp:tasks:v2:owner:'
const ANONYMOUS_INDEX_KEY = 'mcp:tasks:v2:anonymous'

/**
 * Lua's cjson cannot round-trip arbitrary JSON: it turns empty arrays into
 * objects and keeps only 14 significant digits. The scripts below rewrite
 * records in place, so every field carrying tool or client data is stored as a
 * JSON string they pass through without decoding.
 */
function encodeOpaqueMap (map: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (map === undefined) return undefined
  return Object.fromEntries(Object.entries(map).map(([key, value]) => [key, JSON.stringify(value)]))
}

function decodeOpaqueMap (map: unknown): Record<string, unknown> | undefined {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return undefined
  return Object.fromEntries(Object.entries(map).map(([key, value]) =>
    [key, typeof value === 'string' ? JSON.parse(value) : value]
  ))
}

/**
 * Replace lone UTF-16 surrogates, which JSON.stringify escapes as `\udXXX`
 * and Lua's cjson then refuses to decode, failing every script on the record.
 */
function toWellFormed (value: string): string {
  return value.toWellFormed()
}

function encodeTask (task: TaskRecord): string {
  return JSON.stringify({
    ...task,
    ...(task.statusMessage !== undefined ? { statusMessage: toWellFormed(task.statusMessage) } : {}),
    ...(task.authSubject !== undefined ? { authSubject: toWellFormed(task.authSubject) } : {}),
    outcome: task.outcome === undefined ? undefined : JSON.stringify(task.outcome),
    inputRequests: encodeOpaqueMap(task.inputRequests),
    pendingInputResponses: encodeOpaqueMap(task.pendingInputResponses)
  })
}

function decodeTask (raw: string): TaskRecord {
  return fromStored(JSON.parse(raw))
}

function fromStored (stored: any): TaskRecord {
  const task: TaskRecord = { ...stored }
  // Records written before this encoding hold the outcome as an object.
  if (typeof stored.outcome === 'string') task.outcome = JSON.parse(stored.outcome)
  if (stored.inputRequests !== undefined) task.inputRequests = decodeOpaqueMap(stored.inputRequests)
  if (stored.pendingInputResponses !== undefined) {
    task.pendingInputResponses = decodeOpaqueMap(stored.pendingInputResponses)
  }
  return task
}

// Store a task while enforcing its owner's retention cap, atomically so that
// concurrent creates on different instances cannot overshoot it.
//
// KEYS: task key, owner index
// ARGV: task JSON, expiry seconds (-1 = none), score, task id, cap, task key
//       prefix, then the status message, encoded outcome and timestamp for
//       orphaned tasks, then the lease in ms ('' for none)
//
// The owner index is a sorted set of task ids scored by creation time (the same
// one `list` pages through). Ids whose task key has expired are pruned first,
// so an index nobody lists cannot grow without bound; then, at the cap, tasks
// whose lease has lapsed (their instance died) are failed, as expireStaleLease
// would, and the oldest finished tasks are evicted. Returns 0 (storing nothing)
// when the owner is at the cap with nothing finished to evict. Task keys are
// derived from index members, so this needs a standalone Redis (or every key
// in one slot).
//
// Leases are timed by Redis's own clock, so the new task's first lease is
// stamped here: one taken from the creating instance's clock could look lapsed
// to the check above on a concurrent create.
const CREATE_SCRIPT = `
local prefix = ARGV[6]
local cap = tonumber(ARGV[5])
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
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
    local ok, cur = pcall(cjson.decode, redis.call('GET', prefix .. id))
    local s = ok and type(cur) == 'table' and cur.status
    if s == 'completed' or s == 'failed' or s == 'cancelled' then
      if #victims < need then table.insert(victims, id) end
    elseif s and type(cur.leaseExpiresAt) == 'number' and cur.leaseExpiresAt <= now then
      cur.status = 'failed'
      cur.statusMessage = ARGV[7]
      cur.outcome = ARGV[8]
      cur.lastUpdatedAt = ARGV[9]
      cur.inputRequests = nil
      cur.pendingInputResponses = nil
      cur.pendingInputResponseIds = nil
      cur.pendingInputResponseRounds = nil
      redis.call('SET', prefix .. id, cjson.encode(cur), 'KEEPTTL')
      if #victims < need then table.insert(victims, id) end
    end
  end
  if #victims < need then return 0 end
  for _, id in ipairs(victims) do
    redis.call('DEL', prefix .. id)
    redis.call('ZREM', KEYS[2], id)
  end
end

local record = ARGV[1]
if ARGV[10] ~= '' then
  local task = cjson.decode(record)
  task.leaseExpiresAt = now + tonumber(ARGV[10])
  record = cjson.encode(task)
end

local secs = tonumber(ARGV[2])
if secs < 0 then
  redis.call('SET', KEYS[1], record)
else
  redis.call('SET', KEYS[1], record, 'EX', secs)
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
    // A null ttl means unlimited retention (matching taskHasExpired and the
    // memory store), so write the key without an expiry rather than falling back
    // to the default and silently expiring it. The owner index lets `list`
    // enumerate one owner's tasks without a keyspace scan; task keys expire
    // independently, so stale ids are pruned here and on read.
    const { leaseExpiresAt, ...rest } = task
    // Restamped by the script against the Redis clock, keeping its length (a
    // lease already in the past stays lapsed).
    const leaseMs = leaseExpiresAt === undefined ? '' : String(leaseExpiresAt - Date.now())
    const stored = await this.redis.eval(
      CREATE_SCRIPT,
      2,
      this.key(task.taskId),
      this.indexKey(task.authSubject),
      encodeTask(rest),
      task.ttl === null ? -1 : this.expirySeconds(task),
      new Date(task.createdAt).getTime(),
      task.taskId,
      this.maxTasksPerPrincipal,
      TASK_KEY_PREFIX,
      toWellFormed(TASK_OWNER_LOST),
      JSON.stringify(ownerLostOutcome()),
      new Date().toISOString(),
      leaseMs
    )
    if (stored !== 1) {
      throw new TaskLimitError(this.maxTasksPerPrincipal)
    }
  }

  async get (taskId: string): Promise<TaskRecord | null> {
    const raw = await this.redis.get(this.key(taskId))
    if (!raw) return null

    // Retention is the key's own expiry (SET … EX), timed by Redis. Judging it
    // again by this instance's clock would let one instance whose clock runs
    // ahead delete tasks that are still running, for every instance.
    try {
      return decodeTask(raw)
    } catch {
      return null
    }
  }

  async updateStatus (
    taskId: string,
    status: TaskStatus,
    options: TaskUpdateOptions = {}
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
    if (options.statusMessage === null) {
      delete updated.statusMessage
    } else if (options.statusMessage !== undefined) {
      updated.statusMessage = options.statusMessage
    }
    if (options.outcome !== undefined) {
      updated.outcome = options.outcome
    }
    applyInputRequestUpdates(updated, options)

    // The read above and this write are two round trips, so a concurrent write
    // can slip between them. Re-check the stored status atomically in Lua and
    // merge input/outbox bookkeeping from the current record when this status
    // update did not explicitly replace it. That prevents task execution from
    // clobbering a concurrent tasks/update. KEEPTTL preserves retention.
    const preserveInputRequests = options.inputRequests === undefined &&
      !options.clearAnsweredInputKeys &&
      !options.answeredInputKeys?.length
    const preservePendingResponses = !options.clearPendingInputResponses
    const result = await this.redis.eval(
      `local raw = redis.call('GET', KEYS[1])
       if not raw then return false end
       local ok, cur = pcall(cjson.decode, raw)
       if not ok then return false end
       local s = cur.status
       if s == 'completed' or s == 'failed' or s == 'cancelled' then return s end

       local proposed = cjson.decode(ARGV[1])
       if ARGV[2] == '1' then
         proposed.inputRequests = cur.inputRequests
         proposed.answeredInputKeys = cur.answeredInputKeys
         proposed.inputRequestRound = cur.inputRequestRound
       end
       if ARGV[3] == '1' then
         proposed.pendingInputResponses = cur.pendingInputResponses
         proposed.pendingInputResponseIds = cur.pendingInputResponseIds
         proposed.pendingInputResponseRounds = cur.pendingInputResponseRounds
       end
       if ARGV[4] == '1' then
         proposed.inputRequestRound = (cur.inputRequestRound or 0) + 1
       end

       local encoded = cjson.encode(proposed)
       redis.call('SET', KEYS[1], encoded, 'KEEPTTL')
       return encoded`,
      1,
      this.key(taskId),
      encodeTask(updated),
      preserveInputRequests ? '1' : '0',
      preservePendingResponses ? '1' : '0',
      options.incrementInputRequestRound ? '1' : '0'
    )

    if (result === null) return null
    if (result === 'completed' || result === 'failed' || result === 'cancelled') {
      // A terminal status was written concurrently; `result` is that status.
      throw new Error(`Task ${taskId} is already in terminal status '${result}'`)
    }
    if (typeof result !== 'string') return null
    return decodeTask(result)
  }

  async updateInputResponses (
    taskId: string,
    responses: Record<string, unknown>,
    responseId: string,
    round?: number
  ): Promise<TaskInputUpdate | null> {
    const result = await this.redis.eval(
      `local raw = redis.call('GET', KEYS[1])
       if not raw then return nil end
       local ok, task = pcall(cjson.decode, raw)
       if not ok then return nil end

       local submitted = cjson.decode(ARGV[1])
       local outstanding = task.inputRequests or {}
       local pending = task.pendingInputResponses or {}
       local pendingIds = task.pendingInputResponseIds or {}
       local pendingRounds = task.pendingInputResponseRounds or {}
       local currentRound = task.inputRequestRound or 0
       local answered = task.answeredInputKeys or {}
       local answeredSet = {}
       for _, key in ipairs(answered) do answeredSet[key] = true end

       local terminal = task.status == 'completed' or task.status == 'failed' or task.status == 'cancelled'
       local sameRound = ARGV[4] == '' or tonumber(ARGV[4]) == currentRound
       local deliverable = {}
       local responseIds = {}
       local changed = false

       for key, value in pairs(submitted) do
         if pending[key] ~= nil and (pendingRounds[key] == nil or pendingRounds[key] == currentRound) then
           deliverable[key] = pending[key]
           responseIds[key] = pendingIds[key] or ARGV[3]
         elseif not terminal and sameRound and outstanding[key] ~= nil and not answeredSet[key] then
           deliverable[key] = value
           responseIds[key] = ARGV[3]
           pending[key] = value
           pendingIds[key] = ARGV[3]
           pendingRounds[key] = currentRound
           outstanding[key] = nil
           answeredSet[key] = true
           table.insert(answered, key)
           changed = true
         end
       end

       if changed then
         if next(outstanding) == nil then
           task.inputRequests = nil
           -- Fully answered: stop reporting input_required with nothing to ask.
           if task.status == 'input_required' then
             task.status = 'working'
             task.statusMessage = nil
           end
         else
           task.inputRequests = outstanding
         end
         task.answeredInputKeys = answered
         task.pendingInputResponses = pending
         task.pendingInputResponseIds = pendingIds
         task.pendingInputResponseRounds = pendingRounds
         task.lastUpdatedAt = ARGV[2]
         redis.call('SET', KEYS[1], cjson.encode(task), 'KEEPTTL')
       end

       return cjson.encode({ task = task, responses = deliverable, responseIds = responseIds })`,
      1,
      this.key(taskId),
      JSON.stringify(encodeOpaqueMap(responses)),
      new Date().toISOString(),
      responseId,
      round === undefined ? '' : String(round)
    )

    if (typeof result !== 'string') return null
    const parsed = JSON.parse(result) as {
      task: unknown
      responses: Record<string, string> | unknown[]
      responseIds: Record<string, string> | unknown[]
    }
    return {
      task: fromStored(parsed.task),
      responses: decodeOpaqueMap(parsed.responses) ?? {},
      responseIds: Array.isArray(parsed.responseIds) ? {} : parsed.responseIds
    }
  }

  // Leases are timed by Redis's own clock (TIME), so instances whose clocks
  // disagree still agree on whether a worker is alive.

  async renewLease (taskId: string, leaseMs: number): Promise<TaskStatus | null> {
    const result = await this.redis.eval(
      `local raw = redis.call('GET', KEYS[1])
       if not raw then return false end
       local ok, task = pcall(cjson.decode, raw)
       if not ok then return false end
       local s = task.status
       if s == 'completed' or s == 'failed' or s == 'cancelled' then return s end
       local now = redis.call('TIME')
       task.leaseExpiresAt = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000) + tonumber(ARGV[1])
       redis.call('SET', KEYS[1], cjson.encode(task), 'KEEPTTL')
       return s`,
      1,
      this.key(taskId),
      String(leaseMs)
    )
    return typeof result === 'string' ? result as TaskStatus : null
  }

  async expireStaleLease (taskId: string, statusMessage: string, outcome: TaskOutcome): Promise<TaskRecord | null> {
    const result = await this.redis.eval(
      `local raw = redis.call('GET', KEYS[1])
       if not raw then return false end
       local ok, task = pcall(cjson.decode, raw)
       if not ok then return false end
       local s = task.status
       if s == 'completed' or s == 'failed' or s == 'cancelled' then return false end
       if type(task.leaseExpiresAt) ~= 'number' then return false end
       local now = redis.call('TIME')
       local nowMs = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
       if nowMs <= task.leaseExpiresAt then return false end
       task.status = 'failed'
       task.statusMessage = ARGV[1]
       task.outcome = ARGV[2]
       task.lastUpdatedAt = ARGV[3]
       task.inputRequests = nil
       task.pendingInputResponses = nil
       task.pendingInputResponseIds = nil
       task.pendingInputResponseRounds = nil
       local encoded = cjson.encode(task)
       redis.call('SET', KEYS[1], encoded, 'KEEPTTL')
       return encoded`,
      1,
      this.key(taskId),
      toWellFormed(statusMessage),
      JSON.stringify(outcome),
      new Date().toISOString()
    )
    return typeof result === 'string' ? decodeTask(result) : null
  }

  async acknowledgeInputResponses (taskId: string, responseIds: Record<string, string>): Promise<void> {
    if (Object.keys(responseIds).length === 0) return

    await this.redis.eval(
      `local raw = redis.call('GET', KEYS[1])
       if not raw then return 0 end
       local ok, task = pcall(cjson.decode, raw)
       if not ok or not task.pendingInputResponses then return 0 end

       local acknowledgements = cjson.decode(ARGV[1])
       for key, deliveryId in pairs(acknowledgements) do
         if task.pendingInputResponseIds and task.pendingInputResponseIds[key] == deliveryId then
           task.pendingInputResponses[key] = nil
           task.pendingInputResponseIds[key] = nil
           if task.pendingInputResponseRounds then task.pendingInputResponseRounds[key] = nil end
         end
       end
       if next(task.pendingInputResponses) == nil then
         task.pendingInputResponses = nil
         task.pendingInputResponseIds = nil
         task.pendingInputResponseRounds = nil
       end
       redis.call('SET', KEYS[1], cjson.encode(task), 'KEEPTTL')
       return 1`,
      1,
      this.key(taskId),
      JSON.stringify(responseIds)
    )
  }

  async list (authSubject?: string, options: TaskListOptions = {}): Promise<TaskListPage> {
    const limit = taskPageLimit(options.limit)
    const indexKey = this.indexKey(authSubject)
    const subject = authSubject === undefined ? undefined : toWellFormed(authSubject)

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
          task = decodeTask(raw)
        } catch {
          continue
        }
        // The index is per owner, but never trust it over the record itself,
        // which stores the subject well-formed
        if (task.authSubject !== subject) continue
        if (!matchesTaskEra(task, options.era)) continue
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
    // entries are pruned whenever the owner creates or lists tasks. Sweeping
    // every owner's index here would mean scanning the keyspace.
  }
}
