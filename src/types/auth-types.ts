export interface AuthorizationConfig {
  enabled: boolean
  authorizationServers: string[]
  resourceUri: string
  tokenValidation: {
    introspectionEndpoint?: string
    jwksUri?: string
    validateAudience: boolean
  }
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
