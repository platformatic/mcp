export const PROTECTED_RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource'

/**
 * Path at which the protected resource metadata for `resourceUri` is served.
 * Per RFC 9728 §3.1 the well-known segment goes between the host and the
 * resource path, e.g. `https://host/mcp` -> `/.well-known/oauth-protected-resource/mcp`.
 */
export function getResourceMetadataPath (resourceUri: string): string {
  const resourcePath = new URL(resourceUri).pathname.replace(/\/+$/, '')
  return `${PROTECTED_RESOURCE_METADATA_PATH}${resourcePath}`
}

/**
 * Absolute protected resource metadata URL for `resourceUri` (RFC 9728 §3.1),
 * used as the `resource_metadata` parameter of the Bearer challenge.
 */
export function getResourceMetadataUrl (resourceUri: string): string {
  return `${new URL(resourceUri).origin}${getResourceMetadataPath(resourceUri)}`
}

/**
 * Absolute URL at which the plugin, registered under `prefix`, serves the
 * metadata for `resourceUri`. Without a prefix this is the RFC 9728 §3.1 URL.
 * Under a prefix the routes can only live below it, so this is the URL that
 * actually resolves; advertising the origin-root one would be a 404.
 */
export function resolveResourceMetadataUrl (resourceUri: string, prefix: string = ''): string {
  const normalizedPrefix = prefix.replace(/\/+$/, '')
  return `${new URL(resourceUri).origin}${normalizedPrefix}${getResourceMetadataPath(resourceUri)}`
}
