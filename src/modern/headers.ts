/**
 * Header/body reconciliation for the 2026-07-28 Streamable HTTP transport.
 *
 * The transport mirrors selected body fields into HTTP headers so gateways can
 * route without parsing JSON. That only stays safe if the two agree, otherwise
 * a load balancer and the server can be made to disagree about what is being
 * called. Any mismatch is a `HeaderMismatch` (-32020) with HTTP 400.
 */

import type { IncomingHttpHeaders } from 'node:http'

const BASE64_PREFIX = '=?base64?'
const BASE64_SUFFIX = '?='

/** Header field-name token characters, RFC 9110 5.1. */
const TCHAR = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

/** Visible ASCII, space and horizontal tab — what a header value may contain. */
const SAFE_HEADER_VALUE = /^[\x20-\x7E\t]*$/

export type HeaderCheck = { ok: true } | { ok: false, message: string }

/**
 * Decode the Base64 sentinel wrapper if present, otherwise return as-is.
 *
 * Clients use `=?base64?...?=` whenever a value cannot ride in a header
 * literally (non-ASCII, control characters, surrounding whitespace), and also
 * for plain values that would otherwise be mistaken for the sentinel.
 */
export function decodeHeaderValue (raw: string): string | null {
  if (!raw.startsWith(BASE64_PREFIX) || !raw.endsWith(BASE64_SUFFIX)) {
    return raw
  }

  const encoded = raw.slice(BASE64_PREFIX.length, raw.length - BASE64_SUFFIX.length)
  try {
    const buffer = Buffer.from(encoded, 'base64')
    // Buffer.from is lenient: round-trip to catch input that was not valid
    // base64 rather than silently accepting a truncated value.
    if (buffer.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
      return null
    }
    return buffer.toString('utf8')
  } catch {
    return null
  }
}

/** Encode a value the way a conforming client would, for tests and clients. */
export function encodeHeaderValue (value: string): string {
  const needsEncoding =
    !SAFE_HEADER_VALUE.test(value) ||
    value !== value.trim() ||
    (value.startsWith(BASE64_PREFIX) && value.endsWith(BASE64_SUFFIX))

  if (!needsEncoding) return value
  return `${BASE64_PREFIX}${Buffer.from(value, 'utf8').toString('base64')}${BASE64_SUFFIX}`
}

function single (headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name]
  if (value === undefined) return undefined
  return Array.isArray(value) ? value[0] : value
}

/**
 * The body value that `Mcp-Name` mirrors, which differs per method:
 * `params.name` for tools and prompts, `params.uri` for resources.
 * Methods not listed here do not carry the header.
 */
export function expectedNameFor (method: string, params: unknown): string | undefined {
  const record = params as Record<string, unknown> | undefined
  switch (method) {
    case 'tools/call':
    case 'prompts/get':
      return typeof record?.name === 'string' ? record.name : undefined
    case 'resources/read':
      return typeof record?.uri === 'string' ? record.uri : undefined
    default:
      return undefined
  }
}

/**
 * Validate `Mcp-Method` and `Mcp-Name` against the body.
 *
 * `MCP-Protocol-Version` is checked separately because an unsupported version
 * has its own error code, and the two failures are reported differently.
 */
export function validateStandardHeaders (
  headers: IncomingHttpHeaders,
  method: string,
  params: unknown
): HeaderCheck {
  const mcpMethod = single(headers, 'mcp-method')
  if (mcpMethod === undefined) {
    return { ok: false, message: 'Missing required Mcp-Method header' }
  }
  if (mcpMethod !== method) {
    return {
      ok: false,
      message: `Header mismatch: Mcp-Method header value '${mcpMethod}' does not match body value '${method}'`
    }
  }

  const expectedName = expectedNameFor(method, params)
  const rawName = single(headers, 'mcp-name')

  if (expectedName === undefined) {
    // Methods without a name source do not require the header; a stray one is
    // ignored rather than rejected, since it mirrors nothing.
    return { ok: true }
  }

  if (rawName === undefined) {
    return { ok: false, message: 'Missing required Mcp-Name header' }
  }

  const decoded = decodeHeaderValue(rawName)
  if (decoded === null) {
    return { ok: false, message: 'Header mismatch: Mcp-Name header value is not valid Base64' }
  }
  if (decoded !== expectedName) {
    return {
      ok: false,
      message: `Header mismatch: Mcp-Name header value '${decoded}' does not match body value '${expectedName}'`
    }
  }

  return { ok: true }
}

/**
 * Read the `x-mcp-header` annotations off a tool's `inputSchema`.
 *
 * Only properties statically reachable through a chain of `properties` keys
 * count. Anything behind `items`, a composition keyword, `if`/`then`/`else` or
 * a `$ref` is not addressable, so an annotation there makes the tool invalid.
 */
export function collectHeaderParams (
  inputSchema: unknown
): { ok: true, params: Map<string, string[]> } | { ok: false, message: string } {
  const params = new Map<string, string[]>()
  const seen = new Set<string>()

  const walk = (schema: unknown, path: string[]): string | undefined => {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return undefined
    const record = schema as Record<string, unknown>

    const properties = record.properties
    if (!properties || typeof properties !== 'object') return undefined

    for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue
      const property = value as Record<string, unknown>
      const annotation = property['x-mcp-header']

      if (annotation !== undefined) {
        if (typeof annotation !== 'string' || annotation.length === 0) {
          return `x-mcp-header on '${[...path, key].join('.')}' must be a non-empty string`
        }
        if (!TCHAR.test(annotation)) {
          return `x-mcp-header '${annotation}' is not a valid HTTP field name`
        }
        const lower = annotation.toLowerCase()
        if (seen.has(lower)) {
          return `x-mcp-header '${annotation}' is declared more than once`
        }
        const type = property.type
        if (type !== 'string' && type !== 'integer' && type !== 'boolean') {
          return `x-mcp-header '${annotation}' may only annotate string, integer or boolean parameters`
        }
        seen.add(lower)
        params.set(lower, [...path, key])
      }

      const nested = walk(property, [...path, key])
      if (nested) return nested
    }

    return undefined
  }

  const error = walk(inputSchema, [])
  if (error) return { ok: false, message: error }
  return { ok: true, params }
}

function valueAtPath (root: unknown, path: string[]): unknown {
  let current = root
  for (const segment of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/**
 * Check every `Mcp-Param-*` header a tool declares against the call arguments.
 *
 * A parameter that is absent or null carries no header, and a header for a
 * value the body does not have is a mismatch — that combination is exactly the
 * non-conforming client the validation exists to catch.
 */
export function validateToolParamHeaders (
  headers: IncomingHttpHeaders,
  inputSchema: unknown,
  args: unknown
): HeaderCheck {
  const collected = collectHeaderParams(inputSchema)
  if (!collected.ok) {
    // A malformed annotation is the server's own bug; refusing the call is
    // better than validating against a rule we cannot express.
    return { ok: false, message: `Invalid tool definition: ${collected.message}` }
  }

  for (const [name, path] of collected.params) {
    const headerName = `mcp-param-${name}`
    const raw = single(headers, headerName)
    const value = valueAtPath(args, path)

    if (value === undefined || value === null) {
      if (raw !== undefined) {
        return {
          ok: false,
          message: `Header mismatch: Mcp-Param-${name} was sent but '${path.join('.')}' is absent from the request body`
        }
      }
      continue
    }

    if (raw === undefined) {
      return {
        ok: false,
        message: `Missing required Mcp-Param-${name} header for '${path.join('.')}'`
      }
    }

    const decoded = decodeHeaderValue(raw)
    if (decoded === null) {
      return { ok: false, message: `Header mismatch: Mcp-Param-${name} is not valid Base64` }
    }

    if (typeof value === 'number') {
      // Compare numerically: '42' and 42.0 are the same value.
      const asNumber = Number(decoded)
      if (Number.isNaN(asNumber) || asNumber !== value) {
        return {
          ok: false,
          message: `Header mismatch: Mcp-Param-${name} header value '${decoded}' does not match body value '${value}'`
        }
      }
      continue
    }

    const expected = typeof value === 'boolean' ? String(value) : String(value)
    if (decoded !== expected) {
      return {
        ok: false,
        message: `Header mismatch: Mcp-Param-${name} header value '${decoded}' does not match body value '${expected}'`
      }
    }
  }

  return { ok: true }
}
