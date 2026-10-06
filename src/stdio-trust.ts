import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'

/**
 * Marks requests the in-process stdio transport injects into `/mcp`.
 *
 * stdio has no header layer: the 2026-07-28 transport carries everything in
 * the body, so the header/body reconciliation that protects HTTP gateways does
 * not apply. The token is random per process, so an HTTP client cannot claim
 * to be stdio to skip that validation.
 */
export const STDIO_TRUST_HEADER = 'x-platformatic-mcp-stdio-trust'
export const STDIO_TRUST_TOKEN = randomBytes(32).toString('hex')

const expected = Buffer.from(STDIO_TRUST_TOKEN)

export function isStdioRequest (headers: IncomingHttpHeaders): boolean {
  const value = headers[STDIO_TRUST_HEADER]
  if (typeof value !== 'string') return false
  const received = Buffer.from(value)
  return received.length === expected.length && timingSafeEqual(received, expected)
}
