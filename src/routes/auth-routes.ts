import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import { Type } from '@sinclair/typebox'
import type { PKCEChallenge } from '../auth/oauth-client.ts'
import type { SessionStore } from '../stores/session-store.ts'
import type { DCRHooks, DCRRequest, DCRResponse } from '../types/auth-types.ts'

export interface AuthSession {
  state: string
  pkce: PKCEChallenge
  resourceUri?: string
  originalUrl?: string
  callbackUrl?: string // The redirect_uri used in authorization request (required for OIDC token exchange)
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
  /** DCR hooks for custom request/response processing */
  dcrHooks?: DCRHooks
}

// TypeBox schemas for validation
const AuthorizeQuerystring = Type.Object({
  resource: Type.Optional(Type.String({ format: 'uri' })),
  redirect_uri: Type.Optional(Type.String({ format: 'uri' }))
})

const CallbackQuerystring = Type.Object({
  code: Type.Optional(Type.String()),
  state: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
  error_description: Type.Optional(Type.String())
})

const TokenRefreshBodySchema = Type.Object({
  refresh_token: Type.String()
})

const TokenValidateBody = Type.Object({
  token: Type.String()
})

const TokenResponse = Type.Object({
  access_token: Type.String(),
  token_type: Type.String(),
  expires_in: Type.Optional(Type.Number()),
  refresh_token: Type.Optional(Type.String()),
  scope: Type.Optional(Type.String())
})

const ErrorResponse = Type.Object({
  error: Type.String(),
  error_description: Type.Optional(Type.String())
})

const TokenValidationResponse = Type.Object({
  active: Type.Boolean()
})

const AuthStatusResponse = Type.Object({
  authenticated: Type.Boolean()
})

// DCR Request body schema (RFC 7591 Section 2)
const DynamicRegistrationRequest = Type.Object({
  client_name: Type.Optional(Type.String()),
  client_uri: Type.Optional(Type.String({ format: 'uri' })),
  redirect_uris: Type.Optional(Type.Array(Type.String({ format: 'uri' }))),
  grant_types: Type.Optional(Type.Array(Type.String())),
  response_types: Type.Optional(Type.Array(Type.String())),
  scope: Type.Optional(Type.String()),
  token_endpoint_auth_method: Type.Optional(Type.String()),
  logo_uri: Type.Optional(Type.String({ format: 'uri' })),
  tos_uri: Type.Optional(Type.String({ format: 'uri' })),
  policy_uri: Type.Optional(Type.String({ format: 'uri' })),
  contacts: Type.Optional(Type.Array(Type.String())),
  jwks_uri: Type.Optional(Type.String({ format: 'uri' })),
  software_id: Type.Optional(Type.String()),
  software_version: Type.Optional(Type.String())
}, { additionalProperties: true })

const DynamicRegistrationResponse = Type.Object({
  client_id: Type.String(),
  client_secret: Type.Optional(Type.String()),
  registration_status: Type.Optional(Type.String())
}, { additionalProperties: true })

const LogoutResponse = Type.Object({
  logout_status: Type.String()
})

const authRoutesPlugin: FastifyPluginAsync<AuthRoutesOptions> = async (fastify: FastifyInstance, opts) => {
  const { sessionStore } = opts
  // Initiate OAuth authorization flow
  fastify.get('/oauth/authorize', {
    schema: {
      querystring: AuthorizeQuerystring
    }
  }, async (request, reply) => {
    try {
      // eslint-disable-next-line camelcase
      const { resource, redirect_uri } = request.query as { resource?: string; redirect_uri?: string }

      // Build the callback URL for this server (required for OIDC compliance)
      const callbackUrl = `${request.protocol}://${request.host}/oauth/callback`

      // Create authorization request with PKCE and redirect_uri
      const authRequest = await fastify.oauthClient.createAuthorizationRequest({
        ...(resource && { resource }),
        redirect_uri: callbackUrl
      })

      // Store session data in session store
      const sessionData: AuthSession = {
        state: authRequest.state,
        pkce: authRequest.pkce,
        resourceUri: resource,
        // eslint-disable-next-line camelcase
        originalUrl: redirect_uri,
        callbackUrl // Store for token exchange (must match)
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
  fastify.get('/oauth/callback', {
    schema: {
      querystring: CallbackQuerystring,
      response: {
        200: TokenResponse,
        302: {},
        400: ErrorResponse,
        500: ErrorResponse
      }
    }
  }, async (request, reply) => {
    try {
      // eslint-disable-next-line camelcase
      const { code, state, error, error_description } = request.query as { code?: string; state?: string; error?: string; error_description?: string }

      // Check for authorization errors
      if (error) {
        // eslint-disable-next-line camelcase
        fastify.log.error({ error, description: error_description }, 'OAuth authorization error')
        return reply.status(400).send({
          error,
          // eslint-disable-next-line camelcase
          error_description: error_description || 'Authorization failed'
        })
      }

      // Validate required parameters
      if (!code || !state) {
        return reply.status(400).send({
          error: 'invalid_request',
          error_description: 'Missing required parameters: code or state'
        })
      }

      // Retrieve session data from session store
      const sessionMetadata = await sessionStore.get(state)
      if (!sessionMetadata || !sessionMetadata.authSession) {
        return reply.status(400).send({
          error: 'invalid_request',
          error_description: 'Invalid or expired state parameter'
        })
      }

      const sessionData = sessionMetadata.authSession as AuthSession

      // Clean up session data
      await sessionStore.delete(state)

      // Exchange authorization code for tokens (include redirect_uri for OIDC compliance)
      const tokens = await fastify.oauthClient.exchangeCodeForToken(
        code,
        sessionData.pkce,
        sessionData.state,
        state,
        sessionData.callbackUrl
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
  fastify.post('/oauth/refresh', {
    schema: {
      body: TokenRefreshBodySchema,
      response: {
        200: TokenResponse,
        400: ErrorResponse
      }
    }
  }, async (request, reply) => {
    try {
      // eslint-disable-next-line camelcase
      const { refresh_token } = request.body as { refresh_token: string }

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
  fastify.post('/oauth/validate', {
    schema: {
      body: TokenValidateBody,
      response: {
        200: TokenValidationResponse,
        400: ErrorResponse,
        500: ErrorResponse
      }
    }
  }, async (request, reply) => {
    try {
      const { token } = request.body as { token: string }

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
  fastify.get('/oauth/status', {
    schema: {
      response: {
        200: AuthStatusResponse
      }
    }
  }, async (request, reply) => {
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

  // Dynamic client registration endpoint (RFC 7591)
  //
  // When dcrHooks is configured: Acts as a proxy to upstreamEndpoint with hook interception.
  // This is required when the authorization server advertises this MCP server as its
  // registration_endpoint (to add custom logic like response cleaning).
  //
  // When dcrHooks is NOT configured: Returns 501 Not Implemented.
  // Clients should use the authorization server's DCR endpoint directly.
  // (Using oauth-client.dynamicClientRegistration here would cause an infinite loop
  // if OIDC discovery points back to this server.)
  fastify.post('/oauth/register', {
    schema: {
      body: DynamicRegistrationRequest,
      response: {
        200: DynamicRegistrationResponse,
        400: ErrorResponse,
        501: ErrorResponse,
        502: ErrorResponse
      }
    }
  }, async (request, reply) => {
    const { dcrHooks } = opts

    // DCR proxy requires hooks configuration
    if (!dcrHooks) {
      fastify.log.warn('DCR: request received but dcrHooks not configured')
      return reply.status(501).send({
        error: 'not_implemented',
        error_description: 'Dynamic client registration proxy not configured. Use the authorization server\'s registration endpoint directly.'
      })
    }

    let clientMetadata = (request.body || {}) as DCRRequest

    fastify.log.info({ dcrRequest: clientMetadata }, 'DCR: received registration request')

    try {
      // Call onRequest hook if defined
      if (dcrHooks.onRequest) {
        clientMetadata = await dcrHooks.onRequest(clientMetadata, fastify.log)
      }

      // Forward to upstream endpoint (explicit config avoids OIDC discovery loop)
      const upstreamResponse = await fetch(dcrHooks.upstreamEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify(clientMetadata)
      })

      if (!upstreamResponse.ok) {
        const errorText = await upstreamResponse.text()
        fastify.log.warn(
          { status: upstreamResponse.status, error: errorText },
          'DCR: upstream registration failed'
        )
        // Try to parse as JSON error, fallback to text
        try {
          const errorJson = JSON.parse(errorText)
          return reply.status(400).send(errorJson)
        } catch {
          return reply.status(400).send({
            error: 'registration_failed',
            error_description: errorText
          })
        }
      }

      let dcrResponse = await upstreamResponse.json() as DCRResponse

      fastify.log.info(
        { clientId: dcrResponse.client_id },
        'DCR: upstream registration successful'
      )

      // Call onResponse hook if defined
      if (dcrHooks.onResponse) {
        dcrResponse = await dcrHooks.onResponse(dcrResponse, clientMetadata, fastify.log)
      }

      return reply.status(200).send(dcrResponse)
    } catch (error) {
      fastify.log.error({ error }, 'DCR: registration failed')

      // Network error - upstream unreachable
      if (error instanceof TypeError && error.message.includes('fetch')) {
        return reply.status(502).send({
          error: 'bad_gateway',
          error_description: 'Failed to communicate with upstream authorization server'
        })
      }

      return reply.status(400).send({
        error: 'registration_failed',
        error_description: error instanceof Error ? error.message : 'Client registration failed'
      })
    }
  })

  // Logout endpoint (revokes tokens)
  fastify.post('/oauth/logout', {
    schema: {
      response: {
        200: LogoutResponse,
        400: ErrorResponse,
        500: ErrorResponse
      }
    }
  }, async (request, reply) => {
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
