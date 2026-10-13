import { test, describe } from 'node:test'
import type { TestContext } from 'node:test'
import Fastify from 'fastify'
import { Type } from '@sinclair/typebox'
import mcpPlugin from '../src/index.ts'
import { JSONRPC_VERSION, LATEST_PROTOCOL_VERSION, INTERNAL_ERROR } from '../src/schema.ts'
import type { CreateTaskResult } from '../src/schema.ts'
import { isTerminal } from '../src/stores/task-store.ts'
import type { MCPToolCallCompleteEvent } from '../src/types.ts'

// Each one is missing the array its result type requires
const MALFORMED: Array<[string, (field: string) => unknown]> = [
  ['undefined', () => undefined],
  ['an empty object', () => ({})],
  ['a non-array field', (field) => ({ [field]: 'not an array' })]
]

async function buildApp (t: TestContext, opts: Record<string, unknown> = {}) {
  const logs: any[] = []
  const app = Fastify({
    logger: {
      level: 'error',
      stream: { write (line: string) { logs.push(JSON.parse(line)) } }
    }
  })
  t.after(() => app.close())
  await app.register(mcpPlugin, opts)
  return { app, logs }
}

async function call (app: any, method: string, params: unknown) {
  const response = await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: { 'mcp-protocol-version': LATEST_PROTOCOL_VERSION },
    payload: { jsonrpc: JSONRPC_VERSION, id: 1, method, params }
  })
  return response.json()
}

function assertInternalError (t: TestContext, body: any) {
  t.assert.strictEqual(body.result, undefined)
  t.assert.strictEqual(body.error.code, INTERNAL_ERROR)
  t.assert.strictEqual(body.error.message, 'Internal error')
  t.assert.strictEqual(body.error.data, undefined)
}

describe('malformed tool handler results', () => {
  const variants: Record<string, Record<string, unknown>> = {
    typebox: { inputSchema: Type.Object({}) },
    'json schema': { inputSchema: { type: 'object', properties: {} } },
    'no schema': {}
  }

  for (const [label, make] of MALFORMED) {
    for (const [variant, schema] of Object.entries(variants)) {
      test(`tools/call returns -32603 when the handler returns ${label} (${variant})`, async (t: TestContext) => {
        const { app, logs } = await buildApp(t)
        app.mcpAddTool({ name: 'bad', description: 'bad', ...schema } as any, async () => make('content') as any)
        await app.ready()

        const body = await call(app, 'tools/call', { name: 'bad', arguments: {} })
        assertInternalError(t, body)
        t.assert.ok(logs.some(l => l.level === 50 && l.tool === 'bad' && /content array/.test(l.msg)))
      })
    }

    test(`mcpCallTool reports invalid-result when the handler returns ${label}`, async (t: TestContext) => {
      const events: MCPToolCallCompleteEvent[] = []
      const { app, logs } = await buildApp(t, { onToolCallComplete: (event: MCPToolCallCompleteEvent) => { events.push(event) } })
      app.mcpAddTool({ name: 'bad', description: 'bad', inputSchema: Type.Object({}) }, async () => make('content') as any)
      app.post('/direct', async (request, reply) => {
        return await app.mcpCallTool('bad', {}, { request, reply })
      })
      await app.ready()

      const response = await app.inject({ method: 'POST', url: '/direct' })
      t.assert.deepStrictEqual(response.json(), { ok: false, reason: 'invalid-result' })
      t.assert.deepStrictEqual(events.map(e => e.outcome), [{ ok: false, reason: 'invalid-result' }])
      t.assert.ok(logs.some(l => l.level === 50 && l.tool === 'bad'))
    })

    test(`a task-augmented call fails when the handler returns ${label}`, async (t: TestContext) => {
      const { app, logs } = await buildApp(t, { enableTasks: true })
      app.mcpAddTool({
        name: 'bad',
        description: 'bad',
        inputSchema: Type.Object({}),
        execution: { taskSupport: 'optional' }
      } as any, async () => make('content') as any)
      await app.ready()

      const created = await call(app, 'tools/call', { name: 'bad', arguments: {}, task: {} })
      const taskId = (created.result as CreateTaskResult).task.taskId

      let task: any
      for (let i = 0; i < 100; i++) {
        task = (await call(app, 'tasks/get', { taskId })).result
        if (isTerminal(task.status)) break
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      t.assert.strictEqual(task.status, 'failed')
      t.assert.strictEqual(task.statusMessage, 'Internal error')

      const body = await call(app, 'tasks/result', { taskId })
      assertInternalError(t, body)
      t.assert.ok(logs.some(l => l.level === 50 && l.tool === 'bad'))
    })
  }
})

describe('malformed resource handler results', () => {
  for (const [label, make] of MALFORMED) {
    test(`resources/read returns -32603 when the handler returns ${label}`, async (t: TestContext) => {
      const { app, logs } = await buildApp(t)
      app.mcpAddResource({ uriPattern: 'file://bad', name: 'bad' }, async () => make('contents') as any)
      await app.ready()

      const body = await call(app, 'resources/read', { uri: 'file://bad' })
      assertInternalError(t, body)
      t.assert.ok(logs.some(l => l.level === 50 && l.uri === 'file://bad' && /contents array/.test(l.msg)))
    })
  }
})

describe('malformed prompt handler results', () => {
  for (const [label, make] of MALFORMED) {
    test(`prompts/get returns -32603 when the handler returns ${label}`, async (t: TestContext) => {
      const { app, logs } = await buildApp(t)
      app.mcpAddPrompt({ name: 'bad' }, async () => make('messages') as any)
      await app.ready()

      const body = await call(app, 'prompts/get', { name: 'bad', arguments: {} })
      assertInternalError(t, body)
      t.assert.ok(logs.some(l => l.level === 50 && l.prompt === 'bad' && /messages array/.test(l.msg)))
    })
  }
})

test('well-formed handler results are still returned', async (t: TestContext) => {
  const { app } = await buildApp(t)
  app.mcpAddTool({ name: 'ok', description: 'ok', inputSchema: Type.Object({}) }, async () => ({ content: [] }))
  app.mcpAddResource({ uriPattern: 'file://ok', name: 'ok' }, async () => ({ contents: [] }))
  app.mcpAddPrompt({ name: 'ok' }, async () => ({ messages: [] }))
  await app.ready()

  t.assert.deepStrictEqual((await call(app, 'tools/call', { name: 'ok', arguments: {} })).result, { content: [] })
  t.assert.deepStrictEqual((await call(app, 'resources/read', { uri: 'file://ok' })).result, { contents: [] })
  t.assert.deepStrictEqual((await call(app, 'prompts/get', { name: 'ok', arguments: {} })).result, { messages: [] })
})
