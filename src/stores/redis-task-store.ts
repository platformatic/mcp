import type { Redis } from 'ioredis'
import type { TaskStore, StoredTask } from './task-store.ts'
import type { AuthorizationContext } from '../types/auth-types.ts'
import { randomUUID } from 'node:crypto'

export interface RedisTaskStoreOptions {
  redis: Redis
}

/**
 * Redis-backed implementation of TaskStore.
 *
 * Uses Redis hashes for task storage with automatic expiration via TTL.
 * Task IDs are stored in sorted sets for efficient listing and cleanup.
 */
export class RedisTaskStore implements TaskStore {
  private readonly redis: Redis

  constructor (options: RedisTaskStoreOptions) {
    this.redis = options.redis
  }

  async create (task: Omit<StoredTask, 'taskId'>): Promise<string> {
    const taskId = randomUUID()
    const key = `mcp:task:${taskId}`

    // Store task data
    const taskData = {
      taskId,
      status: task.status,
      statusMessage: task.statusMessage ?? '',
      createdAt: task.createdAt.toISOString(),
      ttl: task.ttl.toString(),
      pollInterval: task.pollInterval?.toString() ?? '',
      result: task.result ? JSON.stringify(task.result) : '',
      authContext: task.authContext ? JSON.stringify(task.authContext) : ''
    }

    await this.redis.hset(key, taskData)

    // Set expiration based on TTL (convert ms to seconds)
    const ttlSeconds = Math.ceil(task.ttl / 1000)
    await this.redis.expire(key, ttlSeconds)

    // Add to sorted set for listing (score is expiration timestamp)
    const expiresAt = Date.now() + task.ttl
    await this.redis.zadd('mcp:tasks', expiresAt, taskId)

    return taskId
  }

  async get (taskId: string): Promise<StoredTask | null> {
    const key = `mcp:task:${taskId}`
    const data = await this.redis.hgetall(key)

    if (!data || Object.keys(data).length === 0) {
      return null
    }

    return {
      taskId: data.taskId,
      status: data.status as any,
      statusMessage: data.statusMessage || undefined,
      createdAt: new Date(data.createdAt),
      ttl: parseInt(data.ttl, 10),
      pollInterval: data.pollInterval ? parseInt(data.pollInterval, 10) : undefined,
      result: data.result ? JSON.parse(data.result) : undefined,
      authContext: data.authContext ? JSON.parse(data.authContext) : undefined
    }
  }

  async update (taskId: string, updates: Partial<StoredTask>): Promise<void> {
    const key = `mcp:task:${taskId}`

    // Check if task exists
    const exists = await this.redis.exists(key)
    if (!exists) {
      return
    }

    // Build update object
    const updateData: Record<string, string> = {}

    if (updates.status !== undefined) {
      updateData.status = updates.status
    }

    if (updates.statusMessage !== undefined) {
      updateData.statusMessage = updates.statusMessage
    }

    if (updates.result !== undefined) {
      updateData.result = JSON.stringify(updates.result)
    }

    if (Object.keys(updateData).length > 0) {
      await this.redis.hset(key, updateData)
    }
  }

  async delete (taskId: string): Promise<void> {
    const key = `mcp:task:${taskId}`
    await this.redis.del(key)
    await this.redis.zrem('mcp:tasks', taskId)
  }

  async list (authContext?: AuthorizationContext): Promise<StoredTask[]> {
    // Get all task IDs from sorted set
    const taskIds = await this.redis.zrange('mcp:tasks', 0, -1)

    const tasks: StoredTask[] = []

    for (const taskId of taskIds) {
      const task = await this.get(taskId)
      if (task) {
        // Apply authorization filter if provided
        if (authContext) {
          if (authContext.userId && task.authContext?.userId !== authContext.userId) {
            continue
          }
          if (authContext.clientId && task.authContext?.clientId !== authContext.clientId) {
            continue
          }
        }

        tasks.push(task)
      }
    }

    return tasks
  }

  async cleanup (): Promise<number> {
    const now = Date.now()

    // Remove expired tasks from sorted set
    const removed = await this.redis.zremrangebyscore('mcp:tasks', '-inf', now)

    return removed
  }
}
