import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import fp from 'fastify-plugin'
import type { AuthorizationConfig, ProtectedResourceMetadata } from '../types/auth-types.ts'

interface WellKnownRoutesOptions {
  authConfig?: AuthorizationConfig
}

const wellKnownRoutesPlugin = fp(async function (app: FastifyInstance, opts: WellKnownRoutesOptions) {
  if (!opts.authConfig?.enabled) {
    return // Skip registration if authorization is not enabled
  }

  const { authConfig } = opts

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
    reply.header('Cache-Control', 'public, max-age=3600') // Cache for 1 hour

    return metadata
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
