export type AuthorizationConfig =
  | {
    enabled: false
  }
  | {
    enabled: true
    authorizationServers: string[]
    resourceUri: string
    tokenValidation: {
      introspectionEndpoint?: string
      jwksUri?: string
      validateAudience?: boolean
    }
    // Discovery options for OpenID Connect and OAuth 2.0 AS Metadata
    discoveryMethod?: 'oauth' | 'oidc' | 'auto'  // Default: 'auto'

    // Client registration options
    clientRegistration?: {
      method: 'metadata-document' | 'dynamic' | 'manual'
      metadataUrl?: string      // For metadata-document method
      clientId?: string         // For manual method
      clientSecret?: string     // For manual method
      scopes?: string[]         // Requested scopes
      jwks_uri?: string        // JWKS URI for private_key_jwt
    }

    // Scope management
    defaultScopes?: string[]             // Default scopes to request
    scopeChallengeEnabled?: boolean      // Enable incremental scope consent (default: true)

    // Legacy OAuth client configuration (for backward compatibility)
    oauth2Client?: {
      clientId?: string
      clientSecret?: string
      authorizationServer: string
      resourceUri?: string
      scopes?: string[]
      dynamicRegistration?: boolean
    }
  }

export interface TokenValidationResult {
  valid: boolean
  payload?: any
  error?: string
}

export interface ProtectedResourceMetadata {
  resource: string
  authorization_servers: string[]
  scopes_supported?: string[]              // Optional list of supported scopes
  bearer_methods_supported?: string[]      // Optional list of bearer token methods
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

/**
 * OAuth 2.0 Authorization Server Metadata
 * Supports both OAuth 2.0 AS Metadata (RFC 8414) and OpenID Connect Discovery
 */
export interface AuthorizationServerMetadata {
  issuer: string
  authorization_endpoint?: string
  token_endpoint?: string
  jwks_uri?: string
  registration_endpoint?: string
  scopes_supported?: string[]
  response_types_supported?: string[]
  response_modes_supported?: string[]
  grant_types_supported?: string[]
  token_endpoint_auth_methods_supported?: string[]
  introspection_endpoint?: string
  revocation_endpoint?: string
  code_challenge_methods_supported?: string[]

  // OpenID Connect specific fields
  userinfo_endpoint?: string
  id_token_signing_alg_values_supported?: string[]
  subject_types_supported?: string[]

  // Additional metadata
  service_documentation?: string
  [key: string]: unknown
}

/**
 * OAuth 2.0 Client Metadata for Client ID Metadata Documents
 * Per draft spec, this is the RECOMMENDED method for client registration
 */
export interface ClientMetadata {
  client_id: string               // MUST be HTTPS URL with path component
  client_name: string
  redirect_uris: string[]
  grant_types: string[]
  token_endpoint_auth_method: 'none' | 'private_key_jwt' | 'client_secret_basic' | 'client_secret_post'
  jwks_uri?: string              // For private_key_jwt
  jwks?: {                       // Alternative to jwks_uri
    keys: Array<{
      kty: string
      use?: string
      key_ops?: string[]
      alg?: string
      kid?: string
      [key: string]: unknown
    }>
  }
  scope?: string                 // Space-delimited scope values
  contacts?: string[]            // Email addresses
  logo_uri?: string
  policy_uri?: string
  tos_uri?: string
  [key: string]: unknown
}
