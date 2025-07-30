import type { Redis } from 'ioredis'

/**
 * Interface for distributed locking implementations
 */
export interface DistributedLock {
  /**
   * Attempt to acquire a distributed lock
   * @param key - Lock key identifier
   * @param ttlSeconds - Time-to-live for the lock in seconds
   * @param instanceId - Unique identifier for this instance
   * @returns Promise<boolean> - true if lock was acquired, false otherwise
   */
  acquire(key: string, ttlSeconds: number, instanceId: string): Promise<boolean>

  /**
   * Release a distributed lock
   * @param key - Lock key identifier
   * @param instanceId - Unique identifier for this instance
   * @returns Promise<boolean> - true if lock was released, false if not owned
   */
  release(key: string, instanceId: string): Promise<boolean>

  /**
   * Extend the TTL of an existing lock
   * @param key - Lock key identifier
   * @param ttlSeconds - New time-to-live in seconds
   * @param instanceId - Unique identifier for this instance
   * @returns Promise<boolean> - true if lock was extended, false if not owned
   */
  extend(key: string, ttlSeconds: number, instanceId: string): Promise<boolean>

  /**
   * Check if a lock is currently held
   * @param key - Lock key identifier
   * @returns Promise<string | null> - instance ID of lock holder, or null if not locked
   */
  isLocked(key: string): Promise<string | null>

  /**
   * Clean up any resources
   */
  close?(): Promise<void>
}

/**
 * Redis-based distributed lock implementation
 * Uses Redis SET with NX and EX for atomic lock acquisition
 */
export class RedisDistributedLock implements DistributedLock {
  private readonly redis: Redis
  private readonly lockPrefix: string

  constructor(redis: Redis, lockPrefix: string = 'lock') {
    this.redis = redis
    this.lockPrefix = lockPrefix
  }

  private getLockKey(key: string): string {
    return `${this.lockPrefix}:${key}`
  }

  async acquire(key: string, ttlSeconds: number, instanceId: string): Promise<boolean> {
    const lockKey = this.getLockKey(key)
    
    // Use SET with NX (only if not exists) and EX (expiration) for atomic operation
    const result = await this.redis.set(lockKey, instanceId, 'NX', 'EX', ttlSeconds)
    
    return result === 'OK'
  }

  async release(key: string, instanceId: string): Promise<boolean> {
    const lockKey = this.getLockKey(key)
    
    // Use Lua script to atomically check ownership and delete
    const script = `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("DEL", KEYS[1])
      else
        return 0
      end
    `
    
    const result = await this.redis.eval(script, 1, lockKey, instanceId) as number
    return result === 1
  }

  async extend(key: string, ttlSeconds: number, instanceId: string): Promise<boolean> {
    const lockKey = this.getLockKey(key)
    
    // Use Lua script to atomically check ownership and extend TTL
    const script = `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("EXPIRE", KEYS[1], ARGV[2])
      else
        return 0
      end
    `
    
    const result = await this.redis.eval(script, 1, lockKey, instanceId, ttlSeconds) as number
    return result === 1
  }

  async isLocked(key: string): Promise<string | null> {
    const lockKey = this.getLockKey(key)
    const result = await this.redis.get(lockKey)
    return result
  }
}

/**
 * Stub lock implementation for single-instance deployments or testing
 * Uses in-memory Map to simulate locking behavior within a single process
 * Not actually distributed - all instances share the same memory space
 */
export class StubLock implements DistributedLock {
  private locks = new Map<string, { instanceId: string, timeout: NodeJS.Timeout }>()
  private readonly lockPrefix: string

  constructor(lockPrefix: string = 'lock') {
    this.lockPrefix = lockPrefix
  }

  private getLockKey(key: string): string {
    return `${this.lockPrefix}:${key}`
  }

  async acquire(key: string, ttlSeconds: number, instanceId: string): Promise<boolean> {
    const lockKey = this.getLockKey(key)
    
    // Check if lock already exists and is not expired
    if (this.locks.has(lockKey)) {
      return false
    }
    
    // Create timeout for automatic cleanup
    const timeout = setTimeout(() => {
      this.locks.delete(lockKey)
    }, ttlSeconds * 1000)
    
    // Acquire lock
    this.locks.set(lockKey, { instanceId, timeout })
    return true
  }

  async release(key: string, instanceId: string): Promise<boolean> {
    const lockKey = this.getLockKey(key)
    const lock = this.locks.get(lockKey)
    
    if (!lock || lock.instanceId !== instanceId) {
      return false
    }
    
    // Clear timeout and remove lock
    clearTimeout(lock.timeout)
    this.locks.delete(lockKey)
    return true
  }

  async extend(key: string, ttlSeconds: number, instanceId: string): Promise<boolean> {
    const lockKey = this.getLockKey(key)
    const lock = this.locks.get(lockKey)
    
    if (!lock || lock.instanceId !== instanceId) {
      return false
    }
    
    // Clear old timeout and create new one
    clearTimeout(lock.timeout)
    const newTimeout = setTimeout(() => {
      this.locks.delete(lockKey)
    }, ttlSeconds * 1000)
    
    // Update lock with new timeout
    this.locks.set(lockKey, { instanceId, timeout: newTimeout })
    return true
  }

  async isLocked(key: string): Promise<string | null> {
    const lockKey = this.getLockKey(key)
    const lock = this.locks.get(lockKey)
    return lock ? lock.instanceId : null
  }

  async close(): Promise<void> {
    // Clear all timeouts and locks
    for (const [key, lock] of this.locks.entries()) {
      clearTimeout(lock.timeout)
    }
    this.locks.clear()
  }
}

/**
 * Factory function to create appropriate distributed lock implementation
 * @param redis - Redis instance (optional)
 * @param lockPrefix - Prefix for lock keys
 * @returns DistributedLock implementation
 */
export function createDistributedLock(redis?: Redis, lockPrefix: string = 'lock'): DistributedLock {
  if (redis) {
    return new RedisDistributedLock(redis, lockPrefix)
  } else {
    return new StubLock(lockPrefix)
  }
}