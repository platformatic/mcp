import type { Redis } from 'ioredis'
import type { JSONRPCMessage } from '../schema.ts'
import type { SessionStore, SessionMetadata } from './session-store.ts'
import type { AuthorizationContext, TokenRefreshInfo } from '../types/auth-types.ts'

export class RedisSessionStore implements SessionStore {
  private redis: Redis
  private maxMessages: number

  constructor (options: { redis: Redis, maxMessages?: number }) {
    this.redis = options.redis
    this.maxMessages = options.maxMessages || 100
  }

  async create (metadata: SessionMetadata): Promise<void> {
    const sessionKey = `session:${metadata.id}`
    const sessionData: Record<string, string> = {
      id: metadata.id,
      eventId: metadata.eventId.toString(),
      lastEventId: metadata.lastEventId || '',
      createdAt: metadata.createdAt.toISOString(),
      lastActivity: metadata.lastActivity.toISOString()
    }

    // Add authorization context if present
    if (metadata.authorization) {
      sessionData.authorization = JSON.stringify(metadata.authorization)
    }
    if (metadata.tokenRefresh) {
      sessionData.tokenRefresh = JSON.stringify(metadata.tokenRefresh)
    }
    if (metadata.authSession) {
      sessionData.authSession = JSON.stringify(metadata.authSession)
    }

    await this.redis.hset(sessionKey, sessionData)

    // Set session expiration to 1 hour
    await this.redis.expire(sessionKey, 3600)

    // Add token mapping if present
    if (metadata.authorization?.tokenHash) {
      await this.addTokenMapping(metadata.authorization.tokenHash, metadata.id)
    }
  }

  async get (sessionId: string): Promise<SessionMetadata | null> {
    const sessionKey = `session:${sessionId}`
    const result = await this.redis.hgetall(sessionKey)

    if (!result.id) {
      return null
    }

    const metadata: SessionMetadata = {
      id: result.id,
      eventId: parseInt(result.eventId, 10),
      lastEventId: result.lastEventId || undefined,
      createdAt: new Date(result.createdAt),
      lastActivity: new Date(result.lastActivity)
    }

    // Parse authorization context if present
    if (result.authorization) {
      try {
        metadata.authorization = JSON.parse(result.authorization)
      } catch (error) {
        // Ignore parsing errors for authorization context
      }
    }

    if (result.tokenRefresh) {
      try {
        metadata.tokenRefresh = JSON.parse(result.tokenRefresh)
      } catch (error) {
        // Ignore parsing errors for token refresh
      }
    }

    if (result.authSession) {
      try {
        metadata.authSession = JSON.parse(result.authSession)
      } catch (error) {
        // Ignore parsing errors for auth session
      }
    }

    return metadata
  }

  async delete (sessionId: string): Promise<void> {
    const sessionKey = `session:${sessionId}`
    const historyKey = `session:${sessionId}:history`

    // Get session to clean up token mappings
    const session = await this.get(sessionId)
    if (session?.authorization?.tokenHash) {
      await this.removeTokenMapping(session.authorization.tokenHash)
    }

    await this.redis.del(sessionKey, historyKey)
  }

  async cleanup (): Promise<void> {
    // Redis TTL handles cleanup automatically for sessions
    // But we can also clean up old message histories
    let cursor = '0'
    do {
      const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', 'session:*:history', 'COUNT', 100)
      cursor = nextCursor
      for (const key of keys) {
        const sessionId = key.split(':')[1]
        const sessionKey = `session:${sessionId}`
        const exists = await this.redis.exists(sessionKey)
        if (!exists) {
          await this.redis.del(key)
        }
      }
    } while (cursor !== '0')
  }

  async addMessage (sessionId: string, eventId: string, message: JSONRPCMessage): Promise<void> {
    const historyKey = `session:${sessionId}:history`
    const sessionKey = `session:${sessionId}`

    // Use Redis pipeline for atomic operations
    const pipeline = this.redis.pipeline()

    // Add message to Redis stream
    pipeline.xadd(historyKey, `${eventId}-0`, 'message', JSON.stringify(message))

    // Trim to max messages (exact trimming)
    pipeline.xtrim(historyKey, 'MAXLEN', this.maxMessages)

    // Update session metadata
    pipeline.hset(sessionKey, {
      eventId,
      lastEventId: eventId,
      lastActivity: new Date().toISOString()
    })

    // Reset session expiration
    pipeline.expire(sessionKey, 3600)

    await pipeline.exec()
  }

  async addMessageWithAutoEventId (sessionId: string, message: JSONRPCMessage): Promise<string> {
    const sessionKey = `session:${sessionId}`
    const historyKey = `session:${sessionId}:history`

    // Atomically increment eventId and add message
    const eventId = await this.redis.eval(
      `
      local sessionKey = KEYS[1]
      local historyKey = KEYS[2]
      local message = ARGV[1]
      local maxMessages = tonumber(ARGV[2])
      local ttl = tonumber(ARGV[3])
      local currentTime = ARGV[4]
      
      -- Get and increment eventId atomically
      local eventId = redis.call('HINCRBY', sessionKey, 'eventId', 1)
      
      -- Add message to stream
      redis.call('XADD', historyKey, eventId .. '-0', 'message', message)
      
      -- Trim to max messages
      redis.call('XTRIM', historyKey, 'MAXLEN', maxMessages)
      
      -- Update session metadata
      redis.call('HSET', sessionKey, 'lastEventId', eventId, 'lastActivity', currentTime)
      
      -- Reset expiration
      redis.call('EXPIRE', sessionKey, ttl)
      
      return eventId
      `,
      2,
      sessionKey,
      historyKey,
      JSON.stringify(message),
      this.maxMessages.toString(),
      '3600',
      new Date().toISOString()
    ) as number

    return eventId.toString()
  }

  async getMessagesFrom (sessionId: string, fromEventId: string): Promise<Array<{ eventId: string, message: JSONRPCMessage }>> {
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

  async getAllSessionIds (): Promise<string[]> {
    const sessionKeys = await this.redis.keys('session:*')
    return sessionKeys
      .filter(key => !key.includes(':history') && !key.includes(':token'))
      .map(key => key.replace('session:', ''))
  }

  // Token-to-session mapping operations
  async getSessionByTokenHash (tokenHash: string): Promise<SessionMetadata | null> {
    const tokenKey = `token:${tokenHash}`
    const sessionId = await this.redis.get(tokenKey)
    if (!sessionId) {
      return null
    }
    return this.get(sessionId)
  }

  async addTokenMapping (tokenHash: string, sessionId: string): Promise<void> {
    const tokenKey = `token:${tokenHash}`
    // Set token mapping with same expiration as session (1 hour)
    await this.redis.setex(tokenKey, 3600, sessionId)
  }

  async removeTokenMapping (tokenHash: string): Promise<void> {
    const tokenKey = `token:${tokenHash}`
    await this.redis.del(tokenKey)
  }

  async updateAuthorization (sessionId: string, authorization: AuthorizationContext, tokenRefresh?: TokenRefreshInfo): Promise<void> {
    const sessionKey = `session:${sessionId}`

    // Get existing session to clean up old token mapping
    const existingSession = await this.get(sessionId)
    if (!existingSession) {
      throw new Error(`Session ${sessionId} not found`)
    }

    // Remove old token mapping if it exists
    if (existingSession.authorization?.tokenHash) {
      await this.removeTokenMapping(existingSession.authorization.tokenHash)
    }

    // Update session with new authorization context
    const updateData: Record<string, string> = {
      authorization: JSON.stringify(authorization),
      lastActivity: new Date().toISOString()
    }

    if (tokenRefresh) {
      updateData.tokenRefresh = JSON.stringify(tokenRefresh)
    }

    await this.redis.hset(sessionKey, updateData)

    // Reset session expiration
    await this.redis.expire(sessionKey, 3600)

    // Add new token mapping if tokenHash is provided
    if (authorization.tokenHash) {
      await this.addTokenMapping(authorization.tokenHash, sessionId)
    }
  }
}
