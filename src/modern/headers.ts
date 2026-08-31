/**
 * Header/body reconciliation for the 2026-07-28 Streamable HTTP transport.
 *
 * The transport mirrors selected body fields into HTTP headers so gateways can
 * route without parsing JSON. That only stays safe if the two agree, otherwise
 * a load balancer and the server can be made to disagree about what is being
 * called. Any mismatch is a `HeaderMismatch` (-32020) with HTTP 400.
 */

import type { IncomingHttpHeaders } from 'node:http'
import { TextDecoder } from 'node:util'

const BASE64_PREFIX = '=?base64?'
const BASE64_SUFFIX = '?='

/** Header field-name token characters, RFC 9110 5.1. */
const TCHAR = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

/** Visible ASCII, space and horizontal tab — what a header value may contain. */
const SAFE_HEADER_VALUE = /^[\x20-\x7E\t]*$/

/** Reject malformed byte sequences rather than replacing them with U+FFFD. */
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

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
    return UTF8_DECODER.decode(buffer)
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

/** Methods for which `Mcp-Name` is REQUIRED, and the body field it mirrors. */
const NAME_SOURCE: Record<string, 'name' | 'uri'> = {
  'tools/call': 'name',
  'prompts/get': 'name',
  'resources/read': 'uri'
}

/** Does this method have to carry `Mcp-Name`, whatever the body looks like? */
export function requiresName (method: string): boolean {
  return method in NAME_SOURCE
}

/**
 * The body value that `Mcp-Name` mirrors, which differs per method:
 * `params.name` for tools and prompts, `params.uri` for resources.
 *
 * Returns undefined when the method carries no name *or* when the body is
 * missing the field — callers must distinguish those two cases via
 * {@link requiresName}, since a missing body field does not excuse a missing
 * header.
 */
export function expectedNameFor (method: string, params: unknown): string | undefined {
  const field = NAME_SOURCE[method]
  if (!field) return undefined

  const value = (params as Record<string, unknown> | undefined)?.[field]
  return typeof value === 'string' ? value : undefined
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

  if (!requiresName(method)) {
    // Methods without a name source do not carry the header; a stray one is
    // ignored rather than rejected, since it mirrors nothing.
    return { ok: true }
  }

  const rawName = single(headers, 'mcp-name')
  if (rawName === undefined) {
    // Required for this method regardless of what the body contains — a body
    // that omits `name`/`uri` is malformed, but that is a separate failure and
    // must not excuse the missing header.
    return { ok: false, message: 'Missing required Mcp-Name header' }
  }

  const expectedName = expectedNameFor(method, params)
  if (expectedName === undefined) {
    return {
      ok: false,
      message: `Header mismatch: Mcp-Name header was sent but the request body has no ${method === 'resources/read' ? 'uri' : 'name'}`
    }
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
  const ancestors = new WeakSet<object>()

  interface Visit {
    kind: 'visit'
    value: unknown
    /** Argument path for annotations reached only through `properties`. */
    argumentPath: string[]
    /** JSON Schema path, used to explain an annotation in a forbidden location. */
    schemaPath: string[]
    /** Whether this schema node itself is an addressable property. */
    addressable: boolean
    /** Whether nested `properties` remain statically reachable from the root. */
    chainReachable: boolean
  }

  interface Leave {
    kind: 'leave'
    value: object
  }

  const schemaMapKeywords = new Set([
    '$defs',
    'definitions',
    'patternProperties',
    'dependentSchemas',
    'dependencies'
  ])
  const schemaValueKeywords = new Set([
    'items',
    'additionalItems',
    'additionalProperties',
    'unevaluatedItems',
    'unevaluatedProperties',
    'propertyNames',
    'contains',
    'not',
    'if',
    'then',
    'else',
    'contentSchema',
    'allOf',
    'anyOf',
    'oneOf',
    'prefixItems'
  ])

  const stack: Array<Visit | Leave> = [{
    kind: 'visit',
    value: inputSchema,
    argumentPath: [],
    schemaPath: [],
    addressable: false,
    chainReachable: true
  }]

  // Use an explicit depth-first stack so a maliciously deep schema cannot
  // overflow the JavaScript call stack. `ancestors` rejects cycles while still
  // allowing one schema object to be reused in separate branches.
  while (stack.length > 0) {
    const entry = stack.pop()!
    if (entry.kind === 'leave') {
      ancestors.delete(entry.value)
      continue
    }

    const { value, argumentPath, schemaPath, addressable, chainReachable } = entry
    if (!value || typeof value !== 'object') continue

    if (ancestors.has(value)) {
      return { ok: false, message: `Cyclic schema at '${schemaPath.join('.') || '<root>'}'` }
    }
    ancestors.add(value)
    stack.push({ kind: 'leave', value })

    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index--) {
        stack.push({
          kind: 'visit',
          value: value[index],
          argumentPath,
          schemaPath: [...schemaPath, String(index)],
          addressable: false,
          chainReachable: false
        })
      }
      continue
    }

    const record = value as Record<string, unknown>
    const annotation = record['x-mcp-header']
    if (annotation !== undefined) {
      if (!addressable) {
        return {
          ok: false,
          message: `x-mcp-header at '${schemaPath.join('.') || '<root>'}' is not statically reachable through properties`
        }
      }
      if (typeof annotation !== 'string' || annotation.length === 0) {
        return { ok: false, message: `x-mcp-header on '${argumentPath.join('.')}' must be a non-empty string` }
      }
      if (!TCHAR.test(annotation)) {
        return { ok: false, message: `x-mcp-header '${annotation}' is not a valid HTTP field name` }
      }
      const lower = annotation.toLowerCase()
      if (seen.has(lower)) {
        return { ok: false, message: `x-mcp-header '${annotation}' is declared more than once` }
      }
      const type = record.type
      if (type !== 'string' && type !== 'integer' && type !== 'boolean') {
        return {
          ok: false,
          message: `x-mcp-header '${annotation}' may only annotate string, integer or boolean parameters`
        }
      }
      seen.add(lower)
      params.set(lower, argumentPath)
    }

    const entries = Object.entries(record)
    for (let index = entries.length - 1; index >= 0; index--) {
      const [keyword, child] = entries[index]
      if (keyword === 'x-mcp-header') continue

      if (keyword === 'properties' && child && typeof child === 'object' && !Array.isArray(child)) {
        const properties = Object.entries(child as Record<string, unknown>)
        for (let propertyIndex = properties.length - 1; propertyIndex >= 0; propertyIndex--) {
          const [name, property] = properties[propertyIndex]
          stack.push({
            kind: 'visit',
            value: property,
            argumentPath: [...argumentPath, name],
            schemaPath: [...schemaPath, 'properties', name],
            addressable: chainReachable,
            chainReachable
          })
        }
        continue
      }

      if (schemaMapKeywords.has(keyword) && child && typeof child === 'object' && !Array.isArray(child)) {
        const schemas = Object.entries(child as Record<string, unknown>)
        for (let schemaIndex = schemas.length - 1; schemaIndex >= 0; schemaIndex--) {
          const [name, schema] = schemas[schemaIndex]
          stack.push({
            kind: 'visit',
            value: schema,
            argumentPath,
            schemaPath: [...schemaPath, keyword, name],
            addressable: false,
            chainReachable: false
          })
        }
        continue
      }

      if (schemaValueKeywords.has(keyword)) {
        // Once a path leaves `properties`, it can never become reachable again,
        // even if another `properties` appears below it. Do not inspect data
        // keywords such as `examples`, `default`, `const` or `enum`: an object
        // value there is an instance, not a subschema annotation.
        stack.push({
          kind: 'visit',
          value: child,
          argumentPath,
          schemaPath: [...schemaPath, keyword],
          addressable: false,
          chainReachable: false
        })
      }
    }
  }

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
      // Compare numerically as the transport recommends (`42.0` equals `42`),
      // but require both representations to resolve to safe integers first so
      // distinct large values cannot collapse through Number rounding.
      const headerValue = Number(decoded)
      if (!Number.isSafeInteger(value) || !Number.isSafeInteger(headerValue) || headerValue !== value) {
        return {
          ok: false,
          message: `Header mismatch: Mcp-Param-${name} header value '${decoded}' does not match safe integer body value '${value}'`
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
