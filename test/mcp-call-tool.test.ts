import { test, describe } from 'node:test'
import type { TestContext } from 'node:test'
import Fastify from 'fastify'
import type { FastifyRequest } from 'fastify'
import { Type } from '@sinclair/typebox'
import mcpPlugin from '../src/index.ts'
import type { JSONRPCErrorResponse, JSONRPCRequest, JSONRPCResultResponse, CallToolResult } from '../src/index.ts'
import { JSONRPC_VERSION, LATEST_PROTOCOL_VERSION, METHOD_NOT_FOUND } from '../src/schema.ts'

type DirectBody = {
  name: string
  args?: Record<string, unknown>
  authUserId?: string
  authScopes?: string[]
  spoofContextOverrides?: boolean
}

const SEARCH_JSON_SCHEMA = {
  type: 'object' as const,
  properties: {
    query: { type: 'string', minLength: 1 }
  },
  required: ['query'],
  additionalProperties: false
}

async function buildApp (t: TestContext) {
  let handlerInvocations = 0
  let taskOnlyInvocations = 0
  let jsonSchemaInvocations = 0
  let accessContextRequest: FastifyRequest | undefined
  let accessContextOperation: string | undefined
  let directRouteRequest: FastifyRequest | undefined

  const app = Fastify({ logger: false })
  t.after(() => app.close())

  await app.register(mcpPlugin, {
    enableSSE: true,
    validateJsonSchemaInputs: {},
    canAccessTool: (toolName, context) => {
      accessContextRequest = context.request
      accessContextOperation = context.operation
      if (toolName === 'wallet-summary') {
        return context.authContext?.scopes?.includes('wallet-summary:read') === true
      }
      return toolName !== 'restricted'
    }
  })

  app.mcpAddTool({
    name: 'echo',
    description: 'Echo a message',
    inputSchema: Type.Object({
      message: Type.String()
    })
  }, async (args) => {
    handlerInvocations++
    return { content: [{ type: 'text', text: args.message }] }
  })

  app.mcpAddTool({
    name: 'restricted',
    description: 'Denied by canAccessTool',
    inputSchema: Type.Object({})
  }, async () => {
    handlerInvocations++
    return { content: [{ type: 'text', text: 'restricted ok' }] }
  })

  app.mcpAddTool({
    name: 'throws',
    description: 'Throws from handler',
    inputSchema: Type.Object({})
  }, async () => {
    throw new Error('kaboom')
  })

  app.mcpAddTool({
    name: 'missing-handler',
    description: 'Registered without a handler',
    inputSchema: Type.Object({})
  })

  app.mcpAddTool({
    name: 'json-search',
    description: 'Plain JSON Schema search',
    inputSchema: SEARCH_JSON_SCHEMA
  }, async () => {
    jsonSchemaInvocations++
    return { content: [{ type: 'text', text: 'json ok' }] }
  })

  app.mcpAddTool({
    name: 'session-id',
    description: 'Returns the active session id',
    inputSchema: Type.Object({})
  }, async (_args, context) => {
    return { content: [{ type: 'text', text: context.sessionId ?? 'missing' }] }
  })

  app.mcpAddTool({
    name: 'reply-aware',
    description: 'Touches the Fastify reply',
    inputSchema: Type.Object({})
  }, async (_args, context) => {
    context.reply.header('x-tool-reply', 'applied')
    context.reply.code(209)
    return { content: [{ type: 'text', text: 'reply ok' }] }
  })

  app.mcpAddTool({
    name: 'task-only',
    description: 'Requires task execution',
    inputSchema: Type.Object({}),
    execution: { taskSupport: 'required' }
  }, async () => {
    taskOnlyInvocations++
    return { content: [{ type: 'text', text: 'task ok' }] }
  })

  app.mcpAddTool({
    name: 'auth-context',
    description: 'Returns auth context user id',
    inputSchema: Type.Object({})
  }, async (_args, context) => {
    return { content: [{ type: 'text', text: context.authContext?.userId ?? 'missing' }] }
  })

  app.mcpAddTool({
    name: 'wallet-summary',
    description: 'Returns a wallet summary',
    inputSchema: Type.Object({})
  }, async () => {
    return { content: [{ type: 'text', text: 'wallet ok' }] }
  })

  app.post('/direct-tool-call', async (request, reply) => {
    directRouteRequest = request
    const body = request.body as DirectBody
    if (body.spoofContextOverrides === true) {
      // Simulate a JS/any caller injecting undeclared properties on context.
      const contextWithOverrides = {
        request,
        reply,
        opts: {
          canAccessTool: () => true
        },
        tools: new Map([
          ['echo', {
            definition: {
              name: 'echo',
              description: 'Spoofed echo',
              inputSchema: Type.Object({ message: Type.String() })
            },
            handler: async () => ({ content: [{ type: 'text', text: 'spoofed' }] })
          }]
        ])
      } as unknown as Parameters<typeof app.mcpCallTool>[2]

      return await app.mcpCallTool(body.name, body.args ?? {}, contextWithOverrides)
    }

    if (body.authUserId !== undefined || body.authScopes !== undefined) {
      return await app.mcpCallTool(body.name, body.args ?? {}, {
        request,
        reply,
        authContext: { userId: body.authUserId, scopes: body.authScopes, tokenType: 'Bearer' }
      })
    }
    return await app.mcpCallTool(body.name, body.args ?? {}, { request, reply })
  })

  await app.ready()

  return {
    app,
    getHandlerInvocations: () => handlerInvocations,
    getJsonSchemaInvocations: () => jsonSchemaInvocations,
    getTaskOnlyInvocations: () => taskOnlyInvocations,
    getAccessContextRequest: () => accessContextRequest,
    getAccessContextOperation: () => accessContextOperation,
    getDirectRouteRequest: () => directRouteRequest
  }
}

function callRequest (name: string, args: Record<string, unknown>, id = 1): JSONRPCRequest {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    method: 'tools/call',
    params: { name, arguments: args }
  }
}

function initializeRequest (id = 100): JSONRPCRequest {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    method: 'initialize',
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' }
    }
  }
}

function textFromResult (result: CallToolResult): string {
  const content = result.content[0]
  tAssertTextContent(content)
  return content.text
}

function tAssertTextContent (content: CallToolResult['content'][number]): asserts content is { type: 'text', text: string } {
  if (content.type !== 'text') {
    throw new Error(`Expected text content, got ${content.type}`)
  }
}

describe('mcpCallTool', () => {
  test('returns a successful tool result in-process', async (t: TestContext) => {
    const { app } = await buildApp(t)

    const response = await app.inject({
      method: 'POST',
      url: '/direct-tool-call',
      payload: { name: 'echo', args: { message: 'hello' } }
    })

    t.assert.strictEqual(response.statusCode, 200)
    t.assert.deepStrictEqual(response.json(), {
      ok: true,
      result: { content: [{ type: 'text', text: 'hello' }] }
    })
  })

  test('reports unknown and denied tools without invoking handlers', async (t: TestContext) => {
    const { app, getHandlerInvocations } = await buildApp(t)

    const unknownResponse = await app.inject({
      method: 'POST',
      url: '/direct-tool-call',
      payload: { name: 'missing', args: {} }
    })
    const deniedResponse = await app.inject({
      method: 'POST',
      url: '/direct-tool-call',
      payload: { name: 'restricted', args: {} }
    })

    t.assert.deepStrictEqual(unknownResponse.json(), { ok: false, reason: 'not-found' })
    t.assert.deepStrictEqual(deniedResponse.json(), { ok: false, reason: 'not-found' })
    t.assert.strictEqual(getHandlerInvocations(), 0)
  })

  test('reports invalid arguments without invoking the handler', async (t: TestContext) => {
    const { app, getHandlerInvocations } = await buildApp(t)

    const response = await app.inject({
      method: 'POST',
      url: '/direct-tool-call',
      payload: { name: 'echo', args: {} }
    })
    const body = response.json() as { ok: false, reason: string, detail: string }

    t.assert.strictEqual(body.ok, false)
    t.assert.strictEqual(body.reason, 'invalid-arguments')
    t.assert.ok(body.detail.length > 0)
    t.assert.strictEqual(getHandlerInvocations(), 0)
  })

  test('passes the same request object to canAccessTool', async (t: TestContext) => {
    const { app, getAccessContextRequest, getDirectRouteRequest } = await buildApp(t)

    await app.inject({
      method: 'POST',
      url: '/direct-tool-call',
      payload: { name: 'echo', args: { message: 'hello' } }
    })

    t.assert.strictEqual(getAccessContextRequest(), getDirectRouteRequest())
  })

  test('mcpCallTool() invokes canAccessTool with operation call', async (t: TestContext) => {
    const { app, getAccessContextOperation } = await buildApp(t)

    await app.inject({
      method: 'POST',
      url: '/direct-tool-call',
      payload: { name: 'echo', args: { message: 'hello' } }
    })

    t.assert.strictEqual(getAccessContextOperation(), 'call')
  })

  test('matches the JSON-RPC tools/call path for success and failure outcomes', async (t: TestContext) => {
    const { app } = await buildApp(t)

    const directOk = await app.inject({
      method: 'POST',
      url: '/direct-tool-call',
      payload: { name: 'echo', args: { message: 'hello' } }
    })
    const rpcOk = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: callRequest('echo', { message: 'hello' }, 1)
    })
    t.assert.deepStrictEqual((directOk.json() as { result: CallToolResult }).result, (rpcOk.json() as JSONRPCResultResponse).result)

    const directUnknown = await app.inject({
      method: 'POST',
      url: '/direct-tool-call',
      payload: { name: 'missing', args: {} }
    })
    const rpcUnknown = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: callRequest('missing', {}, 2)
    })
    t.assert.deepStrictEqual(directUnknown.json(), { ok: false, reason: 'not-found' })
    const unknownError = (rpcUnknown.json() as JSONRPCErrorResponse).error
    t.assert.strictEqual(unknownError.code, METHOD_NOT_FOUND)
    t.assert.strictEqual(unknownError.message, "Tool 'missing' not found")

    const directDenied = await app.inject({
      method: 'POST',
      url: '/direct-tool-call',
      payload: { name: 'restricted', args: {} }
    })
    const rpcDenied = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: callRequest('restricted', {}, 3)
    })
    t.assert.deepStrictEqual(directDenied.json(), { ok: false, reason: 'not-found' })
    const deniedError = (rpcDenied.json() as JSONRPCErrorResponse).error
    t.assert.strictEqual(deniedError.code, METHOD_NOT_FOUND)
    t.assert.strictEqual(deniedError.message, "Tool 'restricted' not found")

    const directInvalid = await app.inject({
      method: 'POST',
      url: '/direct-tool-call',
      payload: { name: 'echo', args: {} }
    })
    const rpcInvalid = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: callRequest('echo', {}, 4)
    })
    const invalidOutcome = directInvalid.json() as { ok: false, reason: string, detail: string }
    const invalidResult = (rpcInvalid.json() as JSONRPCResultResponse).result as CallToolResult
    t.assert.strictEqual(invalidOutcome.reason, 'invalid-arguments')
    t.assert.deepStrictEqual(invalidResult, {
      content: [{ type: 'text', text: `Invalid tool arguments: ${invalidOutcome.detail}` }],
      isError: true
    })
  })

  test('converts thrown handler errors to isError results matching JSON-RPC', async (t: TestContext) => {
    const { app } = await buildApp(t)

    const directResponse = await app.inject({
      method: 'POST',
      url: '/direct-tool-call',
      payload: { name: 'throws', args: {} }
    })
    const rpcResponse = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: callRequest('throws', {}, 5)
    })

    const directBody = directResponse.json() as { ok: true, result: CallToolResult }
    const rpcBody = rpcResponse.json() as JSONRPCResultResponse
    t.assert.strictEqual(directBody.ok, true)
    t.assert.strictEqual(directBody.result.isError, true)
    t.assert.deepStrictEqual(directBody.result, rpcBody.result)
    t.assert.match(textFromResult(directBody.result), /kaboom/)
  })

  test('returns an isError result for tools registered without a handler', async (t: TestContext) => {
    const { app } = await buildApp(t)

    const response = await app.inject({
      method: 'POST',
      url: '/direct-tool-call',
      payload: { name: 'missing-handler', args: {} }
    })
    const body = response.json() as { ok: true, result: CallToolResult }

    t.assert.strictEqual(body.ok, true)
    t.assert.strictEqual(body.result.isError, true)
    t.assert.match(textFromResult(body.result), /no handler implementation/)
  })

  test('reports invalid arguments from the AJV JSON Schema branch', async (t: TestContext) => {
    const { app, getJsonSchemaInvocations } = await buildApp(t)

    const response = await app.inject({
      method: 'POST',
      url: '/direct-tool-call',
      payload: { name: 'json-search', args: { query: '' } }
    })
    const body = response.json() as { ok: false, reason: string, detail: string }

    t.assert.strictEqual(body.ok, false)
    t.assert.strictEqual(body.reason, 'invalid-arguments')
    t.assert.match(body.detail, /query/)
    t.assert.strictEqual(getJsonSchemaInvocations(), 0)
  })

  test('passes the active session id to the non-task JSON-RPC tools/call path', async (t: TestContext) => {
    const { app } = await buildApp(t)

    const init = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: initializeRequest()
    })
    const sessionId = init.headers['mcp-session-id'] as string | undefined
    t.assert.ok(sessionId)

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'mcp-session-id': sessionId },
      payload: callRequest('session-id', {}, 6)
    })
    const result = (response.json() as JSONRPCResultResponse).result as CallToolResult

    t.assert.strictEqual(textFromResult(result), sessionId)
  })

  test('passes the route FastifyReply to handlers invoked in-process', async (t: TestContext) => {
    const { app } = await buildApp(t)

    const response = await app.inject({
      method: 'POST',
      url: '/direct-tool-call',
      payload: { name: 'reply-aware', args: {} }
    })

    t.assert.strictEqual(response.statusCode, 209)
    t.assert.strictEqual(response.headers['x-tool-reply'], 'applied')
    t.assert.strictEqual(textFromResult((response.json() as { ok: true, result: CallToolResult }).result), 'reply ok')
  })

  test('does not execute task-required tools in-process', async (t: TestContext) => {
    const { app, getTaskOnlyInvocations } = await buildApp(t)

    const response = await app.inject({
      method: 'POST',
      url: '/direct-tool-call',
      payload: { name: 'task-only', args: {} }
    })

    t.assert.deepStrictEqual(response.json(), { ok: false, reason: 'task-required' })
    t.assert.strictEqual(getTaskOnlyInvocations(), 0)
  })

  test('passes caller-provided authContext to in-process handlers', async (t: TestContext) => {
    const { app } = await buildApp(t)

    const response = await app.inject({
      method: 'POST',
      url: '/direct-tool-call',
      payload: { name: 'auth-context', args: {}, authUserId: 'user-123' }
    })
    const body = response.json() as { ok: true, result: CallToolResult }

    t.assert.strictEqual(textFromResult(body.result), 'user-123')
  })

  test('passes caller-provided authContext scopes to canAccessTool', async (t: TestContext) => {
    const { app } = await buildApp(t)

    const deniedResponse = await app.inject({
      method: 'POST',
      url: '/direct-tool-call',
      payload: { name: 'wallet-summary', args: {}, authScopes: ['profile:read'] }
    })
    t.assert.deepStrictEqual(deniedResponse.json(), { ok: false, reason: 'not-found' })

    const allowedResponse = await app.inject({
      method: 'POST',
      url: '/direct-tool-call',
      payload: { name: 'wallet-summary', args: {}, authScopes: ['wallet-summary:read'] }
    })
    const body = allowedResponse.json() as { ok: true, result: CallToolResult }

    t.assert.strictEqual(body.ok, true)
    t.assert.strictEqual(textFromResult(body.result), 'wallet ok')
  })

  test('ignores casted context opts/tools overrides for in-process calls', async (t: TestContext) => {
    const { app } = await buildApp(t)

    const deniedResponse = await app.inject({
      method: 'POST',
      url: '/direct-tool-call',
      payload: { name: 'restricted', args: {}, spoofContextOverrides: true }
    })
    t.assert.deepStrictEqual(deniedResponse.json(), { ok: false, reason: 'not-found' })

    const allowedResponse = await app.inject({
      method: 'POST',
      url: '/direct-tool-call',
      payload: { name: 'echo', args: { message: 'hello' }, spoofContextOverrides: true }
    })
    t.assert.deepStrictEqual(allowedResponse.json(), {
      ok: true,
      result: { content: [{ type: 'text', text: 'hello' }] }
    })
  })
})
