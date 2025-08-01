import type { JSONRPCMessage } from '../schema.ts'
import type { SessionStore, SessionMetadata } from './session-store.ts'
import type { AuthorizationContext, TokenRefreshInfo } from '../types/auth-types.ts'

interface MessageHistoryEntry {
  eventId: string
  message: JSONRPCMessage
}

export class MemorySessionStore implements SessionStore {
  private sessions = new Map<string, SessionMetadata>()
  private messageHistory = new Map<string, MessageHistoryEntry[]>()
  private tokenToSession = new Map<string, string>() // tokenHash -> sessionId
  private maxMessages: number

  constructor (maxMessages: number = 100) {
    this.maxMessages = maxMessages
  }

  async create (metadata: SessionMetadata): Promise<void> {
    this.sessions.set(metadata.id, { ...metadata })
    this.messageHistory.set(metadata.id, [])
  }

  async get (sessionId: string): Promise<SessionMetadata | null> {
    const session = this.sessions.get(sessionId)
    return session ? { ...session } : null
  }

  async delete (sessionId: string): Promise<void> {
    // Clean up token mappings for this session
    const session = this.sessions.get(sessionId)
    if (session?.authorization?.tokenHash) {
      this.tokenToSession.delete(session.authorization.tokenHash)
    }

    this.sessions.delete(sessionId)
    this.messageHistory.delete(sessionId)
  }

  async cleanup (): Promise<void> {
    const now = new Date()
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000)

    for (const [sessionId, metadata] of this.sessions.entries()) {
      if (metadata.lastActivity < oneHourAgo) {
        await this.delete(sessionId)
      }
    }
  }

  async addMessage (sessionId: string, eventId: string, message: JSONRPCMessage): Promise<void> {
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

    // Update session metadata
    const session = this.sessions.get(sessionId)
    if (session) {
      session.lastEventId = eventId
      session.lastActivity = new Date()
    }
  }

  async getMessagesFrom (sessionId: string, fromEventId: string): Promise<Array<{ eventId: string, message: JSONRPCMessage }>> {
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
    const session = this.sessions.get(sessionId)
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
}
