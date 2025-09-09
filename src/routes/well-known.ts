import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import fp from 'fastify-plugin'
import cors from '@fastify/cors'
import type { AuthorizationConfig, ProtectedResourceMetadata } from '../types/auth-types.ts'

interface WellKnownRoutesOptions {
  authConfig?: AuthorizationConfig
}

const wellKnownRoutesPlugin = fp(async function (app: FastifyInstance, opts: WellKnownRoutesOptions) {
  if (!opts.authConfig?.enabled) {
    return // Skip registration if authorization is not enabled
  }

  const { authConfig } = opts

  // Register CORS for well-known endpoints to allow cross-origin requests
  await app.register(cors, {
    origin: true, // Allow all origins for discovery endpoints
    methods: ['GET', 'HEAD', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'mcp-protocol-version',
      'x-requested-with',
      'accept',
      'cache-control'
    ],
    maxAge: 3600 // Cache preflight for 1 hour
  })

  // OAuth 2.0 Protected Resource Metadata endpoint (RFC 9728)
  app.get('/.well-known/oauth-protected-resource', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            resource: { type: 'string' },
            authorization_servers: {
              type: 'array',
              items: { type: 'string' }
            }
          },
          required: ['resource', 'authorization_servers']
        }
      }
    }
  }, async (_request: FastifyRequest, reply: FastifyReply) => {
    const metadata: ProtectedResourceMetadata = {
      resource: authConfig.resourceUri,
      authorization_servers: authConfig.authorizationServers
    }

    reply.header('Content-Type', 'application/json')

    return metadata
  })

  // OAuth 2.0 Protected Resource Metadata endpoint for MCP path (RFC 9728)
  app.get('/.well-known/oauth-protected-resource/mcp', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            resource: { type: 'string' },
            authorization_servers: {
              type: 'array',
              items: { type: 'string' }
            }
          },
          required: ['resource', 'authorization_servers']
        }
      }
    }
  }, async (_request: FastifyRequest, reply: FastifyReply) => {
    const metadata: ProtectedResourceMetadata = {
      resource: `${authConfig.resourceUri.replace(/\/+$/, '')}/mcp`,
      authorization_servers: authConfig.authorizationServers
    }

    reply.header('Content-Type', 'application/json')

    return metadata
  })

  // OpenID Connect Discovery for MCP (based on OpenID Connect Discovery 1.0)
  app.get('/.well-known/openid-configuration/mcp', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            issuer: { type: 'string' },
            authorization_endpoint: { type: 'string' },
            token_endpoint: { type: 'string' },
            token_endpoint_auth_methods_supported: {
              type: 'array',
              items: { type: 'string' }
            },
            code_challenge_methods_supported: {
              type: 'array',
              items: { type: 'string' }
            },
            response_types_supported: {
              type: 'array',
              items: { type: 'string' }
            },
            grant_types_supported: {
              type: 'array',
              items: { type: 'string' }
            },
            scopes_supported: {
              type: 'array',
              items: { type: 'string' }
            },
            token_introspection_endpoint: { type: 'string' },
            jwks_uri: { type: 'string', nullable: true },
            mcp_resource_uri: { type: 'string' },
            mcp_authorization_servers: {
              type: 'array',
              items: { type: 'string' }
            }
          },
          required: [
            'issuer',
            'authorization_endpoint',
            'token_endpoint',
            'token_endpoint_auth_methods_supported',
            'code_challenge_methods_supported',
            'response_types_supported',
            'grant_types_supported',
            'scopes_supported',
            'token_introspection_endpoint',
            'mcp_resource_uri',
            'mcp_authorization_servers'
          ]
        }
      }
    }
  }, async (_request: FastifyRequest, reply: FastifyReply) => {
    const primaryAuthServer = authConfig.authorizationServers[0]

    reply.header('Content-Type', 'application/json')

    return {
      issuer: primaryAuthServer,
      authorization_endpoint: `${primaryAuthServer}/oauth/authorize`,
      token_endpoint: `${primaryAuthServer}/oauth/token`,
      token_endpoint_auth_methods_supported: [
        'client_secret_post',
        'client_secret_basic',
        'none'
      ],
      code_challenge_methods_supported: ['S256'],
      response_types_supported: ['code'],
      grant_types_supported: [
        'authorization_code',
        'refresh_token'
      ],
      scopes_supported: [
        'read',
        'write',
        'mcp:resources',
        'mcp:prompts',
        'mcp:tools'
      ],
      token_introspection_endpoint: `${primaryAuthServer}/oauth/introspect`,
      jwks_uri: authConfig.tokenValidation.jwksUri || null,
      mcp_resource_uri: authConfig.resourceUri,
      mcp_authorization_servers: authConfig.authorizationServers
    }
  })

  // Health check endpoint that can be used to verify the resource server is operational
  app.get('/.well-known/mcp-resource-health', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            resource: { type: 'string' },
            timestamp: { type: 'string' }
          },
          required: ['status', 'resource', 'timestamp']
        }
      }
    }
  }, async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.header('Content-Type', 'application/json')

    return {
      status: 'healthy',
      resource: authConfig.resourceUri,
      timestamp: new Date().toISOString()
    }
  })
}, {
  name: 'well-known-routes'
})

export default wellKnownRoutesPlugin
