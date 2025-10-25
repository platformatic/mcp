import { test, describe } from 'node:test'
import type { TestContext } from 'node:test'
import Fastify from 'fastify'
import mcpPlugin from '../src/index.ts'
import type { JSONRPCRequest, JSONRPCResponse, CallToolResult } from '../src/schema.ts'
import { JSONRPC_VERSION } from '../src/schema.ts'
import { Type } from '@sinclair/typebox'

describe('Hook Integration', () => {
  test('global before hook should short-circuit tool execution', async (t: TestContext) => {
    const app = Fastify({ logger: false })
    t.after(() => app.close())

    let globalBeforeCalled = 0
    let localBeforeCalled = 0
    let handlerCalled = 0

    await app.register(mcpPlugin, {
      hooks: {
        toolBeforeHandler: () => {
          globalBeforeCalled++
          return {
            content: [{ type: 'text', text: 'blocked by global hook' }],
            isError: true
          }
        }
      }
    })

    // Define a tool that would be blocked by the global hook
    app.mcpAddTool({
      name: 'sample',
      description: 'sample tool',
      inputSchema: Type.Object({}),
      hooks: {
        beforeHandler: () => { localBeforeCalled++ }
      }
    }, async () => {
      handlerCalled++
      return { content: [{ type: 'text', text: 'ok' }] }
    })

    await app.ready()

    const request: JSONRPCRequest = {
      jsonrpc: JSONRPC_VERSION,
      id: 1,
      method: 'tools/call',
      params: { name: 'sample', arguments: {} }
    }

    const response = await app.inject({ method: 'POST', url: '/mcp', payload: request })

    t.assert.strictEqual(response.statusCode, 200)
    const body = response.json() as JSONRPCResponse
    const result = body.result as CallToolResult

    // Assert the hook short-circuited the handler
    t.assert.strictEqual(globalBeforeCalled, 1)
    t.assert.strictEqual(localBeforeCalled, 0, 'Local before hook should not run when global short-circuits')
    t.assert.strictEqual(handlerCalled, 0, 'Handler should not be called when global short-circuits')

    const textContent = result.content[0] as { type: 'text', text: string }
    t.assert.strictEqual(textContent.text, 'blocked by global hook')
    t.assert.strictEqual(result.isError, true)
  })

  test('local before hook should short-circuit when global allows execution', async (t: TestContext) => {
    const app = Fastify({ logger: false })
    t.after(() => app.close())

    let globalBeforeCalled = 0
    let localBeforeCalled = 0
    let handlerCalled = 0

    await app.register(mcpPlugin, {
      hooks: {
        toolBeforeHandler: () => { globalBeforeCalled++ /* allow */ }
      }
    })

    app.mcpAddTool({
      name: 'sample-local',
      description: 'sample tool with local before',
      inputSchema: Type.Object({}),
      hooks: {
        beforeHandler: () => {
          localBeforeCalled++
          return {
            content: [{ type: 'text', text: 'blocked by local hook' }],
            isError: true
          }
        }
      }
    }, async () => {
      handlerCalled++
      return { content: [{ type: 'text', text: 'ok' }] }
    })

    await app.ready()

    const request: JSONRPCRequest = {
      jsonrpc: JSONRPC_VERSION,
      id: 1,
      method: 'tools/call',
      params: { name: 'sample-local', arguments: {} }
    }

    const response = await app.inject({ method: 'POST', url: '/mcp', payload: request })

    t.assert.strictEqual(response.statusCode, 200)
    const body = response.json() as JSONRPCResponse
    const result = body.result as CallToolResult

    t.assert.strictEqual(globalBeforeCalled, 1)
    t.assert.strictEqual(localBeforeCalled, 1)
    t.assert.strictEqual(handlerCalled, 0, 'Handler should not be called when local short-circuits')

    const textContent = result.content[0] as { type: 'text', text: string }
    t.assert.strictEqual(textContent.text, 'blocked by local hook')
    t.assert.strictEqual(result.isError, true)
  })

  test('ordering: global before runs before local, then handler when both return void', async (t: TestContext) => {
    const app = Fastify({ logger: false })
    t.after(() => app.close())

    const calls: string[] = []

    await app.register(mcpPlugin, {
      hooks: {
        toolBeforeHandler: () => { calls.push('global') }
      }
    })

    app.mcpAddTool({
      name: 'ordered',
      description: 'ordering test',
      inputSchema: Type.Object({}),
      hooks: {
        beforeHandler: () => { calls.push('local') }
      }
    }, async () => {
      calls.push('handler')
      return { content: [{ type: 'text', text: 'ok' }] }
    })

    await app.ready()

    const request: JSONRPCRequest = {
      jsonrpc: JSONRPC_VERSION,
      id: 1,
      method: 'tools/call',
      params: { name: 'ordered', arguments: {} }
    }

    const response = await app.inject({ method: 'POST', url: '/mcp', payload: request })

    t.assert.strictEqual(response.statusCode, 200)
    const body = response.json() as JSONRPCResponse
    const result = body.result as CallToolResult

    const textContent = result.content[0] as { type: 'text', text: string }
    t.assert.strictEqual(textContent.text, 'ok')

    t.assert.deepStrictEqual(calls, ['global', 'local', 'handler'])
  })

  test('global before hook error should be returned as CallToolResult isError=true', async (t: TestContext) => {
    const app = Fastify({ logger: false })
    t.after(() => app.close())

    await app.register(mcpPlugin, {
      hooks: {
        toolBeforeHandler: () => {
          throw new Error('boom')
        }
      }
    })

    app.mcpAddTool({
      name: 'will-not-run',
      description: 'error propagation test',
      inputSchema: Type.Object({})
    }, async () => {
      return { content: [{ type: 'text', text: 'should not run' }] }
    })

    await app.ready()

    const request: JSONRPCRequest = {
      jsonrpc: JSONRPC_VERSION,
      id: 1,
      method: 'tools/call',
      params: { name: 'will-not-run', arguments: {} }
    }

    const response = await app.inject({ method: 'POST', url: '/mcp', payload: request })

    t.assert.strictEqual(response.statusCode, 200)
    const body = response.json() as JSONRPCResponse
    const result = body.result as CallToolResult

    const textContent = result.content[0] as { type: 'text', text: string }
    t.assert.ok(textContent.text.includes('Tool execution failed:'))
    t.assert.ok(textContent.text.includes('boom'))
    t.assert.strictEqual(result.isError, true)
  })

  test('hook receives request/reply in context', async (t: TestContext) => {
    const app = Fastify({ logger: false })
    t.after(() => app.close())

    let seenInGlobal: any = null
    let seenInLocal: any = null

    await app.register(mcpPlugin, {
      hooks: {
        toolBeforeHandler: (ctx) => {
          seenInGlobal = { hasRequest: !!ctx.request, hasReply: !!ctx.reply }
        }
      }
    })

    app.mcpAddTool({
      name: 'ctx-check',
      description: 'context check',
      inputSchema: Type.Object({}),
      hooks: {
        beforeHandler: (ctx) => {
          seenInLocal = { url: ctx.request.url, header: ctx.request.headers['x-test'] as string | undefined }
        }
      }
    }, async () => {
      return { content: [{ type: 'text', text: 'ok' }] }
    })

    await app.ready()

    const request: JSONRPCRequest = {
      jsonrpc: JSONRPC_VERSION,
      id: 1,
      method: 'tools/call',
      params: { name: 'ctx-check', arguments: {} }
    }

    const response = await app.inject({
      method: 'POST',
      url: '/mcp?x=1',
      payload: request,
      headers: { 'x-test': 'value' }
    })

    t.assert.strictEqual(response.statusCode, 200)
    const body = response.json() as JSONRPCResponse
    const result = body.result as CallToolResult
    const textContent = result.content[0] as { type: 'text', text: string }
    t.assert.strictEqual(textContent.text, 'ok')

    t.assert.ok(seenInGlobal)
    t.assert.strictEqual(seenInGlobal?.hasRequest, true)
    t.assert.strictEqual(seenInGlobal?.hasReply, true)

    t.assert.ok(seenInLocal)
    t.assert.ok(seenInLocal?.url.includes('/mcp?x=1'))
    t.assert.strictEqual(seenInLocal?.header, 'value')
  })
})
