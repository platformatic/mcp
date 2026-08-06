import type { JSONRPCErrorResponse, JSONRPCResultResponse } from '../schema.ts'
import { JSONRPC_VERSION } from '../schema.ts'
import createFastifyError from 'fastify-error'

const InvalidMcpErrorMessageError = createFastifyError(
  'MCP_ERR_INVALID_ERROR_MESSAGE',
  'Expected error.message to be a string'
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
    throw new Error(`Expected JSON-RPC success response object, got ${describeValue(body)}`)
  }

  if (body.jsonrpc !== JSONRPC_VERSION) {
    throw new Error(`Expected jsonrpc to be '${JSONRPC_VERSION}'`)
  }

  if (!hasOwn(body, 'result')) {
    throw new Error('Expected JSON-RPC success response to include result')
  }

  if (hasOwn(body, 'error')) {
    throw new Error('Expected JSON-RPC success response not to include error')
  }
}

export function assertMcpError (
  body: unknown
): asserts body is JSONRPCErrorResponse {
  if (!isRecord(body)) {
    throw new Error(`Expected JSON-RPC error response object, got ${describeValue(body)}`)
  }

  if (body.jsonrpc !== JSONRPC_VERSION) {
    throw new Error(`Expected jsonrpc to be '${JSONRPC_VERSION}'`)
  }

  if (!hasOwn(body, 'error')) {
    throw new Error('Expected JSON-RPC error response to include error')
  }

  if (hasOwn(body, 'result')) {
    throw new Error('Expected JSON-RPC error response not to include result')
  }

  const errorValue = body.error
  if (!isRecord(errorValue)) {
    throw new Error('Expected error to be an object')
  }

  if (typeof errorValue.code !== 'number') {
    throw new Error('Expected error.code to be a number')
  }

  if (typeof errorValue.message !== 'string') {
    throw new InvalidMcpErrorMessageError()
  }
}
