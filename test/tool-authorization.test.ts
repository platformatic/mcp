import { test, describe } from 'node:test'
import type { TestContext } from 'node:test'
import Fastify from 'fastify'
import mcpPlugin from '../src/index.ts'
import type { MCPPluginOptions } from '../src/types.ts'
import type { JSONRPCRequest, JSONRPCResultResponse, JSONRPCErrorResponse, ListToolsResult } from '../src/schema.ts'
import { JSONRPC_VERSION, METHOD_NOT_FOUND } from '../src/schema.ts'
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
      canAccessTool: (tool, context) => {
        if (tool.name !== 'restricted-tool') return true
        return context.request?.headers['x-role'] === 'admin'
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
    await app.register(mcpPlugin, { canAccessTool: (tool) => tool.name !== 'restricted-tool' })
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

  test('async hooks are awaited', async (t: TestContext) => {
    const app = await buildApp(t, {
      canAccessTool: async (tool) => {
        await new Promise(resolve => setImmediate(resolve))
        return tool.name === 'public-tool'
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
      canAccessTool: (tool) => tool.name !== 'restricted-task-tool'
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
      canAccessTool: (tool, context) => {
        if (tool.name !== 'restricted-tool') return true
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
