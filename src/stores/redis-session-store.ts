import type { Redis } from 'ioredis'
import type { JSONRPCMessage } from '../schema.ts'
import type { SessionStore, SessionMetadata } from './session-store.ts'

export class RedisSessionStore implements SessionStore {
  private redis: Redis
  private maxMessages: number

  constructor(options: { redis: Redis, maxMessages?: number }) {
    this.redis = options.redis
    this.maxMessages = options.maxMessages || 100
  }

  async create(metadata: SessionMetadata): Promise<void> {
    const sessionKey = `session:${metadata.id}`
    await this.redis.hset(sessionKey, {
      id: metadata.id,
      eventId: metadata.eventId.toString(),
      lastEventId: metadata.lastEventId || '',
      createdAt: metadata.createdAt.toISOString(),
      lastActivity: metadata.lastActivity.toISOString()
    })
    // Set session expiration to 1 hour
    await this.redis.expire(sessionKey, 3600)
  }

  async get(sessionId: string): Promise<SessionMetadata | null> {
    const sessionKey = `session:${sessionId}`
    const result = await this.redis.hgetall(sessionKey)
    
    if (!result.id) {
      return null
    }

    return {
      id: result.id,
      eventId: parseInt(result.eventId, 10),
      lastEventId: result.lastEventId || undefined,
      createdAt: new Date(result.createdAt),
      lastActivity: new Date(result.lastActivity)
    }
  }

  async delete(sessionId: string): Promise<void> {
    const sessionKey = `session:${sessionId}`
    const historyKey = `session:${sessionId}:history`
    await this.redis.del(sessionKey, historyKey)
  }

  async cleanup(): Promise<void> {
    // Redis TTL handles cleanup automatically for sessions
    // But we can also clean up old message histories
    const keys = await this.redis.keys('session:*:history')
    for (const key of keys) {
      const sessionId = key.split(':')[1]
      const sessionKey = `session:${sessionId}`
      const exists = await this.redis.exists(sessionKey)
      if (!exists) {
        await this.redis.del(key)
      }
    }
  }

  async addMessage(sessionId: string, eventId: string, message: JSONRPCMessage): Promise<void> {
    const historyKey = `session:${sessionId}:history`
    const sessionKey = `session:${sessionId}`
    
    // Use Redis pipeline for atomic operations
    const pipeline = this.redis.pipeline()
    
    // Add message to Redis stream
    pipeline.xadd(historyKey, `${eventId}-0`, 'message', JSON.stringify(message))
    
    // Trim to max messages
    pipeline.xtrim(historyKey, 'MAXLEN', '~', this.maxMessages)
    
    // Update session metadata
    pipeline.hset(sessionKey, {
      eventId: eventId,
      lastEventId: eventId,
      lastActivity: new Date().toISOString()
    })
    
    // Reset session expiration
    pipeline.expire(sessionKey, 3600)
    
    await pipeline.exec()
  }

  async getMessagesFrom(sessionId: string, fromEventId: string): Promise<Array<{ eventId: string, message: JSONRPCMessage }>> {
    const historyKey = `session:${sessionId}:history`
    
    try {
      const results = await this.redis.xrange(historyKey, `(${fromEventId}-0`, '+')
      
      return results.map(([id, fields]: [string, string[]]) => ({
        eventId: id.split('-')[0],
        message: JSON.parse(fields[1])
      }))
    } catch (error) {
      // If stream doesn't exist, return empty array
      return []
    }
  }
}