import buildGetJwks from 'get-jwks'
import { createVerifier } from 'fast-jwt'
import type { FastifyInstance } from 'fastify'
import type { AuthorizationConfig, TokenValidationResult, TokenIntrospectionResponse } from '../types/auth-types.ts'

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
    const base = server.replace(/\/+$/, '')
    allowed.add(base)
    allowed.add(`${base}/`)
  }
  return [...allowed]
}

export class TokenValidator {
  private getJwks?: any
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

    if (config.tokenValidation.jwksUri) {
      // Extract domain from JWKS URI
      const jwksUrl = new URL(config.tokenValidation.jwksUri)
      const domain = `${jwksUrl.protocol}//${jwksUrl.host}`

      this.getJwks = buildGetJwks({
        max: 50,
        ttl: 600000, // 10 minutes
        jwksPath: jwksUrl.pathname
      })

      this.jwtVerifier = createVerifier({
        key: async (obj: { header?: { kid?: string; alg?: string } } = {}) => {
          const header = obj.header || {}
          const publicKey = await this.getJwks!.getPublicKey({
            kid: header.kid,
            alg: header.alg,
            domain,
          })
          return publicKey
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

    try {
      // Try JWT validation first if JWKS is configured
      if (this.jwtVerifier) {
        try {
          const payload = await this.jwtVerifier(token)

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
            payload
          }
        } catch (jwtError) {
          this.fastify.log.warn({ err: jwtError }, 'JWT validation failed, trying introspection')
        }
      }

      // Fall back to token introspection if available
      if (this.config.tokenValidation.introspectionEndpoint) {
        return await this.introspectToken(token)
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
        })
      })

      if (!response.ok) {
        return {
          valid: false,
          error: `Introspection failed with status ${response.status}`
        }
      }

      const result = await response.json() as TokenIntrospectionResponse

      if (!result.active) {
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

      return {
        valid: true,
        payload: result
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
    // Cleanup if needed
    if (this.getJwks) {
      // get-jwks doesn't expose a close method, but the cache will be garbage collected
    }
  }
}
