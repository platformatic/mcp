import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { SessionStore } from '../stores/session-store.ts'
import type { MessageBroker } from '../brokers/message-broker.ts'
import { shouldAttemptRefresh, createTokenRefreshInfo } from './token-utils.ts'

export interface TokenRefreshServiceOptions {
  sessionStore: SessionStore
  messageBroker: MessageBroker
  oauthClient?: any // OAuth client for token refresh
  checkIntervalMs?: number // How often to check for tokens needing refresh
  refreshBufferMinutes?: number // How many minutes before expiry to refresh
}

/**
 * Background service that automatically refreshes tokens for active sessions
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

  constructor (options: TokenRefreshServiceOptions) {
    this.sessionStore = options.sessionStore
    this.messageBroker = options.messageBroker
    this.oauthClient = options.oauthClient
    this.checkIntervalMs = options.checkIntervalMs || 5 * 60 * 1000 // 5 minutes default
    this.refreshBufferMinutes = options.refreshBufferMinutes || 5 // 5 minutes default
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
        checkIntervalMs: this.checkIntervalMs,
        refreshBufferMinutes: this.refreshBufferMinutes
      }, 'Starting token refresh service')
    }

    // Start periodic check
    this.intervalId = setInterval(() => {
      this.checkAndRefreshTokens().catch(error => {
        if (fastify) {
          fastify.log.error({ error }, 'Token refresh check failed')
        }
      })
    }, this.checkIntervalMs)

    // Don't keep the process alive just for this interval
    this.intervalId.unref()
  }

  /**
   * Stop the token refresh service
   */
  stop (): void {
    if (!this.isRunning) {
      return
    }

    this.isRunning = false

    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = undefined
    }

    if (this.fastify) {
      this.fastify.log.info('Token refresh service stopped')
    }
  }

  /**
   * Check all active sessions and refresh tokens that are close to expiry
   */
  private async checkAndRefreshTokens (): Promise<void> {
    if (!this.oauthClient) {
      return // No OAuth client available for refresh
    }

    // This is a simplified implementation
    // In practice, you'd need a way to iterate through active sessions
    // Since our SessionStore interface doesn't include this, we'll need to add it
    // For now, we'll log that the service is running

    if (this.fastify) {
      this.fastify.log.debug('Token refresh service check completed')
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
    service.stop()
  })
}

// Type augmentation for Fastify
declare module 'fastify' {
  interface FastifyInstance {
    tokenRefreshService?: TokenRefreshService
  }
}
