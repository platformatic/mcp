import type { TracerLike } from './types.ts'
import { MCP_ATTR, type SpanAttributeValue } from './telemetry-constants.ts'

export { MCP_ATTR, buildSpanAttributes } from './telemetry-constants.ts'

let _otel: typeof import('@opentelemetry/api') | undefined

export interface WithSpanOptions {
  kind?: 'internal' | 'server' | 'client'
  /** MCP `params._meta` carrier used to extract the remote MCP parent context. */
  carrier?: Record<string, string | string[]>
  /** Add JSON-RPC response status/error attributes defined by the MCP conventions. */
  recordMcpResponse?: boolean
}

function isJsonRpcError (value: unknown): value is { error: { code: number, message?: string } } {
  return typeof value === 'object' && value !== null &&
    'error' in value && typeof value.error === 'object' && value.error !== null &&
    'code' in value.error && typeof value.error.code === 'number'
}

function isToolError (value: unknown): boolean {
  if (typeof value !== 'object' || value === null || !('result' in value)) return false
  const result = value.result
  return typeof result === 'object' && result !== null && 'isError' in result && result.isError === true
}

const NON_ERROR_JSONRPC_CODES = new Set([-32700, -32600, -32601, -32602, -32002])

function recordMcpResponse (span: any, result: unknown, SpanStatusCode: typeof import('@opentelemetry/api').SpanStatusCode): void {
  if (isJsonRpcError(result)) {
    const code = String(result.error.code)
    span.setAttribute(MCP_ATTR.RPC_RESPONSE_STATUS_CODE, code)
    if (!NON_ERROR_JSONRPC_CODES.has(result.error.code)) {
      span.setAttribute(MCP_ATTR.ERROR_TYPE, code)
      span.setStatus({ code: SpanStatusCode.ERROR, message: result.error.message })
    }
    return
  }

  if (isToolError(result)) {
    span.setAttribute(MCP_ATTR.ERROR_TYPE, 'tool_error')
    span.setStatus({ code: SpanStatusCode.ERROR })
  }
}

function spanKind (
  kind: WithSpanOptions['kind'],
  SpanKind: typeof import('@opentelemetry/api').SpanKind
): number {
  if (kind === 'server') return SpanKind.SERVER
  if (kind === 'client') return SpanKind.CLIENT
  return SpanKind.INTERNAL
}

/**
 * Wraps `fn` in an active OTel span. If no tracer is provided, calls fn directly.
 * `@opentelemetry/api` is loaded dynamically so it is never required at runtime
 * for users who don't configure telemetry.
 */
export async function withSpan<T> (
  tracer: TracerLike | undefined,
  spanName: string,
  attributes: Record<string, SpanAttributeValue>,
  fn: () => Promise<T>,
  options: WithSpanOptions = {}
): Promise<T> {
  if (!tracer) return fn()

  _otel ??= await import('@opentelemetry/api')
  const otel = _otel
  const ambientContext = otel.context.active()
  let parentContext = ambientContext
  const links: Array<{ context: any }> = []

  if (options.carrier && Object.keys(options.carrier).length > 0) {
    const extractedContext = otel.propagation.extract(ambientContext, options.carrier)
    const extractedSpanContext = otel.trace.getSpanContext(extractedContext)
    if (extractedSpanContext && otel.isSpanContextValid(extractedSpanContext)) {
      const ambientSpanContext = otel.trace.getSpanContext(ambientContext)
      if (ambientSpanContext && otel.isSpanContextValid(ambientSpanContext) &&
          (ambientSpanContext.traceId !== extractedSpanContext.traceId || ambientSpanContext.spanId !== extractedSpanContext.spanId)) {
        links.push({ context: ambientSpanContext })
      }
      parentContext = extractedContext
    }
  }

  const spanOptions = {
    attributes,
    kind: spanKind(options.kind, otel.SpanKind),
    ...(links.length > 0 ? { links } : {})
  }

  return tracer.startActiveSpan(spanName, spanOptions, parentContext, async (span: any) => {
    try {
      const result = await fn()
      if (options.recordMcpResponse) recordMcpResponse(span, result, otel.SpanStatusCode)
      return result
    } catch (err: any) {
      span.recordException(err)
      span.setAttribute(MCP_ATTR.ERROR_TYPE, err?.name ?? '_OTHER')
      span.setStatus({ code: otel.SpanStatusCode.ERROR, message: err?.message ?? String(err) })
      throw err
    } finally {
      span.end()
    }
  })
}
