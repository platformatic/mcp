import { test, describe, beforeEach, afterEach } from 'node:test'
import type { TestContext } from 'node:test'
import Fastify from 'fastify'
import { createAuthPreHandler, generateWWWAuthenticateHeader, SKIP_BEARER_AUTH } from '../src/auth/prehandler.ts'
import { colonScopeHierarchy } from '../src/index.ts'
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

  test('should skip authorization for well-known endpoints marked on the route', async (t: TestContext) => {
    const config = createTestAuthConfig()
    const validator = new TokenValidator(config, app)
    const preHandler = createAuthPreHandler(config, validator)

    app.addHook('preHandler', preHandler)
    app.get('/.well-known/test', { config: { [SKIP_BEARER_AUTH]: true } }, async () => ({ success: true }))
    app.get('/.well-known/app-owned', async () => ({ success: true }))

    await app.ready()

    const response = await app.inject({
      method: 'GET',
      url: '/.well-known/test'
    })

    t.assert.strictEqual(response.statusCode, 200)
    t.assert.deepStrictEqual(response.json(), { success: true })

    // An application route under /.well-known/ is protected like any other,
    // and a discovery URL nothing serves answers 404
    t.assert.strictEqual((await app.inject({ method: 'GET', url: '/.well-known/app-owned' })).statusCode, 401)
    t.assert.strictEqual((await app.inject({ method: 'GET', url: '/.well-known/missing' })).statusCode, 404)

    validator.close()
  })

  test('should skip authorization for the start of the OAuth authorization flow', async (t: TestContext) => {
    const config = createTestAuthConfig()
    const validator = new TokenValidator(config, app)
    const preHandler = createAuthPreHandler(config, validator)

    app.addHook('preHandler', preHandler)
    app.get('/oauth/authorize', { config: { [SKIP_BEARER_AUTH]: true } }, async () => ({ success: true }))

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
    // RFC 6750 §3.1: no error code when the request carried no authentication
    t.assert.ok(!wwwAuth.includes('error='))

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
    t.assert.strictEqual(
      response.headers['www-authenticate'],
      'Bearer realm="MCP Server", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource", error="invalid_token", error_description="Authorization header must use Bearer scheme"'
    )

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
    t.assert.strictEqual(
      response.headers['www-authenticate'],
      'Bearer realm="MCP Server", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource", error="invalid_token", error_description="Bearer token is empty"'
    )

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
    app.get('/test', async (request: any) => ({
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

  for (const scheme of ['Bearer', 'bearer', 'BEARER']) {
    test(`should accept the ${scheme} auth-scheme case-insensitively`, async (t: TestContext) => {
      const config = createTestAuthConfig()
      restoreMock = setupMockAgent({
        'https://auth.example.com/.well-known/jwks.json': generateMockJWKSResponse()
      })

      const validator = new TokenValidator(config, app)
      const preHandler = createAuthPreHandler(config, validator)

      app.addHook('preHandler', preHandler)
      app.get('/test', async (request: any) => ({
        success: true,
        user: (request as any).tokenPayload?.sub
      }))

      await app.ready()

      const token = createTestJWT()
      const response = await app.inject({
        method: 'GET',
        url: '/test',
        headers: {
          authorization: `${scheme} ${token}`
        }
      })

      t.assert.strictEqual(response.statusCode, 200)
      t.assert.strictEqual(response.json().user, 'test-user')

      validator.close()
    })
  }

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

    const wwwAuth = response.headers['www-authenticate'] as string
    t.assert.ok(wwwAuth.startsWith('Bearer realm="MCP Server", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"'))
    t.assert.ok(wwwAuth.includes(', error="invalid_token", error_description="'))

    validator.close()
  })

  test('should keep validation errors inside the error_description quoted-string', async (t: TestContext) => {
    const config = createTestAuthConfig()
    const validator = {
      validateToken: async () => ({ valid: false, error: 'bad "token", error="x" \\ café\r\n' })
    } as unknown as TokenValidator
    const preHandler = createAuthPreHandler(config, validator)

    app.addHook('preHandler', preHandler)
    app.get('/test', async () => ({ success: true }))

    await app.ready()

    const response = await app.inject({
      method: 'GET',
      url: '/test',
      headers: {
        authorization: 'Bearer some-token'
      }
    })

    t.assert.strictEqual(response.statusCode, 401)
    t.assert.strictEqual(
      response.headers['www-authenticate'],
      'Bearer realm="MCP Server", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource", error="invalid_token", error_description="bad token, error=x  caf"'
    )
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
    t.assert.strictEqual(body.error_description, 'Token expired')
    t.assert.strictEqual(
      response.headers['www-authenticate'],
      'Bearer realm="MCP Server", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource", error="invalid_token", error_description="Token expired"'
    )

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
    const config = createTestAuthConfig({ authorizationServers: ['https://custom.example.com'] })
    restoreMock = setupMockAgent({
      'https://auth.example.com/.well-known/jwks.json': generateMockJWKSResponse()
    })

    const validator = new TokenValidator(config, app)
    const preHandler = createAuthPreHandler(config, validator)

    app.addHook('preHandler', preHandler)
    app.get('/test', async (request: any) => {
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
    app.get('/.well-known/public', { config: { [SKIP_BEARER_AUTH]: true } }, async () => ({ endpoint: 'public' }))

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

  test('should include requiredScopes in the initial 401 challenge', async (t: TestContext) => {
    const config = createTestAuthConfig({ requiredScopes: ['mcp:read', 'mcp:write'] })
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
    t.assert.strictEqual(
      response.headers['www-authenticate'],
      'Bearer realm="MCP Server", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource", scope="mcp:read mcp:write"'
    )

    validator.close()
  })

  test('should not include a scope parameter when requiredScopes is not configured', async (t: TestContext) => {
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
    t.assert.strictEqual(
      response.headers['www-authenticate'],
      'Bearer realm="MCP Server", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"'
    )

    validator.close()
  })

  describe('requiredScopes with scopeImplies', () => {
    async function request (config: ReturnType<typeof createTestAuthConfig>, scope: string) {
      restoreMock = setupMockAgent({
        'https://auth.example.com/.well-known/jwks.json': generateMockJWKSResponse()
      })
      const validator = new TokenValidator(config, app)
      app.addHook('preHandler', createAuthPreHandler(config, validator))
      app.get('/test', async () => ({ success: true }))
      await app.ready()

      const response = await app.inject({
        method: 'GET',
        url: '/test',
        headers: { authorization: `Bearer ${createTestJWT({ scope })}` }
      })
      validator.close()
      return response
    }

    test('a broader scope is refused by default', async (t: TestContext) => {
      const response = await request(createTestAuthConfig({ requiredScopes: ['files:read'] }), 'files')
      t.assert.strictEqual(response.statusCode, 403)
      t.assert.strictEqual(response.json().error, 'insufficient_scope')
      t.assert.match(response.headers['www-authenticate'] as string, /scope="files:read"/)
    })

    test('a broader scope is accepted with colonScopeHierarchy', async (t: TestContext) => {
      const response = await request(createTestAuthConfig({
        requiredScopes: ['files:read'],
        scopeImplies: colonScopeHierarchy
      }), 'files')
      t.assert.strictEqual(response.statusCode, 200)
      t.assert.deepStrictEqual(response.json(), { success: true })
    })

    test('a narrower scope is still refused with colonScopeHierarchy', async (t: TestContext) => {
      const response = await request(createTestAuthConfig({
        requiredScopes: ['files'],
        scopeImplies: colonScopeHierarchy
      }), 'files:read')
      t.assert.strictEqual(response.statusCode, 403)
      t.assert.strictEqual(response.json().error, 'insufficient_scope')
    })

    test('a lookalike prefix is refused with colonScopeHierarchy', async (t: TestContext) => {
      const response = await request(createTestAuthConfig({
        requiredScopes: ['files:read'],
        scopeImplies: colonScopeHierarchy
      }), 'filesystem')
      t.assert.strictEqual(response.statusCode, 403)
    })
  })
})

test('a challenge cannot be broken out of by the error description', (t: TestContext) => {
  const header = generateWWWAuthenticateHeader(
    { enabled: true, authorizationServers: ['https://auth.example.com'], resourceUri: 'https://api.example.com', tokenValidation: {} } as any,
    { error: 'invalid_token', error_description: 'Token "expired" \\ x' }
  )
  t.assert.strictEqual(
    header,
    'Bearer realm="MCP Server", resource_metadata="https://api.example.com/.well-known/oauth-protected-resource", error="invalid_token", error_description="Token expired  x"'
  )
})

describe('round 15: routes exempt from bearer authorization', () => {
  test('an application route under /oauth/ is protected like any other', async (t: TestContext) => {
    const app = Fastify({ logger: false })
    t.after(() => app.close())
    const config = createTestAuthConfig()
    const validator = new TokenValidator(config, app)
    app.addHook('preHandler', createAuthPreHandler(config, validator))
    app.get('/oauth/registered-clients', async () => ({ clients: ['all of them'] }))
    app.get('/oauth/callbacks/admin', async () => ({ admin: true }))
    app.get('/oauth/authorize-admin', async () => ({ admin: true }))
    await app.ready()
    for (const url of ['/oauth/registered-clients', '/oauth/callbacks/admin', '/oauth/authorize-admin']) {
      t.assert.strictEqual((await app.inject({ method: 'GET', url })).statusCode, 401, url)
    }
  })
})

describe('round 16: excluded paths', () => {
  test('excludedPaths match the path, not the query string', async (t: TestContext) => {
    const app = Fastify({ logger: false })
    t.after(() => app.close())
    const config = createTestAuthConfig({ excludedPaths: ['/public', /\/health$/, /\.(png|css)$/] })
    const validator = new TokenValidator(config, app)
    app.addHook('preHandler', createAuthPreHandler(config, validator))
    app.post('/mcp', async () => ({ secret: true }))
    app.get('/health', async () => ({ ok: true }))
    app.get('/public/logo.png', async () => ({ ok: true }))
    await app.ready()

    for (const url of ['/mcp?x=/health', '/mcp?x.png', '/mcp?/health', '/mcp?/public']) {
      t.assert.strictEqual((await app.inject({ method: 'POST', url })).statusCode, 401, url)
    }
    for (const url of ['/health', '/health?probe=1', '/public/logo.png?v=2']) {
      t.assert.strictEqual((await app.inject({ method: 'GET', url })).statusCode, 200, url)
    }
  })
})

describe('round 17: exemptions follow the router', () => {
  async function rawPost (port: number, target: string): Promise<number> {
    const { connect } = await import('node:net')
    return new Promise((resolve, reject) => {
      const socket = connect(port, '127.0.0.1')
      let data = ''
      socket.on('data', chunk => { data += chunk })
      socket.on('error', reject)
      socket.on('end', () => resolve(Number(data.split(' ')[1])))
      socket.write(`POST ${target} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`)
    })
  }

  test('excludedPaths see the routed path: no fragment, no absolute-form origin', async (t: TestContext) => {
    const app = Fastify({ logger: false })
    t.after(() => app.close())
    const config = createTestAuthConfig({ excludedPaths: [/\/health$/, '/public'] })
    const validator = new TokenValidator(config, app)
    app.addHook('preHandler', createAuthPreHandler(config, validator))
    app.post('/mcp', async () => ({ secret: true }))
    app.post('/health', async () => ({ ok: true }))
    app.post('/public/*', async () => ({ ok: true }))
    await app.listen({ port: 0, host: '127.0.0.1' })
    const port = (app.server.address() as { port: number }).port

    for (const target of ['/mcp#/health', 'http://x/mcp#/health', 'http://x/mcp?/public', '/mcp#/public']) {
      t.assert.strictEqual(await rawPost(port, target), 401, target)
    }
    for (const target of ['/health#', 'http://x/health', '/he%61lth', '/public/a#b']) {
      t.assert.strictEqual(await rawPost(port, target), 200, target)
    }
  })

  test('only the plugin\'s own discovery routes are exempt, not URLs that look like them', async (t: TestContext) => {
    const app = Fastify({ logger: false })
    t.after(() => app.close())
    const config = createTestAuthConfig()
    const validator = new TokenValidator(config, app)
    app.addHook('preHandler', createAuthPreHandler(config, validator))
    app.get('/:collection/:id', async () => ({ secret: true }))
    app.get('/mcp/:tool', async () => ({ secret: true }))
    await app.ready()

    for (const url of ['/.well-known/42', '/mcp/.well-known', '/mcp/.well-known-admin']) {
      t.assert.strictEqual((await app.inject({ method: 'GET', url })).statusCode, 401, url)
    }
  })
})
