import { test, describe, after } from 'node:test'
import * as assert from 'node:assert'
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici'
import Fastify from 'fastify'
import oauthClientPlugin from '../src/auth/oauth-client.ts'
import authRoutesPlugin from '../src/routes/auth-routes.ts'
import { MemorySessionStore } from '../src/stores/memory-session-store.ts'

const originalDispatcher = getGlobalDispatcher()
const mockAgent = new MockAgent()
mockAgent.disableNetConnect()
setGlobalDispatcher(mockAgent)

// Cleanup
after(async () => {
  await mockAgent.close()
  setGlobalDispatcher(originalDispatcher)
})

describe('OAuth Routes', () => {
  test('should initiate OAuth authorization flow', async (t) => {
    const fastify = Fastify()
    t.after(async () => {
      await fastify.close()
    })

    const config = {
      clientId: 'test-client',
      authorizationServer: 'https://auth.example.com'
    }

    await fastify.register(oauthClientPlugin, config)
    const sessionStore = new MemorySessionStore(100)
    await fastify.register(authRoutesPlugin, { sessionStore })

    const response = await fastify.inject({
      method: 'GET',
      url: '/oauth/authorize?resource=https://mcp.example.com'
    })

    assert.strictEqual(response.statusCode, 302)
    assert.ok(response.headers.location)

    const location = new URL(response.headers.location)
    assert.strictEqual(location.origin, 'https://auth.example.com')
    assert.strictEqual(location.pathname, '/oauth/authorize')
    assert.ok(location.searchParams.get('state'))
    assert.ok(location.searchParams.get('code_challenge'))
  })

  test('should handle OAuth callback with valid code', async (t) => {
    const mockPool = mockAgent.get('https://auth.example.com')
    mockPool.intercept({
      path: '/oauth/token',
      method: 'POST'
    }).reply(200, {
      access_token: 'callback-access-token',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'read'
    })

    const fastify = Fastify()
    t.after(async () => {
      await fastify.close()
    })

    const config = {
      clientId: 'test-client',
      clientSecret: 'test-secret',
      authorizationServer: 'https://auth.example.com'
    }

    await fastify.register(oauthClientPlugin, config)
    const sessionStore = new MemorySessionStore(100)
    await fastify.register(authRoutesPlugin, { sessionStore })

    // First, initiate the flow to get a valid state
    const authResponse = await fastify.inject({
      method: 'GET',
      url: '/oauth/authorize'
    })

    const location = new URL(authResponse.headers.location)
    const state = location.searchParams.get('state')

    // Then handle the callback
    const callbackResponse = await fastify.inject({
      method: 'GET',
      url: `/oauth/callback?code=test-code&state=${state}`
    })

    assert.strictEqual(callbackResponse.statusCode, 200)
    const body = JSON.parse(callbackResponse.body)
    assert.strictEqual(body.access_token, 'callback-access-token')
    assert.strictEqual(body.token_type, 'Bearer')
  })

  test('should handle OAuth callback with error', async (t) => {
    const fastify = Fastify()
    t.after(async () => {
      await fastify.close()
    })

    const config = {
      clientId: 'test-client',
      authorizationServer: 'https://auth.example.com'
    }

    await fastify.register(oauthClientPlugin, config)
    const sessionStore = new MemorySessionStore(100)
    await fastify.register(authRoutesPlugin, { sessionStore })

    const response = await fastify.inject({
      method: 'GET',
      url: '/oauth/callback?error=access_denied&error_description=User%20denied%20access'
    })

    assert.strictEqual(response.statusCode, 400)
    const body = JSON.parse(response.body)
    assert.strictEqual(body.error, 'access_denied')
    assert.strictEqual(body.error_description, 'User denied access')
  })

  test('should reject callback with missing parameters', async (t) => {
    const fastify = Fastify()
    t.after(async () => {
      await fastify.close()
    })

    const config = {
      clientId: 'test-client',
      authorizationServer: 'https://auth.example.com'
    }

    await fastify.register(oauthClientPlugin, config)
    const sessionStore = new MemorySessionStore(100)
    await fastify.register(authRoutesPlugin, { sessionStore })

    const response = await fastify.inject({
      method: 'GET',
      url: '/oauth/callback'
    })

    assert.strictEqual(response.statusCode, 400)
    const body = JSON.parse(response.body)
    assert.strictEqual(body.error, 'invalid_request')
    assert.ok(body.error_description.includes('Missing required parameters'))
  })

  test('should reject callback with invalid state', async (t) => {
    const fastify = Fastify()
    t.after(async () => {
      await fastify.close()
    })

    const config = {
      clientId: 'test-client',
      authorizationServer: 'https://auth.example.com'
    }

    await fastify.register(oauthClientPlugin, config)
    const sessionStore = new MemorySessionStore(100)
    await fastify.register(authRoutesPlugin, { sessionStore })

    const response = await fastify.inject({
      method: 'GET',
      url: '/oauth/callback?code=test-code&state=invalid-state'
    })

    assert.strictEqual(response.statusCode, 400)
    const body = JSON.parse(response.body)
    assert.strictEqual(body.error, 'invalid_request')
    assert.ok(body.error_description.includes('Invalid or expired state'))
  })

  test('should refresh token successfully', async (t) => {
    const mockPool = mockAgent.get('https://auth.example.com')
    mockPool.intercept({
      path: '/oauth/token',
      method: 'POST'
    }).reply(200, {
      access_token: 'refreshed-access-token',
      token_type: 'Bearer',
      expires_in: 3600
    })

    const fastify = Fastify()
    t.after(async () => {
      await fastify.close()
    })

    const config = {
      clientId: 'test-client',
      clientSecret: 'test-secret',
      authorizationServer: 'https://auth.example.com'
    }

    await fastify.register(oauthClientPlugin, config)
    const sessionStore = new MemorySessionStore(100)
    await fastify.register(authRoutesPlugin, { sessionStore })

    const response = await fastify.inject({
      method: 'POST',
      url: '/oauth/refresh',
      payload: { refresh_token: 'test-refresh-token' }
    })

    assert.strictEqual(response.statusCode, 200)
    const body = JSON.parse(response.body)
    assert.strictEqual(body.access_token, 'refreshed-access-token')
    assert.strictEqual(body.token_type, 'Bearer')
  })

  test('should handle refresh token failure', async (t) => {
    const mockPool = mockAgent.get('https://auth.example.com')
    mockPool.intercept({
      path: '/oauth/token',
      method: 'POST'
    }).reply(400, {
      error: 'invalid_grant'
    })

    const fastify = Fastify()
    t.after(async () => {
      await fastify.close()
    })

    const config = {
      clientId: 'test-client',
      authorizationServer: 'https://auth.example.com'
    }

    await fastify.register(oauthClientPlugin, config)
    const sessionStore = new MemorySessionStore(100)
    await fastify.register(authRoutesPlugin, { sessionStore })

    const response = await fastify.inject({
      method: 'POST',
      url: '/oauth/refresh',
      payload: { refresh_token: 'invalid-refresh-token' }
    })

    assert.strictEqual(response.statusCode, 400)
    const body = JSON.parse(response.body)
    assert.strictEqual(body.error, 'invalid_grant')
  })

  test('should validate token successfully', async (t) => {
    const mockPool = mockAgent.get('https://auth.example.com')
    mockPool.intercept({
      path: '/oauth/introspect',
      method: 'POST'
    }).reply(200, {
      active: true
    })

    const fastify = Fastify()
    t.after(async () => {
      await fastify.close()
    })

    const config = {
      clientId: 'test-client',
      authorizationServer: 'https://auth.example.com'
    }

    await fastify.register(oauthClientPlugin, config)
    const sessionStore = new MemorySessionStore(100)
    await fastify.register(authRoutesPlugin, { sessionStore })

    const response = await fastify.inject({
      method: 'POST',
      url: '/oauth/validate',
      payload: { token: 'test-token' }
    })

    assert.strictEqual(response.statusCode, 200)
    const body = JSON.parse(response.body)
    assert.strictEqual(body.active, true)
  })

  test('should check authorization status with valid token', async (t) => {
    const mockPool = mockAgent.get('https://auth.example.com')
    mockPool.intercept({
      path: '/oauth/introspect',
      method: 'POST'
    }).reply(200, {
      active: true
    })

    const fastify = Fastify()
    t.after(async () => {
      await fastify.close()
    })

    const config = {
      clientId: 'test-client',
      authorizationServer: 'https://auth.example.com'
    }

    await fastify.register(oauthClientPlugin, config)
    const sessionStore = new MemorySessionStore(100)
    await fastify.register(authRoutesPlugin, { sessionStore })

    const response = await fastify.inject({
      method: 'GET',
      url: '/oauth/status',
      headers: {
        authorization: 'Bearer test-token'
      }
    })

    assert.strictEqual(response.statusCode, 200)
    const body = JSON.parse(response.body)
    assert.strictEqual(body.authenticated, true)
  })

  test('should check authorization status without token', async (t) => {
    const fastify = Fastify()
    t.after(async () => {
      await fastify.close()
    })

    const config = {
      clientId: 'test-client',
      authorizationServer: 'https://auth.example.com'
    }

    await fastify.register(oauthClientPlugin, config)
    const sessionStore = new MemorySessionStore(100)
    await fastify.register(authRoutesPlugin, { sessionStore })

    const response = await fastify.inject({
      method: 'GET',
      url: '/oauth/status'
    })

    assert.strictEqual(response.statusCode, 200)
    const body = JSON.parse(response.body)
    assert.strictEqual(body.authenticated, false)
  })

  test('should handle dynamic client registration', async (t) => {
    const mockPool = mockAgent.get('https://auth.example.com')
    mockPool.intercept({
      path: '/oauth/register',
      method: 'POST'
    }).reply(200, {
      client_id: 'dynamic-client-id',
      client_secret: 'dynamic-client-secret'
    })

    const fastify = Fastify()
    t.after(async () => {
      await fastify.close()
    })

    const config = {
      authorizationServer: 'https://auth.example.com',
      dynamicRegistration: true
    }

    await fastify.register(oauthClientPlugin, config)
    const sessionStore = new MemorySessionStore(100)
    await fastify.register(authRoutesPlugin, { sessionStore })

    const response = await fastify.inject({
      method: 'POST',
      url: '/oauth/register'
    })

    assert.strictEqual(response.statusCode, 200)
    const body = JSON.parse(response.body)
    assert.strictEqual(body.client_id, 'dynamic-client-id')
    assert.strictEqual(body.client_secret, 'dynamic-client-secret')
    assert.strictEqual(body.registration_status, 'success')
  })

  test('should handle logout request', async (t) => {
    const fastify = Fastify()
    t.after(async () => {
      await fastify.close()
    })

    const config = {
      clientId: 'test-client',
      authorizationServer: 'https://auth.example.com'
    }

    await fastify.register(oauthClientPlugin, config)
    const sessionStore = new MemorySessionStore(100)
    await fastify.register(authRoutesPlugin, { sessionStore })

    const response = await fastify.inject({
      method: 'POST',
      url: '/oauth/logout',
      headers: {
        authorization: 'Bearer test-token'
      }
    })

    assert.strictEqual(response.statusCode, 200)
    const body = JSON.parse(response.body)
    assert.strictEqual(body.logout_status, 'success')
  })

  test('should reject logout without authorization header', async (t) => {
    const fastify = Fastify()
    t.after(async () => {
      await fastify.close()
    })

    const config = {
      clientId: 'test-client',
      authorizationServer: 'https://auth.example.com'
    }

    await fastify.register(oauthClientPlugin, config)
    const sessionStore = new MemorySessionStore(100)
    await fastify.register(authRoutesPlugin, { sessionStore })

    const response = await fastify.inject({
      method: 'POST',
      url: '/oauth/logout'
    })

    assert.strictEqual(response.statusCode, 400)
    const body = JSON.parse(response.body)
    assert.strictEqual(body.error, 'invalid_request')
  })

  test('should redirect callback with original URL', async (t) => {
    const mockPool = mockAgent.get('https://auth.example.com')
    mockPool.intercept({
      path: '/oauth/token',
      method: 'POST'
    }).reply(200, {
      access_token: 'redirect-access-token',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'read'
    })

    const fastify = Fastify()
    t.after(async () => {
      await fastify.close()
    })

    const config = {
      clientId: 'test-client',
      clientSecret: 'test-secret',
      authorizationServer: 'https://auth.example.com'
    }

    await fastify.register(oauthClientPlugin, config)
    const sessionStore = new MemorySessionStore(100)
    await fastify.register(authRoutesPlugin, { sessionStore })

    // Initiate flow with redirect URI
    const authResponse = await fastify.inject({
      method: 'GET',
      url: '/oauth/authorize?redirect_uri=https://client.example.com/callback'
    })

    const location = new URL(authResponse.headers.location)
    const state = location.searchParams.get('state')

    // Handle callback
    const callbackResponse = await fastify.inject({
      method: 'GET',
      url: `/oauth/callback?code=test-code&state=${state}`
    })

    assert.strictEqual(callbackResponse.statusCode, 302)
    const redirectUrl = new URL(callbackResponse.headers.location)
    assert.strictEqual(redirectUrl.origin, 'https://client.example.com')
    assert.strictEqual(redirectUrl.pathname, '/callback')
    assert.strictEqual(redirectUrl.searchParams.get('access_token'), 'redirect-access-token')
  })
})

describe('OAuth Routes Error Handling', () => {
  test('should handle authorization flow errors gracefully', async (t) => {
    const fastify = Fastify()
    t.after(async () => {
      await fastify.close()
    })

    const config = {
      clientId: 'test-client',
      authorizationServer: 'https://auth.example.com'
    }

    await fastify.register(oauthClientPlugin, config)

    // Mock the OAuth client method to throw an error
    fastify.oauthClient.createAuthorizationRequest = async () => {
      throw new Error('Authorization server unreachable')
    }

    const sessionStore = new MemorySessionStore(100)
    await fastify.register(authRoutesPlugin, { sessionStore })

    const response = await fastify.inject({
      method: 'GET',
      url: '/oauth/authorize'
    })

    assert.strictEqual(response.statusCode, 500)
    const body = JSON.parse(response.body)
    assert.strictEqual(body.error, 'authorization_failed')
  })

  test('should handle token exchange errors', async (t) => {
    const mockPool = mockAgent.get('https://auth.example.com')
    mockPool.intercept({
      path: '/oauth/token',
      method: 'POST'
    }).reply(500, 'Internal Server Error')

    const fastify = Fastify()
    t.after(async () => {
      await fastify.close()
    })

    const config = {
      clientId: 'test-client',
      clientSecret: 'test-secret',
      authorizationServer: 'https://auth.example.com'
    }

    await fastify.register(oauthClientPlugin, config)
    const sessionStore = new MemorySessionStore(100)
    await fastify.register(authRoutesPlugin, { sessionStore })

    // Initiate flow to get valid state
    const authResponse = await fastify.inject({
      method: 'GET',
      url: '/oauth/authorize'
    })

    const location = new URL(authResponse.headers.location)
    const state = location.searchParams.get('state')

    // Handle callback with server error
    const callbackResponse = await fastify.inject({
      method: 'GET',
      url: `/oauth/callback?code=test-code&state=${state}`
    })

    assert.strictEqual(callbackResponse.statusCode, 500)
    const body = JSON.parse(callbackResponse.body)
    assert.strictEqual(body.error, 'token_exchange_failed')
  })

  test('should handle validation errors gracefully', async (t) => {
    const fastify = Fastify()
    t.after(async () => {
      await fastify.close()
    })

    const config = {
      clientId: 'test-client',
      authorizationServer: 'https://auth.example.com'
    }

    await fastify.register(oauthClientPlugin, config)
    const sessionStore = new MemorySessionStore(100)
    await fastify.register(authRoutesPlugin, { sessionStore })

    const response = await fastify.inject({
      method: 'POST',
      url: '/oauth/validate',
      payload: {} // Missing token
    })

    assert.strictEqual(response.statusCode, 400)
    const body = JSON.parse(response.body)
    assert.strictEqual(body.error, 'invalid_request')
  })
})
