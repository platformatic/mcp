import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import { createHash, randomBytes } from 'node:crypto'
import { validateTokenResponse, validateIntrospectionResponse, validateClientRegistrationResponse } from './oauth-schemas.ts'

export interface OAuthClientConfig {
  clientId?: string
  clientSecret?: string
  authorizationServer: string
  resourceUri?: string
  scopes?: string[]
  dynamicRegistration?: boolean
}

export interface PKCEChallenge {
  codeVerifier: string
  codeChallenge: string
  codeChallengeMethod: 'S256'
}

export interface AuthorizationRequest {
  authorizationUrl: string
  state: string
  pkce: PKCEChallenge
}

export interface TokenResponse {
  access_token: string
  token_type: string
  expires_in?: number
  refresh_token?: string
  scope?: string
}

export interface OAuthClientMethods {
  generatePKCEChallenge(): PKCEChallenge
  generateState(): string
  createAuthorizationRequest(additionalParams?: Record<string, string>): Promise<AuthorizationRequest>
  exchangeCodeForToken(code: string, pkce: PKCEChallenge, state: string, receivedState: string): Promise<TokenResponse>
  refreshToken(refreshToken: string): Promise<TokenResponse>
  validateToken(accessToken: string): Promise<boolean>
  dynamicClientRegistration(): Promise<{ clientId: string; clientSecret?: string }>
}

declare module 'fastify' {
  interface FastifyInstance {
    oauthClient: OAuthClientMethods
  }
}

const oauthClientPlugin: FastifyPluginAsync<OAuthClientConfig> = async (fastify, opts) => {
  // Our OAuth client implementation is completely independent and doesn't need @fastify/oauth2
  // @fastify/oauth2 can be optionally registered by users if they want the additional routes,
  // but our implementation provides all necessary OAuth client functionality

  const oauthClientMethods: OAuthClientMethods = {
    generatePKCEChallenge (): PKCEChallenge {
      const codeVerifier = randomBytes(32).toString('base64url')
      const codeChallenge = createHash('sha256')
        .update(codeVerifier)
        .digest('base64url')

      return {
        codeVerifier,
        codeChallenge,
        codeChallengeMethod: 'S256'
      }
    },

    generateState (): string {
      return randomBytes(16).toString('base64url')
    },

    async createAuthorizationRequest (additionalParams?: Record<string, string>): Promise<AuthorizationRequest> {
      const pkce = oauthClientMethods.generatePKCEChallenge()
      const state = oauthClientMethods.generateState()

      // Build authorization URL with PKCE and MCP-specific parameters
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: opts.clientId || '',
        state,
        code_challenge: pkce.codeChallenge,
        code_challenge_method: pkce.codeChallengeMethod,
        scope: (opts.scopes || ['read']).join(' '),
        ...additionalParams
      })

      // Add resource parameter if specified (MCP-specific)
      if (opts.resourceUri) {
        params.set('resource', opts.resourceUri)
      }

      const authorizationUrl = `${opts.authorizationServer}/oauth/authorize?${params.toString()}`

      return {
        authorizationUrl,
        state,
        pkce
      }
    },

    async exchangeCodeForToken (
      code: string,
      pkce: PKCEChallenge,
      state: string,
      receivedState: string
    ): Promise<TokenResponse> {
      // Validate state parameter to prevent CSRF
      if (state !== receivedState) {
        throw new Error('Invalid state parameter - possible CSRF attack')
      }

      try {
        const tokenResponse = await fetch(`${opts.authorizationServer}/oauth/token`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json'
          },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            client_id: opts.clientId || '',
            code_verifier: pkce.codeVerifier,
            ...(opts.clientSecret && { client_secret: opts.clientSecret })
          }).toString()
        })

        if (!tokenResponse.ok) {
          const errorText = await tokenResponse.text()
          throw new Error(`Token exchange failed: ${tokenResponse.status} ${errorText}`)
        }

        const tokens = await tokenResponse.json() as TokenResponse

        // Validate token response structure with TypeBox
        if (!validateTokenResponse(tokens)) {
          throw new Error('Invalid token response: does not match OAuth 2.0 specification')
        }

        return tokens
      } catch (error) {
        throw new Error(`OAuth token exchange failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    },

    async refreshToken (refreshToken: string): Promise<TokenResponse> {
      if (!refreshToken) {
        throw new Error('Refresh token is required')
      }

      try {
        const tokenResponse = await fetch(`${opts.authorizationServer}/oauth/token`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json'
          },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: opts.clientId || '',
            ...(opts.clientSecret && { client_secret: opts.clientSecret })
          }).toString()
        })

        if (!tokenResponse.ok) {
          const errorText = await tokenResponse.text()
          throw new Error(`Token refresh failed: ${tokenResponse.status} ${errorText}`)
        }

        const tokens = await tokenResponse.json() as TokenResponse

        // Validate token response structure with TypeBox
        if (!validateTokenResponse(tokens)) {
          throw new Error('Invalid token response: does not match OAuth 2.0 specification')
        }

        return tokens
      } catch (error) {
        throw new Error(`OAuth token refresh failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    },

    async validateToken (accessToken: string): Promise<boolean> {
      try {
        const introspectionResponse = await fetch(`${opts.authorizationServer}/oauth/introspect`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
            Authorization: `Bearer ${accessToken}`
          },
          body: new URLSearchParams({
            token: accessToken,
            token_type_hint: 'access_token'
          }).toString()
        })

        if (!introspectionResponse.ok) {
          return false
        }

        const introspection = await introspectionResponse.json()

        // Validate introspection response structure with TypeBox
        if (!validateIntrospectionResponse(introspection)) {
          return false
        }

        return (introspection as { active: boolean }).active === true
      } catch {
        return false
      }
    },

    async dynamicClientRegistration (): Promise<{ clientId: string; clientSecret?: string }> {
      if (!opts.dynamicRegistration) {
        throw new Error('Dynamic client registration not enabled')
      }

      try {
        const registrationResponse = await fetch(`${opts.authorizationServer}/oauth/register`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json'
          },
          body: JSON.stringify({
            client_name: 'MCP Server',
            client_uri: opts.resourceUri,
            redirect_uris: [`${opts.resourceUri}/oauth/callback`],
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'client_secret_post',
            scope: (opts.scopes || ['read']).join(' ')
          })
        })

        if (!registrationResponse.ok) {
          const errorText = await registrationResponse.text()
          throw new Error(`Client registration failed: ${registrationResponse.status} ${errorText}`)
        }

        const registration = await registrationResponse.json()

        // Validate registration response structure with TypeBox
        if (!validateClientRegistrationResponse(registration)) {
          throw new Error('Invalid registration response: does not match OAuth 2.0 specification')
        }

        const validatedRegistration = registration as { client_id: string; client_secret?: string }

        // Update config with new client credentials
        opts.clientId = validatedRegistration.client_id
        opts.clientSecret = validatedRegistration.client_secret

        return {
          clientId: validatedRegistration.client_id,
          clientSecret: validatedRegistration.client_secret
        }
      } catch (error) {
        throw new Error(`Dynamic client registration failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  // Decorate Fastify instance with OAuth client methods
  fastify.decorate('oauthClient', oauthClientMethods)

  // Add cleanup for any potential hanging connections
  fastify.addHook('onClose', async () => {
    // No specific cleanup needed for our implementation
    // @fastify/oauth2 should handle its own cleanup
  })
}

export default fp(oauthClientPlugin, {
  name: 'oauth-client',
  dependencies: []
})
