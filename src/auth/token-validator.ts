import buildGetJwks from 'get-jwks'
import { createVerifier } from 'fast-jwt'
import type { FastifyInstance } from 'fastify'
import type { AuthorizationConfig, TokenValidationResult, TokenIntrospectionResponse } from '../types/auth-types.ts'

// Canonicalise an audience for comparison: lowercase scheme and host and strip
// a single trailing slash, so `https://MCP.example.com/` matches
// `https://mcp.example.com`. Non-URL audiences are compared as-is.
export function normalizeAudience (value: string): string {
  let normalized = value
  try {
    // URL lowercases scheme and host (and adds `/` to an empty path)
    normalized = new URL(value).href
  } catch {
    // Not a URL, fall back to the raw string
  }
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized
}

export class TokenValidator {
  private getJwks?: any
  private jwtVerifier?: any
  private config: AuthorizationConfig
  private fastify: FastifyInstance

  constructor (config: AuthorizationConfig, fastify: FastifyInstance) {
    this.config = config
    this.fastify = fastify

    // Early return if authorization is disabled - no need to set up JWT validation
    if (!config.enabled) {
      return
    }

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

        algorithms: ['RS256', 'ES256']
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

          // Validate audience unless explicitly disabled
          if (this.config.tokenValidation.validateAudience !== false) {
            if (!this.validateAudience(payload.aud)) {
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

  private validateAudience (aud: unknown): boolean {
    if (!this.config.enabled || !aud) {
      return false
    }

    const expected = normalizeAudience(this.config.resourceUri)
    const audiences = Array.isArray(aud) ? aud : [aud]
    return audiences.some((value) => typeof value === 'string' && normalizeAudience(value) === expected)
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

      // Validate audience unless explicitly disabled
      if (this.config.tokenValidation.validateAudience !== false) {
        if (!this.validateAudience(result.aud)) {
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

  close (): void {
    // Cleanup if needed
    if (this.getJwks) {
      // get-jwks doesn't expose a close method, but the cache will be garbage collected
    }
  }
}
