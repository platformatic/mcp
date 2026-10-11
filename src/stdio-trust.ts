import { randomBytes } from 'node:crypto'
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http'
import type { AuthorizationContext } from './types/auth-types.ts'

/**
 * Marks requests the in-process stdio transport injects into `/mcp`.
 *
 * stdio has no header layer: the 2026-07-28 transport carries everything in
 * the body, so the header/body reconciliation that protects HTTP gateways does
 * not apply, and the caller is whoever started the process. Each injected
 * request carries a random token that is good for that one request only: it
 * is registered just before the injection and consumed as the request
 * arrives. A token that shows up in a log, or in a hook that runs before the
 * plugin's, has already been spent and cannot be replayed over HTTP.
 */
export const STDIO_REQUEST_HEADER = 'x-platformatic-mcp-stdio-request'

interface StdioRequest {
  signal?: AbortSignal
  authContext?: AuthorizationContext
}

/** Tokens issued for injections that have not arrived yet. */
const issued = new Map<string, StdioRequest>()
/** Requests recognised as stdio-injected. */
const stdioRequests = new WeakMap<IncomingMessage, StdioRequest>()

/**
 * Issue a single-use token for one injected request. `signal` carries its
 * cancellation (on stdio the client cancels with `notifications/cancelled`
 * rather than by closing a stream), and `authContext` is the identity the
 * operator configured for this transport, if any.
 */
export function registerStdioRequest (
  signal: AbortSignal,
  authContext?: AuthorizationContext
): { token: string, release: () => void } {
  const token = randomBytes(32).toString('hex')
  issued.set(token, { signal, authContext })
  return { token, release: () => issued.delete(token) }
}

/**
 * Recognise a stdio-injected request once, as it arrives, spending its token
 * and removing it from the headers handlers can read.
 */
export function claimStdioRequest (request: { raw: IncomingMessage, headers: IncomingHttpHeaders }): void {
  const token = request.headers[STDIO_REQUEST_HEADER]
  if (token === undefined) return
  delete request.headers[STDIO_REQUEST_HEADER]
  if (typeof token !== 'string') return
  const entry = issued.get(token)
  if (!entry) return
  issued.delete(token)
  stdioRequests.set(request.raw, entry)
}

export function isStdioRequest (request: { raw: IncomingMessage }): boolean {
  return stdioRequests.has(request.raw)
}

/** The cancellation signal of a stdio-injected request, if it has one. */
export function stdioRequestSignal (request: { raw: IncomingMessage }): AbortSignal | undefined {
  return stdioRequests.get(request.raw)?.signal
}

/** The identity the stdio transport was configured with, if any. */
export function stdioAuthContext (request: { raw: IncomingMessage }): AuthorizationContext | undefined {
  return stdioRequests.get(request.raw)?.authContext
}
