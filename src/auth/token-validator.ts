import buildGetJwks from 'get-jwks'
import { createVerifier } from 'fast-jwt'
import type { FastifyInstance } from 'fastify'
import type { AuthorizationConfig, TokenValidationResult, TokenIntrospectionResponse } from '../types/auth-types.ts'

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
        ttl: 600000 // 10 minutes
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
      const response = await fetch(this.config.tokenValidation.introspectionEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json'
        },
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
