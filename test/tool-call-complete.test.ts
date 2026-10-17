import { test, describe } from 'node:test'
import type { TestContext } from 'node:test'
import Fastify from 'fastify'
import { Type } from '@sinclair/typebox'
import mcpPlugin from '../src/index.ts'
import type { MCPToolCallCompleteEvent } from '../src/index.ts'
import { JSONRPC_VERSION, LATEST_LEGACY_PROTOCOL_VERSION, LATEST_PROTOCOL_VERSION } from '../src/schema.ts'
import { META_CLIENT_CAPABILITIES, META_PROTOCOL_VERSION, TASKS_EXTENSION } from '../src/schema-2026.ts'

async function call (app: any, method: string, params: unknown, id = 1) {
  const response = await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: { 'mcp-protocol-version': LATEST_LEGACY_PROTOCOL_VERSION },
    payload: { jsonrpc: JSONRPC_VERSION, id, method, params }
  })
  return response.json()
}

async function modernCall (
  app: any,
  method: string,
  params: Record<string, unknown>,
  capabilities: Record<string, unknown> = {},
  id = 1
) {
  const response = await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
      'mcp-method': method,
      ...(typeof params.name === 'string' ? { 'mcp-name': params.name } : {})
    },
    payload: {
      jsonrpc: JSONRPC_VERSION,
      id,
      method,
      params: {
        ...params,
        _meta: {
          [META_PROTOCOL_VERSION]: LATEST_PROTOCOL_VERSION,
          [META_CLIENT_CAPABILITIES]: capabilities
        }
      }
    }
  })
  return response.json()
}

/** Poll tasks/get until the task leaves the `working` state */
async function waitForTaskEvent (events: () => MCPToolCallCompleteEvent[]): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (events().some(e => e.source === 'task')) {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('task never emitted a completion event')
}

async function buildApp (t: TestContext, opts: Record<string, unknown> = {}) {
  const events: MCPToolCallCompleteEvent[] = []

  const app = Fastify({ logger: false })
  t.after(() => app.close())

  await app.register(mcpPlugin, {
    enableTasks: true,
    canAccessTool: (toolName) => toolName !== 'denied',
    onToolCallComplete: (event) => { events.push(event) },
    ...opts
  })

  app.mcpAddTool({
    name: 'echo',
    description: 'Echo a message',
    inputSchema: Type.Object({ message: Type.String() })
  }, async (args) => ({ content: [{ type: 'text', text: args.message }] }))

  app.mcpAddTool({
    name: 'boom',
    description: 'Throws from handler',
    inputSchema: Type.Object({})
  }, async () => { throw new Error('kaboom') })

  app.mcpAddTool({
    name: 'denied',
    description: 'Denied by canAccessTool',
    inputSchema: Type.Object({})
  }, async () => ({ content: [{ type: 'text', text: 'nope' }] }))

  app.mcpAddTool({
    name: 'slow',
    description: 'Optional task support',
    inputSchema: Type.Object({}),
    execution: { taskSupport: 'optional' }
  } as any, async () => ({ content: [{ type: 'text', text: 'task ok' }] }))

  app.mcpAddTool({
    name: 'task-only',
    description: 'Must be invoked as a task',
    inputSchema: Type.Object({}),
    execution: { taskSupport: 'required' }
  } as any, async () => ({ content: [{ type: 'text', text: 'done' }] }))

  app.post('/direct-tool-call', async (request, reply) => {
    const body = request.body as { name: string, args?: Record<string, unknown> }
    return await app.mcpCallTool(body.name, body.args ?? {}, { request, reply })
  })

  await app.ready()

  return { app, events: () => events }
}

describe('onToolCallComplete', () => {
  test('a successful JSON-RPC call emits one event', async (t: TestContext) => {
    const { app, events } = await buildApp(t)

    await call(app, 'tools/call', { name: 'echo', arguments: { message: 'hi' } })

    t.assert.strictEqual(events().length, 1)
    t.assert.strictEqual(events()[0].source, 'json-rpc')
    t.assert.strictEqual(events()[0].toolName, 'echo')
    t.assert.deepStrictEqual(events()[0].arguments, { message: 'hi' })
  })

  test('a successful modern JSON-RPC call emits one event', async (t: TestContext) => {
    const { app, events } = await buildApp(t)

    await modernCall(app, 'tools/call', { name: 'echo', arguments: { message: 'modern' } })

    t.assert.strictEqual(events().length, 1)
    t.assert.strictEqual(events()[0].source, 'json-rpc')
    t.assert.strictEqual(events()[0].toolName, 'echo')
    t.assert.deepStrictEqual(events()[0].arguments, { message: 'modern' })
  })

  test('modern denied and unknown calls emit normalized not-found outcomes', async (t: TestContext) => {
    const { app, events } = await buildApp(t)

    await modernCall(app, 'tools/call', { name: 'denied', arguments: {} }, {}, 1)
    await modernCall(app, 'tools/call', { name: 'missing', arguments: {} }, {}, 2)

    t.assert.strictEqual(events().length, 2)
    t.assert.ok(events().every(event => !event.outcome.ok && event.outcome.reason === 'not-found'))
  })

  test('an in-process call emits one event with source: in-process', async (t: TestContext) => {
    const { app, events } = await buildApp(t)

    await app.inject({ method: 'POST', url: '/direct-tool-call', payload: { name: 'echo', args: { message: 'hi' } } })

    t.assert.strictEqual(events().length, 1)
    t.assert.strictEqual(events()[0].source, 'in-process')
  })

  test('invalid arguments expose the structured outcome', async (t: TestContext) => {
    const { app, events } = await buildApp(t)

    await call(app, 'tools/call', { name: 'echo', arguments: {} })

    t.assert.strictEqual(events().length, 1)
    const outcome = events()[0].outcome
    t.assert.strictEqual(outcome.ok, false)
    t.assert.strictEqual(!outcome.ok && outcome.reason, 'invalid-arguments')
  })

  test('denied and unknown tools expose their normalized not-found outcome', async (t: TestContext) => {
    const { app, events } = await buildApp(t)

    await call(app, 'tools/call', { name: 'denied', arguments: {} })
    await call(app, 'tools/call', { name: 'does-not-exist', arguments: {} })

    t.assert.strictEqual(events().length, 2)
    for (const event of events()) {
      t.assert.deepStrictEqual(event.outcome, { ok: false, reason: 'not-found' })
    }
  })

  test('a handler error exposes the resulting CallToolResult', async (t: TestContext) => {
    const { app, events } = await buildApp(t)

    await call(app, 'tools/call', { name: 'boom', arguments: {} })

    t.assert.strictEqual(events().length, 1)
    const outcome = events()[0].outcome
    t.assert.strictEqual(outcome.ok, true)
    t.assert.strictEqual(outcome.ok && outcome.result.isError, true)
  })

  test('a task-required tool called directly emits a task-required outcome', async (t: TestContext) => {
    const { app, events } = await buildApp(t)

    await call(app, 'tools/call', { name: 'task-only', arguments: {} })

    t.assert.strictEqual(events().length, 1)
    t.assert.deepStrictEqual(events()[0].outcome, { ok: false, reason: 'task-required' })
  })

  test('the original request, auth context, arguments, and session are provided', async (t: TestContext) => {
    const { app, events } = await buildApp(t)

    await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'mcp-protocol-version': LATEST_LEGACY_PROTOCOL_VERSION },
      payload: { jsonrpc: JSONRPC_VERSION, id: 1, method: 'tools/call', params: { name: 'echo', arguments: { message: 'hi' } } }
    })

    const event = events()[0]
    t.assert.ok(event.request)
    t.assert.ok(event.reply)
    t.assert.deepStrictEqual(event.arguments, { message: 'hi' })
  })

  test('duration is a non-negative number', async (t: TestContext) => {
    const { app, events } = await buildApp(t)

    await call(app, 'tools/call', { name: 'echo', arguments: { message: 'hi' } })

    t.assert.strictEqual(typeof events()[0].durationMs, 'number')
    t.assert.ok(events()[0].durationMs >= 0)
  })

  test('every event carries a requestId for correlation', async (t: TestContext) => {
    const { app, events } = await buildApp(t)

    await call(app, 'tools/call', { name: 'echo', arguments: { message: 'hi' } })

    t.assert.strictEqual(typeof events()[0].requestId, 'string')
    t.assert.ok(events()[0].requestId.length > 0)
  })

  test('task events do not expose completed request lifecycle objects', async (t: TestContext) => {
    const { app, events } = await buildApp(t)

    await call(app, 'tools/call', { name: 'slow', arguments: {}, task: {} })

    await waitForTaskEvent(events)

    const event = events().find(candidate => candidate.source === 'task')

    t.assert.ok(event)
    t.assert.strictEqual('request' in event!, false)
    t.assert.strictEqual('reply' in event!, false)
    t.assert.strictEqual(typeof event!.requestId, 'string')
    t.assert.ok(event!.requestId.length > 0)
  })

  test('JSON-RPC duration includes authorization', async (t: TestContext) => {
    const authorizationDelayMs = 30

    const { app, events } = await buildApp(t, {
      canAccessTool: async () => {
        await new Promise(resolve => setTimeout(resolve, authorizationDelayMs))
        return true
      }
    })

    await call(app, 'tools/call', { name: 'echo', arguments: { message: 'hello' } })

    t.assert.strictEqual(events().length, 1)
    t.assert.ok(events()[0].durationMs >= authorizationDelayMs - 5)
  })

  test('in-process duration includes authorization', async (t: TestContext) => {
    const authorizationDelayMs = 30

    const { app, events } = await buildApp(t, {
      canAccessTool: async () => {
        await new Promise(resolve => setTimeout(resolve, authorizationDelayMs))
        return true
      }
    })

    await app.inject({ method: 'POST', url: '/direct-tool-call', payload: { name: 'echo', args: { message: 'hi' } } })

    t.assert.strictEqual(events().length, 1)
    t.assert.ok(events()[0].durationMs >= authorizationDelayMs - 5)
  })

  test('a throwing observer does not change the MCP response', async (t: TestContext) => {
    const app = Fastify({ logger: false })
    t.after(() => app.close())
    await app.register(mcpPlugin, { onToolCallComplete: () => { throw new Error('observer exploded') } })
    app.mcpAddTool({
      name: 'echo',
      description: 'Echo a message',
      inputSchema: Type.Object({ message: Type.String() })
    }, async (args) => ({ content: [{ type: 'text', text: args.message }] }))
    await app.ready()

    const body = await call(app, 'tools/call', { name: 'echo', arguments: { message: 'hi' } })

    t.assert.deepStrictEqual(body.result, { content: [{ type: 'text', text: 'hi' }] })
  })

  test('tools/list does not emit an event', async (t: TestContext) => {
    const { app, events } = await buildApp(t)

    await call(app, 'tools/list', {})

    t.assert.strictEqual(events().length, 0)
  })

  test('a modern task emits one completion event with source task', async (t: TestContext) => {
    const { app, events } = await buildApp(t)
    const capabilities = { extensions: { [TASKS_EXTENSION]: {} } }

    await modernCall(app, 'tools/call', { name: 'slow', arguments: {} }, capabilities)
    await waitForTaskEvent(events)

    t.assert.strictEqual(events().length, 1)
    t.assert.strictEqual(events()[0].source, 'task')
  })

  test('a task emits one event, with source: task, when execution finishes', async (t: TestContext) => {
    const { app, events } = await buildApp(t)

    await call(app, 'tools/call', { name: 'slow', arguments: {}, task: {} })

    await waitForTaskEvent(events)

    t.assert.strictEqual(events().length, 1)
    t.assert.strictEqual(events()[0].source, 'task')
    t.assert.strictEqual(events()[0].outcome.ok, true)
  })
})
