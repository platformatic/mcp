import type { FastifyPluginAsync, FastifyBaseLogger } from 'fastify'
import fp from 'fastify-plugin'
import { createHash, randomBytes } from 'node:crypto'
import { validateTokenResponse, validateIntrospectionResponse, validateClientRegistrationResponse } from './oauth-schemas.ts'

export interface OAuthClientConfig {
  clientId?: string
  clientSecret?: string
  authorizationServer: string
  resourceUri?: string
  scopes?: string[]
  dynamicRegistration?: boolean
  /**
   * OAuth Client ID Metadata Document (SEP-991), the registration mechanism
   * recommended from 2025-11-25 on. When enabled we publish our client metadata
   * as JSON and use its HTTPS URL as the `client_id`, so no registration call —
   * dynamic or manual — is needed against the authorization server.
   *
   * Pass `true` for the default path, or an object to override it.
   */
  clientIdMetadataDocument?: boolean | { path?: string }
}

/** Where the client metadata document is served unless overridden */
export const DEFAULT_CLIENT_ID_METADATA_PATH = '/.well-known/oauth-client'

export interface PKCEChallenge {
  codeVerifier: string
  codeChallenge: string
  codeChallengeMethod: 'S256'
}

export interface AuthorizationRequest {
  authorizationUrl: string
  state: string
  pkce: PKCEChallenge
}

export interface TokenResponse {
  access_token: string
  token_type: string
  expires_in?: number
  refresh_token?: string
  scope?: string
}

export interface OAuthClientMethods {
  generatePKCEChallenge(): PKCEChallenge
  generateState(): string
  createAuthorizationRequest(additionalParams?: Record<string, string>): Promise<AuthorizationRequest>
  exchangeCodeForToken(code: string, pkce: PKCEChallenge, state: string, receivedState: string, redirectUri?: string): Promise<TokenResponse>
  refreshToken(refreshToken: string): Promise<TokenResponse>
  validateToken(accessToken: string): Promise<boolean>
  /**
   * Register a new OAuth client dynamically (RFC 7591).
   * @param clientMetadata Optional client metadata from the registration request.
   *                       If provided, merges with defaults (client metadata wins).
   */
  dynamicClientRegistration(clientMetadata?: Record<string, unknown>): Promise<{ clientId: string; clientSecret?: string }>
}

declare module 'fastify' {
  interface FastifyInstance {
    oauthClient: OAuthClientMethods
  }
}

// OIDC Discovery types
interface OIDCEndpoints {
  authorizationEndpoint: string
  tokenEndpoint: string
  introspectionEndpoint: string
  registrationEndpoint: string
}

// OIDC Discovery cache (per authorization server)
const discoveryCache = new Map<string, { endpoints: OIDCEndpoints; timestamp: number }>()
const DISCOVERY_CACHE_TTL = 5 * 60 * 1000 // 5 minutes

/**
 * Build the ordered list of metadata URLs to try for an issuer.
 *
 * The 2025-11-25 revision (SEP-797) requires supporting OpenID Connect Discovery
 * 1.0 alongside RFC 8414. Issuers with a path component have two spellings each,
 * so the full chain is:
 *
 * 1. RFC 8414 path-insertion:  `{origin}/.well-known/oauth-authorization-server{path}`
 * 2. OIDC path-insertion:      `{origin}/.well-known/openid-configuration{path}`
 * 3. OIDC path-appending:      `{issuer}/.well-known/openid-configuration`
 *
 * For an issuer without a path all three collapse to two distinct URLs.
 */
export function buildDiscoveryUrls (authorizationServer: string): string[] {
  const issuer = authorizationServer.replace(/\/$/, '')

  let origin: string
  let path: string
  try {
    const url = new URL(issuer)
    origin = url.origin
    path = url.pathname === '/' ? '' : url.pathname
  } catch {
    // Not a parseable URL; fall back to simple appending
    return [`${issuer}/.well-known/openid-configuration`]
  }

  const urls = [
    `${origin}/.well-known/oauth-authorization-server${path}`,
    `${origin}/.well-known/openid-configuration${path}`,
    `${issuer}/.well-known/openid-configuration`
  ]

  return [...new Set(urls)]
}

async function discoverOIDCEndpoints (
  authorizationServer: string,
  logger?: FastifyBaseLogger
): Promise<OIDCEndpoints> {
  const now = Date.now()
  const cached = discoveryCache.get(authorizationServer)

  if (cached && (now - cached.timestamp) < DISCOVERY_CACHE_TTL) {
    return cached.endpoints
  }

  for (const discoveryUrl of buildDiscoveryUrls(authorizationServer)) {
    try {
      logger?.info({ discoveryUrl }, 'OAuth client: fetching authorization server metadata')

      const response = await fetch(discoveryUrl)
      if (response.ok) {
        const metadata = await response.json() as Record<string, string>
        const endpoints: OIDCEndpoints = {
          authorizationEndpoint: metadata.authorization_endpoint,
          tokenEndpoint: metadata.token_endpoint,
          introspectionEndpoint: metadata.introspection_endpoint,
          registrationEndpoint: metadata.registration_endpoint
        }
        discoveryCache.set(authorizationServer, { endpoints, timestamp: now })
        logger?.info({ discoveryUrl, endpoints }, 'OAuth client: authorization server metadata discovered')
        return endpoints
      }
      logger?.debug({ discoveryUrl, status: response.status }, 'OAuth client: metadata endpoint returned non-OK, trying next')
    } catch (error) {
      logger?.debug({ discoveryUrl, error: error instanceof Error ? error.message : String(error) }, 'OAuth client: metadata fetch failed, trying next')
    }
  }

  logger?.warn({ authorizationServer }, 'OAuth client: discovery exhausted all well-known locations, using defaults')

  // Default endpoints (original behavior for backwards compatibility)
  const defaults: OIDCEndpoints = {
    authorizationEndpoint: `${authorizationServer}/oauth/authorize`,
    tokenEndpoint: `${authorizationServer}/oauth/token`,
    introspectionEndpoint: `${authorizationServer}/oauth/introspect`,
    registrationEndpoint: `${authorizationServer}/oauth/register`
  }
  discoveryCache.set(authorizationServer, { endpoints: defaults, timestamp: now })
  return defaults
}

/**
 * Build the client metadata document we publish when using CIMD (SEP-991).
 * `client_id` must equal the URL the document is served from.
 */
export function buildClientIdMetadataDocument (opts: OAuthClientConfig, documentUrl: string): Record<string, unknown> {
  return {
    client_id: documentUrl,
    client_name: 'MCP Server',
    client_uri: opts.resourceUri,
    redirect_uris: [`${opts.resourceUri}/oauth/callback`],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: (opts.scopes || ['read']).join(' ')
  }
}

const oauthClientPlugin: FastifyPluginAsync<OAuthClientConfig> = async (fastify, opts) => {
  // Discover OIDC endpoints on startup
  const endpoints = await discoverOIDCEndpoints(opts.authorizationServer, fastify.log)

  // SEP-991: publish a client metadata document and adopt its URL as our client_id
  if (opts.clientIdMetadataDocument) {
    const path = (typeof opts.clientIdMetadataDocument === 'object' && opts.clientIdMetadataDocument.path) ||
      DEFAULT_CLIENT_ID_METADATA_PATH

    if (!opts.resourceUri) {
      throw new Error('clientIdMetadataDocument requires resourceUri so the document URL can be resolved')
    }

    const documentUrl = `${opts.resourceUri.replace(/\/$/, '')}${path}`
    const document = buildClientIdMetadataDocument(opts, documentUrl)

    // The authorization server fetches this document unauthenticated to resolve
    // the client_id. The auth preHandler only exempts /.well-known, so a custom
    // path outside it would sit behind bearer auth and be unreachable (401).
    if (!path.startsWith('/.well-known/')) {
      fastify.log.warn({ path },
        'clientIdMetadataDocument path is outside /.well-known; add it to authorization.excludedPaths or the authorization server will get 401 when fetching it')
    }

    fastify.get(path, async (_request, reply) => {
      return reply.type('application/json').send(document)
    })

    // The document URL *is* the client identifier, so registration is unnecessary
    opts.clientId = documentUrl
    fastify.log.info({ documentUrl }, 'OAuth client: using Client ID Metadata Document as client_id')
  }

  // Our OAuth client implementation is completely independent and doesn't need @fastify/oauth2
  // @fastify/oauth2 can be optionally registered by users if they want the additional routes,
  // but our implementation provides all necessary OAuth client functionality

  const oauthClientMethods: OAuthClientMethods = {
    generatePKCEChallenge (): PKCEChallenge {
      const codeVerifier = randomBytes(32).toString('base64url')
      const codeChallenge = createHash('sha256')
        .update(codeVerifier)
        .digest('base64url')

      return {
        codeVerifier,
        codeChallenge,
        codeChallengeMethod: 'S256'
      }
    },

    generateState (): string {
      return randomBytes(16).toString('base64url')
    },

    async createAuthorizationRequest (additionalParams?: Record<string, string>): Promise<AuthorizationRequest> {
      const pkce = oauthClientMethods.generatePKCEChallenge()
      const state = oauthClientMethods.generateState()

      // Build authorization URL with PKCE and MCP-specific parameters
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: opts.clientId || '',
        state,
        code_challenge: pkce.codeChallenge,
        code_challenge_method: pkce.codeChallengeMethod,
        scope: (opts.scopes || ['read']).join(' '),
        ...additionalParams
      })

      // Add resource parameter if specified (MCP-specific)
      if (opts.resourceUri) {
        params.set('resource', opts.resourceUri)
      }

      const authorizationUrl = `${endpoints.authorizationEndpoint}?${params.toString()}`

      return {
        authorizationUrl,
        state,
        pkce
      }
    },

    async exchangeCodeForToken (
      code: string,
      pkce: PKCEChallenge,
      state: string,
      receivedState: string,
      redirectUri?: string
    ): Promise<TokenResponse> {
      // Validate state parameter to prevent CSRF
      if (state !== receivedState) {
        throw new Error('Invalid state parameter - possible CSRF attack')
      }

      try {
        const tokenResponse = await fetch(endpoints.tokenEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json'
          },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            client_id: opts.clientId || '',
            code_verifier: pkce.codeVerifier,
            ...(opts.clientSecret && { client_secret: opts.clientSecret }),
            // redirect_uri must match the one used in authorization request (required for OIDC)
            ...(redirectUri && { redirect_uri: redirectUri })
          }).toString()
        })

        if (!tokenResponse.ok) {
          const errorText = await tokenResponse.text()
          throw new Error(`Token exchange failed: ${tokenResponse.status} ${errorText}`)
        }

        const tokens = await tokenResponse.json() as TokenResponse

        // Validate token response structure with TypeBox
        if (!validateTokenResponse(tokens)) {
          throw new Error('Invalid token response: does not match OAuth 2.0 specification')
        }

        return tokens
      } catch (error) {
        throw new Error(`OAuth token exchange failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    },

    async refreshToken (refreshToken: string): Promise<TokenResponse> {
      if (!refreshToken) {
        throw new Error('Refresh token is required')
      }

      try {
        const tokenResponse = await fetch(endpoints.tokenEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json'
          },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: opts.clientId || '',
            ...(opts.clientSecret && { client_secret: opts.clientSecret })
          }).toString()
        })

        if (!tokenResponse.ok) {
          const errorText = await tokenResponse.text()
          throw new Error(`Token refresh failed: ${tokenResponse.status} ${errorText}`)
        }

        const tokens = await tokenResponse.json() as TokenResponse

        // Validate token response structure with TypeBox
        if (!validateTokenResponse(tokens)) {
          throw new Error('Invalid token response: does not match OAuth 2.0 specification')
        }

        return tokens
      } catch (error) {
        throw new Error(`OAuth token refresh failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    },

    async validateToken (accessToken: string): Promise<boolean> {
      try {
        const introspectionResponse = await fetch(endpoints.introspectionEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
            Authorization: `Bearer ${accessToken}`
          },
          body: new URLSearchParams({
            token: accessToken,
            token_type_hint: 'access_token'
          }).toString()
        })

        if (!introspectionResponse.ok) {
          return false
        }

        const introspection = await introspectionResponse.json()

        // Validate introspection response structure with TypeBox
        if (!validateIntrospectionResponse(introspection)) {
          return false
        }

        return (introspection as { active: boolean }).active === true
      } catch {
        return false
      }
    },

    async dynamicClientRegistration (clientMetadata?: Record<string, unknown>): Promise<{ clientId: string; clientSecret?: string }> {
      if (!opts.dynamicRegistration) {
        throw new Error('Dynamic client registration not enabled')
      }

      try {
        // Default client metadata (can be overridden by clientMetadata)
        const defaultMetadata = {
          client_name: 'MCP Server',
          client_uri: opts.resourceUri,
          redirect_uris: [`${opts.resourceUri}/oauth/callback`],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'client_secret_post',
          scope: (opts.scopes || ['read']).join(' ')
        }

        // Merge with client-provided metadata (client metadata wins)
        const payload = { ...defaultMetadata, ...clientMetadata }

        const registrationResponse = await fetch(endpoints.registrationEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json'
          },
          body: JSON.stringify(payload)
        })

        if (!registrationResponse.ok) {
          const errorText = await registrationResponse.text()
          throw new Error(`Client registration failed: ${registrationResponse.status} ${errorText}`)
        }

        const registration = await registrationResponse.json()

        // Validate registration response structure with TypeBox
        if (!validateClientRegistrationResponse(registration)) {
          throw new Error('Invalid registration response: does not match OAuth 2.0 specification')
        }

        const validatedRegistration = registration as { client_id: string; client_secret?: string }

        // Update config with new client credentials
        opts.clientId = validatedRegistration.client_id
        opts.clientSecret = validatedRegistration.client_secret

        return {
          clientId: validatedRegistration.client_id,
          clientSecret: validatedRegistration.client_secret
        }
      } catch (error) {
        throw new Error(`Dynamic client registration failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  // Decorate Fastify instance with OAuth client methods
  fastify.decorate('oauthClient', oauthClientMethods)

  // Add cleanup for any potential hanging connections
  fastify.addHook('onClose', async () => {
    // No specific cleanup needed for our implementation
    // @fastify/oauth2 should handle its own cleanup
  })
}

export default fp(oauthClientPlugin, {
  name: 'oauth-client',
  dependencies: []
})
