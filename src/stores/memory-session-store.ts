import type { JSONRPCMessage } from '../schema.ts'
import type { SessionStore, SessionMetadata, StreamMetadata } from './session-store.ts'
import type { AuthorizationContext, TokenRefreshInfo } from '../types/auth-types.ts'

interface MessageHistoryEntry {
  eventId: string
  message: JSONRPCMessage
}

export class MemorySessionStore implements SessionStore {
  private sessions = new Map<string, SessionMetadata>()
  private messageHistory = new Map<string, MessageHistoryEntry[]>() // Legacy: sessionId -> messages
  private streamMessageHistory = new Map<string, MessageHistoryEntry[]>() // streamKey -> messages
  private tokenToSession = new Map<string, string>() // tokenHash -> sessionId
  private maxMessages: number

  constructor (maxMessages: number = 100) {
    this.maxMessages = maxMessages
  }

  private getStreamKey(sessionId: string, streamId: string): string {
    return `${sessionId}:${streamId}`
  }

  async create (metadata: SessionMetadata): Promise<void> {
    const sessionData = { 
      ...metadata,
      streams: new Map(metadata.streams || [])
    }
    this.sessions.set(metadata.id, sessionData)
    this.messageHistory.set(metadata.id, [])
  }

  async get (sessionId: string): Promise<SessionMetadata | null> {
    const session = this.sessions.get(sessionId)
    if (!session) return null
    
    return { 
      ...session,
      streams: new Map(session.streams)
    }
  }

  async delete (sessionId: string): Promise<void> {
    // Clean up token mappings for this session
    const session = this.sessions.get(sessionId)
    if (session?.authorization?.tokenHash) {
      this.tokenToSession.delete(session.authorization.tokenHash)
    }

    // Clean up all stream message histories for this session
    for (const [key] of this.streamMessageHistory.entries()) {
      if (key.startsWith(`${sessionId}:`)) {
        this.streamMessageHistory.delete(key)
      }
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

  // Stream management methods
  async createStream(sessionId: string, streamId: string): Promise<StreamMetadata | null> {
    const session = this.sessions.get(sessionId)
    if (!session) return null

    const streamMetadata: StreamMetadata = {
      id: streamId,
      eventId: 0,
      lastEventId: undefined,
      createdAt: new Date(),
      lastActivity: new Date()
    }

    session.streams.set(streamId, streamMetadata)
    session.lastActivity = new Date()
    this.sessions.set(sessionId, session)

    return { ...streamMetadata }
  }

  async getStream(sessionId: string, streamId: string): Promise<StreamMetadata | null> {
    const session = this.sessions.get(sessionId)
    if (!session) return null

    const stream = session.streams.get(streamId)
    return stream ? { ...stream } : null
  }

  async deleteStream(sessionId: string, streamId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return

    session.streams.delete(streamId)
    session.lastActivity = new Date()
    this.sessions.set(sessionId, session)

    // Clean up stream message history
    const streamKey = this.getStreamKey(sessionId, streamId)
    this.streamMessageHistory.delete(streamKey)
  }

  async updateStreamActivity(sessionId: string, streamId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return

    const stream = session.streams.get(streamId)
    if (stream) {
      stream.lastActivity = new Date()
      session.lastActivity = new Date()
      this.sessions.set(sessionId, session)
    }
  }

  // Per-stream message history operations
  async addMessage(sessionId: string, streamId: string, eventId: string, message: JSONRPCMessage): Promise<void> {
    const streamKey = this.getStreamKey(sessionId, streamId)
    let history = this.streamMessageHistory.get(streamKey)
    if (!history) {
      history = []
      this.streamMessageHistory.set(streamKey, history)
    }

    history.push({ eventId, message })

    // Auto-trim using constructor maxMessages
    if (history.length > this.maxMessages) {
      history.splice(0, history.length - this.maxMessages)
    }

    // Update stream metadata
    const session = this.sessions.get(sessionId)
    if (session) {
      const stream = session.streams.get(streamId)
      if (stream) {
        stream.eventId = parseInt(eventId)
        stream.lastEventId = eventId
        stream.lastActivity = new Date()
        session.lastActivity = new Date()
        this.sessions.set(sessionId, session)
      }
    }
  }

  async getMessagesFrom(sessionId: string, streamId: string, fromEventId: string): Promise<Array<{ eventId: string, message: JSONRPCMessage }>> {
    const streamKey = this.getStreamKey(sessionId, streamId)
    const history = this.streamMessageHistory.get(streamKey) || []
    const fromIndex = history.findIndex(entry => entry.eventId === fromEventId)

    if (fromIndex === -1) {
      return []
    }

    return history.slice(fromIndex + 1).map(entry => ({
      eventId: entry.eventId,
      message: entry.message
    }))
  }

  // Legacy message operations (for backwards compatibility)
  async addSessionMessage(sessionId: string, eventId: string, message: JSONRPCMessage): Promise<void> {
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
      session.lastActivity = new Date()
    }
  }

  async getSessionMessagesFrom(sessionId: string, fromEventId: string): Promise<Array<{ eventId: string, message: JSONRPCMessage }>> {
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
