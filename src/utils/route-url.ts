/** A route's URL under a Fastify prefix, as the router will match it. */
export function resolveRouteUrl (prefix: string | undefined, url: string): string {
  if (!prefix || prefix === '/') {
    return url
  }

  const normalizedPrefix = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
  return `${normalizedPrefix}${url}`
}
