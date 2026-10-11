import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http'

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

function presentsTrustToken (headers: IncomingHttpHeaders): boolean {
  const value = headers[STDIO_TRUST_HEADER]
  if (typeof value !== 'string') return false
  const received = Buffer.from(value)
  return received.length === expected.length && timingSafeEqual(received, expected)
}

/** Requests recognised as stdio-injected, with their cancellation signal if any. */
const stdioRequests = new WeakMap<IncomingMessage, { signal?: AbortSignal }>()

/**
 * Recognise a stdio-injected request once, as it arrives, and remove the
 * tokens from its headers. Handlers can read their request's headers, and a
 * handler that echoed or logged them must not hand out a token an HTTP client
 * could replay to skip header validation.
 */
export function claimStdioRequest (request: { raw: IncomingMessage, headers: IncomingHttpHeaders }): void {
  const headers = request.headers
  if (!presentsTrustToken(headers)) return
  const token = headers[STDIO_REQUEST_HEADER]
  stdioRequests.set(request.raw, { signal: typeof token === 'string' ? requestSignals.get(token) : undefined })
  delete headers[STDIO_TRUST_HEADER]
  delete headers[STDIO_REQUEST_HEADER]
}

export function isStdioRequest (request: { raw: IncomingMessage }): boolean {
  return stdioRequests.has(request.raw)
}

/**
 * Carries a stdio request's cancellation into the route. On stdio the client
 * cancels with `notifications/cancelled` rather than by closing a stream, so
 * the transport registers a signal per request and passes its token along.
 */
export const STDIO_REQUEST_HEADER = 'x-platformatic-mcp-stdio-request'
const requestSignals = new Map<string, AbortSignal>()

export function registerStdioRequest (signal: AbortSignal): { token: string, release: () => void } {
  const token = randomBytes(16).toString('hex')
  requestSignals.set(token, signal)
  return { token, release: () => requestSignals.delete(token) }
}

/** The cancellation signal of a stdio-injected request, if it has one. */
export function stdioRequestSignal (request: { raw: IncomingMessage }): AbortSignal | undefined {
  return stdioRequests.get(request.raw)?.signal
}
