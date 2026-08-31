import type { Redis } from 'ioredis'
import type { TaskStatus } from '../schema.ts'
import type { TaskStore, TaskRecord, TaskUpdateOptions, TaskInputUpdate } from './task-store.ts'
import { applyInputRequestUpdates, canTransition, isTerminal, taskHasExpired } from './task-store.ts'

const TASK_KEY_PREFIX = 'mcp:task:'
const TASK_INDEX_KEY = 'mcp:tasks'

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

  private expirySeconds (task: TaskRecord): number {
    const ttl = task.ttl ?? this.defaultTtlMs
    return Math.max(1, Math.ceil(ttl / 1000))
  }

  async create (task: TaskRecord): Promise<void> {
    const key = this.key(task.taskId)
    // A null ttl means unlimited retention (matching taskHasExpired and the
    // memory store), so write the key without an expiry rather than falling back
    // to the default and silently expiring it.
    if (task.ttl === null) {
      await this.redis.set(key, JSON.stringify(task))
    } else {
      await this.redis.set(key, JSON.stringify(task), 'EX', this.expirySeconds(task))
    }
    // Index membership lets `list` enumerate without a keyspace scan; stale ids
    // are pruned on read, since the task keys expire independently.
    await this.redis.zadd(TASK_INDEX_KEY, new Date(task.createdAt).getTime(), task.taskId)
  }

  async get (taskId: string): Promise<TaskRecord | null> {
    const raw = await this.redis.get(this.key(taskId))
    if (!raw) {
      await this.redis.zrem(TASK_INDEX_KEY, taskId)
      return null
    }

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
    if (options.statusMessage !== undefined) {
      updated.statusMessage = options.statusMessage
    }
    if (options.outcome !== undefined) {
      updated.outcome = options.outcome
    }
    if (options.cancelledFromInputRequired !== undefined) {
      updated.cancelledFromInputRequired = options.cancelledFromInputRequired
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
      JSON.stringify(updated),
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
    return JSON.parse(result) as TaskRecord
  }

  async updateInputResponses (
    taskId: string,
    responses: Record<string, unknown>,
    responseId: string
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
       local deliverable = {}
       local responseIds = {}
       local changed = false

       for key, value in pairs(submitted) do
         if pending[key] ~= nil and (pendingRounds[key] == nil or pendingRounds[key] == currentRound) then
           deliverable[key] = pending[key]
           responseIds[key] = pendingIds[key] or ARGV[3]
         elseif not terminal and outstanding[key] ~= nil and not answeredSet[key] then
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
      JSON.stringify(responses),
      new Date().toISOString(),
      responseId
    )

    if (typeof result !== 'string') return null
    const parsed = JSON.parse(result) as {
      task: TaskRecord
      responses: Record<string, unknown> | unknown[]
      responseIds: Record<string, string> | unknown[]
    }
    return {
      task: parsed.task,
      responses: Array.isArray(parsed.responses) ? {} : parsed.responses,
      responseIds: Array.isArray(parsed.responseIds) ? {} : parsed.responseIds
    }
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

  async list (authSubject?: string): Promise<TaskRecord[]> {
    const ids = await this.redis.zrevrange(TASK_INDEX_KEY, 0, -1)
    const results: TaskRecord[] = []

    for (const id of ids) {
      const task = await this.get(id)
      if (!task) continue
      if (task.authSubject !== authSubject) continue
      results.push(task)
    }

    return results
  }

  async delete (taskId: string): Promise<void> {
    await this.redis.del(this.key(taskId))
    await this.redis.zrem(TASK_INDEX_KEY, taskId)
  }

  async cleanup (): Promise<void> {
    // Task keys expire on their own; this only prunes the index of ids whose
    // task key is already gone.
    const ids = await this.redis.zrange(TASK_INDEX_KEY, 0, -1)
    for (const id of ids) {
      if (await this.redis.exists(this.key(id)) === 0) {
        await this.redis.zrem(TASK_INDEX_KEY, id)
      }
    }
  }
}
