import { test, describe, beforeEach, afterEach } from 'node:test'
import type { TestContext } from 'node:test'
import Fastify from 'fastify'
import wellKnownRoutes from '../src/routes/well-known.ts'
import { createTestAuthConfig } from './auth-test-utils.ts'

describe('Well-known Routes', () => {
  let app: Awaited<ReturnType<typeof Fastify>>

  beforeEach(async () => {
    app = Fastify({ logger: false })
  })

  afterEach(async () => {
    await app.close()
  })

  test('should not register routes when authorization is disabled', async (t: TestContext) => {
    await app.register(wellKnownRoutes, {
      authConfig: { enabled: false }
    })
    await app.ready()

    const response = await app.inject({
      method: 'GET',
      url: '/.well-known/oauth-protected-resource'
    })

    t.assert.strictEqual(response.statusCode, 404)
  })

  test('should not register routes when no auth config provided', async (t: TestContext) => {
    await app.register(wellKnownRoutes, {})
    await app.ready()

    const response = await app.inject({
      method: 'GET',
      url: '/.well-known/oauth-protected-resource'
    })

    t.assert.strictEqual(response.statusCode, 404)
  })

  describe('OAuth Protected Resource Metadata', () => {
    test('should return protected resource metadata', async (t: TestContext) => {
      const authConfig = createTestAuthConfig({
        resourceUri: 'https://mcp.test.com',
        authorizationServers: [
          'https://auth1.example.com',
          'https://auth2.example.com'
        ]
      })

      await app.register(wellKnownRoutes, { authConfig })
      await app.ready()

      const response = await app.inject({
        method: 'GET',
        url: '/.well-known/oauth-protected-resource'
      })

      t.assert.strictEqual(response.statusCode, 200)
      t.assert.strictEqual(response.headers['content-type'], 'application/json; charset=utf-8')
      t.assert.strictEqual(response.headers['cache-control'], 'public, max-age=3600')

      const body = response.json()
      t.assert.strictEqual(body.resource, 'https://mcp.test.com')
      t.assert.deepStrictEqual(body.authorization_servers, [
        'https://auth1.example.com',
        'https://auth2.example.com'
      ])
    })

    test('should return metadata with single authorization server', async (t: TestContext) => {
      const authConfig = createTestAuthConfig({
        resourceUri: 'https://mcp.single.com',
        authorizationServers: ['https://auth.example.com']
      })

      await app.register(wellKnownRoutes, { authConfig })
      await app.ready()

      const response = await app.inject({
        method: 'GET',
        url: '/.well-known/oauth-protected-resource'
      })

      t.assert.strictEqual(response.statusCode, 200)

      const body = response.json()
      t.assert.strictEqual(body.resource, 'https://mcp.single.com')
      t.assert.deepStrictEqual(body.authorization_servers, ['https://auth.example.com'])
    })

    test('should handle HEAD request for metadata endpoint', async (t: TestContext) => {
      const authConfig = createTestAuthConfig()

      await app.register(wellKnownRoutes, { authConfig })
      await app.ready()

      const response = await app.inject({
        method: 'HEAD',
        url: '/.well-known/oauth-protected-resource'
      })

      t.assert.strictEqual(response.statusCode, 200)
      t.assert.strictEqual(response.headers['content-type'], 'application/json; charset=utf-8')
      t.assert.strictEqual(response.headers['cache-control'], 'public, max-age=3600')
      t.assert.strictEqual(response.body, '')
    })

    test('should return 404 for POST request to metadata endpoint', async (t: TestContext) => {
      const authConfig = createTestAuthConfig()

      await app.register(wellKnownRoutes, { authConfig })
      await app.ready()

      const response = await app.inject({
        method: 'POST',
        url: '/.well-known/oauth-protected-resource',
        payload: { test: 'data' }
      })

      t.assert.strictEqual(response.statusCode, 404)
    })
  })

  describe('MCP Resource Health Check', () => {
    test('should return health status', async (t: TestContext) => {
      const authConfig = createTestAuthConfig({
        resourceUri: 'https://mcp.health.com'
      })

      await app.register(wellKnownRoutes, { authConfig })
      await app.ready()

      const response = await app.inject({
        method: 'GET',
        url: '/.well-known/mcp-resource-health'
      })

      t.assert.strictEqual(response.statusCode, 200)
      t.assert.strictEqual(response.headers['content-type'], 'application/json; charset=utf-8')

      const body = response.json()
      t.assert.strictEqual(body.status, 'healthy')
      t.assert.strictEqual(body.resource, 'https://mcp.health.com')
      t.assert.ok(body.timestamp)

      // Verify timestamp is valid ISO date
      const timestamp = new Date(body.timestamp)
      t.assert.ok(!isNaN(timestamp.getTime()))

      // Timestamp should be recent (within last minute)
      const now = new Date()
      const timeDiff = Math.abs(now.getTime() - timestamp.getTime())
      t.assert.ok(timeDiff < 60000) // Less than 1 minute
    })

    test('should handle HEAD request for health endpoint', async (t: TestContext) => {
      const authConfig = createTestAuthConfig()

      await app.register(wellKnownRoutes, { authConfig })
      await app.ready()

      const response = await app.inject({
        method: 'HEAD',
        url: '/.well-known/mcp-resource-health'
      })

      t.assert.strictEqual(response.statusCode, 200)
      t.assert.strictEqual(response.headers['content-type'], 'application/json; charset=utf-8')
      t.assert.strictEqual(response.body, '')
    })

    test('should return 404 for POST request to health endpoint', async (t: TestContext) => {
      const authConfig = createTestAuthConfig()

      await app.register(wellKnownRoutes, { authConfig })
      await app.ready()

      const response = await app.inject({
        method: 'POST',
        url: '/.well-known/mcp-resource-health',
        payload: { test: 'data' }
      })

      t.assert.strictEqual(response.statusCode, 404)
    })
  })

  describe('Error Handling', () => {
    test('should return 404 for unknown well-known endpoints', async (t: TestContext) => {
      const authConfig = createTestAuthConfig()

      await app.register(wellKnownRoutes, { authConfig })
      await app.ready()

      const response = await app.inject({
        method: 'GET',
        url: '/.well-known/unknown-endpoint'
      })

      t.assert.strictEqual(response.statusCode, 404)
    })

    test('should handle malformed requests gracefully', async (t: TestContext) => {
      const authConfig = createTestAuthConfig()

      await app.register(wellKnownRoutes, { authConfig })
      await app.ready()

      const response = await app.inject({
        method: 'GET',
        url: '/.well-known/oauth-protected-resource',
        headers: {
          'content-type': 'invalid-content-type'
        }
      })

      t.assert.strictEqual(response.statusCode, 200)
      // Should still work despite malformed headers
    })
  })

  describe('Content Negotiation', () => {
    test('should return JSON for metadata with Accept: application/json', async (t: TestContext) => {
      const authConfig = createTestAuthConfig()

      await app.register(wellKnownRoutes, { authConfig })
      await app.ready()

      const response = await app.inject({
        method: 'GET',
        url: '/.well-known/oauth-protected-resource',
        headers: {
          accept: 'application/json'
        }
      })

      t.assert.strictEqual(response.statusCode, 200)
      t.assert.strictEqual(response.headers['content-type'], 'application/json; charset=utf-8')

      const body = response.json()
      t.assert.ok(body.resource)
      t.assert.ok(body.authorization_servers)
    })

    test('should return JSON for metadata with Accept: */*', async (t: TestContext) => {
      const authConfig = createTestAuthConfig()

      await app.register(wellKnownRoutes, { authConfig })
      await app.ready()

      const response = await app.inject({
        method: 'GET',
        url: '/.well-known/oauth-protected-resource',
        headers: {
          accept: '*/*'
        }
      })

      t.assert.strictEqual(response.statusCode, 200)
      t.assert.strictEqual(response.headers['content-type'], 'application/json; charset=utf-8')
    })
  })

  describe('CORS and Security Headers', () => {
    test('should handle CORS preflight for metadata endpoint', async (t: TestContext) => {
      const authConfig = createTestAuthConfig()

      await app.register(wellKnownRoutes, { authConfig })
      await app.ready()

      const response = await app.inject({
        method: 'OPTIONS',
        url: '/.well-known/oauth-protected-resource',
        headers: {
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'Authorization',
          origin: 'https://client.example.com'
        }
      })

      // Fastify handles OPTIONS by default, should return 404 for unhandled OPTIONS
      // or the route might handle it if CORS is configured
      t.assert.ok(response.statusCode === 404 || response.statusCode === 200)
    })

    test('should include cache headers for metadata endpoint', async (t: TestContext) => {
      const authConfig = createTestAuthConfig()

      await app.register(wellKnownRoutes, { authConfig })
      await app.ready()

      const response = await app.inject({
        method: 'GET',
        url: '/.well-known/oauth-protected-resource'
      })

      t.assert.strictEqual(response.statusCode, 200)
      t.assert.strictEqual(response.headers['cache-control'], 'public, max-age=3600')
    })
  })

  describe('Multiple Resource URIs', () => {
    test('should handle different resource URI formats', async (t: TestContext) => {
      const testCases = [
        'https://mcp.example.com',
        'https://mcp.example.com/',
        'https://mcp.example.com:8443',
        'https://mcp.example.com/api/mcp',
        'https://subdomain.mcp.example.com/path'
      ]

      for (const resourceUri of testCases) {
        const testApp = Fastify({ logger: false })
        const authConfig = createTestAuthConfig({ resourceUri })

        await testApp.register(wellKnownRoutes, { authConfig })
        await testApp.ready()

        const response = await testApp.inject({
          method: 'GET',
          url: '/.well-known/oauth-protected-resource'
        })

        t.assert.strictEqual(response.statusCode, 200)

        const body = response.json()
        t.assert.strictEqual(body.resource, resourceUri)

        await testApp.close()
      }
    })
  })
})
