import { createHash } from 'node:crypto'
import type { AuthorizationContext, TokenRefreshInfo } from '../types/auth-types.ts'

/**
 * Creates a hash of the token for secure mapping to sessions
 * Uses SHA-256 to create a consistent hash that doesn't expose the token
 */
export function hashToken (token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Parses token scopes from space-delimited string to array
 */
export function parseScopes (scopeString?: string): string[] {
  if (!scopeString) return []
  return scopeString.split(' ').filter(scope => scope.length > 0)
}

/**
 * Converts token scopes from array back to space-delimited string
 */
export function formatScopes (scopes: string[]): string {
  return scopes.join(' ')
}

/**
 * Creates authorization context from token payload and additional info
 */
export function createAuthorizationContext (
  tokenPayload: any,
  token: string,
  options: {
    refreshToken?: string
    authorizationServer?: string
  } = {}
): AuthorizationContext {
  const tokenHash = hashToken(token)

  return {
    userId: tokenPayload.sub,
    clientId: tokenPayload.client_id || tokenPayload.azp, // azp = authorized party
    scopes: parseScopes(tokenPayload.scope),
    audience: Array.isArray(tokenPayload.aud) ? tokenPayload.aud : tokenPayload.aud ? [tokenPayload.aud] : undefined,
    tokenType: 'Bearer',
    tokenHash,
    expiresAt: tokenPayload.exp ? new Date(tokenPayload.exp * 1000) : undefined,
    issuedAt: tokenPayload.iat ? new Date(tokenPayload.iat * 1000) : undefined,
    refreshToken: options.refreshToken,
    authorizationServer: options.authorizationServer || tokenPayload.iss,
    sessionBoundToken: tokenHash // Same as tokenHash for now, but could be different for session-bound tokens
  }
}

/**
 * Creates token refresh info from token response and context
 */
export function createTokenRefreshInfo (
  refreshToken: string,
  clientId: string,
  authorizationServer: string,
  scopes: string[]
): TokenRefreshInfo {
  return {
    refreshToken,
    clientId,
    authorizationServer,
    scopes,
    lastRefreshAt: new Date(),
    refreshAttempts: 0
  }
}

/**
 * Checks if a token is expired or close to expiration
 */
export function isTokenExpiring (context: AuthorizationContext, bufferMinutes: number = 5): boolean {
  if (!context.expiresAt) {
    return false // No expiration info, assume valid
  }

  const now = new Date()
  const bufferTime = bufferMinutes * 60 * 1000 // Convert to milliseconds
  const expirationWithBuffer = new Date(context.expiresAt.getTime() - bufferTime)

  return now >= expirationWithBuffer
}

/**
 * Checks if a refresh should be attempted
 */
export function shouldAttemptRefresh (
  context: AuthorizationContext,
  refreshInfo?: TokenRefreshInfo,
  maxAttempts: number = 3
): boolean {
  if (!refreshInfo?.refreshToken) {
    return false
  }

  if (!isTokenExpiring(context)) {
    return false
  }

  const attempts = refreshInfo.refreshAttempts || 0
  return attempts < maxAttempts
}
