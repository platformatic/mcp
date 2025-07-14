import type { JSONRPCMessage } from '../schema.ts'
import type { SessionStore, SessionMetadata } from './session-store.ts'

interface MessageHistoryEntry {
  eventId: string
  message: JSONRPCMessage
}

export class MemorySessionStore implements SessionStore {
  private sessions = new Map<string, SessionMetadata>()
  private messageHistory = new Map<string, MessageHistoryEntry[]>()
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

  async update (sessionId: string, metadata: SessionMetadata): Promise<void> {
    if (this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, { ...metadata })
    }
  }

  async delete (sessionId: string): Promise<void> {
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

  async trimMessageHistory (sessionId: string, maxMessages: number): Promise<void> {
    const history = this.messageHistory.get(sessionId)
    if (history && history.length > maxMessages) {
      history.splice(0, history.length - maxMessages)
    }
  }
}
