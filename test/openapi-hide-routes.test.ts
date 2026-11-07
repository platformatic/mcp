import { describe, test } from 'node:test'
import type { TestContext } from 'node:test'
import Fastify from 'fastify'
import swagger from '@fastify/swagger'
import mcpPlugin from '../src/index.ts'
import type { MCPRouteSchemaContext } from '../src/types.ts'
import { createTestAuthConfig, setupMockAgent } from './auth-test-utils.ts'

// Regression tests for https://github.com/platformatic/mcp/issues/72:
// every route the plugin registers must go through transformRouteSchema so
// it can be hidden from a generated OpenAPI document.

async function buildApp (t: TestContext, mcpOptions: Parameters<typeof mcpPlugin>[1]) {
  const app = Fastify()
  t.after(() => app.close())

  await app.register(swagger, { openapi: { info: { title: 'api', version: '1.0.0' } } })
  app.get('/users', async () => [])
  await app.register(mcpPlugin, mcpOptions)
  await app.ready()

  return app
}

function documentedPaths (app: Awaited<ReturnType<typeof buildApp>>): string[] {
  return Object.keys(app.swagger().paths ?? {}).sort()
}

const oauthDiscovery = {
  'https://auth.example.com/.well-known/oauth-authorization-server': {
    authorization_endpoint: 'https://auth.example.com/oauth/authorize',
    token_endpoint: 'https://auth.example.com/oauth/token',
    introspection_endpoint: 'https://auth.example.com/oauth/introspect',
    registration_endpoint: 'https://auth.example.com/oauth/register'
  }
}

describe('Hiding MCP routes from OpenAPI', () => {
  test('MCP routes are documented by default', async (t: TestContext) => {
    const app = await buildApp(t, {})

    t.assert.deepStrictEqual(documentedPaths(app), ['/mcp', '/users'])
  })

  test('schema.hide removes every MCP route when SSE is disabled', async (t: TestContext) => {
    const app = await buildApp(t, {
      transformRouteSchema: (schema) => ({ ...schema, hide: true })
    })

    t.assert.deepStrictEqual(documentedPaths(app), ['/users'])
  })

  test('schema.hide removes every MCP route when SSE is enabled', async (t: TestContext) => {
    const app = await buildApp(t, {
      enableSSE: true,
      transformRouteSchema: (schema) => ({ ...schema, hide: true })
    })

    t.assert.deepStrictEqual(documentedPaths(app), ['/users'])
  })

  test('hiddenTag removes every MCP route', async (t: TestContext) => {
    const app = await buildApp(t, {
      transformRouteSchema: (schema) => ({ ...schema, tags: ['X-HIDDEN'] })
    })

    t.assert.deepStrictEqual(documentedPaths(app), ['/users'])
  })

  test('schema.hide removes the well-known routes registered for authorization', async (t: TestContext) => {
    const contexts: MCPRouteSchemaContext[] = []
    const app = await buildApp(t, {
      authorization: createTestAuthConfig({ resourceUri: 'https://mcp.example.com/api' }),
      transformRouteSchema: (schema, context) => {
        contexts.push(context)
        return { ...schema, hide: true }
      }
    })

    t.assert.deepStrictEqual(documentedPaths(app), ['/users'])
    t.assert.deepStrictEqual(contexts.map(c => `${c.routeId} ${c.method} ${c.url}`).sort(), [
      'mcp.delete DELETE /mcp',
      'mcp.get GET /mcp',
      'mcp.post POST /mcp',
      'wellKnown.preflight OPTIONS /.well-known/*',
      'wellKnown.protectedResourceMetadata GET /.well-known/oauth-protected-resource',
      'wellKnown.protectedResourceMetadata GET /.well-known/oauth-protected-resource/api',
      'wellKnown.protectedResourceMetadata GET /.well-known/oauth-protected-resource/mcp',
      'wellKnown.resourceHealth GET /.well-known/mcp-resource-health'
    ])
  })

  test('schema.hide removes the OAuth client routes', async (t: TestContext) => {
    const restoreMock = setupMockAgent(oauthDiscovery)
    t.after(restoreMock)

    const contexts: MCPRouteSchemaContext[] = []
    const app = await buildApp(t, {
      authorization: createTestAuthConfig({
        oauth2Client: {
          clientId: 'test-client',
          authorizationServer: 'https://auth.example.com',
          resourceUri: 'https://mcp.example.com',
          clientIdMetadataDocument: true
        }
      }),
      transformRouteSchema: (schema, context) => {
        contexts.push(context)
        return { ...schema, hide: true }
      }
    })

    t.assert.deepStrictEqual(documentedPaths(app), ['/users'])
    const oauthRoutes = contexts
      .filter(c => c.routeId.startsWith('oauth.'))
      .map(c => `${c.routeId} ${c.method} ${c.url}`)
      .sort()
    t.assert.deepStrictEqual(oauthRoutes, [
      'oauth.authorize GET /oauth/authorize',
      'oauth.callback GET /oauth/callback',
      'oauth.clientIdMetadataDocument GET /.well-known/oauth-client',
      'oauth.logout POST /oauth/logout',
      'oauth.refresh POST /oauth/refresh',
      'oauth.register POST /oauth/register',
      'oauth.status GET /oauth/status',
      'oauth.validate POST /oauth/validate'
    ])
  })

  test('route schemas are preserved and prefixes are reported', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())

    const contexts: MCPRouteSchemaContext[] = []
    await app.register(swagger, { openapi: {} })
    await app.register(async (instance) => {
      await instance.register(mcpPlugin, {
        authorization: createTestAuthConfig(),
        transformRouteSchema: (schema, context) => {
          contexts.push(context)
          return { ...schema, tags: ['MCP'] }
        }
      })
    }, { prefix: '/v1' })
    await app.ready()

    const spec = app.swagger()
    const health = spec.paths?.['/v1/.well-known/mcp-resource-health']?.get
    t.assert.deepStrictEqual(health?.tags, ['MCP'])
    t.assert.ok(health?.responses?.['200'])
    t.assert.ok(contexts.length > 0)
    t.assert.ok(contexts.every(c => c.url.startsWith('/v1/')))
  })
})
