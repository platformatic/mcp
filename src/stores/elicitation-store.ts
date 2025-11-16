/**
 * Storage for URL mode elicitation requests.
 *
 * URL mode elicitation allows servers to redirect users to external URLs
 * for out-of-band data collection, then receive a completion notification
 * when the user finishes the flow.
 */

export interface ElicitationData {
  elicitationId: string
  url: string
  message: string
  status: 'pending' | 'completed' | 'cancelled'
  createdAt: Date
  completedAt?: Date
  userId?: string
  sessionId?: string
}

export interface ElicitationStore {
  /**
   * Creates a new elicitation request.
   *
   * @param data - Elicitation request data
   */
  create (data: Omit<ElicitationData, 'createdAt' | 'status'>): Promise<void>

  /**
   * Retrieves an elicitation by ID.
   *
   * @param elicitationId - The elicitation ID
   * @returns The elicitation data, or null if not found
   */
  get (elicitationId: string): Promise<ElicitationData | null>

  /**
   * Marks an elicitation as completed.
   *
   * @param elicitationId - The elicitation ID
   */
  complete (elicitationId: string): Promise<void>

  /**
   * Marks an elicitation as cancelled.
   *
   * @param elicitationId - The elicitation ID
   */
  cancel (elicitationId: string): Promise<void>

  /**
   * Deletes an elicitation.
   *
   * @param elicitationId - The elicitation ID
   */
  delete (elicitationId: string): Promise<void>

  /**
   * Lists all elicitations for a user.
   *
   * @param userId - The user ID
   * @returns Array of elicitation data
   */
  listByUser (userId: string): Promise<ElicitationData[]>

  /**
   * Lists all elicitations for a session.
   *
   * @param sessionId - The session ID
   * @returns Array of elicitation data
   */
  listBySession (sessionId: string): Promise<ElicitationData[]>

  /**
   * Cleans up old elicitations (older than TTL).
   *
   * @param ttl - Time to live in milliseconds
   * @returns Number of elicitations deleted
   */
  cleanup (ttl: number): Promise<number>
}

/**
 * In-memory implementation of ElicitationStore.
 */
export class MemoryElicitationStore implements ElicitationStore {
  private readonly elicitations = new Map<string, ElicitationData>()

  async create (data: Omit<ElicitationData, 'createdAt' | 'status'>): Promise<void> {
    this.elicitations.set(data.elicitationId, {
      ...data,
      createdAt: new Date(),
      status: 'pending'
    })
  }

  async get (elicitationId: string): Promise<ElicitationData | null> {
    return this.elicitations.get(elicitationId) ?? null
  }

  async complete (elicitationId: string): Promise<void> {
    const elicitation = this.elicitations.get(elicitationId)
    if (elicitation) {
      elicitation.status = 'completed'
      elicitation.completedAt = new Date()
    }
  }

  async cancel (elicitationId: string): Promise<void> {
    const elicitation = this.elicitations.get(elicitationId)
    if (elicitation) {
      elicitation.status = 'cancelled'
      elicitation.completedAt = new Date()
    }
  }

  async delete (elicitationId: string): Promise<void> {
    this.elicitations.delete(elicitationId)
  }

  async listByUser (userId: string): Promise<ElicitationData[]> {
    return Array.from(this.elicitations.values())
      .filter(e => e.userId === userId)
  }

  async listBySession (sessionId: string): Promise<ElicitationData[]> {
    return Array.from(this.elicitations.values())
      .filter(e => e.sessionId === sessionId)
  }

  async cleanup (ttl: number): Promise<number> {
    const now = Date.now()
    let count = 0

    for (const [id, elicitation] of this.elicitations.entries()) {
      if (now - elicitation.createdAt.getTime() > ttl) {
        this.elicitations.delete(id)
        count++
      }
    }

    return count
  }
}
