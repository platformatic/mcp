import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import { Type } from '@sinclair/typebox'
import { BEARER_SCHEME, SKIP_BEARER_AUTH } from '../auth/prehandler.ts'
import { AUTHORIZATION_STATE_TTL_MS, MemoryAuthorizationStateStore } from '../auth/authorization-state-store.ts'
import type { AuthSession, AuthorizationStateStore } from '../auth/authorization-state-store.ts'
import type { DCRHooks, DCRRequest, DCRResponse } from '../types/auth-types.ts'

export type { AuthSession } from '../auth/authorization-state-store.ts'

/** Cookie tying a pending authorization to the browser that started it. */
export const AUTHORIZATION_STATE_COOKIE = 'mcp_oauth_state'

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
  /** Where pending authorization requests wait for their callback (default: in memory). */
  stateStore?: AuthorizationStateStore
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

function stateCookie (callbackUrl: string | undefined, value: string, ttlMs: number): string {
  const url = callbackUrl ? new URL(callbackUrl) : undefined
  const attributes = [
    `${AUTHORIZATION_STATE_COOKIE}=${encodeURIComponent(value)}`,
    `Path=${url?.pathname ?? '/'}`,
    `Max-Age=${Math.floor(ttlMs / 1000)}`,
    'HttpOnly',
    // Lax still sends it on the authorization server's top-level redirect back
    'SameSite=Lax'
  ]
  if (url?.protocol === 'https:') attributes.push('Secure')
  return attributes.join('; ')
}

function readCookie (header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator === -1 || part.slice(0, separator).trim() !== name) continue
    try {
      return decodeURIComponent(part.slice(separator + 1).trim())
    } catch {
      return undefined
    }
  }
  return undefined
}

const authRoutesPlugin: FastifyPluginAsync<AuthRoutesOptions> = async (fastify: FastifyInstance, opts) => {
  const stateStore = opts.stateStore ?? new MemoryAuthorizationStateStore()

  // Initiate OAuth authorization flow
  fastify.get('/oauth/authorize', {
    config: { [SKIP_BEARER_AUTH]: true },
    schema: {
      querystring: AuthorizeQuerystring
    }
  }, async (request, reply) => {
    try {
      const { resource, redirect_uri: redirectUri } = request.query as { resource?: string; redirect_uri?: string }

      // MCP clients authorize directly with the advertised authorization
      // server. This endpoint must not proxy tokens to a client callback.
      if (redirectUri) {
        return reply.status(400).send({
          error: 'invalid_request',
          error_description: 'redirect_uri is not supported'
        })
      }

      // The callback comes from configuration, the same one the client
      // metadata advertises: a Host header is the caller's to choose.
      const callbackUrl = fastify.oauthClient.redirectUri
      if (!callbackUrl) {
        fastify.log.error('OAuth authorization needs oauth2Client.resourceUri or oauth2Client.redirectUri to build its callback URL')
        return reply.status(500).send({
          error: 'server_error',
          error_description: 'The OAuth callback URL is not configured'
        })
      }

      // Create authorization request with PKCE and redirect_uri
      const authRequest = await fastify.oauthClient.createAuthorizationRequest({
        ...(resource && { resource }),
        redirect_uri: callbackUrl
      })

      const sessionData: AuthSession = {
        state: authRequest.state,
        pkce: authRequest.pkce,
        resourceUri: resource,
        callbackUrl // Store for token exchange (must match)
      }
      await stateStore.put(authRequest.state, sessionData, AUTHORIZATION_STATE_TTL_MS)

      // The callback only completes in the browser that started the flow
      // (RFC 9700 Section 4.7.1): a callback URL from someone else's login
      // carries a state this browser never received.
      reply.header('Set-Cookie', stateCookie(callbackUrl, authRequest.state, AUTHORIZATION_STATE_TTL_MS))
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
    config: { [SKIP_BEARER_AUTH]: true },
    schema: {
      querystring: CallbackQuerystring,
      response: {
        200: TokenResponse,
        400: ErrorResponse,
        500: ErrorResponse
      }
    }
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    reply.header('Pragma', 'no-cache')

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

      if (readCookie(request.headers.cookie, AUTHORIZATION_STATE_COOKIE) !== state) {
        return reply.status(400).send({
          error: 'invalid_request',
          error_description: 'This authorization was not started from this browser'
        })
      }

      // Read and removed in one step: a state is redeemed once
      const sessionData = await stateStore.take(state)
      if (!sessionData) {
        return reply.status(400).send({
          error: 'invalid_request',
          error_description: 'Invalid or expired state parameter'
        })
      }
      reply.header('Set-Cookie', stateCookie(sessionData.callbackUrl, '', 0))

      // Exchange authorization code for tokens (include redirect_uri for OIDC compliance)
      const tokens = await fastify.oauthClient.exchangeCodeForToken(
        code,
        sessionData.pkce,
        sessionData.state,
        state,
        sessionData.callbackUrl
      )

      // Never place access tokens in redirect URIs. Keep the legacy JSON
      // response for server-side OAuth client callers; MCP clients obtain their
      // own tokens directly from the authorization server.
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
    reply.header('Cache-Control', 'no-store')
    reply.header('Pragma', 'no-cache')

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
      const match = authHeader && BEARER_SCHEME.exec(authHeader)
      if (!match) {
        return reply.send({
          authenticated: false
        })
      }

      const token = match[1]
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
    config: { [SKIP_BEARER_AUTH]: true },
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
      const match = authHeader && BEARER_SCHEME.exec(authHeader)
      if (!match) {
        return reply.status(400).send({
          error: 'invalid_request',
          error_description: 'Missing or invalid authorization header'
        })
      }

      const token = match[1]

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
