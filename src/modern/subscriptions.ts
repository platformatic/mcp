/**
 * `subscriptions/listen` streams.
 *
 * This revision has no standalone GET endpoint and no `resources/subscribe`
 * RPC. A client that wants change notifications sends one long-lived request
 * and names exactly what it wants; the response *is* the stream. Everything the
 * server pushes on it carries the subscription id, which is the JSON-RPC id of
 * the request that opened it.
 */

import type { FastifyBaseLogger, FastifyReply } from 'fastify'
import type { JSONRPCMessage, JSONRPCNotification, RequestId } from '../schema.ts'
import { JSONRPC_VERSION } from '../schema.ts'
import type { ServerCapabilities, SubscriptionFilter } from '../schema-2026.ts'
import { META_SUBSCRIPTION_ID } from '../schema-2026.ts'

/** How often a quiet stream emits an SSE comment to stay open through proxies. */
const KEEPALIVE_MS = 30_000
/** Per-client application queue beyond Node's own writable buffer. */
const DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024
const DEFAULT_CLOSE_DRAIN_TIMEOUT_MS = 1000

interface Subscription {
  id: RequestId
  reply: FastifyReply
  filter: SubscriptionFilter
  keepAlive?: NodeJS.Timeout
  blocked: boolean
  queue: string[]
  queuedBytes: number
  onDrain?: () => void
  onClose?: () => void
}

/**
 * Narrow a requested filter to what this server can actually honour.
 *
 * The acknowledgement reports the subset the server agreed to, so a client can
 * see that (say) it asked for prompt-list changes on a server with no prompts.
 */
export function negotiateFilter (
  requested: SubscriptionFilter,
  capabilities: ServerCapabilities
): SubscriptionFilter {
  const agreed: SubscriptionFilter = {}

  if (requested.toolsListChanged && capabilities.tools !== undefined) {
    agreed.toolsListChanged = true
  }
  if (requested.promptsListChanged && capabilities.prompts !== undefined) {
    agreed.promptsListChanged = true
  }
  if (requested.resourcesListChanged && capabilities.resources !== undefined) {
    agreed.resourcesListChanged = true
  }
  if (requested.resourceSubscriptions?.length && capabilities.resources !== undefined) {
    agreed.resourceSubscriptions = [...new Set(requested.resourceSubscriptions)]
  }

  return agreed
}

/** Does this notification match what the subscription asked for? */
export function matchesFilter (notification: JSONRPCNotification, filter: SubscriptionFilter): boolean {
  switch (notification.method) {
    case 'notifications/tools/list_changed':
      return filter.toolsListChanged === true
    case 'notifications/prompts/list_changed':
      return filter.promptsListChanged === true
    case 'notifications/resources/list_changed':
      return filter.resourcesListChanged === true
    case 'notifications/resources/updated': {
      const uri = (notification.params as { uri?: unknown } | undefined)?.uri
      if (typeof uri !== 'string') return false
      return filter.resourceSubscriptions?.includes(uri) === true
    }
    default:
      // Request-scoped notifications (progress, log messages) belong on the
      // response stream of the request they relate to, never here.
      return false
  }
}

/**
 * Registry of open listen streams for this process.
 *
 * Subscriptions are per-connection by nature, so there is nothing to share
 * across instances: each replica fans broadcasts out to the streams it is
 * holding, and the message broker is what gets the broadcast to every replica.
 */
export class SubscriptionRegistry {
  #subscriptions = new Set<Subscription>()
  #log: FastifyBaseLogger
  #maxBufferedBytes: number
  #closeDrainTimeoutMs: number
  #closing = false

  constructor (
    log: FastifyBaseLogger,
    maxBufferedBytes: number = DEFAULT_MAX_BUFFERED_BYTES,
    closeDrainTimeoutMs: number = DEFAULT_CLOSE_DRAIN_TIMEOUT_MS
  ) {
    this.#log = log
    this.#maxBufferedBytes = Math.max(1, maxBufferedBytes)
    this.#closeDrainTimeoutMs = Math.max(1, closeDrainTimeoutMs)
  }

  get size (): number {
    return this.#subscriptions.size
  }

  /**
   * Take over the reply, acknowledge the subscription, and keep the stream
   * open until either side closes it.
   */
  open (
    reply: FastifyReply,
    id: RequestId,
    filter: SubscriptionFilter
  ): boolean {
    const raw = reply.raw
    if (this.#closing || raw.destroyed || raw.closed || raw.writableEnded) return false

    reply.hijack()

    raw.setHeader('Content-Type', 'text/event-stream')
    raw.setHeader('Cache-Control', 'no-cache')
    raw.setHeader('Connection', 'keep-alive')
    // Tell nginx and friends not to buffer, or notifications arrive in batches.
    raw.setHeader('X-Accel-Buffering', 'no')
    raw.writeHead(200)

    const subscription: Subscription = {
      id,
      reply,
      filter,
      blocked: false,
      queue: [],
      queuedBytes: 0
    }

    subscription.onClose = () => {
      this.#remove(subscription)
      this.#log.debug({ subscriptionId: id }, 'Subscription stream closed by client')
    }
    raw.once('close', subscription.onClose)

    subscription.keepAlive = setInterval(() => {
      // Keepalives are disposable. Do not queue them behind real messages when
      // the peer is already applying backpressure.
      if (!subscription.blocked) this.#writeFrame(subscription, ':\r\n', false)
    }, KEEPALIVE_MS)
    subscription.keepAlive.unref()
    this.#subscriptions.add(subscription)

    // The acknowledgement must be the first thing on the stream, so the client
    // learns which of its requested notification types were actually accepted.
    this.#write(subscription, {
      jsonrpc: JSONRPC_VERSION,
      method: 'notifications/subscriptions/acknowledged',
      params: {
        _meta: { [META_SUBSCRIPTION_ID]: id },
        notifications: filter
      }
    })

    return this.#subscriptions.has(subscription)
  }

  /** Fan a notification out to every subscription that asked for it. */
  deliver (notification: JSONRPCNotification): void {
    for (const subscription of [...this.#subscriptions]) {
      if (!matchesFilter(notification, subscription.filter)) continue

      this.#write(subscription, {
        ...notification,
        params: {
          ...(notification.params ?? {}),
          _meta: {
            ...((notification.params as { _meta?: Record<string, unknown> } | undefined)?._meta ?? {}),
            [META_SUBSCRIPTION_ID]: subscription.id
          }
        }
      })
    }
  }

  /**
   * End every stream gracefully.
   *
   * Each gets the empty response to its original request first: that is what
   * distinguishes an orderly shutdown from a dropped connection, and tells the
   * client it may reconnect rather than assume something broke.
   */
  closeAll (): void {
    this.#closing = true
    for (const subscription of [...this.#subscriptions]) {
      const completion = {
        jsonrpc: JSONRPC_VERSION,
        id: subscription.id,
        result: {
          resultType: 'complete',
          _meta: { [META_SUBSCRIPTION_ID]: subscription.id }
        }
      } as JSONRPCMessage
      // `end(frame)` appends the completion after Node's existing writable
      // buffer even when write() previously returned false. Queuing and then
      // clearing it would silently drop the protocol's graceful completion.
      this.#close(subscription, `data: ${JSON.stringify(completion)}\n\n`)
    }
  }

  #write (subscription: Subscription, message: JSONRPCMessage): void {
    this.#writeFrame(subscription, `data: ${JSON.stringify(message)}\n\n`, true)
  }

  #writeFrame (subscription: Subscription, frame: string, queueWhenBlocked: boolean): void {
    if (!this.#subscriptions.has(subscription)) return

    if (subscription.blocked) {
      if (queueWhenBlocked) this.#enqueue(subscription, frame)
      return
    }

    try {
      if (!subscription.reply.raw.write(frame)) this.#waitForDrain(subscription)
    } catch (error) {
      this.#log.debug({ err: error, subscriptionId: subscription.id }, 'Failed to write to subscription stream')
      this.#close(subscription)
    }
  }

  #enqueue (subscription: Subscription, frame: string): void {
    const bytes = Buffer.byteLength(frame)
    if (subscription.queuedBytes + bytes > this.#maxBufferedBytes) {
      this.#log.warn({
        subscriptionId: subscription.id,
        maxBufferedBytes: this.#maxBufferedBytes
      }, 'Closing slow subscription after its buffer limit was exceeded')
      this.#close(subscription)
      return
    }

    subscription.queue.push(frame)
    subscription.queuedBytes += bytes
  }

  #waitForDrain (subscription: Subscription): void {
    if (subscription.blocked || !this.#subscriptions.has(subscription)) return
    subscription.blocked = true

    const onDrain = () => {
      subscription.onDrain = undefined
      subscription.blocked = false
      this.#flush(subscription)
    }
    subscription.onDrain = onDrain
    subscription.reply.raw.once('drain', onDrain)
  }

  #flush (subscription: Subscription): void {
    while (this.#subscriptions.has(subscription) && subscription.queue.length > 0) {
      const frame = subscription.queue.shift()!
      subscription.queuedBytes -= Buffer.byteLength(frame)
      try {
        if (!subscription.reply.raw.write(frame)) {
          this.#waitForDrain(subscription)
          return
        }
      } catch (error) {
        this.#log.debug({ err: error, subscriptionId: subscription.id }, 'Failed to drain subscription buffer')
        this.#close(subscription)
        return
      }
    }
  }

  #remove (subscription: Subscription): void {
    if (subscription.keepAlive) clearInterval(subscription.keepAlive)
    if (subscription.onDrain) subscription.reply.raw.off('drain', subscription.onDrain)
    if (subscription.onClose) subscription.reply.raw.off('close', subscription.onClose)
    subscription.onDrain = undefined
    subscription.onClose = undefined
    subscription.queue.length = 0
    subscription.queuedBytes = 0
    subscription.blocked = false
    this.#subscriptions.delete(subscription)
  }

  #close (subscription: Subscription, finalFrame?: string): void {
    this.#remove(subscription)
    const raw = subscription.reply.raw
    try {
      raw.end(finalFrame)
      if (!raw.writableFinished && !raw.destroyed && !raw.closed) {
        // A peer that stopped reading may never drain `end(finalFrame)`. Bound
        // graceful shutdown, then force the socket closed so Fastify's close
        // cannot wait forever on a stream no longer present in the registry.
        const timer = setTimeout(() => {
          try {
            if (!raw.destroyed && !raw.closed) raw.destroy()
          } catch {
            // best-effort shutdown
          }
        }, this.#closeDrainTimeoutMs)
        timer.unref()
        raw.once('close', () => clearTimeout(timer))
      }
    } catch {
      try {
        raw.destroy()
      } catch {
        // already gone
      }
    }
  }
}
