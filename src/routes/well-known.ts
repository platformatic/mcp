import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import fp from 'fastify-plugin'
import cors from '@fastify/cors'
import type { AuthorizationConfig, ProtectedResourceMetadata } from '../types/auth-types.ts'
import { getResourceMetadataPath, PROTECTED_RESOURCE_METADATA_PATH } from '../auth/resource-metadata.ts'

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

  const protectedResourceSchema = {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            resource: { type: 'string' },
            authorization_servers: {
              type: 'array',
              items: { type: 'string' }
            },
            scopes_supported: {
              type: 'array',
              items: { type: 'string' }
            }
          },
          required: ['resource', 'authorization_servers']
        }
      }
    }
  }

  function serveProtectedResourceMetadata (path: string, resource: string) {
    app.get(path, protectedResourceSchema, async (_request: FastifyRequest, reply: FastifyReply) => {
      const metadata: ProtectedResourceMetadata = {
        resource,
        authorization_servers: authConfig.authorizationServers
      }
      if (authConfig.requiredScopes && authConfig.requiredScopes.length > 0) {
        metadata.scopes_supported = authConfig.requiredScopes
      }

      reply.header('Content-Type', 'application/json')

      return metadata
    })
  }

  // OAuth 2.0 Protected Resource Metadata endpoint (RFC 9728).
  // The root route is kept for clients that do not insert the resource path.
  serveProtectedResourceMetadata(PROTECTED_RESOURCE_METADATA_PATH, authConfig.resourceUri)

  // RFC 9728 §3.1: when the resource has a path, the metadata lives at
  // /.well-known/oauth-protected-resource{path}. This is the URL advertised in
  // the WWW-Authenticate challenge, and `resource` must match resourceUri exactly.
  const metadataPath = getResourceMetadataPath(authConfig.resourceUri)
  if (metadataPath !== PROTECTED_RESOURCE_METADATA_PATH) {
    serveProtectedResourceMetadata(metadataPath, authConfig.resourceUri)
  }

  // Legacy MCP-specific metadata route, kept for backwards compatibility
  const legacyMcpPath = `${PROTECTED_RESOURCE_METADATA_PATH}/mcp`
  if (metadataPath !== legacyMcpPath) {
    serveProtectedResourceMetadata(legacyMcpPath, `${authConfig.resourceUri.replace(/\/+$/, '')}/mcp`)
  }

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
