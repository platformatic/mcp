/**
 * Security utilities for handling untrusted inputs in MCP implementation
 */

/**
 * Maximum length for string inputs to prevent DoS attacks
 */
const MAX_STRING_LENGTH = 10000

/**
 * Maximum nesting depth for objects to prevent stack overflow
 */
const MAX_OBJECT_DEPTH = 10

/**
 * Maximum number of properties in an object
 */
const MAX_OBJECT_PROPERTIES = 100

/**
 * Limits applied to tool arguments by `sanitizeToolParams`.
 * Use `Infinity` to disable a limit.
 */
export interface ToolArgumentLimits {
  /** Maximum length of any string, including object keys (default 10000) */
  maxStringLength?: number
  /** Maximum number of keys in a single object; arrays are not counted (default 100) */
  maxObjectProperties?: number
  /** Maximum number of items in a single array (default unlimited) */
  maxArrayLength?: number
  /** Maximum nesting depth (default 10) */
  maxDepth?: number
}

/**
 * Sanitize a string by removing potentially dangerous characters
 * and limiting length to prevent DoS attacks
 */
export function sanitizeString (input: string, maxLength: number = MAX_STRING_LENGTH): string {
  if (typeof input !== 'string') {
    throw new Error('Input must be a string')
  }

  // Limit string length
  if (input.length > maxLength) {
    throw new Error(`String length exceeds maximum allowed length of ${maxLength}`)
  }

  // Remove null bytes and other control characters (except newlines and tabs)
  // eslint-disable-next-line no-control-regex
  return input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
}

/**
 * Validate object depth to prevent stack overflow attacks
 */
export function validateObjectDepth (
  obj: any,
  maxDepth: number = MAX_OBJECT_DEPTH,
  maxProperties: number = MAX_OBJECT_PROPERTIES,
  maxArrayLength: number = Infinity
): void {
  function checkDepth (current: any, depth: number): void {
    if (depth > maxDepth) {
      throw new Error(`Object nesting depth exceeds maximum allowed depth of ${maxDepth}`)
    }

    if (current && typeof current === 'object') {
      // Check for circular references
      if (seen.has(current)) {
        throw new Error('Circular reference detected in object')
      }
      seen.add(current)

      // Arrays are bounded by their own limit, not counted as properties
      const keys = Object.keys(current)
      if (Array.isArray(current)) {
        if (current.length > maxArrayLength) {
          throw new Error(`Array has too many items (${current.length} > ${maxArrayLength})`)
        }
      } else if (keys.length > maxProperties) {
        throw new Error(`Object has too many properties (${keys.length} > ${maxProperties})`)
      }

      for (const key of keys) {
        checkDepth(current[key], depth + 1)
      }

      seen.delete(current)
    }
  }

  const seen = new WeakSet()
  checkDepth(obj, 0)
}

/**
 * Sanitize tool parameters from untrusted sources.
 *
 * The structure (depth, property counts, array lengths, cycles) is validated
 * once up front; every string reached afterwards, including object keys and
 * strings nested inside arrays at any depth, is length-checked and stripped of
 * control characters.
 */
export function sanitizeToolParams (params: Record<string, any>, limits: ToolArgumentLimits = {}): Record<string, any> {
  const maxStringLength = limits.maxStringLength ?? MAX_STRING_LENGTH

  // Validate object structure first
  validateObjectDepth(
    params,
    limits.maxDepth ?? MAX_OBJECT_DEPTH,
    limits.maxObjectProperties ?? MAX_OBJECT_PROPERTIES,
    limits.maxArrayLength ?? Infinity
  )

  function sanitizeValue (value: any): any {
    if (typeof value === 'string') {
      return sanitizeString(value, maxStringLength)
    }
    if (Array.isArray(value)) {
      return value.map(sanitizeValue)
    }
    if (typeof value === 'object' && value !== null) {
      const sanitized: Record<string, any> = {}
      for (const [key, item] of Object.entries(value)) {
        sanitized[sanitizeString(key, maxStringLength)] = sanitizeValue(item)
      }
      return sanitized
    }
    return value
  }

  return sanitizeValue(params)
}

/**
 * Security warnings for tool annotations
 */
export const SECURITY_WARNINGS = {
  UNTRUSTED_ANNOTATIONS: 'Tool annotations are hints from potentially untrusted servers and should not be used for security decisions',
  DESTRUCTIVE_TOOL: 'This tool may perform destructive operations - verify the operation before proceeding',
  OPEN_WORLD_TOOL: 'This tool interacts with external entities - be cautious of data exposure',
  UNVALIDATED_INPUT: 'Input validation failed - request may contain malicious data'
} as const

/**
 * Check if tool annotations indicate potential security risks
 */
export function assessToolSecurity (annotations?: {
  destructiveHint?: boolean
  openWorldHint?: boolean
  readOnlyHint?: boolean
}): {
    riskLevel: 'low' | 'medium' | 'high'
    warnings: string[]
  } {
  const warnings: string[] = []
  let riskLevel: 'low' | 'medium' | 'high' = 'low'

  // Always warn about untrusted annotations
  warnings.push(SECURITY_WARNINGS.UNTRUSTED_ANNOTATIONS)

  if (annotations?.destructiveHint === true) {
    warnings.push(SECURITY_WARNINGS.DESTRUCTIVE_TOOL)
    riskLevel = 'high'
  }

  if (annotations?.openWorldHint === true) {
    warnings.push(SECURITY_WARNINGS.OPEN_WORLD_TOOL)
    if (riskLevel === 'low') riskLevel = 'medium'
  }

  return { riskLevel, warnings }
}

/**
 * Validate elicitation request to prevent abuse
 */
export function validateElicitationRequest (message: string, schema: any): void {
  // Validate message length
  if (message.length > MAX_STRING_LENGTH) {
    throw new Error(`Elicitation message length exceeds maximum allowed length of ${MAX_STRING_LENGTH}`)
  }

  // Sanitize message
  const sanitizedMessage = sanitizeString(message)
  if (sanitizedMessage !== message) {
    throw new Error('Elicitation message contains invalid characters')
  }

  // Validate schema structure
  validateObjectDepth(schema)

  // Ensure schema is not overly complex
  const schemaString = JSON.stringify(schema)
  if (schemaString.length > MAX_STRING_LENGTH) {
    throw new Error('Elicitation schema is too complex')
  }
}

/**
 * Validate a URL mode elicitation request (2025-11-25).
 *
 * The spec forbids servers from putting anything sensitive in the URL, and
 * forbids pre-authenticated URLs, because a malicious client could replay them
 * to impersonate the user. We enforce what is mechanically checkable: a parseable
 * http(s) URL carrying no embedded credentials.
 */
export function validateElicitationUrl (message: string, url: string): void {
  if (message.length > MAX_STRING_LENGTH) {
    throw new Error(`Elicitation message length exceeds maximum allowed length of ${MAX_STRING_LENGTH}`)
  }

  const sanitizedMessage = sanitizeString(message)
  if (sanitizedMessage !== message) {
    throw new Error('Elicitation message contains invalid characters')
  }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('Elicitation URL is not a valid URL')
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Elicitation URL must use http or https, got '${parsed.protocol}'`)
  }

  if (parsed.username || parsed.password) {
    throw new Error('Elicitation URL must not embed credentials')
  }
}

/**
 * Configured value for the allowed `Origin` headers.
 *
 * - `undefined` (the default) accepts only loopback origins and the server's own host
 * - `'*'` or `true` accepts any origin, disabling validation
 * - an array accepts exact origin matches only
 */
export type AllowedOrigins = string[] | '*' | true | undefined

function parseOrigin (origin: string): URL | undefined {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  return url
}

function isLoopbackHostname (hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  // URL has already normalised IPv4 literals to dotted-quad form
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
}

/**
 * Compare host:port only, so an `https` origin matches a server that sees plain
 * HTTP behind a TLS-terminating proxy. The Host header is parsed with the origin's
 * scheme so an explicit default port (`:443`) matches an implied one.
 */
function isSameHost (url: URL, host: string | undefined): boolean {
  if (!host) return false
  try {
    return new URL(`${url.protocol}//${host}`).host === url.host
  } catch {
    return false
  }
}

/**
 * Check a request `Origin` against the configured allow-list.
 *
 * Requests without an `Origin` header are accepted: the header is set by browsers,
 * and its absence means the request did not come from one. Without an explicit
 * allow-list only loopback origins and the server's own host (`host`, from the
 * request's Host header) are trusted; an opaque `null` origin never is. The
 * 2025-11-25 revision clarified that a rejected origin must be answered with 403.
 */
export function isOriginAllowed (origin: string | undefined, allowed: AllowedOrigins, host?: string): boolean {
  if (origin === undefined) return true
  if (allowed === true || allowed === '*') return true
  if (allowed === undefined) {
    const url = parseOrigin(origin)
    if (url === undefined) return false
    return isLoopbackHostname(url.hostname) || isSameHost(url, host)
  }
  // Never fall through to String.prototype.includes, a substring match
  if (!Array.isArray(allowed)) return false
  return allowed.includes(origin)
}

/**
 * Rate limiting helper for preventing abuse
 */
export class RateLimiter {
  private requests = new Map<string, number[]>()
  private readonly maxRequests: number
  private readonly windowMs: number

  constructor (maxRequests: number = 100, windowMs: number = 60000) {
    this.maxRequests = maxRequests
    this.windowMs = windowMs
  }

  /**
   * Check if a request should be allowed
   */
  isAllowed (identifier: string): boolean {
    const now = Date.now()
    const requests = this.requests.get(identifier) || []

    // Remove old requests outside the window
    const validRequests = requests.filter(time => now - time < this.windowMs)

    if (validRequests.length >= this.maxRequests) {
      return false
    }

    // Add current request
    validRequests.push(now)
    this.requests.set(identifier, validRequests)

    return true
  }

  /**
   * Clear old entries to prevent memory leaks
   */
  cleanup (): void {
    const now = Date.now()
    for (const [identifier, requests] of this.requests.entries()) {
      const validRequests = requests.filter(time => now - time < this.windowMs)
      if (validRequests.length === 0) {
        this.requests.delete(identifier)
      } else {
        this.requests.set(identifier, validRequests)
      }
    }
  }
}
