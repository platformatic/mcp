import { test, describe, after } from 'node:test'
import * as assert from 'node:assert'
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici'
import Fastify from 'fastify'
import { MemorySessionStore } from '../src/stores/memory-session-store.ts'
import { createAuthorizationContext, hashToken, createTokenRefreshInfo, isTokenExpiring, shouldAttemptRefresh } from '../src/auth/token-utils.ts'
import { createSessionAuthPreHandler } from '../src/auth/session-auth-prehandler.ts'
import { TokenValidator } from '../src/auth/token-validator.ts'
import type { AuthorizationContext, TokenRefreshInfo } from '../src/types/auth-types.ts'

const originalDispatcher = getGlobalDispatcher()
const mockAgent = new MockAgent()
mockAgent.disableNetConnect()
setGlobalDispatcher(mockAgent)

// Cleanup
after(async () => {
  await mockAgent.close()
  setGlobalDispatcher(originalDispatcher)
})

describe('Phase 3: Session-Based Authorization', () => {
  describe('Token Utilities', () => {
    test('should hash token consistently', (t) => {
      const token = 'test-token-123'
      const hash1 = hashToken(token)
      const hash2 = hashToken(token)

      assert.strictEqual(hash1, hash2)
      assert.strictEqual(hash1.length, 64) // SHA-256 hex length
      assert.notEqual(hash1, token) // Should be different from original
    })

    test('should create authorization context from token payload', (t) => {
      const tokenPayload = {
        sub: 'user123',
        client_id: 'client456',
        scope: 'read write',
        aud: 'https://api.example.com',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        iss: 'https://auth.example.com'
      }

      const token = 'test-access-token'
      const context = createAuthorizationContext(tokenPayload, token, {
        refreshToken: 'refresh-123',
        authorizationServer: 'https://auth.example.com'
      })

      assert.strictEqual(context.userId, 'user123')
      assert.strictEqual(context.clientId, 'client456')
      assert.deepStrictEqual(context.scopes, ['read', 'write'])
      assert.deepStrictEqual(context.audience, ['https://api.example.com'])
      assert.strictEqual(context.tokenType, 'Bearer')
      assert.strictEqual(context.tokenHash, hashToken(token))
      assert.strictEqual(context.refreshToken, 'refresh-123')
      assert.strictEqual(context.authorizationServer, 'https://auth.example.com')
    })

    test('should create token refresh info', (t) => {
      const refreshInfo = createTokenRefreshInfo(
        'refresh-token-123',
        'client-456',
        'https://auth.example.com',
        ['read', 'write']
      )

      assert.strictEqual(refreshInfo.refreshToken, 'refresh-token-123')
      assert.strictEqual(refreshInfo.clientId, 'client-456')
      assert.strictEqual(refreshInfo.authorizationServer, 'https://auth.example.com')
      assert.deepStrictEqual(refreshInfo.scopes, ['read', 'write'])
      assert.ok(refreshInfo.lastRefreshAt instanceof Date)
      assert.strictEqual(refreshInfo.refreshAttempts, 0)
    })

    test('should detect expiring tokens', (t) => {
      const now = new Date()
      const soonExpiring = new Date(now.getTime() + 3 * 60 * 1000) // 3 minutes from now
      const notExpiring = new Date(now.getTime() + 30 * 60 * 1000) // 30 minutes from now

      const expiringContext: AuthorizationContext = {
        userId: 'user123',
        expiresAt: soonExpiring
      }

      const validContext: AuthorizationContext = {
        userId: 'user123',
        expiresAt: notExpiring
      }

      assert.strictEqual(isTokenExpiring(expiringContext), true)
      assert.strictEqual(isTokenExpiring(validContext), false)
    })

    test('should determine when to attempt refresh', (t) => {
      const now = new Date()
      const soonExpiring = new Date(now.getTime() + 3 * 60 * 1000) // 3 minutes from now

      const expiringContext: AuthorizationContext = {
        userId: 'user123',
        expiresAt: soonExpiring
      }

      const refreshInfo: TokenRefreshInfo = {
        refreshToken: 'refresh-123',
        clientId: 'client-456',
        authorizationServer: 'https://auth.example.com',
        scopes: ['read'],
        refreshAttempts: 0
      }

      const noRefreshInfo: TokenRefreshInfo = {
        refreshToken: 'refresh-123',
        clientId: 'client-456',
        authorizationServer: 'https://auth.example.com',
        scopes: ['read'],
        refreshAttempts: 5 // Too many attempts
      }

      assert.strictEqual(shouldAttemptRefresh(expiringContext, refreshInfo), true)
      assert.strictEqual(shouldAttemptRefresh(expiringContext, noRefreshInfo), false)
      assert.strictEqual(shouldAttemptRefresh(expiringContext), false) // No refresh info
    })
  })

  describe('Session Store Token Mapping', () => {
    test('should add and retrieve token-to-session mapping', async (t) => {
      const store = new MemorySessionStore(100)
      const tokenHash = hashToken('test-token')

      const session = {
        id: 'session-123',
        eventId: 0,
        createdAt: new Date(),
        lastActivity: new Date()
      }

      await store.create(session)
      await store.addTokenMapping(tokenHash, session.id)

      const retrievedSession = await store.getSessionByTokenHash(tokenHash)
      assert.ok(retrievedSession)
      assert.strictEqual(retrievedSession.id, session.id)
    })

    test('should update authorization context and maintain token mapping', async (t) => {
      const store = new MemorySessionStore(100)
      const token1 = 'old-token'
      const token2 = 'new-token'
      const tokenHash1 = hashToken(token1)
      const tokenHash2 = hashToken(token2)

      const session = {
        id: 'session-123',
        eventId: 0,
        createdAt: new Date(),
        lastActivity: new Date()
      }

      await store.create(session)

      // Add initial authorization
      const authContext1: AuthorizationContext = {
        userId: 'user123',
        tokenHash: tokenHash1
      }
      await store.updateAuthorization(session.id, authContext1)

      // Verify initial mapping
      const retrievedSession = await store.getSessionByTokenHash(tokenHash1)
      assert.ok(retrievedSession)
      assert.strictEqual(retrievedSession.authorization?.tokenHash, tokenHash1)

      // Update with new token
      const authContext2: AuthorizationContext = {
        userId: 'user123',
        tokenHash: tokenHash2
      }
      await store.updateAuthorization(session.id, authContext2)

      // Verify old mapping is removed and new mapping exists
      const oldSession = await store.getSessionByTokenHash(tokenHash1)
      assert.strictEqual(oldSession, null)

      const newSession = await store.getSessionByTokenHash(tokenHash2)
      assert.ok(newSession)
      assert.strictEqual(newSession.authorization?.tokenHash, tokenHash2)
    })

    test('should clean up token mappings when session is deleted', async (t) => {
      const store = new MemorySessionStore(100)
      const tokenHash = hashToken('test-token')

      const session = {
        id: 'session-123',
        eventId: 0,
        createdAt: new Date(),
        lastActivity: new Date(),
        authorization: {
          userId: 'user123',
          tokenHash
        }
      }

      await store.create(session)
      await store.addTokenMapping(tokenHash, session.id)

      // Verify mapping exists
      const retrievedSession = await store.getSessionByTokenHash(tokenHash)
      assert.ok(retrievedSession)

      // Delete session
      await store.delete(session.id)

      // Verify mapping is cleaned up
      const deletedSession = await store.getSessionByTokenHash(tokenHash)
      assert.strictEqual(deletedSession, null)
    })
  })

  describe('Session-Aware Authorization PreHandler', () => {
    test('should create session-aware prehandler', async (t) => {
      const fastify = Fastify()
      t.after(async () => {
        await fastify.close()
      })

      const config = {
        enabled: true,
        authorizationServers: ['https://auth.example.com'],
        resourceUri: 'https://api.example.com',
        tokenValidation: {
          jwksUri: 'https://auth.example.com/.well-known/jwks.json',
          validateAudience: true
        }
      }

      const sessionStore = new MemorySessionStore(100)
      const tokenValidator = new TokenValidator(config, fastify)

      const preHandler = createSessionAuthPreHandler({
        config,
        tokenValidator,
        sessionStore
      })

      fastify.addHook('preHandler', preHandler)
      fastify.get('/test', async () => ({ message: 'success' }))

      // Test without authorization header
      const response1 = await fastify.inject({
        method: 'GET',
        url: '/test'
      })

      assert.strictEqual(response1.statusCode, 401)
      const body1 = JSON.parse(response1.body)
      assert.strictEqual(body1.error, 'authorization_required')
    })

    test('should skip authorization for well-known endpoints', async (t) => {
      const fastify = Fastify()
      t.after(async () => {
        await fastify.close()
      })

      const config = {
        enabled: true,
        authorizationServers: ['https://auth.example.com'],
        resourceUri: 'https://api.example.com',
        tokenValidation: {
          jwksUri: 'https://auth.example.com/.well-known/jwks.json',
          validateAudience: true
        }
      }

      const sessionStore = new MemorySessionStore(100)
      const tokenValidator = new TokenValidator(config, fastify)

      const preHandler = createSessionAuthPreHandler({
        config,
        tokenValidator,
        sessionStore
      })

      fastify.addHook('preHandler', preHandler)
      fastify.get('/.well-known/test', async () => ({ message: 'public' }))

      // Should work without authorization
      const response = await fastify.inject({
        method: 'GET',
        url: '/.well-known/test'
      })

      assert.strictEqual(response.statusCode, 200)
      const body = JSON.parse(response.body)
      assert.strictEqual(body.message, 'public')
    })

    test('should handle invalid bearer token format', async (t) => {
      const fastify = Fastify()
      t.after(async () => {
        await fastify.close()
      })

      const config = {
        enabled: true,
        authorizationServers: ['https://auth.example.com'],
        resourceUri: 'https://api.example.com',
        tokenValidation: {
          jwksUri: 'https://auth.example.com/.well-known/jwks.json',
          validateAudience: true
        }
      }

      const sessionStore = new MemorySessionStore(100)
      const tokenValidator = new TokenValidator(config, fastify)

      const preHandler = createSessionAuthPreHandler({
        config,
        tokenValidator,
        sessionStore
      })

      fastify.addHook('preHandler', preHandler)
      fastify.get('/test', async () => ({ message: 'success' }))

      // Test with invalid bearer format
      const response = await fastify.inject({
        method: 'GET',
        url: '/test',
        headers: {
          authorization: 'Invalid token-format'
        }
      })

      assert.strictEqual(response.statusCode, 401)
      const body = JSON.parse(response.body)
      assert.strictEqual(body.error, 'invalid_token')
      assert.strictEqual(body.error_description, 'Authorization header must use Bearer scheme')
    })

    test('should handle empty bearer token', async (t) => {
      const fastify = Fastify()
      t.after(async () => {
        await fastify.close()
      })

      const config = {
        enabled: true,
        authorizationServers: ['https://auth.example.com'],
        resourceUri: 'https://api.example.com',
        tokenValidation: {
          jwksUri: 'https://auth.example.com/.well-known/jwks.json',
          validateAudience: true
        }
      }

      const sessionStore = new MemorySessionStore(100)
      const tokenValidator = new TokenValidator(config, fastify)

      const preHandler = createSessionAuthPreHandler({
        config,
        tokenValidator,
        sessionStore
      })

      fastify.addHook('preHandler', preHandler)
      fastify.get('/test', async () => ({ message: 'success' }))

      // Test with empty bearer token
      const response = await fastify.inject({
        method: 'GET',
        url: '/test',
        headers: {
          authorization: 'Bearer '
        }
      })

      assert.strictEqual(response.statusCode, 401)
      const body = JSON.parse(response.body)
      assert.strictEqual(body.error, 'invalid_token')
      assert.strictEqual(body.error_description, 'Bearer token is empty')
    })
  })

  describe('Authorization Context Integration', () => {
    test('should maintain authorization context across requests', async (t) => {
      const sessionStore = new MemorySessionStore(100)
      const token = 'test-access-token'
      const tokenHash = hashToken(token)

      // Create a session with authorization context
      const authContext: AuthorizationContext = {
        userId: 'user123',
        clientId: 'client456',
        scopes: ['read', 'write'],
        tokenHash,
        expiresAt: new Date(Date.now() + 3600000) // 1 hour from now
      }

      const session = {
        id: 'session-123',
        eventId: 0,
        createdAt: new Date(),
        lastActivity: new Date(),
        authorization: authContext
      }

      await sessionStore.create(session)

      // Add token mapping (this would normally be done by updateAuthorization)
      await sessionStore.addTokenMapping(tokenHash, session.id)

      // Verify session can be retrieved by token hash
      const retrievedSession = await sessionStore.getSessionByTokenHash(tokenHash)
      assert.ok(retrievedSession)
      assert.strictEqual(retrievedSession.authorization?.userId, 'user123')
      assert.strictEqual(retrievedSession.authorization?.clientId, 'client456')
      assert.deepStrictEqual(retrievedSession.authorization?.scopes, ['read', 'write'])
    })

    test('should handle token refresh context updates', async (t) => {
      const sessionStore = new MemorySessionStore(100)
      const oldToken = 'old-token'
      const newToken = 'new-token'

      const session = {
        id: 'session-123',
        eventId: 0,
        createdAt: new Date(),
        lastActivity: new Date()
      }

      await sessionStore.create(session)

      // Set initial authorization
      const initialAuth: AuthorizationContext = {
        userId: 'user123',
        tokenHash: hashToken(oldToken),
        expiresAt: new Date(Date.now() + 300000) // 5 minutes from now
      }

      const refreshInfo: TokenRefreshInfo = {
        refreshToken: 'refresh-123',
        clientId: 'client456',
        authorizationServer: 'https://auth.example.com',
        scopes: ['read'],
        refreshAttempts: 0
      }

      await sessionStore.updateAuthorization(session.id, initialAuth, refreshInfo)

      // Simulate token refresh
      const newAuth: AuthorizationContext = {
        userId: 'user123',
        tokenHash: hashToken(newToken),
        expiresAt: new Date(Date.now() + 3600000) // 1 hour from now
      }

      const updatedRefreshInfo: TokenRefreshInfo = {
        ...refreshInfo,
        lastRefreshAt: new Date(),
        refreshAttempts: 0
      }

      await sessionStore.updateAuthorization(session.id, newAuth, updatedRefreshInfo)

      // Verify old token mapping is gone and new one exists
      const oldSession = await sessionStore.getSessionByTokenHash(hashToken(oldToken))
      assert.strictEqual(oldSession, null)

      const newSession = await sessionStore.getSessionByTokenHash(hashToken(newToken))
      assert.ok(newSession)
      assert.strictEqual(newSession.authorization?.tokenHash, hashToken(newToken))
      assert.ok(newSession.tokenRefresh?.lastRefreshAt)
    })
  })
})
