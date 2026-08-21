import type { TaskStatus } from '../schema.ts'
import type { TaskStore, TaskRecord, TaskOutcome } from './task-store.ts'
import { canTransition, isTerminal, taskHasExpired } from './task-store.ts'

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
