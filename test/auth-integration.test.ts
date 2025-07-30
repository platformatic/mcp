import { test, describe, beforeEach, afterEach } from 'node:test'
import type { TestContext } from 'node:test'
import Fastify from 'fastify'
import mcpPlugin from '../src/index.ts'
import type { JSONRPCRequest, InitializeResult } from '../src/schema.ts'
import { JSONRPC_VERSION, LATEST_PROTOCOL_VERSION } from '../src/schema.ts'
import {
  createTestAuthConfig,
  createTestJWT,
  createExpiredJWT,
  createJWTWithInvalidAudience,
  setupMockAgent,
  generateMockJWKSResponse,
  createIntrospectionResponse
} from './auth-test-utils.ts'

describe('Authorization Integration Tests', () => {
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

  describe('Plugin Registration with Authorization', () => {
    test('should register plugin with authorization enabled', async (t: TestContext) => {
      const authConfig = createTestAuthConfig()

      await app.register(mcpPlugin, {
        serverInfo: { name: 'test-server', version: '1.0.0' },
        authorization: authConfig
      })
      await app.ready()

      t.assert.ok(app.hasPlugin('@platformatic/mcp'))
    })

    test('should register plugin with authorization disabled', async (t: TestContext) => {
      await app.register(mcpPlugin, {
        serverInfo: { name: 'test-server', version: '1.0.0' },
        authorization: { enabled: false }
      })
      await app.ready()

      t.assert.ok(app.hasPlugin('@platformatic/mcp'))
    })

    test('should register plugin without authorization config', async (t: TestContext) => {
      await app.register(mcpPlugin, {
        serverInfo: { name: 'test-server', version: '1.0.0' }
      })
      await app.ready()

      t.assert.ok(app.hasPlugin('@platformatic/mcp'))
    })
  })

  describe('Well-known Endpoints with Authorization', () => {
    test('should serve protected resource metadata when authorization enabled', async (t: TestContext) => {
      const authConfig = createTestAuthConfig({
        resourceUri: 'https://test.mcp.com',
        authorizationServers: ['https://auth.test.com']
      })

      await app.register(mcpPlugin, {
        authorization: authConfig
      })
      await app.ready()

      const response = await app.inject({
        method: 'GET',
        url: '/.well-known/oauth-protected-resource'
      })

      t.assert.strictEqual(response.statusCode, 200)

      const body = response.json()
      t.assert.strictEqual(body.resource, 'https://test.mcp.com')
      t.assert.deepStrictEqual(body.authorization_servers, ['https://auth.test.com'])
    })

    test('should not serve protected resource metadata when authorization disabled', async (t: TestContext) => {
      await app.register(mcpPlugin, {
        authorization: { enabled: false }
      })
      await app.ready()

      const response = await app.inject({
        method: 'GET',
        url: '/.well-known/oauth-protected-resource'
      })

      t.assert.strictEqual(response.statusCode, 404)
    })

    test('should serve health check when authorization enabled', async (t: TestContext) => {
      const authConfig = createTestAuthConfig({
        resourceUri: 'https://health.mcp.com'
      })

      await app.register(mcpPlugin, {
        authorization: authConfig
      })
      await app.ready()

      const response = await app.inject({
        method: 'GET',
        url: '/.well-known/mcp-resource-health'
      })

      t.assert.strictEqual(response.statusCode, 200)

      const body = response.json()
      t.assert.strictEqual(body.status, 'healthy')
      t.assert.strictEqual(body.resource, 'https://health.mcp.com')
    })
  })

  describe('MCP Protocol with Authorization', () => {
    test('should require authorization for MCP initialize request', async (t: TestContext) => {
      const authConfig = createTestAuthConfig()
      restoreMock = setupMockAgent({
        'https://auth.example.com/.well-known/jwks.json': generateMockJWKSResponse()
      })

      await app.register(mcpPlugin, {
        authorization: authConfig
      })
      await app.ready()

      const initRequest: JSONRPCRequest = {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' }
        }
      }

      // Request without authorization should fail
      const response1 = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload: initRequest
      })

      t.assert.strictEqual(response1.statusCode, 401)

      const body1 = response1.json()
      t.assert.strictEqual(body1.error, 'authorization_required')

      // Request with valid token should succeed
      const token = createTestJWT()
      const response2 = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload: initRequest,
        headers: {
          authorization: `Bearer ${token}`
        }
      })

      t.assert.strictEqual(response2.statusCode, 200)

      const body2 = response2.json() as InitializeResult
      t.assert.strictEqual(body2.jsonrpc, JSONRPC_VERSION)
      t.assert.strictEqual(body2.id, 1)
      t.assert.ok(body2.result)
    })

    test('should reject MCP requests with invalid tokens', async (t: TestContext) => {
      const authConfig = createTestAuthConfig()
      restoreMock = setupMockAgent({
        'https://auth.example.com/.well-known/jwks.json': generateMockJWKSResponse()
      })

      await app.register(mcpPlugin, {
        authorization: authConfig
      })
      await app.ready()

      const initRequest: JSONRPCRequest = {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' }
        }
      }

      // Test with expired token
      const expiredToken = createExpiredJWT()
      const response1 = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload: initRequest,
        headers: {
          authorization: `Bearer ${expiredToken}`
        }
      })

      t.assert.strictEqual(response1.statusCode, 401)

      // Test with invalid audience
      const invalidAudToken = createJWTWithInvalidAudience()
      const response2 = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload: initRequest,
        headers: {
          authorization: `Bearer ${invalidAudToken}`
        }
      })

      t.assert.strictEqual(response2.statusCode, 401)

      // Test with malformed token
      const response3 = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload: initRequest,
        headers: {
          authorization: 'Bearer invalid-token'
        }
      })

      t.assert.strictEqual(response3.statusCode, 401)
    })

    test('should work without authorization when disabled', async (t: TestContext) => {
      await app.register(mcpPlugin, {
        authorization: { enabled: false }
      })
      await app.ready()

      const initRequest: JSONRPCRequest = {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' }
        }
      }

      const response = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload: initRequest
      })

      t.assert.strictEqual(response.statusCode, 200)

      const body = response.json() as InitializeResult
      t.assert.strictEqual(body.jsonrpc, JSONRPC_VERSION)
      t.assert.strictEqual(body.id, 1)
      t.assert.ok(body.result)
    })
  })

  describe('SSE with Authorization', () => {
    test('should require authorization for SSE connections', async (t: TestContext) => {
      const authConfig = createTestAuthConfig()
      restoreMock = setupMockAgent({
        'https://auth.example.com/.well-known/jwks.json': generateMockJWKSResponse()
      })

      await app.register(mcpPlugin, {
        enableSSE: true,
        authorization: authConfig
      })
      await app.ready()

      // SSE request without authorization should fail
      const response = await app.inject({
        method: 'GET',
        url: '/mcp',
        payloadAsStream: true,
        headers: {
          accept: 'text/event-stream'
        }
      })

      t.assert.strictEqual(response.statusCode, 401)
      response.stream().destroy()
    })

    test('should allow SSE connections with valid tokens', async (t: TestContext) => {
      const authConfig = createTestAuthConfig()
      restoreMock = setupMockAgent({
        'https://auth.example.com/.well-known/jwks.json': generateMockJWKSResponse()
      })

      await app.register(mcpPlugin, {
        enableSSE: true,
        authorization: authConfig
      })
      await app.ready()

      const token = createTestJWT()
      const response = await app.inject({
        method: 'GET',
        url: '/mcp',
        payloadAsStream: true,
        headers: {
          accept: 'text/event-stream',
          authorization: `Bearer ${token}`
        }
      })

      t.assert.strictEqual(response.statusCode, 200)
      t.assert.strictEqual(response.headers['content-type'], 'text/event-stream')
      response.stream().destroy()
    })
  })

  describe('Token Introspection Integration', () => {
    test('should work with token introspection endpoint', async (t: TestContext) => {
      const authConfig = createTestAuthConfig({
        tokenValidation: {
          introspectionEndpoint: 'https://auth.example.com/introspect',
          validateAudience: true
        }
      })

      restoreMock = setupMockAgent({
        'https://auth.example.com/introspect': createIntrospectionResponse(true)
      })

      await app.register(mcpPlugin, {
        authorization: authConfig
      })
      await app.ready()

      const initRequest: JSONRPCRequest = {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' }
        }
      }

      const response = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload: initRequest,
        headers: {
          authorization: 'Bearer opaque-token-123'
        }
      })

      t.assert.strictEqual(response.statusCode, 200)

      const body = response.json() as InitializeResult
      t.assert.strictEqual(body.jsonrpc, JSONRPC_VERSION)
      t.assert.ok(body.result)
    })

    test('should reject inactive tokens from introspection', async (t: TestContext) => {
      const authConfig = createTestAuthConfig({
        tokenValidation: {
          introspectionEndpoint: 'https://auth.example.com/introspect',
          validateAudience: true
        }
      })

      restoreMock = setupMockAgent({
        'https://auth.example.com/introspect': createIntrospectionResponse(false)
      })

      await app.register(mcpPlugin, {
        authorization: authConfig
      })
      await app.ready()

      const initRequest: JSONRPCRequest = {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' }
        }
      }

      const response = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload: initRequest,
        headers: {
          authorization: 'Bearer inactive-token'
        }
      })

      t.assert.strictEqual(response.statusCode, 401)
    })
  })

  describe('Error Handling Integration', () => {
    test('should handle JWT validation errors gracefully', async (t: TestContext) => {
      const authConfig = createTestAuthConfig()
      // Don't mock fetch to trigger JWKS fetch errors
      restoreMock = setupMockAgent({})

      await app.register(mcpPlugin, {
        authorization: authConfig
      })
      await app.ready()

      const initRequest: JSONRPCRequest = {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' }
        }
      }

      const token = createTestJWT()
      const response = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload: initRequest,
        headers: {
          authorization: `Bearer ${token}`
        }
      })

      t.assert.strictEqual(response.statusCode, 401)

      const body = response.json()
      t.assert.strictEqual(body.error, 'invalid_token')
    })

    test('should provide proper WWW-Authenticate headers', async (t: TestContext) => {
      const authConfig = createTestAuthConfig({
        resourceUri: 'https://custom.mcp.server'
      })

      await app.register(mcpPlugin, {
        authorization: authConfig
      })
      await app.ready()

      const response = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload: { test: 'request' }
      })

      t.assert.strictEqual(response.statusCode, 401)

      const wwwAuth = response.headers['www-authenticate']
      t.assert.ok(wwwAuth)
      t.assert.ok(wwwAuth.includes('Bearer realm="MCP Server"'))
      t.assert.ok(wwwAuth.includes('resource_metadata="https://custom.mcp.server/.well-known/oauth-protected-resource"'))
    })
  })

  describe('Multi-endpoint Authorization', () => {
    test('should protect all MCP endpoints consistently', async (t: TestContext) => {
      const authConfig = createTestAuthConfig()
      restoreMock = setupMockAgent({
        'https://auth.example.com/.well-known/jwks.json': generateMockJWKSResponse()
      })

      await app.register(mcpPlugin, {
        authorization: authConfig,
        enableSSE: true
      })
      await app.ready()

      const token = createTestJWT()

      // Test POST /mcp
      const postResponse = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload: {
          jsonrpc: JSONRPC_VERSION,
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'test', version: '1.0.0' }
          }
        },
        headers: { authorization: `Bearer ${token}` }
      })
      t.assert.strictEqual(postResponse.statusCode, 200)

      // Test GET /mcp (SSE)
      const getResponse = await app.inject({
        method: 'GET',
        url: '/mcp',
        payloadAsStream: true,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'text/event-stream'
        }
      })
      getResponse.stream().destroy()
      t.assert.strictEqual(getResponse.statusCode, 200)

      // Test that well-known endpoints don't require auth
      const wellKnownResponse = await app.inject({
        method: 'GET',
        url: '/.well-known/oauth-protected-resource'
      })
      t.assert.strictEqual(wellKnownResponse.statusCode, 200)
    })
  })
})
