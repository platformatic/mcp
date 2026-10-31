import { test, describe, after } from 'node:test'
import * as assert from 'node:assert'
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici'
import Fastify from 'fastify'
import oauthClientPlugin from '../src/auth/oauth-client.ts'
import authRoutesPlugin from '../src/routes/auth-routes.ts'
import type { TestContext } from 'node:test'
import mcpPlugin from '../src/index.ts'
import { MemorySessionStore } from '../src/stores/memory-session-store.ts'
import { AuthorizationStateSealer } from '../src/auth/authorization-state.ts'
import type { AuthSession } from '../src/auth/authorization-state.ts'

const originalDispatcher = getGlobalDispatcher()
const mockAgent = new MockAgent()
mockAgent.disableNetConnect()
setGlobalDispatcher(mockAgent)

// Cleanup
after(async () => {
  await mockAgent.close()
  setGlobalDispatcher(originalDispatcher)
})

/** The `name=value` pair of the state cookie an /oauth/authorize response set. */
function stateCookieOf (response: { headers: Record<string, unknown> }): string {
  return String(response.headers['set-cookie']).split(';')[0]
}

describe('OAuth Routes', () => {
  test('should initiate OAuth authorization flow', async (t) => {
    const fastify = Fastify()
    t.after(async () => {
      await fastify.close()
    })

    const config = {
      clientId: 'test-client',
      authorizationServer: 'https://auth.example.com',
      redirectUri: 'https://mcp.example.com/oauth/callback'
    }

    await fastify.register(oauthClientPlugin, config)
    await fastify.register(authRoutesPlugin)

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
      authorizationServer: 'https://auth.example.com',
      redirectUri: 'https://mcp.example.com/oauth/callback'
    }

    await fastify.register(oauthClientPlugin, config)
    await fastify.register(authRoutesPlugin)

    // First, initiate the flow to get a valid state
    const authResponse = await fastify.inject({
      method: 'GET',
      url: '/oauth/authorize'
    })

    const locationHeader = authResponse.headers.location
    assert.ok(locationHeader, 'Location header should be present')
    const location = new URL(locationHeader!)
    const state = location.searchParams.get('state')

    // Then handle the callback
    const callbackResponse = await fastify.inject({
      method: 'GET',
      url: `/oauth/callback?code=test-code&state=${state}`,
      headers: { cookie: stateCookieOf(authResponse) }
    })

    assert.strictEqual(callbackResponse.statusCode, 200)
    assert.strictEqual(callbackResponse.headers['cache-control'], 'no-store')
    assert.strictEqual(callbackResponse.headers.pragma, 'no-cache')
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
      authorizationServer: 'https://auth.example.com',
      redirectUri: 'https://mcp.example.com/oauth/callback'
    }

    await fastify.register(oauthClientPlugin, config)
    await fastify.register(authRoutesPlugin)

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
      authorizationServer: 'https://auth.example.com',
      redirectUri: 'https://mcp.example.com/oauth/callback'
    }

    await fastify.register(oauthClientPlugin, config)
    await fastify.register(authRoutesPlugin)

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
      authorizationServer: 'https://auth.example.com',
      redirectUri: 'https://mcp.example.com/oauth/callback'
    }

    await fastify.register(oauthClientPlugin, config)
    await fastify.register(authRoutesPlugin)

    const response = await fastify.inject({
      method: 'GET',
      url: '/oauth/callback?code=test-code&state=invalid-state',
      headers: { cookie: 'mcp_oauth_state_invalid-state=not-a-sealed-value' }
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
      authorizationServer: 'https://auth.example.com',
      redirectUri: 'https://mcp.example.com/oauth/callback'
    }

    await fastify.register(oauthClientPlugin, config)
    await fastify.register(authRoutesPlugin)

    const response = await fastify.inject({
      method: 'POST',
      url: '/oauth/refresh',
      payload: { refresh_token: 'test-refresh-token' }
    })

    assert.strictEqual(response.statusCode, 200)
    assert.strictEqual(response.headers['cache-control'], 'no-store')
    assert.strictEqual(response.headers.pragma, 'no-cache')
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
      authorizationServer: 'https://auth.example.com',
      redirectUri: 'https://mcp.example.com/oauth/callback'
    }

    await fastify.register(oauthClientPlugin, config)
    await fastify.register(authRoutesPlugin)

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
      authorizationServer: 'https://auth.example.com',
      redirectUri: 'https://mcp.example.com/oauth/callback'
    }

    await fastify.register(oauthClientPlugin, config)
    await fastify.register(authRoutesPlugin)

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
      authorizationServer: 'https://auth.example.com',
      redirectUri: 'https://mcp.example.com/oauth/callback'
    }

    await fastify.register(oauthClientPlugin, config)
    await fastify.register(authRoutesPlugin)

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
      authorizationServer: 'https://auth.example.com',
      redirectUri: 'https://mcp.example.com/oauth/callback'
    }

    await fastify.register(oauthClientPlugin, config)
    await fastify.register(authRoutesPlugin)

    const response = await fastify.inject({
      method: 'GET',
      url: '/oauth/status'
    })

    assert.strictEqual(response.statusCode, 200)
    const body = JSON.parse(response.body)
    assert.strictEqual(body.authenticated, false)
  })

  test('should return 501 when dcrHooks not configured', async (t) => {
    const fastify = Fastify()
    t.after(async () => {
      await fastify.close()
    })

    const config = {
      authorizationServer: 'https://auth.example.com',
      dynamicRegistration: true
    }

    await fastify.register(oauthClientPlugin, config)
    await fastify.register(authRoutesPlugin)

    const response = await fastify.inject({
      method: 'POST',
      url: '/oauth/register',
      payload: { redirect_uris: ['http://localhost/callback'] }
    })

    assert.strictEqual(response.statusCode, 501)
    const body = JSON.parse(response.body)
    assert.strictEqual(body.error, 'not_implemented')
  })

  test('should handle dynamic client registration with dcrHooks', async (t) => {
    const mockPool = mockAgent.get('https://auth.example.com')
    mockPool.intercept({
      path: '/oauth2/register',
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
    await fastify.register(authRoutesPlugin, {
      dcrHooks: {
        upstreamEndpoint: 'https://auth.example.com/oauth2/register'
      }
    })

    const response = await fastify.inject({
      method: 'POST',
      url: '/oauth/register',
      payload: {
        client_name: 'Test Client',
        redirect_uris: ['http://localhost/callback']
      }
    })

    assert.strictEqual(response.statusCode, 200)
    const body = JSON.parse(response.body)
    assert.strictEqual(body.client_id, 'dynamic-client-id')
    assert.strictEqual(body.client_secret, 'dynamic-client-secret')
  })

  test('should call dcrHooks onRequest and onResponse', async (t) => {
    const mockPool = mockAgent.get('https://auth.example.com')
    mockPool.intercept({
      path: '/oauth2/register',
      method: 'POST'
    }).reply(200, {
      client_id: 'dynamic-client-id',
      client_secret: 'dynamic-client-secret',
      client_uri: '' // Empty string that should be cleaned
    })

    const fastify = Fastify()
    t.after(async () => {
      await fastify.close()
    })

    const config = {
      authorizationServer: 'https://auth.example.com',
      dynamicRegistration: true
    }

    let onRequestCalled = false
    let onResponseCalled = false

    await fastify.register(oauthClientPlugin, config)
    await fastify.register(authRoutesPlugin, {
      dcrHooks: {
        upstreamEndpoint: 'https://auth.example.com/oauth2/register',
        onRequest: async (request, _log) => {
          onRequestCalled = true
          // Add metadata
          return { ...request, software_id: 'test-software' }
        },
        onResponse: async (response, _request, _log) => {
          onResponseCalled = true
          // Clean empty client_uri
          const cleaned = { ...response }
          if (cleaned.client_uri === '') {
            delete cleaned.client_uri
          }
          return cleaned
        }
      }
    })

    const response = await fastify.inject({
      method: 'POST',
      url: '/oauth/register',
      payload: {
        client_name: 'Test Client',
        redirect_uris: ['http://localhost/callback']
      }
    })

    assert.strictEqual(response.statusCode, 200)
    assert.strictEqual(onRequestCalled, true)
    assert.strictEqual(onResponseCalled, true)
    const body = JSON.parse(response.body)
    assert.strictEqual(body.client_uri, undefined) // Should be cleaned
  })

  test('should handle logout request', async (t) => {
    const fastify = Fastify()
    t.after(async () => {
      await fastify.close()
    })

    const config = {
      clientId: 'test-client',
      authorizationServer: 'https://auth.example.com',
      redirectUri: 'https://mcp.example.com/oauth/callback'
    }

    await fastify.register(oauthClientPlugin, config)
    await fastify.register(authRoutesPlugin)

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

  test('should accept a lower-case bearer auth-scheme on logout', async (t) => {
    const fastify = Fastify()
    t.after(async () => {
      await fastify.close()
    })

    const config = {
      clientId: 'test-client',
      authorizationServer: 'https://auth.example.com',
      redirectUri: 'https://mcp.example.com/oauth/callback'
    }

    await fastify.register(oauthClientPlugin, config)
    await fastify.register(authRoutesPlugin)

    const response = await fastify.inject({
      method: 'POST',
      url: '/oauth/logout',
      headers: {
        authorization: 'bearer test-token'
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
      authorizationServer: 'https://auth.example.com',
      redirectUri: 'https://mcp.example.com/oauth/callback'
    }

    await fastify.register(oauthClientPlugin, config)
    await fastify.register(authRoutesPlugin)

    const response = await fastify.inject({
      method: 'POST',
      url: '/oauth/logout'
    })

    assert.strictEqual(response.statusCode, 400)
    const body = JSON.parse(response.body)
    assert.strictEqual(body.error, 'invalid_request')
  })

  test('should reject downstream redirect URIs before creating OAuth state', async (t) => {
    const fastify = Fastify()
    t.after(async () => {
      await fastify.close()
    })

    await fastify.register(oauthClientPlugin, {
      clientId: 'test-client',
      authorizationServer: 'https://auth.example.com',
      redirectUri: 'https://mcp.example.com/oauth/callback'
    })

    let authorizationRequestCreated = false
    fastify.oauthClient.createAuthorizationRequest = async () => {
      authorizationRequestCreated = true
      throw new Error('must not be called')
    }

    await fastify.register(authRoutesPlugin)

    const response = await fastify.inject({
      method: 'GET',
      url: '/oauth/authorize?redirect_uri=https%3A%2F%2Fclient.example%2Fcallback'
    })

    assert.strictEqual(response.statusCode, 400)
    assert.deepStrictEqual(response.json(), {
      error: 'invalid_request',
      error_description: 'redirect_uri is not supported'
    })
    assert.strictEqual(authorizationRequestCreated, false)
    assert.strictEqual(response.headers['set-cookie'], undefined)
  })

  test('should not redirect tokens for a session created before the fix', async (t) => {
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

    await fastify.register(oauthClientPlugin, {
      clientId: 'test-client',
      clientSecret: 'test-secret',
      authorizationServer: 'https://auth.example.com',
      redirectUri: 'https://mcp.example.com/oauth/callback'
    })

    const stateSecret = 'a'.repeat(32)
    const sealed = new AuthorizationStateSealer(stateSecret).seal({
      state: 'stale-state',
      pkce: {
        codeVerifier: 'verifier',
        codeChallenge: 'challenge',
        codeChallengeMethod: 'S256'
      },
      originalUrl: 'https://attacker.example/capture',
      callbackUrl: 'https://mcp.example.com/oauth/callback'
    } as AuthSession, 60_000)

    await fastify.register(authRoutesPlugin, { stateSecret })

    const response = await fastify.inject({
      method: 'GET',
      url: '/oauth/callback?code=test-code&state=stale-state',
      headers: { cookie: `mcp_oauth_state_stale-state=${sealed}` }
    })

    assert.strictEqual(response.statusCode, 200)
    assert.strictEqual(response.headers.location, undefined)
    assert.strictEqual(response.headers['cache-control'], 'no-store')
    assert.strictEqual(response.headers.pragma, 'no-cache')
    assert.strictEqual(response.json().access_token, 'callback-access-token')
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
      authorizationServer: 'https://auth.example.com',
      redirectUri: 'https://mcp.example.com/oauth/callback'
    }

    await fastify.register(oauthClientPlugin, config)

    // Mock the OAuth client method to throw an error
    fastify.oauthClient.createAuthorizationRequest = async () => {
      throw new Error('Authorization server unreachable')
    }

    await fastify.register(authRoutesPlugin)

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
      authorizationServer: 'https://auth.example.com',
      redirectUri: 'https://mcp.example.com/oauth/callback'
    }

    await fastify.register(oauthClientPlugin, config)
    await fastify.register(authRoutesPlugin)

    // Initiate flow to get valid state
    const authResponse = await fastify.inject({
      method: 'GET',
      url: '/oauth/authorize'
    })

    const authLocationHeaderError = authResponse.headers.location
    assert.ok(authLocationHeaderError, 'Location header should be present')
    const location = new URL(authLocationHeaderError!)
    const state = location.searchParams.get('state')

    // Handle callback with server error
    const callbackResponse = await fastify.inject({
      method: 'GET',
      url: `/oauth/callback?code=test-code&state=${state}`,
      headers: { cookie: stateCookieOf(authResponse) }
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
      authorizationServer: 'https://auth.example.com',
      redirectUri: 'https://mcp.example.com/oauth/callback'
    }

    await fastify.register(oauthClientPlugin, config)
    await fastify.register(authRoutesPlugin)

    const response = await fastify.inject({
      method: 'POST',
      url: '/oauth/validate',
      payload: {} // Missing token
    })

    assert.strictEqual(response.statusCode, 400)
    const body = JSON.parse(response.body)
    // TypeBox validation should return a validation error
    // Check for either Fastify validation error format or our custom format
    assert.ok(body.statusCode === 400 || body.error || body.message)
  })
})

describe('round 15: callback URL, metadata issuer and pre-authorization routes', () => {
  test('the redirect_uri comes from configuration, never from the Host header', async (t) => {
    const fastify = Fastify()
    t.after(() => fastify.close())
    await fastify.register(oauthClientPlugin, {
      clientId: 'test-client',
      authorizationServer: 'https://round15-host.example.com',
      resourceUri: 'https://mcp.example.com/'
    })
    await fastify.register(authRoutesPlugin)
    const response = await fastify.inject({ method: 'GET', url: '/oauth/authorize', headers: { host: 'attacker.example.net' } })
    assert.strictEqual(response.statusCode, 302)
    const location = new URL(response.headers.location as string)
    assert.strictEqual(location.searchParams.get('redirect_uri'), 'https://mcp.example.com/oauth/callback')
  })

  test('without a configured callback the flow is not started', async (t) => {
    const fastify = Fastify({ logger: false })
    t.after(() => fastify.close())
    await fastify.register(oauthClientPlugin, { clientId: 'test-client', authorizationServer: 'https://round15-none.example.com' })
    await fastify.register(authRoutesPlugin)
    const response = await fastify.inject({ method: 'GET', url: '/oauth/authorize' })
    assert.strictEqual(response.statusCode, 500)
    assert.strictEqual(response.headers.location, undefined)
  })

  test('authorization server metadata naming another issuer is not used', async (t) => {
    const server = 'https://round15-issuer.example.com'
    const pool = mockAgent.get(server)
    pool.intercept({ path: '/.well-known/oauth-authorization-server', method: 'GET' }).reply(200, {
      issuer: 'https://attacker.example.net',
      authorization_endpoint: 'https://attacker.example.net/authorize',
      token_endpoint: 'https://attacker.example.net/token'
    })
    pool.intercept({ path: '/.well-known/openid-configuration', method: 'GET' }).reply(404, {})
    const fastify = Fastify({ logger: false })
    t.after(() => fastify.close())
    await fastify.register(oauthClientPlugin, { clientId: 'test-client', authorizationServer: server, redirectUri: 'https://mcp.example.com/oauth/callback' })
    const request = await fastify.oauthClient.createAuthorizationRequest()
    assert.strictEqual(new URL(request.authorizationUrl).origin, server)
  })
})

describe('round 16: pending authorizations and the default callback', () => {
  const tokenReply = {
    access_token: 'round16-access-token',
    token_type: 'Bearer',
    expires_in: 3600
  }

  async function buildRoutes (t: TestContext, server: string, extra: Record<string, unknown> = {}) {
    const fastify = Fastify({ logger: false })
    t.after(() => fastify.close())
    await fastify.register(oauthClientPlugin, {
      clientId: 'test-client',
      clientSecret: 'test-secret',
      authorizationServer: server,
      redirectUri: 'https://mcp.example.com/oauth/callback',
      ...extra
    })
    await fastify.register(authRoutesPlugin)
    const authorize = await fastify.inject({ method: 'GET', url: '/oauth/authorize' })
    const state = new URL(authorize.headers.location as string).searchParams.get('state')!
    return { fastify, authorize, state }
  }

  test('authorize sets a cookie scoped to the callback, and the callback needs it', async (t: TestContext) => {
    const server = 'https://round16-cookie.example.com'
    mockAgent.get(server).intercept({ path: '/oauth/token', method: 'POST' }).reply(200, tokenReply)
    const { fastify, authorize, state } = await buildRoutes(t, server)

    const cookie = String(authorize.headers['set-cookie'])
    assert.match(cookie, new RegExp(`^mcp_oauth_state_${state}=[A-Za-z0-9_-]+;`))
    assert.match(cookie, /Path=\/oauth\/callback/)
    assert.match(cookie, /HttpOnly/)
    assert.match(cookie, /SameSite=Lax/)
    assert.match(cookie, /Secure/)
    // The PKCE verifier travels sealed, not readable
    assert.doesNotMatch(cookie, /codeVerifier/)

    // A callback URL opened in a browser that did not start the flow
    for (const headers of [{}, { cookie: `mcp_oauth_state_${state}=forged` }]) {
      const response = await fastify.inject({ method: 'GET', url: `/oauth/callback?code=c&state=${state}`, headers })
      assert.strictEqual(response.statusCode, 400)
      assert.strictEqual(response.json().error, 'invalid_request')
    }

    const response = await fastify.inject({
      method: 'GET',
      url: `/oauth/callback?code=c&state=${state}`,
      headers: { cookie: `other=1; ${stateCookieOf(authorize)}` }
    })
    assert.strictEqual(response.statusCode, 200)
    assert.strictEqual(response.json().access_token, 'round16-access-token')
    assert.match(String(response.headers['set-cookie']), new RegExp(`^mcp_oauth_state_${state}=; .*Max-Age=0`))
  })

  test('starting an authorization creates no MCP session', async (t: TestContext) => {
    const created = t.mock.method(MemorySessionStore.prototype, 'create')
    const app = Fastify({ logger: false })
    t.after(() => app.close())
    await app.register(mcpPlugin, {
      authorization: {
        enabled: true,
        authorizationServers: ['https://round16-session.example.com'],
        resourceUri: 'https://mcp.example.com',
        tokenValidation: { jwksUri: 'https://round16-session.example.com/.well-known/jwks.json' },
        oauth2Client: {
          clientId: 'test-client',
          authorizationServer: 'https://round16-session.example.com',
          resourceUri: 'https://mcp.example.com'
        }
      }
    })
    await app.ready()
    for (let i = 0; i < 3; i++) {
      assert.strictEqual((await app.inject({ method: 'GET', url: '/oauth/authorize' })).statusCode, 302)
    }
    assert.strictEqual(created.mock.callCount(), 0)
  })

  test('the default callback is the served route: resource path ignored, route prefix applied', async (t: TestContext) => {
    for (const { prefix, resourceUri, expected } of [
      { prefix: '', resourceUri: 'https://mcp.example.com/mcp', expected: 'https://mcp.example.com/oauth/callback' },
      { prefix: '/api', resourceUri: 'https://mcp.example.com', expected: 'https://mcp.example.com/api/oauth/callback' }
    ]) {
      const fastify = Fastify({ logger: false })
      t.after(() => fastify.close())
      await fastify.register(async (child) => {
        await child.register(oauthClientPlugin, { clientId: 'test-client', authorizationServer: 'https://round16-default.example.com', resourceUri })
        await child.register(authRoutesPlugin)
      }, { prefix })
      const authorize = await fastify.inject({ method: 'GET', url: `${prefix}/oauth/authorize` })
      const redirectUri = new URL(authorize.headers.location as string).searchParams.get('redirect_uri')
      assert.strictEqual(redirectUri, expected)
      // ...which is where the callback route answers
      const state = new URL(authorize.headers.location as string).searchParams.get('state')
      const callback = await fastify.inject({ method: 'GET', url: `${new URL(redirectUri!).pathname}?state=${state}` })
      assert.strictEqual(callback.statusCode, 400)
      assert.match(callback.json().error_description, /Missing required parameters/)
      assert.match(String(authorize.headers['set-cookie']), new RegExp(`Path=${new URL(expected).pathname}`))
    }
  })
})

describe('round 17: pending authorizations live in their cookie', () => {
  const tokenReply = {
    access_token: 'round17-access-token',
    token_type: 'Bearer',
    expires_in: 3600
  }

  async function buildRoutes (t: TestContext, server: string, stateSecret?: string) {
    const fastify = Fastify({ logger: false })
    t.after(() => fastify.close())
    await fastify.register(oauthClientPlugin, {
      clientId: 'test-client',
      authorizationServer: server,
      redirectUri: 'https://mcp.example.com/oauth/callback'
    })
    await fastify.register(authRoutesPlugin, { stateSecret })
    return fastify
  }

  async function authorize (fastify: Awaited<ReturnType<typeof buildRoutes>>) {
    const response = await fastify.inject({ method: 'GET', url: '/oauth/authorize' })
    return { cookie: stateCookieOf(response), state: new URL(response.headers.location as string).searchParams.get('state')! }
  }

  test('two authorizations started in one browser both complete', async (t: TestContext) => {
    const server = 'https://round17-tabs.example.com'
    mockAgent.get(server).intercept({ path: '/oauth/token', method: 'POST' }).reply(200, tokenReply).times(2)
    const fastify = await buildRoutes(t, server)
    const first = await authorize(fastify)
    const second = await authorize(fastify)
    // The browser holds both cookies and sends both to the callback path
    const jar = `${first.cookie}; ${second.cookie}`
    for (const { state } of [first, second]) {
      const response = await fastify.inject({ method: 'GET', url: `/oauth/callback?code=c&state=${state}`, headers: { cookie: jar } })
      assert.strictEqual(response.statusCode, 200)
    }
  })

  test('anonymous authorizations cannot push out a pending one', async (t: TestContext) => {
    const server = 'https://round17-flood.example.com'
    mockAgent.get(server).intercept({ path: '/oauth/token', method: 'POST' }).reply(200, tokenReply)
    const fastify = await buildRoutes(t, server)
    const victim = await authorize(fastify)
    for (let i = 0; i < 10_000; i++) {
      await fastify.inject({ method: 'GET', url: '/oauth/authorize' })
    }
    const response = await fastify.inject({ method: 'GET', url: `/oauth/callback?code=c&state=${victim.state}`, headers: { cookie: victim.cookie } })
    assert.strictEqual(response.statusCode, 200)
  })

  test('a cookie opens only for its own state, before it expires, under the same secret', async (t: TestContext) => {
    t.mock.timers.enable({ apis: ['Date'] })
    const server = 'https://round17-seal.example.com'
    mockAgent.get(server).intercept({ path: '/oauth/token', method: 'POST' }).reply(200, tokenReply)
    const secret = 'b'.repeat(32)
    const issuer = await buildRoutes(t, server, secret)
    const other = await buildRoutes(t, server, secret)
    const stranger = await buildRoutes(t, server, 'c'.repeat(32))

    const pending = await authorize(issuer)
    const value = pending.cookie.split('=')[1]
    const otherState = 'A'.repeat(22)
    const replayed = await issuer.inject({
      method: 'GET',
      url: `/oauth/callback?code=c&state=${otherState}`,
      headers: { cookie: `mcp_oauth_state_${otherState}=${value}` }
    })
    assert.strictEqual(replayed.statusCode, 400)

    const callback = (app: typeof issuer, { state, cookie } = pending) => app.inject({ method: 'GET', url: `/oauth/callback?code=c&state=${state}`, headers: { cookie } })
    assert.strictEqual((await callback(stranger)).statusCode, 400)
    // Another instance with the same secret finishes the flow
    assert.strictEqual((await callback(other)).statusCode, 200)

    const late = await authorize(issuer)
    t.mock.timers.tick(10 * 60 * 1000 + 1)
    assert.strictEqual((await callback(other, late)).statusCode, 400)
  })
})
