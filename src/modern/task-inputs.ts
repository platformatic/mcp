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

/** Broker topic carrying `tasks/update` answers between instances. */
export const TASK_INPUT_TOPIC = 'mcp/tasks/input'

type Waiter = (responses: InputResponses) => void
type Publisher = (taskId: string, responses: Record<string, unknown>) => Promise<void>

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
  #publish?: Publisher

  /**
   * How long an unclaimed answer is held.
   *
   * Every instance sees every broadcast, so all but one of them buffer answers
   * for a task they are not running. Without an expiry those entries would
   * accumulate for the life of the process.
   */
  readonly #pendingTtlMs: number

  constructor (pendingTtlMs: number = 60_000) {
    this.#pendingTtlMs = pendingTtlMs
  }

  /** Wire up cross-instance delivery. Called once, at plugin registration. */
  setPublisher (publish: Publisher): void {
    this.#publish = publish
  }

  /**
   * Announce answers to whichever instance is running the task.
   *
   * Falls back to local delivery when no publisher is configured, so the
   * channel still works standalone (and in unit tests).
   */
  async publish (taskId: string, responses: Record<string, unknown>): Promise<void> {
    if (!this.#publish) {
      this.deliver(taskId, responses)
      return
    }
    await this.#publish(taskId, responses)
  }

  /**
   * Wait for the client to answer at least one outstanding input request.
   *
   * Resolves with whatever arrived; a caller expecting several keys should keep
   * waiting until it has them all.
   */
  wait (taskId: string, signal?: AbortSignal): Promise<InputResponses> {
    // Something answered before we got here — take it rather than block.
    const early = this.#pending.get(taskId)
    if (early) {
      this.#pending.delete(taskId)
      if (early.expiresAt > Date.now()) {
        return Promise.resolve(early.responses)
      }
    }

    return new Promise((resolve, reject) => {
      const settle = (responses: InputResponses) => {
        this.#remove(taskId, settle)
        resolve(responses)
      }

      let set = this.#waiters.get(taskId)
      if (!set) {
        set = new Set()
        this.#waiters.set(taskId, set)
      }
      set.add(settle)

      signal?.addEventListener('abort', () => {
        this.#remove(taskId, settle)
        reject(new Error('aborted'))
      }, { once: true })
    })
  }

  /** Hand responses to anyone waiting on this task in this process. */
  deliver (taskId: string, responses: Record<string, unknown>): void {
    const set = this.#waiters.get(taskId)
    if (!set || set.size === 0) {
      // Nobody here is waiting. Either the task runs on another instance — in
      // which case this is correctly a no-op — or it has not parked yet, so
      // hold the answers for the wait that is about to happen.
      this.#prunePending()
      const held = this.#pending.get(taskId)?.responses ?? {}
      this.#pending.set(taskId, {
        responses: { ...held, ...(responses as InputResponses) },
        expiresAt: Date.now() + this.#pendingTtlMs
      })
      return
    }

    for (const waiter of [...set]) {
      waiter(responses as InputResponses)
    }
  }

  /** Drop anything held for a task that has finished or been cancelled. */
  forget (taskId: string): void {
    this.#pending.delete(taskId)
    this.#waiters.delete(taskId)
  }

  #prunePending (): void {
    const now = Date.now()
    for (const [taskId, entry] of this.#pending) {
      if (entry.expiresAt <= now) this.#pending.delete(taskId)
    }
  }

  #remove (taskId: string, waiter: Waiter): void {
    const set = this.#waiters.get(taskId)
    if (!set) return
    set.delete(waiter)
    if (set.size === 0) this.#waiters.delete(taskId)
  }
}
