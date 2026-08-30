import type { FastifyInstance } from 'fastify'
import createFastifyError from 'fastify-error'
import type {
  Implementation,
  JSONRPCNotification,
  Tool,
  JSONRPCRequest,
  JSONRPCResponse
} from './schema.ts'
import {
  JSONRPC_VERSION,
  LATEST_LEGACY_PROTOCOL_VERSION,
  MODERN_PROTOCOL_VERSIONS
} from './schema.ts'
import {
  META_CLIENT_CAPABILITIES,
  META_CLIENT_INFO,
  META_PROTOCOL_VERSION
} from './schema-2026.ts'
import { collectHeaderParams, encodeHeaderValue, expectedNameFor } from './modern/headers.ts'
import type { InputResponses } from './schema-2026.ts'

const DEFAULT_ENDPOINT = '/mcp'
const DEFAULT_STARTING_REQUEST_ID = 1
const DEFAULT_ACCEPT_HEADER = 'application/json, text/event-stream'
const DEFAULT_CLIENT_INFO: Implementation = {
  name: '@platformatic/mcp-client',
  version: '1.0.0'
}
const JSON_PARSE_ERROR_PAYLOAD_LIMIT = 600
const InvalidJsonResponseError = createFastifyError(
  'MCP_ERR_INVALID_JSON_RESPONSE',
  'Failed to parse JSON response from MCP client request (status %s): %s; payload=%s'
)
const InvalidNotificationAcceptanceError = createFastifyError(
  'MCP_ERR_INVALID_NOTIFICATION_ACCEPTANCE',
  'MCP %s notification failed: expected an empty 202 or 204 response, received status %s; payload=%s'
)
const InvalidMcpErrorMessageError = createFastifyError(
  'MCP_ERR_INVALID_ERROR_MESSAGE',
  'Expected error.message to be a string'
)
const InvalidMcpJsonrpcVersionError = createFastifyError(
  'MCP_ERR_INVALID_JSONRPC_VERSION',
  `Expected jsonrpc to be '${JSONRPC_VERSION}'`
)
const MissingMcpResultError = createFastifyError(
  'MCP_ERR_MISSING_RESULT',
  'Expected JSON-RPC success response to include result'
)
const UnexpectedMcpResultErrorFieldError = createFastifyError(
  'MCP_ERR_UNEXPECTED_RESULT_ERROR',
  'Expected JSON-RPC success response not to include error'
)
const InvalidMcpErrorResponseObjectError = createFastifyError(
  'MCP_ERR_INVALID_ERROR_RESPONSE_OBJECT',
  'Expected JSON-RPC error response object, got %s'
)
const InvalidMcpErrorObjectError = createFastifyError(
  'MCP_ERR_INVALID_ERROR_OBJECT',
  'Expected error to be an object'
)
const InvalidMcpErrorCodeError = createFastifyError(
  'MCP_ERR_INVALID_ERROR_CODE',
  'Expected error.code to be a number'
)
const ModernInitializeError = createFastifyError(
  'MCP_ERR_MODERN_INITIALIZE',
  "Protocol version '%s' is stateless and does not support initialize; call methods directly or use discover()"
)

export interface McpClientOptions {
  endpoint?: string
  headers?: Record<string, string>
  protocolVersion?: string | null
  startingRequestId?: number
  /** Identity sent in modern per-request metadata. */
  clientInfo?: Implementation
  /** Capabilities sent in modern per-request metadata. */
  clientCapabilities?: Record<string, unknown>
}

export interface McpClientRequestOptions {
  headers?: Record<string, string>
  protocolVersion?: string | null
  id?: string | number
}

export interface McpClientCallToolOptions extends McpClientRequestOptions {
  /** Opaque state returned by a modern input_required result. */
  requestState?: string
  /** Client answers supplied when retrying a modern multi round-trip call. */
  inputResponses?: InputResponses
}

export interface McpClientResponse<TBody = JSONRPCResponse> {
  statusCode: number
  headers: Record<string, string | string[] | undefined>
  body: TBody
  payload: string
}

export interface McpClientInitializeOptions {
  clientInfo?: {
    name: string
    version: string
  }
  capabilities?: Record<string, unknown>
  protocolVersion?: string | null
  headers?: Record<string, string>
  id?: string | number
}

export interface McpClient {
  readonly sessionId: string | undefined

  initialize(options?: McpClientInitializeOptions): Promise<McpClientResponse>

  discover(options?: McpClientRequestOptions): Promise<McpClientResponse>

  listTools(options?: McpClientRequestOptions & {
    cursor?: string
  }): Promise<McpClientResponse>

  callTool(
    name: string,
    args?: Record<string, unknown>,
    options?: McpClientCallToolOptions
  ): Promise<McpClientResponse>
}

interface SendOptions extends McpClientRequestOptions {
  expectJsonResponse?: boolean
  sessionId?: string | null
}

function truncateForError (payload: string): string {
  if (payload.length <= JSON_PARSE_ERROR_PAYLOAD_LIMIT) {
    return payload
  }

  return `${payload.slice(0, JSON_PARSE_ERROR_PAYLOAD_LIMIT)}... [truncated ${payload.length - JSON_PARSE_ERROR_PAYLOAD_LIMIT} chars]`
}

function parseJsonBody (payload: string, statusCode: number): unknown {
  try {
    return JSON.parse(payload)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new InvalidJsonResponseError(
      statusCode,
      message,
      truncateForError(payload)
    )
  }
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function hasOwn (value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function describeValue (value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function assertMcpResponse (body: unknown): asserts body is JSONRPCResponse {
  if (!isRecord(body)) {
    throw new InvalidMcpErrorResponseObjectError(describeValue(body))
  }

  if (body.jsonrpc !== JSONRPC_VERSION) {
    throw new InvalidMcpJsonrpcVersionError()
  }

  if (hasOwn(body, 'result') && hasOwn(body, 'error')) {
    throw new UnexpectedMcpResultErrorFieldError()
  }

  if (hasOwn(body, 'result')) {
    return
  }

  if (!hasOwn(body, 'error')) {
    throw new MissingMcpResultError()
  }

  const errorValue = body.error
  if (!isRecord(errorValue)) {
    throw new InvalidMcpErrorObjectError()
  }

  if (typeof errorValue.code !== 'number') {
    throw new InvalidMcpErrorCodeError()
  }

  if (typeof errorValue.message !== 'string') {
    throw new InvalidMcpErrorMessageError()
  }
}

function isInitializeSuccessResponse (body: unknown): body is {
  result: {
    protocolVersion?: unknown
  }
} {
  if (!isRecord(body)) {
    return false
  }

  return hasOwn(body, 'result') && !hasOwn(body, 'error')
}

function getHeaderValue (headers: Record<string, string | string[] | undefined>, key: string): string | undefined {
  const value = headers[key]
  if (Array.isArray(value)) {
    return value[0]
  }
  return value
}

function omitManagedMcpHeaders (
  headers: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!headers) {
    return undefined
  }

  const forwardedHeaders: Record<string, string> = {}

  for (const [name, value] of Object.entries(headers)) {
    const normalizedName = name.toLowerCase()

    if (
      normalizedName === 'mcp-session-id' ||
      normalizedName === 'mcp-protocol-version'
    ) {
      continue
    }

    forwardedHeaders[name] = value
  }

  return forwardedHeaders
}

function assertNotificationAccepted (
  response: McpClientResponse<unknown>,
  method: string
): void {
  const acceptedStatus =
    response.statusCode === 202 ||
    response.statusCode === 204

  if (!acceptedStatus || response.payload.trim() !== '') {
    throw new InvalidNotificationAcceptanceError(
      method,
      response.statusCode,
      truncateForError(response.payload)
    )
  }
}

function normalizeResponseHeaders (
  headers: Record<string, unknown>
): Record<string, string | string[] | undefined> {
  const normalized: Record<string, string | string[] | undefined> = {}

  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      normalized[key] = undefined
      continue
    }
    if (typeof value === 'string') {
      normalized[key] = value
      continue
    }
    if (Array.isArray(value)) {
      normalized[key] = value.map(item => String(item))
      continue
    }
    normalized[key] = String(value)
  }

  return normalized
}

function getPayloadProtocolVersion (
  configuredProtocolVersion: string | null,
  requestProtocolVersion: string | null | undefined
): string {
  if (requestProtocolVersion === undefined) {
    return configuredProtocolVersion ?? LATEST_LEGACY_PROTOCOL_VERSION
  }

  if (requestProtocolVersion === null) {
    return LATEST_LEGACY_PROTOCOL_VERSION
  }

  return requestProtocolVersion
}

function isModernProtocolVersion (protocolVersion: string | null): protocolVersion is string {
  return protocolVersion !== null &&
    (MODERN_PROTOCOL_VERSIONS as readonly string[]).includes(protocolVersion)
}

function valueAtPath (root: unknown, path: string[]): unknown {
  let current = root
  for (const segment of path) {
    if (!isRecord(current) || Array.isArray(current)) return undefined
    current = current[segment]
  }
  return current
}

function toolParamHeaders (inputSchema: unknown, args: Record<string, unknown>): Record<string, string> {
  const collected = collectHeaderParams(inputSchema)
  if (!collected.ok) return {}

  const headers: Record<string, string> = {}
  for (const [name, path] of collected.params) {
    const value = valueAtPath(args, path)
    if (value !== undefined && value !== null) {
      headers[`mcp-param-${name}`] = encodeHeaderValue(String(value))
    }
  }
  return headers
}

function withModernMetadata (
  request: JSONRPCRequest | JSONRPCNotification,
  protocolVersion: string,
  clientInfo: Implementation,
  clientCapabilities: Record<string, unknown>
): JSONRPCRequest | JSONRPCNotification {
  const params = isRecord(request.params) ? request.params : {}
  const currentMeta = isRecord(params._meta) ? params._meta : {}

  return {
    ...request,
    params: {
      ...params,
      _meta: {
        ...currentMeta,
        [META_PROTOCOL_VERSION]: protocolVersion,
        [META_CLIENT_INFO]: clientInfo,
        [META_CLIENT_CAPABILITIES]: clientCapabilities
      }
    }
  }
}

export function createMcpClient (
  app: FastifyInstance,
  options: McpClientOptions = {}
): McpClient {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT
  const clientHeaders = options.headers ?? {}
  const configuredProtocolVersion =
    options.protocolVersion === undefined
      ? LATEST_LEGACY_PROTOCOL_VERSION
      : options.protocolVersion
  const clientInfo = options.clientInfo ?? DEFAULT_CLIENT_INFO
  const clientCapabilities = options.clientCapabilities ?? {}
  const toolSchemas = new Map<string, unknown>()
  let nextRequestId = options.startingRequestId ?? DEFAULT_STARTING_REQUEST_ID
  let storedSessionId: string | undefined
  let negotiatedProtocolVersion = configuredProtocolVersion

  function getRequestId (explicitId: string | number | undefined): string | number {
    if (explicitId !== undefined) {
      return explicitId
    }

    const generatedId = nextRequestId
    nextRequestId += 1
    return generatedId
  }

  function effectiveProtocolVersion (requestOptions?: McpClientRequestOptions): string | null {
    return requestOptions?.protocolVersion === undefined
      ? negotiatedProtocolVersion
      : requestOptions.protocolVersion
  }

  function filterAndRememberToolSchemas (
    response: McpClientResponse,
    rejectInvalidHeaderAnnotations: boolean
  ): McpClientResponse {
    if (!('result' in response.body) || !isRecord(response.body.result)) return response
    const tools = response.body.result.tools
    if (!Array.isArray(tools)) return response

    const accepted: Tool[] = []
    for (const entry of tools as Tool[]) {
      if (typeof entry?.name !== 'string' || !('inputSchema' in entry)) {
        accepted.push(entry)
        continue
      }

      const annotations = collectHeaderParams(entry.inputSchema)
      if (rejectInvalidHeaderAnnotations && !annotations.ok) {
        // Streamable HTTP clients MUST exclude malformed x-mcp-header tools.
        // Also forget an earlier valid schema with the same name so a stale
        // cache cannot keep generating headers for a now-invalid definition.
        toolSchemas.delete(entry.name)
        continue
      }

      toolSchemas.set(entry.name, entry.inputSchema)
      accepted.push(entry)
    }

    if (accepted.length === tools.length) return response

    const body = {
      ...response.body,
      result: {
        ...response.body.result,
        tools: accepted
      }
    } as JSONRPCResponse

    const payload = JSON.stringify(body)
    const headers = { ...response.headers }
    if (headers['content-length'] !== undefined) {
      headers['content-length'] = String(Buffer.byteLength(payload))
    }

    return { ...response, headers, body, payload }
  }

  function send (
    request: JSONRPCRequest | JSONRPCNotification,
    requestOptions?: SendOptions & { expectJsonResponse?: true }
  ): Promise<McpClientResponse>
  function send (
    request: JSONRPCRequest | JSONRPCNotification,
    requestOptions: SendOptions & { expectJsonResponse: false }
  ): Promise<McpClientResponse<undefined>>
  async function send (
    request: JSONRPCRequest | JSONRPCNotification,
    requestOptions?: SendOptions
  ): Promise<McpClientResponse<JSONRPCResponse | undefined>> {
    const expectJsonResponse = requestOptions?.expectJsonResponse ?? true
    const requestProtocolVersion = effectiveProtocolVersion(requestOptions)
    const effectiveSessionId =
      requestOptions?.sessionId === undefined
        ? storedSessionId
        : requestOptions.sessionId

    const modern = isModernProtocolVersion(requestProtocolVersion)
    const payloadRequest = modern
      ? withModernMetadata(request, requestProtocolVersion, clientInfo, clientCapabilities)
      : request

    const generatedHeaders: Record<string, string> = {}
    if (requestProtocolVersion !== null) {
      generatedHeaders['mcp-protocol-version'] = requestProtocolVersion
    }
    if (modern) {
      generatedHeaders['mcp-method'] = request.method
      const name = expectedNameFor(request.method, request.params)
      if (name !== undefined) {
        generatedHeaders['mcp-name'] = encodeHeaderValue(name)
      }
    } else if (effectiveSessionId !== null && effectiveSessionId !== undefined) {
      generatedHeaders['mcp-session-id'] = effectiveSessionId
    }

    const headers = {
      'content-type': 'application/json',
      accept: DEFAULT_ACCEPT_HEADER,
      ...clientHeaders,
      ...generatedHeaders,
      ...(requestOptions?.headers ?? {})
    }

    const response = await app.inject({
      method: 'POST',
      url: endpoint,
      headers,
      payload: payloadRequest
    })

    const payload = response.body
    let body: JSONRPCResponse | undefined
    if (expectJsonResponse) {
      const parsedBody = parseJsonBody(payload, response.statusCode)
      assertMcpResponse(parsedBody)
      body = parsedBody
    }

    return {
      statusCode: response.statusCode,
      headers: normalizeResponseHeaders(response.headers as Record<string, unknown>),
      body,
      payload
    }
  }

  return {
    get sessionId () {
      return storedSessionId
    },

    async initialize (initOptions?: McpClientInitializeOptions): Promise<McpClientResponse> {
      const payloadProtocolVersion = getPayloadProtocolVersion(
        configuredProtocolVersion,
        initOptions?.protocolVersion
      )
      if (isModernProtocolVersion(payloadProtocolVersion)) {
        throw new ModernInitializeError(payloadProtocolVersion)
      }

      const id = getRequestId(initOptions?.id)
      const request: JSONRPCRequest = {
        jsonrpc: JSONRPC_VERSION,
        id,
        method: 'initialize',
        params: {
          protocolVersion: payloadProtocolVersion,
          capabilities: initOptions?.capabilities ?? {},
          clientInfo: initOptions?.clientInfo ?? DEFAULT_CLIENT_INFO
        }
      }

      const response = await send(request, {
        headers: initOptions?.headers,
        protocolVersion: initOptions?.protocolVersion,
        id: initOptions?.id,
        sessionId: null
      })

      if (!isInitializeSuccessResponse(response.body)) {
        return response
      }

      const candidateSessionId = getHeaderValue(response.headers, 'mcp-session-id')

      const responseProtocolVersion = response.body.result.protocolVersion
      const candidateProtocolVersion =
        typeof responseProtocolVersion === 'string'
          ? responseProtocolVersion
          : payloadProtocolVersion

      const initializedResponse = await send(
        {
          jsonrpc: JSONRPC_VERSION,
          method: 'notifications/initialized'
        },
        {
          expectJsonResponse: false,
          headers: omitManagedMcpHeaders(initOptions?.headers),
          sessionId: candidateSessionId ?? null,
          protocolVersion: candidateProtocolVersion
        }
      )

      assertNotificationAccepted(
        initializedResponse,
        'notifications/initialized'
      )

      storedSessionId = candidateSessionId
      negotiatedProtocolVersion = candidateProtocolVersion

      return response
    },

    async discover (requestOptions?: McpClientRequestOptions): Promise<McpClientResponse> {
      const id = getRequestId(requestOptions?.id)
      return await send({
        jsonrpc: JSONRPC_VERSION,
        id,
        method: 'server/discover'
      }, requestOptions)
    },

    async listTools (requestOptions?: McpClientRequestOptions & { cursor?: string }): Promise<McpClientResponse> {
      const id = getRequestId(requestOptions?.id)

      const request: JSONRPCRequest = {
        jsonrpc: JSONRPC_VERSION,
        id,
        method: 'tools/list',
        ...(requestOptions?.cursor === undefined ? {} : { params: { cursor: requestOptions.cursor } })
      }

      const response = await send(request, requestOptions)
      return filterAndRememberToolSchemas(
        response,
        isModernProtocolVersion(effectiveProtocolVersion(requestOptions))
      )
    },

    async callTool (
      name: string,
      args: Record<string, unknown> = {},
      requestOptions?: McpClientCallToolOptions
    ): Promise<McpClientResponse> {
      const id = getRequestId(requestOptions?.id)
      const {
        requestState,
        inputResponses,
        ...baseRequestOptions
      } = requestOptions ?? {}

      const request: JSONRPCRequest = {
        jsonrpc: JSONRPC_VERSION,
        id,
        method: 'tools/call',
        params: {
          name,
          arguments: args,
          ...(requestState === undefined ? {} : { requestState }),
          ...(inputResponses === undefined ? {} : { inputResponses })
        }
      }

      const schema = toolSchemas.get(name)
      const generatedHeaders = isModernProtocolVersion(effectiveProtocolVersion(requestOptions)) && schema !== undefined
        ? toolParamHeaders(schema, args)
        : {}

      return await send(request, {
        ...baseRequestOptions,
        headers: {
          ...generatedHeaders,
          ...(requestOptions?.headers ?? {})
        }
      })
    }
  }
}
