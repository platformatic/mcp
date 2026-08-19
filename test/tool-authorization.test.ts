import { test, describe } from 'node:test'
import type { TestContext } from 'node:test'
import Fastify from 'fastify'
import mcpPlugin from '../src/index.ts'
import type { MCPPluginOptions } from '../src/types.ts'
import type { JSONRPCRequest, JSONRPCResultResponse, JSONRPCErrorResponse, ListToolsResult } from '../src/schema.ts'
import { INVALID_PARAMS, JSONRPC_VERSION, LATEST_PROTOCOL_VERSION, METHOD_NOT_FOUND } from '../src/schema.ts'
import { createTestJWT, setupMockAgent, generateMockJWKSResponse, createTestAuthConfig } from './auth-test-utils.ts'

async function buildApp (t: TestContext, opts: MCPPluginOptions = {}) {
  const app = Fastify({ logger: false })
  t.after(() => app.close())
  await app.register(mcpPlugin, opts)

  app.mcpAddTool({
    name: 'public-tool',
    description: 'Tool everyone can use',
    inputSchema: { type: 'object', properties: {} }
  }, async () => ({ content: [{ type: 'text', text: 'public ok' }] }))

  app.mcpAddTool({
    name: 'restricted-tool',
    description: 'Tool behind authorization',
    inputSchema: { type: 'object', properties: {} }
  }, async () => ({ content: [{ type: 'text', text: 'restricted ok' }] }))

  await app.ready()
  return app
}

function listRequest (id = 1): JSONRPCRequest {
  return { jsonrpc: JSONRPC_VERSION, id, method: 'tools/list' }
}

function callRequest (name: string, id = 1): JSONRPCRequest {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    method: 'tools/call',
    params: { name, arguments: {} }
  }
}

function listedToolNames (response: { json: () => unknown }): string[] {
  const body = response.json() as JSONRPCResultResponse
  return (body.result as ListToolsResult).tools.map(t => t.name)
}

describe('Tool Authorization (canAccessTool)', () => {
  test('without a hook, every tool is listed and callable', async (t: TestContext) => {
    const app = await buildApp(t)

    const listResponse = await app.inject({ method: 'POST', url: '/mcp', payload: listRequest() })
    t.assert.strictEqual(listResponse.statusCode, 200)
    t.assert.deepStrictEqual(listedToolNames(listResponse), ['public-tool', 'restricted-tool'])

    const callResponse = await app.inject({ method: 'POST', url: '/mcp', payload: callRequest('restricted-tool') })
    const callBody = callResponse.json() as JSONRPCResultResponse
    t.assert.ok(callBody.result, 'call should succeed without a hook')
  })

  test('tools/list omits tools the hook denies, per request', async (t: TestContext) => {
    const app = await buildApp(t, {
      canAccessTool: (toolName, context) => {
        if (toolName !== 'restricted-tool') return true
        return context.request.headers['x-role'] === 'admin'
      }
    })

    const memberResponse = await app.inject({ method: 'POST', url: '/mcp', payload: listRequest() })
    t.assert.deepStrictEqual(listedToolNames(memberResponse), ['public-tool'])

    const adminResponse = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: listRequest(),
      headers: { 'x-role': 'admin' }
    })
    t.assert.deepStrictEqual(listedToolNames(adminResponse), ['public-tool', 'restricted-tool'])
  })

  test('tools/call to a denied tool answers exactly like an unknown tool', async (t: TestContext) => {
    let handlerInvoked = false
    const app = Fastify({ logger: false })
    t.after(() => app.close())
    await app.register(mcpPlugin, { canAccessTool: (toolName) => toolName !== 'restricted-tool' })
    app.mcpAddTool({
      name: 'restricted-tool',
      description: 'Tool behind authorization',
      inputSchema: { type: 'object', properties: {} }
    }, async () => {
      handlerInvoked = true
      return { content: [{ type: 'text', text: 'restricted ok' }] }
    })
    await app.ready()

    const deniedResponse = await app.inject({ method: 'POST', url: '/mcp', payload: callRequest('restricted-tool') })
    const deniedBody = deniedResponse.json() as JSONRPCErrorResponse
    const unknownResponse = await app.inject({ method: 'POST', url: '/mcp', payload: callRequest('no-such-tool') })
    const unknownBody = unknownResponse.json() as JSONRPCErrorResponse

    t.assert.strictEqual(handlerInvoked, false, 'denied handler must not run')
    t.assert.strictEqual(deniedBody.error.code, METHOD_NOT_FOUND)
    t.assert.strictEqual(deniedBody.error.message, "Tool 'restricted-tool' not found")
    // Same code and message shape as a genuinely unknown tool: no existence leak
    t.assert.strictEqual(unknownBody.error.code, deniedBody.error.code)
    t.assert.strictEqual(unknownBody.error.message, "Tool 'no-such-tool' not found")
  })

  test('modern tools/list and tools/call use the same authorization gate', async (t: TestContext) => {
    let handlerInvoked = false
    const app = Fastify({ logger: false })
    t.after(() => app.close())
    await app.register(mcpPlugin, {
      canAccessTool: (toolName) => toolName !== 'restricted-tool'
    })
    app.mcpAddTool({
      name: 'public-tool',
      description: 'Public',
      inputSchema: { type: 'object', properties: {} }
    }, async () => ({ content: [{ type: 'text', text: 'public ok' }] }))
    app.mcpAddTool({
      name: 'restricted-tool',
      description: 'Restricted',
      inputSchema: { type: 'object', properties: {} }
    }, async () => {
      handlerInvoked = true
      return { content: [{ type: 'text', text: 'restricted ok' }] }
    })
    await app.ready()

    const client = app.mcpClient({ protocolVersion: LATEST_PROTOCOL_VERSION })
    const listed = await client.listTools()
    t.assert.ok('result' in listed.body)
    const tools = (listed.body.result as { tools: Array<{ name: string }> }).tools
    t.assert.deepStrictEqual(tools.map(tool => tool.name), ['public-tool'])

    const denied = await client.callTool('restricted-tool')
    const unknown = await client.callTool('no-such-tool')
    t.assert.ok('error' in denied.body)
    t.assert.ok('error' in unknown.body)
    t.assert.strictEqual(denied.body.error.code, INVALID_PARAMS)
    t.assert.strictEqual(unknown.body.error.code, denied.body.error.code)
    t.assert.match(denied.body.error.message, /Unknown tool/)
    t.assert.match(unknown.body.error.message, /Unknown tool/)
    t.assert.strictEqual(handlerInvoked, false)
  })

  test('the hook is invoked for unknown tool names too', async (t: TestContext) => {
    // Same code path for unknown and denied names: identical protocol response
    const checkedNames: string[] = []
    const app = await buildApp(t, {
      canAccessTool: async (toolName) => {
        checkedNames.push(toolName)
        await new Promise(resolve => setImmediate(resolve))
        return toolName !== 'restricted-tool'
      }
    })

    await app.inject({ method: 'POST', url: '/mcp', payload: callRequest('restricted-tool') })
    await app.inject({ method: 'POST', url: '/mcp', payload: callRequest('no-such-tool') })

    t.assert.ok(checkedNames.includes('restricted-tool'), 'denied registered name must be checked')
    t.assert.ok(checkedNames.includes('no-such-tool'), 'unknown name must be checked')
  })

  test('tools/list evaluates independent checks concurrently', async (t: TestContext) => {
    let activeChecks = 0
    let maxConcurrentChecks = 0
    const app = await buildApp(t, {
      canAccessTool: async () => {
        activeChecks++
        maxConcurrentChecks = Math.max(maxConcurrentChecks, activeChecks)
        await new Promise(resolve => setImmediate(resolve))
        activeChecks--
        return true
      }
    })

    const listResponse = await app.inject({ method: 'POST', url: '/mcp', payload: listRequest() })
    // buildApp registers two tools; serial evaluation would report 1
    t.assert.strictEqual(maxConcurrentChecks, 2)
    // Concurrency must not reorder: registration order is preserved
    t.assert.deepStrictEqual(listedToolNames(listResponse), ['public-tool', 'restricted-tool'])
  })

  test('tools/list caps concurrent hook evaluations with many tools', async (t: TestContext) => {
    const TOOL_COUNT = 50
    const CONCURRENCY_CAP = 8
    let activeChecks = 0
    let maxConcurrentChecks = 0
    let totalChecks = 0
    const app = Fastify({ logger: false })
    t.after(() => app.close())
    await app.register(mcpPlugin, {
      canAccessTool: async () => {
        activeChecks++
        totalChecks++
        maxConcurrentChecks = Math.max(maxConcurrentChecks, activeChecks)
        await new Promise(resolve => setImmediate(resolve))
        activeChecks--
        return true
      }
    })
    for (let i = 0; i < TOOL_COUNT; i++) {
      app.mcpAddTool({
        name: `tool-${i}`,
        description: `Tool number ${i}`,
        inputSchema: { type: 'object', properties: {} }
      }, async () => ({ content: [{ type: 'text', text: 'ok' }] }))
    }
    await app.ready()

    const listResponse = await app.inject({ method: 'POST', url: '/mcp', payload: listRequest() })

    t.assert.strictEqual(totalChecks, TOOL_COUNT, 'every tool must be checked')
    t.assert.ok(maxConcurrentChecks > 1, 'checks must overlap')
    t.assert.ok(
      maxConcurrentChecks <= CONCURRENCY_CAP,
      `at most ${CONCURRENCY_CAP} concurrent checks, saw ${maxConcurrentChecks}`
    )
    // Registration order preserved despite the bounded pool
    t.assert.deepStrictEqual(
      listedToolNames(listResponse),
      Array.from({ length: TOOL_COUNT }, (_, i) => `tool-${i}`)
    )
  })

  test('async hooks are awaited', async (t: TestContext) => {
    const app = await buildApp(t, {
      canAccessTool: async (toolName) => {
        await new Promise(resolve => setImmediate(resolve))
        return toolName === 'public-tool'
      }
    })

    const listResponse = await app.inject({ method: 'POST', url: '/mcp', payload: listRequest() })
    t.assert.deepStrictEqual(listedToolNames(listResponse), ['public-tool'])

    const callResponse = await app.inject({ method: 'POST', url: '/mcp', payload: callRequest('restricted-tool') })
    const callBody = callResponse.json() as JSONRPCErrorResponse
    t.assert.strictEqual(callBody.error.code, METHOD_NOT_FOUND)
  })

  test('a throwing hook fails closed', async (t: TestContext) => {
    const app = await buildApp(t, {
      canAccessTool: () => {
        throw new Error('authorization backend unavailable')
      }
    })

    const listResponse = await app.inject({ method: 'POST', url: '/mcp', payload: listRequest() })
    t.assert.strictEqual(listResponse.statusCode, 200, 'a hook failure must not become an HTTP error')
    t.assert.deepStrictEqual(listedToolNames(listResponse), [])

    const callResponse = await app.inject({ method: 'POST', url: '/mcp', payload: callRequest('public-tool') })
    const callBody = callResponse.json() as JSONRPCErrorResponse
    t.assert.strictEqual(callBody.error.code, METHOD_NOT_FOUND)
  })

  test('non-boolean truthy returns deny access', async (t: TestContext) => {
    // A hook typed away from strictness (e.g. plain JS) returning a truthy
    // non-boolean must not accidentally grant access
    const app = await buildApp(t, {
      canAccessTool: (() => 'yes') as unknown as MCPPluginOptions['canAccessTool']
    })

    const listResponse = await app.inject({ method: 'POST', url: '/mcp', payload: listRequest() })
    t.assert.deepStrictEqual(listedToolNames(listResponse), [])
  })

  test('task-augmented calls inherit the gate', async (t: TestContext) => {
    const app = Fastify({ logger: false })
    t.after(() => app.close())
    await app.register(mcpPlugin, {
      enableTasks: true,
      canAccessTool: (toolName) => toolName !== 'restricted-task-tool'
    })
    app.mcpAddTool({
      name: 'restricted-task-tool',
      description: 'Task-capable tool behind authorization',
      inputSchema: { type: 'object', properties: {} },
      execution: { taskSupport: 'optional' }
    }, async () => ({ content: [{ type: 'text', text: 'should never run' }] }))
    await app.ready()

    const taskCallResponse = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'mcp-protocol-version': '2025-11-25' },
      payload: {
        jsonrpc: JSONRPC_VERSION,
        id: 2,
        method: 'tools/call',
        params: { name: 'restricted-task-tool', arguments: {}, task: {} }
      }
    })
    const taskCallBody = taskCallResponse.json() as JSONRPCErrorResponse
    t.assert.strictEqual(taskCallBody.error.code, METHOD_NOT_FOUND)
    t.assert.strictEqual(taskCallBody.error.message, "Tool 'restricted-task-tool' not found")
  })

  test('hook receives the authContext of the calling token', async (t: TestContext) => {
    const restoreMock = setupMockAgent({
      'https://auth.example.com/.well-known/jwks.json': generateMockJWKSResponse()
    })
    t.after(() => restoreMock())

    const app = await buildApp(t, {
      authorization: createTestAuthConfig({ resourceUri: 'http://localhost:3000' }),
      canAccessTool: (toolName, context) => {
        if (toolName !== 'restricted-tool') return true
        return context.authContext?.scopes?.includes('tools:admin') === true
      }
    })

    const withScope = createTestJWT({ aud: 'http://localhost:3000', scope: 'tools:read tools:admin' } as any)
    const withoutScope = createTestJWT({ aud: 'http://localhost:3000', scope: 'tools:read' } as any)

    const adminList = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${withScope}` },
      payload: listRequest()
    })
    t.assert.deepStrictEqual(listedToolNames(adminList), ['public-tool', 'restricted-tool'])

    const readerList = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${withoutScope}` },
      payload: listRequest()
    })
    t.assert.deepStrictEqual(listedToolNames(readerList), ['public-tool'])

    const readerCall = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${withoutScope}` },
      payload: callRequest('restricted-tool')
    })
    const readerCallBody = readerCall.json() as JSONRPCErrorResponse
    t.assert.strictEqual(readerCallBody.error.code, METHOD_NOT_FOUND)

    const adminCall = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${withScope}` },
      payload: callRequest('restricted-tool')
    })
    const adminCallBody = adminCall.json() as JSONRPCResultResponse
    t.assert.ok(adminCallBody.result, 'holder of the required scope can call the tool')
  })
})
