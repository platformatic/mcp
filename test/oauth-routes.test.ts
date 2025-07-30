import { test } from 'node:test'
import * as assert from 'node:assert'
import { MockAgent, setGlobalDispatcher } from 'undici'
import Fastify from 'fastify'
import oauthClientPlugin from '../src/auth/oauth-client.ts'
import { registerAuthRoutes } from '../src/routes/auth-routes.ts'

const mockAgent = new MockAgent()
setGlobalDispatcher(mockAgent)

test('OAuth Routes', async (t) => {
  await t.test('should initiate OAuth authorization flow', async () => {
    const fastify = Fastify()
    const config = {
      clientId: 'test-client',
      authorizationServer: 'https://auth.example.com'
    }
    
    await fastify.register(oauthClientPlugin, config)
    await registerAuthRoutes(fastify)
    
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
    
    await fastify.close()
  })

  await t.test('should handle OAuth callback with valid code', async () => {
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
    const config = {
      clientId: 'test-client',
      clientSecret: 'test-secret',
      authorizationServer: 'https://auth.example.com'
    }
    
    await fastify.register(oauthClientPlugin, config)
    await registerAuthRoutes(fastify)
    
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
    
    await fastify.close()
  })

  await t.test('should handle OAuth callback with error', async () => {
    const fastify = Fastify()
    const config = {
      clientId: 'test-client',
      authorizationServer: 'https://auth.example.com'
    }
    
    await fastify.register(oauthClientPlugin, config)
    await registerAuthRoutes(fastify)
    
    const response = await fastify.inject({
      method: 'GET',
      url: '/oauth/callback?error=access_denied&error_description=User%20denied%20access'
    })
    
    assert.strictEqual(response.statusCode, 400)
    const body = JSON.parse(response.body)
    assert.strictEqual(body.error, 'access_denied')
    assert.strictEqual(body.error_description, 'User denied access')
    
    await fastify.close()
  })

  await t.test('should reject callback with missing parameters', async () => {
    const fastify = Fastify()
    const config = {
      clientId: 'test-client',
      authorizationServer: 'https://auth.example.com'
    }
    
    await fastify.register(oauthClientPlugin, config)
    await registerAuthRoutes(fastify)
    
    const response = await fastify.inject({
      method: 'GET',
      url: '/oauth/callback'
    })
    
    assert.strictEqual(response.statusCode, 400)
    const body = JSON.parse(response.body)
    assert.strictEqual(body.error, 'invalid_request')
    assert.ok(body.error_description.includes('Missing required parameters'))
    
    await fastify.close()
  })

  await t.test('should reject callback with invalid state', async () => {
    const fastify = Fastify()
    const config = {
      clientId: 'test-client',
      authorizationServer: 'https://auth.example.com'
    }
    
    await fastify.register(oauthClientPlugin, config)
    await registerAuthRoutes(fastify)
    
    const response = await fastify.inject({
      method: 'GET',
      url: '/oauth/callback?code=test-code&state=invalid-state'
    })
    
    assert.strictEqual(response.statusCode, 400)
    const body = JSON.parse(response.body)
    assert.strictEqual(body.error, 'invalid_request')
    assert.ok(body.error_description.includes('Invalid or expired state'))
    
    await fastify.close()
  })

  await t.test('should refresh token successfully', async () => {
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
    const config = {
      clientId: 'test-client',
      clientSecret: 'test-secret',
      authorizationServer: 'https://auth.example.com'
    }
    
    await fastify.register(oauthClientPlugin, config)
    await registerAuthRoutes(fastify)
    
    const response = await fastify.inject({
      method: 'POST',
      url: '/oauth/refresh',
      payload: { refresh_token: 'test-refresh-token' }
    })
    
    assert.strictEqual(response.statusCode, 200)
    const body = JSON.parse(response.body)
    assert.strictEqual(body.access_token, 'refreshed-access-token')
    assert.strictEqual(body.token_type, 'Bearer')
    
    await fastify.close()
  })

  await t.test('should handle refresh token failure', async () => {
    const mockPool = mockAgent.get('https://auth.example.com')
    mockPool.intercept({
      path: '/oauth/token',
      method: 'POST'
    }).reply(400, {
      error: 'invalid_grant'
    })

    const fastify = Fastify()
    const config = {
      clientId: 'test-client',
      authorizationServer: 'https://auth.example.com'
    }
    
    await fastify.register(oauthClientPlugin, config)
    await registerAuthRoutes(fastify)
    
    const response = await fastify.inject({
      method: 'POST',
      url: '/oauth/refresh',
      payload: { refresh_token: 'invalid-refresh-token' }
    })
    
    assert.strictEqual(response.statusCode, 400)
    const body = JSON.parse(response.body)
    assert.strictEqual(body.error, 'invalid_grant')
    
    await fastify.close()
  })

  await t.test('should validate token successfully', async () => {
    const mockPool = mockAgent.get('https://auth.example.com')
    mockPool.intercept({
      path: '/oauth/introspect',
      method: 'POST'
    }).reply(200, {
      active: true
    })

    const fastify = Fastify()
    const config = {
      clientId: 'test-client',
      authorizationServer: 'https://auth.example.com'
    }
    
    await fastify.register(oauthClientPlugin, config)
    await registerAuthRoutes(fastify)
    
    const response = await fastify.inject({
      method: 'POST',
      url: '/oauth/validate',
      payload: { token: 'test-token' }
    })
    
    assert.strictEqual(response.statusCode, 200)
    const body = JSON.parse(response.body)
    assert.strictEqual(body.active, true)
    
    await fastify.close()
  })

  await t.test('should check authorization status with valid token', async () => {
    const mockPool = mockAgent.get('https://auth.example.com')
    mockPool.intercept({
      path: '/oauth/introspect',
      method: 'POST'
    }).reply(200, {
      active: true
    })

    const fastify = Fastify()
    const config = {
      clientId: 'test-client',
      authorizationServer: 'https://auth.example.com'
    }
    
    await fastify.register(oauthClientPlugin, config)
    await registerAuthRoutes(fastify)
    
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
    
    await fastify.close()
  })

  await t.test('should check authorization status without token', async () => {
    const fastify = Fastify()
    const config = {
      clientId: 'test-client',
      authorizationServer: 'https://auth.example.com'
    }
    
    await fastify.register(oauthClientPlugin, config)
    await registerAuthRoutes(fastify)
    
    const response = await fastify.inject({
      method: 'GET',
      url: '/oauth/status'
    })
    
    assert.strictEqual(response.statusCode, 200)
    const body = JSON.parse(response.body)
    assert.strictEqual(body.authenticated, false)
    
    await fastify.close()
  })

  await t.test('should handle dynamic client registration', async () => {
    const mockPool = mockAgent.get('https://auth.example.com')
    mockPool.intercept({
      path: '/oauth/register',
      method: 'POST'
    }).reply(200, {
      client_id: 'dynamic-client-id',
      client_secret: 'dynamic-client-secret'
    })

    const fastify = Fastify()
    const config = {
      authorizationServer: 'https://auth.example.com',
      dynamicRegistration: true
    }
    
    await fastify.register(oauthClientPlugin, config)
    await registerAuthRoutes(fastify)
    
    const response = await fastify.inject({
      method: 'POST',
      url: '/oauth/register'
    })
    
    assert.strictEqual(response.statusCode, 200)
    const body = JSON.parse(response.body)
    assert.strictEqual(body.client_id, 'dynamic-client-id')
    assert.strictEqual(body.client_secret, 'dynamic-client-secret')
    assert.strictEqual(body.registration_status, 'success')
    
    await fastify.close()
  })

  await t.test('should handle logout request', async () => {
    const fastify = Fastify()
    const config = {
      clientId: 'test-client',
      authorizationServer: 'https://auth.example.com'
    }
    
    await fastify.register(oauthClientPlugin, config)
    await registerAuthRoutes(fastify)
    
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
    
    await fastify.close()
  })

  await t.test('should reject logout without authorization header', async () => {
    const fastify = Fastify()
    const config = {
      clientId: 'test-client',
      authorizationServer: 'https://auth.example.com'
    }
    
    await fastify.register(oauthClientPlugin, config)
    await registerAuthRoutes(fastify)
    
    const response = await fastify.inject({
      method: 'POST',
      url: '/oauth/logout'
    })
    
    assert.strictEqual(response.statusCode, 400)
    const body = JSON.parse(response.body)
    assert.strictEqual(body.error, 'invalid_request')
    
    await fastify.close()
  })

  await t.test('should redirect callback with original URL', async () => {
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
    const config = {
      clientId: 'test-client',
      clientSecret: 'test-secret',
      authorizationServer: 'https://auth.example.com'
    }
    
    await fastify.register(oauthClientPlugin, config)
    await registerAuthRoutes(fastify)
    
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
    
    await fastify.close()
  })
})

test('OAuth Routes Error Handling', async (t) => {
  await t.test('should handle authorization flow errors gracefully', async () => {
    const fastify = Fastify()
    const config = {
      clientId: 'test-client',
      authorizationServer: 'https://auth.example.com'
    }
    
    await fastify.register(oauthClientPlugin, config)
    
    // Mock the OAuth client method to throw an error
    const originalCreateAuthRequest = fastify.oauthClient.createAuthorizationRequest
    fastify.oauthClient.createAuthorizationRequest = async () => {
      throw new Error('Authorization server unreachable')
    }
    
    await registerAuthRoutes(fastify)
    
    const response = await fastify.inject({
      method: 'GET',
      url: '/oauth/authorize'
    })
    
    assert.strictEqual(response.statusCode, 500)
    const body = JSON.parse(response.body)
    assert.strictEqual(body.error, 'authorization_failed')
    
    await fastify.close()
  })

  await t.test('should handle token exchange errors', async () => {
    const mockPool = mockAgent.get('https://auth.example.com')
    mockPool.intercept({
      path: '/oauth/token',
      method: 'POST'
    }).reply(500, 'Internal Server Error')

    const fastify = Fastify()
    const config = {
      clientId: 'test-client',
      clientSecret: 'test-secret',
      authorizationServer: 'https://auth.example.com'
    }
    
    await fastify.register(oauthClientPlugin, config)
    await registerAuthRoutes(fastify)
    
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
    
    await fastify.close()
  })

  await t.test('should handle validation errors gracefully', async () => {
    const fastify = Fastify()
    const config = {
      clientId: 'test-client',
      authorizationServer: 'https://auth.example.com'
    }
    
    await fastify.register(oauthClientPlugin, config)
    await registerAuthRoutes(fastify)
    
    const response = await fastify.inject({
      method: 'POST',
      url: '/oauth/validate',
      payload: {} // Missing token
    })
    
    assert.strictEqual(response.statusCode, 400)
    const body = JSON.parse(response.body)
    assert.strictEqual(body.error, 'invalid_request')
    
    await fastify.close()
  })
})