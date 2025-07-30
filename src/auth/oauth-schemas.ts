import { Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'

// OAuth 2.0 Token Response Schema (RFC 6749 Section 5.1)
export const TokenResponseSchema = Type.Object({
  access_token: Type.String(),
  token_type: Type.String(),
  expires_in: Type.Optional(Type.Number({ minimum: 0 })),
  refresh_token: Type.Optional(Type.String()),
  scope: Type.Optional(Type.String())
})

// OAuth 2.0 Error Response Schema (RFC 6749 Section 5.2)
export const TokenErrorResponseSchema = Type.Object({
  error: Type.Union([
    Type.Literal('invalid_request'),
    Type.Literal('invalid_client'),
    Type.Literal('invalid_grant'),
    Type.Literal('unauthorized_client'),
    Type.Literal('unsupported_grant_type'),
    Type.Literal('invalid_scope')
  ]),
  error_description: Type.Optional(Type.String()),
  error_uri: Type.Optional(Type.String({ format: 'uri' }))
})

// Token Introspection Response Schema (RFC 7662 Section 2.2)
export const IntrospectionResponseSchema = Type.Object({
  active: Type.Boolean(),
  scope: Type.Optional(Type.String()),
  client_id: Type.Optional(Type.String()),
  username: Type.Optional(Type.String()),
  token_type: Type.Optional(Type.String()),
  exp: Type.Optional(Type.Number()),
  iat: Type.Optional(Type.Number()),
  nbf: Type.Optional(Type.Number()),
  sub: Type.Optional(Type.String()),
  aud: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
  iss: Type.Optional(Type.String()),
  jti: Type.Optional(Type.String())
})

// Dynamic Client Registration Response Schema (RFC 7591 Section 3.2.1)
export const ClientRegistrationResponseSchema = Type.Object({
  client_id: Type.String(),
  client_secret: Type.Optional(Type.String()),
  client_id_issued_at: Type.Optional(Type.Number()),
  client_secret_expires_at: Type.Optional(Type.Number()),
  redirect_uris: Type.Optional(Type.Array(Type.String({ format: 'uri' }))),
  token_endpoint_auth_method: Type.Optional(Type.String()),
  grant_types: Type.Optional(Type.Array(Type.String())),
  response_types: Type.Optional(Type.Array(Type.String())),
  client_name: Type.Optional(Type.String()),
  client_uri: Type.Optional(Type.String({ format: 'uri' })),
  logo_uri: Type.Optional(Type.String({ format: 'uri' })),
  scope: Type.Optional(Type.String()),
  contacts: Type.Optional(Type.Array(Type.String())),
  tos_uri: Type.Optional(Type.String({ format: 'uri' })),
  policy_uri: Type.Optional(Type.String({ format: 'uri' })),
  jwks_uri: Type.Optional(Type.String({ format: 'uri' })),
  software_id: Type.Optional(Type.String()),
  software_version: Type.Optional(Type.String())
})

// Validation functions
export function validateTokenResponse (data: unknown): boolean {
  return Value.Check(TokenResponseSchema, data)
}

export function validateIntrospectionResponse (data: unknown): boolean {
  return Value.Check(IntrospectionResponseSchema, data)
}

export function validateClientRegistrationResponse (data: unknown): boolean {
  return Value.Check(ClientRegistrationResponseSchema, data)
}

export function validateTokenErrorResponse (data: unknown): boolean {
  return Value.Check(TokenErrorResponseSchema, data)
}

// Type exports for TypeScript
export type TokenResponse = typeof TokenResponseSchema
export type TokenErrorResponse = typeof TokenErrorResponseSchema
export type IntrospectionResponse = typeof IntrospectionResponseSchema
export type ClientRegistrationResponse = typeof ClientRegistrationResponseSchema
