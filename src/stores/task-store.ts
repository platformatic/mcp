import type { Task, TaskStatus, JSONRPCResultResponse, JSONRPCErrorResponse } from '../schema.ts'

/**
 * The final outcome of a task-augmented request, stored verbatim so that
 * `tasks/result` can return exactly what the underlying request would have
 * returned — success or JSON-RPC error.
 */
export type TaskOutcome = JSONRPCResultResponse | JSONRPCErrorResponse

export interface TaskRecord extends Task {
  /**
   * Authorization subject this task belongs to, when the deployment can identify
   * requestors. `tasks/get`, `tasks/result` and `tasks/cancel` must refuse tasks
   * belonging to a different context.
   */
  authSubject?: string
  /** The method of the request the task wraps, e.g. `tools/call` */
  method: string
  /** Terminal outcome, present once the task reaches completed/failed/cancelled */
  outcome?: TaskOutcome
  /**
   * Outstanding server-to-client requests while the task sits in
   * `input_required` (2026-07-28 tasks extension). Keys are unique for the
   * lifetime of the task, so a client can deduplicate across polls and the
   * server can ignore responses to keys it has already satisfied.
   */
  inputRequests?: Record<string, unknown>
  /** Keys that have already been answered, so replays can be ignored. */
  answeredInputKeys?: string[]
  /** Monotonic generation for input requests; incremented whenever a new round is issued. */
  inputRequestRound?: number
  /**
   * Accepted answers waiting for successful broker publication.
   *
   * This is a durable outbox: if publication fails, a retry can republish the
   * original values even though their keys are no longer outstanding.
   */
  pendingInputResponses?: Record<string, unknown>
  /** Stable per-key delivery ids used to deduplicate ambiguous broker retries. */
  pendingInputResponseIds?: Record<string, string>
  /** Input generation each pending response belongs to. */
  pendingInputResponseRounds?: Record<string, number>
  /**
   * Which protocol era created the task. The 2025-11-25 core tasks and the
   * 2026-07-28 extension have different shapes and lifecycles, so each era
   * only sees its own tasks. Absent on records written before this field.
   */
  era?: 'legacy' | 'modern'
  /**
   * Epoch ms until which the instance running the task is known to be alive.
   * The worker renews it while it runs; once it lapses, any instance may mark
   * the task failed, so a crashed worker cannot leave it non-terminal.
   */
  leaseExpiresAt?: number
}

/**
 * Which status transitions the spec permits. Terminal states are absent because
 * they can never transition again.
 */
const ALLOWED_TRANSITIONS: Record<string, TaskStatus[]> = {
  working: ['input_required', 'completed', 'failed', 'cancelled'],
  input_required: ['working', 'completed', 'failed', 'cancelled']
}

export const TERMINAL_STATUSES: TaskStatus[] = ['completed', 'failed', 'cancelled']

export function isTerminal (status: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status)
}

export function canTransition (from: TaskStatus, to: TaskStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false
}

/** Fields a status transition may set alongside the new status. */
export interface TaskUpdateOptions {
  /** A new status message, or `null` to clear a stale one. */
  statusMessage?: string | null
  outcome?: TaskOutcome
  /** Replaces the outstanding input requests; `null` clears them. */
  inputRequests?: Record<string, unknown> | null
  /** Keys to mark as answered, merged with those already recorded. */
  answeredInputKeys?: string[]
  /**
   * Forget which keys have been answered. Set when a new round of questions is
   * issued, so a key reused across rounds is not mistaken for one already
   * satisfied.
   */
  clearAnsweredInputKeys?: boolean
  /** Advance the input generation when a handler issues a new set of questions. */
  incrementInputRequestRound?: boolean
  /** Drop stale outbox entries when a task settles. */
  clearPendingInputResponses?: boolean
}

export interface TaskInputUpdate {
  task: TaskRecord
  /** Stored values that should be published for this update or retry. */
  responses: Record<string, unknown>
  /** Stable ids paired with each response key for broker deduplication. */
  responseIds: Record<string, string>
}

export interface TaskListOptions {
  /** Opaque cursor from a previous page's `nextCursor` */
  cursor?: string
  /** Maximum number of tasks to return, defaults to DEFAULT_TASK_PAGE_SIZE */
  limit?: number
  /** Only tasks created by this protocol era; records without one are legacy */
  era?: 'legacy' | 'modern'
}

/** Whether a task belongs to the era a listing asked for */
export function matchesTaskEra (task: TaskRecord, era: TaskListOptions['era']): boolean {
  return era === undefined || (task.era ?? 'legacy') === era
}

export interface TaskListPage {
  tasks: TaskRecord[]
  /** Present only when more tasks follow this page */
  nextCursor?: string
}

export const DEFAULT_TASK_PAGE_SIZE = 50

/** Thrown by `TaskStore.list` for a cursor it cannot decode */
export class InvalidTaskCursorError extends Error {
  constructor () {
    super('Invalid cursor')
    this.name = 'InvalidTaskCursorError'
  }
}

/**
 * Position of the last task on a page. Tasks are ordered by creation time then
 * task id, both descending, so a (time, id) pair is a stable keyset position
 * that survives tasks being created or deleted between pages.
 */
export interface TaskCursorPosition {
  createdAt: number
  taskId: string
}

export function encodeTaskCursor (task: TaskRecord): string {
  const position = { t: new Date(task.createdAt).getTime(), id: task.taskId }
  return Buffer.from(JSON.stringify(position)).toString('base64url')
}

export function decodeTaskCursor (cursor: unknown): TaskCursorPosition {
  if (typeof cursor !== 'string') throw new InvalidTaskCursorError()
  let position: any
  try {
    position = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw new InvalidTaskCursorError()
  }
  if (
    position === null ||
    typeof position !== 'object' ||
    !Number.isFinite(position.t) ||
    typeof position.id !== 'string' ||
    position.id.length === 0
  ) {
    throw new InvalidTaskCursorError()
  }
  return { createdAt: position.t, taskId: position.id }
}

/** Whether a task sorts strictly after the cursor position (newest first) */
export function isAfterTaskCursor (createdAt: number, taskId: string, position: TaskCursorPosition): boolean {
  if (createdAt !== position.createdAt) return createdAt < position.createdAt
  return taskId < position.taskId
}

export function taskPageLimit (limit: number | undefined): number {
  if (limit === undefined || !Number.isInteger(limit) || limit < 1) return DEFAULT_TASK_PAGE_SIZE
  return limit
}

export interface TaskStore {
  create(task: TaskRecord): Promise<void>
  get(taskId: string): Promise<TaskRecord | null>
  /**
   * Move a task to a new status, rejecting transitions the spec forbids.
   * Returns the updated record, or null if the task is gone.
   * @throws if the transition is not allowed
   */
  updateStatus(taskId: string, status: TaskStatus, options?: TaskUpdateOptions): Promise<TaskRecord | null>
  /**
   * Atomically accept outstanding input and stage it for broker publication.
   * A retry of a staged key returns the original stored value. When `round`
   * is given and the task has since moved to another input round, no new
   * input is accepted.
   */
  updateInputResponses(
    taskId: string,
    responses: Record<string, unknown>,
    responseId: string,
    round?: number
  ): Promise<TaskInputUpdate | null>
  /**
   * Remove delivered values from the outbox only when their stable delivery ids
   * still match, so delayed publication completion cannot delete a later round.
   */
  acknowledgeInputResponses(taskId: string, responseIds: Record<string, string>): Promise<void>
  /**
   * Extend the running worker's lease to `leaseMs` from now, by the store's
   * clock. Returns the task's current status, so a worker whose cancellation
   * was lost in transit still learns it ended, or null if the task is gone.
   */
  renewLease(taskId: string, leaseMs: number): Promise<TaskStatus | null>
  /**
   * Atomically fail a non-terminal task whose lease has lapsed by the store's
   * clock, recording `outcome`. Returns the failed record, or null when the
   * task is gone, terminal, unleased, or its lease is still live.
   */
  expireStaleLease(taskId: string, statusMessage: string, outcome: TaskOutcome): Promise<TaskRecord | null>
  /**
   * One page of the tasks visible to the given authorization subject, newest
   * first. Pass the previous page's `nextCursor` to continue.
   * @throws InvalidTaskCursorError if `cursor` was not issued by this store
   */
  list(authSubject?: string, options?: TaskListOptions): Promise<TaskListPage>
  delete(taskId: string): Promise<void>
  /** Drop tasks whose ttl has elapsed */
  cleanup(): Promise<void>
  close?(): Promise<void>
}

/**
 * Wake anyone blocked in `tasks/result` when a task reaches a terminal state.
 * Kept separate from the store so both backends can share it: the waiters only
 * ever live in the process handling that particular `tasks/result` request.
 */
export class TaskWaiters {
  private waiters = new Map<string, Set<(task: TaskRecord) => void>>()

  wait (taskId: string, signal?: AbortSignal): Promise<TaskRecord> {
    return new Promise((resolve, reject) => {
      const resolveAndCleanup = (task: TaskRecord) => {
        this.remove(taskId, resolveAndCleanup)
        resolve(task)
      }

      let set = this.waiters.get(taskId)
      if (!set) {
        set = new Set()
        this.waiters.set(taskId, set)
      }
      set.add(resolveAndCleanup)

      signal?.addEventListener('abort', () => {
        this.remove(taskId, resolveAndCleanup)
        reject(new Error('aborted'))
      }, { once: true })
    })
  }

  notify (task: TaskRecord): void {
    const set = this.waiters.get(task.taskId)
    if (!set) return
    for (const waiter of [...set]) {
      waiter(task)
    }
  }

  private remove (taskId: string, waiter: (task: TaskRecord) => void): void {
    const set = this.waiters.get(taskId)
    if (!set) return
    set.delete(waiter)
    if (set.size === 0) {
      this.waiters.delete(taskId)
    }
  }
}

/**
 * Fold the input-request fields of an update into a record, in place.
 *
 * Shared by both backends so `input_required` bookkeeping cannot drift between
 * them: answered keys accumulate (never shrink) and clearing is explicit.
 */
export function applyInputRequestUpdates (task: TaskRecord, options: TaskUpdateOptions): void {
  if (options.inputRequests === null) {
    delete task.inputRequests
  } else if (options.inputRequests !== undefined) {
    task.inputRequests = options.inputRequests
  }

  if (options.clearAnsweredInputKeys) {
    delete task.answeredInputKeys
  }

  if (options.incrementInputRequestRound) {
    task.inputRequestRound = (task.inputRequestRound ?? 0) + 1
  }

  if (options.clearPendingInputResponses) {
    delete task.pendingInputResponses
    delete task.pendingInputResponseIds
    delete task.pendingInputResponseRounds
  }

  if (options.answeredInputKeys?.length) {
    task.answeredInputKeys = [...new Set([...(task.answeredInputKeys ?? []), ...options.answeredInputKeys])]
  }
}

export function taskHasExpired (task: TaskRecord, now: number = Date.now()): boolean {
  if (task.ttl === null || task.ttl === undefined) return false
  return now - new Date(task.createdAt).getTime() > task.ttl
}

/**
 * The 2025-11-25 `Task` for a record. Built from the spec's fields rather than
 * by stripping storage ones, so a field added to the record for another reason
 * (the era, the lease, the input bookkeeping) never leaks onto the wire.
 */
export function toWireTask (task: TaskRecord): Task {
  return {
    taskId: task.taskId,
    status: task.status,
    ...(task.statusMessage !== undefined ? { statusMessage: task.statusMessage } : {}),
    createdAt: task.createdAt,
    lastUpdatedAt: task.lastUpdatedAt,
    ttl: task.ttl,
    ...(task.pollInterval !== undefined ? { pollInterval: task.pollInterval } : {})
  }
}
