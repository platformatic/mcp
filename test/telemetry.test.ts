import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { withSpan, buildSpanAttributes, MCP_ATTR } from '../src/telemetry.ts'
import type { Tracer, Span } from '@opentelemetry/api'
import { SpanStatusCode } from '@opentelemetry/api'

function makeSpan (): Span & {
  setStatus: ReturnType<typeof mock.fn>
  recordException: ReturnType<typeof mock.fn>
  end: ReturnType<typeof mock.fn>
} {
  return {
    setAttribute: mock.fn(),
    setStatus: mock.fn(),
    recordException: mock.fn(),
    end: mock.fn()
  } as unknown as any
}

function makeTracer (span: Span): Tracer {
  return {
    startActiveSpan: (_name: string, _opts: any, fn: (s: Span) => any) => fn(span)
  } as unknown as Tracer
}

describe('withSpan', () => {
  it('calls fn and returns result when tracer provided', async () => {
    const span = makeSpan()
    const tracer = makeTracer(span)

    const result = await withSpan(tracer, 'tools/call', { 'mcp.method.name': 'tools/call' }, async () => 42)

    assert.equal(result, 42)
    assert.equal(span.end.mock.calls.length, 1)
    assert.equal((span.setStatus.mock.calls[0].arguments[0] as any).code, SpanStatusCode.OK)
  })

  it('records exception and rethrows on error', async () => {
    const span = makeSpan()
    const tracer = makeTracer(span)
    const err = new Error('boom')

    await assert.rejects(
      withSpan(tracer, 'tools/call', {}, async () => { throw err }),
      /boom/
    )

    assert.equal(span.recordException.mock.calls.length, 1)
    assert.equal(span.recordException.mock.calls[0].arguments[0], err)
    assert.equal((span.setStatus.mock.calls[0].arguments[0] as any).code, SpanStatusCode.ERROR)
    assert.equal(span.end.mock.calls.length, 1)
  })

  it('calls fn directly when no tracer', async () => {
    const result = await withSpan(undefined, 'tools/call', {}, async () => 'direct')
    assert.equal(result, 'direct')
  })
})

describe('buildSpanAttributes', () => {
  it('includes method name', () => {
    const attrs = buildSpanAttributes('tools/call')
    assert.equal(attrs[MCP_ATTR.METHOD_NAME], 'tools/call')
  })

  it('includes sessionId when provided', () => {
    const attrs = buildSpanAttributes('tools/call', 'sess-123')
    assert.equal(attrs[MCP_ATTR.SESSION_ID], 'sess-123')
  })

  it('omits sessionId when not provided', () => {
    const attrs = buildSpanAttributes('tools/call')
    assert.equal(attrs[MCP_ATTR.SESSION_ID], undefined)
  })

  it('merges extra attributes', () => {
    const attrs = buildSpanAttributes('tools/call', undefined, { [MCP_ATTR.TOOL_NAME]: 'myTool' })
    assert.equal(attrs[MCP_ATTR.TOOL_NAME], 'myTool')
  })
})

describe('MCP_ATTR', () => {
  it('has expected attribute keys', () => {
    assert.equal(MCP_ATTR.METHOD_NAME, 'mcp.method.name')
    assert.equal(MCP_ATTR.SESSION_ID, 'mcp.session.id')
    assert.equal(MCP_ATTR.PROTOCOL_VERSION, 'mcp.protocol.version')
    assert.equal(MCP_ATTR.RESOURCE_URI, 'mcp.resource.uri')
    assert.equal(MCP_ATTR.TOOL_NAME, 'mcp.tool.name')
    assert.equal(MCP_ATTR.PROMPT_NAME, 'mcp.prompt.name')
  })
})
