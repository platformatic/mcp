import type { FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify'
import type { AuthorizationConfig, ScopeImplies } from '../types/auth-types.ts'
import { TokenValidator } from './token-validator.ts'
import { isStdioRequest } from '../stdio-trust.ts'
import { getResourceMetadataUrl } from './resource-metadata.ts'

/** Route config key marking the plugin's own pre-authorization OAuth routes. */
export const SKIP_BEARER_AUTH = 'mcpSkipBearerAuth'

const ABSOLUTE_FORM = /^https?:\/\/.*?\//

/**
 * The path the router matched for this request, worked out the way
 * find-my-way does it: absolute-form targets lose their origin, the path
 * ends at the first `?` or `#` (or `;` with `useSemicolonDelimiter`), and it
 * is percent-decoded. Exclusions must see the same path the router routed,
 * or a suffix the router ignores could select an excluded path. Returns
 * undefined when the path cannot be decoded, so nothing is excluded.
 */
function routedPath (request: FastifyRequest): string | undefined {
  const config = request.server.initialConfig as { useSemicolonDelimiter?: boolean, routerOptions?: { useSemicolonDelimiter?: boolean } }
  const semicolon = config.routerOptions?.useSemicolonDelimiter ?? config.useSemicolonDelimiter ?? false
  let path = request.url
  if (path.charCodeAt(0) !== 47) {
    path = path.replace(ABSOLUTE_FORM, '/')
  }
  for (let i = 0; i < path.length; i++) {
    const char = path.charCodeAt(i)
    if (char === 63 || char === 35 || (char === 59 && semicolon)) {
      path = path.slice(0, i)
      break
    }
  }
  try {
    return decodeURI(path)
  } catch {
    return undefined
  }
}

export const BEARER_SCHEME = /^bearer +(.*)$/i

export function createAuthPreHandler (
  config: AuthorizationConfig,
  tokenValidator: TokenValidator
): preHandlerHookHandler {
  return async function authPreHandler (request: FastifyRequest, reply: FastifyReply) {
    // Skip authorization if disabled
    if (!config.enabled) {
      return
    }

    // stdio is a local transport: the spec has it take credentials from the
    // environment, not from HTTP bearer tokens, and only the in-process stdio
    // transport can present this token.
    if (isStdioRequest(request)) {
      return
    }

    // Skip authorization for the discovery and OAuth flow endpoints this
    // plugin registers (metadata, authorize, callback, register). They are
    // marked on the route, so an application route whose URL merely starts
    // the same way stays protected.
    if ((request.routeOptions.config as unknown as Record<string, unknown> | undefined)?.[SKIP_BEARER_AUTH] === true) {
      return
    }

    const pathname = routedPath(request)
    if (pathname !== undefined) {
      // A well-known URL that matches no route answers 404, not 401, so
      // clients probing discovery locations can tell "not here" apart.
      if (request.is404 && pathname.startsWith('/.well-known/')) {
        return
      }

      // Skip authorization for custom excluded paths. They match the routed
      // path only: the query string and fragment are the caller's to choose.
      if (config.excludedPaths?.some(path =>
        typeof path === 'string' ? pathname.startsWith(path) : path.test(pathname)
      )) {
        return
      }
    }

    // Extract Bearer token from Authorization header
    const authHeader = request.headers.authorization
    if (!authHeader) {
      return reply.code(401).header('WWW-Authenticate', generateWWWAuthenticateHeader(config)).send({
        error: 'authorization_required',
        error_description: 'Authorization header required'
      })
    }

    // The auth-scheme is case-insensitive (RFC 7235 Section 2.1, RFC 6750 Section 2.1)
    const match = BEARER_SCHEME.exec(authHeader)
    if (!match) {
      return sendInvalidToken(reply, config, 'Authorization header must use Bearer scheme')
    }

    const token = match[1]
    if (!token) {
      return sendInvalidToken(reply, config, 'Bearer token is empty')
    }

    // Validate the token
    const validationResult = await tokenValidator.validateToken(token)
    if (!validationResult.valid) {
      request.log.warn({ error: validationResult.error }, 'Token validation failed')

      return sendInvalidToken(reply, config, validationResult.error || 'Token validation failed')
    }

    // SEP-835: the token is good but may not carry everything this resource needs.
    // Name the missing scopes so the client can run an incremental consent flow.
    const missingScopes = findMissingScopes(config.requiredScopes, validationResult.payload, config.scopeImplies)
    if (missingScopes.length > 0) {
      request.log.warn({ missingScopes }, 'Token is missing required scopes')

      return reply
        .code(403)
        .header('WWW-Authenticate', generateWWWAuthenticateHeader(config, {
          error: 'insufficient_scope',
          scope: config.requiredScopes
        }))
        .send({
          error: 'insufficient_scope',
          error_description: `Token is missing required scope(s): ${missingScopes.join(', ')}`
        })
    }

    // Add token payload to request context for downstream handlers
    // @ts-ignore - Adding custom property to request
    request.tokenPayload = validationResult.payload
    request.tokenIssuer = validationResult.issuer

    request.log.debug({ sub: validationResult.payload?.sub }, 'Token validation successful')
  }
}

/**
 * Read the scopes off a validated token, tolerating both the space-delimited
 * `scope` string of RFC 6749 and the `scopes` array some issuers emit.
 */
export function extractTokenScopes (payload: any): string[] {
  if (!payload) return []
  if (typeof payload.scope === 'string') {
    return payload.scope.split(' ').filter(Boolean)
  }
  if (Array.isArray(payload.scopes)) {
    return payload.scopes
  }
  return []
}

export function findMissingScopes (
  required: string[] | undefined,
  payload: any,
  scopeImplies?: ScopeImplies
): string[] {
  if (!required || required.length === 0) return []
  const granted = extractTokenScopes(payload)
  if (!scopeImplies) {
    const grantedSet = new Set(granted)
    return required.filter(scope => !grantedSet.has(scope))
  }
  return required.filter(scope => !granted.some(g => scopeImplies(g, scope)))
}

/**
 * `scopeImplies` implementation for the `resource:action` convention: a granted
 * scope implies itself and every scope nested below it with `:`, so `files`
 * satisfies `files:read`, but `files:read` does not satisfy `files` and
 * `filesystem` does not satisfy `files:read`.
 */
export function colonScopeHierarchy (granted: string, required: string): boolean {
  if (granted === required) return true
  return granted.length > 0 && required.startsWith(granted + ':')
}

/**
 * Reply 401 with an RFC 6750 §3.1 `invalid_token` challenge, mirroring the
 * error and description in both the WWW-Authenticate header and the body.
 */
export function sendInvalidToken (reply: FastifyReply, config: AuthorizationConfig, description: string) {
  return reply
    .code(401)
    .header('WWW-Authenticate', generateWWWAuthenticateHeader(config, {
      error: 'invalid_token',
      error_description: description
    }))
    .send({
      error: 'invalid_token',
      error_description: description
    })
}

interface WWWAuthenticateChallenge {
  error?: string
  error_description?: string
  scope?: string[]
}

/**
 * RFC 6750 §3 restricts error_description to %x20-21 / %x23-5B / %x5D-7E,
 * so drop anything else (quotes, backslashes, control and non-ASCII chars)
 * rather than letting validation messages break out of the quoted-string.
 */
function sanitizeErrorDescription (description: string): string {
  return description.replace(/[^\x20\x21\x23-\x5B\x5D-\x7E]/g, '')
}

export function generateWWWAuthenticateHeader (config: AuthorizationConfig, challenge: WWWAuthenticateChallenge = {}): string {
  if (!config.enabled) {
    throw new Error('Authorization is disabled')
  }
  const resourceMetadataUrl = getResourceMetadataUrl(config.resourceUri)
  const params = ['realm="MCP Server"', `resource_metadata="${resourceMetadataUrl}"`]

  if (challenge.error) {
    params.push(`error="${challenge.error}"`)
  }
  if (challenge.error_description) {
    params.push(`error_description="${sanitizeErrorDescription(challenge.error_description)}"`)
  }
  // Advertise the required scopes on every challenge, including the first 401,
  // so clients know what to request up front (MCP authorization, scope selection).
  const scope = challenge.scope ?? config.requiredScopes
  if (scope && scope.length > 0) {
    params.push(`scope="${scope.join(' ')}"`)
  }

  return `Bearer ${params.join(', ')}`
}

// Type augmentation for FastifyRequest to include tokenPayload
declare module 'fastify' {
  interface FastifyRequest {
    tokenPayload?: any
    /** Canonical issuer identity of the validated token, see TokenValidationResult.issuer */
    tokenIssuer?: string
  }
}
