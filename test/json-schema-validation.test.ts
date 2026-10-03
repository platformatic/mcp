import { test, describe } from 'node:test'
import { strict as assert } from 'node:assert'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { Type } from '@sinclair/typebox'
import mcpPlugin from '../src/index.ts'
import { JSONRPC_VERSION, LATEST_LEGACY_PROTOCOL_VERSION, LATEST_PROTOCOL_VERSION } from '../src/schema.ts'
import type { CallToolResult } from '../src/schema.ts'
import type { MCPPluginOptions } from '../src/types.ts'

const SEARCH_JSON_SCHEMA = {
  type: 'object',
  properties: {
    query: { type: 'string', minLength: 1 },
    limit: { type: 'number', minimum: 1, maximum: 100, default: 10 }
  },
  required: ['query'],
  additionalProperties: false
}

async function buildApp (t: { after: (fn: () => unknown) => void }, opts: MCPPluginOptions = {}): Promise<FastifyInstance> {
  const app = Fastify()
  t.after(() => app.close())
  await app.register(mcpPlugin, opts)
  return app
}

async function callTool (app: FastifyInstance, name: string, args: unknown, extraParams: Record<string, unknown> = {}) {
  const response = await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: { 'mcp-protocol-version': LATEST_LEGACY_PROTOCOL_VERSION },
    payload: {
      jsonrpc: JSONRPC_VERSION,
      id: 1,
      method: 'tools/call',
      params: { name, ...(args === undefined ? {} : { arguments: args }), ...extraParams }
    }
  })
  assert.strictEqual(response.statusCode, 200)
  return response.json()
}

describe('JSON Schema Validation (validateJsonSchemaInputs)', () => {
  test('custom AJV options are applied', async (t) => {
    const app = await buildApp(t, {
      validateJsonSchemaInputs: {
        useDefaults: false
      }
    })

    let receivedParams: unknown
    app.mcpAddTool({
      name: 'search',
      description: 'Search',
      inputSchema: SEARCH_JSON_SCHEMA
    }, async (params: unknown) => {
      receivedParams = params
      return { content: [{ type: 'text' as const, text: 'ok' }] }
    })
    await app.ready()

    const body = await callTool(app, 'search', { query: 'test' })
    assert.strictEqual(body.result.isError, undefined)
    // The `limit` default from the schema must NOT be injected
    assert.deepStrictEqual(receivedParams, { query: 'test' })
  })

  test('invalid arguments return an isError result before the handler runs', async (t) => {
    const app = await buildApp(t, { validateJsonSchemaInputs: {} })

    let handlerCalled = false
    app.mcpAddTool({
      name: 'search',
      description: 'Search',
      inputSchema: SEARCH_JSON_SCHEMA
    }, async () => {
      handlerCalled = true
      return { content: [{ type: 'text' as const, text: 'ok' }] }
    })
    await app.ready()

    const body = await callTool(app, 'search', { query: '', limit: 500 })
    const result = body.result as CallToolResult
    assert.strictEqual(result.isError, true)
    assert.ok((result.content[0] as any).text.startsWith('Invalid tool arguments:'))
    assert.ok((result.content[0] as any).text.includes('/query'))
    assert.strictEqual(handlerCalled, false)
  })

  test('missing arguments are validated as an empty object', async (t) => {
    const app = await buildApp(t, { validateJsonSchemaInputs: {} })

    app.mcpAddTool({
      name: 'search',
      description: 'Search',
      inputSchema: SEARCH_JSON_SCHEMA
    }, async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }))
    await app.ready()

    const body = await callTool(app, 'search', undefined)
    const result = body.result as CallToolResult
    assert.strictEqual(result.isError, true)
    assert.ok((result.content[0] as any).text.includes('query'))
  })

  test('long error lists are capped in the message', async (t) => {
    const app = await buildApp(t, { validateJsonSchemaInputs: {} })

    const manyProps = Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [`p${i}`, { type: 'string' }])
    )
    app.mcpAddTool({
      name: 'many',
      description: 'Many props',
      inputSchema: { type: 'object', properties: manyProps, required: Object.keys(manyProps) }
    }, async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }))
    await app.ready()

    const body = await callTool(app, 'many', {})
    const result = body.result as CallToolResult
    assert.strictEqual(result.isError, true)
    assert.deepEqual(result.content[0], {
      type: 'text',
      text: "Invalid tool arguments: / must have required property 'p0'"
    })
  })

  test('an uncompilable schema fails tool registration', async (t) => {
    const app = await buildApp(t, { validateJsonSchemaInputs: {} })
    await app.ready()

    assert.throws(() => {
      app.mcpAddTool({
        name: 'broken',
        description: 'Broken schema',
        inputSchema: { type: 'object', properties: { a: { type: 'not-a-type' } } }
      }, async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }))
    }, /Invalid tool schema for 'broken'/)
  })

  test('flag off (default): invalid arguments pass through to the handler unchanged', async (t) => {
    const app = await buildApp(t)

    let receivedParams: unknown
    app.mcpAddTool({
      name: 'search',
      description: 'Search',
      inputSchema: SEARCH_JSON_SCHEMA
    }, async (params: unknown) => {
      receivedParams = params
      return { content: [{ type: 'text' as const, text: 'ok' }] }
    })
    await app.ready()

    const body = await callTool(app, 'search', { query: 42, limit: 'nope' })
    assert.strictEqual((body.result as CallToolResult).isError, undefined)
    assert.deepStrictEqual(receivedParams, { query: 42, limit: 'nope' })
  })

  test('TypeBox tools keep their own validation regardless of the flag', async (t) => {
    const app = await buildApp(t, { validateJsonSchemaInputs: {} })

    app.mcpAddTool({
      name: 'typed',
      description: 'TypeBox tool',
      inputSchema: Type.Object({ query: Type.String({ minLength: 1 }) })
    }, async (params) => ({ content: [{ type: 'text' as const, text: params.query }] }))
    await app.ready()

    const body = await callTool(app, 'typed', { query: '' })
    const result = body.result as CallToolResult
    assert.strictEqual(result.isError, true)
    assert.ok((result.content[0] as any).text.startsWith('Invalid tool arguments:'))
  })

  test('modern tools/call uses the same AJV validation path', async (t) => {
    const app = await buildApp(t, { validateJsonSchemaInputs: {} })
    let handlerCalled = false
    app.mcpAddTool({
      name: 'search',
      description: 'Search',
      inputSchema: SEARCH_JSON_SCHEMA
    }, async () => {
      handlerCalled = true
      return { content: [{ type: 'text' as const, text: 'ok' }] }
    })
    await app.ready()

    const client = app.mcpClient({ protocolVersion: LATEST_PROTOCOL_VERSION })
    const response = await client.callTool('search', { query: '', limit: 500 })

    assert.strictEqual(response.statusCode, 200)
    assert.ok('result' in response.body)
    const result = response.body.result as CallToolResult & { resultType: string }
    assert.strictEqual(result.resultType, 'complete')
    assert.strictEqual(result.isError, true)
    assert.ok((result.content[0] as any).text.startsWith('Invalid tool arguments:'))
    assert.strictEqual(handlerCalled, false)
  })

  test('task-mode calls are validated too', async (t) => {
    const app = await buildApp(t, { validateJsonSchemaInputs: {}, enableTasks: true })

    app.mcpAddTool({
      name: 'search',
      description: 'Search',
      inputSchema: SEARCH_JSON_SCHEMA,
      execution: { taskSupport: 'optional' }
    }, async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }))
    await app.ready()

    const created = await callTool(app, 'search', { query: '' }, { task: {} })
    const taskId = created.result.task.taskId

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'mcp-protocol-version': LATEST_LEGACY_PROTOCOL_VERSION },
      payload: { jsonrpc: JSONRPC_VERSION, id: 2, method: 'tasks/result', params: { taskId } }
    })
    const result = response.json().result as CallToolResult
    assert.strictEqual(result.isError, true)
    assert.ok((result.content[0] as any).text.startsWith('Invalid tool arguments:'))
  })
})
