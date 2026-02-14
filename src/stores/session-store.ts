import type { JSONRPCMessage } from '../schema.ts'
import type { AuthorizationContext, TokenRefreshInfo } from '../types/auth-types.ts'

export interface StreamMetadata {
  id: string
  eventId: number
  lastEventId?: string
  createdAt: Date
  lastActivity: Date
}

export interface SessionMetadata {
  id: string
  createdAt: Date
  lastActivity: Date
  authSession?: any // OAuth session data (legacy - for Phase 2 compatibility)

  // Enhanced authorization context
  authorization?: AuthorizationContext
  tokenRefresh?: TokenRefreshInfo

  // Per-stream tracking - maps streamId to stream metadata
  streams: Map<string, StreamMetadata>
}

export interface SessionStore {
  create(metadata: SessionMetadata): Promise<void>
  get(sessionId: string): Promise<SessionMetadata | null>
  delete(sessionId: string): Promise<void>
  cleanup(): Promise<void>

  // Stream management within sessions
  createStream(sessionId: string, streamId: string): Promise<StreamMetadata | null>
  getStream(sessionId: string, streamId: string): Promise<StreamMetadata | null>
  deleteStream(sessionId: string, streamId: string): Promise<void>
  updateStreamActivity(sessionId: string, streamId: string): Promise<void>

  // Per-stream message history operations
  addMessage(sessionId: string, streamId: string, eventId: string, message: JSONRPCMessage): Promise<void>
  getMessagesFrom(sessionId: string, streamId: string, fromEventId: string): Promise<Array<{ eventId: string, message: JSONRPCMessage }>>

  // Legacy message operations (for backwards compatibility)
  addSessionMessage(sessionId: string, eventId: string, message: JSONRPCMessage): Promise<void>
  getSessionMessagesFrom(sessionId: string, fromEventId: string): Promise<Array<{ eventId: string, message: JSONRPCMessage }>>

  // Token-to-session mapping operations
  getSessionByTokenHash(tokenHash: string): Promise<SessionMetadata | null>
  addTokenMapping(tokenHash: string, sessionId: string): Promise<void>
  removeTokenMapping(tokenHash: string): Promise<void>
  updateAuthorization(sessionId: string, authorization: AuthorizationContext, tokenRefresh?: TokenRefreshInfo): Promise<void>
}
