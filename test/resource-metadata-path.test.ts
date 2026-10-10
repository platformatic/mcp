import { test, describe } from 'node:test'
import type { TestContext } from 'node:test'
import Fastify from 'fastify'
import mcpPlugin from '../src/index.ts'
import { getResourceMetadataUrl } from '../src/auth/resource-metadata.ts'
import { createSessionAuthPreHandler } from '../src/auth/session-auth-prehandler.ts'
import { TokenValidator } from '../src/auth/token-validator.ts'
import { MemorySessionStore } from '../src/stores/memory-session-store.ts'
import { createTestAuthConfig } from './auth-test-utils.ts'

// RFC 9728 §3.1: the metadata URL is the origin, then
// /.well-known/oauth-protected-resource, then the resource path.
async function followChallenge (t: TestContext, resourceUri: string, expectedMetadataUrl: string) {
  const app = Fastify({ logger: false })
  t.after(() => app.close())

  await app.register(mcpPlugin, {
    serverInfo: { name: 'test-server', version: '1.0.0' },
    authorization: createTestAuthConfig({ resourceUri })
  })
  await app.ready()

  const unauthorized = await app.inject({
    method: 'POST',
    url: '/mcp',
    payload: { jsonrpc: '2.0', id: 1, method: 'ping' }
  })
  t.assert.strictEqual(unauthorized.statusCode, 401)

  const wwwAuth = unauthorized.headers['www-authenticate'] as string
  const match = /resource_metadata="([^"]+)"/.exec(wwwAuth)
  t.assert.ok(match, `missing resource_metadata in ${wwwAuth}`)
  const metadataUrl = match[1]
  t.assert.strictEqual(metadataUrl, expectedMetadataUrl)

  const { pathname } = new URL(metadataUrl)
  const metadata = await app.inject({ method: 'GET', url: pathname })
  t.assert.strictEqual(metadata.statusCode, 200)
  t.assert.strictEqual(metadata.json().resource, resourceUri)
}

describe('Protected resource metadata URL (RFC 9728 §3.1)', () => {
  test('resourceUri without a path', async (t: TestContext) => {
    await followChallenge(t, 'https://mcp.example.com',
      'https://mcp.example.com/.well-known/oauth-protected-resource')
  })

  test('resourceUri with a /mcp path', async (t: TestContext) => {
    await followChallenge(t, 'https://mcp.example.com/mcp',
      'https://mcp.example.com/.well-known/oauth-protected-resource/mcp')
  })

  test('resourceUri with a nested path', async (t: TestContext) => {
    await followChallenge(t, 'https://mcp.example.com/tenant/a',
      'https://mcp.example.com/.well-known/oauth-protected-resource/tenant/a')
  })

  test('root metadata route still works when resourceUri has a path', async (t: TestContext) => {
    const app = Fastify({ logger: false })
    t.after(() => app.close())

    await app.register(mcpPlugin, {
      authorization: createTestAuthConfig({ resourceUri: 'https://mcp.example.com/mcp' })
    })
    await app.ready()

    const response = await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource' })
    t.assert.strictEqual(response.statusCode, 200)
    t.assert.strictEqual(response.json().resource, 'https://mcp.example.com/mcp')
  })

  test('getResourceMetadataUrl ignores a trailing slash', (t: TestContext) => {
    t.assert.strictEqual(getResourceMetadataUrl('https://mcp.example.com/'),
      'https://mcp.example.com/.well-known/oauth-protected-resource')
    t.assert.strictEqual(getResourceMetadataUrl('https://mcp.example.com/mcp/'),
      'https://mcp.example.com/.well-known/oauth-protected-resource/mcp')
  })

  test('session auth preHandler uses the same metadata URL', async (t: TestContext) => {
    const app = Fastify({ logger: false })
    t.after(() => app.close())

    const config = createTestAuthConfig({ resourceUri: 'https://mcp.example.com/mcp' })
    const tokenValidator = new TokenValidator(config, app)
    t.after(() => tokenValidator.close())

    app.addHook('preHandler', createSessionAuthPreHandler({
      config,
      tokenValidator,
      sessionStore: new MemorySessionStore(100)
    }))
    app.get('/mcp', async () => ({ ok: true }))
    await app.ready()

    const response = await app.inject({ method: 'GET', url: '/mcp' })
    t.assert.strictEqual(response.statusCode, 401)
    t.assert.ok((response.headers['www-authenticate'] as string).includes(
      'resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"'))
  })
})
