import type { FastifyBaseLogger } from 'fastify'

// =============================================================================
// Introspection Authentication
// =============================================================================

/**
 * Configuration for authenticating to the token introspection endpoint.
 * Different OAuth providers require different auth methods for introspection.
 */
export type IntrospectionAuthConfig =
  | { type: 'bearer'; token: string }                         // API key as bearer token (e.g., Ory)
  | { type: 'basic'; clientId: string; clientSecret: string } // Client credentials (RFC 7662)
  | { type: 'none' }                                          // Token sent in body only (default)

// =============================================================================
// Dynamic Client Registration (DCR)
// =============================================================================

/**
 * DCR Request body (RFC 7591 Section 2).
 * Client metadata sent during dynamic registration.
 */
export interface DCRRequest {
  client_name?: string
  client_uri?: string
  redirect_uris: string[]
  grant_types?: string[]
  response_types?: string[]
  scope?: string
  token_endpoint_auth_method?: string
  logo_uri?: string
  tos_uri?: string
  policy_uri?: string
  contacts?: string[]
  jwks_uri?: string
  software_id?: string
  software_version?: string
  [key: string]: unknown
}

/**
 * DCR Response body (RFC 7591 Section 3.2.1).
 * Client information returned after successful registration.
 */
export interface DCRResponse {
  client_id: string
  client_secret?: string
  client_name?: string
  redirect_uris?: string[]
  grant_types?: string[]
  response_types?: string[]
  scope?: string
  client_uri?: string
  logo_uri?: string
  tos_uri?: string
  policy_uri?: string
  contacts?: string[] | null
  registration_access_token?: string
  registration_client_uri?: string
  client_id_issued_at?: number
  client_secret_expires_at?: number
  [key: string]: unknown
}

/**
 * DCR Hooks for custom request/response processing.
 * Allows intercepting DCR flow for logging, transformation, or proxying.
 */
export interface DCRHooks {
  /**
   * Upstream DCR endpoint URL.
   * REQUIRED to avoid infinite loop when OIDC discovery points to self.
   * This bypasses the discovered registration_endpoint.
   */
  upstreamEndpoint: string

  /**
   * Called before forwarding request to upstream.
   * Use to enrich, validate, or transform the DCR request.
   */
  onRequest?: (
    request: DCRRequest,
    log: FastifyBaseLogger
  ) => Promise<DCRRequest> | DCRRequest

  /**
   * Called after receiving upstream response, before returning to client.
   * Use to clean, transform, or enrich the DCR response.
   */
  onResponse?: (
    response: DCRResponse,
    request: DCRRequest,
    log: FastifyBaseLogger
  ) => Promise<DCRResponse> | DCRResponse
}

// =============================================================================
// Authorization Configuration
// =============================================================================

export type AuthorizationConfig =
  | {
    enabled: false
  }
  | {
    enabled: true
    authorizationServers: string[]
    resourceUri: string
    /** Paths to exclude from authorization (e.g., health checks). Supports string prefix or RegExp. */
    excludedPaths?: (string | RegExp)[]
    tokenValidation: {
      introspectionEndpoint?: string
      jwksUri?: string
      validateAudience?: boolean
      /**
       * How to authenticate to the introspection endpoint.
       * - 'bearer': Use API key as Bearer token (e.g., Ory admin API)
       * - 'basic': Use client credentials (RFC 7662 standard)
       * - 'none': No auth header, token sent in body only (default)
       */
      introspectionAuth?: IntrospectionAuthConfig
    }
    oauth2Client?: {
      clientId?: string
      clientSecret?: string
      authorizationServer: string
      resourceUri?: string
      scopes?: string[]
      dynamicRegistration?: boolean
    }
    /**
     * DCR hooks for custom request/response processing.
     * When configured, the /oauth/register endpoint acts as a proxy
     * to the upstreamEndpoint with hook interception.
     */
    dcrHooks?: DCRHooks
  }

export interface TokenValidationResult {
  valid: boolean
  payload?: any
  error?: string
}

export interface ProtectedResourceMetadata {
  resource: string
  authorization_servers: string[]
}

export interface TokenIntrospectionResponse {
  active: boolean
  scope?: string
  client_id?: string
  username?: string
  token_type?: string
  exp?: number
  iat?: number
  nbf?: number
  sub?: string
  aud?: string | string[]
  iss?: string
  jti?: string
}

export interface AuthorizationContext {
  userId?: string              // Subject from token
  clientId?: string           // OAuth client ID
  scopes?: string[]           // Token scopes as array
  audience?: string[]         // Token audience
  tokenType?: string          // Token type (Bearer, etc.)
  tokenHash?: string          // Hash of the token for mapping
  expiresAt?: Date           // Token expiration time
  issuedAt?: Date            // Token issued time
  refreshToken?: string      // Associated refresh token (encrypted)
  authorizationServer?: string // Which auth server issued the token
  sessionBoundToken?: string  // Token bound to this specific session (hashed)
}

export interface TokenRefreshInfo {
  refreshToken: string        // Encrypted refresh token
  clientId: string           // OAuth client ID for refresh
  authorizationServer: string // Authorization server URL
  scopes: string[]           // Original scopes
  lastRefreshAt?: Date       // When token was last refreshed
  refreshAttempts?: number   // Number of refresh attempts
}
