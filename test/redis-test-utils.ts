import { Redis } from 'ioredis'
import { test } from 'node:test'
import type { TestOptions, TestContext } from 'node:test'

export interface RedisTestConfig {
  host: string
  port: number
  db: number
}

export const defaultRedisConfig: RedisTestConfig = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  db: parseInt(process.env.REDIS_DB || '1', 10) // Use DB 1 for tests
}

export async function createTestRedis (config: RedisTestConfig = defaultRedisConfig): Promise<Redis> {
  const redis = new Redis({
    host: config.host,
    port: config.port,
    db: config.db,
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    enableReadyCheck: false
  })

  try {
    await redis.ping()
    await redis.flushdb() // Clear the database before starting tests
    return redis
  } catch (error) {
    await redis.disconnect()
    throw new Error(`Redis connection failed: ${error}. Make sure Redis is running on ${config.host}:${config.port}`)
  }
}

export async function cleanupRedis (redis: Redis): Promise<void> {
  try {
    await redis.flushdb()
    await redis.disconnect()
  } catch (error) {
    // Ignore cleanup errors
  }
}

type testFn = (redis: Redis, t: TestContext) => Promise<void>

export function testWithRedis (testName: string, testFn: testFn): void
export function testWithRedis (testName: string, opts: TestOptions, testFn: testFn): void
export function testWithRedis (testName: string, opts: TestOptions | testFn, testFn?: testFn): void {
  if (typeof opts === 'function') {
    testFn = opts
    opts = {}
  }

  test(testName, opts, async (t) => {
    let redis: Redis
    try {
      redis = await createTestRedis()

      // Set up cleanup to run after test completes
      t.after(async () => {
        if (redis) {
          await cleanupRedis(redis)
        }
      })

      await testFn!(redis, t)
    } catch (error) {
      if (error instanceof Error && error.message.includes('Redis connection failed')) {
        // Skip test if Redis is not available
        t.skip('Redis not available')
        return
      }
      throw error
    }
  })
}
