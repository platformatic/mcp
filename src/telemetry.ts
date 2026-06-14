import type { TracerLike } from './types.ts'

export { MCP_ATTR, buildSpanAttributes } from './telemetry-constants.ts'

// SpanStatusCode cached after first withSpan call — not re-imported per invocation
let _SpanStatusCode: typeof import('@opentelemetry/api').SpanStatusCode | undefined

/**
 * Wraps `fn` in an active OTel span. If no tracer is provided, calls fn directly.
 * `@opentelemetry/api` is loaded dynamically so it is never required at runtime
 * for users who don't configure telemetry.
 */
export async function withSpan<T> (
  tracer: TracerLike | undefined,
  spanName: string,
  attributes: Record<string, string>,
  fn: () => Promise<T>
): Promise<T> {
  if (!tracer) return fn()

  if (!_SpanStatusCode) {
    const otel = await import('@opentelemetry/api')
    _SpanStatusCode = otel.SpanStatusCode
  }
  const SpanStatusCode = _SpanStatusCode

  return tracer.startActiveSpan(spanName, { attributes }, async (span: any) => {
    try {
      const result = await fn()
      span.setStatus({ code: SpanStatusCode.OK })
      return result
    } catch (err: any) {
      span.recordException(err)
      span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message ?? String(err) })
      throw err
    } finally {
      span.end()
    }
  })
}
