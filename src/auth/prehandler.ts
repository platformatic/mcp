import type { FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify'
import type { AuthorizationConfig } from '../types/auth-types.ts'
import { TokenValidator } from './token-validator.ts'

export function createAuthPreHandler (
  config: AuthorizationConfig,
  tokenValidator: TokenValidator
): preHandlerHookHandler {
  return async function authPreHandler (request: FastifyRequest, reply: FastifyReply) {
    // Skip authorization if disabled
    if (!config.enabled) {
      return
    }

    // Skip authorization for well-known endpoints
    if (request.url.startsWith('/.well-known/') || request.url.startsWith('/mcp/.well-known')) {
      return
    }

    // Skip authorization for OAuth flow endpoints (authorize initiates, callback receives code, register is pre-auth)
    if (request.url.startsWith('/oauth/authorize') || request.url.startsWith('/oauth/callback') || request.url.startsWith('/oauth/register')) {
      return
    }

    // Skip authorization for custom excluded paths
    if (config.excludedPaths?.some(path =>
      typeof path === 'string' ? request.url.startsWith(path) : path.test(request.url)
    )) {
      return
    }

    // Extract Bearer token from Authorization header
    const authHeader = request.headers.authorization
    if (!authHeader) {
      return reply.code(401).header('WWW-Authenticate', generateWWWAuthenticateHeader(config)).send({
        error: 'authorization_required',
        error_description: 'Authorization header required'
      })
    }

    if (!authHeader.startsWith('Bearer ')) {
      return reply.code(401).header('WWW-Authenticate', generateWWWAuthenticateHeader(config)).send({
        error: 'invalid_token',
        error_description: 'Authorization header must use Bearer scheme'
      })
    }

    const token = authHeader.substring(7) // Remove 'Bearer ' prefix
    if (!token) {
      return reply.code(401).header('WWW-Authenticate', generateWWWAuthenticateHeader(config)).send({
        error: 'invalid_token',
        error_description: 'Bearer token is empty'
      })
    }

    // Validate the token
    const validationResult = await tokenValidator.validateToken(token)
    if (!validationResult.valid) {
      request.log.warn({ error: validationResult.error }, 'Token validation failed')

      return reply.code(401).header('WWW-Authenticate', generateWWWAuthenticateHeader(config)).send({
        error: 'invalid_token',
        error_description: validationResult.error || 'Token validation failed'
      })
    }

    // SEP-835: the token is good but may not carry everything this resource needs.
    // Name the missing scopes so the client can run an incremental consent flow.
    const missingScopes = findMissingScopes(config.requiredScopes, validationResult.payload)
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

export function findMissingScopes (required: string[] | undefined, payload: any): string[] {
  if (!required || required.length === 0) return []
  const granted = new Set(extractTokenScopes(payload))
  return required.filter(scope => !granted.has(scope))
}

interface WWWAuthenticateChallenge {
  error?: string
  scope?: string[]
}

function generateWWWAuthenticateHeader (config: AuthorizationConfig, challenge: WWWAuthenticateChallenge = {}): string {
  if (!config.enabled) {
    throw new Error('Authorization is disabled')
  }
  const resourceMetadataUrl = `${config.resourceUri}/.well-known/oauth-protected-resource`
  const params = ['realm="MCP Server"', `resource_metadata="${resourceMetadataUrl}"`]

  if (challenge.error) {
    params.push(`error="${challenge.error}"`)
  }
  if (challenge.scope && challenge.scope.length > 0) {
    params.push(`scope="${challenge.scope.join(' ')}"`)
  }

  return `Bearer ${params.join(', ')}`
}

// Type augmentation for FastifyRequest to include tokenPayload
declare module 'fastify' {
  interface FastifyRequest {
    tokenPayload?: any
  }
}
