import type { ClientCapabilities, JSONRPCMessage } from '../schema.ts'
import type { AuthorizationContext, TokenRefreshInfo } from '../types/auth-types.ts'

export interface SessionMetadata {
  id: string
  eventId: number
  lastEventId?: string
  createdAt: Date
  lastActivity: Date
  /** Protocol revision agreed during `initialize`, if the handshake has happened */
  protocolVersion?: string
  /** Capabilities the client declared during `initialize`, if the handshake has happened */
  clientCapabilities?: ClientCapabilities
  authSession?: any // OAuth session data (legacy - for Phase 2 compatibility)
  /**
   * Subject (`sub`) of the verified access token that created the session.
   * When set, only requests bearing a token for the same issuer and subject
   * may use the session. Unset when authorization is disabled.
   */
  ownerSub?: string
  /**
   * Issuer identity of that token (see TokenValidationResult.issuer). A subject
   * is only unique per issuer, so the owner is the (ownerIss, ownerSub) pair.
   */
  ownerIss?: string

  // Enhanced authorization context
  authorization?: AuthorizationContext
  tokenRefresh?: TokenRefreshInfo

  /** Resource URIs this session subscribed to via `resources/subscribe` */
  resourceSubscriptions?: string[]
}

/**
 * How many sessions one principal may keep active, by default: unlimited.
 * A session's principal is the (issuer, subject) pair that created it, or the
 * shared anonymous bucket when no caller can be identified.
 */
export const DEFAULT_MAX_SESSIONS_PER_PRINCIPAL = Infinity

/**
 * How many distinct resource URIs one session may subscribe to, by default:
 * unlimited.
 */
export const DEFAULT_MAX_RESOURCE_SUBSCRIPTIONS_PER_SESSION = Infinity

/**
 * JSON-RPC error code returned when a session cannot be created because its
 * owner is at the active-session cap. Implementation-defined, in the
 * -32000..-32099 server error range (matching TASK_LIMIT_REACHED).
 */
export const SESSION_LIMIT_REACHED = -32035

/**
 * JSON-RPC error code returned when a resource subscription cannot be added
 * because the session is at its subscription cap.
 */
export const SUBSCRIPTION_LIMIT_REACHED = -32036

/**
 * Thrown by `SessionStore.create` when the owner is at the active-session cap.
 */
export class SessionLimitError extends Error {
  readonly limit: number

  constructor (limit: number) {
    super(`Session limit reached (${limit})`)
    this.name = 'SessionLimitError'
    this.limit = limit
  }
}

/**
 * Thrown by `SessionStore.addResourceSubscription` when the session is at its
 * subscription cap and the URI is not already subscribed.
 */
export class SubscriptionLimitError extends Error {
  readonly limit: number

  constructor (limit: number) {
    super(`Resource subscription limit reached (${limit})`)
    this.name = 'SubscriptionLimitError'
    this.limit = limit
  }
}

/** Validate a session/subscription limit option, accepting Infinity or a positive integer. */
export function validateStoreLimit (name: string, value: unknown): void {
  if (value === Infinity) return
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer or Infinity`)
  }
}

export interface SessionStore {
  /**
   * Store a new session, enforcing the owner's active-session cap when one is
   * configured. The cap is keyed by the session's (ownerIss, ownerSub) pair, or
   * by a shared anonymous bucket when the session has no owner.
   * @throws SessionLimitError when the owner is at the active-session cap
   */
  create(metadata: SessionMetadata): Promise<void>
  /**
   * Persist changes to an existing session without touching its message history.
   * A no-op when the session is gone.
   */
  update(metadata: SessionMetadata): Promise<void>
  get(sessionId: string): Promise<SessionMetadata | null>
  /**
   * Record activity on a session so it is not expired while in use. Called on
   * every request carrying the session id and on each SSE heartbeat. A no-op
   * when the session is gone. Optional for custom stores that do not expire.
   */
  touch?(sessionId: string): Promise<void>
  delete(sessionId: string): Promise<void>
  cleanup(): Promise<void>

  // Message history operations
  addMessage(sessionId: string, eventId: string, message: JSONRPCMessage): Promise<void>
  getMessagesFrom(sessionId: string, fromEventId: string): Promise<Array<{ eventId: string, message: JSONRPCMessage }>>

  // Token-to-session mapping operations
  getSessionByTokenHash(tokenHash: string): Promise<SessionMetadata | null>
  addTokenMapping(tokenHash: string, sessionId: string): Promise<void>
  removeTokenMapping(tokenHash: string): Promise<void>
  updateAuthorization(sessionId: string, authorization: AuthorizationContext, tokenRefresh?: TokenRefreshInfo): Promise<void>

  // Resource subscription operations (no-ops when the session is gone)
  /**
   * Record a resource subscription. Adding an already-subscribed URI is a
   * no-op. When a per-session cap is configured and the session is at that cap,
   * adding a new URI fails.
   * @throws SubscriptionLimitError when the session is at the subscription cap
   */
  addResourceSubscription(sessionId: string, uri: string): Promise<void>
  removeResourceSubscription(sessionId: string, uri: string): Promise<void>
}
