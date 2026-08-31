/**
 * Cross-instance delivery of `tasks/update` input responses.
 *
 * Redis Pub/Sub confirms publication, not delivery to the replica that owns a
 * task execution. Delivery therefore uses an explicit acknowledgement: the
 * publishing request waits until the owning waiter (or its pre-wait buffer)
 * consumes the message. The task store keeps the response in an outbox until
 * that acknowledgement arrives, so retries remain safe.
 */

import type { InputResponses } from '../schema-2026.ts'

export const TASK_INPUT_TOPIC = 'mcp/tasks/input'
export const TASK_INPUT_ACK_TOPIC = 'mcp/tasks/input/ack'
export const TASK_INPUT_CANCEL_TOPIC = 'mcp/tasks/input/cancel'

interface Waiter {
  resolve: (responses: InputResponses) => void
  reject: (error: Error) => void
  signal?: AbortSignal
  onAbort?: () => void
}

interface PendingDelivery {
  taskId: string
  deliveryId: string
  responses: InputResponses
  expiresAt: number
}

interface AckWaiter {
  resolve: () => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

type Publisher = (taskId: string, responses: Record<string, unknown>, deliveryId: string) => Promise<void>
type AcknowledgementPublisher = (taskId: string, deliveryId: string, keys: string[]) => Promise<void>
type CancellationPublisher = (taskId: string, cancellationId: string) => Promise<void>

const DEFAULT_RETENTION_MS = 3_600_000
const DEFAULT_ACK_TIMEOUT_MS = 5_000
const DEFAULT_MAX_PENDING = 1000

export class TaskInputChannel {
  #waiters = new Map<string, Set<Waiter>>()
  #pending = new Map<string, PendingDelivery>()
  #seenDeliveries = new Map<string, number>()
  #cancellations = new Map<string, { expiresAt: number, cancellationId: string, acknowledged: boolean }>()
  #ackWaiters = new Map<string, Set<AckWaiter>>()
  #publish?: Publisher
  #publishAcknowledgement?: AcknowledgementPublisher
  #publishCancellation?: CancellationPublisher
  #expiryTimer?: NodeJS.Timeout
  #closed = false

  readonly #retentionMs: number
  readonly #ackTimeoutMs: number
  readonly #maxPending: number
  readonly #maxSeenDeliveries: number
  readonly #maxCancellations: number

  constructor (
    retentionMs: number = DEFAULT_RETENTION_MS,
    maxPending: number = DEFAULT_MAX_PENDING,
    ackTimeoutMs: number = DEFAULT_ACK_TIMEOUT_MS
  ) {
    this.#retentionMs = Math.max(1, retentionMs)
    this.#ackTimeoutMs = Math.max(1, ackTimeoutMs)
    this.#maxPending = Math.max(1, maxPending)
    this.#maxSeenDeliveries = this.#maxPending * 4
    this.#maxCancellations = this.#maxPending
  }

  get pendingSize (): number {
    return this.#pending.size
  }

  get waiterCount (): number {
    let count = 0
    for (const waiters of this.#waiters.values()) count += waiters.size
    return count
  }

  setPublisher (publish: Publisher): void {
    this.#publish = publish
  }

  setAcknowledgementPublisher (publish: AcknowledgementPublisher): void {
    this.#publishAcknowledgement = publish
  }

  setCancellationPublisher (publish: CancellationPublisher): void {
    this.#publishCancellation = publish
  }

  /**
   * Publish and wait for acknowledgement from the replica that consumed it.
   * Publication success alone is deliberately insufficient.
   */
  async publish (
    taskId: string,
    responses: Record<string, unknown>,
    deliveryId: string
  ): Promise<void> {
    if (this.#closed) throw new Error('channel closed')

    const acknowledgement = this.#registerAckWaiter(taskId, deliveryId)
    try {
      if (this.#publish) {
        await this.#publish(taskId, responses, deliveryId)
      } else {
        this.deliver(taskId, responses, deliveryId)
      }
      await acknowledgement.promise
    } catch (error) {
      acknowledgement.cancel()
      throw error
    }
  }

  async cancel (taskId: string, waitForAcknowledgement: boolean = false): Promise<void> {
    const cancellationId = `cancel:${taskId}`
    if (!this.#publishCancellation) {
      this.abort(taskId, 'cancelled', cancellationId)
      return
    }

    if (!waitForAcknowledgement) {
      await this.#publishCancellation(taskId, cancellationId)
      return
    }

    const acknowledgement = this.#registerAckWaiter(taskId, cancellationId)
    try {
      await this.#publishCancellation(taskId, cancellationId)
      await acknowledgement.promise
    } catch (error) {
      acknowledgement.cancel()
      throw error
    }
  }

  /** Called by the acknowledgement broker subscription on every replica. */
  confirmDelivery (taskId: string, deliveryId: string): void {
    const key = this.#deliveryKey(taskId, deliveryId)
    const waiters = this.#ackWaiters.get(key)
    if (!waiters) return
    for (const waiter of [...waiters]) {
      this.#removeAckWaiter(key, waiter)
      waiter.resolve()
    }
  }

  wait (taskId: string, signal?: AbortSignal): Promise<InputResponses> {
    if (this.#closed) return Promise.reject(new Error('channel closed'))
    this.#pruneExpired()

    const cancellation = this.#cancellations.get(taskId)
    if (cancellation) {
      cancellation.acknowledged = true
      this.#acknowledge(taskId, cancellation.cancellationId, [])
      return Promise.reject(new Error('task cancelled'))
    }

    const early = [...this.#pending.entries()].filter(([, entry]) => entry.taskId === taskId)
    if (early.length > 0) {
      const responses: InputResponses = {}
      for (const [key, entry] of early) {
        this.#pending.delete(key)
        Object.assign(responses, entry.responses)
        this.#markConsumed(entry.taskId, entry.deliveryId)
        this.#acknowledge(entry.taskId, entry.deliveryId, Object.keys(entry.responses))
      }
      this.#scheduleExpiry()
      return Promise.resolve(responses)
    }

    if (signal?.aborted) return Promise.reject(new Error('aborted'))

    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal }
      waiter.onAbort = () => this.#rejectWaiter(taskId, waiter, new Error('aborted'))

      let set = this.#waiters.get(taskId)
      if (!set) {
        set = new Set()
        this.#waiters.set(taskId, set)
      }
      set.add(waiter)
      signal?.addEventListener('abort', waiter.onAbort, { once: true })

      // Cancellation can race the registration above. Re-check after the
      // waiter is visible so either the tombstone or abort() rejects it.
      const racedCancellation = this.#cancellations.get(taskId)
      if (racedCancellation) {
        racedCancellation.acknowledged = true
        this.#rejectWaiter(taskId, waiter, new Error('task cancelled'))
        this.#acknowledge(taskId, racedCancellation.cancellationId, [])
      }
    })
  }

  deliver (taskId: string, responses: Record<string, unknown>, deliveryId?: string): void {
    if (this.#closed) return
    this.#pruneExpired()

    const id = deliveryId ?? `local-${taskId}`
    const deliveryKey = this.#deliveryKey(taskId, id)

    // A retry after an acknowledgement/store race must be acknowledged again,
    // but never delivered to a later input round.
    if (this.#seenDeliveries.has(deliveryKey)) {
      this.#acknowledge(taskId, id, Object.keys(responses))
      return
    }

    const set = this.#waiters.get(taskId)
    if (!set || set.size === 0) {
      if (!this.#pending.has(deliveryKey)) {
        this.#pending.set(deliveryKey, {
          taskId,
          deliveryId: id,
          responses: responses as InputResponses,
          expiresAt: Date.now() + this.#retentionMs
        })
        this.#evictOldest(this.#pending, this.#maxPending)
        this.#scheduleExpiry()
      }
      return
    }

    this.#markConsumed(taskId, id)
    for (const waiter of [...set]) {
      this.#resolveWaiter(taskId, waiter, responses as InputResponses)
    }
    this.#acknowledge(taskId, id, Object.keys(responses))
  }

  /** Reject current and future waits for a recently cancelled task. */
  abort (
    taskId: string,
    reason: string = 'cancelled',
    cancellationId: string = `cancel:${taskId}`
  ): void {
    const existing = this.#cancellations.get(taskId)
    const cancellation = {
      expiresAt: Date.now() + this.#retentionMs,
      cancellationId,
      acknowledged: existing?.acknowledged ?? false
    }
    this.#cancellations.delete(taskId)
    this.#cancellations.set(taskId, cancellation)
    this.#evictOldest(this.#cancellations, this.#maxCancellations)

    for (const [key, entry] of this.#pending) {
      if (entry.taskId === taskId) this.#pending.delete(key)
    }

    const set = this.#waiters.get(taskId)
    if (set && set.size > 0) {
      cancellation.acknowledged = true
      for (const waiter of [...set]) {
        this.#rejectWaiter(taskId, waiter, new Error(reason))
      }
    }
    if (cancellation.acknowledged) {
      this.#acknowledge(taskId, cancellationId, [])
    }
    this.#scheduleExpiry()
  }

  /** Drop transient data for a completed task without creating a tombstone. */
  forget (taskId: string): void {
    for (const [key, entry] of this.#pending) {
      if (entry.taskId === taskId) this.#pending.delete(key)
    }
    const set = this.#waiters.get(taskId)
    if (set) {
      for (const waiter of [...set]) {
        this.#rejectWaiter(taskId, waiter, new Error('task finished'))
      }
    }
    this.#scheduleExpiry()
  }

  close (): void {
    this.#closed = true
    if (this.#expiryTimer) clearTimeout(this.#expiryTimer)
    this.#expiryTimer = undefined
    this.#pending.clear()
    this.#seenDeliveries.clear()
    this.#cancellations.clear()

    for (const taskId of [...this.#waiters.keys()]) this.forget(taskId)
    for (const [key, waiters] of this.#ackWaiters) {
      for (const waiter of [...waiters]) {
        this.#removeAckWaiter(key, waiter)
        waiter.reject(new Error('channel closed'))
      }
    }
  }

  #acknowledge (taskId: string, deliveryId: string, keys: string[]): void {
    if (!this.#publishAcknowledgement) {
      this.confirmDelivery(taskId, deliveryId)
      return
    }
    this.#publishAcknowledgement(taskId, deliveryId, keys).catch(() => {
      // The sender times out and retains its outbox. A retry is re-acknowledged
      // by the seen-delivery branch above.
    })
  }

  #markConsumed (taskId: string, deliveryId: string): void {
    const key = this.#deliveryKey(taskId, deliveryId)
    this.#seenDeliveries.delete(key)
    this.#seenDeliveries.set(key, Date.now() + this.#retentionMs)
    this.#evictOldest(this.#seenDeliveries, this.#maxSeenDeliveries)
    this.#scheduleExpiry()
  }

  #registerAckWaiter (taskId: string, deliveryId: string): {
    promise: Promise<void>
    cancel: () => void
  } {
    const key = this.#deliveryKey(taskId, deliveryId)
    let waiter: AckWaiter
    const promise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#removeAckWaiter(key, waiter)
        reject(new Error(`Timed out waiting for task input delivery acknowledgement '${deliveryId}'`))
      }, this.#ackTimeoutMs)
      timer.unref()
      waiter = { resolve, reject, timer }

      let set = this.#ackWaiters.get(key)
      if (!set) {
        set = new Set()
        this.#ackWaiters.set(key, set)
      }
      set.add(waiter)
    })

    return {
      promise,
      cancel: () => {
        if (waiter) this.#removeAckWaiter(key, waiter)
      }
    }
  }

  #removeAckWaiter (key: string, waiter: AckWaiter): void {
    clearTimeout(waiter.timer)
    const set = this.#ackWaiters.get(key)
    if (!set) return
    set.delete(waiter)
    if (set.size === 0) this.#ackWaiters.delete(key)
  }

  #pruneExpired (): void {
    const now = Date.now()
    for (const [key, entry] of this.#pending) {
      if (entry.expiresAt <= now) this.#pending.delete(key)
    }
    for (const [key, expiresAt] of this.#seenDeliveries) {
      if (expiresAt <= now) this.#seenDeliveries.delete(key)
    }
    for (const [taskId, cancellation] of this.#cancellations) {
      if (cancellation.expiresAt <= now) this.#cancellations.delete(taskId)
    }
    this.#scheduleExpiry()
  }

  #scheduleExpiry (): void {
    if (this.#expiryTimer) clearTimeout(this.#expiryTimer)
    this.#expiryTimer = undefined

    const expiries = [
      ...[...this.#pending.values()].map(entry => entry.expiresAt),
      ...this.#seenDeliveries.values(),
      ...[...this.#cancellations.values()].map(cancellation => cancellation.expiresAt)
    ]
    if (expiries.length === 0) return

    this.#expiryTimer = setTimeout(() => {
      this.#expiryTimer = undefined
      this.#pruneExpired()
    }, Math.max(1, Math.min(...expiries) - Date.now()))
    this.#expiryTimer.unref()
  }

  #resolveWaiter (taskId: string, waiter: Waiter, responses: InputResponses): void {
    this.#removeWaiter(taskId, waiter)
    waiter.resolve(responses)
  }

  #rejectWaiter (taskId: string, waiter: Waiter, error: Error): void {
    this.#removeWaiter(taskId, waiter)
    waiter.reject(error)
  }

  #removeWaiter (taskId: string, waiter: Waiter): void {
    const set = this.#waiters.get(taskId)
    if (!set) return
    set.delete(waiter)
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort)
    if (set.size === 0) this.#waiters.delete(taskId)
  }

  #deliveryKey (taskId: string, deliveryId: string): string {
    return `${taskId}\u0000${deliveryId}`
  }

  #evictOldest<K, V> (map: Map<K, V>, maximum: number): void {
    while (map.size > maximum) {
      const oldest = map.keys().next().value as K | undefined
      if (oldest === undefined) break
      map.delete(oldest)
    }
  }
}
