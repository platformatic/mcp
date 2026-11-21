import { test, describe } from 'node:test'
import type { TestContext } from 'node:test'
import Fastify from 'fastify'
import mcpPlugin from '../src/index.ts'
import type { MCPPluginOptions, JSONRPCResultResponse, CallToolResult } from '../src/index.ts'
import { JSONRPC_VERSION } from '../src/schema.ts'
import { sanitizeToolParams } from '../src/security.ts'

async function buildApp (t: TestContext, opts: Partial<MCPPluginOptions> = {}) {
  let invocations = 0
  const app = Fastify({ logger: false })
  t.after(() => app.close())

  await app.register(mcpPlugin, opts)

  app.mcpAddTool({
    name: 'accept',
    description: 'Accepts anything',
    inputSchema: { type: 'object' }
  }, async () => {
    invocations++
    return { content: [{ type: 'text', text: 'ok' }] }
  })

  await app.ready()
  return { app, getInvocations: () => invocations }
}

async function callTool (app: Awaited<ReturnType<typeof buildApp>>['app'], args: Record<string, unknown>) {
  const response = await app.inject({
    method: 'POST',
    url: '/mcp',
    payload: {
      jsonrpc: JSONRPC_VERSION,
      id: 1,
      method: 'tools/call',
      params: { name: 'accept', arguments: args }
    }
  })
  return (response.json() as JSONRPCResultResponse).result as CallToolResult
}

describe('tool argument limits', () => {
  test('accepts an array with more than 100 items by default', async (t: TestContext) => {
    const { app, getInvocations } = await buildApp(t)

    const result = await callTool(app, { xs: Array.from({ length: 101 }, (_, i) => i) })

    t.assert.notStrictEqual(result.isError, true)
    t.assert.strictEqual(getInvocations(), 1)
  })

  test('still refuses an object with more than 100 properties by default', async (t: TestContext) => {
    const { app, getInvocations } = await buildApp(t)

    const obj: Record<string, number> = {}
    for (let i = 0; i < 101; i++) obj[`k${i}`] = i
    const result = await callTool(app, { obj })

    t.assert.strictEqual(result.isError, true)
    t.assert.strictEqual(getInvocations(), 0)
  })

  test('still refuses a string longer than 10000 characters by default', async (t: TestContext) => {
    const { app, getInvocations } = await buildApp(t)

    const result = await callTool(app, { doc: 'a'.repeat(10001) })

    t.assert.strictEqual(result.isError, true)
    t.assert.strictEqual(getInvocations(), 0)
  })

  test('accepts a longer string when maxStringLength is raised', async (t: TestContext) => {
    const { app, getInvocations } = await buildApp(t, {
      toolArgumentLimits: { maxStringLength: 20000 }
    })

    const result = await callTool(app, { doc: 'a'.repeat(10001) })

    t.assert.notStrictEqual(result.isError, true)
    t.assert.strictEqual(getInvocations(), 1)
  })

  test('accepts more object properties when maxObjectProperties is raised', async (t: TestContext) => {
    const { app, getInvocations } = await buildApp(t, {
      toolArgumentLimits: { maxObjectProperties: 200 }
    })

    const obj: Record<string, number> = {}
    for (let i = 0; i < 150; i++) obj[`k${i}`] = i
    const result = await callTool(app, { obj })

    t.assert.notStrictEqual(result.isError, true)
    t.assert.strictEqual(getInvocations(), 1)
  })

  test('refuses a string over a lowered maxStringLength', async (t: TestContext) => {
    const { app, getInvocations } = await buildApp(t, {
      toolArgumentLimits: { maxStringLength: 5 }
    })

    const result = await callTool(app, { doc: 'abcdef' })

    t.assert.strictEqual(result.isError, true)
    t.assert.match((result.content[0] as { text: string }).text, /maximum allowed length of 5/)
    t.assert.strictEqual(getInvocations(), 0)
  })

  test('refuses an object over a lowered maxObjectProperties', async (t: TestContext) => {
    const { app, getInvocations } = await buildApp(t, {
      toolArgumentLimits: { maxObjectProperties: 2 }
    })

    const result = await callTool(app, { obj: { a: 1, b: 2, c: 3 } })

    t.assert.strictEqual(result.isError, true)
    t.assert.match((result.content[0] as { text: string }).text, /too many properties \(3 > 2\)/)
    t.assert.strictEqual(getInvocations(), 0)
  })

  test('refuses an array over a configured maxArrayLength', async (t: TestContext) => {
    const { app, getInvocations } = await buildApp(t, {
      toolArgumentLimits: { maxArrayLength: 3 }
    })

    const result = await callTool(app, { xs: [1, 2, 3, 4] })

    t.assert.strictEqual(result.isError, true)
    t.assert.match((result.content[0] as { text: string }).text, /too many items \(4 > 3\)/)
    t.assert.strictEqual(getInvocations(), 0)
  })

  test('refuses nesting deeper than a lowered maxDepth', async (t: TestContext) => {
    const { app, getInvocations } = await buildApp(t, {
      toolArgumentLimits: { maxDepth: 2 }
    })

    const result = await callTool(app, { a: { b: { c: 1 } } })

    t.assert.strictEqual(result.isError, true)
    t.assert.match((result.content[0] as { text: string }).text, /depth of 2/)
    t.assert.strictEqual(getInvocations(), 0)
  })

  test('sanitizeToolParams applies limits to strings inside arrays and nested objects', (t: TestContext) => {
    t.assert.throws(
      () => sanitizeToolParams({ xs: ['abcdef'] }, { maxStringLength: 5 }),
      /maximum allowed length of 5/
    )
    t.assert.throws(
      () => sanitizeToolParams({ o: { s: 'abcdef' } }, { maxStringLength: 5 }),
      /maximum allowed length of 5/
    )
    t.assert.deepStrictEqual(
      sanitizeToolParams({ xs: Array.from({ length: 500 }, () => 1) }),
      { xs: Array.from({ length: 500 }, () => 1) }
    )
  })
  test('refuses an over-long string inside an object inside an array by default', async (t: TestContext) => {
    const { app, getInvocations } = await buildApp(t)

    const result = await callTool(app, { xs: [{ s: 'a'.repeat(10001) }] })

    t.assert.strictEqual(result.isError, true)
    t.assert.match((result.content[0] as { text: string }).text, /maximum allowed length of 10000/)
    t.assert.strictEqual(getInvocations(), 0)
  })

  test('sanitizeToolParams removes control characters from strings in objects inside arrays', (t: TestContext) => {
    t.assert.deepStrictEqual(
      sanitizeToolParams({ xs: [{ s: 'a\x00b\x07c', n: 1 }, 'd\x1Fe'] }),
      { xs: [{ s: 'abc', n: 1 }, 'de'] }
    )
    t.assert.throws(
      () => sanitizeToolParams({ xs: [{ ['k\x00'.repeat(4)]: 1 }] }, { maxStringLength: 5 }),
      /maximum allowed length of 5/
    )
  })

  // Issue #342: a NaN limit made every comparison false and removed the limit
  for (const field of ['maxStringLength', 'maxObjectProperties', 'maxArrayLength', 'maxDepth'] as const) {
    for (const value of [NaN, 0, -1, 1.5, -Infinity, '10', null]) {
      test(`refuses toolArgumentLimits.${field} = ${typeof value === 'string' ? `'${value}'` : String(value)} at registration`, async (t: TestContext) => {
        const app = Fastify({ logger: false })
        t.after(() => app.close())
        app.register(mcpPlugin, { toolArgumentLimits: { [field]: value as number } })
        await t.assert.rejects(async () => { await app.ready() }, {
          name: 'TypeError',
          message: `toolArgumentLimits.${field} must be a positive integer or Infinity`
        })
      })
    }

    test(`accepts toolArgumentLimits.${field} = Infinity`, async (t: TestContext) => {
      const app = Fastify({ logger: false })
      t.after(() => app.close())
      app.register(mcpPlugin, { toolArgumentLimits: { [field]: Infinity } })
      await app.ready()
    })
  }

  test('refuses a toolArgumentLimits that is not an object', async (t: TestContext) => {
    for (const value of [null, 5, 'x', []]) {
      const app = Fastify({ logger: false })
      t.after(() => app.close())
      app.register(mcpPlugin, { toolArgumentLimits: value as any })
      await t.assert.rejects(async () => { await app.ready() }, {
        name: 'TypeError',
        message: 'toolArgumentLimits must be an object'
      })
    }
  })

  test('sanitizeToolParams recurses into nested arrays', (t: TestContext) => {
    t.assert.deepStrictEqual(
      sanitizeToolParams({ xs: [[['a\x00b'], [{ s: 'c\x7Fd' }]], [1, null, true]] }),
      { xs: [[['ab'], [{ s: 'cd' }]], [1, null, true]] }
    )
    t.assert.throws(
      () => sanitizeToolParams({ xs: [[['abcdef']]] }, { maxStringLength: 5 }),
      /maximum allowed length of 5/
    )
    t.assert.throws(
      () => sanitizeToolParams({ xs: [[{ a: 1, b: 2, c: 3 }]] }, { maxObjectProperties: 2 }),
      /too many properties \(3 > 2\)/
    )
    t.assert.throws(
      () => sanitizeToolParams({ xs: [[[[1]]]] }, { maxDepth: 3 }),
      /depth of 3/
    )
  })
})
