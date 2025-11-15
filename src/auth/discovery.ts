import type { AuthorizationServerMetadata } from '../types/auth-types.ts'

/**
 * Discovers authorization server metadata using OAuth 2.0 AS Metadata (RFC 8414)
 * and OpenID Connect Discovery.
 *
 * The discovery process attempts endpoints in the following order:
 * 1. OAuth 2.0 AS Metadata endpoints (preferred for OAuth 2.1)
 * 2. OpenID Connect Discovery endpoints
 *
 * @param issuer - The authorization server issuer URL
 * @param method - Discovery method: 'oauth' (OAuth 2.0 AS Metadata only),
 *                'oidc' (OpenID Connect Discovery only), or 'auto' (try both)
 * @returns Authorization server metadata
 * @throws Error if discovery fails or returns invalid metadata
 */
export async function discoverAuthorizationServer (
  issuer: string,
  method: 'oauth' | 'oidc' | 'auto' = 'auto'
): Promise<AuthorizationServerMetadata> {
  // Normalize issuer (remove trailing slash)
  const normalizedIssuer = issuer.replace(/\/$/, '')

  // Build discovery endpoint URLs
  const endpoints: string[] = []

  if (method === 'oauth' || method === 'auto') {
    // OAuth 2.0 AS Metadata endpoints (RFC 8414)
    // Try issuer with and without path component
    endpoints.push(`${normalizedIssuer}/.well-known/oauth-authorization-server`)

    // For issuers with paths, also try at the root
    const issuerUrl = new URL(normalizedIssuer)
    if (issuerUrl.pathname && issuerUrl.pathname !== '/') {
      const pathComponent = issuerUrl.pathname
      endpoints.push(
        `${issuerUrl.origin}/.well-known/oauth-authorization-server${pathComponent}`
      )
    }
  }

  if (method === 'oidc' || method === 'auto') {
    // OpenID Connect Discovery endpoints
    endpoints.push(`${normalizedIssuer}/.well-known/openid-configuration`)

    // For issuers with paths
    const issuerUrl = new URL(normalizedIssuer)
    if (issuerUrl.pathname && issuerUrl.pathname !== '/') {
      const pathComponent = issuerUrl.pathname
      endpoints.push(
        `${issuerUrl.origin}/.well-known/openid-configuration${pathComponent}`
      )
    }
  }

  // Try each endpoint in order
  let lastError: Error | null = null

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        headers: {
          Accept: 'application/json'
        }
      })

      if (!response.ok) {
        lastError = new Error(
          `Discovery endpoint returned ${response.status}: ${endpoint}`
        )
        continue
      }

      const metadata = await response.json() as AuthorizationServerMetadata

      // Validate required fields
      if (!metadata.issuer) {
        lastError = new Error('Discovery metadata missing required "issuer" field')
        continue
      }

      // Verify issuer matches (security requirement)
      if (metadata.issuer !== normalizedIssuer) {
        lastError = new Error(
          `Issuer mismatch: expected ${normalizedIssuer}, got ${metadata.issuer}`
        )
        continue
      }

      // Successfully discovered metadata
      return metadata
    } catch (error) {
      lastError = error instanceof Error
        ? error
        : new Error(`Discovery failed for ${endpoint}`)
    }
  }

  // All endpoints failed
  throw new Error(
    `Authorization server discovery failed for issuer "${normalizedIssuer}": ${lastError?.message || 'Unknown error'}`
  )
}

/**
 * Fetches JWKS (JSON Web Key Set) from the provided URI.
 *
 * @param jwksUri - The URI to fetch JWKS from
 * @returns The JWKS object containing public keys
 * @throws Error if fetch fails or returns invalid JWKS
 */
export async function fetchJWKS (jwksUri: string): Promise<{
  keys: Array<{
    kty: string
    use?: string
    key_ops?: string[]
    alg?: string
    kid?: string
    [key: string]: unknown
  }>
}> {
  try {
    const response = await fetch(jwksUri, {
      headers: {
        Accept: 'application/json'
      }
    })

    if (!response.ok) {
      throw new Error(`JWKS fetch returned ${response.status}`)
    }

    const jwks = await response.json() as {
      keys: Array<{
        kty: string
        use?: string
        key_ops?: string[]
        alg?: string
        kid?: string
        [key: string]: unknown
      }>
    }

    if (!jwks.keys || !Array.isArray(jwks.keys)) {
      throw new Error('Invalid JWKS: missing or invalid "keys" array')
    }

    return jwks
  } catch (error) {
    throw new Error(
      `Failed to fetch JWKS from ${jwksUri}: ${error instanceof Error ? error.message : 'Unknown error'}`
    )
  }
}

/**
 * Fetches OAuth 2.0 Client Metadata from a Client ID Metadata Document URL.
 *
 * Per the draft spec, this is the RECOMMENDED method for client registration.
 * The client_id MUST be an HTTPS URL with a path component.
 *
 * @param clientId - The client ID (HTTPS URL)
 * @returns The client metadata document
 * @throws Error if fetch fails, client_id is invalid, or metadata is invalid
 */
export async function fetchClientMetadata (clientId: string): Promise<any> {
  // Validate client_id is HTTPS URL with path
  let clientUrl: URL
  try {
    clientUrl = new URL(clientId)
  } catch {
    throw new Error('client_id must be a valid URL')
  }

  if (clientUrl.protocol !== 'https:') {
    throw new Error('client_id must use HTTPS protocol')
  }

  if (!clientUrl.pathname || clientUrl.pathname === '/') {
    throw new Error('client_id must include a path component')
  }

  try {
    const response = await fetch(clientId, {
      headers: {
        Accept: 'application/json'
      }
    })

    if (!response.ok) {
      throw new Error(`Client metadata fetch returned ${response.status}`)
    }

    const metadata = await response.json() as any

    // Validate required fields
    if (metadata.client_id !== clientId) {
      throw new Error(
        `Client ID mismatch: expected ${clientId}, got ${metadata.client_id as string}`
      )
    }

    if (!metadata.client_name) {
      throw new Error('Client metadata missing required "client_name" field')
    }

    if (!metadata.redirect_uris || !Array.isArray(metadata.redirect_uris)) {
      throw new Error('Client metadata missing required "redirect_uris" array')
    }

    return metadata as import('../types/auth-types.ts').ClientMetadata
  } catch (error) {
    throw new Error(
      `Failed to fetch client metadata from ${clientId}: ${error instanceof Error ? error.message : 'Unknown error'}`
    )
  }
}
