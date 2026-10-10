import { test, describe } from 'node:test'
import { strict as assert } from 'node:assert'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { Type } from '@sinclair/typebox'
import mcpPlugin from '../src/index.ts'
import { JSONRPC_VERSION, LATEST_PROTOCOL_VERSION } from '../src/schema.ts'
import type { CallToolResult } from '../src/schema.ts'
import type { MCPPluginOptions } from '../src/types.ts'
import { createJsonSchemaValidator } from '../src/validation/json-schema-validator.ts'

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
    headers: { 'mcp-protocol-version': LATEST_PROTOCOL_VERSION },
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

describe('createJsonSchemaValidator', () => {
  test('is non-mutating: no coercion, no defaults, no property removal', () => {
    const validator = createJsonSchemaValidator({ allErrors: true })
    const schema = {
      type: 'object',
      properties: {
        n: { type: 'number' },
        tags: { type: 'array', items: { type: 'string' } },
        mode: { type: 'string', default: 'fast' }
      },
      additionalProperties: false
    }
    const args = { n: '42', tags: 'one', extra: 'dropped?' }

    const error = validator.validate(schema, args)

    assert.ok(error !== null)
    assert.ok(error.includes('/n must be number'))
    assert.ok(error.includes('/tags must be array'))
    assert.ok(error.includes('must NOT have additional properties'))
    assert.deepStrictEqual(args, { n: '42', tags: 'one', extra: 'dropped?' })
  })

  test('valid data is not augmented with defaults', () => {
    const validator = createJsonSchemaValidator()
    const args = { query: 'test' }
    assert.strictEqual(validator.validate(SEARCH_JSON_SCHEMA, args), null)
    assert.deepStrictEqual(args, { query: 'test' })
  })
})

describe('JSON Schema Validation (plain JSON Schema tool inputs)', () => {
  test('arguments reach the handler exactly as sent', async (t) => {
    const app = await buildApp(t, { validateJsonSchemaInputs: {} })

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

    const invalid = await callTool(app, 'search', { query: 'test', limit: '5' })
    assert.strictEqual(invalid.result.isError, true)
    assert.ok(invalid.result.content[0].text.includes('/limit must be number'))
  })

  test('custom AJV options are applied', async (t) => {
    const app = await buildApp(t, {
      validateJsonSchemaInputs: {
        useDefaults: true
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
    // Explicitly opting in to `useDefaults` injects the `limit` default
    assert.deepStrictEqual(receivedParams, { query: 'test', limit: 10 })
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

  test('plain JSON Schema inputs are validated by default', async (t) => {
    const app = await buildApp(t)

    let handlerCalled = false
    app.mcpAddTool({
      name: 'count',
      description: 'Count',
      inputSchema: {
        type: 'object',
        properties: { n: { type: 'integer' } },
        required: ['n'],
        additionalProperties: false
      }
    }, async () => {
      handlerCalled = true
      return { content: [{ type: 'text' as const, text: 'ok' }] }
    })
    await app.ready()

    const body = await callTool(app, 'count', { n: 'notint', extra: 1 })
    assert.deepStrictEqual(body.result, {
      content: [{ type: 'text', text: 'Invalid tool arguments: / must NOT have additional properties' }],
      isError: true
    })
    assert.strictEqual(handlerCalled, false)

    const ok = await callTool(app, 'count', { n: 3 })
    assert.strictEqual(ok.result.isError, undefined)
    assert.strictEqual(handlerCalled, true)
  })

  test('default validation uses the same error shape as TypeBox validation', async (t) => {
    const app = await buildApp(t)

    app.mcpAddTool({
      name: 'plain',
      description: 'Plain JSON Schema tool',
      inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1 } } }
    }, async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }))
    app.mcpAddTool({
      name: 'typed',
      description: 'TypeBox tool',
      inputSchema: Type.Object({ query: Type.String({ minLength: 1 }) })
    }, async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }))
    await app.ready()

    const plain = (await callTool(app, 'plain', { query: '' })).result as CallToolResult
    const typed = (await callTool(app, 'typed', { query: '' })).result as CallToolResult
    assert.deepStrictEqual(Object.keys(plain).sort(), Object.keys(typed).sort())
    assert.strictEqual(plain.isError, true)
    assert.strictEqual(typed.isError, true)
    assert.strictEqual(plain.content.length, 1)
    assert.strictEqual(plain.content[0].type, 'text')
    assert.ok((plain.content[0] as any).text.startsWith('Invalid tool arguments:'))
    assert.ok((typed.content[0] as any).text.startsWith('Invalid tool arguments:'))
  })

  test('validateJsonSchemaInputs: false opts out: invalid arguments pass through unchanged', async (t) => {
    const app = await buildApp(t, { validateJsonSchemaInputs: false })

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

  test('an unsupported $schema dialect fails tool registration', async (t) => {
    const app = await buildApp(t)
    await app.ready()

    assert.throws(() => {
      app.mcpAddTool({
        name: 'draft7',
        description: 'Draft-07 schema',
        inputSchema: {
          $schema: 'http://json-schema.org/draft-07/schema#',
          type: 'object',
          properties: { a: { type: 'string' } }
        }
      }, async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }))
    }, {
      message: "Invalid tool schema for 'draft7': dialect 'http://json-schema.org/draft-07/schema#' is not supported; use JSON Schema 2020-12 or set validateJsonSchemaInputs: false"
    })
  })

  test('an explicit JSON Schema 2020-12 $schema is accepted and validated', async (t) => {
    const app = await buildApp(t)

    for (const [name, dialect] of [
      ['plain', 'https://json-schema.org/draft/2020-12/schema'],
      ['hash', 'https://json-schema.org/draft/2020-12/schema#']
    ]) {
      app.mcpAddTool({
        name,
        description: 'Explicit 2020-12 schema',
        inputSchema: {
          $schema: dialect,
          type: 'object',
          properties: { a: { type: 'string' } },
          required: ['a']
        }
      }, async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }))
    }
    await app.ready()

    for (const name of ['plain', 'hash']) {
      const body = await callTool(app, name, {})
      assert.strictEqual(body.result.isError, true)
      assert.ok(body.result.content[0].text.includes("must have required property 'a'"))
    }
  })

  test('unsupported $schema dialects are allowed when validation is opted out', async (t) => {
    const app = await buildApp(t, { validateJsonSchemaInputs: false })

    let receivedParams: unknown
    app.mcpAddTool({
      name: 'draft7',
      description: 'Draft-07 schema',
      inputSchema: {
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: { a: { type: 'string' } }
      }
    }, async (params: unknown) => {
      receivedParams = params
      return { content: [{ type: 'text' as const, text: 'ok' }] }
    })
    await app.ready()

    const body = await callTool(app, 'draft7', { a: 1 })
    assert.strictEqual(body.result.isError, undefined)
    assert.deepStrictEqual(receivedParams, { a: 1 })
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
      headers: { 'mcp-protocol-version': LATEST_PROTOCOL_VERSION },
      payload: { jsonrpc: JSONRPC_VERSION, id: 2, method: 'tasks/result', params: { taskId } }
    })
    const result = response.json().result as CallToolResult
    assert.strictEqual(result.isError, true)
    assert.ok((result.content[0] as any).text.startsWith('Invalid tool arguments:'))
  })
})
