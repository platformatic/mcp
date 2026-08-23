/**
 * MCP semantic convention attribute keys.
 * Source: https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/mcp.md
 *
 * Kept in a separate module with no @opentelemetry/api dependency so they can be
 * imported statically by any module without pulling in OTel at runtime.
 *
 * MCP conventions are still in development. The stable JS semantic-conventions
 * entry point does not export them, and the package recommends copying unstable
 * definitions into instrumentation libraries instead of importing its incubating
 * entry point. Keep this small local set aligned with the GenAI conventions repo.
 */
export const MCP_ATTR = {
  ERROR_TYPE: 'error.type',
  JSONRPC_REQUEST_ID: 'jsonrpc.request.id',
  METHOD_NAME: 'mcp.method.name',
  SESSION_ID: 'mcp.session.id',
  PROTOCOL_VERSION: 'mcp.protocol.version',
  RESOURCE_URI: 'mcp.resource.uri',
  RPC_RESPONSE_STATUS_CODE: 'rpc.response.status_code',
  CLIENT_ADDRESS: 'client.address',
  CLIENT_PORT: 'client.port',
  NETWORK_PROTOCOL_NAME: 'network.protocol.name',
  NETWORK_PROTOCOL_VERSION: 'network.protocol.version',
  NETWORK_TRANSPORT: 'network.transport',
  OPERATION_NAME: 'gen_ai.operation.name',
  TOOL_NAME: 'gen_ai.tool.name',
  PROMPT_NAME: 'gen_ai.prompt.name'
} as const

export type SpanAttributeValue = string | number | boolean

/**
 * Build span attributes for an MCP operation using semconv keys.
 */
export function buildSpanAttributes (
  methodName: string,
  sessionId?: string,
  extra?: Record<string, SpanAttributeValue>
): Record<string, SpanAttributeValue> {
  return {
    [MCP_ATTR.METHOD_NAME]: methodName,
    ...(sessionId ? { [MCP_ATTR.SESSION_ID]: sessionId } : {}),
    ...extra
  }
}
