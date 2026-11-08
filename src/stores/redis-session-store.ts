import type { Redis } from 'ioredis'
import type { JSONRPCMessage } from '../schema.ts'
import type { SessionStore, SessionMetadata } from './session-store.ts'
import { SessionLimitError, SubscriptionLimitError, DEFAULT_MAX_SESSIONS_PER_PRINCIPAL, DEFAULT_MAX_RESOURCE_SUBSCRIPTIONS_PER_SESSION, validateStoreLimit } from './session-store.ts'
import type { AuthorizationContext, TokenRefreshInfo } from '../types/auth-types.ts'

// Each subscribed URI is its own hash field, so concurrent subscribe and
// unsubscribe calls never overwrite each other and the data shares the
// session's TTL and is removed with it.
const RESOURCE_SUBSCRIPTION_PREFIX = 'resourceSubscription:'

/** Idle time after which a session key expires (1 hour) */
const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1000

// Per-owner set of session ids, so `create` can enforce the active-session cap
// atomically. Session keys expire independently, so stale ids (whose key is
// gone) are pruned on every create for that owner, just like the task store.
const SESSION_OWNER_INDEX_PREFIX = 'sessionOwner:'
const SESSION_OWNER_INDEX_ANONYMOUS = 'sessionOwner:__anonymous__'

// Create a session while enforcing its owner's active-session cap, atomically.
//
// KEYS[1] = session key, KEYS[2] = owner index (set of session ids)
// ARGV[1] = session id, ARGV[2] = sessionTtlMs, ARGV[3] = cap (-1 = unlimited),
//          ARGV[4] = session key prefix, ARGV[5...] = hash field/value pairs
//
// Ids whose session key has expired are pruned first; then, at the cap, the
// create is refused. Returns 0 (storing nothing) when at the cap, else 1.
const CREATE_WITH_LIMIT_SCRIPT = `
local prefix = ARGV[4]
local cap = tonumber(ARGV[3])
local live = {}
for _, id in ipairs(redis.call('SMEMBERS', KEYS[2])) do
  if redis.call('EXISTS', prefix .. id) == 1 then
    table.insert(live, id)
  else
    redis.call('SREM', KEYS[2], id)
  end
end

if cap >= 0 and #live >= cap then
  return 0
end

redis.call('DEL', KEYS[1])
redis.call('HSET', KEYS[1], unpack(ARGV, 5))
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]))
redis.call('SADD', KEYS[2], ARGV[1])
return 1
`

// Add a resource subscription while enforcing the per-session cap, atomically,
// so concurrent subscribes cannot overshoot it.
//
// KEYS[1] = session key
// ARGV[1] = subscription field, ARGV[2] = subscription prefix, ARGV[3] = cap
//
// Returns: 0 = session gone (no-op), 1 = added, 2 = already subscribed
// (idempotent), -1 = at the subscription cap.
const ADD_SUBSCRIPTION_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 0
end
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 then
  return 2
end
local prefix = ARGV[2]
local cap = tonumber(ARGV[3])
if cap >= 0 then
  local count = 0
  for _, field in ipairs(redis.call('HKEYS', KEYS[1])) do
    if string.sub(field, 1, #prefix) == prefix then
      count = count + 1
    end
  end
  if count >= cap then
    return -1
  end
end
redis.call('HSET', KEYS[1], ARGV[1], '1')
return 1
`

export class RedisSessionStore implements SessionStore {
  private redis: Redis
  private maxMessages: number
  readonly sessionTtlMs: number
  private readonly maxSessionsPerPrincipal: number
  private readonly maxResourceSubscriptionsPerSession: number

  constructor (options: { redis: Redis, maxMessages?: number, sessionTtlMs?: number, maxSessionsPerPrincipal?: number, maxResourceSubscriptionsPerSession?: number }) {
    this.redis = options.redis
    this.maxMessages = options.maxMessages || 100
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS
    this.maxSessionsPerPrincipal = options.maxSessionsPerPrincipal ?? DEFAULT_MAX_SESSIONS_PER_PRINCIPAL
    this.maxResourceSubscriptionsPerSession = options.maxResourceSubscriptionsPerSession ?? DEFAULT_MAX_RESOURCE_SUBSCRIPTIONS_PER_SESSION
    validateStoreLimit('maxSessionsPerPrincipal', this.maxSessionsPerPrincipal)
    validateStoreLimit('maxResourceSubscriptionsPerSession', this.maxResourceSubscriptionsPerSession)
  }

  /** The set key holding the session ids of one owner bucket. */
  private ownerIndexKey (metadata: SessionMetadata): string {
    if (metadata.ownerSub === undefined && metadata.ownerIss === undefined) {
      return SESSION_OWNER_INDEX_ANONYMOUS
    }
    return `${SESSION_OWNER_INDEX_PREFIX}${encodeURIComponent(metadata.ownerIss ?? '')}:${encodeURIComponent(metadata.ownerSub ?? '')}`
  }

  private sessionData (metadata: SessionMetadata): Record<string, string> {
    const sessionData: Record<string, string> = {
      id: metadata.id,
      eventId: metadata.eventId.toString(),
      lastEventId: metadata.lastEventId || '',
      createdAt: metadata.createdAt.toISOString(),
      lastActivity: metadata.lastActivity.toISOString()
    }

    if (metadata.protocolVersion) {
      sessionData.protocolVersion = metadata.protocolVersion
    }
    if (metadata.clientCapabilities) {
      sessionData.clientCapabilities = JSON.stringify(metadata.clientCapabilities)
    }

    if (metadata.ownerSub !== undefined) {
      sessionData.ownerSub = metadata.ownerSub
    }
    if (metadata.ownerIss !== undefined) {
      sessionData.ownerIss = metadata.ownerIss
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

    return sessionData
  }

  async create (metadata: SessionMetadata): Promise<void> {
    const sessionKey = `session:${metadata.id}`
    const sessionData = this.sessionData(metadata)
    const args = Object.entries(sessionData).flat()

    if (this.maxSessionsPerPrincipal === Infinity) {
      await this.redis.hset(sessionKey, sessionData)

      // Expire the session after sessionTtlMs without activity
      await this.redis.pexpire(sessionKey, this.sessionTtlMs)
    } else {
      // Enforce the owner's active-session cap atomically: the check and the
      // write happen in one script, so concurrent creates on different
      // instances cannot overshoot the cap.
      const stored = await this.redis.eval(
        CREATE_WITH_LIMIT_SCRIPT,
        2,
        sessionKey,
        this.ownerIndexKey(metadata),
        metadata.id,
        String(this.sessionTtlMs),
        String(this.maxSessionsPerPrincipal),
        'session:',
        ...args
      )
      if (stored !== 1) {
        throw new SessionLimitError(this.maxSessionsPerPrincipal)
      }
    }

    // Add token mapping if present
    if (metadata.authorization?.tokenHash) {
      await this.addTokenMapping(metadata.authorization.tokenHash, metadata.id)
    }
  }

  async update (metadata: SessionMetadata): Promise<void> {
    const sessionKey = `session:${metadata.id}`

    // Persist only what the caller owns: the negotiated version, client
    // capabilities and activity time. Writing eventId/lastEventId here would
    // roll the SSE counter back to a stale value if addMessage bumped it
    // between the caller's get() and now.
    const sessionData: Record<string, string> = {
      lastActivity: metadata.lastActivity.toISOString()
    }
    if (metadata.protocolVersion) {
      sessionData.protocolVersion = metadata.protocolVersion
    }
    if (metadata.clientCapabilities) {
      sessionData.clientCapabilities = JSON.stringify(metadata.clientCapabilities)
    }

    // Check-then-write must be atomic: a separate EXISTS followed by HSET would
    // recreate a session that expired in between, leaving it with no TTL. The
    // script skips the write when the key is gone, so an expired session stays
    // expired; HSET does not touch the TTL, so the original expiry is preserved.
    await this.redis.eval(
      `if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
       redis.call('HSET', KEYS[1], unpack(ARGV))
       return 1`,
      1,
      sessionKey,
      ...Object.entries(sessionData).flat()
    )
  }

  async touch (sessionId: string): Promise<void> {
    // Refresh the idle TTL atomically, and only for a session that still exists,
    // so an expired session is never recreated without a TTL
    await this.redis.eval(
      `if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
       redis.call('HSET', KEYS[1], 'lastActivity', ARGV[1])
       redis.call('PEXPIRE', KEYS[1], ARGV[2])
       return 1`,
      1,
      `session:${sessionId}`,
      new Date().toISOString(),
      String(this.sessionTtlMs)
    )
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
      lastActivity: new Date(result.lastActivity),
      protocolVersion: result.protocolVersion || undefined
    }

    if (result.clientCapabilities) {
      try {
        metadata.clientCapabilities = JSON.parse(result.clientCapabilities)
      } catch (error) {
        // Ignore parsing errors for client capabilities
      }
    }

    if (result.ownerSub !== undefined) {
      metadata.ownerSub = result.ownerSub
    }
    if (result.ownerIss !== undefined) {
      metadata.ownerIss = result.ownerIss
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

    const subscriptions = Object.keys(result)
      .filter(key => key.startsWith(RESOURCE_SUBSCRIPTION_PREFIX))
      .map(key => key.slice(RESOURCE_SUBSCRIPTION_PREFIX.length))
    if (subscriptions.length > 0) {
      metadata.resourceSubscriptions = subscriptions
    }

    return metadata
  }

  async delete (sessionId: string): Promise<void> {
    const sessionKey = `session:${sessionId}`
    const historyKey = `session:${sessionId}:history`

    // Get session to clean up token mappings and pull its id out of the owner
    // index (a no-op when the session is already gone; the index prunes ids
    // whose key has expired the next time that owner creates a session).
    const session = await this.get(sessionId)
    if (session?.authorization?.tokenHash) {
      await this.removeTokenMapping(session.authorization.tokenHash)
    }
    if (session) {
      await this.redis.srem(this.ownerIndexKey(session), sessionId)
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
    pipeline.pexpire(sessionKey, this.sessionTtlMs)

    await pipeline.exec()
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
    // Set token mapping with same expiration as session
    await this.redis.psetex(tokenKey, this.sessionTtlMs, sessionId)
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
    await this.redis.pexpire(sessionKey, this.sessionTtlMs)

    // Add new token mapping if tokenHash is provided
    if (authorization.tokenHash) {
      await this.addTokenMapping(authorization.tokenHash, sessionId)
    }
  }

  async addResourceSubscription (sessionId: string, uri: string): Promise<void> {
    // Skip the write when the session is gone so we never recreate an expired
    // session key without a TTL. Duplicate subscriptions stay idempotent, and
    // the per-session cap (when configured) is enforced atomically so
    // concurrent subscribes cannot overshoot it.
    const result = await this.redis.eval(
      ADD_SUBSCRIPTION_SCRIPT,
      1,
      `session:${sessionId}`,
      RESOURCE_SUBSCRIPTION_PREFIX + uri,
      RESOURCE_SUBSCRIPTION_PREFIX,
      String(this.maxResourceSubscriptionsPerSession === Infinity ? -1 : this.maxResourceSubscriptionsPerSession)
    )
    if (result === -1) {
      throw new SubscriptionLimitError(this.maxResourceSubscriptionsPerSession)
    }
  }

  async removeResourceSubscription (sessionId: string, uri: string): Promise<void> {
    await this.redis.hdel(`session:${sessionId}`, RESOURCE_SUBSCRIPTION_PREFIX + uri)
  }
}
