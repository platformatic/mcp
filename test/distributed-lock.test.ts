import { test, describe, after } from 'node:test'
import * as assert from 'node:assert'
import { createTestRedis, cleanupRedis } from './redis-test-utils.ts'
import { createDistributedLock, RedisDistributedLock, StubLock } from '../src/utils/distributed-lock.ts'
import type { Redis } from 'ioredis'

let testRedisInstances: Redis[] = []

after(async () => {
  // Cleanup all Redis instances created during tests
  for (const redis of testRedisInstances) {
    await cleanupRedis(redis)
  }
  testRedisInstances = []
})

async function getTestRedis (): Promise<Redis> {
  const redis = await createTestRedis()
  testRedisInstances.push(redis)
  return redis
}

describe('Distributed Lock', () => {
  describe('StubLock', () => {
    test('should acquire and release locks successfully', async (_t) => {
      const lock = new StubLock()
      const instanceId = 'instance-1'
      const key = 'test-key'

      // Acquire lock
      const acquired = await lock.acquire(key, 10, instanceId)
      assert.strictEqual(acquired, true)

      // Check lock is held
      const holder = await lock.isLocked(key)
      assert.strictEqual(holder, instanceId)

      // Release lock
      const released = await lock.release(key, instanceId)
      assert.strictEqual(released, true)

      // Check lock is released
      const holderAfter = await lock.isLocked(key)
      assert.strictEqual(holderAfter, null)

      await lock.close()
    })

    test('should prevent duplicate lock acquisition', async (_t) => {
      const lock = new StubLock()
      const instance1 = 'instance-1'
      const instance2 = 'instance-2'
      const key = 'test-key'

      // First instance acquires lock
      const acquired1 = await lock.acquire(key, 10, instance1)
      assert.strictEqual(acquired1, true)

      // Second instance cannot acquire same lock
      const acquired2 = await lock.acquire(key, 10, instance2)
      assert.strictEqual(acquired2, false)

      // First instance can release
      const released1 = await lock.release(key, instance1)
      assert.strictEqual(released1, true)

      // Second instance cannot release (didn't own it)
      const released2 = await lock.release(key, instance2)
      assert.strictEqual(released2, false)

      await lock.close()
    })

    test('should handle lock expiration', async (_t) => {
      const lock = new StubLock()
      const instanceId = 'instance-1'
      const key = 'test-key'

      // Acquire lock with very short TTL
      const acquired = await lock.acquire(key, 0.1, instanceId) // 100ms
      assert.strictEqual(acquired, true)

      // Wait for lock to expire
      await new Promise(resolve => setTimeout(resolve, 150))

      // Check lock has expired
      const holder = await lock.isLocked(key)
      assert.strictEqual(holder, null)

      // Another instance can now acquire
      const acquired2 = await lock.acquire(key, 10, 'instance-2')
      assert.strictEqual(acquired2, true)

      await lock.close()
    })

    test('should extend lock TTL', async (_t) => {
      const lock = new StubLock()
      const instanceId = 'instance-1'
      const key = 'test-key'

      // Acquire lock
      const acquired = await lock.acquire(key, 0.2, instanceId) // 200ms
      assert.strictEqual(acquired, true)

      // Wait half the TTL
      await new Promise(resolve => setTimeout(resolve, 100))

      // Extend lock
      const extended = await lock.extend(key, 0.3, instanceId) // 300ms more
      assert.strictEqual(extended, true)

      // Wait original TTL time
      await new Promise(resolve => setTimeout(resolve, 150))

      // Lock should still be held (due to extension)
      const holder = await lock.isLocked(key)
      assert.strictEqual(holder, instanceId)

      await lock.close()
    })

    test('should not allow extension by non-owner', async (_t) => {
      const lock = new StubLock()
      const instance1 = 'instance-1'
      const instance2 = 'instance-2'
      const key = 'test-key'

      // First instance acquires lock
      const acquired = await lock.acquire(key, 10, instance1)
      assert.strictEqual(acquired, true)

      // Second instance cannot extend
      const extended = await lock.extend(key, 20, instance2)
      assert.strictEqual(extended, false)

      // First instance can extend
      const extended2 = await lock.extend(key, 20, instance1)
      assert.strictEqual(extended2, true)

      await lock.close()
    })
  })

  describe('RedisDistributedLock', () => {
    test('should acquire and release locks successfully', async (_t) => {
      const redis = await getTestRedis()
      const lock = new RedisDistributedLock(redis, 'test')
      const instanceId = 'instance-1'
      const key = 'test-key'

      // Acquire lock
      const acquired = await lock.acquire(key, 10, instanceId)
      assert.strictEqual(acquired, true)

      // Check lock is held
      const holder = await lock.isLocked(key)
      assert.strictEqual(holder, instanceId)

      // Release lock
      const released = await lock.release(key, instanceId)
      assert.strictEqual(released, true)

      // Check lock is released
      const holderAfter = await lock.isLocked(key)
      assert.strictEqual(holderAfter, null)
    })

    test('should prevent duplicate lock acquisition across Redis instances', async (_t) => {
      const redis1 = await getTestRedis()
      const redis2 = await getTestRedis()

      const lock1 = new RedisDistributedLock(redis1, 'test')
      const lock2 = new RedisDistributedLock(redis2, 'test')

      const instance1 = 'instance-1'
      const instance2 = 'instance-2'
      const key = 'test-key'

      // First instance acquires lock
      const acquired1 = await lock1.acquire(key, 10, instance1)
      assert.strictEqual(acquired1, true)

      // Second instance (different Redis connection) cannot acquire same lock
      const acquired2 = await lock2.acquire(key, 10, instance2)
      assert.strictEqual(acquired2, false)

      // Verify lock holder from both connections
      const holder1 = await lock1.isLocked(key)
      const holder2 = await lock2.isLocked(key)
      assert.strictEqual(holder1, instance1)
      assert.strictEqual(holder2, instance1)

      // First instance releases lock
      const released = await lock1.release(key, instance1)
      assert.strictEqual(released, true)

      // Now second instance can acquire
      const acquired3 = await lock2.acquire(key, 10, instance2)
      assert.strictEqual(acquired3, true)
    })

    test('should handle Redis lock expiration', async (_t) => {
      const redis = await getTestRedis()
      const lock = new RedisDistributedLock(redis, 'test')
      const instanceId = 'instance-1'
      const key = 'test-key'

      // Acquire lock with short TTL
      const acquired = await lock.acquire(key, 1, instanceId) // 1 second
      assert.strictEqual(acquired, true)

      // Wait for lock to expire
      await new Promise(resolve => setTimeout(resolve, 1100))

      // Check lock has expired
      const holder = await lock.isLocked(key)
      assert.strictEqual(holder, null)

      // Another instance can now acquire
      const acquired2 = await lock.acquire(key, 10, 'instance-2')
      assert.strictEqual(acquired2, true)
    })

    test('should extend Redis lock TTL', async (_t) => {
      const redis = await getTestRedis()
      const lock = new RedisDistributedLock(redis, 'test')
      const instanceId = 'instance-1'
      const key = 'test-key'

      // Acquire lock with short TTL
      const acquired = await lock.acquire(key, 1, instanceId) // 1 second
      assert.strictEqual(acquired, true)

      // Wait half the TTL
      await new Promise(resolve => setTimeout(resolve, 500))

      // Extend lock
      const extended = await lock.extend(key, 2, instanceId) // 2 more seconds
      assert.strictEqual(extended, true)

      // Wait original TTL time
      await new Promise(resolve => setTimeout(resolve, 600))

      // Lock should still be held (due to extension)
      const holder = await lock.isLocked(key)
      assert.strictEqual(holder, instanceId)
    })

    test('should enforce ownership for Redis operations', async (_t) => {
      const redis = await getTestRedis()
      const lock = new RedisDistributedLock(redis, 'test')
      const instance1 = 'instance-1'
      const instance2 = 'instance-2'
      const key = 'test-key'

      // First instance acquires lock
      const acquired = await lock.acquire(key, 10, instance1)
      assert.strictEqual(acquired, true)

      // Second instance cannot release lock owned by first
      const released1 = await lock.release(key, instance2)
      assert.strictEqual(released1, false)

      // Second instance cannot extend lock owned by first
      const extended1 = await lock.extend(key, 20, instance2)
      assert.strictEqual(extended1, false)

      // First instance can release its own lock
      const released2 = await lock.release(key, instance1)
      assert.strictEqual(released2, true)
    })
  })

  describe('createDistributedLock factory', () => {
    test('should create StubLock when no Redis provided', async (_t) => {
      const lock = createDistributedLock(undefined, 'test')
      assert.ok(lock instanceof StubLock)

      // Test basic functionality
      const acquired = await lock.acquire('key', 10, 'instance-1')
      assert.strictEqual(acquired, true)

      await lock.close?.()
    })

    test('should create RedisDistributedLock when Redis provided', async (_t) => {
      const redis = await getTestRedis()
      const lock = createDistributedLock(redis, 'test')
      assert.ok(lock instanceof RedisDistributedLock)

      // Test basic functionality
      const acquired = await lock.acquire('key', 10, 'instance-1')
      assert.strictEqual(acquired, true)
    })
  })

  describe('Lock prefix handling', () => {
    test('should handle StubLock without prefixes', async (_t) => {
      const lock1 = new StubLock()
      const lock2 = new StubLock()

      const instanceId = 'instance-1'
      const key = 'same-key'

      // StubLock instances have separate memory, so both can acquire same key
      const acquired1 = await lock1.acquire(key, 10, instanceId)
      const acquired2 = await lock2.acquire(key, 10, instanceId)

      assert.strictEqual(acquired1, true)
      assert.strictEqual(acquired2, true) // Both can acquire (separate instances)

      // Each lock sees its own state
      const holder1 = await lock1.isLocked(key)
      const holder2 = await lock2.isLocked(key)

      assert.strictEqual(holder1, instanceId)
      assert.strictEqual(holder2, instanceId)

      await lock1.close()
      await lock2.close()
    })

    test('should isolate Redis locks with different prefixes', async (_t) => {
      const redis = await getTestRedis()
      const lock1 = new RedisDistributedLock(redis, 'prefix1')
      const lock2 = new RedisDistributedLock(redis, 'prefix2')

      const instanceId = 'instance-1'
      const key = 'same-key'

      // Both locks can acquire same key (different prefixes)
      const acquired1 = await lock1.acquire(key, 10, instanceId)
      const acquired2 = await lock2.acquire(key, 10, instanceId)

      assert.strictEqual(acquired1, true)
      assert.strictEqual(acquired2, true)

      // Both locks show they hold their respective keys
      const holder1 = await lock1.isLocked(key)
      const holder2 = await lock2.isLocked(key)

      assert.strictEqual(holder1, instanceId)
      assert.strictEqual(holder2, instanceId)
    })
  })
})
