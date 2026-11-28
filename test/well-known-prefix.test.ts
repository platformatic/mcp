import { test, describe } from 'node:test'
import type { TestContext } from 'node:test'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import mcpPlugin, { wellKnownRoutes, getResourceMetadataUrl } from '../src/index.ts'
import type { AuthorizationConfig } from '../src/index.ts'
import { createTestAuthConfig } from './auth-test-utils.ts'

const ping = { jsonrpc: '2.0', id: 1, method: 'ping' }

async function buildPrefixedApp (t: TestContext, authorization: AuthorizationConfig, prefix = '/api') {
  const app = Fastify({ logger: false })
  t.after(() => app.close())
  await app.register(async (api: FastifyInstance) => {
    await api.register(mcpPlugin, {
      serverInfo: { name: 'test-server', version: '1.0.0' },
      authorization
    })
  }, { prefix })
  return app
}

function advertisedMetadataUrl (wwwAuthenticate: string): string {
  const match = /resource_metadata="([^"]+)"/.exec(wwwAuthenticate)
  if (!match) {
    throw new Error(`missing resource_metadata in ${wwwAuthenticate}`)
  }
  return match[1]
}

// Issue #340: OAuth discovery must work when the plugin is registered under a prefix.
describe('Protected resource metadata under a route prefix', () => {
  for (const protectedRoutes of ['all', 'mcp'] as const) {
    test(`well-known routes are public under the prefix (protectedRoutes: '${protectedRoutes}')`, async (t: TestContext) => {
      const app = await buildPrefixedApp(t, createTestAuthConfig({
        resourceUri: 'https://mcp.example.com/api/mcp',
        protectedRoutes
      }))
      await app.ready()

      for (const url of [
        '/api/.well-known/oauth-protected-resource',
        '/api/.well-known/oauth-protected-resource/api/mcp',
        '/api/.well-known/oauth-protected-resource/mcp',
        '/api/.well-known/mcp-resource-health'
      ]) {
        const response = await app.inject({ method: 'GET', url })
        t.assert.strictEqual(response.statusCode, 200, `${url}: ${response.body}`)
      }
    })
  }

  test('the advertised resource_metadata URL resolves to the metadata', async (t: TestContext) => {
    const resourceUri = 'https://mcp.example.com/api/mcp'
    const app = await buildPrefixedApp(t, createTestAuthConfig({ resourceUri }))
    await app.ready()

    const unauthorized = await app.inject({ method: 'POST', url: '/api/mcp', payload: ping })
    t.assert.strictEqual(unauthorized.statusCode, 401)

    const metadataUrl = advertisedMetadataUrl(unauthorized.headers['www-authenticate'] as string)
    t.assert.strictEqual(metadataUrl,
      'https://mcp.example.com/api/.well-known/oauth-protected-resource/api/mcp')

    const metadata = await app.inject({ method: 'GET', url: new URL(metadataUrl).pathname })
    t.assert.strictEqual(metadata.statusCode, 200, metadata.body)
    t.assert.strictEqual(metadata.json().resource, resourceUri)
  })

  test('a nested prefix is reflected in the advertised URL', async (t: TestContext) => {
    const resourceUri = 'https://mcp.example.com'
    const app = await buildPrefixedApp(t, createTestAuthConfig({ resourceUri }), '/v1/tenant')
    await app.ready()

    const unauthorized = await app.inject({ method: 'POST', url: '/v1/tenant/mcp', payload: ping })
    const metadataUrl = advertisedMetadataUrl(unauthorized.headers['www-authenticate'] as string)
    t.assert.strictEqual(metadataUrl,
      'https://mcp.example.com/v1/tenant/.well-known/oauth-protected-resource')

    const metadata = await app.inject({ method: 'GET', url: new URL(metadataUrl).pathname })
    t.assert.strictEqual(metadata.statusCode, 200, metadata.body)
    t.assert.strictEqual(metadata.json().resource, resourceUri)
  })

  test('CORS preflight on the prefixed metadata route is answered', async (t: TestContext) => {
    const app = await buildPrefixedApp(t, createTestAuthConfig())
    await app.ready()

    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/api/.well-known/oauth-protected-resource',
      headers: {
        origin: 'https://client.example.com',
        'access-control-request-method': 'GET'
      }
    })
    t.assert.strictEqual(preflight.statusCode, 204)
    t.assert.strictEqual(preflight.headers['access-control-allow-origin'], 'https://client.example.com')
  })

  test('other routes under the prefix still require a token', async (t: TestContext) => {
    const app = Fastify({ logger: false })
    t.after(() => app.close())
    await app.register(async (api: FastifyInstance) => {
      await api.register(mcpPlugin, {
        serverInfo: { name: 'test-server', version: '1.0.0' },
        authorization: createTestAuthConfig()
      })
      api.get('/private', async () => ({ ok: true }))
    }, { prefix: '/api' })
    await app.ready()

    const response = await app.inject({ method: 'GET', url: '/api/private' })
    t.assert.strictEqual(response.statusCode, 401)
  })

  test('OAuth flow entry points are public under the prefix', async (t: TestContext) => {
    const app = await buildPrefixedApp(t, createTestAuthConfig({
      oauth2Client: {
        clientId: 'test-client',
        authorizationServer: 'https://auth.example.com'
      }
    }))
    await app.ready()

    const response = await app.inject({
      method: 'GET',
      url: '/api/oauth/authorize?resource=https://mcp.example.com'
    })
    t.assert.strictEqual(response.statusCode, 302, response.body)
  })

  test('resourceMetadataUrl overrides the advertised URL, with the routes mounted at the origin root', async (t: TestContext) => {
    // RFC 9728 §3.1 location for https://mcp.example.com/api/mcp. A plugin
    // registered under /api cannot add routes outside it, so the application
    // mounts the well-known routes at the root itself.
    const resourceUri = 'https://mcp.example.com/api/mcp'
    const authorization = createTestAuthConfig({
      resourceUri,
      resourceMetadataUrl: getResourceMetadataUrl(resourceUri)
    })
    const app = await buildPrefixedApp(t, authorization)
    await app.register(wellKnownRoutes, { authConfig: authorization })
    await app.ready()

    const unauthorized = await app.inject({ method: 'POST', url: '/api/mcp', payload: ping })
    t.assert.strictEqual(unauthorized.statusCode, 401)
    const metadataUrl = advertisedMetadataUrl(unauthorized.headers['www-authenticate'] as string)
    t.assert.strictEqual(metadataUrl,
      'https://mcp.example.com/.well-known/oauth-protected-resource/api/mcp')

    const metadata = await app.inject({ method: 'GET', url: new URL(metadataUrl).pathname })
    t.assert.strictEqual(metadata.statusCode, 200, metadata.body)
    t.assert.strictEqual(metadata.json().resource, resourceUri)
  })

  test('without a prefix the advertised URL is unchanged', async (t: TestContext) => {
    const app = Fastify({ logger: false })
    t.after(() => app.close())
    await app.register(mcpPlugin, {
      serverInfo: { name: 'test-server', version: '1.0.0' },
      authorization: createTestAuthConfig({ resourceUri: 'https://mcp.example.com/mcp' })
    })
    await app.ready()

    const unauthorized = await app.inject({ method: 'POST', url: '/mcp', payload: ping })
    t.assert.strictEqual(advertisedMetadataUrl(unauthorized.headers['www-authenticate'] as string),
      'https://mcp.example.com/.well-known/oauth-protected-resource/mcp')
  })
})
