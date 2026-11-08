import type { FastifyInstance, FastifySchema, HTTPMethods } from 'fastify'
import type { MCPRouteId, MCPRouteSchemaContext, MCPRouteSchemaTransformer } from '../types.ts'

export function resolveRouteUrl (prefix: string | undefined, url: string): string {
  if (!prefix || prefix === '/') {
    return url
  }

  const normalizedPrefix = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
  return `${normalizedPrefix}${url}`
}

function isThenable (value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  )
}

export function resolveMcpRouteSchema (
  defaultSchema: FastifySchema | undefined,
  context: MCPRouteSchemaContext,
  transform?: MCPRouteSchemaTransformer
): FastifySchema | undefined {
  if (!transform) {
    return defaultSchema
  }

  const schema = defaultSchema ?? {}
  const transformed = transform(schema, context)

  if (typeof transformed !== 'object' || transformed === null || Array.isArray(transformed) || isThenable(transformed)) {
    throw new TypeError(`transformRouteSchema must return a synchronous Fastify schema object for ${context.routeId}`)
  }

  return transformed
}

/**
 * Returns route options carrying the transformed schema for a route the
 * plugin registers on `app`, or no `schema` key at all when there is neither
 * a default schema nor a transformer.
 */
export function routeSchemaOptions (
  app: FastifyInstance,
  routeId: MCPRouteId,
  method: HTTPMethods,
  url: string,
  defaultSchema: FastifySchema | undefined,
  transform?: MCPRouteSchemaTransformer
): { schema?: FastifySchema } {
  const schema = resolveMcpRouteSchema(defaultSchema, {
    routeId,
    method,
    url: resolveRouteUrl(app.prefix, url)
  }, transform)
  return schema === undefined ? {} : { schema }
}
