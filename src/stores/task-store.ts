import type { TaskStatus } from '../schema.ts'
import type { AuthorizationContext } from '../types/auth-types.ts'
import { randomUUID } from 'node:crypto'

/**
 * Stored task data with metadata.
 */
export interface StoredTask {
  taskId: string
  status: TaskStatus
  statusMessage?: string
  createdAt: Date
  ttl: number
  pollInterval?: number
  result?: unknown
  authContext?: AuthorizationContext
}

/**
 * Task store interface for managing asynchronous task state.
 *
 * Tasks have a time-to-live (TTL) and are automatically cleaned up
 * when they expire.
 */
export interface TaskStore {
  /**
   * Creates a new task.
   *
   * @param task - Task data without taskId (will be generated)
   * @returns The generated task ID
   */
  create (task: Omit<StoredTask, 'taskId'>): Promise<string>

  /**
   * Retrieves a task by ID.
   *
   * @param taskId - The task ID
   * @returns The task data, or null if not found
   */
  get (taskId: string): Promise<StoredTask | null>

  /**
   * Updates a task's mutable fields.
   *
   * @param taskId - The task ID
   * @param updates - Partial task updates
   */
  update (taskId: string, updates: Partial<StoredTask>): Promise<void>

  /**
   * Deletes a task.
   *
   * @param taskId - The task ID
   */
  delete (taskId: string): Promise<void>

  /**
   * Lists all tasks, optionally filtered by authorization context.
   *
   * @param authContext - Optional authorization context for filtering
   * @returns Array of task data
   */
  list (authContext?: AuthorizationContext): Promise<StoredTask[]>

  /**
   * Cleans up expired tasks (older than their TTL).
   *
   * @returns Number of tasks deleted
   */
  cleanup (): Promise<number>
}

/**
 * In-memory implementation of TaskStore.
 */
export class MemoryTaskStore implements TaskStore {
  private readonly tasks = new Map<string, StoredTask>()

  async create (task: Omit<StoredTask, 'taskId'>): Promise<string> {
    const taskId = randomUUID()
    this.tasks.set(taskId, {
      ...task,
      taskId
    })
    return taskId
  }

  async get (taskId: string): Promise<StoredTask | null> {
    return this.tasks.get(taskId) ?? null
  }

  async update (taskId: string, updates: Partial<StoredTask>): Promise<void> {
    const task = this.tasks.get(taskId)
    if (task) {
      this.tasks.set(taskId, {
        ...task,
        ...updates
      })
    }
  }

  async delete (taskId: string): Promise<void> {
    this.tasks.delete(taskId)
  }

  async list (authContext?: AuthorizationContext): Promise<StoredTask[]> {
    const tasks = Array.from(this.tasks.values())

    // If no auth context provided, return all tasks
    if (!authContext) {
      return tasks
    }

    // Filter by user ID if provided
    if (authContext.userId) {
      return tasks.filter(t =>
        t.authContext?.userId === authContext.userId
      )
    }

    // Filter by client ID if provided
    if (authContext.clientId) {
      return tasks.filter(t =>
        t.authContext?.clientId === authContext.clientId
      )
    }

    return tasks
  }

  async cleanup (): Promise<number> {
    const now = Date.now()
    let count = 0

    for (const [id, task] of this.tasks.entries()) {
      const expiresAt = task.createdAt.getTime() + task.ttl
      if (now > expiresAt) {
        this.tasks.delete(id)
        count++
      }
    }

    return count
  }
}
