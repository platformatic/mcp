import type { FastifyInstance } from 'fastify'
import createFastifyError from 'fastify-error'
import type {
  Implementation,
  JSONRPCNotification,
  JSONRPCRequest,
  JSONRPCResponse
} from './schema.ts'
import {
  JSONRPC_VERSION,
  LATEST_PROTOCOL_VERSION
} from './schema.ts'

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

export interface McpClientOptions {
  endpoint?: string
  headers?: Record<string, string>
  protocolVersion?: string | null
  startingRequestId?: number
}

export interface McpClientRequestOptions {
  headers?: Record<string, string>
  protocolVersion?: string | null
  id?: string | number
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

  listTools(options?: McpClientRequestOptions & {
    cursor?: string
  }): Promise<McpClientResponse>

  callTool(
    name: string,
    args?: Record<string, unknown>,
    options?: McpClientRequestOptions
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
    return configuredProtocolVersion ?? LATEST_PROTOCOL_VERSION
  }

  if (requestProtocolVersion === null) {
    return LATEST_PROTOCOL_VERSION
  }

  return requestProtocolVersion
}

export function createMcpClient (
  app: FastifyInstance,
  options: McpClientOptions = {}
): McpClient {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT
  const clientHeaders = options.headers ?? {}
  const configuredProtocolVersion =
    options.protocolVersion === undefined
      ? LATEST_PROTOCOL_VERSION
      : options.protocolVersion
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
    const effectiveProtocolVersion =
      requestOptions?.protocolVersion === undefined
        ? negotiatedProtocolVersion
        : requestOptions.protocolVersion
    const effectiveSessionId =
      requestOptions?.sessionId === undefined
        ? storedSessionId
        : requestOptions.sessionId

    const generatedHeaders: Record<string, string> = {}
    if (effectiveProtocolVersion !== null) {
      generatedHeaders['mcp-protocol-version'] = effectiveProtocolVersion
    }
    if (effectiveSessionId !== null && effectiveSessionId !== undefined) {
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
      payload: request
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
      const id = getRequestId(initOptions?.id)
      const payloadProtocolVersion = getPayloadProtocolVersion(
        configuredProtocolVersion,
        initOptions?.protocolVersion
      )

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
          : configuredProtocolVersion

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

    async listTools (requestOptions?: McpClientRequestOptions & { cursor?: string }): Promise<McpClientResponse> {
      const id = getRequestId(requestOptions?.id)

      const request: JSONRPCRequest = {
        jsonrpc: JSONRPC_VERSION,
        id,
        method: 'tools/list',
        ...(requestOptions?.cursor === undefined ? {} : { params: { cursor: requestOptions.cursor } })
      }

      return await send(request, requestOptions)
    },

    async callTool (
      name: string,
      args: Record<string, unknown> = {},
      requestOptions?: McpClientRequestOptions
    ): Promise<McpClientResponse> {
      const id = getRequestId(requestOptions?.id)

      const request: JSONRPCRequest = {
        jsonrpc: JSONRPC_VERSION,
        id,
        method: 'tools/call',
        params: {
          name,
          arguments: args
        }
      }

      return await send(request, requestOptions)
    }
  }
}
