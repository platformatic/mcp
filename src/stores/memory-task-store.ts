import type { TaskStatus } from '../schema.ts'
import type { TaskStore, TaskRecord, TaskUpdateOptions, TaskInputUpdate } from './task-store.ts'
import { applyInputRequestUpdates, canTransition, isTerminal, taskHasExpired } from './task-store.ts'

/**
 * In-process task store for single-instance deployments.
 *
 * Expired tasks are treated as absent on read and swept lazily, so a task never
 * outlives its ttl even if `cleanup()` has not run recently.
 */
export class MemoryTaskStore implements TaskStore {
  private tasks = new Map<string, TaskRecord>()
  private readonly maxTasks: number

  constructor (maxTasks: number = 1000) {
    this.maxTasks = maxTasks
  }

  async create (task: TaskRecord): Promise<void> {
    if (this.tasks.size >= this.maxTasks) {
      await this.cleanup()
    }
    if (this.tasks.size >= this.maxTasks) {
      throw new Error(`Task limit reached (${this.maxTasks})`)
    }
    this.tasks.set(task.taskId, { ...task })
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
    applyInputRequestUpdates(updated, options)

    this.tasks.set(taskId, updated)
    return { ...updated }
  }

  async updateInputResponses (
    taskId: string,
    responses: Record<string, unknown>,
    responseId: string
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
    const deliverable: Array<[string, unknown]> = []
    const responseIds: Array<[string, string]> = []
    let changed = false

    for (const [key, value] of Object.entries(responses)) {
      if (Object.hasOwn(pending, key)) {
        // A prior request staged this key but failed before acknowledging its
        // broker publication. Retry the durable value, not a changed replay.
        deliverable.push([key, pending[key]])
        responseIds.push([key, pendingIds[key] ?? responseId])
      } else if (!isTerminal(task.status) && Object.hasOwn(outstanding, key) && !answered.has(key)) {
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
        delete outstanding[key]
        answered.add(key)
        changed = true
      }
    }

    const updated: TaskRecord = changed
      ? {
          ...task,
          lastUpdatedAt: new Date().toISOString(),
          ...(Object.keys(outstanding).length > 0 ? { inputRequests: outstanding } : { inputRequests: undefined }),
          answeredInputKeys: [...answered],
          pendingInputResponses: pending,
          pendingInputResponseIds: pendingIds
        }
      : task

    if (changed) this.tasks.set(taskId, updated)
    return {
      task: { ...updated },
      responses: Object.fromEntries(deliverable),
      responseIds: Object.fromEntries(responseIds)
    }
  }

  async acknowledgeInputResponses (taskId: string, keys: string[]): Promise<void> {
    const task = this.tasks.get(taskId)
    if (!task || !task.pendingInputResponses) return

    const acknowledged = new Set(keys)
    const remaining = Object.fromEntries(
      Object.entries(task.pendingInputResponses).filter(([key]) => !acknowledged.has(key))
    )
    const remainingIds = Object.fromEntries(
      Object.entries(task.pendingInputResponseIds ?? {}).filter(([key]) => !acknowledged.has(key))
    )
    const updated = { ...task }
    if (Object.keys(remaining).length > 0) {
      updated.pendingInputResponses = remaining
      updated.pendingInputResponseIds = remainingIds
    } else {
      delete updated.pendingInputResponses
      delete updated.pendingInputResponseIds
    }
    this.tasks.set(taskId, updated)
  }

  async list (authSubject?: string): Promise<TaskRecord[]> {
    const results: TaskRecord[] = []
    for (const task of this.tasks.values()) {
      if (taskHasExpired(task)) continue
      // Tasks bound to a subject are only ever visible to that subject
      if (task.authSubject !== authSubject) continue
      results.push({ ...task })
    }
    return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
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
