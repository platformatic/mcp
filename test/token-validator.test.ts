import { test, describe, beforeEach, afterEach } from 'node:test'
import type { TestContext } from 'node:test'
import Fastify from 'fastify'
import { TokenValidator } from '../src/auth/token-validator.ts'
import type { AuthorizationConfig } from '../src/types/auth-types.ts'
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
      t.assert.ok(result.error)
      
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
        'https://auth.example.com/.well-known/jwks.json': generateMockJWKSResponse({
          kid: undefined
        }),
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
})
