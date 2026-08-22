import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { withSpan, buildSpanAttributes, MCP_ATTR } from '../src/telemetry.ts'
import type { Tracer, Span } from '@opentelemetry/api'
import { SpanKind, SpanStatusCode } from '@opentelemetry/api'

function makeSpan (): Span & {
  setAttribute: ReturnType<typeof mock.fn>
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

function makeTracer (span: Span, options?: any[]): Tracer {
  return {
    startActiveSpan: (_name: string, opts: any, ...args: any[]) => {
      options?.push(opts)
      const fn = args.at(-1) as (s: Span) => any
      return fn(span)
    }
  } as unknown as Tracer
}

describe('withSpan', () => {
  it('calls fn and returns result when tracer provided', async () => {
    const span = makeSpan()
    const options: any[] = []
    const tracer = makeTracer(span, options)

    const result = await withSpan(
      tracer,
      'tools/call',
      { 'mcp.method.name': 'tools/call' },
      async () => 42,
      { kind: 'server' }
    )

    assert.equal(result, 42)
    assert.equal(span.end.mock.calls.length, 1)
    assert.equal(span.setStatus.mock.calls.length, 0)
    assert.equal(options[0].kind, SpanKind.SERVER)
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

  it('records JSON-RPC response errors without marking caller errors as span errors', async () => {
    const span = makeSpan()
    const tracer = makeTracer(span)

    await withSpan(
      tracer,
      'tools/call',
      {},
      async () => ({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Invalid params' } }),
      { recordMcpResponse: true }
    )

    assert.deepEqual(span.setAttribute.mock.calls[0].arguments, [MCP_ATTR.RPC_RESPONSE_STATUS_CODE, '-32602'])
    assert.equal(span.setStatus.mock.calls.length, 0)
  })

  it('marks tool errors as span errors', async () => {
    const span = makeSpan()
    const tracer = makeTracer(span)

    await withSpan(
      tracer,
      'tools/call',
      {},
      async () => ({ jsonrpc: '2.0', id: 1, result: { isError: true } }),
      { recordMcpResponse: true }
    )

    assert.deepEqual(span.setAttribute.mock.calls[0].arguments, [MCP_ATTR.ERROR_TYPE, 'tool_error'])
    assert.equal((span.setStatus.mock.calls[0].arguments[0] as any).code, SpanStatusCode.ERROR)
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
    assert.equal(MCP_ATTR.JSONRPC_REQUEST_ID, 'jsonrpc.request.id')
    assert.equal(MCP_ATTR.SESSION_ID, 'mcp.session.id')
    assert.equal(MCP_ATTR.PROTOCOL_VERSION, 'mcp.protocol.version')
    assert.equal(MCP_ATTR.RESOURCE_URI, 'mcp.resource.uri')
    assert.equal(MCP_ATTR.RPC_RESPONSE_STATUS_CODE, 'rpc.response.status_code')
    assert.equal(MCP_ATTR.NETWORK_TRANSPORT, 'network.transport')
    assert.equal(MCP_ATTR.OPERATION_NAME, 'gen_ai.operation.name')
    assert.equal(MCP_ATTR.TOOL_NAME, 'gen_ai.tool.name')
    assert.equal(MCP_ATTR.PROMPT_NAME, 'gen_ai.prompt.name')
  })
})
