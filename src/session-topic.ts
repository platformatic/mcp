import type { JSONRPCMessage } from './schema.ts'
import type { MessageBroker } from './brokers/message-broker.ts'
import type { SessionStore } from './stores/session-store.ts'

/**
 * Per-session broker topic of the legacy (Streamable HTTP + SSE) transport.
 *
 * A message is written to the session's history by whoever sends it, and only
 * then published here with the event id it was stored under. Instances that
 * hold one of the session's GET streams subscribe and write it to their
 * streams; nobody else needs to. Storing on the sending side is what keeps
 * history exactly-once with several instances: if subscribers stored it, every
 * subscribed instance would add its own copy.
 */
export function sessionTopic (sessionId: string): string {
  return `mcp/session/${sessionId}/message`
}

interface SessionEventPacket {
  mcpSessionEvent: { eventId: string, message: JSONRPCMessage }
}

interface SessionTerminatedPacket {
  mcpSessionTerminated: true
}

export type SessionTopicPayload =
  | { kind: 'event', eventId: string, message: JSONRPCMessage }
  | { kind: 'terminated' }
  // Published straight to the topic by code that bypasses mcpSendToSession,
  // so it is not in history yet
  | { kind: 'raw', message: JSONRPCMessage }

export function decodeSessionTopicPayload (payload: unknown): SessionTopicPayload {
  if (typeof payload === 'object' && payload !== null) {
    if ('mcpSessionEvent' in payload) {
      const { eventId, message } = (payload as SessionEventPacket).mcpSessionEvent
      return { kind: 'event', eventId, message }
    }
    if ('mcpSessionTerminated' in payload) {
      return { kind: 'terminated' }
    }
  }
  return { kind: 'raw', message: payload as JSONRPCMessage }
}

// The broker interface is typed for JSON-RPC messages, but every broker passes
// payloads through untouched (or JSON-serialized), so packets travel as is.
function asBrokerPayload (packet: SessionEventPacket | SessionTerminatedPacket): JSONRPCMessage {
  return packet as unknown as JSONRPCMessage
}

/**
 * Record a message in a session's history and return the event id it was
 * stored under, or null when the session no longer exists.
 */
export async function appendToHistory (sessionStore: SessionStore, sessionId: string, message: JSONRPCMessage): Promise<string | null> {
  const session = await sessionStore.get(sessionId)
  if (!session) return null

  const eventId = (session.eventId + 1).toString()
  await sessionStore.addMessage(sessionId, eventId, message)
  return eventId
}

/**
 * Store a message in the session's history, then hand it to whichever
 * instances hold the session's streams. Returns false when the session is gone.
 */
export async function sendToSession (
  sessionStore: SessionStore,
  messageBroker: MessageBroker,
  sessionId: string,
  message: JSONRPCMessage
): Promise<boolean> {
  const eventId = await appendToHistory(sessionStore, sessionId, message)
  if (eventId === null) return false

  await messageBroker.publish(sessionTopic(sessionId), asBrokerPayload({ mcpSessionEvent: { eventId, message } }))
  return true
}

/** Tell every instance that the session was terminated, so they end its streams */
export async function publishSessionTerminated (messageBroker: MessageBroker, sessionId: string): Promise<void> {
  await messageBroker.publish(sessionTopic(sessionId), asBrokerPayload({ mcpSessionTerminated: true }))
}

/**
 * Keeps this instance subscribed to a session's topic exactly while `wanted`
 * says so (while it holds at least one of the session's streams).
 *
 * Changes for one session are applied one at a time, so a stream closing and
 * another attaching in quick succession can never leave the subscription
 * dropped by an unsubscribe that finished after the new subscribe.
 */
export class SessionTopicSubscriptions {
  private readonly broker: MessageBroker
  private readonly wanted: (sessionId: string) => boolean
  private readonly handler: (sessionId: string, payload: SessionTopicPayload) => void
  private readonly subscribed = new Set<string>()
  private readonly pending = new Map<string, Promise<void>>()
  private closed = false

  constructor (
    broker: MessageBroker,
    wanted: (sessionId: string) => boolean,
    handler: (sessionId: string, payload: SessionTopicPayload) => void
  ) {
    this.broker = broker
    this.wanted = wanted
    this.handler = handler
  }

  /** Subscribe or unsubscribe so the subscription matches `wanted` */
  sync (sessionId: string): Promise<void> {
    const previous = this.pending.get(sessionId) ?? Promise.resolve()
    const apply = () => this.apply(sessionId)
    const next = previous.then(apply, apply)
    const tracked = next.catch(() => {}).finally(() => {
      if (this.pending.get(sessionId) === tracked) {
        this.pending.delete(sessionId)
      }
    })
    this.pending.set(sessionId, tracked)
    return next
  }

  isSubscribed (sessionId: string): boolean {
    return this.subscribed.has(sessionId)
  }

  /** Stop following `wanted` and drop every subscription */
  async close (): Promise<void> {
    this.closed = true
    await Promise.all([...this.pending.values()])
    await Promise.allSettled([...this.subscribed].map(sessionId => this.sync(sessionId)))
  }

  private async apply (sessionId: string): Promise<void> {
    const want = !this.closed && this.wanted(sessionId)
    if (want && !this.subscribed.has(sessionId)) {
      await this.broker.subscribe(sessionTopic(sessionId), (payload: unknown) => {
        this.handler(sessionId, decodeSessionTopicPayload(payload))
      })
      this.subscribed.add(sessionId)
    } else if (!want && this.subscribed.has(sessionId)) {
      this.subscribed.delete(sessionId)
      await this.broker.unsubscribe(sessionTopic(sessionId))
    }
  }
}
