/**
 * Cross-instance delivery of `tasks/update` input responses.
 *
 * The message-broker contract treats a resolved publication as confirmation
 * that the intended consumer accepted delivery. The task store keeps each
 * response in a durable outbox until publication resolves, so failures remain
 * safely retryable without acknowledging queued work early.
 */

import type { InputResponses } from '../schema-2026.ts'

export const TASK_INPUT_TOPIC = 'mcp/tasks/input'
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

type Publisher = (taskId: string, responses: Record<string, unknown>, deliveryId: string) => Promise<void>
type CancellationPublisher = (taskId: string) => Promise<void>

const DEFAULT_RETENTION_MS = 3_600_000
const DEFAULT_MAX_PENDING = 1000

export class TaskInputChannel {
  #waiters = new Map<string, Set<Waiter>>()
  #pending = new Map<string, PendingDelivery>()
  #seenDeliveries = new Map<string, number>()
  #cancellations = new Map<string, { expiresAt: number }>()
  #publish?: Publisher
  #publishCancellation?: CancellationPublisher
  #expiryTimer?: NodeJS.Timeout
  #closed = false

  readonly #retentionMs: number
  readonly #maxPending: number
  readonly #maxSeenDeliveries: number
  readonly #maxCancellations: number

  constructor (
    retentionMs: number = DEFAULT_RETENTION_MS,
    maxPending: number = DEFAULT_MAX_PENDING
  ) {
    this.#retentionMs = Math.max(1, retentionMs)
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

  setCancellationPublisher (publish: CancellationPublisher): void {
    this.#publishCancellation = publish
  }

  /** Publish responses; resolution is the broker's delivery confirmation. */
  async publish (
    taskId: string,
    responses: Record<string, unknown>,
    deliveryId: string
  ): Promise<void> {
    if (this.#closed) throw new Error('channel closed')

    if (this.#publish) {
      await this.#publish(taskId, responses, deliveryId)
    } else {
      this.deliver(taskId, responses, deliveryId)
    }
  }

  /** Publish cancellation and wait for the broker to confirm acceptance. */
  async cancel (taskId: string): Promise<void> {
    if (this.#publishCancellation) {
      await this.#publishCancellation(taskId)
    } else {
      this.abort(taskId, 'cancelled')
    }
  }

  wait (taskId: string, signal?: AbortSignal): Promise<InputResponses> {
    if (this.#closed) return Promise.reject(new Error('channel closed'))
    this.#pruneExpired()

    if (this.#cancellations.has(taskId)) {
      return Promise.reject(new Error('task cancelled'))
    }

    const early = [...this.#pending.entries()].filter(([, entry]) => entry.taskId === taskId)
    if (early.length > 0) {
      const responses: InputResponses = {}
      for (const [key, entry] of early) {
        this.#pending.delete(key)
        Object.assign(responses, entry.responses)
        this.#markConsumed(entry.taskId, entry.deliveryId)
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
      if (this.#cancellations.has(taskId)) {
        this.#rejectWaiter(taskId, waiter, new Error('task cancelled'))
      }
    })
  }

  deliver (taskId: string, responses: Record<string, unknown>, deliveryId?: string): void {
    if (this.#closed) return
    this.#pruneExpired()

    const id = deliveryId ?? `local-${taskId}`
    const deliveryKey = this.#deliveryKey(taskId, id)

    // An ambiguous publication retry must never reach a later input round.
    if (this.#seenDeliveries.has(deliveryKey)) return

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
  }

  /** Reject current and future waits for a recently cancelled task. */
  abort (taskId: string, reason: string = 'cancelled'): void {
    const cancellation = {
      expiresAt: Date.now() + this.#retentionMs
    }
    this.#cancellations.delete(taskId)
    this.#cancellations.set(taskId, cancellation)
    this.#evictOldest(this.#cancellations, this.#maxCancellations)

    for (const [key, entry] of this.#pending) {
      if (entry.taskId === taskId) this.#pending.delete(key)
    }

    const set = this.#waiters.get(taskId)
    if (set && set.size > 0) {
      for (const waiter of [...set]) {
        this.#rejectWaiter(taskId, waiter, new Error(reason))
      }
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
  }

  #markConsumed (taskId: string, deliveryId: string): void {
    const key = this.#deliveryKey(taskId, deliveryId)
    this.#seenDeliveries.delete(key)
    this.#seenDeliveries.set(key, Date.now() + this.#retentionMs)
    this.#evictOldest(this.#seenDeliveries, this.#maxSeenDeliveries)
    this.#scheduleExpiry()
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
