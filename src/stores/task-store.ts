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
   * Epoch milliseconds at which the instance running the task loses its claim
   * on it unless it renews the lease first. Absent for tasks with no lease.
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

export interface TaskListOptions {
  /** Opaque cursor from a previous page's `nextCursor` */
  cursor?: string
  /** Maximum number of tasks to return, defaults to DEFAULT_TASK_PAGE_SIZE */
  limit?: number
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

/** Tasks one principal may keep stored, finished ones included, by default */
export const DEFAULT_TASK_MAX_PER_PRINCIPAL = 100

/**
 * JSON-RPC error code returned when a task cannot be created because the
 * caller (or the store) is at capacity and holds no finished task to evict.
 * Implementation-defined, in the -32000..-32099 server error range.
 */
export const TASK_LIMIT_REACHED = -32029

/**
 * Thrown by `TaskStore.create` when the store is at capacity and no finished
 * task can be evicted to make room.
 */
export class TaskLimitError extends Error {
  readonly limit: number

  constructor (limit: number) {
    super(`Task limit reached (${limit})`)
    this.name = 'TaskLimitError'
    this.limit = limit
  }
}

export function validateTaskLimit (name: string, value: unknown): void {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new TypeError(`${name} must be a positive integer`)
  }
}

export interface TaskStore {
  /**
   * Store a new task. Every principal (and the anonymous caller) has a cap on
   * the tasks it keeps stored, finished ones included; at the cap, its oldest
   * finished task is evicted to make room.
   * @throws TaskLimitError if at capacity with no finished task to evict
   */
  create(task: TaskRecord): Promise<void>
  get(taskId: string): Promise<TaskRecord | null>
  /**
   * Move a task to a new status, rejecting transitions the spec forbids.
   * Returns the updated record, or null if the task is gone.
   * @throws if the transition is not allowed
   */
  updateStatus(taskId: string, status: TaskStatus, options?: { statusMessage?: string, outcome?: TaskOutcome }): Promise<TaskRecord | null>
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
  /**
   * Extend the lease of a non-terminal task to `leaseMs` from now. Returns false
   * when the task is gone or already terminal, so the owner can stop renewing.
   */
  renewLease?(taskId: string, leaseMs: number): Promise<boolean>
  /**
   * Atomically move a non-terminal task whose lease has lapsed to `failed`. A
   * task with a live (or no) lease is left untouched. Returns the task as it now
   * stands, or null if it is gone. The store's clock (the one renewLease uses)
   * is authoritative: callers never pre-check the lease against their own clock.
   */
  failExpiredLease?(taskId: string, options: { statusMessage: string, outcome: TaskOutcome }): Promise<TaskRecord | null>
}

/**
 * Keeps the leases of the tasks this instance is running alive. If the instance
 * dies (or closes) the renewals stop, the lease lapses, and whichever instance
 * next reads the task marks it failed instead of reporting `working` until the
 * task's ttl runs out.
 */
export class TaskLeases {
  private timers = new Map<string, ReturnType<typeof setInterval>>()
  private closed = false
  private readonly store: TaskStore
  readonly leaseMs: number
  private readonly onError?: (error: unknown, taskId: string) => void

  constructor (store: TaskStore, leaseMs: number, onError?: (error: unknown, taskId: string) => void) {
    this.store = store
    this.leaseMs = leaseMs
    this.onError = onError
  }

  /** Take the lease on a freshly created task and keep renewing it until `stop()` */
  async start (taskId: string): Promise<void> {
    // A store must support both halves; a lease nobody can reap is pointless,
    // and one nobody renews would fail live tasks.
    const { store } = this
    if (this.closed || !store.renewLease || !store.failExpiredLease) return

    await store.renewLease(taskId, this.leaseMs)
    if (this.closed) return

    const timer = setInterval(() => {
      store.renewLease!(taskId, this.leaseMs).then((renewed) => {
        if (!renewed) this.stop(taskId)
      }, (error) => {
        this.onError?.(error, taskId)
      })
    }, Math.max(1, Math.floor(this.leaseMs / 3)))
    timer.unref()
    this.timers.set(taskId, timer)
  }

  stop (taskId: string): void {
    const timer = this.timers.get(taskId)
    if (timer) {
      clearInterval(timer)
      this.timers.delete(taskId)
    }
  }

  /** Stop renewing everything, e.g. when the server shuts down */
  close (): void {
    this.closed = true
    for (const timer of this.timers.values()) {
      clearInterval(timer)
    }
    this.timers.clear()
  }
}

/**
 * Whether a task's lease has lapsed, so its owner is presumed dead. Only valid
 * where `now` comes from the same clock that set the lease (MemoryTaskStore).
 */
export function taskLeaseExpired (task: TaskRecord, now: number = Date.now()): boolean {
  return !isTerminal(task.status) && typeof task.leaseExpiresAt === 'number' && task.leaseExpiresAt <= now
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

export function taskHasExpired (task: TaskRecord, now: number = Date.now()): boolean {
  if (task.ttl === null || task.ttl === undefined) return false
  return now - new Date(task.createdAt).getTime() > task.ttl
}

/**
 * Strip storage-only fields so a record can go on the wire as a spec `Task`.
 */
export function toWireTask (task: TaskRecord): Task {
  const { authSubject, method, outcome, leaseExpiresAt, ...wire } = task
  return wire
}
