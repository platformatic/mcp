import { createHash, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Redis } from 'ioredis'
import type { SessionStore } from '../stores/session-store.ts'
import type { MessageBroker } from '../brokers/message-broker.ts'
import { shouldAttemptRefresh, createTokenRefreshInfo } from './token-utils.ts'
import { createDistributedLock, type DistributedLock } from '../utils/distributed-lock.ts'

export interface TokenRefreshCoordinationOptions {
  /** Lock timeout in seconds (default: 30) */
  lockTimeoutSeconds?: number
  /** Maximum number of lock extensions (default: 3) */
  maxLockExtensions?: number
  /** Enable detailed coordination logging (default: false) */
  enableCoordinationLogging?: boolean
}

export interface TokenRefreshServiceOptions {
  sessionStore: SessionStore
  messageBroker: MessageBroker
  oauthClient?: any // OAuth client for token refresh
  checkIntervalMs?: number // How often to check for tokens needing refresh
  refreshBufferMinutes?: number // How many minutes before expiry to refresh

  // Distributed coordination options
  redis?: Redis // Redis instance for distributed coordination
  coordination?: TokenRefreshCoordinationOptions
}

/**
 * Background service that automatically refreshes tokens for active sessions
 * Supports distributed coordination to prevent duplicate refresh attempts across multiple instances
 */
export class TokenRefreshService {
  private sessionStore: SessionStore
  private messageBroker: MessageBroker
  private oauthClient?: any
  private checkIntervalMs: number
  private refreshBufferMinutes: number
  private intervalId?: NodeJS.Timeout
  private isRunning = false
  private fastify?: FastifyInstance

  // Distributed coordination
  private distributedLock?: DistributedLock
  private instanceId: string
  private lockTimeoutSeconds: number
  private enableCoordinationLogging: boolean

  constructor (options: TokenRefreshServiceOptions) {
    this.sessionStore = options.sessionStore
    this.messageBroker = options.messageBroker
    this.oauthClient = options.oauthClient
    this.checkIntervalMs = options.checkIntervalMs || 5 * 60 * 1000 // 5 minutes default
    this.refreshBufferMinutes = options.refreshBufferMinutes || 5 // 5 minutes default

    // Initialize distributed coordination
    this.instanceId = randomUUID()
    this.lockTimeoutSeconds = options.coordination?.lockTimeoutSeconds || 30
    this.enableCoordinationLogging = options.coordination?.enableCoordinationLogging || false

    // Always create distributed lock (Redis or in-memory)
    this.distributedLock = createDistributedLock(options.redis, 'token-refresh')
  }

  /**
   * Start the token refresh service
   */
  start (fastify?: FastifyInstance): void {
    if (this.isRunning) {
      return
    }

    this.fastify = fastify
    this.isRunning = true

    if (fastify) {
      fastify.log.info({
        instanceId: this.instanceId,
        checkIntervalMs: this.checkIntervalMs,
        refreshBufferMinutes: this.refreshBufferMinutes,
        lockTimeoutSeconds: this.lockTimeoutSeconds,
        useDistributedCoordination: !!this.distributedLock
      }, 'Starting token refresh service with distributed coordination')
    }

    // Start periodic check
    this.intervalId = setInterval(() => {
      this.checkAndRefreshTokens().catch(error => {
        if (fastify) {
          fastify.log.error({ error, instanceId: this.instanceId }, 'Token refresh check failed')
        }
      })
    }, this.checkIntervalMs)

    // Don't keep the process alive just for this interval
    this.intervalId.unref()
  }

  /**
   * Stop the token refresh service
   */
  async stop (): Promise<void> {
    if (!this.isRunning) {
      return
    }

    this.isRunning = false

    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = undefined
    }

    // Clean up distributed lock resources
    if (this.distributedLock?.close) {
      await this.distributedLock.close()
    }

    if (this.fastify) {
      this.fastify.log.info({ instanceId: this.instanceId }, 'Token refresh service stopped')
    }
  }

  /**
   * Check all active sessions and refresh tokens that are close to expiry
   * Uses distributed coordination to ensure only one instance performs refresh
   */
  private async checkAndRefreshTokens (): Promise<void> {
    if (!this.oauthClient) {
      return // No OAuth client available for refresh
    }

    if (!this.distributedLock) {
      // Fallback to single-instance behavior
      await this.performTokenRefresh()
      return
    }

    // Use distributed coordination
    await this.checkAndRefreshWithLock()
  }

  /**
   * Perform token refresh with distributed locking coordination
   */
  private async checkAndRefreshWithLock (): Promise<void> {
    if (!this.distributedLock) {
      return
    }

    // Create time-based lock key to ensure fair scheduling
    const lockWindow = Math.floor(Date.now() / this.checkIntervalMs)
    const lockKey = `refresh-cycle:${lockWindow}`

    const lockAcquired = await this.distributedLock.acquire(
      lockKey,
      this.lockTimeoutSeconds,
      this.instanceId
    )

    if (!lockAcquired) {
      if (this.enableCoordinationLogging && this.fastify) {
        this.fastify.log.debug({
          instanceId: this.instanceId,
          lockKey,
          lockWindow
        }, 'Token refresh lock not acquired, skipping cycle')
      }
      return
    }

    if (this.enableCoordinationLogging && this.fastify) {
      this.fastify.log.info({
        instanceId: this.instanceId,
        lockKey,
        lockWindow,
        lockTimeoutSeconds: this.lockTimeoutSeconds
      }, 'Token refresh coordination lock acquired')
    }

    try {
      await this.performTokenRefresh()

      if (this.enableCoordinationLogging && this.fastify) {
        this.fastify.log.info({
          instanceId: this.instanceId,
          lockKey
        }, 'Token refresh cycle completed successfully')
      }
    } catch (error) {
      if (this.fastify) {
        this.fastify.log.error({
          error,
          instanceId: this.instanceId,
          lockKey
        }, 'Token refresh cycle failed')
      }
      throw error
    } finally {
      // Always release the lock
      const released = await this.distributedLock.release(lockKey, this.instanceId)

      if (this.enableCoordinationLogging && this.fastify) {
        this.fastify.log.debug({
          instanceId: this.instanceId,
          lockKey,
          released
        }, 'Token refresh lock released')
      }
    }
  }

  /**
   * Perform the actual token refresh logic
   * This is separated from coordination logic for clarity
   */
  private async performTokenRefresh (): Promise<void> {
    // This is a simplified implementation placeholder
    // In a complete implementation, you would:
    // 1. Query session store for sessions with expiring tokens
    // 2. Iterate through sessions and refresh tokens as needed
    // 3. Update session store with new token information
    // 4. Send notifications to affected sessions

    if (this.fastify) {
      this.fastify.log.debug({
        instanceId: this.instanceId
      }, 'Token refresh service check completed')
    }
  }

  /**
   * Manually refresh a token for a specific session
   */
  async refreshSessionToken (sessionId: string): Promise<boolean> {
    if (!this.oauthClient) {
      throw new Error('No OAuth client available for token refresh')
    }

    const session = await this.sessionStore.get(sessionId)
    if (!session?.authorization || !session.tokenRefresh) {
      return false
    }

    if (!shouldAttemptRefresh(session.authorization, session.tokenRefresh)) {
      return false // Token doesn't need refresh yet
    }

    try {
      const refreshResult = await this.oauthClient.refreshToken(session.tokenRefresh.refreshToken)

      // For a complete implementation, we'd need to decode/introspect the new token
      // to get the full payload. For now, we'll update what we can.
      const newAuthContext = {
        ...session.authorization,
        expiresAt: refreshResult.expires_in
          ? new Date(Date.now() + refreshResult.expires_in * 1000)
          : undefined,
        tokenHash: createHash('sha256').update(refreshResult.access_token).digest('hex')
      }

      const newRefreshInfo = createTokenRefreshInfo(
        refreshResult.refresh_token || session.tokenRefresh.refreshToken,
        session.tokenRefresh.clientId,
        session.tokenRefresh.authorizationServer,
        session.tokenRefresh.scopes
      )

      // Update session with new token info
      await this.sessionStore.updateAuthorization(sessionId, newAuthContext, newRefreshInfo)

      // Notify the session about the token refresh via SSE
      await this.messageBroker.publish(`mcp/session/${sessionId}/message`, {
        jsonrpc: '2.0',
        method: 'notifications/token_refreshed',
        params: {
          access_token: refreshResult.access_token,
          token_type: refreshResult.token_type,
          expires_in: refreshResult.expires_in,
          scope: refreshResult.scope
        }
      })

      if (this.fastify) {
        this.fastify.log.info({
          sessionId,
          userId: session.authorization.userId
        }, 'Token refreshed successfully for session')
      }

      return true
    } catch (error) {
      // Update refresh attempt count
      const updatedRefreshInfo = {
        ...session.tokenRefresh,
        refreshAttempts: (session.tokenRefresh.refreshAttempts || 0) + 1
      }

      await this.sessionStore.updateAuthorization(session.id, session.authorization, updatedRefreshInfo)

      if (this.fastify) {
        this.fastify.log.warn({
          error,
          sessionId,
          userId: session.authorization.userId,
          attempts: updatedRefreshInfo.refreshAttempts
        }, 'Token refresh failed for session')
      }

      throw error
    }
  }

  /**
   * Notify a session that its token has been refreshed externally
   */
  async notifyTokenRefresh (sessionId: string, newToken: string, tokenResponse: any): Promise<void> {
    await this.messageBroker.publish(`mcp/session/${sessionId}/message`, {
      jsonrpc: '2.0',
      method: 'notifications/token_refreshed',
      params: {
        access_token: newToken,
        token_type: tokenResponse.token_type,
        expires_in: tokenResponse.expires_in,
        scope: tokenResponse.scope
      }
    })

    if (this.fastify) {
      this.fastify.log.info({ sessionId }, 'Token refresh notification sent to session')
    }
  }
}

/**
 * Fastify plugin to register the token refresh service
 */
export async function registerTokenRefreshService (
  fastify: FastifyInstance,
  options: TokenRefreshServiceOptions
): Promise<void> {
  const service = new TokenRefreshService(options)

  // Add service to Fastify instance
  fastify.decorate('tokenRefreshService', service)

  // Start the service when Fastify is ready
  fastify.ready(() => {
    service.start(fastify)
  })

  // Stop the service when Fastify closes
  fastify.addHook('onClose', async () => {
    await service.stop()
  })
}

// Type augmentation for Fastify
declare module 'fastify' {
  interface FastifyInstance {
    tokenRefreshService?: TokenRefreshService
  }
}
