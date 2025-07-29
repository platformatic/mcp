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
    if (request.url.startsWith('/.well-known/')) {
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

    // Add token payload to request context for downstream handlers
    // @ts-ignore - Adding custom property to request
    request.tokenPayload = validationResult.payload

    request.log.debug({ sub: validationResult.payload?.sub }, 'Token validation successful')
  }
}

function generateWWWAuthenticateHeader (config: AuthorizationConfig): string {
  const resourceMetadataUrl = `${config.resourceUri}/.well-known/oauth-protected-resource`
  return `Bearer realm="MCP Server", resource_metadata="${resourceMetadataUrl}"`
}

// Type augmentation for FastifyRequest to include tokenPayload
declare module 'fastify' {
  interface FastifyRequest {
    tokenPayload?: any
  }
}
