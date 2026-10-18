import type { TaskStatus } from '../schema.ts'
import type { TaskStore, TaskRecord, TaskUpdateOptions, TaskInputUpdate, TaskOutcome, TaskListOptions, TaskListPage } from './task-store.ts'
import {
  DEFAULT_TASK_MAX_PER_PRINCIPAL,
  TaskLimitError,
  TASK_OWNER_LOST,
  applyInputRequestUpdates,
  canTransition,
  decodeTaskCursor,
  encodeTaskCursor,
  isAfterTaskCursor,
  isTerminal,
  matchesTaskEra,
  ownerLostOutcome,
  taskHasExpired,
  taskPageLimit,
  validateTaskLimit
} from './task-store.ts'

/**
 * In-process task store for single-instance deployments.
 *
 * Expired tasks are treated as absent on read and swept lazily, so a task never
 * outlives its ttl even if `cleanup()` has not run recently.
 */
/** Who a task counts against for the per-caller cap. */
function quotaOf (task: TaskRecord): string | undefined {
  return task.quotaKey ?? task.authSubject
}

export class MemoryTaskStore implements TaskStore {
  // Insertion order is creation order, so iteration visits the oldest first
  private tasks = new Map<string, TaskRecord>()
  private readonly maxTasks: number
  private readonly maxTasksPerPrincipal: number

  constructor (options: number | { maxTasks?: number, maxTasksPerPrincipal?: number } = {}) {
    const opts = typeof options === 'number' ? { maxTasks: options } : options
    this.maxTasks = opts.maxTasks ?? 1000
    this.maxTasksPerPrincipal = opts.maxTasksPerPrincipal ?? DEFAULT_TASK_MAX_PER_PRINCIPAL
    validateTaskLimit('maxTasks', this.maxTasks)
    validateTaskLimit('maxTasksPerPrincipal', this.maxTasksPerPrincipal)
  }

  async create (task: TaskRecord): Promise<void> {
    // No await until the task is stored, so concurrent creates cannot both
    // pass the capacity checks and overshoot them.
    const quota = quotaOf(task)
    const ownedBy = (t: TaskRecord) => quotaOf(t) === quota
    const ownClient = (t: TaskRecord) => t.authSubject === task.authSubject && ownedBy(t)

    // Finished tasks count too: otherwise one caller could hold every slot
    // with results it never collects until their ttl runs out.
    if (this.count(ownedBy) >= this.maxTasksPerPrincipal) {
      this.sweepExpired()
      this.failLapsedLeases(ownedBy)
      // The caller's own finished work goes first; only then results another
      // of the user's OAuth clients has not collected yet.
      if (
        this.count(ownedBy) >= this.maxTasksPerPrincipal &&
        !this.evictOldestFinished(ownClient) &&
        !this.evictOldestFinished(ownedBy)
      ) {
        throw new TaskLimitError(this.maxTasksPerPrincipal)
      }
    }

    if (this.tasks.size >= this.maxTasks) {
      this.sweepExpired()
      this.failLapsedLeases(() => true)
      // Prefer the caller's own finished work (this client's, then the
      // user's others); failing that, the oldest finished task of anyone, as
      // stale results matter less than new work.
      if (
        this.tasks.size >= this.maxTasks &&
        !this.evictOldestFinished(ownClient) &&
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
      if (!predicate(task) || isTerminal(task.status)) continue
      if (task.leaseExpiresAt === undefined || now <= task.leaseExpiresAt) continue
      const failed: TaskRecord = {
        ...task,
        status: 'failed',
        statusMessage: TASK_OWNER_LOST,
        outcome: ownerLostOutcome(),
        lastUpdatedAt: new Date(now).toISOString()
      }
      applyInputRequestUpdates(failed, { inputRequests: null, clearPendingInputResponses: true })
      this.tasks.set(taskId, failed)
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
    options: TaskUpdateOptions = {}
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

    // A terminal task never changes again, not even to rewrite the same status
    // with another message or outcome (the Redis store refuses the same).
    if (isTerminal(task.status)) {
      throw new Error(`Task ${taskId} is already in terminal status '${task.status}'`)
    }
    if (task.status !== status) {
      if (!canTransition(task.status, status)) {
        throw new Error(`Invalid task transition '${task.status}' -> '${status}'`)
      }
    }

    const updated: TaskRecord = {
      ...task,
      status,
      lastUpdatedAt: new Date().toISOString()
    }
    if (options.statusMessage === null) {
      delete updated.statusMessage
    } else if (options.statusMessage !== undefined) {
      updated.statusMessage = options.statusMessage
    }
    if (options.outcome !== undefined) {
      updated.outcome = options.outcome
    }
    applyInputRequestUpdates(updated, options)

    this.tasks.set(taskId, updated)
    return { ...updated }
  }

  async updateInputResponses (
    taskId: string,
    responses: Record<string, unknown>,
    responseId: string,
    round?: number
  ): Promise<TaskInputUpdate | null> {
    const task = this.tasks.get(taskId)
    if (!task || taskHasExpired(task)) {
      this.tasks.delete(taskId)
      return null
    }

    const outstanding = { ...(task.inputRequests ?? {}) }
    const answered = new Set(task.answeredInputKeys ?? [])
    const pending = { ...(task.pendingInputResponses ?? {}) }
    const pendingIds = { ...(task.pendingInputResponseIds ?? {}) }
    const pendingRounds = { ...(task.pendingInputResponseRounds ?? {}) }
    const currentRound = task.inputRequestRound ?? 0
    const deliverable: Array<[string, unknown]> = []
    const responseIds: Array<[string, string]> = []
    let changed = false

    for (const [key, value] of Object.entries(responses)) {
      if (Object.hasOwn(pending, key) && (pendingRounds[key] ?? currentRound) === currentRound) {
        // A prior request staged this key but did not complete broker delivery.
        // Retry the durable value, not a changed replay.
        deliverable.push([key, pending[key]])
        responseIds.push([key, pendingIds[key] ?? responseId])
      } else if (!isTerminal(task.status) && (round === undefined || round === currentRound) &&
        Object.hasOwn(outstanding, key) && !answered.has(key)) {
        deliverable.push([key, value])
        responseIds.push([key, responseId])
        Object.defineProperty(pending, key, {
          value,
          enumerable: true,
          configurable: true,
          writable: true
        })
        Object.defineProperty(pendingIds, key, {
          value: responseId,
          enumerable: true,
          configurable: true,
          writable: true
        })
        Object.defineProperty(pendingRounds, key, {
          value: currentRound,
          enumerable: true,
          configurable: true,
          writable: true
        })
        delete outstanding[key]
        answered.add(key)
        changed = true
      }
    }

    const updated: TaskRecord = changed
      ? {
          ...task,
          lastUpdatedAt: new Date().toISOString(),
          ...(Object.keys(outstanding).length > 0
            ? { inputRequests: outstanding }
            // Fully answered: the task is no longer waiting on the client, so
            // it must not keep reporting `input_required` with nothing to ask.
            : { inputRequests: undefined, ...(task.status === 'input_required' ? { status: 'working' as const, statusMessage: undefined } : {}) }),
          answeredInputKeys: [...answered],
          pendingInputResponses: pending,
          pendingInputResponseIds: pendingIds,
          pendingInputResponseRounds: pendingRounds
        }
      : task

    if (changed) this.tasks.set(taskId, updated)
    return {
      task: { ...updated },
      responses: Object.fromEntries(deliverable),
      responseIds: Object.fromEntries(responseIds)
    }
  }

  async renewLease (taskId: string, leaseMs: number): Promise<TaskStatus | null> {
    const task = this.tasks.get(taskId)
    if (!task || taskHasExpired(task)) return null
    if (!isTerminal(task.status)) {
      this.tasks.set(taskId, { ...task, leaseExpiresAt: Date.now() + leaseMs })
    }
    return task.status
  }

  async expireStaleLease (taskId: string, statusMessage: string, outcome: TaskOutcome): Promise<TaskRecord | null> {
    const task = this.tasks.get(taskId)
    if (!task || taskHasExpired(task) || isTerminal(task.status)) return null
    if (task.leaseExpiresAt === undefined || Date.now() <= task.leaseExpiresAt) return null

    const failed: TaskRecord = {
      ...task,
      status: 'failed',
      statusMessage,
      outcome,
      lastUpdatedAt: new Date().toISOString()
    }
    applyInputRequestUpdates(failed, { inputRequests: null, clearPendingInputResponses: true })
    this.tasks.set(taskId, failed)
    return { ...failed }
  }

  async acknowledgeInputResponses (taskId: string, responseIds: Record<string, string>): Promise<void> {
    const task = this.tasks.get(taskId)
    if (!task || !task.pendingInputResponses) return

    const acknowledged = new Set(
      Object.entries(responseIds)
        .filter(([key, deliveryId]) => task.pendingInputResponseIds?.[key] === deliveryId)
        .map(([key]) => key)
    )
    const remaining = Object.fromEntries(
      Object.entries(task.pendingInputResponses).filter(([key]) => !acknowledged.has(key))
    )
    const remainingIds = Object.fromEntries(
      Object.entries(task.pendingInputResponseIds ?? {}).filter(([key]) => !acknowledged.has(key))
    )
    const remainingRounds = Object.fromEntries(
      Object.entries(task.pendingInputResponseRounds ?? {}).filter(([key]) => !acknowledged.has(key))
    )
    const updated = { ...task }
    if (Object.keys(remaining).length > 0) {
      updated.pendingInputResponses = remaining
      updated.pendingInputResponseIds = remainingIds
      updated.pendingInputResponseRounds = remainingRounds
    } else {
      delete updated.pendingInputResponses
      delete updated.pendingInputResponseIds
      delete updated.pendingInputResponseRounds
    }
    this.tasks.set(taskId, updated)
  }

  async list (authSubject?: string, options: TaskListOptions = {}): Promise<TaskListPage> {
    const after = options.cursor === undefined ? undefined : decodeTaskCursor(options.cursor)
    const limit = taskPageLimit(options.limit)

    const matches: Array<{ createdAt: number, task: TaskRecord }> = []
    for (const task of this.tasks.values()) {
      if (taskHasExpired(task)) continue
      // Tasks bound to a subject are only ever visible to that subject
      if (task.authSubject !== authSubject) continue
      if (!matchesTaskEra(task, options.era)) continue
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
    for (const [taskId, task] of this.tasks.entries()) {
      if (taskHasExpired(task)) {
        this.tasks.delete(taskId)
      }
    }
  }
}
