/**
 * Per-request metadata handling for the 2026-07-28 revision.
 *
 * There is no handshake any more: every request states which protocol version
 * it speaks and which capabilities the client has, in `_meta`. Nothing may be
 * inferred from an earlier request on the same connection, so this parsing runs
 * for each message independently.
 */

import type { Implementation, LoggingLevel } from '../schema.ts'
import type { ClientCapabilities, RequestMetaObject } from '../schema-2026.ts'
import {
  META_CLIENT_CAPABILITIES,
  META_CLIENT_INFO,
  META_LOG_LEVEL,
  META_PROTOCOL_VERSION,
  TASKS_EXTENSION
} from '../schema-2026.ts'

/** Everything the modern dispatch needs to know about who is calling. */
export interface RequestContext {
  protocolVersion: string
  clientInfo?: Implementation
  clientCapabilities: ClientCapabilities
  /** Absent means the client did not opt into `notifications/message`. */
  logLevel?: LoggingLevel
  progressToken?: string | number
}

export type RequestContextResult =
  | { ok: true, context: RequestContext }
  | { ok: false, message: string }

const LOG_LEVELS: readonly string[] = [
  'debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'
]

/**
 * Read `_meta` off a request's params.
 *
 * A missing or malformed required field is a client error, reported by the
 * caller as `-32602` (and HTTP 400) per the spec. We deliberately do not fill
 * in defaults: guessing a protocol version would defeat the point of carrying
 * one on every request.
 */
export function parseRequestContext (params: unknown): RequestContextResult {
  const meta = (params as { _meta?: unknown } | undefined)?._meta

  if (meta === undefined || meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    return { ok: false, message: 'Missing required "_meta" on request params' }
  }

  const record = meta as RequestMetaObject

  const protocolVersion = record[META_PROTOCOL_VERSION]
  if (typeof protocolVersion !== 'string' || protocolVersion.length === 0) {
    return { ok: false, message: `Missing required "_meta.${META_PROTOCOL_VERSION}"` }
  }

  const rawCapabilities = record[META_CLIENT_CAPABILITIES]
  if (rawCapabilities === undefined || rawCapabilities === null ||
      typeof rawCapabilities !== 'object' || Array.isArray(rawCapabilities)) {
    return { ok: false, message: `Missing required "_meta.${META_CLIENT_CAPABILITIES}"` }
  }

  const rawClientInfo = record[META_CLIENT_INFO]
  let clientInfo: Implementation | undefined
  if (rawClientInfo !== undefined) {
    if (typeof rawClientInfo !== 'object' || rawClientInfo === null || Array.isArray(rawClientInfo)) {
      return { ok: false, message: `Invalid "_meta.${META_CLIENT_INFO}": expected an object` }
    }
    clientInfo = rawClientInfo as Implementation
  }

  const rawLogLevel = record[META_LOG_LEVEL]
  let logLevel: LoggingLevel | undefined
  if (rawLogLevel !== undefined) {
    if (typeof rawLogLevel !== 'string' || !LOG_LEVELS.includes(rawLogLevel)) {
      return { ok: false, message: `Invalid "_meta.${META_LOG_LEVEL}": unknown log level` }
    }
    logLevel = rawLogLevel as LoggingLevel
  }

  const rawProgressToken = (record as { progressToken?: unknown }).progressToken
  let progressToken: string | number | undefined
  if (rawProgressToken !== undefined) {
    if (typeof rawProgressToken !== 'string' && typeof rawProgressToken !== 'number') {
      return { ok: false, message: 'Invalid "_meta.progressToken": expected a string or number' }
    }
    progressToken = rawProgressToken
  }

  return {
    ok: true,
    context: {
      protocolVersion,
      clientInfo,
      clientCapabilities: rawCapabilities as ClientCapabilities,
      logLevel,
      progressToken
    }
  }
}

/**
 * Cheap check for whether a message is aimed at the modern protocol, used to
 * route between eras before doing any real parsing.
 *
 * Presence of the protocol-version key is the signal. A body that merely looks
 * malformed is left to the legacy path, which is what a legacy client's traffic
 * would look like.
 */
export function looksModern (body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false
  const meta = (body as { params?: { _meta?: unknown } }).params?._meta
  if (!meta || typeof meta !== 'object') return false
  return META_PROTOCOL_VERSION in (meta as Record<string, unknown>)
}

/** Did the client declare support for elicitation in this request? */
export function supportsElicitation (capabilities: ClientCapabilities): boolean {
  return capabilities.elicitation !== undefined
}

/** Did the client declare support for URL-mode elicitation? */
export function supportsUrlElicitation (capabilities: ClientCapabilities): boolean {
  return capabilities.elicitation?.url !== undefined
}

/** Did the client declare sampling (deprecated, but still negotiable)? */
export function supportsSampling (capabilities: ClientCapabilities): boolean {
  return capabilities.sampling !== undefined
}

/** Did the client declare roots (deprecated, but still negotiable)? */
export function supportsRoots (capabilities: ClientCapabilities): boolean {
  return capabilities.roots !== undefined
}

/** Did the client opt into the official tasks extension on this request? */
export function supportsTasksExtension (capabilities: ClientCapabilities): boolean {
  return capabilities.extensions?.[TASKS_EXTENSION] !== undefined
}
