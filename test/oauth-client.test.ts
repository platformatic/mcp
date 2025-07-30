import { test } from 'node:test'
import * as assert from 'node:assert'
import { MockAgent, setGlobalDispatcher } from 'undici'
import Fastify from 'fastify'
import oauthClientPlugin from '../src/auth/oauth-client.ts'

const mockAgent = new MockAgent()
setGlobalDispatcher(mockAgent)

test('OAuth Client Plugin', async (t) => {
  await t.test('should register OAuth client plugin successfully', async () => {
    const fastify = Fastify()
    const config = {
      clientId: 'test-client',
      clientSecret: 'test-secret',
      authorizationServer: 'https://auth.example.com',
      scopes: ['read', 'write']
    }
    
    await fastify.register(oauthClientPlugin, config)
    
    assert.ok(fastify.oauthClient)
    assert.ok(typeof fastify.oauthClient.generatePKCEChallenge === 'function')
    assert.ok(typeof fastify.oauthClient.generateState === 'function')
    assert.ok(typeof fastify.oauthClient.createAuthorizationRequest === 'function')
    
    await fastify.close()
  })

  await t.test('should generate valid PKCE challenge', async () => {
    const fastify = Fastify()
    const config = {
      clientId: 'test-client',
      authorizationServer: 'https://auth.example.com'
    }
    
    await fastify.register(oauthClientPlugin, config)
    
    const pkce = fastify.oauthClient.generatePKCEChallenge()
    
    assert.ok(pkce.codeVerifier)
    assert.ok(pkce.codeChallenge)
    assert.strictEqual(pkce.codeChallengeMethod, 'S256')
    assert.notEqual(pkce.codeVerifier, pkce.codeChallenge)
    
    await fastify.close()
  })

  await t.test('should generate unique state values', async () => {
    const fastify = Fastify()
    const config = {
      clientId: 'test-client',
      authorizationServer: 'https://auth.example.com'
    }
    
    await fastify.register(oauthClientPlugin, config)
    
    const state1 = fastify.oauthClient.generateState()
    const state2 = fastify.oauthClient.generateState()
    
    assert.ok(state1)
    assert.ok(state2)
    assert.notEqual(state1, state2)
    
    await fastify.close()
  })

  await t.test('should create authorization request with PKCE', async () => {
    const fastify = Fastify()
    const config = {
      clientId: 'test-client',
      authorizationServer: 'https://auth.example.com',
      resourceUri: 'https://mcp.example.com',
      scopes: ['read', 'write']
    }
    
    await fastify.register(oauthClientPlugin, config)
    
    const authRequest = await fastify.oauthClient.createAuthorizationRequest()
    
    assert.ok(authRequest.authorizationUrl)
    assert.ok(authRequest.state)
    assert.ok(authRequest.pkce)
    
    const url = new URL(authRequest.authorizationUrl)
    assert.strictEqual(url.origin, 'https://auth.example.com')
    assert.strictEqual(url.pathname, '/oauth/authorize')
    
    const params = url.searchParams
    assert.strictEqual(params.get('response_type'), 'code')
    assert.strictEqual(params.get('client_id'), 'test-client')
    assert.strictEqual(params.get('state'), authRequest.state)
    assert.strictEqual(params.get('code_challenge'), authRequest.pkce.codeChallenge)
    assert.strictEqual(params.get('code_challenge_method'), 'S256')
    assert.strictEqual(params.get('scope'), 'read write')
    assert.strictEqual(params.get('resource'), 'https://mcp.example.com')
    
    await fastify.close()
  })

  await t.test('should exchange code for token successfully', async () => {
    const mockPool = mockAgent.get('https://auth.example.com')
    mockPool.intercept({
      path: '/oauth/token',
      method: 'POST'
    }).reply(200, {
      access_token: 'test-access-token',
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: 'test-refresh-token',
      scope: 'read write'
    })

    const fastify = Fastify()
    const config = {
      clientId: 'test-client',
      clientSecret: 'test-secret',
      authorizationServer: 'https://auth.example.com'
    }
    
    await fastify.register(oauthClientPlugin, config)
    
    const pkce = fastify.oauthClient.generatePKCEChallenge()
    const state = 'test-state'
    
    const tokens = await fastify.oauthClient.exchangeCodeForToken('test-code', pkce, state, state)
    
    assert.strictEqual(tokens.access_token, 'test-access-token')
    assert.strictEqual(tokens.token_type, 'Bearer')
    assert.strictEqual(tokens.expires_in, 3600)
    assert.strictEqual(tokens.refresh_token, 'test-refresh-token')
    assert.strictEqual(tokens.scope, 'read write')
    
    await fastify.close()
  })

  await t.test('should reject invalid state in token exchange', async () => {
    const fastify = Fastify()
    const config = {
      clientId: 'test-client',
      authorizationServer: 'https://auth.example.com'
    }
    
    await fastify.register(oauthClientPlugin, config)
    const pkce = fastify.oauthClient.generatePKCEChallenge()
    
    await assert.rejects(
      fastify.oauthClient.exchangeCodeForToken('test-code', pkce, 'original-state', 'different-state'),
      /Invalid state parameter/
    )
    
    await fastify.close()
  })

  await t.test('should refresh token successfully', async () => {
    const mockPool = mockAgent.get('https://auth.example.com')
    mockPool.intercept({
      path: '/oauth/token',
      method: 'POST'
    }).reply(200, {
      access_token: 'new-access-token',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'read write'
    })

    const fastify = Fastify()
    const config = {
      clientId: 'test-client',
      clientSecret: 'test-secret',
      authorizationServer: 'https://auth.example.com'
    }
    
    await fastify.register(oauthClientPlugin, config)
    const tokens = await fastify.oauthClient.refreshToken('test-refresh-token')
    
    assert.strictEqual(tokens.access_token, 'new-access-token')
    assert.strictEqual(tokens.token_type, 'Bearer')
    assert.strictEqual(tokens.expires_in, 3600)
    
    await fastify.close()
  })

  await t.test('should validate token successfully', async () => {
    const mockPool = mockAgent.get('https://auth.example.com')
    mockPool.intercept({
      path: '/oauth/introspect',
      method: 'POST'
    }).reply(200, {
      active: true,
      client_id: 'test-client',
      scope: 'read write'
    })

    const fastify = Fastify()
    const config = {
      clientId: 'test-client',
      authorizationServer: 'https://auth.example.com'
    }
    
    await fastify.register(oauthClientPlugin, config)
    const isValid = await fastify.oauthClient.validateToken('test-token')
    
    assert.strictEqual(isValid, true)
    
    await fastify.close()
  })

  await t.test('should perform dynamic client registration', async () => {
    const mockPool = mockAgent.get('https://auth.example.com')
    mockPool.intercept({
      path: '/oauth/register',
      method: 'POST'
    }).reply(200, {
      client_id: 'dynamic-client-id',
      client_secret: 'dynamic-client-secret',
      client_id_issued_at: Date.now(),
      client_secret_expires_at: 0
    })

    const fastify = Fastify()
    const config = {
      authorizationServer: 'https://auth.example.com',
      resourceUri: 'https://mcp.example.com',
      dynamicRegistration: true,
      scopes: ['read']
    }
    
    await fastify.register(oauthClientPlugin, config)
    const registration = await fastify.oauthClient.dynamicClientRegistration()
    
    assert.strictEqual(registration.clientId, 'dynamic-client-id')
    assert.strictEqual(registration.clientSecret, 'dynamic-client-secret')
    
    await fastify.close()
  })

  await t.test('should reject dynamic registration when disabled', async () => {
    const fastify = Fastify()
    const config = {
      clientId: 'test-client',
      authorizationServer: 'https://auth.example.com',
      dynamicRegistration: false
    }
    
    await fastify.register(oauthClientPlugin, config)
    
    await assert.rejects(
      fastify.oauthClient.dynamicClientRegistration(),
      /Dynamic client registration not enabled/
    )
    
    await fastify.close()
  })

  await t.test('should create authorization request with additional parameters', async () => {
    const fastify = Fastify()
    const config = {
      clientId: 'test-client',
      authorizationServer: 'https://auth.example.com'
    }
    
    await fastify.register(oauthClientPlugin, config)
    const authRequest = await fastify.oauthClient.createAuthorizationRequest({
      audience: 'https://api.example.com',
      prompt: 'consent'
    })
    
    const url = new URL(authRequest.authorizationUrl)
    const params = url.searchParams
    
    assert.strictEqual(params.get('audience'), 'https://api.example.com')
    assert.strictEqual(params.get('prompt'), 'consent')
    
    await fastify.close()
  })
})