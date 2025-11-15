/**
 * Creates a WWW-Authenticate header value for insufficient scope errors.
 *
 * Per the draft MCP spec and RFC 6750, when a request lacks sufficient scopes,
 * the server SHOULD return 403 Forbidden with a WWW-Authenticate header that
 * includes the required scopes in the scope parameter.
 *
 * This enables incremental scope consent, allowing clients to request additional
 * scopes without requiring full re-authorization.
 *
 * @param requiredScopes - Array of scopes required for the requested operation
 * @param resourceMetadataUrl - URL to the protected resource metadata endpoint
 * @param realm - Optional realm parameter
 * @returns WWW-Authenticate header value
 *
 * @example
 * ```typescript
 * const challenge = createScopeChallenge(
 *   ['mcp:tools', 'mcp:resources'],
 *   'https://api.example.com/.well-known/oauth-protected-resource'
 * )
 * // Returns: 'Bearer error="insufficient_scope", scope="mcp:tools mcp:resources", resource_metadata="https://..."'
 * ```
 */
export function createScopeChallenge (
  requiredScopes: string[],
  resourceMetadataUrl: string,
  realm?: string
): string {
  const params: string[] = []

  // Add realm if provided
  if (realm) {
    params.push(`realm="${realm}"`)
  }

  // Error code per RFC 6750 section 3.1
  params.push('error="insufficient_scope"')

  // Required scopes as space-delimited list
  if (requiredScopes.length > 0) {
    const scopeValue = requiredScopes.join(' ')
    params.push(`scope="${scopeValue}"`)
  }

  // Protected resource metadata URL for discovery
  params.push(`resource_metadata="${resourceMetadataUrl}"`)

  return `Bearer ${params.join(', ')}`
}

/**
 * Creates a WWW-Authenticate header value for invalid token errors.
 *
 * Per RFC 6750, when a request includes an invalid access token,
 * the server SHOULD return 401 Unauthorized with a WWW-Authenticate header.
 *
 * @param error - Error code (e.g., 'invalid_token', 'invalid_request')
 * @param errorDescription - Optional human-readable error description
 * @param resourceMetadataUrl - URL to the protected resource metadata endpoint
 * @param realm - Optional realm parameter
 * @returns WWW-Authenticate header value
 */
export function createAuthChallenge (
  error: string,
  errorDescription?: string,
  resourceMetadataUrl?: string,
  realm?: string
): string {
  const params: string[] = []

  // Add realm if provided
  if (realm) {
    params.push(`realm="${realm}"`)
  }

  // Error code
  params.push(`error="${error}"`)

  // Optional error description
  if (errorDescription) {
    params.push(`error_description="${errorDescription}"`)
  }

  // Protected resource metadata URL for discovery
  if (resourceMetadataUrl) {
    params.push(`resource_metadata="${resourceMetadataUrl}"`)
  }

  return `Bearer ${params.join(', ')}`
}

/**
 * Parses scopes from a token payload.
 *
 * OAuth 2.0 tokens may include scopes as either:
 * - A space-delimited string in the 'scope' field
 * - An array of strings in the 'scope' or 'scopes' field
 *
 * @param tokenPayload - The decoded token payload
 * @returns Array of scope strings
 */
export function parseTokenScopes (tokenPayload: any): string[] {
  if (!tokenPayload) {
    return []
  }

  // Try 'scope' field first (standard OAuth 2.0)
  if (typeof tokenPayload.scope === 'string') {
    return tokenPayload.scope.split(' ').filter(Boolean)
  }

  if (Array.isArray(tokenPayload.scope)) {
    return tokenPayload.scope.filter((s: unknown) => typeof s === 'string')
  }

  // Try 'scopes' field (alternative)
  if (Array.isArray(tokenPayload.scopes)) {
    return tokenPayload.scopes.filter((s: unknown) => typeof s === 'string')
  }

  return []
}

/**
 * Checks if a token has all required scopes.
 *
 * @param tokenScopes - Scopes present in the token
 * @param requiredScopes - Scopes required for the operation
 * @returns True if token has all required scopes
 */
export function hasRequiredScopes (
  tokenScopes: string[],
  requiredScopes: string[]
): boolean {
  if (requiredScopes.length === 0) {
    return true // No scopes required
  }

  const tokenScopeSet = new Set(tokenScopes)

  return requiredScopes.every(scope => tokenScopeSet.has(scope))
}

/**
 * Extracts missing scopes from a token.
 *
 * @param tokenScopes - Scopes present in the token
 * @param requiredScopes - Scopes required for the operation
 * @returns Array of missing scopes
 */
export function getMissingScopes (
  tokenScopes: string[],
  requiredScopes: string[]
): string[] {
  const tokenScopeSet = new Set(tokenScopes)

  return requiredScopes.filter(scope => !tokenScopeSet.has(scope))
}
