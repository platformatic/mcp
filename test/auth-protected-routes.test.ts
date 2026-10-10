import { test, describe, beforeEach, afterEach } from 'node:test'
import type { TestContext } from 'node:test'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import mcpPlugin from '../src/index.ts'
import type { JSONRPCRequest } from '../src/schema.ts'
import { JSONRPC_VERSION } from '../src/schema.ts'
import {
  createTestAuthConfig,
  createTestJWT,
  setupMockAgent,
  generateMockJWKSResponse
} from './auth-test-utils.ts'

const pingRequest: JSONRPCRequest = {
  jsonrpc: JSONRPC_VERSION,
  id: 1,
  method: 'ping'
}

describe('authorization.protectedRoutes', () => {
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

  test('defaults to protecting every route of the app', async (t: TestContext) => {
    await app.register(mcpPlugin, {
      authorization: createTestAuthConfig()
    })
    app.get('/public', async () => ({ ok: true }))
    await app.ready()

    const response = await app.inject({ method: 'GET', url: '/public' })
    t.assert.strictEqual(response.statusCode, 401)
  })

  test("'all' protects every route of the app", async (t: TestContext) => {
    await app.register(mcpPlugin, {
      authorization: createTestAuthConfig({ protectedRoutes: 'all' })
    })
    app.get('/public', async () => ({ ok: true }))
    await app.ready()

    const response = await app.inject({ method: 'GET', url: '/public' })
    t.assert.strictEqual(response.statusCode, 401)
  })

  test("'mcp' leaves user routes reachable without a token", async (t: TestContext) => {
    await app.register(mcpPlugin, {
      authorization: createTestAuthConfig({ protectedRoutes: 'mcp' })
    })
    app.get('/public', async () => ({ ok: true }))
    await app.ready()

    const response = await app.inject({ method: 'GET', url: '/public' })
    t.assert.strictEqual(response.statusCode, 200)
    t.assert.deepStrictEqual(response.json(), { ok: true })
  })

  test("'mcp' still requires a token on every MCP route", async (t: TestContext) => {
    await app.register(mcpPlugin, {
      enableSSE: true,
      authorization: createTestAuthConfig({ protectedRoutes: 'mcp' })
    })
    app.get('/public', async () => ({ ok: true }))
    await app.ready()

    const post = await app.inject({ method: 'POST', url: '/mcp', payload: pingRequest })
    t.assert.strictEqual(post.statusCode, 401)
    t.assert.ok(post.headers['www-authenticate'])

    const get = await app.inject({
      method: 'GET',
      url: '/mcp',
      headers: { accept: 'text/event-stream' }
    })
    t.assert.strictEqual(get.statusCode, 401)

    const del = await app.inject({
      method: 'DELETE',
      url: '/mcp',
      headers: { 'mcp-session-id': 'some-session' }
    })
    t.assert.strictEqual(del.statusCode, 401)
  })

  test("'mcp' protects the GET route when SSE is disabled", async (t: TestContext) => {
    await app.register(mcpPlugin, {
      authorization: createTestAuthConfig({ protectedRoutes: 'mcp' })
    })
    await app.ready()

    const get = await app.inject({ method: 'GET', url: '/mcp' })
    t.assert.strictEqual(get.statusCode, 401)
  })

  test("'mcp' accepts a valid token on the MCP route", async (t: TestContext) => {
    restoreMock = setupMockAgent({
      'https://auth.example.com/.well-known/jwks.json': generateMockJWKSResponse()
    })

    await app.register(mcpPlugin, {
      authorization: createTestAuthConfig({ protectedRoutes: 'mcp' })
    })
    await app.ready()

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: pingRequest,
      headers: { authorization: `Bearer ${createTestJWT()}` }
    })
    t.assert.strictEqual(response.statusCode, 200)
    t.assert.deepStrictEqual(response.json().result, {})
  })

  test("'mcp' keeps well-known metadata reachable", async (t: TestContext) => {
    await app.register(mcpPlugin, {
      authorization: createTestAuthConfig({ protectedRoutes: 'mcp' })
    })
    await app.ready()

    const response = await app.inject({
      method: 'GET',
      url: '/.well-known/oauth-protected-resource'
    })
    t.assert.strictEqual(response.statusCode, 200)
  })

  test("'mcp' protects MCP routes registered under a prefix", async (t: TestContext) => {
    await app.register(async (api: FastifyInstance) => {
      await api.register(mcpPlugin, {
        authorization: createTestAuthConfig({ protectedRoutes: 'mcp' })
      })
    }, { prefix: '/api' })
    app.get('/public', async () => ({ ok: true }))
    await app.ready()

    const mcp = await app.inject({ method: 'POST', url: '/api/mcp', payload: pingRequest })
    t.assert.strictEqual(mcp.statusCode, 401)

    const pub = await app.inject({ method: 'GET', url: '/public' })
    t.assert.strictEqual(pub.statusCode, 200)
  })
})
