import { test, describe } from 'node:test'
import type { TestContext } from 'node:test'
import Fastify from 'fastify'
import { Type } from '@sinclair/typebox'
import mcpPlugin from '../src/index.ts'
import { JSONRPC_VERSION, INVALID_PARAMS, INTERNAL_ERROR } from '../src/schema.ts'
import type { JSONRPCError, JSONRPCResultResponse, GetPromptResult, ListPromptsResult } from '../src/schema.ts'

async function call (app: any, method: string, params?: Record<string, unknown>) {
  const response = await app.inject({
    method: 'POST',
    url: '/mcp',
    payload: { jsonrpc: JSONRPC_VERSION, id: 1, method, params }
  })
  return response.json()
}

describe('prompts/get errors', () => {
  test('returns -32602 when a TypeBox argumentSchema rejects the arguments', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())
    await app.register(mcpPlugin)

    let called = false
    app.mcpAddPrompt({
      name: 'greet',
      argumentSchema: Type.Object({ name: Type.String({ minLength: 1 }) })
    }, async () => {
      called = true
      return { messages: [] }
    })
    await app.ready()

    const body = await call(app, 'prompts/get', { name: 'greet', arguments: {} }) as JSONRPCError
    t.assert.strictEqual(body.error.code, INVALID_PARAMS)
    t.assert.ok(body.error.message.includes('Invalid prompt arguments'))
    t.assert.strictEqual((body as any).result, undefined)
    t.assert.strictEqual(called, false)
  })

  test('returns -32602 when a required argument declared via `arguments` is missing', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())
    await app.register(mcpPlugin)

    let called = false
    app.mcpAddPrompt({
      name: 'summarize',
      arguments: [
        { name: 'text', required: true },
        { name: 'style', required: false }
      ]
    }, async () => {
      called = true
      return { messages: [] }
    })
    await app.ready()

    const body = await call(app, 'prompts/get', { name: 'summarize', arguments: { style: 'short' } }) as JSONRPCError
    t.assert.strictEqual(body.error.code, INVALID_PARAMS)
    t.assert.ok(body.error.message.includes('text'))
    t.assert.deepStrictEqual(body.error.data, { missing: ['text'] })
    t.assert.strictEqual(called, false)

    // No arguments object at all
    const noArgs = await call(app, 'prompts/get', { name: 'summarize' }) as JSONRPCError
    t.assert.strictEqual(noArgs.error.code, INVALID_PARAMS)
    t.assert.strictEqual(called, false)
  })

  test('runs the handler when required `arguments` are provided', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())
    await app.register(mcpPlugin)

    app.mcpAddPrompt({
      name: 'summarize',
      arguments: [{ name: 'text', required: true }]
    }, async (_name, args) => ({
      messages: [{ role: 'user', content: { type: 'text', text: `Summarize: ${args.text}` } }]
    }))
    await app.ready()

    const body = await call(app, 'prompts/get', { name: 'summarize', arguments: { text: 'hello' } }) as JSONRPCResultResponse
    const result = body.result as GetPromptResult
    t.assert.strictEqual((result.messages[0].content as any).text, 'Summarize: hello')
  })

  for (const variant of ['typebox', 'arguments', 'none'] as const) {
    test(`returns -32603 without a stack trace when the handler throws (${variant})`, async (t: TestContext) => {
      const app = Fastify()
      t.after(() => app.close())
      await app.register(mcpPlugin)

      const definition: any = { name: 'boom' }
      if (variant === 'typebox') definition.argumentSchema = Type.Object({})
      if (variant === 'arguments') definition.arguments = [{ name: 'x', required: false }]

      app.mcpAddPrompt(definition, async () => {
        throw new Error('kaboom')
      })
      await app.ready()

      const body = await call(app, 'prompts/get', { name: 'boom', arguments: {} }) as JSONRPCError
      t.assert.strictEqual(body.error.code, INTERNAL_ERROR)
      t.assert.strictEqual(body.error.message, 'Prompt execution failed: kaboom')
      t.assert.strictEqual(body.error.data, undefined)
      t.assert.ok(!JSON.stringify(body).includes('at '))
      t.assert.strictEqual((body as any).result, undefined)
    })
  }
})

describe('prompts/list', () => {
  test('does not expose the internal argumentSchema field', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())
    await app.register(mcpPlugin)

    app.mcpAddPrompt({
      name: 'greet',
      description: 'Greets',
      argumentSchema: Type.Object({ name: Type.String({ description: 'Who' }) })
    }, async () => ({ messages: [] }))
    app.mcpAddPrompt({
      name: 'plain',
      arguments: [{ name: 'x', required: true }]
    }, async () => ({ messages: [] }))
    await app.ready()

    const body = await call(app, 'prompts/list') as JSONRPCResultResponse
    const result = body.result as ListPromptsResult
    for (const prompt of result.prompts) {
      t.assert.strictEqual('argumentSchema' in prompt, false)
    }
    const greet = result.prompts.find(p => p.name === 'greet')!
    t.assert.deepStrictEqual(greet.arguments, [{ name: 'name', description: 'Who', required: true }])
  })
})

describe('resources/read errors', () => {
  test('returns -32603 without a stack trace when the handler throws', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())
    await app.register(mcpPlugin)

    app.mcpAddResource({
      uriPattern: 'file://broken',
      name: 'broken'
    }, async () => {
      throw new Error('disk on fire')
    })
    await app.ready()

    const body = await call(app, 'resources/read', { uri: 'file://broken' }) as JSONRPCError
    t.assert.strictEqual(body.error.code, INTERNAL_ERROR)
    t.assert.strictEqual(body.error.message, 'Resource read failed: disk on fire')
    t.assert.strictEqual(body.error.data, undefined)
    t.assert.strictEqual((body as any).result, undefined)
  })

  test('returns -32602 when the URI fails the uriSchema', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())
    await app.register(mcpPlugin)

    let called = false
    app.mcpAddResource({
      uriPattern: 'file://items',
      name: 'items',
      uriSchema: Type.String({ pattern: '^file://items\\?id=\\d+$' })
    }, async (uri) => {
      called = true
      return { contents: [{ uri, text: 'ok' }] }
    })
    await app.ready()

    const body = await call(app, 'resources/read', { uri: 'file://items?id=abc' }) as JSONRPCError
    t.assert.strictEqual(body.error.code, INVALID_PARAMS)
    t.assert.ok(body.error.message.includes('Invalid resource URI'))
    t.assert.strictEqual(called, false)

    const ok = await call(app, 'resources/read', { uri: 'file://items?id=42' }) as JSONRPCResultResponse
    t.assert.ok(ok.result)
    t.assert.strictEqual(called, true)
  })
})
