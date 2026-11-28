import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import fp from 'fastify-plugin'
import type { AuthorizationConfig, ProtectedResourceMetadata } from '../types/auth-types.ts'
import type { MCPRouteSchemaTransformer } from '../types.ts'
import { routeSchemaOptions } from './route-schema.ts'
import { getResourceMetadataPath, PROTECTED_RESOURCE_METADATA_PATH } from '../auth/resource-metadata.ts'

interface WellKnownRoutesOptions {
  authConfig?: AuthorizationConfig
  transformRouteSchema?: MCPRouteSchemaTransformer
}

const CORS_ALLOWED_METHODS = 'GET, HEAD, OPTIONS'
const CORS_ALLOWED_HEADERS = [
  'Content-Type',
  'Authorization',
  'mcp-protocol-version',
  'x-requested-with',
  'accept',
  'cache-control'
].join(', ')
const CORS_MAX_AGE = '3600' // Cache preflight for 1 hour

const wellKnownRoutesPlugin = fp(async function (fastify: FastifyInstance, opts: WellKnownRoutesOptions) {
  const authConfig = opts.authConfig
  if (!authConfig?.enabled) {
    return // Skip registration if authorization is not enabled
  }

  // The routes and their CORS hook live in an encapsulated child context so
  // CORS covers only /.well-known/* and never leaks onto the application's
  // routes (including /mcp, whose CORS policy is left to the application).
  // @fastify/cors is not used here: it decorates the request and adds a
  // global OPTIONS * route, both of which clash with an app-level
  // @fastify/cors registration.
  await fastify.register(async (app) => wellKnownRoutes(app, authConfig, opts.transformRouteSchema))
}, {
  name: 'well-known-routes'
})

async function wellKnownRoutes (
  app: FastifyInstance,
  authConfig: AuthorizationConfig & { enabled: true },
  transformRouteSchema?: MCPRouteSchemaTransformer
) {
  // Discovery endpoints are public, so allow cross-origin requests from any origin
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin
    if (!origin) {
      return
    }
    reply.header('Access-Control-Allow-Origin', origin)
    reply.header('Vary', 'Origin')

    if (request.method === 'OPTIONS' && request.headers['access-control-request-method']) {
      reply.header('Access-Control-Allow-Methods', CORS_ALLOWED_METHODS)
      reply.header('Access-Control-Allow-Headers', CORS_ALLOWED_HEADERS)
      reply.header('Access-Control-Max-Age', CORS_MAX_AGE)
      return reply.code(204).send()
    }
  })

  // Lets the router accept preflight requests; they are answered in the hook above
  app.options('/.well-known/*', routeSchemaOptions(app, 'wellKnown.preflight', 'OPTIONS', '/.well-known/*', undefined, transformRouteSchema), async (_request, reply) => {
    return reply.callNotFound()
  })

  const protectedResourceSchema = {
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

  function serveProtectedResourceMetadata (path: string, resource: string) {
    const options = routeSchemaOptions(app, 'wellKnown.protectedResourceMetadata', 'GET', path, protectedResourceSchema, transformRouteSchema)
    app.get(path, options, async (_request: FastifyRequest, reply: FastifyReply) => {
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
  const healthPath = '/.well-known/mcp-resource-health'
  const healthSchema = {
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
  app.get(healthPath, routeSchemaOptions(app, 'wellKnown.resourceHealth', 'GET', healthPath, healthSchema, transformRouteSchema), async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.header('Content-Type', 'application/json')

    return {
      status: 'healthy',
      resource: authConfig.resourceUri,
      timestamp: new Date().toISOString()
    }
  })
}

export default wellKnownRoutesPlugin
