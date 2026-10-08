/**
 * The tasks one plugin instance is running in the background, for both the
 * 2025-11-25 core tasks and the 2026-07-28 extension: the limits on how many
 * may run, and the shutdown drain that records the ones still running.
 */

import type { AuthorizationContext } from './types/auth-types.ts'
import type { MCPPluginOptions } from './types.ts'
import type { TaskOutcome, TaskStore } from './stores/task-store.ts'
import { JSONRPC_VERSION, INTERNAL_ERROR } from './schema.ts'

const DEFAULT_TASK_MAX_CONCURRENT = 1000
const DEFAULT_TASK_MAX_PER_PRINCIPAL = 100
const TASK_SHUTDOWN_GRACE_MS = 1000
const SHUTTING_DOWN = 'The server shut down before this task finished'
const SHUTDOWN_OUTCOME: TaskOutcome = {
  jsonrpc: JSONRPC_VERSION,
  error: { code: INTERNAL_ERROR, message: SHUTTING_DOWN }
}

/** Node's timers cap at 2^31-1 ms; longer delays fire after 1ms instead. */
export const MAX_TIMER_MS = 2 ** 31 - 1

/** Why a running task was stopped, recorded as its failure. */
export class TaskStopped extends Error {}

export interface LiveTask {
  /** Whose allowance the task counts against; absent for unidentified callers. */
  quotaKey?: string
  stop: (reason: TaskStopped) => void
  done: Promise<void>
}

interface TaskRegistry {
  live: Map<string, LiveTask>
  closing: boolean
}

const registries = new WeakMap<object, TaskRegistry>()

function registryFor (store: object): TaskRegistry {
  let registry = registries.get(store)
  if (!registry) {
    registry = { live: new Map(), closing: false }
    registries.set(store, registry)
  }
  return registry
}

/**
 * Who a task counts against: the user at their issuer, whichever OAuth client
 * they come through, so registering more clients does not raise the limit.
 * Undefined for callers the deployment cannot identify, who are bounded by
 * the global limit only: sharing one allowance would let any of them lock
 * out all the others.
 */
export function quotaKeyOf (authContext: AuthorizationContext | undefined): string | undefined {
  if (authContext?.userId === undefined) return undefined
  return JSON.stringify([authContext.userId, authContext.authorizationServer ?? null])
}

/**
 * Reserve a slot for a new task, or say why there is none. Reservation is
 * synchronous, so concurrent requests cannot all pass the check before any of
 * them is counted. `release()` gives the slot back.
 */
export function reserveTask (
  store: TaskStore,
  taskId: string,
  quotaKey: string | undefined,
  opts: MCPPluginOptions
): { ok: true, live: LiveTask, release: () => void } | { ok: false, reason: string } {
  const registry = registryFor(store)
  if (registry.closing) return { ok: false, reason: 'The server is shutting down' }

  const maxConcurrent = opts.taskMaxConcurrent ?? DEFAULT_TASK_MAX_CONCURRENT
  if (registry.live.size >= maxConcurrent) return { ok: false, reason: 'Task limit reached' }

  if (quotaKey !== undefined) {
    const maxPerPrincipal = opts.taskMaxPerPrincipal ?? DEFAULT_TASK_MAX_PER_PRINCIPAL
    let mine = 0
    for (const task of registry.live.values()) if (task.quotaKey === quotaKey) mine++
    if (mine >= maxPerPrincipal) return { ok: false, reason: 'Per-caller task limit reached' }
  }

  const live: LiveTask = { quotaKey, stop: () => {}, done: Promise.resolve() }
  registry.live.set(taskId, live)
  return {
    ok: true,
    live,
    release: () => {
      if (registry.live.get(taskId) === live) registry.live.delete(taskId)
    }
  }
}

export function sleep (ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms).unref())
}

/**
 * Stop taking new tasks and let running ones finish, for up to `timeoutMs`.
 * Whatever is still running then is aborted through its signal and recorded
 * as failed, so a restart never leaves a task `working` until its ttl.
 */
export async function drainTasks (store: TaskStore, timeoutMs: number): Promise<void> {
  const registry = registries.get(store)
  if (!registry) return
  registry.closing = true

  const running = () => [...registry.live.values()]
  await Promise.race([Promise.allSettled(running().map(task => task.done)), sleep(timeoutMs)])

  const remaining = [...registry.live.values()]
  for (const task of remaining) task.stop(new TaskStopped(SHUTTING_DOWN))
  await Promise.race([Promise.allSettled(remaining.map(task => task.done)), sleep(TASK_SHUTDOWN_GRACE_MS)])

  // A handler that ignores its signal is still running; record the outcome for it.
  for (const taskId of registry.live.keys()) {
    try {
      await store.updateStatus(taskId, 'failed', {
        statusMessage: SHUTTING_DOWN,
        outcome: SHUTDOWN_OUTCOME,
        inputRequests: null,
        clearPendingInputResponses: true
      })
    } catch {
      // already terminal
    }
  }
}
