import { describe, test } from 'node:test'
import type { TestContext } from 'node:test'
import Fastify from 'fastify'
import mcpPlugin from '../src/index.ts'
import { JSONRPC_VERSION } from '../src/schema.ts'
import type { FastifySchema, HTTPMethods, RouteOptions } from 'fastify'
import type { MCPRouteSchemaContext, MCPRouteSchemaTransformer } from '../src/types.ts'
import { createTestAuthConfig } from './auth-test-utils.ts'

type OpenApiRouteSchema = FastifySchema & Record<string, unknown>

interface CapturedRoute {
  method: HTTPMethods
  url: string
  schema: OpenApiRouteSchema | undefined
}

function captureMcpRoutes (app: ReturnType<typeof Fastify>): CapturedRoute[] {
  const routes: CapturedRoute[] = []

  app.addHook('onRoute', (route: RouteOptions) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method]
    for (const method of methods) {
      if (/\/mcp$/.test(route.url)) {
        routes.push({
          method: method as HTTPMethods,
          url: route.url,
          schema: route.schema as OpenApiRouteSchema | undefined
        })
      }
    }
  })

  return routes
}

describe('MCP route schema customization', () => {
  test('plugin registration works without transformRouteSchema and keeps schemas unchanged', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())

    const captured = captureMcpRoutes(app)

    await app.register(mcpPlugin)
    await app.ready()

    const postRoute = captured.find(r => r.method === 'POST' && r.url === '/mcp')
    const getRoute = captured.find(r => r.method === 'GET' && r.url === '/mcp')

    t.assert.ok(postRoute)
    t.assert.ok(getRoute)
    t.assert.strictEqual(postRoute?.schema, undefined)
    t.assert.strictEqual(getRoute?.schema, undefined)
  })

  test('transformer is called for POST only when SSE is disabled', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())

    const contexts: MCPRouteSchemaContext[] = []
    const transformer: MCPRouteSchemaTransformer = (schema, context) => {
      contexts.push(context)
      return {
        ...schema,
        tags: ['MCP']
      }
    }

    await app.register(mcpPlugin, {
      transformRouteSchema: transformer
    })
    await app.ready()

    t.assert.strictEqual(contexts.length, 1)
    t.assert.strictEqual(contexts[0].routeId, 'mcp.post')
    t.assert.strictEqual(contexts[0].method, 'POST')
    t.assert.strictEqual(contexts[0].url, '/mcp')
  })

  test('transformer is called for POST, GET and DELETE when SSE is enabled', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())

    const seen = new Map<string, MCPRouteSchemaContext>()
    const transformer: MCPRouteSchemaTransformer = (schema, context) => {
      seen.set(context.routeId, context)
      return {
        ...schema,
        operationId: context.routeId.replace('.', '-')
      }
    }

    await app.register(mcpPlugin, {
      enableSSE: true,
      transformRouteSchema: transformer
    })
    await app.ready()

    t.assert.strictEqual(seen.size, 3)
    t.assert.strictEqual(seen.get('mcp.post')?.method, 'POST')
    t.assert.strictEqual(seen.get('mcp.get')?.method, 'GET')
    t.assert.strictEqual(seen.get('mcp.delete')?.method, 'DELETE')
    t.assert.strictEqual(seen.get('mcp.post')?.url, '/mcp')
    t.assert.strictEqual(seen.get('mcp.get')?.url, '/mcp')
    t.assert.strictEqual(seen.get('mcp.delete')?.url, '/mcp')
  })

  test('transformer receives prefixed URL in context', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())

    const contexts: MCPRouteSchemaContext[] = []

    await app.register(async function (instance) {
      await instance.register(mcpPlugin, {
        transformRouteSchema: (schema, context) => {
          contexts.push(context)
          return schema
        }
      })
    }, { prefix: '/v1' })

    await app.ready()

    t.assert.strictEqual(contexts.length, 1)
    t.assert.strictEqual(contexts[0].url, '/v1/mcp')
  })

  test('returned schema is used for route registration and can include OpenAPI metadata', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())

    const captured = captureMcpRoutes(app)

    await app.register(mcpPlugin, {
      enableSSE: true,
      transformRouteSchema (schema, { routeId }) {
        return {
          ...schema,
          tags: ['MCP'],
          security: [{ oauth2: ['tools:read'] }],
          operationId: routeId.replace('.', '-'),
          description: `Route ${routeId}`,
          'x-roles': ['admin']
        }
      }
    })
    await app.ready()

    const postRoute = captured.find(r => r.method === 'POST' && r.url === '/mcp')
    const getRoute = captured.find(r => r.method === 'GET' && r.url === '/mcp')
    const deleteRoute = captured.find(r => r.method === 'DELETE' && r.url === '/mcp')

    t.assert.deepStrictEqual(postRoute?.schema?.tags, ['MCP'])
    t.assert.deepStrictEqual(postRoute?.schema?.security, [{ oauth2: ['tools:read'] }])
    t.assert.deepStrictEqual(postRoute?.schema?.['x-roles'], ['admin'])

    t.assert.strictEqual(getRoute?.schema?.operationId, 'mcp-get')
    t.assert.strictEqual(deleteRoute?.schema?.description, 'Route mcp.delete')
  })

  test('transformer can override fields deliberately', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())

    const captured = captureMcpRoutes(app)

    await app.register(mcpPlugin, {
      transformRouteSchema: (schema) => ({
        ...schema,
        tags: ['overridden'],
        description: 'overridden'
      })
    })

    await app.ready()

    const postRoute = captured.find(r => r.method === 'POST' && r.url === '/mcp')
    t.assert.deepStrictEqual(postRoute?.schema?.tags, ['overridden'])
    t.assert.strictEqual(postRoute?.schema?.description, 'overridden')
  })

  test('transformer runs only during registration and not per request', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())

    let calls = 0
    await app.register(mcpPlugin, {
      transformRouteSchema: (schema) => {
        calls++
        return {
          ...schema,
          tags: ['MCP']
        }
      }
    })
    await app.ready()

    t.assert.strictEqual(calls, 1)

    const request = {
      jsonrpc: JSONRPC_VERSION,
      id: 1,
      method: 'ping'
    }

    const first = await app.inject({ method: 'POST', url: '/mcp', payload: request })
    const second = await app.inject({ method: 'POST', url: '/mcp', payload: request })

    t.assert.strictEqual(first.statusCode, 200)
    t.assert.strictEqual(second.statusCode, 200)
    t.assert.strictEqual(calls, 1)
  })

  test('thrown transformer error rejects plugin registration', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())

    await t.assert.rejects(async () => {
      await app.register(mcpPlugin, {
        transformRouteSchema: () => {
          throw new Error('schema transform failed')
        }
      })
      await app.ready()
    }, /schema transform failed/)
  })

  test('invalid transformer return values reject plugin registration with route id', async (t: TestContext) => {
    const invalidCases = [
      { value: undefined, expected: /mcp\.post/ },
      { value: null, expected: /mcp\.post/ },
      { value: [], expected: /mcp\.post/ },
      { value: 42, expected: /mcp\.post/ },
      { value: 'invalid', expected: /mcp\.post/ }
    ]

    for (const testCase of invalidCases) {
      const app = Fastify()
      t.after(() => app.close())

      await t.assert.rejects(async () => {
        await app.register(mcpPlugin, {
          transformRouteSchema: () => testCase.value as any
        })
        await app.ready()
      }, testCase.expected)
    }
  })

  test('async transformers are rejected at runtime', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())

    const asyncTransformer = async (schema: FastifySchema) => ({
      ...schema,
      tags: ['MCP']
    })

    await t.assert.rejects(async () => {
      await app.register(mcpPlugin, {
        // Deliberately bypass TypeScript to mimic JavaScript consumers and casts.
        transformRouteSchema: asyncTransformer as unknown as MCPRouteSchemaTransformer
      })
      await app.ready()
    }, /must return a synchronous Fastify schema object for mcp\.post/)
  })

  test('two encapsulated plugin instances use independent transformers', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())

    const captured = captureMcpRoutes(app)

    await app.register(async function (instance) {
      await instance.register(mcpPlugin, {
        transformRouteSchema (schema) {
          return {
            ...schema,
            tags: ['instance-a']
          }
        }
      })
    }, { prefix: '/a' })

    await app.register(async function (instance) {
      await instance.register(mcpPlugin, {
        transformRouteSchema (schema) {
          return {
            ...schema,
            tags: ['instance-b']
          }
        }
      })
    }, { prefix: '/b' })

    await app.ready()

    const aPost = captured.find(r => r.method === 'POST' && r.url === '/a/mcp')
    const bPost = captured.find(r => r.method === 'POST' && r.url === '/b/mcp')

    t.assert.deepStrictEqual(aPost?.schema?.tags, ['instance-a'])
    t.assert.deepStrictEqual(bPost?.schema?.tags, ['instance-b'])
  })

  test('transformer does not run for unrelated or OAuth routes', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())

    const contexts: MCPRouteSchemaContext[] = []

    app.get('/health', {
      schema: {
        description: 'health route'
      } as FastifySchema
    }, async () => ({ ok: true }))

    await app.register(mcpPlugin, {
      authorization: createTestAuthConfig(),
      transformRouteSchema: (schema, context) => {
        contexts.push(context)
        return {
          ...schema,
          tags: ['MCP']
        }
      }
    })
    await app.ready()

    t.assert.strictEqual(contexts.length, 1)
    t.assert.strictEqual(contexts[0].routeId, 'mcp.post')
  })
})
