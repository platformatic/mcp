import { createVerifier } from 'fast-jwt'
import type { FastifyInstance } from 'fastify'
import { JwksCache } from './jwks.ts'
import type { AuthorizationConfig, TokenValidationResult, TokenIntrospectionResponse } from '../types/auth-types.ts'

const INTROSPECTION_TIMEOUT_MS = 5_000

/**
 * Issuers we accept, derived from the configured authorization servers.
 *
 * RFC 8414 says `iss` must match the issuer identifier exactly, but providers
 * disagree on whether that identifier carries a trailing slash (Auth0 does,
 * most others do not), and operators copy whichever form they see first. Accept
 * both spellings of each configured server and nothing else: no prefix or
 * path matching, so `https://auth.example.com.evil` stays rejected.
 */
export function buildAllowedIssuers (authorizationServers: string[]): string[] {
  const allowed = new Set<string>()
  for (const server of authorizationServers) {
    const base = normalizeIssuer(server)
    allowed.add(base)
    allowed.add(`${base}/`)
  }
  return [...allowed]
}

/**
 * Canonical form of an issuer identifier: the two spellings
 * `buildAllowedIssuers` accepts for one server collapse to the same value.
 */
export function normalizeIssuer (issuer: string): string {
  return issuer.replace(/\/+$/, '')
}

/**
 * The key set of each issuer, keyed by its canonical form. A single `jwksUri`
 * belongs to the first authorization server; a map names the issuer of each.
 */
function keySetsByIssuer (authorizationServers: string[], jwksUri: string | Record<string, string> | undefined): Map<string, JwksCache> {
  const keySets = new Map<string, JwksCache>()
  if (typeof jwksUri === 'string') {
    if (authorizationServers.length > 0) keySets.set(normalizeIssuer(authorizationServers[0]), new JwksCache(jwksUri))
  } else if (jwksUri) {
    const caches = new Map<string, JwksCache>()
    for (const [issuer, uri] of Object.entries(jwksUri)) {
      let cache = caches.get(uri)
      if (!cache) {
        cache = new JwksCache(uri)
        caches.set(uri, cache)
      }
      keySets.set(normalizeIssuer(issuer), cache)
    }
  }
  return keySets
}

export class TokenValidator {
  private jwtVerifier?: any
  private config: AuthorizationConfig
  private fastify: FastifyInstance
  private allowedIssuers: string[] = []

  constructor (config: AuthorizationConfig, fastify: FastifyInstance) {
    this.config = config
    this.fastify = fastify

    // Early return if authorization is disabled - no need to set up JWT validation
    if (!config.enabled) {
      return
    }

    this.allowedIssuers = buildAllowedIssuers(config.authorizationServers)

    const keySets = keySetsByIssuer(config.authorizationServers, config.tokenValidation.jwksUri)
    if (keySets.size > 0) {
      this.jwtVerifier = createVerifier({
        // A key proves who signed the token only when it comes from the key
        // set of the issuer the token names: one authorization server's key
        // must not vouch for a subject at another.
        key: async (obj: { header?: { kid?: string; alg?: string }, payload?: { iss?: unknown } } = {}) => {
          const header = obj.header || {}
          const iss = obj.payload?.iss
          const jwks = typeof iss === 'string' ? keySets.get(normalizeIssuer(iss)) : undefined
          if (!jwks) throw new Error('No signing keys for this issuer')
          return await jwks.getPublicKey(header.kid, header.alg)
        },

        algorithms: ['RS256', 'ES256'],
        // Only tokens minted by our own authorization servers, bound to a subject
        // (sessions are keyed on it) and with a bounded lifetime.
        allowedIss: this.allowedIssuers,
        requiredClaims: ['iss', 'sub', 'exp']
      })
    }
  }

  async validateToken (token: string): Promise<TokenValidationResult> {
    if (!this.config.enabled) {
      return { valid: false, error: 'Authorization is disabled' }
    }

    let jwtFailure: string | undefined

    try {
      // Try JWT validation first if JWKS is configured
      if (this.jwtVerifier) {
        try {
          const payload = await this.jwtVerifier(token)

          // Sessions, tasks and sealed state are bound to the subject, so it
          // must be a usable identifier, as introspection already requires.
          if (typeof payload.sub !== 'string' || payload.sub === '') {
            return { valid: false, error: 'Invalid subject claim' }
          }

          // Validate audience if required
          if (this.config.tokenValidation.validateAudience) {
            if (!this.validateAudience(payload)) {
              return {
                valid: false,
                error: 'Invalid audience claim'
              }
            }
          }

          return {
            valid: true,
            payload,
            // fast-jwt has already checked `iss` against allowedIss
            issuer: normalizeIssuer(payload.iss)
          }
        } catch (jwtError) {
          this.fastify.log.warn({ err: jwtError }, 'JWT validation failed, trying introspection')
          jwtFailure = describeJwtError(jwtError)
        }
      }

      // Fall back to token introspection if available
      if (this.config.tokenValidation.introspectionEndpoint) {
        return await this.introspectToken(token)
      }

      if (jwtFailure) {
        return { valid: false, error: jwtFailure }
      }

      return {
        valid: false,
        error: 'No token validation method configured'
      }
    } catch (error) {
      this.fastify.log.error({ err: error }, 'Token validation error')
      return {
        valid: false,
        error: error instanceof Error ? error.message : 'Unknown validation error'
      }
    }
  }

  private validateAudience (payload: any): boolean {
    if (!this.config.enabled || !payload.aud) {
      return false
    }

    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
    return audiences.includes(this.config.resourceUri)
  }

  private async introspectToken (token: string): Promise<TokenValidationResult> {
    if (!this.config.enabled || !this.config.tokenValidation.introspectionEndpoint) {
      return {
        valid: false,
        error: 'No introspection endpoint configured'
      }
    }

    try {
      // Build headers with optional introspection authentication
      const headers: Record<string, string> = {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      }

      // Apply introspection auth based on config
      const introspectionAuth = this.config.tokenValidation.introspectionAuth
      if (introspectionAuth) {
        if (introspectionAuth.type === 'bearer') {
          headers.Authorization = `Bearer ${introspectionAuth.token}`
        } else if (introspectionAuth.type === 'basic') {
          const credentials = Buffer.from(
            `${introspectionAuth.clientId}:${introspectionAuth.clientSecret}`
          ).toString('base64')
          headers.Authorization = `Basic ${credentials}`
        }
        // type === 'none' - no auth header added
      }

      const response = await fetch(this.config.tokenValidation.introspectionEndpoint, {
        method: 'POST',
        headers,
        body: new URLSearchParams({
          token,
          token_type_hint: 'access_token'
        }),
        // Any bearer string reaches here, so a stalled endpoint must not hold
        // each request that carries one.
        signal: AbortSignal.timeout(INTROSPECTION_TIMEOUT_MS)
      })

      if (!response.ok) {
        return {
          valid: false,
          error: `Introspection failed with status ${response.status}`
        }
      }

      const result = await response.json() as TokenIntrospectionResponse

      // RFC 7662 §2.2: `active` is a boolean; anything but true is inactive.
      if (result?.active !== true) {
        return {
          valid: false,
          error: 'Token is not active'
        }
      }

      // RFC 7662 makes `iss` optional, but when the server reports it, it must be
      // one of ours.
      if (result.iss !== undefined && !this.allowedIssuers.includes(result.iss)) {
        return {
          valid: false,
          error: 'Invalid issuer claim'
        }
      }

      // Sessions are bound to the token subject, so a token without one cannot
      // be used against this resource server.
      if (typeof result.sub !== 'string' || result.sub === '') {
        return {
          valid: false,
          error: 'Missing subject claim'
        }
      }

      // Validate audience if required
      if (this.config.tokenValidation.validateAudience) {
        if (!result.aud || !this.validateIntrospectionAudience(result.aud)) {
          return {
            valid: false,
            error: 'Invalid audience claim'
          }
        }
      }

      // RFC 7662 lets the server omit `iss`. The response then speaks only for
      // the introspection endpoint we were configured to trust, so that endpoint
      // is the issuer identity. It is never confused with a real issuer: a
      // response that does report `iss` was checked against
      // authorizationServers above and is identified by it.
      const issuer = result.iss !== undefined
        ? normalizeIssuer(result.iss)
        : `introspection:${this.config.tokenValidation.introspectionEndpoint}`

      return {
        valid: true,
        payload: result,
        issuer
      }
    } catch (error) {
      this.fastify.log.error({ err: error, endpoint: this.config.tokenValidation.introspectionEndpoint }, 'Token introspection failed')
      return {
        valid: false,
        error: error instanceof Error ? error.message : 'Introspection request failed'
      }
    }
  }

  private validateIntrospectionAudience (aud: string | string[]): boolean {
    if (!this.config.enabled) {
      return false
    }
    const audiences = Array.isArray(aud) ? aud : [aud]
    return audiences.includes(this.config.resourceUri)
  }

  close (): void {
    // Nothing to release: the key cache holds no timers or connections.
  }
}

// Map fast-jwt failures to fixed descriptions: the library messages can
// include claim values from the token, which must not be echoed to clients.
function describeJwtError (err: unknown): string {
  switch ((err as { code?: string } | null)?.code) {
    case 'FAST_JWT_EXPIRED':
      return 'Token expired'
    case 'FAST_JWT_INACTIVE':
      return 'Token not yet valid'
    case 'FAST_JWT_INVALID_SIGNATURE':
    case 'FAST_JWT_MISSING_SIGNATURE':
      return 'Invalid token signature'
    default:
      return 'Invalid token'
  }
}
