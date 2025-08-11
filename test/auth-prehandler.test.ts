import { test, describe, beforeEach, afterEach } from 'node:test'
import type { TestContext } from 'node:test'
import Fastify from 'fastify'
import { createAuthPreHandler } from '../src/auth/prehandler.ts'
import { TokenValidator } from '../src/auth/token-validator.ts'
import {
  createTestAuthConfig,
  createTestJWT,
  createExpiredJWT,
  createJWTWithInvalidAudience,
  setupMockAgent,
  generateMockJWKSResponse
} from './auth-test-utils.ts'

describe('Authorization PreHandler', () => {
  let app: Awaited<ReturnType<typeof Fastify>>
  let restoreMock: (() => void) | null = null

  beforeEach(async () => {
    app = Fastify({ logger: false })
  })

  afterEach(async () => {
    if (restoreMock) {
      restoreMock()
      restoreMock = null
    }
    await app.close()
  })

  test('should skip authorization when disabled', async (t: TestContext) => {
    const config = createTestAuthConfig({ enabled: false })
    const validator = new TokenValidator(config, app)
    const preHandler = createAuthPreHandler(config, validator)

    app.addHook('preHandler', preHandler)
    app.get('/test', async () => ({ success: true }))

    await app.ready()

    const response = await app.inject({
      method: 'GET',
      url: '/test'
    })

    t.assert.strictEqual(response.statusCode, 200)
    t.assert.deepStrictEqual(response.json(), { success: true })

    validator.close()
  })

  test('should skip authorization for well-known endpoints', async (t: TestContext) => {
    const config = createTestAuthConfig()
    const validator = new TokenValidator(config, app)
    const preHandler = createAuthPreHandler(config, validator)

    app.addHook('preHandler', preHandler)
    app.get('/.well-known/test', async () => ({ success: true }))

    await app.ready()

    const response = await app.inject({
      method: 'GET',
      url: '/.well-known/test'
    })

    t.assert.strictEqual(response.statusCode, 200)
    t.assert.deepStrictEqual(response.json(), { success: true })

    validator.close()
  })

  test('should skip authorization for the start of the OAuth authorization flow', async (t: TestContext) => {
    const config = createTestAuthConfig()
    const validator = new TokenValidator(config, app)
    const preHandler = createAuthPreHandler(config, validator)

    app.addHook('preHandler', preHandler)
    app.get('/oauth/authorize', async () => ({ success: true }))

    await app.ready()

    const response = await app.inject({
      method: 'GET',
      url: '/oauth/authorize'
    })

    t.assert.strictEqual(response.statusCode, 200)
    t.assert.deepStrictEqual(response.json(), { success: true })

    validator.close()
  })

  test('should return 401 when no Authorization header', async (t: TestContext) => {
    const config = createTestAuthConfig()
    const validator = new TokenValidator(config, app)
    const preHandler = createAuthPreHandler(config, validator)

    app.addHook('preHandler', preHandler)
    app.get('/test', async () => ({ success: true }))

    await app.ready()

    const response = await app.inject({
      method: 'GET',
      url: '/test'
    })

    t.assert.strictEqual(response.statusCode, 401)

    const body = response.json()
    t.assert.strictEqual(body.error, 'authorization_required')
    t.assert.strictEqual(body.error_description, 'Authorization header required')

    const wwwAuth = response.headers['www-authenticate']
    t.assert.ok(wwwAuth)
    t.assert.ok(wwwAuth.includes('Bearer realm="MCP Server"'))
    t.assert.ok(wwwAuth.includes('resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"'))

    validator.close()
  })

  test('should return 401 when Authorization header is not Bearer', async (t: TestContext) => {
    const config = createTestAuthConfig()
    const validator = new TokenValidator(config, app)
    const preHandler = createAuthPreHandler(config, validator)

    app.addHook('preHandler', preHandler)
    app.get('/test', async () => ({ success: true }))

    await app.ready()

    const response = await app.inject({
      method: 'GET',
      url: '/test',
      headers: {
        authorization: 'Basic dGVzdDp0ZXN0'
      }
    })

    t.assert.strictEqual(response.statusCode, 401)

    const body = response.json()
    t.assert.strictEqual(body.error, 'invalid_token')
    t.assert.strictEqual(body.error_description, 'Authorization header must use Bearer scheme')

    validator.close()
  })

  test('should return 401 when Bearer token is empty', async (t: TestContext) => {
    const config = createTestAuthConfig()
    const validator = new TokenValidator(config, app)
    const preHandler = createAuthPreHandler(config, validator)

    app.addHook('preHandler', preHandler)
    app.get('/test', async () => ({ success: true }))

    await app.ready()

    const response = await app.inject({
      method: 'GET',
      url: '/test',
      headers: {
        authorization: 'Bearer '
      }
    })

    t.assert.strictEqual(response.statusCode, 401)

    const body = response.json()
    t.assert.strictEqual(body.error, 'invalid_token')
    t.assert.strictEqual(body.error_description, 'Bearer token is empty')

    validator.close()
  })

  test('should allow request with valid token', async (t: TestContext) => {
    const config = createTestAuthConfig()
    restoreMock = setupMockAgent({
      'https://auth.example.com/.well-known/jwks.json': generateMockJWKSResponse()
    })

    const validator = new TokenValidator(config, app)
    const preHandler = createAuthPreHandler(config, validator)

    app.addHook('preHandler', preHandler)
    app.get('/test', async (request) => ({
      success: true,
      user: (request as any).tokenPayload?.sub
    }))

    await app.ready()

    const token = createTestJWT()
    const response = await app.inject({
      method: 'GET',
      url: '/test',
      headers: {
        authorization: `Bearer ${token}`
      }
    })

    t.assert.strictEqual(response.statusCode, 200)

    const body = response.json()
    t.assert.strictEqual(body.success, true)
    t.assert.strictEqual(body.user, 'test-user')

    validator.close()
  })

  test('should return 401 with invalid token', async (t: TestContext) => {
    const config = createTestAuthConfig()
    restoreMock = setupMockAgent({
      'https://auth.example.com/.well-known/jwks.json': generateMockJWKSResponse()
    })

    const validator = new TokenValidator(config, app)
    const preHandler = createAuthPreHandler(config, validator)

    app.addHook('preHandler', preHandler)
    app.get('/test', async () => ({ success: true }))

    await app.ready()

    const response = await app.inject({
      method: 'GET',
      url: '/test',
      headers: {
        authorization: 'Bearer invalid-token'
      }
    })

    t.assert.strictEqual(response.statusCode, 401)

    const body = response.json()
    t.assert.strictEqual(body.error, 'invalid_token')
    t.assert.ok(body.error_description)

    validator.close()
  })

  test('should return 401 with expired token', async (t: TestContext) => {
    const config = createTestAuthConfig()
    restoreMock = setupMockAgent({
      'https://auth.example.com/.well-known/jwks.json': generateMockJWKSResponse()
    })

    const validator = new TokenValidator(config, app)
    const preHandler = createAuthPreHandler(config, validator)

    app.addHook('preHandler', preHandler)
    app.get('/test', async () => ({ success: true }))

    await app.ready()

    const token = createExpiredJWT()
    const response = await app.inject({
      method: 'GET',
      url: '/test',
      headers: {
        authorization: `Bearer ${token}`
      }
    })

    t.assert.strictEqual(response.statusCode, 401)

    const body = response.json()
    t.assert.strictEqual(body.error, 'invalid_token')

    validator.close()
  })

  test('should return 401 with token having invalid audience', async (t: TestContext) => {
    const config = createTestAuthConfig()
    restoreMock = setupMockAgent({
      'https://auth.example.com/.well-known/jwks.json': generateMockJWKSResponse()
    })

    const validator = new TokenValidator(config, app)
    const preHandler = createAuthPreHandler(config, validator)

    app.addHook('preHandler', preHandler)
    app.get('/test', async () => ({ success: true }))

    await app.ready()

    const token = createJWTWithInvalidAudience()
    const response = await app.inject({
      method: 'GET',
      url: '/test',
      headers: {
        authorization: `Bearer ${token}`
      }
    })

    t.assert.strictEqual(response.statusCode, 401)

    const body = response.json()
    t.assert.strictEqual(body.error, 'invalid_token')
    t.assert.strictEqual(body.error_description, 'Invalid audience claim')

    validator.close()
  })

  test('should add token payload to request context', async (t: TestContext) => {
    const config = createTestAuthConfig()
    restoreMock = setupMockAgent({
      'https://auth.example.com/.well-known/jwks.json': generateMockJWKSResponse()
    })

    const validator = new TokenValidator(config, app)
    const preHandler = createAuthPreHandler(config, validator)

    app.addHook('preHandler', preHandler)
    app.get('/test', async (request) => {
      const payload = (request as any).tokenPayload
      return {
        success: true,
        tokenData: {
          sub: payload?.sub,
          iss: payload?.iss,
          aud: payload?.aud
        }
      }
    })

    await app.ready()

    const token = createTestJWT({
      sub: 'custom-user',
      iss: 'https://custom.example.com'
    })

    const response = await app.inject({
      method: 'GET',
      url: '/test',
      headers: {
        authorization: `Bearer ${token}`
      }
    })

    t.assert.strictEqual(response.statusCode, 200)

    const body = response.json()
    t.assert.strictEqual(body.success, true)
    t.assert.strictEqual(body.tokenData.sub, 'custom-user')
    t.assert.strictEqual(body.tokenData.iss, 'https://custom.example.com')
    t.assert.strictEqual(body.tokenData.aud, 'https://mcp.example.com')

    validator.close()
  })

  test('should handle multiple endpoints with authorization', async (t: TestContext) => {
    const config = createTestAuthConfig()
    restoreMock = setupMockAgent({
      'https://auth.example.com/.well-known/jwks.json': generateMockJWKSResponse()
    })

    const validator = new TokenValidator(config, app)
    const preHandler = createAuthPreHandler(config, validator)

    app.addHook('preHandler', preHandler)
    app.get('/protected1', async () => ({ endpoint: 'protected1' }))
    app.get('/protected2', async () => ({ endpoint: 'protected2' }))
    app.get('/.well-known/public', async () => ({ endpoint: 'public' }))

    await app.ready()

    const token = createTestJWT()

    // Test protected endpoints require token
    const response1 = await app.inject({
      method: 'GET',
      url: '/protected1',
      headers: { authorization: `Bearer ${token}` }
    })
    t.assert.strictEqual(response1.statusCode, 200)
    t.assert.strictEqual(response1.json().endpoint, 'protected1')

    const response2 = await app.inject({
      method: 'GET',
      url: '/protected2',
      headers: { authorization: `Bearer ${token}` }
    })
    t.assert.strictEqual(response2.statusCode, 200)
    t.assert.strictEqual(response2.json().endpoint, 'protected2')

    // Test well-known endpoint doesn't require token
    const response3 = await app.inject({
      method: 'GET',
      url: '/.well-known/public'
    })
    t.assert.strictEqual(response3.statusCode, 200)
    t.assert.strictEqual(response3.json().endpoint, 'public')

    // Test protected endpoint without token fails
    const response4 = await app.inject({
      method: 'GET',
      url: '/protected1'
    })
    t.assert.strictEqual(response4.statusCode, 401)

    validator.close()
  })
})
