import type { TaskStatus } from '../schema.ts'
import type { TaskStore, TaskRecord, TaskOutcome, TaskListOptions, TaskListPage, TaskOwner } from './task-store.ts'
import {
  DEFAULT_TASK_MAX_ANONYMOUS,
  DEFAULT_TASK_MAX_PER_PRINCIPAL,
  TaskLimitError,
  TASK_OWNER_LOST,
  canTransition,
  decodeTaskCursor,
  encodeTaskCursor,
  isAfterTaskCursor,
  isAnonymousOwner,
  isTaskOwner,
  isTerminal,
  ownerLostOutcome,
  taskHasExpired,
  taskLeaseExpired,
  taskPageLimit,
  validateTaskLimit
} from './task-store.ts'

/**
 * In-process task store for single-instance deployments.
 *
 * Expired tasks are treated as absent on read and swept lazily, so a task never
 * outlives its ttl even if `cleanup()` has not run recently.
 */
export class MemoryTaskStore implements TaskStore {
  // Insertion order is creation order, so iteration visits the oldest first
  private tasks = new Map<string, TaskRecord>()
  private readonly maxTasks: number
  private readonly maxTasksPerPrincipal: number
  private readonly maxAnonymousTasks: number

  constructor (options: number | { maxTasks?: number, maxTasksPerPrincipal?: number, maxAnonymousTasks?: number } = {}) {
    const opts = typeof options === 'number' ? { maxTasks: options } : options
    this.maxTasks = opts.maxTasks ?? 1000
    this.maxTasksPerPrincipal = opts.maxTasksPerPrincipal ?? DEFAULT_TASK_MAX_PER_PRINCIPAL
    this.maxAnonymousTasks = opts.maxAnonymousTasks ?? DEFAULT_TASK_MAX_ANONYMOUS
    validateTaskLimit('maxTasks', this.maxTasks)
    validateTaskLimit('maxTasksPerPrincipal', this.maxTasksPerPrincipal)
    validateTaskLimit('maxAnonymousTasks', this.maxAnonymousTasks)
  }

  async create (task: TaskRecord): Promise<void> {
    // No await until the task is stored, so concurrent creates cannot both
    // pass the capacity checks and overshoot them.
    const owner = { subject: task.authSubject, issuer: task.authIssuer }
    const ownedBy = (t: TaskRecord) => isTaskOwner(t, owner)
    // Anonymous callers cannot be told apart, so the per-principal cap would be
    // one allowance shared by all of them (#320); bound them as a whole instead.
    const cap = isAnonymousOwner(owner) ? this.maxAnonymousTasks : this.maxTasksPerPrincipal

    // Finished tasks count too: otherwise one caller could hold every slot
    // with results it never collects until their ttl runs out.
    if (this.count(ownedBy) >= cap) {
      this.sweepExpired()
      this.failLapsedLeases(ownedBy)
      if (this.count(ownedBy) >= cap && !this.evictOldestFinished(ownedBy)) {
        throw new TaskLimitError(cap)
      }
    }

    if (this.tasks.size >= this.maxTasks) {
      this.sweepExpired()
      this.failLapsedLeases(() => true)
      // Prefer the caller's own finished work; failing that, the oldest
      // finished task of anyone, as stale results matter less than new work.
      if (
        this.tasks.size >= this.maxTasks &&
        !this.evictOldestFinished(ownedBy) &&
        !this.evictOldestFinished(() => true)
      ) {
        throw new TaskLimitError(this.maxTasks)
      }
    }

    this.tasks.set(task.taskId, { ...task })
  }

  private count (predicate: (task: TaskRecord) => boolean): number {
    let n = 0
    for (const task of this.tasks.values()) {
      if (predicate(task)) n++
    }
    return n
  }

  private evictOldestFinished (predicate: (task: TaskRecord) => boolean): boolean {
    for (const [taskId, task] of this.tasks) {
      if (isTerminal(task.status) && predicate(task)) {
        this.tasks.delete(taskId)
        return true
      }
    }
    return false
  }

  /**
   * Fail the tasks whose running instance stopped renewing their lease, so they
   * can be evicted like any finished task. Otherwise an orphan nobody polls
   * would hold a slot until its ttl runs out.
   */
  private failLapsedLeases (predicate: (task: TaskRecord) => boolean): void {
    const now = Date.now()
    for (const [taskId, task] of this.tasks) {
      if (predicate(task) && taskLeaseExpired(task, now)) {
        this.tasks.set(taskId, {
          ...task,
          status: 'failed',
          statusMessage: TASK_OWNER_LOST,
          outcome: ownerLostOutcome(),
          lastUpdatedAt: new Date(now).toISOString()
        })
      }
    }
  }

  private sweepExpired (): void {
    for (const [taskId, task] of this.tasks.entries()) {
      if (taskHasExpired(task)) {
        this.tasks.delete(taskId)
      }
    }
  }

  async get (taskId: string): Promise<TaskRecord | null> {
    const task = this.tasks.get(taskId)
    if (!task) return null
    if (taskHasExpired(task)) {
      this.tasks.delete(taskId)
      return null
    }
    return { ...task }
  }

  async updateStatus (
    taskId: string,
    status: TaskStatus,
    options: { statusMessage?: string, outcome?: TaskOutcome } = {}
  ): Promise<TaskRecord | null> {
    // Read straight from the map with no intervening await, so the terminal
    // check and the write cannot interleave with a concurrent updateStatus.
    // A separate `await this.get()` here would open a window in which a cancel
    // and a completion both read `working` and each overwrite the other.
    const task = this.tasks.get(taskId)
    if (!task || taskHasExpired(task)) {
      this.tasks.delete(taskId)
      return null
    }

    if (task.status !== status) {
      if (isTerminal(task.status)) {
        throw new Error(`Task ${taskId} is already in terminal status '${task.status}'`)
      }
      if (!canTransition(task.status, status)) {
        throw new Error(`Invalid task transition '${task.status}' -> '${status}'`)
      }
    }

    const updated: TaskRecord = {
      ...task,
      status,
      lastUpdatedAt: new Date().toISOString()
    }
    if (options.statusMessage !== undefined) {
      updated.statusMessage = options.statusMessage
    }
    if (options.outcome !== undefined) {
      updated.outcome = options.outcome
    }

    this.tasks.set(taskId, updated)
    return { ...updated }
  }

  async renewLease (taskId: string, leaseMs: number): Promise<boolean> {
    const task = this.tasks.get(taskId)
    if (!task || taskHasExpired(task) || isTerminal(task.status)) return false
    this.tasks.set(taskId, { ...task, leaseExpiresAt: Date.now() + leaseMs })
    return true
  }

  async failExpiredLease (
    taskId: string,
    options: { statusMessage: string, outcome: TaskOutcome }
  ): Promise<TaskRecord | null> {
    // Check and write with no intervening await, so a renewal cannot interleave
    const task = this.tasks.get(taskId)
    if (!task || taskHasExpired(task)) {
      this.tasks.delete(taskId)
      return null
    }
    if (!taskLeaseExpired(task)) return { ...task }

    const failed: TaskRecord = {
      ...task,
      status: 'failed',
      statusMessage: options.statusMessage,
      outcome: options.outcome,
      lastUpdatedAt: new Date().toISOString()
    }
    this.tasks.set(taskId, failed)
    return { ...failed }
  }

  async list (owner: TaskOwner = {}, options: TaskListOptions = {}): Promise<TaskListPage> {
    const after = options.cursor === undefined ? undefined : decodeTaskCursor(options.cursor)
    const limit = taskPageLimit(options.limit)

    const matches: Array<{ createdAt: number, task: TaskRecord }> = []
    for (const task of this.tasks.values()) {
      if (taskHasExpired(task)) continue
      // Tasks bound to an owner are only ever visible to that owner
      if (!isTaskOwner(task, owner)) continue
      const createdAt = new Date(task.createdAt).getTime()
      if (after && !isAfterTaskCursor(createdAt, task.taskId, after)) continue
      matches.push({ createdAt, task })
    }
    matches.sort((a, b) => (b.createdAt - a.createdAt) || (a.task.taskId < b.task.taskId ? 1 : a.task.taskId > b.task.taskId ? -1 : 0))

    const tasks = matches.slice(0, limit).map(({ task }) => ({ ...task }))
    const page: TaskListPage = { tasks }
    if (matches.length > limit) {
      page.nextCursor = encodeTaskCursor(tasks[tasks.length - 1])
    }
    return page
  }

  async delete (taskId: string): Promise<void> {
    this.tasks.delete(taskId)
  }

  async cleanup (): Promise<void> {
    this.sweepExpired()
  }
}
