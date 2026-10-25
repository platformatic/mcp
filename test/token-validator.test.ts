import { test, describe, beforeEach, afterEach } from 'node:test'
import type { TestContext } from 'node:test'
import Fastify from 'fastify'
import { createServer } from 'node:http'
import { TokenValidator } from '../src/auth/token-validator.ts'
import { JwksCache } from '../src/auth/jwks.ts'
import {
  createTestAuthConfig,
  createTestJWT,
  createExpiredJWT,
  createJWTWithInvalidAudience,
  createIntrospectionResponse,
  setupMockAgent,
  generateMockJWKSResponse
} from './auth-test-utils.ts'

describe('TokenValidator', () => {
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

  test('should initialize with JWKS configuration', async (t: TestContext) => {
    const config = createTestAuthConfig()
    const validator = new TokenValidator(config, app)

    t.assert.ok(validator)
    t.assert.strictEqual(typeof validator.validateToken, 'function')

    validator.close()
  })

  test('should initialize with introspection configuration', async (t: TestContext) => {
    const config = createTestAuthConfig({
      tokenValidation: {
        introspectionEndpoint: 'https://auth.example.com/introspect',
        validateAudience: true
      }
    })
    const validator = new TokenValidator(config, app)

    t.assert.ok(validator)
    validator.close()
  })

  describe('JWT Validation', () => {
    test('should validate valid JWT token', async (t: TestContext) => {
      const config = createTestAuthConfig()
      restoreMock = setupMockAgent({
        'https://auth.example.com/.well-known/jwks.json': generateMockJWKSResponse()
      })

      const validator = new TokenValidator(config, app)
      const token = createTestJWT()

      const result = await validator.validateToken(token)

      t.assert.strictEqual(result.valid, true)
      t.assert.ok(result.payload)
      t.assert.strictEqual(result.payload.sub, 'test-user')
      t.assert.strictEqual(result.issuer, 'https://auth.example.com')

      validator.close()
    })

    test('reports the JWT issuer without its trailing slash', async (t: TestContext) => {
      const config = createTestAuthConfig()
      restoreMock = setupMockAgent({
        'https://auth.example.com/.well-known/jwks.json': generateMockJWKSResponse()
      })

      const validator = new TokenValidator(config, app)
      const result = await validator.validateToken(createTestJWT({ iss: 'https://auth.example.com/' }))

      t.assert.strictEqual(result.valid, true)
      t.assert.strictEqual(result.issuer, 'https://auth.example.com')

      validator.close()
    })

    test('should reject expired JWT token', async (t: TestContext) => {
      const config = createTestAuthConfig()
      restoreMock = setupMockAgent({
        'https://auth.example.com/.well-known/jwks.json': generateMockJWKSResponse()
      })

      const validator = new TokenValidator(config, app)
      const token = createExpiredJWT()

      const result = await validator.validateToken(token)

      t.assert.strictEqual(result.valid, false)
      t.assert.strictEqual(result.error, 'Token expired')

      validator.close()
    })

    test('should reject JWT with a bad signature', async (t: TestContext) => {
      const config = createTestAuthConfig()
      restoreMock = setupMockAgent({
        'https://auth.example.com/.well-known/jwks.json': generateMockJWKSResponse()
      })

      const validator = new TokenValidator(config, app)
      // Swap in the signature of a different token
      const [header, payload] = createTestJWT().split('.')
      const otherSignature = createTestJWT({ sub: 'someone-else' }).split('.')[2]
      const token = `${header}.${payload}.${otherSignature}`

      const result = await validator.validateToken(token)

      t.assert.strictEqual(result.valid, false)
      t.assert.strictEqual(result.error, 'Invalid token signature')

      validator.close()
    })

    test('should reject a malformed JWT without echoing its content', async (t: TestContext) => {
      const config = createTestAuthConfig()
      restoreMock = setupMockAgent({
        'https://auth.example.com/.well-known/jwks.json': generateMockJWKSResponse()
      })

      const validator = new TokenValidator(config, app)

      const result = await validator.validateToken('not-a-jwt-secret-value')

      t.assert.strictEqual(result.valid, false)
      t.assert.strictEqual(result.error, 'Invalid token')

      validator.close()
    })

    test('should reject JWT with invalid audience when validation enabled', async (t: TestContext) => {
      const config = createTestAuthConfig()
      restoreMock = setupMockAgent({
        'https://auth.example.com/.well-known/jwks.json': generateMockJWKSResponse()
      })

      const validator = new TokenValidator(config, app)
      const token = createJWTWithInvalidAudience()

      const result = await validator.validateToken(token)

      t.assert.strictEqual(result.valid, false)
      t.assert.strictEqual(result.error, 'Invalid audience claim')

      validator.close()
    })

    test('should accept JWT with invalid audience when validation disabled', async (t: TestContext) => {
      const config = createTestAuthConfig({
        tokenValidation: {
          jwksUri: 'https://auth.example.com/.well-known/jwks.json',
          validateAudience: false
        }
      })
      restoreMock = setupMockAgent({
        'https://auth.example.com/.well-known/jwks.json': generateMockJWKSResponse()
      })

      const validator = new TokenValidator(config, app)
      const token = createJWTWithInvalidAudience()

      const result = await validator.validateToken(token)

      t.assert.strictEqual(result.valid, true)
      t.assert.ok(result.payload)

      validator.close()
    })

    test('should handle JWT with array audience', async (t: TestContext) => {
      const config = createTestAuthConfig()
      restoreMock = setupMockAgent({
        'https://auth.example.com/.well-known/jwks.json': generateMockJWKSResponse()
      })

      const validator = new TokenValidator(config, app)
      const token = createTestJWT({
        aud: ['https://mcp.example.com', 'https://other.example.com']
      })

      const result = await validator.validateToken(token)

      t.assert.strictEqual(result.valid, true)
      t.assert.ok(result.payload)

      validator.close()
    })

    test('should reject JWT with missing kid', async (t: TestContext) => {
      const config = createTestAuthConfig()
      restoreMock = setupMockAgent({
        'https://auth.example.com/.well-known/jwks.json': generateMockJWKSResponse(undefined),
      })

      const validator = new TokenValidator(config, app)

      const token = createTestJWT({ kid: undefined })

      const result = await validator.validateToken(token)

      t.assert.strictEqual(result.valid, false)
      t.assert.ok(result.error)

      validator.close()
    })
  })

  describe('Token Introspection', () => {
    test('should validate active token via introspection', async (t: TestContext) => {
      const config = createTestAuthConfig({
        tokenValidation: {
          introspectionEndpoint: 'https://auth.example.com/introspect',
          validateAudience: true
        }
      })

      restoreMock = setupMockAgent({
        'https://auth.example.com/introspect': createIntrospectionResponse(true)
      })

      const validator = new TokenValidator(config, app)
      const result = await validator.validateToken('opaque-token-123')

      t.assert.strictEqual(result.valid, true)
      t.assert.ok(result.payload)
      t.assert.strictEqual(result.payload.active, true)
      t.assert.strictEqual(result.payload.sub, 'test-user')
      t.assert.strictEqual(result.issuer, 'https://auth.example.com')

      validator.close()
    })

    test('derives the issuer from the introspection endpoint when the response has no iss', async (t: TestContext) => {
      const config = createTestAuthConfig({
        tokenValidation: {
          introspectionEndpoint: 'https://auth.example.com/introspect',
          validateAudience: true
        }
      })

      restoreMock = setupMockAgent({
        // undefined is dropped when the mock serialises the body
        'https://auth.example.com/introspect': createIntrospectionResponse(true, { iss: undefined })
      })

      const validator = new TokenValidator(config, app)
      const result = await validator.validateToken('opaque-token-123')

      t.assert.strictEqual(result.valid, true)
      t.assert.strictEqual(result.issuer, 'introspection:https://auth.example.com/introspect')

      validator.close()
    })

    test('should reject inactive token via introspection', async (t: TestContext) => {
      const config = createTestAuthConfig({
        tokenValidation: {
          introspectionEndpoint: 'https://auth.example.com/introspect',
          validateAudience: true
        }
      })

      restoreMock = setupMockAgent({
        'https://auth.example.com/introspect': createIntrospectionResponse(false)
      })

      const validator = new TokenValidator(config, app)
      const result = await validator.validateToken('opaque-token-123')

      t.assert.strictEqual(result.valid, false)
      t.assert.strictEqual(result.error, 'Token is not active')

      validator.close()
    })

    test('should reject token with invalid audience via introspection', async (t: TestContext) => {
      const config = createTestAuthConfig({
        tokenValidation: {
          introspectionEndpoint: 'https://auth.example.com/introspect',
          validateAudience: true
        }
      })

      restoreMock = setupMockAgent({
        'https://auth.example.com/introspect': createIntrospectionResponse(true, {
          aud: 'https://different.example.com'
        })
      })

      const validator = new TokenValidator(config, app)
      const result = await validator.validateToken('opaque-token-123')

      t.assert.strictEqual(result.valid, false)
      t.assert.strictEqual(result.error, 'Invalid audience claim')

      validator.close()
    })

    test('should handle introspection endpoint errors', async (t: TestContext) => {
      const config = createTestAuthConfig({
        tokenValidation: {
          introspectionEndpoint: 'https://auth.example.com/introspect',
          validateAudience: true
        }
      })

      restoreMock = setupMockAgent({
        'https://auth.example.com/introspect': {
          status: 500,
          body: { error: 'Internal server error' }
        }
      })

      const validator = new TokenValidator(config, app)
      const result = await validator.validateToken('opaque-token-123')

      t.assert.strictEqual(result.valid, false)
      t.assert.ok(result.error?.includes('Introspection failed with status 500'))

      validator.close()
    })

    test('should handle network errors during introspection', async (t: TestContext) => {
      const config = createTestAuthConfig({
        tokenValidation: {
          introspectionEndpoint: 'https://auth.example.com/introspect',
          validateAudience: true
        }
      })

      restoreMock = setupMockAgent({})

      const validator = new TokenValidator(config, app)
      const result = await validator.validateToken('opaque-token-123')

      t.assert.strictEqual(result.valid, false)
      t.assert.ok(result.error)

      validator.close()
    })

    test('should use bearer token auth for introspection when configured', async (t: TestContext) => {
      const config = createTestAuthConfig({
        tokenValidation: {
          introspectionEndpoint: 'https://auth.example.com/admin/introspect',
          validateAudience: true,
          introspectionAuth: {
            type: 'bearer',
            token: 'admin-api-key-123'
          }
        }
      })

      // The mock will verify the Authorization header is set correctly
      restoreMock = setupMockAgent({
        'https://auth.example.com/admin/introspect': createIntrospectionResponse(true)
      })

      const validator = new TokenValidator(config, app)
      const result = await validator.validateToken('opaque-token-123')

      t.assert.strictEqual(result.valid, true)
      t.assert.ok(result.payload)

      validator.close()
    })

    test('should use basic auth for introspection when configured', async (t: TestContext) => {
      const config = createTestAuthConfig({
        tokenValidation: {
          introspectionEndpoint: 'https://auth.example.com/introspect',
          validateAudience: true,
          introspectionAuth: {
            type: 'basic',
            clientId: 'client-id',
            clientSecret: 'client-secret'
          }
        }
      })

      restoreMock = setupMockAgent({
        'https://auth.example.com/introspect': createIntrospectionResponse(true)
      })

      const validator = new TokenValidator(config, app)
      const result = await validator.validateToken('opaque-token-123')

      t.assert.strictEqual(result.valid, true)
      t.assert.ok(result.payload)

      validator.close()
    })

    test('should not send auth header when introspectionAuth is none', async (t: TestContext) => {
      const config = createTestAuthConfig({
        tokenValidation: {
          introspectionEndpoint: 'https://auth.example.com/introspect',
          validateAudience: true,
          introspectionAuth: {
            type: 'none'
          }
        }
      })

      restoreMock = setupMockAgent({
        'https://auth.example.com/introspect': createIntrospectionResponse(true)
      })

      const validator = new TokenValidator(config, app)
      const result = await validator.validateToken('opaque-token-123')

      t.assert.strictEqual(result.valid, true)
      t.assert.ok(result.payload)

      validator.close()
    })
  })

  describe('Custom Introspection Endpoint Path', () => {
    // Some providers use non-standard introspection paths (e.g. /oauth2/introspection rather than /introspect)
    test('should validate token via custom /oauth2/introspection path', async (t: TestContext) => {
      const config = createTestAuthConfig({
        tokenValidation: {
          introspectionEndpoint: 'https://sample-instance-01.authkit.app/oauth2/introspection',
          validateAudience: true
        }
      })

      restoreMock = setupMockAgent({
        'https://sample-instance-01.authkit.app/oauth2/introspection': createIntrospectionResponse(true)
      })

      const validator = new TokenValidator(config, app)
      const result = await validator.validateToken('opaque-token-123')

      t.assert.strictEqual(result.valid, true)
      t.assert.ok(result.payload)
      t.assert.strictEqual(result.payload.active, true)

      validator.close()
    })

    test('should reject inactive token via custom /oauth2/introspection path', async (t: TestContext) => {
      const config = createTestAuthConfig({
        tokenValidation: {
          introspectionEndpoint: 'https://sample-instance-01.authkit.app/oauth2/introspection',
          validateAudience: true
        }
      })

      restoreMock = setupMockAgent({
        'https://sample-instance-01.authkit.app/oauth2/introspection': createIntrospectionResponse(false)
      })

      const validator = new TokenValidator(config, app)
      const result = await validator.validateToken('opaque-token-123')

      t.assert.strictEqual(result.valid, false)
      t.assert.strictEqual(result.error, 'Token is not active')

      validator.close()
    })

    test('should validate token via deeply nested custom introspection path', async (t: TestContext) => {
      const config = createTestAuthConfig({
        tokenValidation: {
          introspectionEndpoint: 'https://auth.example.com/v1/tokens/validate',
          validateAudience: true
        }
      })

      restoreMock = setupMockAgent({
        'https://auth.example.com/v1/tokens/validate': createIntrospectionResponse(true)
      })

      const validator = new TokenValidator(config, app)
      const result = await validator.validateToken('opaque-token-123')

      t.assert.strictEqual(result.valid, true)
      t.assert.ok(result.payload)

      validator.close()
    })

    test('should handle error from custom introspection path', async (t: TestContext) => {
      const config = createTestAuthConfig({
        tokenValidation: {
          introspectionEndpoint: 'https://sample-instance-01.authkit.app/oauth2/introspection',
          validateAudience: true
        }
      })

      restoreMock = setupMockAgent({
        'https://sample-instance-01.authkit.app/oauth2/introspection': {
          status: 401,
          body: { error: 'unauthorized' }
        }
      })

      const validator = new TokenValidator(config, app)
      const result = await validator.validateToken('opaque-token-123')

      t.assert.strictEqual(result.valid, false)
      t.assert.ok(result.error?.includes('Introspection failed with status 401'))

      validator.close()
    })
  })

  describe('Custom JWKS URI Path', () => {
    // Some providers use non-standard JWKS paths (e.g. /oauth2/jwks rather than /.well-known/jwks.json)
    test('should validate JWT using custom JSWKS path', async (t: TestContext) => {
      const config = createTestAuthConfig({
        authorizationServers: ['https://sample-instance-01.authkit.app'],
        tokenValidation: {
          jwksUri: 'https://sample-instance-01.authkit.app/oauth2/jwks',
          validateAudience: true
        }
      })
      restoreMock = setupMockAgent({
        'https://sample-instance-01.authkit.app/oauth2/jwks': generateMockJWKSResponse()
      })

      const validator = new TokenValidator(config, app)
      const token = createTestJWT({ iss: 'https://sample-instance-01.authkit.app', aud: 'https://mcp.example.com' })

      const result = await validator.validateToken(token)

      t.assert.strictEqual(result.valid, true)
      t.assert.ok(result.payload)
      t.assert.strictEqual(result.payload.sub, 'test-user')

      validator.close()
    })

    test('should validate JWT using deeply nested custom JWKS path', async (t: TestContext) => {
      const config = createTestAuthConfig({
        tokenValidation: {
          jwksUri: 'https://auth.example.com/auth/realms/myrealm/protocol/openid-connect/certs',
          validateAudience: true
        }
      })
      restoreMock = setupMockAgent({
        'https://auth.example.com/auth/realms/myrealm/protocol/openid-connect/certs': generateMockJWKSResponse()
      })

      const validator = new TokenValidator(config, app)
      const token = createTestJWT()

      const result = await validator.validateToken(token)

      t.assert.strictEqual(result.valid, true)
      t.assert.ok(result.payload)

      validator.close()
    })

    test('should fail JWT validation when custom JWKS path returns 404', async (t: TestContext) => {
      const config = createTestAuthConfig({
        authorizationServers: ['https://sample-instance-01.authkit.app'],
        tokenValidation: {
          jwksUri: 'https://sample-instance-01.authkit.app/oauth2/jwks',
          validateAudience: false
        }
      })
      restoreMock = setupMockAgent({
        'https://sample-instance-01.authkit.app/oauth2/jwks': { status: 404, body: { error: 'not found' } }
      })

      const validator = new TokenValidator(config, app)
      const token = createTestJWT({ iss: 'https://sample-instance-01.authkit.app', aud: 'https://mcp.example.com' })

      const result = await validator.validateToken(token)

      t.assert.strictEqual(result.valid, false)
      t.assert.ok(result.error)

      validator.close()
    })

    test('should not fetch /.well-known/jwks.json when custom path configured', async (t: TestContext) => {
      const config = createTestAuthConfig({
        authorizationServers: ['https://sample-instance-01.authkit.app'],
        tokenValidation: {
          jwksUri: 'https://sample-instance-01.authkit.app/oauth2/jwks',
          validateAudience: false
        }
      })
      // Only mock the custom path — if the validator incorrectly fetches the default
      // path, disableNetConnect will cause it to fail
      restoreMock = setupMockAgent({
        'https://sample-instance-01.authkit.app/oauth2/jwks': generateMockJWKSResponse()
      })

      const validator = new TokenValidator(config, app)
      const token = createTestJWT({ iss: 'https://sample-instance-01.authkit.app', aud: 'https://mcp.example.com' })

      const result = await validator.validateToken(token)

      t.assert.strictEqual(result.valid, true)

      validator.close()
    })
  })

  describe('Fallback Logic', () => {
    test('should fallback to introspection when JWT validation fails', async (t: TestContext) => {
      const config = createTestAuthConfig({
        tokenValidation: {
          jwksUri: 'https://auth.example.com/.well-known/jwks.json',
          introspectionEndpoint: 'https://auth.example.com/introspect',
          validateAudience: true
        }
      })

      restoreMock = setupMockAgent({
        'https://auth.example.com/.well-known/jwks.json': generateMockJWKSResponse(),
        'https://auth.example.com/introspect': createIntrospectionResponse(true)
      })

      const validator = new TokenValidator(config, app)
      // Use an opaque token that won't validate as JWT
      const result = await validator.validateToken('opaque-token-123')

      t.assert.strictEqual(result.valid, true)
      t.assert.ok(result.payload)
      t.assert.strictEqual(result.payload.active, true)

      validator.close()
    })

    test('should fail when no validation method configured', async (t: TestContext) => {
      const config = createTestAuthConfig({
        tokenValidation: {
          validateAudience: true
        }
      })

      const validator = new TokenValidator(config, app)
      const result = await validator.validateToken('any-token')

      t.assert.strictEqual(result.valid, false)
      t.assert.strictEqual(result.error, 'No token validation method configured')

      validator.close()
    })
  })

  describe('Error Handling', () => {
    test('should handle malformed JWT tokens', async (t: TestContext) => {
      const config = createTestAuthConfig()
      restoreMock = setupMockAgent({
        'https://auth.example.com/.well-known/jwks.json': generateMockJWKSResponse()
      })

      const validator = new TokenValidator(config, app)
      const result = await validator.validateToken('not.a.jwt')

      t.assert.strictEqual(result.valid, false)
      t.assert.ok(result.error)

      validator.close()
    })

    test('should handle JWKS fetch errors', async (t: TestContext) => {
      const config = createTestAuthConfig()
      restoreMock = setupMockAgent({})

      const validator = new TokenValidator(config, app)
      const token = createTestJWT()
      const result = await validator.validateToken(token)

      t.assert.strictEqual(result.valid, false)
      t.assert.ok(result.error)

      validator.close()
    })
  })

  describe('Audience Validation', () => {
    test('should validate single audience string', async (t: TestContext) => {
      const config = createTestAuthConfig()
      restoreMock = setupMockAgent({
        'https://auth.example.com/.well-known/jwks.json': generateMockJWKSResponse()
      })

      const validator = new TokenValidator(config, app)
      const token = createTestJWT({ aud: 'https://mcp.example.com' })

      const result = await validator.validateToken(token)

      t.assert.strictEqual(result.valid, true)

      validator.close()
    })

    test('should validate audience array', async (t: TestContext) => {
      const config = createTestAuthConfig()
      restoreMock = setupMockAgent({
        'https://auth.example.com/.well-known/jwks.json': generateMockJWKSResponse()
      })

      const validator = new TokenValidator(config, app)
      const token = createTestJWT({
        aud: ['https://mcp.example.com', 'https://api.example.com']
      })

      const result = await validator.validateToken(token)

      t.assert.strictEqual(result.valid, true)

      validator.close()
    })

    test('should reject token with no audience when validation enabled', async (t: TestContext) => {
      const config = createTestAuthConfig()
      restoreMock = setupMockAgent({
        'https://auth.example.com/.well-known/jwks.json': generateMockJWKSResponse()
      })

      const validator = new TokenValidator(config, app)
      const token = createTestJWT({ aud: undefined })

      const result = await validator.validateToken(token)

      t.assert.strictEqual(result.valid, false)
      t.assert.strictEqual(result.error, 'Invalid audience claim')

      validator.close()
    })
  })

  describe('Issuer and required claims', () => {
    const jwks = () => setupMockAgent({
      'https://auth.example.com/.well-known/jwks.json': generateMockJWKSResponse()
    })

    test('should reject JWT from an issuer that is not a configured authorization server', async (t: TestContext) => {
      restoreMock = jwks()
      const validator = new TokenValidator(createTestAuthConfig(), app)

      const result = await validator.validateToken(createTestJWT({ iss: 'https://evil.example.com' }))

      t.assert.strictEqual(result.valid, false)
      validator.close()
    })

    test('should reject JWT whose issuer only shares a prefix with a configured server', async (t: TestContext) => {
      restoreMock = jwks()
      const validator = new TokenValidator(createTestAuthConfig(), app)

      const result = await validator.validateToken(createTestJWT({ iss: 'https://auth.example.com.evil.com' }))

      t.assert.strictEqual(result.valid, false)
      validator.close()
    })

    test('should accept issuer differing from configuration only by a trailing slash', async (t: TestContext) => {
      restoreMock = jwks()
      const withSlash = new TokenValidator(createTestAuthConfig(), app)
      t.assert.strictEqual((await withSlash.validateToken(createTestJWT({ iss: 'https://auth.example.com/' }))).valid, true)

      const configuredWithSlash = new TokenValidator(createTestAuthConfig({ authorizationServers: ['https://auth.example.com/'] }), app)
      t.assert.strictEqual((await configuredWithSlash.validateToken(createTestJWT({ iss: 'https://auth.example.com' }))).valid, true)
    })

    test('should accept JWT from any configured authorization server', async (t: TestContext) => {
      restoreMock = jwks()
      const validator = new TokenValidator(createTestAuthConfig({
        authorizationServers: ['https://other.example.com', 'https://auth.example.com']
      }), app)

      const result = await validator.validateToken(createTestJWT({ iss: 'https://other.example.com' }))

      t.assert.strictEqual(result.valid, true)
      validator.close()
    })

    for (const claim of ['iss', 'sub', 'exp'] as const) {
      test(`should reject JWT without ${claim}`, async (t: TestContext) => {
        restoreMock = jwks()
        const validator = new TokenValidator(createTestAuthConfig(), app)

        const result = await validator.validateToken(createTestJWT({ [claim]: undefined }))

        t.assert.strictEqual(result.valid, false)
        validator.close()
      })
    }

    test('should reject introspection response with a foreign issuer', async (t: TestContext) => {
      restoreMock = setupMockAgent({
        'https://auth.example.com/introspect': createIntrospectionResponse(true, { iss: 'https://evil.example.com' })
      })
      const validator = new TokenValidator(createTestAuthConfig({
        tokenValidation: { introspectionEndpoint: 'https://auth.example.com/introspect', validateAudience: true }
      }), app)

      const result = await validator.validateToken('opaque-token-123')

      t.assert.strictEqual(result.valid, false)
      t.assert.strictEqual(result.error, 'Invalid issuer claim')
      validator.close()
    })

    test('should accept introspection response without iss', async (t: TestContext) => {
      restoreMock = setupMockAgent({
        'https://auth.example.com/introspect': createIntrospectionResponse(true, { iss: undefined })
      })
      const validator = new TokenValidator(createTestAuthConfig({
        tokenValidation: { introspectionEndpoint: 'https://auth.example.com/introspect', validateAudience: true }
      }), app)

      const result = await validator.validateToken('opaque-token-123')

      t.assert.strictEqual(result.valid, true)
      validator.close()
    })

    test('should reject introspection response without sub', async (t: TestContext) => {
      restoreMock = setupMockAgent({
        'https://auth.example.com/introspect': createIntrospectionResponse(true, { sub: undefined })
      })
      const validator = new TokenValidator(createTestAuthConfig({
        tokenValidation: { introspectionEndpoint: 'https://auth.example.com/introspect', validateAudience: true }
      }), app)

      const result = await validator.validateToken('opaque-token-123')

      t.assert.strictEqual(result.valid, false)
      t.assert.strictEqual(result.error, 'Missing subject claim')
      validator.close()
    })
  })
})

describe('round 12: signing keys', () => {
  test('tokens naming unknown signing keys do not each fetch the key set', async (t: TestContext) => {
    let fetches = 0
    const jwks = JSON.stringify(generateMockJWKSResponse())
    const server = createServer((_req, res) => { fetches++; res.setHeader('content-type', 'application/json'); res.end(jwks) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => server.close())
    const { port } = server.address() as { port: number }
    const app = Fastify({ logger: false })
    t.after(() => app.close())
    const validator = new TokenValidator(createTestAuthConfig({
      tokenValidation: { jwksUri: `http://127.0.0.1:${port}/jwks.json`, validateAudience: true }
    }), app)
    t.after(() => validator.close())

    t.assert.strictEqual((await validator.validateToken(createTestJWT({ kid: 'forged-0' } as any))).valid, false)
    t.assert.strictEqual(fetches, 1)
    for (let i = 1; i <= 10; i++) {
      t.assert.strictEqual((await validator.validateToken(createTestJWT({ kid: `forged-${i % 2}` } as any))).valid, false)
    }
    t.assert.strictEqual(fetches, 1)

    // The real key came with that one fetch, so forged tokens never lock it out.
    const real = await validator.validateToken(createTestJWT())
    t.assert.strictEqual(real.valid, true, real.error)
    t.assert.strictEqual(fetches, 1)
  })

  test('a key rotated in is picked up by the next refresh a token may cause', async (t: TestContext) => {
    let fetches = 0
    let keys: unknown[] = [{ ...generateMockJWKSResponse().keys[0], kid: 'old' }]
    const server = createServer((_req, res) => { fetches++; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys })) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => server.close())
    const { port } = server.address() as { port: number }
    const cache = new JwksCache(`http://127.0.0.1:${port}/jwks.json`, { minRefreshMs: 100 })

    t.assert.match(await cache.getPublicKey('old', 'RS256'), /BEGIN PUBLIC KEY/)
    keys = [...keys, { ...generateMockJWKSResponse().keys[0], kid: 'new' }]
    await t.assert.rejects(cache.getPublicKey('new', 'RS256'), /No matching signing key/)
    t.assert.strictEqual(fetches, 1)
    await new Promise(resolve => setTimeout(resolve, 120))
    t.assert.match(await cache.getPublicKey('new', 'RS256'), /BEGIN PUBLIC KEY/)
    t.assert.strictEqual(fetches, 2)
  })

  test('a JWT whose sub is not a non-empty string is refused', async (t: TestContext) => {
    const restore = setupMockAgent({ 'https://auth.example.com/.well-known/jwks.json': generateMockJWKSResponse() })
    t.after(restore)
    const app = Fastify({ logger: false })
    t.after(() => app.close())
    const validator = new TokenValidator(createTestAuthConfig(), app)
    t.after(() => validator.close())
    for (const sub of [12345, '', { id: 'alice' }]) {
      const result = await validator.validateToken(createTestJWT({ sub } as any))
      t.assert.strictEqual(result.valid, false, JSON.stringify(sub))
      t.assert.strictEqual(result.error, 'Invalid subject claim')
    }
  })
})

describe('round 13: signing keys', () => {
  test('tokens arriving while the key set is being fetched wait for it', async (t: TestContext) => {
    let fetches = 0
    let keys: unknown[] = [{ ...generateMockJWKSResponse().keys[0], kid: 'old' }]
    const server = createServer((_req, res) => {
      fetches++
      // Slow enough that the other callers arrive while it is in flight.
      setTimeout(() => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys })) }, 100)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => server.close())
    const { port } = server.address() as { port: number }
    const cache = new JwksCache(`http://127.0.0.1:${port}/jwks.json`, { minRefreshMs: 50 })

    // A cold start: nothing fetched yet.
    const cold = await Promise.allSettled(Array.from({ length: 5 }, () => cache.getPublicKey('old', 'RS256')))
    t.assert.deepStrictEqual(cold.map(result => result.status), Array(5).fill('fulfilled'))
    t.assert.strictEqual(fetches, 1)

    // A rotation: the first token naming the new key starts the fetch.
    await new Promise(resolve => setTimeout(resolve, 60))
    keys = [...keys, { ...generateMockJWKSResponse().keys[0], kid: 'new' }]
    const rotated = await Promise.allSettled(Array.from({ length: 4 }, () => cache.getPublicKey('new', 'RS256')))
    t.assert.deepStrictEqual(rotated.map(result => result.status), Array(4).fill('fulfilled'))
    t.assert.strictEqual(fetches, 2)
  })
})

describe('round 14: signing keys', () => {
  test('a cached key does not wait for a fetch made for an unknown one', async (t: TestContext) => {
    let fetches = 0
    const keys = [{ ...generateMockJWKSResponse().keys[0], kid: 'good' }]
    const server = createServer((_req, res) => {
      // The first fetch is quick; the server then becomes very slow.
      const delay = fetches++ === 0 ? 0 : 2_000
      setTimeout(() => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys })) }, delay)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => { server.closeAllConnections(); server.close() })
    const { port } = server.address() as { port: number }
    const cache = new JwksCache(`http://127.0.0.1:${port}/jwks.json`, { minRefreshMs: 0 })

    await cache.getPublicKey('good', 'RS256')
    const unknown = cache.getPublicKey('made-up', 'RS256').catch(() => {})
    const startedAt = Date.now()
    await cache.getPublicKey('good', 'RS256')
    t.assert.ok(Date.now() - startedAt < 500, `took ${Date.now() - startedAt}ms`)
    await unknown
  })

  test('a failed first fetch does not refuse every token until the next refresh is allowed', async (t: TestContext) => {
    let fetches = 0
    const keys = [{ ...generateMockJWKSResponse().keys[0], kid: 'good' }]
    const server = createServer((_req, res) => {
      if (fetches++ === 0) {
        res.statusCode = 503
        res.end()
        return
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ keys }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => server.close())
    const { port } = server.address() as { port: number }
    const cache = new JwksCache(`http://127.0.0.1:${port}/jwks.json`)

    t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
    await t.assert.rejects(cache.getPublicKey('good', 'RS256'))
    // Until a set has been fetched the next attempt waits one second, not minRefreshMs
    t.mock.timers.tick(1000)
    t.assert.match(await cache.getPublicKey('good', 'RS256'), /BEGIN PUBLIC KEY/)
    t.assert.strictEqual(fetches, 2)
  })
})

describe('round 15: issuers, introspection and key sets', () => {
  const OTHER = 'https://other.example.com'

  test('a key from one authorization server does not vouch for a token naming another', async (t: TestContext) => {
    const restore = setupMockAgent({ 'https://auth.example.com/.well-known/jwks.json': generateMockJWKSResponse() })
    t.after(restore)
    const app = Fastify({ logger: false })
    t.after(() => app.close())
    // One key set, which belongs to the first server.
    const validator = new TokenValidator(createTestAuthConfig({ authorizationServers: ['https://auth.example.com', OTHER] }), app)
    t.assert.strictEqual((await validator.validateToken(createTestJWT())).valid, true)
    t.assert.strictEqual((await validator.validateToken(createTestJWT({ iss: OTHER }))).valid, false)
  })

  test('each issuer can be given its own key set', async (t: TestContext) => {
    const restore = setupMockAgent({
      'https://auth.example.com/.well-known/jwks.json': generateMockJWKSResponse(),
      'https://other.example.com/jwks.json': generateMockJWKSResponse()
    })
    t.after(restore)
    const app = Fastify({ logger: false })
    t.after(() => app.close())
    const validator = new TokenValidator(createTestAuthConfig({
      authorizationServers: ['https://auth.example.com', OTHER],
      tokenValidation: {
        jwksUri: { 'https://auth.example.com': 'https://auth.example.com/.well-known/jwks.json', [OTHER]: 'https://other.example.com/jwks.json' },
        validateAudience: true
      }
    }), app)
    const fromOther = await validator.validateToken(createTestJWT({ iss: OTHER }))
    t.assert.strictEqual(fromOther.valid, true)
    t.assert.strictEqual(fromOther.issuer, OTHER)
  })

  test('introspection treats any active value but true as inactive', async (t: TestContext) => {
    const restore = setupMockAgent({ 'https://auth.example.com/introspect': createIntrospectionResponse('false' as any) })
    t.after(restore)
    const app = Fastify({ logger: false })
    t.after(() => app.close())
    const validator = new TokenValidator(createTestAuthConfig({
      tokenValidation: { introspectionEndpoint: 'https://auth.example.com/introspect', validateAudience: true }
    }), app)
    const result = await validator.validateToken('opaque-token')
    t.assert.strictEqual(result.valid, false)
  })

  test('introspection is bounded by a timeout', async (t: TestContext) => {
    let signal: AbortSignal | undefined
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return new Response(JSON.stringify(createIntrospectionResponse(true)), { headers: { 'content-type': 'application/json' } })
    })
    const app = Fastify({ logger: false })
    t.after(() => app.close())
    const validator = new TokenValidator(createTestAuthConfig({
      tokenValidation: { introspectionEndpoint: 'https://auth.example.com/introspect', validateAudience: true }
    }), app)
    await validator.validateToken('opaque-token')
    t.assert.ok(signal instanceof AbortSignal, 'introspection fetch has no abort signal')
  })

  test('an unreachable key set is not fetched again for every token', async (t: TestContext) => {
    let fetches = 0
    const server = createServer((_req, res) => {
      fetches++
      res.statusCode = 503
      res.end()
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => server.close())
    const { port } = server.address() as { port: number }
    const cache = new JwksCache(`http://127.0.0.1:${port}/jwks.json`)
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
    for (let i = 0; i < 10; i++) await cache.getPublicKey(`kid-${i}`, 'RS256').catch(() => {})
    t.assert.strictEqual(fetches, 1)
  })

  test('a key published for encryption does not verify signatures', async (t: TestContext) => {
    const keys = generateMockJWKSResponse().keys.map((key: Record<string, unknown>) => ({ ...key, use: 'enc' }))
    const restore = setupMockAgent({ 'https://auth.example.com/.well-known/jwks.json': { keys } })
    t.after(restore)
    const app = Fastify({ logger: false })
    t.after(() => app.close())
    const validator = new TokenValidator(createTestAuthConfig(), app)
    t.assert.strictEqual((await validator.validateToken(createTestJWT())).valid, false)
  })
})
