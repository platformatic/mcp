import type { JSONRPCMessage } from '../schema.ts'
import type { SessionStore, SessionMetadata } from './session-store.ts'
import type { AuthorizationContext, TokenRefreshInfo } from '../types/auth-types.ts'

interface MessageHistoryEntry {
  eventId: string
  message: JSONRPCMessage
}

/** Idle time after which a session expires, matching RedisSessionStore (1 hour) */
export const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1000

export interface MemorySessionStoreOptions {
  /**
   * Expire a session after this many milliseconds without activity
   * (default 1 hour, like the Redis store's TTL).
   */
  sessionTtlMs?: number
}

export class MemorySessionStore implements SessionStore {
  private sessions = new Map<string, SessionMetadata>()
  private messageHistory = new Map<string, MessageHistoryEntry[]>()
  private tokenToSession = new Map<string, string>() // tokenHash -> sessionId
  private maxMessages: number
  readonly sessionTtlMs: number

  constructor (maxMessages: number = 100, options: MemorySessionStoreOptions = {}) {
    this.maxMessages = maxMessages
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS
  }

  private isExpired (session: SessionMetadata): boolean {
    return Date.now() - session.lastActivity.getTime() > this.sessionTtlMs
  }

  /**
   * The stored session, or undefined when it is missing or idle past its TTL.
   * An expired session is removed here so it behaves like an expired Redis key
   * even before the periodic cleanup runs.
   */
  private live (sessionId: string): SessionMetadata | undefined {
    const session = this.sessions.get(sessionId)
    if (!session) return undefined
    if (this.isExpired(session)) {
      this.deleteSync(sessionId)
      return undefined
    }
    return session
  }

  async create (metadata: SessionMetadata): Promise<void> {
    this.sessions.set(metadata.id, { ...metadata })
    this.messageHistory.set(metadata.id, [])
  }

  async touch (sessionId: string): Promise<void> {
    const session = this.live(sessionId)
    if (session) {
      session.lastActivity = new Date()
    }
  }

  async update (metadata: SessionMetadata): Promise<void> {
    const existing = this.live(metadata.id)
    if (!existing) {
      return
    }
    // Only the negotiated version, client capabilities and activity time are the
    // caller's to change. Writing the whole record back would roll the event
    // counter back to a stale value if a concurrent SSE message bumped it
    // between get() and update().
    existing.lastActivity = metadata.lastActivity
    if (metadata.protocolVersion !== undefined) {
      existing.protocolVersion = metadata.protocolVersion
    }
    if (metadata.clientCapabilities !== undefined) {
      existing.clientCapabilities = metadata.clientCapabilities
    }
  }

  async get (sessionId: string): Promise<SessionMetadata | null> {
    const session = this.live(sessionId)
    if (!session) return null
    const copy = { ...session }
    if (session.resourceSubscriptions) {
      copy.resourceSubscriptions = [...session.resourceSubscriptions]
    }
    return copy
  }

  async delete (sessionId: string): Promise<void> {
    this.deleteSync(sessionId)
  }

  private deleteSync (sessionId: string): void {
    // Clean up token mappings for this session
    const session = this.sessions.get(sessionId)
    if (session?.authorization?.tokenHash) {
      this.tokenToSession.delete(session.authorization.tokenHash)
    }

    this.sessions.delete(sessionId)
    this.messageHistory.delete(sessionId)
  }

  /** Remove every session idle past its TTL, with its history and token mapping */
  async cleanup (): Promise<void> {
    for (const [sessionId, metadata] of this.sessions) {
      if (this.isExpired(metadata)) {
        this.deleteSync(sessionId)
      }
    }
  }

  /** Number of sessions currently held, including expired ones not yet swept */
  get size (): number {
    return this.sessions.size
  }

  async addMessage (sessionId: string, eventId: string, message: JSONRPCMessage): Promise<void> {
    // Do not revive an expired session or keep history for one that is gone
    const session = this.live(sessionId)
    if (!session) return

    let history = this.messageHistory.get(sessionId)
    if (!history) {
      history = []
      this.messageHistory.set(sessionId, history)
    }

    history.push({ eventId, message })

    // Auto-trim using constructor maxMessages
    if (history.length > this.maxMessages) {
      history.splice(0, history.length - this.maxMessages)
    }

    // Update session metadata.
    // Persist the numeric counter, not just lastEventId. get() hands callers a
    // copy, so the `++session.eventId` a caller does on that copy is otherwise
    // never stored — leaving every SSE event with id "1" and breaking
    // Last-Event-ID resumption. The Redis backend already persists this.
    const numericEventId = parseInt(eventId, 10)
    if (!Number.isNaN(numericEventId)) {
      session.eventId = numericEventId
    }
    session.lastEventId = eventId
    session.lastActivity = new Date()
  }

  async getMessagesFrom (sessionId: string, fromEventId: string): Promise<Array<{ eventId: string, message: JSONRPCMessage }>> {
    if (!this.live(sessionId)) return []
    const history = this.messageHistory.get(sessionId) || []
    const fromIndex = history.findIndex(entry => entry.eventId === fromEventId)

    if (fromIndex === -1) {
      return []
    }

    return history.slice(fromIndex + 1).map(entry => ({
      eventId: entry.eventId,
      message: entry.message
    }))
  }

  // Token-to-session mapping operations
  async getSessionByTokenHash (tokenHash: string): Promise<SessionMetadata | null> {
    const sessionId = this.tokenToSession.get(tokenHash)
    if (!sessionId) {
      return null
    }
    return this.get(sessionId)
  }

  async addTokenMapping (tokenHash: string, sessionId: string): Promise<void> {
    this.tokenToSession.set(tokenHash, sessionId)
  }

  async removeTokenMapping (tokenHash: string): Promise<void> {
    this.tokenToSession.delete(tokenHash)
  }

  async updateAuthorization (sessionId: string, authorization: AuthorizationContext, tokenRefresh?: TokenRefreshInfo): Promise<void> {
    const session = this.live(sessionId)
    if (!session) {
      throw new Error(`Session ${sessionId} not found`)
    }

    // Remove old token mapping if it exists
    if (session.authorization?.tokenHash) {
      this.tokenToSession.delete(session.authorization.tokenHash)
    }

    // Update session authorization
    session.authorization = authorization
    session.tokenRefresh = tokenRefresh
    session.lastActivity = new Date()

    // Add new token mapping if tokenHash is provided
    if (authorization.tokenHash) {
      this.tokenToSession.set(authorization.tokenHash, sessionId)
    }

    this.sessions.set(sessionId, session)
  }

  async addResourceSubscription (sessionId: string, uri: string): Promise<void> {
    const session = this.live(sessionId)
    if (!session) return
    const subscriptions = session.resourceSubscriptions ??= []
    if (!subscriptions.includes(uri)) {
      subscriptions.push(uri)
    }
  }

  async removeResourceSubscription (sessionId: string, uri: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session?.resourceSubscriptions) return
    session.resourceSubscriptions = session.resourceSubscriptions.filter(s => s !== uri)
  }
}
