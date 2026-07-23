import type { Redis } from 'ioredis'
import type { TaskStatus } from '../schema.ts'
import type { TaskStore, TaskRecord, TaskOutcome } from './task-store.ts'
import { canTransition, isTerminal, taskHasExpired } from './task-store.ts'

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
    await this.redis.set(key, JSON.stringify(task), 'EX', this.expirySeconds(task))
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
