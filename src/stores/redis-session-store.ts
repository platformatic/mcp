import type { Redis } from 'ioredis'
import type { JSONRPCMessage } from '../schema.ts'
import type { SessionStore, SessionMetadata, StreamMetadata } from './session-store.ts'
import type { AuthorizationContext, TokenRefreshInfo } from '../types/auth-types.ts'

export class RedisSessionStore implements SessionStore {
  private redis: Redis
  private maxMessages: number

  constructor (options: { redis: Redis, maxMessages?: number }) {
    this.redis = options.redis
    this.maxMessages = options.maxMessages || 100
  }

  private getStreamKey(sessionId: string, streamId: string): string {
    return `session:${sessionId}:stream:${streamId}`
  }

  private getStreamHistoryKey(sessionId: string, streamId: string): string {
    return `session:${sessionId}:stream:${streamId}:history`
  }

  async create (metadata: SessionMetadata): Promise<void> {
    const sessionKey = `session:${metadata.id}`
    const sessionData: Record<string, string> = {
      id: metadata.id,
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

    // Store stream metadata
    if (metadata.streams && metadata.streams.size > 0) {
      const streamsArray: Array<[string, StreamMetadata]> = Array.from(metadata.streams.entries())
      sessionData.streams = JSON.stringify(streamsArray)
    } else {
      sessionData.streams = JSON.stringify([])
    }

    await this.redis.hset(sessionKey, sessionData)

    // Set session expiration to 1 hour
    await this.redis.expire(sessionKey, 3600)

    // Create stream metadata for each stream
    for (const [streamId, streamMeta] of (metadata.streams || new Map())) {
      const streamKey = this.getStreamKey(metadata.id, streamId)
      await this.redis.hset(streamKey, {
        id: streamMeta.id,
        eventId: streamMeta.eventId.toString(),
        lastEventId: streamMeta.lastEventId || '',
        createdAt: streamMeta.createdAt.toISOString(),
        lastActivity: streamMeta.lastActivity.toISOString()
      })
      await this.redis.expire(streamKey, 3600)
    }

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
      createdAt: new Date(result.createdAt),
      lastActivity: new Date(result.lastActivity),
      streams: new Map()
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

    // Parse streams data
    if (result.streams) {
      try {
        const streamsArray: Array<[string, StreamMetadata]> = JSON.parse(result.streams)
        metadata.streams = new Map(streamsArray)
      } catch (error) {
        // Ignore parsing errors for streams, use empty map
        metadata.streams = new Map()
      }
    }

    return metadata
  }

  async delete (sessionId: string): Promise<void> {
    const sessionKey = `session:${sessionId}`
    const historyKey = `session:${sessionId}:history`

    // Get session to clean up token mappings and streams
    const session = await this.get(sessionId)
    if (session?.authorization?.tokenHash) {
      await this.removeTokenMapping(session.authorization.tokenHash)
    }

    // Clean up all streams for this session
    if (session?.streams) {
      for (const streamId of session.streams.keys()) {
        const streamKey = this.getStreamKey(sessionId, streamId)
        const streamHistoryKey = this.getStreamHistoryKey(sessionId, streamId)
        await this.redis.del(streamKey, streamHistoryKey)
      }
    }

    // Also scan for any missed stream keys
    let cursor = '0'
    do {
      const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', `session:${sessionId}:stream:*`, 'COUNT', 100)
      cursor = nextCursor
      if (keys.length > 0) {
        await this.redis.del(...keys)
      }
    } while (cursor !== '0')

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

    // Also clean up orphaned stream keys
    cursor = '0'
    do {
      const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', 'session:*:stream:*', 'COUNT', 100)
      cursor = nextCursor
      for (const key of keys) {
        const parts = key.split(':')
        if (parts.length >= 2) {
          const sessionId = parts[1]
          const sessionKey = `session:${sessionId}`
          const exists = await this.redis.exists(sessionKey)
          if (!exists) {
            await this.redis.del(key)
          }
        }
      }
    } while (cursor !== '0')
  }

  // Stream management methods
  async createStream(sessionId: string, streamId: string): Promise<StreamMetadata | null> {
    const session = await this.get(sessionId)
    if (!session) return null

    const streamMetadata: StreamMetadata = {
      id: streamId,
      eventId: 0,
      lastEventId: undefined,
      createdAt: new Date(),
      lastActivity: new Date()
    }

    // Add stream to session
    session.streams.set(streamId, streamMetadata)
    session.lastActivity = new Date()

    // Update session with new stream data
    const sessionKey = `session:${sessionId}`
    const streamsArray: Array<[string, StreamMetadata]> = Array.from(session.streams.entries())
    await this.redis.hset(sessionKey, {
      streams: JSON.stringify(streamsArray),
      lastActivity: session.lastActivity.toISOString()
    })

    // Create stream metadata in Redis
    const streamKey = this.getStreamKey(sessionId, streamId)
    await this.redis.hset(streamKey, {
      id: streamMetadata.id,
      eventId: streamMetadata.eventId.toString(),
      lastEventId: streamMetadata.lastEventId || '',
      createdAt: streamMetadata.createdAt.toISOString(),
      lastActivity: streamMetadata.lastActivity.toISOString()
    })
    await this.redis.expire(streamKey, 3600)

    return { ...streamMetadata }
  }

  async getStream(sessionId: string, streamId: string): Promise<StreamMetadata | null> {
    const streamKey = this.getStreamKey(sessionId, streamId)
    const result = await this.redis.hgetall(streamKey)

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

  async deleteStream(sessionId: string, streamId: string): Promise<void> {
    const session = await this.get(sessionId)
    if (!session) return

    // Remove stream from session
    session.streams.delete(streamId)
    session.lastActivity = new Date()

    // Update session with new stream data
    const sessionKey = `session:${sessionId}`
    const streamsArray: Array<[string, StreamMetadata]> = Array.from(session.streams.entries())
    await this.redis.hset(sessionKey, {
      streams: JSON.stringify(streamsArray),
      lastActivity: session.lastActivity.toISOString()
    })

    // Delete stream metadata and history
    const streamKey = this.getStreamKey(sessionId, streamId)
    const streamHistoryKey = this.getStreamHistoryKey(sessionId, streamId)
    await this.redis.del(streamKey, streamHistoryKey)
  }

  async updateStreamActivity(sessionId: string, streamId: string): Promise<void> {
    const streamKey = this.getStreamKey(sessionId, streamId)
    const sessionKey = `session:${sessionId}`
    const now = new Date().toISOString()

    const pipeline = this.redis.pipeline()
    pipeline.hset(streamKey, 'lastActivity', now)
    pipeline.expire(streamKey, 3600)
    pipeline.hset(sessionKey, 'lastActivity', now)
    pipeline.expire(sessionKey, 3600)
    await pipeline.exec()
  }

  // Per-stream message history operations
  async addMessage(sessionId: string, streamId: string, eventId: string, message: JSONRPCMessage): Promise<void> {
    const historyKey = this.getStreamHistoryKey(sessionId, streamId)
    const streamKey = this.getStreamKey(sessionId, streamId)

    // Use Redis pipeline for atomic operations
    const pipeline = this.redis.pipeline()

    // Add message to Redis stream
    pipeline.xadd(historyKey, `${eventId}-0`, 'message', JSON.stringify(message))

    // Trim to max messages (exact trimming)
    pipeline.xtrim(historyKey, 'MAXLEN', this.maxMessages)

    // Update stream metadata
    pipeline.hset(streamKey, {
      eventId,
      lastEventId: eventId,
      lastActivity: new Date().toISOString()
    })

    // Reset stream expiration
    pipeline.expire(streamKey, 3600)

    // Update session activity
    const sessionKey = `session:${sessionId}`
    pipeline.hset(sessionKey, 'lastActivity', new Date().toISOString())
    pipeline.expire(sessionKey, 3600)

    await pipeline.exec()
  }

  async getMessagesFrom(sessionId: string, streamId: string, fromEventId: string): Promise<Array<{ eventId: string, message: JSONRPCMessage }>> {
    const historyKey = this.getStreamHistoryKey(sessionId, streamId)

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

  // Legacy message operations (for backwards compatibility)
  async addSessionMessage(sessionId: string, eventId: string, message: JSONRPCMessage): Promise<void> {
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
      lastActivity: new Date().toISOString()
    })

    // Reset session expiration
    pipeline.expire(sessionKey, 3600)

    await pipeline.exec()
  }

  async getSessionMessagesFrom(sessionId: string, fromEventId: string): Promise<Array<{ eventId: string, message: JSONRPCMessage }>> {
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
