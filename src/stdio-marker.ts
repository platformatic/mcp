import { randomUUID } from 'node:crypto'
import type { FastifyRequest } from 'fastify'

export const STDIO_TRANSPORT_HEADER = 'x-platformatic-mcp-transport'
export const STDIO_TOKEN_HEADER = 'x-platformatic-mcp-stdio-token'

// The stdio transport only ever reaches the server through app.inject(), so
// this per-process secret never travels over the network. An HTTP client can
// send the transport header, but it cannot guess the token.
export const STDIO_TOKEN = randomUUID()

export function isStdioRequest (request: FastifyRequest): boolean {
  return request.headers[STDIO_TOKEN_HEADER] === STDIO_TOKEN
}
