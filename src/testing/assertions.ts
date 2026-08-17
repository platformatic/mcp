import type { JSONRPCErrorResponse, JSONRPCResultResponse } from '../schema.ts'
import { JSONRPC_VERSION } from '../schema.ts'
import createFastifyError from 'fastify-error'

const InvalidMcpErrorMessageError = createFastifyError(
  'MCP_ERR_INVALID_ERROR_MESSAGE',
  'Expected error.message to be a string'
)
const InvalidMcpResultResponseObjectError = createFastifyError(
  'MCP_ERR_INVALID_RESULT_RESPONSE_OBJECT',
  'Expected JSON-RPC success response object, got %s'
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
const MissingMcpErrorFieldError = createFastifyError(
  'MCP_ERR_MISSING_ERROR',
  'Expected JSON-RPC error response to include error'
)
const UnexpectedMcpErrorResultError = createFastifyError(
  'MCP_ERR_UNEXPECTED_ERROR_RESULT',
  'Expected JSON-RPC error response not to include result'
)
const InvalidMcpErrorObjectError = createFastifyError(
  'MCP_ERR_INVALID_ERROR_OBJECT',
  'Expected error to be an object'
)
const InvalidMcpErrorCodeError = createFastifyError(
  'MCP_ERR_INVALID_ERROR_CODE',
  'Expected error.code to be a number'
)

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

export function assertMcpResult (
  body: unknown
): asserts body is JSONRPCResultResponse {
  if (!isRecord(body)) {
    throw new InvalidMcpResultResponseObjectError(describeValue(body))
  }

  if (body.jsonrpc !== JSONRPC_VERSION) {
    throw new InvalidMcpJsonrpcVersionError()
  }

  if (!hasOwn(body, 'result')) {
    throw new MissingMcpResultError()
  }

  if (hasOwn(body, 'error')) {
    throw new UnexpectedMcpResultErrorFieldError()
  }
}

export function assertMcpError (
  body: unknown
): asserts body is JSONRPCErrorResponse {
  if (!isRecord(body)) {
    throw new InvalidMcpErrorResponseObjectError(describeValue(body))
  }

  if (body.jsonrpc !== JSONRPC_VERSION) {
    throw new InvalidMcpJsonrpcVersionError()
  }

  if (!hasOwn(body, 'error')) {
    throw new MissingMcpErrorFieldError()
  }

  if (hasOwn(body, 'result')) {
    throw new UnexpectedMcpErrorResultError()
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
