import { test, describe } from 'node:test'
import * as assert from 'node:assert'
import Fastify from 'fastify'
import { MemorySessionStore } from '../src/stores/memory-session-store.ts'
import { MemoryMessageBroker } from '../src/brokers/memory-message-broker.ts'
import { TokenRefreshService } from '../src/auth/token-refresh-service.ts'
import type { AuthorizationContext, TokenRefreshInfo } from '../src/types/auth-types.ts'
import { hashToken } from '../src/auth/token-utils.ts'

describe('Token Refresh Service', () => {
  describe('TokenRefreshService', () => {
    test('should create token refresh service', () => {
      const sessionStore = new MemorySessionStore(100)
      const messageBroker = new MemoryMessageBroker()

      const service = new TokenRefreshService({
        sessionStore,
        messageBroker,
        checkIntervalMs: 1000,
        refreshBufferMinutes: 5
      })

      assert.ok(service)
    })

    test('should start and stop service', async (t) => {
      const fastify = Fastify()
      t.after(async () => {
        await fastify.close()
      })

      const sessionStore = new MemorySessionStore(100)
      const messageBroker = new MemoryMessageBroker()

      const service = new TokenRefreshService({
        sessionStore,
        messageBroker,
        checkIntervalMs: 100, // Short interval for testing
        refreshBufferMinutes: 5
      })

      // Start service
      service.start(fastify)

      // Stop service
      service.stop()
    })

    test('should handle manual token refresh', async (_t) => {
      const sessionStore = new MemorySessionStore(100)
      const messageBroker = new MemoryMessageBroker()

      // Mock OAuth client
      const mockOAuthClient = {
        refreshToken: async (refreshToken: string) => {
          assert.strictEqual(refreshToken, 'refresh-123')
          return {
            access_token: 'new-access-token',
            token_type: 'Bearer',
            expires_in: 3600,
            refresh_token: 'new-refresh-token',
            scope: 'read write'
          }
        }
      }

      const service = new TokenRefreshService({
        sessionStore,
        messageBroker,
        oauthClient: mockOAuthClient,
        checkIntervalMs: 1000,
        refreshBufferMinutes: 1 // Very short buffer for testing
      })

      // Create session with expiring token
      const session = {
        id: 'session-123',
        eventId: 0,
        createdAt: new Date(),
        lastActivity: new Date()
      }

      await sessionStore.create(session)

      // Add authorization context with soon-to-expire token
      const authContext: AuthorizationContext = {
        userId: 'user123',
        tokenHash: hashToken('old-token'),
        expiresAt: new Date(Date.now() + 30000) // 30 seconds from now (within buffer)
      }

      const refreshInfo: TokenRefreshInfo = {
        refreshToken: 'refresh-123',
        clientId: 'client456',
        authorizationServer: 'https://auth.example.com',
        scopes: ['read', 'write'],
        refreshAttempts: 0
      }

      await sessionStore.updateAuthorization(session.id, authContext, refreshInfo)

      // Attempt refresh
      const result = await service.refreshSessionToken(session.id)
      assert.strictEqual(result, true)

      // Verify session was updated
      const updatedSession = await sessionStore.get(session.id)
      assert.ok(updatedSession)
      assert.ok(updatedSession.authorization)
      assert.ok(updatedSession.authorization.expiresAt)
      assert.ok(updatedSession.authorization.expiresAt > new Date(Date.now() + 3000000)) // Should be much later
    })

    test('should not refresh token when not needed', async (_t) => {
      const sessionStore = new MemorySessionStore(100)
      const messageBroker = new MemoryMessageBroker()

      const mockOAuthClient = {
        refreshToken: async () => {
          assert.fail('Should not call refresh token')
        }
      }

      const service = new TokenRefreshService({
        sessionStore,
        messageBroker,
        oauthClient: mockOAuthClient,
        checkIntervalMs: 1000,
        refreshBufferMinutes: 5
      })

      // Create session with valid token (not expiring soon)
      const session = {
        id: 'session-123',
        eventId: 0,
        createdAt: new Date(),
        lastActivity: new Date()
      }

      await sessionStore.create(session)

      const authContext: AuthorizationContext = {
        userId: 'user123',
        tokenHash: hashToken('valid-token'),
        expiresAt: new Date(Date.now() + 3600000) // 1 hour from now
      }

      const refreshInfo: TokenRefreshInfo = {
        refreshToken: 'refresh-123',
        clientId: 'client456',
        authorizationServer: 'https://auth.example.com',
        scopes: ['read'],
        refreshAttempts: 0
      }

      await sessionStore.updateAuthorization(session.id, authContext, refreshInfo)

      // Attempt refresh - should return false (not needed)
      const result = await service.refreshSessionToken(session.id)
      assert.strictEqual(result, false)
    })

    test('should handle refresh failure and increment attempts', async (_t) => {
      const sessionStore = new MemorySessionStore(100)
      const messageBroker = new MemoryMessageBroker()

      const mockOAuthClient = {
        refreshToken: async () => {
          throw new Error('Refresh failed')
        }
      }

      const service = new TokenRefreshService({
        sessionStore,
        messageBroker,
        oauthClient: mockOAuthClient,
        checkIntervalMs: 1000,
        refreshBufferMinutes: 1
      })

      // Create session with expiring token
      const session = {
        id: 'session-123',
        eventId: 0,
        createdAt: new Date(),
        lastActivity: new Date()
      }

      await sessionStore.create(session)

      const authContext: AuthorizationContext = {
        userId: 'user123',
        tokenHash: hashToken('expiring-token'),
        expiresAt: new Date(Date.now() + 30000) // 30 seconds from now
      }

      const refreshInfo: TokenRefreshInfo = {
        refreshToken: 'refresh-123',
        clientId: 'client456',
        authorizationServer: 'https://auth.example.com',
        scopes: ['read'],
        refreshAttempts: 0
      }

      await sessionStore.updateAuthorization(session.id, authContext, refreshInfo)

      // Attempt refresh - should throw error
      try {
        await service.refreshSessionToken(session.id)
        assert.fail('Should have thrown an error')
      } catch (error) {
        assert.ok(error)
      }

      // Verify attempt count was incremented
      const updatedSession = await sessionStore.get(session.id)
      assert.ok(updatedSession)
      assert.ok(updatedSession.tokenRefresh)
      assert.strictEqual(updatedSession.tokenRefresh.refreshAttempts, 1)
    })

    test('should not refresh when too many attempts have been made', async (_t) => {
      const sessionStore = new MemorySessionStore(100)
      const messageBroker = new MemoryMessageBroker()

      const mockOAuthClient = {
        refreshToken: async () => {
          assert.fail('Should not call refresh token')
        }
      }

      const service = new TokenRefreshService({
        sessionStore,
        messageBroker,
        oauthClient: mockOAuthClient,
        checkIntervalMs: 1000,
        refreshBufferMinutes: 1
      })

      // Create session with expiring token but too many attempts
      const session = {
        id: 'session-123',
        eventId: 0,
        createdAt: new Date(),
        lastActivity: new Date()
      }

      await sessionStore.create(session)

      const authContext: AuthorizationContext = {
        userId: 'user123',
        tokenHash: hashToken('expiring-token'),
        expiresAt: new Date(Date.now() + 30000) // 30 seconds from now
      }

      const refreshInfo: TokenRefreshInfo = {
        refreshToken: 'refresh-123',
        clientId: 'client456',
        authorizationServer: 'https://auth.example.com',
        scopes: ['read'],
        refreshAttempts: 5 // Too many attempts
      }

      await sessionStore.updateAuthorization(session.id, authContext, refreshInfo)

      // Attempt refresh - should return false
      const result = await service.refreshSessionToken(session.id)
      assert.strictEqual(result, false)
    })

    test('should send token refresh notification', async (_t) => {
      const sessionStore = new MemorySessionStore(100)
      const messageBroker = new MemoryMessageBroker()

      const service = new TokenRefreshService({
        sessionStore,
        messageBroker,
        checkIntervalMs: 1000,
        refreshBufferMinutes: 5
      })

      let notificationReceived = false
      let receivedMessage: any = null

      // Subscribe to session messages
      await messageBroker.subscribe('mcp/session/session-123/message', (message) => {
        notificationReceived = true
        receivedMessage = message
      })

      // Send token refresh notification
      await service.notifyTokenRefresh('session-123', 'new-token', {
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'read write'
      })

      // Wait a bit for message to be processed
      await new Promise(resolve => setTimeout(resolve, 10))

      assert.strictEqual(notificationReceived, true)
      assert.ok(receivedMessage)
      assert.strictEqual(receivedMessage.jsonrpc, '2.0')
      assert.strictEqual(receivedMessage.method, 'notifications/token_refreshed')
      assert.ok(receivedMessage.params)
      assert.strictEqual(receivedMessage.params.access_token, 'new-token')
      assert.strictEqual(receivedMessage.params.token_type, 'Bearer')
      assert.strictEqual(receivedMessage.params.expires_in, 3600)
    })

    test('should handle session without authorization context', async (_t) => {
      const sessionStore = new MemorySessionStore(100)
      const messageBroker = new MemoryMessageBroker()

      const mockOAuthClient = {
        refreshToken: async () => ({ access_token: 'new-token' })
      }

      const service = new TokenRefreshService({
        sessionStore,
        messageBroker,
        oauthClient: mockOAuthClient, // Add OAuth client
        checkIntervalMs: 1000,
        refreshBufferMinutes: 5
      })

      // Create session without authorization context
      const session = {
        id: 'session-123',
        eventId: 0,
        createdAt: new Date(),
        lastActivity: new Date()
      }

      await sessionStore.create(session)

      // Attempt refresh - should return false (no auth context)
      const result = await service.refreshSessionToken(session.id)
      assert.strictEqual(result, false)
    })

    test('should handle non-existent session', async (_t) => {
      const sessionStore = new MemorySessionStore(100)
      const messageBroker = new MemoryMessageBroker()

      const mockOAuthClient = {
        refreshToken: async () => ({ access_token: 'new-token' })
      }

      const service = new TokenRefreshService({
        sessionStore,
        messageBroker,
        oauthClient: mockOAuthClient, // Add OAuth client
        checkIntervalMs: 1000,
        refreshBufferMinutes: 5
      })

      // Attempt refresh on non-existent session
      const result = await service.refreshSessionToken('non-existent-session')
      assert.strictEqual(result, false)
    })
  })
})
