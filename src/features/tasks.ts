import type { TaskStore, StoredTask } from '../stores/task-store.ts'
import type { MessageBroker } from '../brokers/message-broker.ts'
import type { AuthorizationContext } from '../types/auth-types.ts'
import type {
  TaskStatus,
  CreateTaskResult,
  JSONRPCNotification
} from '../schema.ts'
import { JSONRPC_VERSION } from '../schema.ts'

/**
 * Service for managing task lifecycle.
 *
 * Provides methods for creating, updating, querying, and cancelling tasks.
 * Tasks are asynchronous operations that can be polled for completion.
 */
export class TaskService {
  private readonly taskStore: TaskStore
  private readonly messageBroker: MessageBroker

  constructor (taskStore: TaskStore, messageBroker: MessageBroker) {
    this.taskStore = taskStore
    this.messageBroker = messageBroker
  }

  /**
   * Creates a new task.
   *
   * @param ttl - Time to live in milliseconds
   * @param authContext - Optional authorization context
   * @returns Task creation result with task metadata
   */
  async createTask (
    ttl: number,
    authContext?: AuthorizationContext
  ): Promise<CreateTaskResult> {
    const createdAt = new Date()
    const pollInterval = Math.min(Math.floor(ttl / 10), 5000)

    const taskId = await this.taskStore.create({
      status: 'working',
      createdAt,
      ttl,
      pollInterval,
      authContext
    })

    return {
      task: {
        taskId,
        status: 'working',
        createdAt: createdAt.toISOString(),
        ttl,
        pollInterval
      }
    }
  }

  /**
   * Gets task status.
   *
   * @param taskId - The task ID
   * @param authContext - Optional authorization context for access control
   * @returns Task status information
   */
  async getTask (
    taskId: string,
    authContext?: AuthorizationContext
  ): Promise<{
    taskId: string
    status: TaskStatus
    statusMessage?: string
    createdAt: string
    ttl: number
    pollInterval?: number
  }> {
    const task = await this.taskStore.get(taskId)

    if (!task) {
      throw new Error('Task not found')
    }

    // Verify authorization
    if (!this.verifyTaskAccess(task, authContext)) {
      throw new Error('Task not found')
    }

    return {
      taskId: task.taskId,
      status: task.status,
      statusMessage: task.statusMessage,
      createdAt: task.createdAt.toISOString(),
      ttl: task.ttl,
      pollInterval: task.pollInterval
    }
  }

  /**
   * Gets task result. Blocks if task is not in terminal state.
   *
   * @param taskId - The task ID
   * @param authContext - Optional authorization context for access control
   * @returns The task result
   */
  async getTaskResult (
    taskId: string,
    authContext?: AuthorizationContext
  ): Promise<unknown> {
    const task = await this.taskStore.get(taskId)

    if (!task) {
      throw new Error('Task not found')
    }

    // Verify authorization
    if (!this.verifyTaskAccess(task, authContext)) {
      throw new Error('Task not found')
    }

    // Wait for terminal status if not terminal
    if (!this.isTerminal(task.status)) {
      await this.waitForTerminal(taskId, task.ttl)
    }

    // Refetch task to get updated result
    const updatedTask = await this.taskStore.get(taskId)
    return updatedTask?.result
  }

  /**
   * Lists tasks, optionally filtered by authorization context.
   *
   * @param authContext - Optional authorization context for filtering
   * @returns Array of tasks
   */
  async listTasks (
    authContext?: AuthorizationContext
  ): Promise<Array<{
    taskId: string
    status: TaskStatus
    statusMessage?: string
    createdAt: string
    ttl: number
    pollInterval?: number
  }>> {
    const tasks = await this.taskStore.list(authContext)

    return tasks.map(task => ({
      taskId: task.taskId,
      status: task.status,
      statusMessage: task.statusMessage,
      createdAt: task.createdAt.toISOString(),
      ttl: task.ttl,
      pollInterval: task.pollInterval
    }))
  }

  /**
   * Cancels a task.
   *
   * @param taskId - The task ID
   * @param authContext - Optional authorization context for access control
   */
  async cancelTask (
    taskId: string,
    authContext?: AuthorizationContext
  ): Promise<void> {
    const task = await this.taskStore.get(taskId)

    if (!task) {
      throw new Error('Task not found')
    }

    // Verify authorization
    if (!this.verifyTaskAccess(task, authContext)) {
      throw new Error('Task not found')
    }

    if (this.isTerminal(task.status)) {
      throw new Error('Cannot cancel terminal task')
    }

    await this.taskStore.update(taskId, {
      status: 'cancelled',
      statusMessage: 'Cancelled by user'
    })

    await this.notifyStatusChange(taskId)
  }

  /**
   * Updates task status and result.
   *
   * @param taskId - The task ID
   * @param status - New status
   * @param result - Optional result data
   * @param statusMessage - Optional status message
   */
  async updateTask (
    taskId: string,
    status: TaskStatus,
    result?: unknown,
    statusMessage?: string
  ): Promise<void> {
    await this.taskStore.update(taskId, {
      status,
      result,
      statusMessage
    })

    await this.notifyStatusChange(taskId)
  }

  /**
   * Notifies subscribers of task status change.
   *
   * @param taskId - The task ID
   */
  async notifyStatusChange (taskId: string): Promise<void> {
    const task = await this.taskStore.get(taskId)
    if (!task) return

    const notification: JSONRPCNotification = {
      jsonrpc: JSONRPC_VERSION,
      method: 'notifications/tasks/status',
      params: {
        taskId: task.taskId,
        status: task.status,
        statusMessage: task.statusMessage,
        createdAt: task.createdAt.toISOString(),
        ttl: task.ttl,
        pollInterval: task.pollInterval
      }
    }

    await this.messageBroker.publish(`mcp/task/${taskId}/status`, notification)
  }

  /**
   * Cleans up expired tasks.
   *
   * @returns Number of tasks cleaned up
   */
  async cleanup (): Promise<number> {
    return await this.taskStore.cleanup()
  }

  /**
   * Checks if a status is terminal.
   *
   * @param status - The task status
   * @returns True if the status is terminal
   */
  private isTerminal (status: TaskStatus): boolean {
    return ['completed', 'failed', 'cancelled'].includes(status)
  }

  /**
   * Waits for a task to reach terminal status.
   *
   * @param taskId - The task ID
   * @param timeout - Timeout in milliseconds
   */
  private async waitForTerminal (
    taskId: string,
    timeout: number
  ): Promise<void> {
    const startTime = Date.now()
    const pollInterval = 100

    while (Date.now() - startTime < timeout) {
      const task = await this.taskStore.get(taskId)

      if (!task) {
        throw new Error('Task not found')
      }

      if (this.isTerminal(task.status)) {
        return
      }

      await new Promise(resolve => setTimeout(resolve, pollInterval))
    }

    throw new Error('Task timeout')
  }

  /**
   * Verifies that the requester has access to the task.
   *
   * @param task - The stored task
   * @param authContext - The authorization context
   * @returns True if access is granted
   */
  private verifyTaskAccess (
    task: StoredTask,
    authContext?: AuthorizationContext
  ): boolean {
    // If no auth context on task, allow access
    if (!task.authContext) {
      return true
    }

    // If no auth context provided, deny access to protected tasks
    if (!authContext) {
      return false
    }

    // Match by user ID
    if (task.authContext.userId && authContext.userId) {
      return task.authContext.userId === authContext.userId
    }

    // Match by client ID
    if (task.authContext.clientId && authContext.clientId) {
      return task.authContext.clientId === authContext.clientId
    }

    return false
  }
}
