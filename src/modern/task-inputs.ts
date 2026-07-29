/**
 * Delivery of `tasks/update` input responses to the code waiting for them.
 *
 * A task that needs something from the client parks until the client answers
 * on a *different* request. The waiter only exists in the process actually
 * running the task, so this channel is deliberately process-local: a
 * `tasks/update` that lands on another instance updates the store, and the
 * running instance picks the responses up when it next reads the record.
 */

import type { InputResponses } from '../schema-2026.ts'

type Waiter = (responses: InputResponses) => void

export class TaskInputChannel {
  #waiters = new Map<string, Set<Waiter>>()

  /**
   * Wait for the client to answer at least one outstanding input request.
   *
   * Resolves with whatever arrived; a caller expecting several keys should keep
   * waiting until it has them all.
   */
  wait (taskId: string, signal?: AbortSignal): Promise<InputResponses> {
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
    if (!set) return
    for (const waiter of [...set]) {
      waiter(responses as InputResponses)
    }
  }

  #remove (taskId: string, waiter: Waiter): void {
    const set = this.#waiters.get(taskId)
    if (!set) return
    set.delete(waiter)
    if (set.size === 0) this.#waiters.delete(taskId)
  }
}
