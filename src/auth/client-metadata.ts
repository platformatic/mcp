import type { ClientMetadata, AuthorizationConfig } from '../types/auth-types.ts'

/**
 * Generates OAuth 2.0 Client Metadata Document for the MCP server.
 *
 * Per the draft MCP spec, Client ID Metadata Documents are the RECOMMENDED
 * method for client registration. The client_id MUST be an HTTPS URL with
 * a path component that resolves to this metadata document.
 *
 * @param config - Authorization configuration
 * @param baseUrl - Base URL of the MCP server (must be HTTPS)
 * @returns Client metadata document
 * @throws Error if configuration is invalid
 */
export function generateClientMetadata (
  config: Extract<AuthorizationConfig, { enabled: true }>,
  baseUrl: string
): ClientMetadata {
  // Validate baseUrl is HTTPS
  let serverUrl: URL
  try {
    serverUrl = new URL(baseUrl)
  } catch {
    throw new Error('baseUrl must be a valid URL')
  }

  if (serverUrl.protocol !== 'https:') {
    throw new Error('baseUrl must use HTTPS protocol for client metadata')
  }

  // Determine client_id based on configuration
  let clientId: string

  if (config.clientRegistration?.method === 'metadata-document') {
    // Use configured metadata URL as client_id
    if (!config.clientRegistration.metadataUrl) {
      throw new Error('metadataUrl is required for metadata-document method')
    }
    clientId = config.clientRegistration.metadataUrl
  } else if (config.clientRegistration?.clientId) {
    // Use manually configured client ID
    clientId = config.clientRegistration.clientId
  } else if (config.oauth2Client?.clientId) {
    // Fallback to legacy oauth2Client configuration
    clientId = config.oauth2Client.clientId
  } else {
    // Default: construct from baseUrl
    clientId = `${baseUrl}/oauth/client-metadata.json`
  }

  // Validate client_id is HTTPS URL with path
  let clientIdUrl: URL
  try {
    clientIdUrl = new URL(clientId)
  } catch {
    throw new Error('client_id must be a valid URL')
  }

  if (clientIdUrl.protocol !== 'https:') {
    throw new Error('client_id must use HTTPS protocol')
  }

  if (!clientIdUrl.pathname || clientIdUrl.pathname === '/') {
    throw new Error('client_id must include a path component')
  }

  // Determine scopes
  const scopes = config.defaultScopes ||
    config.clientRegistration?.scopes ||
    config.oauth2Client?.scopes ||
    []

  // Determine redirect URIs
  const redirectUris = [
    `${baseUrl}/oauth/callback`,
    `${baseUrl}/auth/callback`
  ]

  // Build metadata document
  const metadata: ClientMetadata = {
    client_id: clientId,
    client_name: 'MCP Server',
    redirect_uris: redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_method: 'none', // Public client (PKCE required)
    scope: scopes.join(' ')
  }

  // Add optional fields if configured
  if (config.clientRegistration?.jwks_uri) {
    metadata.jwks_uri = config.clientRegistration.jwks_uri
  }

  return metadata
}

/**
 * Validates a Client Metadata Document.
 *
 * @param metadata - The metadata to validate
 * @throws Error if metadata is invalid
 */
export function validateClientMetadata (metadata: ClientMetadata): void {
  // Validate required fields
  if (!metadata.client_id) {
    throw new Error('Client metadata missing required "client_id" field')
  }

  if (!metadata.client_name) {
    throw new Error('Client metadata missing required "client_name" field')
  }

  if (!metadata.redirect_uris || !Array.isArray(metadata.redirect_uris) || metadata.redirect_uris.length === 0) {
    throw new Error('Client metadata missing required "redirect_uris" array')
  }

  if (!metadata.grant_types || !Array.isArray(metadata.grant_types) || metadata.grant_types.length === 0) {
    throw new Error('Client metadata missing required "grant_types" array')
  }

  if (!metadata.token_endpoint_auth_method) {
    throw new Error('Client metadata missing required "token_endpoint_auth_method" field')
  }

  // Validate client_id is HTTPS URL with path
  let clientIdUrl: URL
  try {
    clientIdUrl = new URL(metadata.client_id)
  } catch {
    throw new Error('client_id must be a valid URL')
  }

  if (clientIdUrl.protocol !== 'https:') {
    throw new Error('client_id must use HTTPS protocol')
  }

  if (!clientIdUrl.pathname || clientIdUrl.pathname === '/') {
    throw new Error('client_id must include a path component')
  }

  // Validate redirect_uris are HTTPS
  for (const uri of metadata.redirect_uris) {
    try {
      const redirectUrl = new URL(uri)
      if (redirectUrl.protocol !== 'https:' && redirectUrl.protocol !== 'http:') {
        throw new Error(`Invalid redirect_uri protocol: ${uri}`)
      }
    } catch {
      throw new Error(`Invalid redirect_uri: ${uri}`)
    }
  }

  // Validate private_key_jwt requirements
  if (metadata.token_endpoint_auth_method === 'private_key_jwt') {
    if (!metadata.jwks_uri && !metadata.jwks) {
      throw new Error('private_key_jwt requires either jwks_uri or jwks')
    }
  }
}
