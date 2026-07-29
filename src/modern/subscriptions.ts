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

interface Subscription {
  id: RequestId
  reply: FastifyReply
  filter: SubscriptionFilter
  keepAlive: NodeJS.Timeout
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

  constructor (log: FastifyBaseLogger) {
    this.#log = log
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
  ): void {
    reply.hijack()

    const raw = reply.raw
    raw.setHeader('Content-Type', 'text/event-stream')
    raw.setHeader('Cache-Control', 'no-cache')
    raw.setHeader('Connection', 'keep-alive')
    // Tell nginx and friends not to buffer, or notifications arrive in batches.
    raw.setHeader('X-Accel-Buffering', 'no')
    raw.writeHead(200)

    const keepAlive = setInterval(() => {
      try {
        raw.write(':\r\n')
      } catch {
        this.#close(subscription)
      }
    }, KEEPALIVE_MS)
    keepAlive.unref()

    const subscription: Subscription = { id, reply, filter, keepAlive }
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

    raw.on('close', () => {
      clearInterval(keepAlive)
      this.#subscriptions.delete(subscription)
      this.#log.debug({ subscriptionId: id }, 'Subscription stream closed by client')
    })
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
    for (const subscription of [...this.#subscriptions]) {
      this.#write(subscription, {
        jsonrpc: JSONRPC_VERSION,
        id: subscription.id,
        result: {
          resultType: 'complete',
          _meta: { [META_SUBSCRIPTION_ID]: subscription.id }
        }
      } as JSONRPCMessage)
      this.#close(subscription)
    }
  }

  #write (subscription: Subscription, message: JSONRPCMessage): void {
    try {
      subscription.reply.raw.write(`data: ${JSON.stringify(message)}\n\n`)
    } catch (error) {
      this.#log.debug({ err: error, subscriptionId: subscription.id }, 'Failed to write to subscription stream')
      this.#close(subscription)
    }
  }

  #close (subscription: Subscription): void {
    clearInterval(subscription.keepAlive)
    this.#subscriptions.delete(subscription)
    try {
      subscription.reply.raw.end()
    } catch {
      // already gone
    }
  }
}
