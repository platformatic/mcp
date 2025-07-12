import { randomUUID } from 'crypto'
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type { JSONRPCMessage } from '../schema.ts'
import type { SSESession } from '../types.ts'

export function createSSESession (sessions: Map<string, SSESession>): SSESession {
  const sessionId = randomUUID()
  const session: SSESession = {
    id: sessionId,
    eventId: 0,
    streams: new Set(),
    lastEventId: undefined,
    messageHistory: []
  }
  sessions.set(sessionId, session)
  return session
}

export function supportsSSE (request: FastifyRequest): boolean {
  const accept = request.headers.accept
  return accept ? accept.includes('text/event-stream') : false
}

export function hasActiveSSESession (sessionId: string | undefined, sessions: Map<string, SSESession>): boolean {
  if (!sessionId) return false
  const session = sessions.get(sessionId)
  return session ? session.streams.size > 0 : false
}

export function replayMessagesFromEventId (session: SSESession, lastEventId: string, stream: FastifyReply, app: FastifyInstance): void {
  // Find the index of the last received event
  const lastIndex = session.messageHistory.findIndex(entry => entry.eventId === lastEventId)

  if (lastIndex !== -1) {
    // Replay messages after the last received event
    const messagesToReplay = session.messageHistory.slice(lastIndex + 1)

    for (const entry of messagesToReplay) {
      const sseEvent = `id: ${entry.eventId}\ndata: ${JSON.stringify(entry.message)}\n\n`
      try {
        stream.raw.write(sseEvent)
      } catch (error) {
        app.log.error('Failed to replay SSE event:', error)
        break
      }
    }

    if (messagesToReplay.length > 0) {
      app.log.info(`Replayed ${messagesToReplay.length} messages from event ID: ${lastEventId}`)
    }
  } else {
    app.log.warn(`Event ID ${lastEventId} not found in message history`)
  }
}

export function sendSSEMessage (session: SSESession, message: JSONRPCMessage, sessions: Map<string, SSESession>, app: FastifyInstance): void {
  const eventId = (++session.eventId).toString()
  const sseEvent = `id: ${eventId}\ndata: ${JSON.stringify(message)}\n\n`
  session.lastEventId = eventId

  // Store message in history for resumability
  session.messageHistory.push({ eventId, message })
  // Keep only last 100 messages to prevent memory leaks
  if (session.messageHistory.length > 100) {
    session.messageHistory.shift()
  }

  // Send to all connected streams in this session
  const deadStreams = new Set<FastifyReply>()
  for (const stream of session.streams) {
    try {
      stream.raw.write(sseEvent)
    } catch (error) {
      app.log.error('Failed to write SSE event:', error)
      deadStreams.add(stream)
    }
  }

  // Clean up dead streams
  for (const deadStream of deadStreams) {
    session.streams.delete(deadStream)
  }

  // Clean up session if no streams left
  if (session.streams.size === 0) {
    app.log.info({
      sessionId: session.id
    }, 'Session has no active streams, cleaning up')
    sessions.delete(session.id)
  }
}
