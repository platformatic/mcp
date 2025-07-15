import { Redis } from 'ioredis'
import { test } from 'node:test'

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

export function skipIfNoRedis (testName: string, testFn: () => Promise<void>) {
  test(testName, async () => {
    let redis: Redis
    try {
      redis = await createTestRedis()
      await testFn()
    } catch (error) {
      if (error instanceof Error && error.message.includes('Redis connection failed')) {
        // Skip test if Redis is not available
        console.log(`Skipping ${testName} - Redis not available`)
        return
      }
      throw error
    } finally {
      if (redis!) {
        await cleanupRedis(redis)
      }
    }
  })
}
