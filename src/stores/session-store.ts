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
   * The user who created the session: the `userId` from
   * `resolveAuthorizationContext` when one is configured, otherwise the
   * subject (`sub`) of the verified access token. When set, only requests
   * from the same user at the same issuer may use the session. Unset for
   * anonymous callers.
   */
  ownerSub?: string
  /**
   * That user's issuer (the resolver's `authorizationServer`, or see
   * TokenValidationResult.issuer). A subject is only unique per issuer, so the
   * owner is the (ownerIss, ownerSub) pair.
   */
  ownerIss?: string
  /**
   * The OAuth client the owner came through (`client_id` or `azp`), so another
   * app acting for the same user cannot use the session.
   */
  ownerClient?: string

  // Enhanced authorization context
  authorization?: AuthorizationContext
  tokenRefresh?: TokenRefreshInfo

  /** Resource URIs this session subscribed to via `resources/subscribe` */
  resourceSubscriptions?: string[]
}

export interface SessionStore {
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
  addResourceSubscription(sessionId: string, uri: string): Promise<void>
  removeResourceSubscription(sessionId: string, uri: string): Promise<void>
}
