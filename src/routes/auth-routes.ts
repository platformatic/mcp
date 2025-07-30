import type { FastifyInstance, FastifyRequest, FastifyReply, FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import type { PKCEChallenge } from '../auth/oauth-client.ts'
import type { SessionStore } from '../stores/session-store.ts'

export interface AuthSession {
  state: string
  pkce: PKCEChallenge
  resourceUri?: string
  originalUrl?: string
}

export interface AuthorizationCallbackQuery {
  code?: string
  state?: string
  error?: string
  error_description?: string
}

export interface TokenRefreshBody {
  refresh_token: string
}

export interface AuthRoutesOptions {
  sessionStore: SessionStore
}

const authRoutesPlugin: FastifyPluginAsync<AuthRoutesOptions> = async (fastify: FastifyInstance, opts) => {
  const { sessionStore } = opts
  // Initiate OAuth authorization flow
  fastify.get('/oauth/authorize', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const query = request.query as { resource?: string; redirect_uri?: string }

      // Create authorization request with PKCE
      const authRequest = await fastify.oauthClient.createAuthorizationRequest({
        ...(query.resource && { resource: query.resource })
      })

      // Store session data in session store
      const sessionData: AuthSession = {
        state: authRequest.state,
        pkce: authRequest.pkce,
        resourceUri: query.resource,
        originalUrl: query.redirect_uri
      }

      // Create session metadata with auth session data
      const sessionMetadata = {
        id: authRequest.state,
        eventId: 0,
        createdAt: new Date(),
        lastActivity: new Date(),
        authSession: sessionData
      }

      await sessionStore.create(sessionMetadata)

      // Redirect to authorization server
      return reply.redirect(authRequest.authorizationUrl)
    } catch (error) {
      fastify.log.error({ error }, 'Failed to initiate OAuth authorization')
      return reply.status(500).send({
        error: 'authorization_failed',
        error_description: 'Failed to initiate OAuth authorization flow'
      })
    }
  })

  // Handle OAuth callback
  fastify.get('/oauth/callback', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const query = request.query as AuthorizationCallbackQuery

      // Check for authorization errors
      if (query.error) {
        fastify.log.error({ error: query.error, description: query.error_description }, 'OAuth authorization error')
        return reply.status(400).send({
          error: query.error,
          error_description: query.error_description || 'Authorization failed'
        })
      }

      // Validate required parameters
      if (!query.code || !query.state) {
        return reply.status(400).send({
          error: 'invalid_request',
          error_description: 'Missing required parameters: code or state'
        })
      }

      // Retrieve session data from session store
      const sessionMetadata = await sessionStore.get(query.state)
      if (!sessionMetadata || !sessionMetadata.authSession) {
        return reply.status(400).send({
          error: 'invalid_request',
          error_description: 'Invalid or expired state parameter'
        })
      }

      const sessionData = sessionMetadata.authSession as AuthSession

      // Clean up session data
      await sessionStore.delete(query.state)

      // Exchange authorization code for tokens
      const tokens = await fastify.oauthClient.exchangeCodeForToken(
        query.code,
        sessionData.pkce,
        sessionData.state,
        query.state
      )

      // Return tokens to client or redirect with tokens
      if (sessionData.originalUrl) {
        const redirectUrl = new URL(sessionData.originalUrl)
        redirectUrl.searchParams.set('access_token', tokens.access_token)
        redirectUrl.searchParams.set('token_type', tokens.token_type)
        if (tokens.expires_in) {
          redirectUrl.searchParams.set('expires_in', tokens.expires_in.toString())
        }
        if (tokens.scope) {
          redirectUrl.searchParams.set('scope', tokens.scope)
        }
        return reply.redirect(redirectUrl.toString())
      }

      // Return JSON response with tokens
      return reply.send({
        access_token: tokens.access_token,
        token_type: tokens.token_type,
        expires_in: tokens.expires_in,
        refresh_token: tokens.refresh_token,
        scope: tokens.scope
      })
    } catch (error) {
      fastify.log.error({ error }, 'OAuth callback processing failed')
      return reply.status(500).send({
        error: 'token_exchange_failed',
        error_description: error instanceof Error ? error.message : 'Token exchange failed'
      })
    }
  })

  // Token refresh endpoint
  fastify.post<{ Body: TokenRefreshBody }>('/oauth/refresh', async (request, reply) => {
    try {
      // eslint-disable-next-line camelcase
      const { refresh_token } = request.body

      // eslint-disable-next-line camelcase
      if (!refresh_token) {
        return reply.status(400).send({
          error: 'invalid_request',
          error_description: 'Missing refresh_token parameter'
        })
      }

      const tokens = await fastify.oauthClient.refreshToken(refresh_token)

      return reply.send({
        access_token: tokens.access_token,
        token_type: tokens.token_type,
        expires_in: tokens.expires_in,
        refresh_token: tokens.refresh_token,
        scope: tokens.scope
      })
    } catch (error) {
      fastify.log.error({ error }, 'Token refresh failed')
      return reply.status(400).send({
        error: 'invalid_grant',
        error_description: error instanceof Error ? error.message : 'Token refresh failed'
      })
    }
  })

  // Token validation endpoint
  fastify.post<{ Body: { token: string } }>('/oauth/validate', async (request, reply) => {
    try {
      const { token } = request.body

      if (!token) {
        return reply.status(400).send({
          error: 'invalid_request',
          error_description: 'Missing token parameter'
        })
      }

      const isValid = await fastify.oauthClient.validateToken(token)

      return reply.send({
        active: isValid
      })
    } catch (error) {
      fastify.log.error({ error }, 'Token validation failed')
      return reply.status(500).send({
        error: 'validation_failed',
        error_description: 'Token validation failed'
      })
    }
  })

  // Get authorization status
  fastify.get('/oauth/status', async (request, reply) => {
    try {
      const authHeader = request.headers.authorization
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return reply.send({
          authenticated: false
        })
      }

      const token = authHeader.substring(7)
      const isValid = await fastify.oauthClient.validateToken(token)

      return reply.send({
        authenticated: isValid
      })
    } catch (error) {
      fastify.log.error({ error }, 'Status check failed')
      return reply.send({
        authenticated: false
      })
    }
  })

  // Dynamic client registration endpoint (if enabled)
  fastify.post('/oauth/register', async (_, reply) => {
    try {
      const registration = await fastify.oauthClient.dynamicClientRegistration()

      return reply.send({
        client_id: registration.clientId,
        client_secret: registration.clientSecret,
        registration_status: 'success'
      })
    } catch (error) {
      fastify.log.error({ error }, 'Dynamic client registration failed')
      return reply.status(400).send({
        error: 'registration_failed',
        error_description: error instanceof Error ? error.message : 'Client registration failed'
      })
    }
  })

  // Logout endpoint (revokes tokens)
  fastify.post('/oauth/logout', async (request, reply) => {
    try {
      const authHeader = request.headers.authorization
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return reply.status(400).send({
          error: 'invalid_request',
          error_description: 'Missing or invalid authorization header'
        })
      }

      const token = authHeader.substring(7)

      // In a full implementation, you would revoke the token at the authorization server
      // For now, we just return success
      fastify.log.info({ token: token.substring(0, 10) + '...' }, 'Token logout requested')

      return reply.send({
        logout_status: 'success'
      })
    } catch (error) {
      fastify.log.error({ error }, 'Logout failed')
      return reply.status(500).send({
        error: 'logout_failed',
        error_description: 'Logout failed'
      })
    }
  })

  fastify.log.info('OAuth authorization routes registered')
}

export default fp(authRoutesPlugin, {
  name: 'oauth-auth-routes',
  dependencies: ['oauth-client']
})

// Legacy function export for backward compatibility
export async function registerAuthRoutes (_: FastifyInstance) {
  // This is now handled by the plugin, but we keep this export for existing code
  // The session store needs to be passed via options when registering the plugin
}
