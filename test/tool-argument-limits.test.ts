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

  test('sanitizeToolParams does not let a direct __proto__ key change the result prototype', (t: TestContext) => {
    const result = sanitizeToolParams(JSON.parse('{"__proto__": {"polluted": true}}'))

    t.assert.strictEqual(Object.getPrototypeOf(result), Object.prototype)
    t.assert.strictEqual(Object.prototype.hasOwnProperty.call(result, '__proto__'), true)
    const descriptor = Object.getOwnPropertyDescriptor(result, '__proto__')
    t.assert.ok(descriptor)
    t.assert.strictEqual(descriptor.value.polluted, true)
  })

  test('sanitizeToolParams does not let __proto__ pollute when nested in objects and arrays', (t: TestContext) => {
    const result = sanitizeToolParams({
      obj: JSON.parse('{"__proto__": {"a": 1}}'),
      xs: [JSON.parse('{"__proto__": {"b": 2}}')]
    })

    t.assert.strictEqual(Object.getPrototypeOf(result.obj), Object.prototype)
    t.assert.strictEqual(Object.getPrototypeOf(result.xs[0]), Object.prototype)
    t.assert.deepStrictEqual(Object.keys(result.obj), ['__proto__'])
    t.assert.deepStrictEqual(Object.keys(result.xs[0]), ['__proto__'])
    const objDescriptor = Object.getOwnPropertyDescriptor(result.obj, '__proto__')
    const xsDescriptor = Object.getOwnPropertyDescriptor(result.xs[0], '__proto__')
    t.assert.ok(objDescriptor)
    t.assert.ok(xsDescriptor)
    t.assert.strictEqual(objDescriptor.value.a, 1)
    t.assert.strictEqual(xsDescriptor.value.b, 2)
  })

  test('sanitizeToolParams copies constructor and prototype keys as ordinary own properties', (t: TestContext) => {
    const result = sanitizeToolParams(JSON.parse('{"constructor": 1, "prototype": 2}'))

    t.assert.strictEqual(Object.getPrototypeOf(result), Object.prototype)
    t.assert.strictEqual(Object.prototype.hasOwnProperty.call(result, 'constructor'), true)
    t.assert.strictEqual(Object.prototype.hasOwnProperty.call(result, 'prototype'), true)
    t.assert.strictEqual(result.constructor, 1)
    t.assert.strictEqual(result.prototype, 2)
  })

  test('sanitizeToolParams safely copies a key that sanitizes to a special property name', (t: TestContext) => {
    // '__pro\u0000to__' strips the null character back to '__proto__'
    const result = sanitizeToolParams({ '__pro\u0000to__': { polluted: true } })

    t.assert.strictEqual(Object.getPrototypeOf(result), Object.prototype)
    t.assert.strictEqual(Object.prototype.hasOwnProperty.call(result, '__proto__'), true)
    const entries = Object.entries(result)
    t.assert.strictEqual(entries.length, 1)
    t.assert.strictEqual(entries[0][0], '__proto__')
    t.assert.strictEqual((entries[0][1] as Record<string, unknown>).polluted, true)
  })

  test('sanitizeToolParams detects when key sanitization maps two keys onto the same output key', (t: TestContext) => {
    t.assert.throws(
      () => sanitizeToolParams({ 'a\u0000b': 1, ab: 2 }),
      /Duplicate key "ab" after key sanitization/
    )
  })

  test('sanitizeToolParams detects key collisions nested inside objects and arrays', (t: TestContext) => {
    t.assert.throws(
      () => sanitizeToolParams({ o: { 'a\u0000b': 1, ab: 2 } }),
      /Duplicate key "ab" after key sanitization/
    )
    t.assert.throws(
      () => sanitizeToolParams({ xs: [{ 'a\u0000b': 1, ab: 2 }] }),
      /Duplicate key "ab" after key sanitization/
    )
  })

  test('refuses a tool call whose arguments collide after key sanitization', async (t: TestContext) => {
    const { app, getInvocations } = await buildApp(t)

    const result = await callTool(app, { 'a\u0000b': 1, ab: 2 })

    t.assert.strictEqual(result.isError, true)
    t.assert.match((result.content[0] as { text: string }).text, /Duplicate key "ab" after key sanitization/)
    t.assert.strictEqual(getInvocations(), 0)
  })
})
