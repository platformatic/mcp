import type { Redis } from 'ioredis'
import type { PKCEChallenge } from './oauth-client.ts'

/** What /oauth/authorize remembers until its callback arrives. */
export interface AuthSession {
  state: string
  pkce: PKCEChallenge
  resourceUri?: string
  callbackUrl?: string // The redirect_uri used in authorization request (required for OIDC token exchange)
}

/**
 * Pending authorization requests, keyed by `state`. Kept apart from MCP
 * sessions: anyone can start an authorization, and its state must not be
 * addressable as a session. `take` reads and removes in one step, so a state
 * is redeemed once.
 */
export interface AuthorizationStateStore {
  put (state: string, session: AuthSession, ttlMs: number): Promise<void>
  take (state: string): Promise<AuthSession | undefined>
}

export const AUTHORIZATION_STATE_TTL_MS = 10 * 60 * 1000
const DEFAULT_MAX_PENDING = 10_000

export class MemoryAuthorizationStateStore implements AuthorizationStateStore {
  private readonly pending = new Map<string, { session: AuthSession, expiresAt: number }>()
  private readonly maxPending: number

  constructor (maxPending = DEFAULT_MAX_PENDING) {
    this.maxPending = maxPending
  }

  async put (state: string, session: AuthSession, ttlMs: number): Promise<void> {
    const now = Date.now()
    // Insertion order is expiry order for a fixed ttl: drop the lapsed ones,
    // then the oldest while full.
    for (const [key, entry] of this.pending) {
      if (entry.expiresAt > now && this.pending.size < this.maxPending) break
      this.pending.delete(key)
    }
    this.pending.set(state, { session, expiresAt: now + ttlMs })
  }

  async take (state: string): Promise<AuthSession | undefined> {
    const entry = this.pending.get(state)
    if (!entry) return undefined
    this.pending.delete(state)
    return entry.expiresAt > Date.now() ? entry.session : undefined
  }
}

export class RedisAuthorizationStateStore implements AuthorizationStateStore {
  private readonly redis: Redis

  constructor (redis: Redis) {
    this.redis = redis
  }

  private key (state: string): string {
    return `mcp:oauth:state:${state}`
  }

  async put (state: string, session: AuthSession, ttlMs: number): Promise<void> {
    await this.redis.set(this.key(state), JSON.stringify(session), 'PX', ttlMs)
  }

  async take (state: string): Promise<AuthSession | undefined> {
    const results = await this.redis.multi().get(this.key(state)).del(this.key(state)).exec()
    const [error, value] = results?.[0] ?? []
    if (error) throw error
    return typeof value === 'string' ? JSON.parse(value) as AuthSession : undefined
  }
}
