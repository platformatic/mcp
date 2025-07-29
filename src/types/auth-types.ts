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
