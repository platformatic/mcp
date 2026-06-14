/**
 * MCP semantic convention attribute keys.
 * Source: https://opentelemetry.io/docs/specs/semconv/registry/attributes/mcp/
 *
 * Kept in a separate module with no @opentelemetry/api dependency so they can be
 * imported statically by any module without pulling in OTel at runtime.
 *
 * Why inlined instead of imported from `@opentelemetry/semantic-conventions`:
 *   - As of @opentelemetry/semantic-conventions 1.40.0, only METHOD_NAME,
 *     PROTOCOL_VERSION, RESOURCE_URI, and SESSION_ID are exported. TOOL_NAME and
 *     PROMPT_NAME are in the MCP spec but not yet in the JS semconv package,
 *     so mixing would force a partial import + hardcoded strings anyway.
 *   - MCP attrs live under `/experimental` in the semconv package. That export
 *     path is explicitly unstable — coupling to it would trade a stable set of
 *     six local strings for a drift risk on every semconv release.
 *   - These keys are stable in the MCP spec itself (the source of truth the
 *     semconv package tracks), so local drift is minimal.
 * Revisit once all six attrs are exported from a stable semconv path.
 */
export const MCP_ATTR = {
  METHOD_NAME: 'mcp.method.name',
  SESSION_ID: 'mcp.session.id',
  PROTOCOL_VERSION: 'mcp.protocol.version',
  RESOURCE_URI: 'mcp.resource.uri',
  TOOL_NAME: 'mcp.tool.name',
  PROMPT_NAME: 'mcp.prompt.name'
} as const

/**
 * Build span attributes for an MCP operation using semconv keys.
 */
export function buildSpanAttributes (
  methodName: string,
  sessionId?: string,
  extra?: Record<string, string>
): Record<string, string> {
  return {
    [MCP_ATTR.METHOD_NAME]: methodName,
    ...(sessionId ? { [MCP_ATTR.SESSION_ID]: sessionId } : {}),
    ...extra
  }
}
