import type { FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify'
import type { AuthorizationConfig } from '../types/auth-types.ts'
import type { SessionStore } from '../stores/session-store.ts'
import { TokenValidator } from './token-validator.ts'
import { hashToken, createAuthorizationContext, createTokenRefreshInfo, shouldAttemptRefresh } from './token-utils.ts'

export interface SessionAuthPreHandlerOptions {
  config: AuthorizationConfig
  tokenValidator: TokenValidator
  sessionStore: SessionStore
  oauthClient?: any // OAuth client for token refresh
}

/**
 * Enhanced authorization prehandler that integrates with session management
 * This provides token-to-session mapping and automatic token refresh capabilities
 */
export function createSessionAuthPreHandler (
  options: SessionAuthPreHandlerOptions
): preHandlerHookHandler {
  const { config, tokenValidator, sessionStore, oauthClient } = options

  return async function sessionAuthPreHandler (request: FastifyRequest, reply: FastifyReply) {
    // Skip authorization if disabled
    if (!config.enabled) {
      return
    }

    // Skip authorization for well-known endpoints
    if (request.url.startsWith('/.well-known/')) {
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

    const tokenHash = hashToken(token)

    try {
      // First check if we have a session associated with this token
      const session = await sessionStore.getSessionByTokenHash(tokenHash)
      let authContext = session?.authorization

      // If no session or authorization context, validate the token and create context
      if (!session || !authContext) {
        const validationResult = await tokenValidator.validateToken(token)
        if (!validationResult.valid) {
          request.log.warn({ error: validationResult.error }, 'Token validation failed')
          return reply.code(401).header('WWW-Authenticate', generateWWWAuthenticateHeader(config)).send({
            error: 'invalid_token',
            error_description: validationResult.error || 'Token validation failed'
          })
        }

        // Create authorization context from validated token
        authContext = createAuthorizationContext(validationResult.payload, token, {
          authorizationServer: config.authorizationServers[0] // Use first auth server for now
        })

        request.log.debug({
          userId: authContext.userId,
          clientId: authContext.clientId,
          hasSession: !!session
        }, 'Token validated and authorization context created')
      } else {
        // Check if token needs refresh
        if (shouldAttemptRefresh(authContext, session.tokenRefresh) && oauthClient) {
          try {
            request.log.info({ sessionId: session.id }, 'Attempting token refresh')

            const refreshResult = await oauthClient.refreshToken(session.tokenRefresh!.refreshToken)

            // Update authorization context with new token
            const newAuthContext = createAuthorizationContext(
              // We'd need to decode the new token or use introspection to get payload
              { ...authContext, exp: refreshResult.expires_in ? Math.floor(Date.now() / 1000) + refreshResult.expires_in : undefined },
              refreshResult.access_token,
              {
                refreshToken: refreshResult.refresh_token || session.tokenRefresh!.refreshToken,
                authorizationServer: session.tokenRefresh!.authorizationServer
              }
            )

            const newRefreshInfo = createTokenRefreshInfo(
              refreshResult.refresh_token || session.tokenRefresh!.refreshToken,
              session.tokenRefresh!.clientId,
              session.tokenRefresh!.authorizationServer,
              session.tokenRefresh!.scopes
            )

            // Update session with new token info
            await sessionStore.updateAuthorization(session.id, newAuthContext, newRefreshInfo)

            authContext = newAuthContext
            request.log.info({ sessionId: session.id }, 'Token refreshed successfully')

            // Note: In a real implementation, we'd need to inform the client of the new token
            // This could be done via SSE or by including it in response headers
          } catch (refreshError) {
            request.log.warn({
              error: refreshError,
              sessionId: session.id
            }, 'Token refresh failed, proceeding with current token')
          }
        }

        request.log.debug({
          userId: authContext.userId,
          sessionId: session.id
        }, 'Using existing session authorization context')
      }

      // Add authorization context to request for downstream handlers
      // @ts-ignore - Adding custom property to request
      request.authContext = authContext
      // @ts-ignore - Adding custom property to request
      request.tokenPayload = {
        sub: authContext.userId,
        client_id: authContext.clientId,
        scope: authContext.scopes?.join(' '),
        aud: authContext.audience,
        exp: authContext.expiresAt ? Math.floor(authContext.expiresAt.getTime() / 1000) : undefined,
        iat: authContext.issuedAt ? Math.floor(authContext.issuedAt.getTime() / 1000) : undefined
      }

      // Store session association for SSE connections
      const sessionId = request.headers['mcp-session-id'] as string
      if (sessionId && (!session || session.id !== sessionId)) {
        // Link the token to the specific MCP session
        const mcpSession = await sessionStore.get(sessionId)
        if (mcpSession) {
          await sessionStore.updateAuthorization(sessionId, authContext, session?.tokenRefresh)
          request.log.debug({
            sessionId,
            userId: authContext.userId
          }, 'Linked token to MCP session')
        }
      }
    } catch (error) {
      request.log.error({ error }, 'Session-aware authorization failed')
      return reply.code(500).header('WWW-Authenticate', generateWWWAuthenticateHeader(config)).send({
        error: 'server_error',
        error_description: 'Internal authorization error'
      })
    }
  }
}

function generateWWWAuthenticateHeader (config: AuthorizationConfig): string {
  if (!config.enabled) {
    throw new Error('Authorization is disabled')
  }
  const resourceMetadataUrl = `${config.resourceUri}/.well-known/oauth-protected-resource`
  return `Bearer realm="MCP Server", resource_metadata="${resourceMetadataUrl}"`
}

// Type augmentation for FastifyRequest to include authorization context
declare module 'fastify' {
  interface FastifyRequest {
    authContext?: import('../types/auth-types.ts').AuthorizationContext
  }
}
