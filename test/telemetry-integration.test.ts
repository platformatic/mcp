import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import type { Tracer, Span } from '@opentelemetry/api'
import mcpPlugin from '../src/index.ts'
import { MCP_ATTR } from '../src/telemetry.ts'

function makeSpan (): Span & { end: ReturnType<typeof mock.fn>, setStatus: ReturnType<typeof mock.fn>, recordException: ReturnType<typeof mock.fn> } {
  return {
    setAttribute: mock.fn(),
    setStatus: mock.fn(),
    recordException: mock.fn(),
    end: mock.fn()
  } as unknown as any
}

function makeTracer (): { tracer: Tracer, spans: Span[], spanNames: string[], spanAttrs: Record<string, unknown>[] } {
  const spans: Span[] = []
  const spanNames: string[] = []
  const spanAttrs: Record<string, unknown>[] = []

  const tracer: Tracer = {
    startActiveSpan (name: string, opts: any, fn: (s: Span) => any) {
      spanNames.push(name)
      spanAttrs.push(opts?.attributes ?? {})
      const span = makeSpan()
      spans.push(span)
      return fn(span)
    }
  } as unknown as Tracer

  return { tracer, spans, spanNames, spanAttrs }
}

async function buildApp (tracer: Tracer) {
  const app = Fastify({ logger: false })
  await app.register(mcpPlugin, {
    telemetry: { tracer },
    capabilities: { tools: {}, resources: {}, prompts: {} }
  })

  app.mcpAddTool(
    { name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: { msg: { type: 'string' } } } },
    async ({ msg }: any) => ({ content: [{ type: 'text' as const, text: msg }] })
  )

  await app.ready()
  return app
}

describe('telemetry integration', () => {
  describe('tools/call', () => {
    it('creates a span with mcp.tool.name attribute', async () => {
      const { tracer, spanNames, spanAttrs, spans } = makeTracer()
      const app = await buildApp(tracer)

      const res = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { 'content-type': 'application/json' },
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: { msg: 'hi' } } }
      })

      assert.equal(res.statusCode, 200)
      assert.ok(spanNames.includes('tools/call'), `expected tools/call span, got: ${spanNames}`)
      const idx = spanNames.indexOf('tools/call')
      assert.equal(spanAttrs[idx][MCP_ATTR.METHOD_NAME], 'tools/call')
      assert.equal(spanAttrs[idx][MCP_ATTR.TOOL_NAME], 'echo')
      assert.equal((spans[idx] as any).end.mock.calls.length, 1)

      await app.close()
    })
  })

  describe('tools/list', () => {
    it('creates a span with mcp.method.name attribute', async () => {
      const { tracer, spanNames, spanAttrs, spans } = makeTracer()
      const app = await buildApp(tracer)

      await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { 'content-type': 'application/json' },
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }
      })

      assert.ok(spanNames.includes('tools/list'), `expected tools/list span, got: ${spanNames}`)
      const idx = spanNames.indexOf('tools/list')
      assert.equal(spanAttrs[idx][MCP_ATTR.METHOD_NAME], 'tools/list')
      assert.equal((spans[idx] as any).end.mock.calls.length, 1)

      await app.close()
    })
  })

  describe('no tracer', () => {
    it('processes requests normally without a tracer', async () => {
      const app = Fastify({ logger: false })
      await app.register(mcpPlugin, {
        capabilities: { tools: {}, resources: {}, prompts: {} }
      })
      await app.ready()

      const res = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { 'content-type': 'application/json' },
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }
      })

      assert.equal(res.statusCode, 200)
      await app.close()
    })
  })
})
