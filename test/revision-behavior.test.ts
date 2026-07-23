import { test, describe } from 'node:test'
import type { TestContext } from 'node:test'
import Fastify from 'fastify'
import { Type } from '@sinclair/typebox'
import mcpPlugin from '../src/index.ts'
import { JSONRPC_VERSION, METHOD_NOT_FOUND } from '../src/schema.ts'
import {
  atLeast,
  supportsTasks,
  supportsIcons,
  trimDefinitionToRevision,
  capabilitiesForRevision
} from '../src/protocol-version.ts'

const OLD = '2025-03-26'
const NEW = '2025-11-25'

async function call (app: any, method: string, params: unknown, version?: string, sessionId?: string) {
  const headers: Record<string, string> = {}
  if (version) headers['mcp-protocol-version'] = version
  if (sessionId) headers['mcp-session-id'] = sessionId

  const response = await app.inject({
    method: 'POST',
    url: '/mcp',
    headers,
    payload: { jsonrpc: JSONRPC_VERSION, id: 1, method, params }
  })
  return response
}

async function buildApp (t: TestContext, opts: Record<string, unknown> = {}) {
  const app = Fastify({ logger: false })
  t.after(() => app.close())
  await app.register(mcpPlugin, { enableTasks: true, ...opts })

  app.mcpAddTool({
    name: 'adder',
    description: 'Adds two numbers',
    inputSchema: Type.Object({ a: Type.Number(), b: Type.Number() }),
    icons: [{ src: 'https://example.com/i.png', mimeType: 'image/png' }],
    execution: { taskSupport: 'optional' }
  } as any, async (params: any) => ({
    content: [{ type: 'text', text: String(params.a + params.b) }]
  }))

  await app.ready()
  return app
}

describe('revision comparison', () => {
  test('atLeast orders revisions and treats absence as oldest', (t: TestContext) => {
    t.assert.strictEqual(atLeast(NEW, NEW), true)
    t.assert.strictEqual(atLeast('2026-07-28', NEW), true)
    t.assert.strictEqual(atLeast(OLD, NEW), false)
    t.assert.strictEqual(atLeast('2024-11-05', NEW), false)
    t.assert.strictEqual(atLeast(undefined, NEW), false)
  })

  test('feature predicates follow the revision that introduced them', (t: TestContext) => {
    t.assert.strictEqual(supportsTasks(NEW), true)
    t.assert.strictEqual(supportsTasks(OLD), false)
    t.assert.strictEqual(supportsIcons(NEW), true)
    t.assert.strictEqual(supportsIcons(OLD), false)
  })

  test('trimDefinitionToRevision removes only what postdates the revision', (t: TestContext) => {
    const definition = { name: 't', icons: [{ src: 'x' }], execution: { taskSupport: 'optional' } }

    t.assert.deepStrictEqual(trimDefinitionToRevision(definition, NEW), definition)
    t.assert.deepStrictEqual(trimDefinitionToRevision(definition, OLD), { name: 't' })
  })

  test('trimDefinitionToRevision does not mutate its input', (t: TestContext) => {
    const definition = { name: 't', icons: [{ src: 'x' }] }
    trimDefinitionToRevision(definition, OLD)
    t.assert.ok(definition.icons, 'the original definition should be untouched')
  })

  test('capabilitiesForRevision drops tasks for older revisions', (t: TestContext) => {
    const capabilities = { tools: {}, tasks: { cancel: {} } }

    t.assert.deepStrictEqual(capabilitiesForRevision(capabilities, NEW), capabilities)
    t.assert.deepStrictEqual(capabilitiesForRevision(capabilities, OLD), { tools: {} })
    // Nothing to strip when tasks were never advertised
    t.assert.deepStrictEqual(capabilitiesForRevision({ tools: {} }, OLD), { tools: {} })
  })
})

describe('a client on 2025-03-26 keeps that revision\'s behavior', () => {
  test('initialize does not advertise tasks', async (t: TestContext) => {
    const app = await buildApp(t)

    const old = await call(app, 'initialize', { protocolVersion: OLD, capabilities: {} })
    t.assert.strictEqual(old.json().result.protocolVersion, OLD)
    t.assert.strictEqual(old.json().result.capabilities.tasks, undefined)

    const modern = await call(app, 'initialize', { protocolVersion: NEW, capabilities: {} })
    t.assert.strictEqual(modern.json().result.protocolVersion, NEW)
    t.assert.ok(modern.json().result.capabilities.tasks)
  })

  test('tools/list omits icons, execution and the schema dialect', async (t: TestContext) => {
    const app = await buildApp(t)

    const old = (await call(app, 'tools/list', {}, OLD)).json().result.tools[0]
    t.assert.strictEqual(old.icons, undefined)
    t.assert.strictEqual(old.execution, undefined)
    t.assert.strictEqual(old.inputSchema.$schema, undefined)
    // The fields the old revision does define are still there
    t.assert.strictEqual(old.name, 'adder')
    t.assert.strictEqual(old.inputSchema.type, 'object')

    const modern = (await call(app, 'tools/list', {}, NEW)).json().result.tools[0]
    t.assert.ok(modern.icons)
    t.assert.ok(modern.execution)
    t.assert.ok(modern.inputSchema.$schema)
  })

  test('the tasks methods do not exist', async (t: TestContext) => {
    const app = await buildApp(t)

    for (const method of ['tasks/get', 'tasks/result', 'tasks/list', 'tasks/cancel']) {
      const body = (await call(app, method, { taskId: 'x' }, OLD)).json()
      t.assert.strictEqual(body.error.code, METHOD_NOT_FOUND, `${method} should not exist on ${OLD}`)
      t.assert.match(body.error.message, /not found/)
    }
  })

  test('a task field on tools/call is ignored rather than honoured', async (t: TestContext) => {
    const app = await buildApp(t)

    const body = (await call(app, 'tools/call', {
      name: 'adder',
      arguments: { a: 2, b: 3 },
      task: { ttl: 30_000 }
    }, OLD)).json()

    // Executed normally, so the caller gets the tool result and not a task handle
    t.assert.strictEqual(body.result.content[0].text, '5')
    t.assert.strictEqual(body.result.task, undefined)
  })
})

describe('the session version is authoritative', () => {
  test('a header that contradicts the negotiated version is rejected', async (t: TestContext) => {
    const app = await buildApp(t, { enableSSE: true })

    const init = await call(app, 'initialize', { protocolVersion: OLD, capabilities: {} })
    const sessionId = init.headers['mcp-session-id'] as string
    t.assert.strictEqual(init.json().result.protocolVersion, OLD)

    const mismatched = await call(app, 'tools/list', {}, NEW, sessionId)
    t.assert.strictEqual(mismatched.statusCode, 400)
    t.assert.strictEqual(mismatched.json().negotiated, OLD)

    const matching = await call(app, 'tools/list', {}, OLD, sessionId)
    t.assert.strictEqual(matching.statusCode, 200)
  })

  test('a session that negotiated an old revision keeps it when the header is omitted', async (t: TestContext) => {
    const app = await buildApp(t, { enableSSE: true })

    const init = await call(app, 'initialize', { protocolVersion: OLD, capabilities: {} })
    const sessionId = init.headers['mcp-session-id'] as string

    const body = (await call(app, 'tools/list', {}, undefined, sessionId)).json()
    t.assert.strictEqual(body.result.tools[0].icons, undefined)
  })

  test('a session that negotiated 2025-11-25 keeps it when the header is omitted', async (t: TestContext) => {
    const app = await buildApp(t, { enableSSE: true })

    const init = await call(app, 'initialize', { protocolVersion: NEW, capabilities: {} })
    const sessionId = init.headers['mcp-session-id'] as string

    // Without the session lookup this would fall back to 2025-03-26 and lose icons
    const body = (await call(app, 'tools/list', {}, undefined, sessionId)).json()
    t.assert.ok(body.result.tools[0].icons)
  })

  test('initialize may re-negotiate on an existing session', async (t: TestContext) => {
    const app = await buildApp(t, { enableSSE: true })

    const init = await call(app, 'initialize', { protocolVersion: OLD, capabilities: {} })
    const sessionId = init.headers['mcp-session-id'] as string

    // Re-negotiating upward must not be blocked by the earlier agreement
    const again = await call(app, 'initialize', { protocolVersion: NEW, capabilities: {} }, NEW, sessionId)
    t.assert.strictEqual(again.statusCode, 200)
    t.assert.strictEqual(again.json().result.protocolVersion, NEW)

    // ...and the new agreement sticks
    const body = (await call(app, 'tools/list', {}, NEW, sessionId)).json()
    t.assert.ok(body.result.tools[0].icons)
  })

  test('URL elicitation is refused for a session on an older revision', async (t: TestContext) => {
    const app = await buildApp(t, { enableSSE: true })

    const oldInit = await call(app, 'initialize', { protocolVersion: OLD, capabilities: {} })
    const oldSession = oldInit.headers['mcp-session-id'] as string
    t.assert.strictEqual(
      await app.mcpElicitUrl(oldSession, 'Authorize', 'https://mcp.example.com/connect'),
      null
    )

    const newInit = await call(app, 'initialize', { protocolVersion: NEW, capabilities: {} })
    const newSession = newInit.headers['mcp-session-id'] as string
    t.assert.ok(await app.mcpElicitUrl(newSession, 'Authorize', 'https://mcp.example.com/connect'))
  })
})
