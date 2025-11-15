import type { FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify'
import type { AuthorizationConfig, AuthorizationContext } from '../types/auth-types.ts'
import { TokenValidator } from './token-validator.ts'
import { createAuthChallenge, parseTokenScopes } from './scope-challenge.ts'

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

    // Skip authorization for the start of the OAuth authorization flow.
    if (request.url.startsWith('/oauth/authorize')) {
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

    // Build authorization context from token payload
    const scopes = parseTokenScopes(validationResult.payload)
    const authContext: AuthorizationContext = {
      userId: validationResult.payload?.sub,
      clientId: validationResult.payload?.client_id,
      scopes,
      audience: Array.isArray(validationResult.payload?.aud)
        ? validationResult.payload.aud
        : validationResult.payload?.aud
          ? [validationResult.payload.aud]
          : undefined,
      tokenType: 'Bearer',
      expiresAt: validationResult.payload?.exp
        ? new Date(validationResult.payload.exp * 1000)
        : undefined,
      issuedAt: validationResult.payload?.iat
        ? new Date(validationResult.payload.iat * 1000)
        : undefined,
      authorizationServer: validationResult.payload?.iss
    }

    // Add auth context to request for downstream handlers
    // @ts-ignore - Adding custom property to request
    request.authContext = authContext

    // Keep tokenPayload for backward compatibility
    // @ts-ignore - Adding custom property to request
    request.tokenPayload = validationResult.payload

    request.log.debug({ sub: authContext.userId, scopes: authContext.scopes }, 'Token validation successful')
  }
}

function generateWWWAuthenticateHeader (config: AuthorizationConfig): string {
  if (!config.enabled) {
    throw new Error('Authorization is disabled')
  }
  const resourceMetadataUrl = `${config.resourceUri}/.well-known/oauth-protected-resource`
  return createAuthChallenge('invalid_token', undefined, resourceMetadataUrl, 'MCP Server')
}

// Type augmentation for FastifyRequest to include tokenPayload and authContext
declare module 'fastify' {
  interface FastifyRequest {
    tokenPayload?: any
    authContext?: AuthorizationContext
  }
}
