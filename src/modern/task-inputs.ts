/**
 * Delivery of `tasks/update` input responses to the code waiting for them.
 *
 * A task that needs something from the client parks until the client answers,
 * and the answer arrives on a *different* request — which, behind a load
 * balancer, lands on an arbitrary instance. The waiter only exists in the
 * process actually running the task, so a purely process-local channel would
 * silently drop every answer that arrived anywhere else.
 *
 * So `publish` fans the answers out over the message broker and `deliver` is
 * what the broker subscription calls on each instance: a no-op everywhere
 * except the one holding the waiter.
 */

import type { InputResponses } from '../schema-2026.ts'

/** Broker topics carrying task answers and cancellation between instances. */
export const TASK_INPUT_TOPIC = 'mcp/tasks/input'
export const TASK_INPUT_CANCEL_TOPIC = 'mcp/tasks/input/cancel'

interface Waiter {
  resolve: (responses: InputResponses) => void
  reject: (error: Error) => void
  signal?: AbortSignal
  onAbort?: () => void
}

type Publisher = (taskId: string, responses: Record<string, unknown>, deliveryId: string) => Promise<void>
type CancellationPublisher = (taskId: string) => Promise<void>

export class TaskInputChannel {
  #waiters = new Map<string, Set<Waiter>>()
  /**
   * Answers that arrived before anyone was waiting for them.
   *
   * The store write in `tasks/update` and the `wait()` in the running task are
   * separate async chains, so the answer genuinely can land first. Holding it
   * here means a task parks and resumes immediately rather than blocking until
   * its ttl elapses.
   */
  #pending = new Map<string, { responses: InputResponses, expiresAt: number }>()
  /** Recently received delivery ids, retained so ambiguous retries are harmless. */
  #seenDeliveries = new Map<string, number>()
  #publish?: Publisher
  #publishCancellation?: CancellationPublisher
  #pendingTimer?: NodeJS.Timeout
  #closed = false

  /** How long an unclaimed answer is held. */
  readonly #pendingTtlMs: number
  /** Hard bound for bursts received by replicas that do not own the task. */
  readonly #maxPending: number
  readonly #maxSeenDeliveries: number

  constructor (pendingTtlMs: number = 60_000, maxPending: number = 1000) {
    this.#pendingTtlMs = Math.max(1, pendingTtlMs)
    this.#maxPending = Math.max(1, maxPending)
    this.#maxSeenDeliveries = this.#maxPending * 4
  }

  /** Exposed for lifecycle assertions and operational diagnostics. */
  get pendingSize (): number {
    return this.#pending.size
  }

  get waiterCount (): number {
    let count = 0
    for (const waiters of this.#waiters.values()) count += waiters.size
    return count
  }

  /** Wire up cross-instance delivery. Called once, at plugin registration. */
  setPublisher (publish: Publisher): void {
    this.#publish = publish
  }

  /** Wire up cross-instance cancellation. Called once, at registration. */
  setCancellationPublisher (publish: CancellationPublisher): void {
    this.#publishCancellation = publish
  }

  /** Announce answers to whichever instance is running the task. */
  async publish (
    taskId: string,
    responses: Record<string, unknown>,
    deliveryId: string
  ): Promise<void> {
    if (!this.#publish) {
      this.deliver(taskId, responses, deliveryId)
      return
    }
    await this.#publish(taskId, responses, deliveryId)
  }

  /** Announce cancellation so the owning instance releases its waiter. */
  async cancel (taskId: string): Promise<void> {
    if (!this.#publishCancellation) {
      this.abort(taskId, 'cancelled')
      return
    }
    await this.#publishCancellation(taskId)
  }

  /**
   * Wait for the client to answer at least one outstanding input request.
   *
   * Resolves with whatever arrived; a caller expecting several keys should keep
   * waiting until it has them all.
   */
  wait (taskId: string, signal?: AbortSignal): Promise<InputResponses> {
    if (this.#closed) return Promise.reject(new Error('channel closed'))

    // Something answered before we got here — take it rather than block.
    const early = this.#pending.get(taskId)
    if (early) {
      this.#pending.delete(taskId)
      this.#schedulePendingPrune()
      if (early.expiresAt > Date.now()) {
        return Promise.resolve(early.responses)
      }
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
    })
  }

  /** Hand responses to anyone waiting on this task in this process. */
  deliver (taskId: string, responses: Record<string, unknown>, deliveryId?: string): void {
    if (this.#closed) return

    this.#pruneExpired()
    if (deliveryId) {
      const seenKey = `${taskId}\u0000${deliveryId}`
      if (this.#seenDeliveries.has(seenKey)) return
      this.#seenDeliveries.set(seenKey, Date.now() + this.#pendingTtlMs)
      while (this.#seenDeliveries.size > this.#maxSeenDeliveries) {
        const oldest = this.#seenDeliveries.keys().next().value as string | undefined
        if (oldest === undefined) break
        this.#seenDeliveries.delete(oldest)
      }
      this.#schedulePendingPrune()
    }

    const set = this.#waiters.get(taskId)
    if (!set || set.size === 0) {
      // Nobody here is waiting. Either the task runs on another instance — in
      // which case this is correctly a bounded, expiring no-op — or it has not
      // parked yet, so hold the answers for the wait that is about to happen.
      const held = this.#pending.get(taskId)?.responses ?? {}
      this.#pending.delete(taskId)
      this.#pending.set(taskId, {
        responses: { ...held, ...(responses as InputResponses) },
        expiresAt: Date.now() + this.#pendingTtlMs
      })

      while (this.#pending.size > this.#maxPending) {
        const oldest = this.#pending.keys().next().value as string | undefined
        if (oldest === undefined) break
        this.#pending.delete(oldest)
      }
      this.#schedulePendingPrune()
      return
    }

    for (const waiter of [...set]) {
      this.#resolveWaiter(taskId, waiter, responses as InputResponses)
    }
  }

  /** Reject local waiters and discard early answers for a cancelled task. */
  abort (taskId: string, reason: string = 'cancelled'): void {
    this.#pending.delete(taskId)
    const set = this.#waiters.get(taskId)
    if (set) {
      for (const waiter of [...set]) {
        this.#rejectWaiter(taskId, waiter, new Error(reason))
      }
    }
    this.#schedulePendingPrune()
  }

  /** Drop anything held for a task that has finished. */
  forget (taskId: string): void {
    this.abort(taskId, 'task finished')
  }

  /** Release timers and waiters during application shutdown. */
  close (): void {
    this.#closed = true
    if (this.#pendingTimer) clearTimeout(this.#pendingTimer)
    this.#pendingTimer = undefined
    this.#pending.clear()
    this.#seenDeliveries.clear()
    for (const taskId of [...this.#waiters.keys()]) {
      this.abort(taskId, 'channel closed')
    }
  }

  #pruneExpired (): void {
    const now = Date.now()
    for (const [taskId, entry] of this.#pending) {
      if (entry.expiresAt <= now) this.#pending.delete(taskId)
    }
    for (const [deliveryId, expiresAt] of this.#seenDeliveries) {
      if (expiresAt <= now) this.#seenDeliveries.delete(deliveryId)
    }
    this.#schedulePendingPrune()
  }

  #schedulePendingPrune (): void {
    if (this.#pendingTimer) clearTimeout(this.#pendingTimer)
    this.#pendingTimer = undefined
    if (this.#pending.size === 0 && this.#seenDeliveries.size === 0) return

    let earliest = Infinity
    for (const entry of this.#pending.values()) {
      earliest = Math.min(earliest, entry.expiresAt)
    }
    for (const expiresAt of this.#seenDeliveries.values()) {
      earliest = Math.min(earliest, expiresAt)
    }

    this.#pendingTimer = setTimeout(() => {
      this.#pendingTimer = undefined
      this.#pruneExpired()
    }, Math.max(1, earliest - Date.now()))
    this.#pendingTimer.unref()
  }

  #resolveWaiter (taskId: string, waiter: Waiter, responses: InputResponses): void {
    this.#remove(taskId, waiter)
    waiter.resolve(responses)
  }

  #rejectWaiter (taskId: string, waiter: Waiter, error: Error): void {
    this.#remove(taskId, waiter)
    waiter.reject(error)
  }

  #remove (taskId: string, waiter: Waiter): void {
    const set = this.#waiters.get(taskId)
    if (!set) return
    set.delete(waiter)
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort)
    }
    if (set.size === 0) this.#waiters.delete(taskId)
  }
}
