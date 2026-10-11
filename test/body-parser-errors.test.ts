import { test, describe } from 'node:test'
import type { TestContext } from 'node:test'
import Fastify from 'fastify'
import mcpPlugin from '../src/index.ts'
import { JSONRPC_VERSION, PARSE_ERROR, INVALID_REQUEST } from '../src/schema.ts'

describe('body-parser errors on POST /mcp', () => {
  test('malformed JSON returns a JSON-RPC Parse error', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())
    await app.register(mcpPlugin)
    await app.ready()

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json' },
      payload: '{"jsonrpc": "2.0", "id": 1, "method": '
    })

    t.assert.strictEqual(response.statusCode, 400)
    t.assert.match(response.headers['content-type'] as string, /application\/json/)
    t.assert.deepStrictEqual(response.json(), {
      jsonrpc: JSONRPC_VERSION,
      id: null,
      error: { code: PARSE_ERROR, message: 'Parse error' }
    })
  })

  test('empty JSON body returns a JSON-RPC Parse error', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())
    await app.register(mcpPlugin)
    await app.ready()

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json' },
      payload: ''
    })

    t.assert.strictEqual(response.statusCode, 400)
    t.assert.deepStrictEqual(response.json(), {
      jsonrpc: JSONRPC_VERSION,
      id: null,
      error: { code: PARSE_ERROR, message: 'Parse error' }
    })
  })

  test('body over the limit returns a JSON-RPC Invalid Request with 413', async (t: TestContext) => {
    const app = Fastify({ bodyLimit: 64 })
    t.after(() => app.close())
    await app.register(mcpPlugin)
    await app.ready()

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'ping',
        params: { padding: 'x'.repeat(256) }
      }
    })

    t.assert.strictEqual(response.statusCode, 413)
    t.assert.deepStrictEqual(response.json(), {
      jsonrpc: JSONRPC_VERSION,
      id: null,
      error: { code: INVALID_REQUEST, message: 'Invalid Request' }
    })
  })

  test('unsupported content-type returns a JSON-RPC Invalid Request with 415', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())
    await app.register(mcpPlugin)
    await app.ready()

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/xml' },
      payload: '<jsonrpc/>'
    })

    t.assert.strictEqual(response.statusCode, 415)
    t.assert.deepStrictEqual(response.json(), {
      jsonrpc: JSONRPC_VERSION,
      id: null,
      error: { code: INVALID_REQUEST, message: 'Invalid Request' }
    })
  })

  test('malformed JSON on POST /mcp with SSE enabled returns a JSON-RPC Parse error', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())
    await app.register(mcpPlugin, { enableSSE: true })
    await app.ready()

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json' },
      payload: 'not json'
    })

    t.assert.strictEqual(response.statusCode, 400)
    t.assert.deepStrictEqual(response.json(), {
      jsonrpc: JSONRPC_VERSION,
      id: null,
      error: { code: PARSE_ERROR, message: 'Parse error' }
    })
  })

  test('other errors on POST /mcp are delegated to the parent error handler', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())
    app.setErrorHandler((error, _request, reply) => {
      reply.code(422).send({ custom: true, code: (error as any).code })
    })
    await app.register(mcpPlugin, {
      transformRouteSchema: (schema, context) => context.routeId === 'mcp.post'
        ? { ...schema, body: { type: 'object', required: ['jsonrpc'] } }
        : schema
    })
    await app.ready()

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: { id: 1, method: 'ping' }
    })

    t.assert.strictEqual(response.statusCode, 422)
    t.assert.deepStrictEqual(response.json(), { custom: true, code: 'FST_ERR_VALIDATION' })
  })

  test('other errors on POST /mcp keep the default Fastify error body', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())
    await app.register(mcpPlugin, {
      transformRouteSchema: (schema, context) => context.routeId === 'mcp.post'
        ? { ...schema, body: { type: 'object', required: ['jsonrpc'] } }
        : schema
    })
    await app.ready()

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: { id: 1, method: 'ping' }
    })

    t.assert.strictEqual(response.statusCode, 400)
    t.assert.strictEqual(response.json().code, 'FST_ERR_VALIDATION')
  })

  test('other routes keep the user error handler for body-parser errors', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())
    app.setErrorHandler((error, _request, reply) => {
      reply.code((error as any).statusCode ?? 500).send({ custom: true, code: (error as any).code })
    })
    await app.register(mcpPlugin)
    app.post('/other', async () => ({ ok: true }))
    await app.ready()

    const response = await app.inject({
      method: 'POST',
      url: '/other',
      headers: { 'content-type': 'application/json' },
      payload: '{bad'
    })

    t.assert.strictEqual(response.statusCode, 400)
    t.assert.deepStrictEqual(response.json(), { custom: true, code: 'FST_ERR_CTP_INVALID_JSON_BODY' })
  })
})
