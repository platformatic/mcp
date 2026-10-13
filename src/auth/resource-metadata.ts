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
