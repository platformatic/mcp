# OAuth 2.1 Authorization Implementation Plan

## Overview

This plan outlines the implementation of OAuth 2.1 authorization support for the Fastify MCP plugin, following the MCP authorization specification and leveraging `@fastify/oauth2` for OAuth flows.

## Current Architecture Analysis

The current plugin structure:
- Main plugin in `src/index.ts` with Fastify plugin pattern
- Routes handling in `src/routes.ts` with POST/GET endpoints for MCP communication
- Session management via `SessionStore` (Memory/Redis backends)
- Message broadcasting via `MessageBroker` (Memory/Redis backends)
- Server-Sent Events (SSE) support for real-time communication
- TypeScript with comprehensive type definitions in `src/types.ts` and `src/schema.ts`

## OAuth 2.1 Integration Architecture

### 1. Authorization Flow Components

#### A. Protected Resource Metadata Endpoint
- **Implementation**: New route `/.well-known/oauth-protected-resource`
- **Purpose**: RFC 9728 compliance for authorization server discovery
- **Response**: JSON metadata containing `authorization_servers` array

#### B. Authorization PreHandler Hook
- **Implementation**: Fastify `preHandler` hook using `@fastify/jwt`
- **Purpose**: Token validation for all MCP endpoints
- **Features**:
  - Bearer token extraction from `Authorization` header
  - JWT verification with `@fastify/jwt.verify`
  - Token audience validation (resource parameter binding)
  - 401 responses with `WWW-Authenticate` header

#### C. OAuth Client Integration
- **Implementation**: `@fastify/oauth2` plugin registration
- **Purpose**: Handle client-side OAuth flows (for MCP servers acting as clients)
- **Features**:
  - PKCE support (required by MCP spec)
  - Resource parameter injection
  - Dynamic client registration support

### 2. New Configuration Options

Extend `MCPPluginOptions` interface:

```typescript
interface MCPPluginOptions {
  // ... existing options
  authorization?: {
    enabled: boolean
    authorizationServers: string[]           // List of authorization servers
    resourceUri: string                      // Canonical URI for this MCP server
    tokenValidation: {
      introspectionEndpoint?: string         // Token introspection endpoint
      jwksUri?: string                       // JWKS endpoint for JWT validation
      validateAudience: boolean              // Enforce audience validation
    }
    oauth2Client?: {                         // Optional: for MCP server as OAuth client
      clientId?: string
      clientSecret?: string
      authorizationServer: string
      dynamicRegistration?: boolean
    }
  }
}
```

### 3. File Structure Additions

```
src/
├── auth/
│   ├── prehandler.ts         # Authorization preHandler hook
│   ├── token-validator.ts    # Token validation logic
│   ├── metadata.ts          # Protected resource metadata
│   └── oauth-client.ts      # OAuth client wrapper
├── routes/
│   ├── auth-routes.ts       # OAuth endpoints
│   └── well-known.ts        # Well-known endpoints
└── types/
    └── auth-types.ts        # Authorization type definitions
```

### 4. Implementation Strategy

#### Phase 1: Core Authorization Infrastructure
1. **Token Validation Module** (`src/auth/token-validator.ts`)
   - JWT token validation with `fast-jwt` and `get-jwks`
   - Token introspection support
   - Audience claim validation
   - Error handling for invalid/expired tokens

2. **Authorization PreHandler** (`src/auth/prehandler.ts`)
   - Fastify `preHandler` hook registration
   - Bearer token extraction
   - Integration with `@fastify/jwt.verify`
   - WWW-Authenticate header generation
   - Skip authorization for public endpoints

3. **Protected Resource Metadata** (`src/routes/well-known.ts`)
   - RFC 9728 compliant metadata endpoint
   - Configuration-driven authorization server discovery

#### Phase 2: OAuth Client Support
1. **OAuth Client Wrapper** (`src/auth/oauth-client.ts`)
   - `@fastify/oauth2` integration
   - PKCE implementation
   - Resource parameter injection
   - Dynamic client registration

2. **Authorization Routes** (`src/routes/auth-routes.ts`)
   - OAuth authorization flow endpoints
   - Callback handling
   - Token refresh logic

#### Phase 3: Enhanced Features
1. **Session-Based Authorization**
   - Extend `SessionStore` to include authorization context
   - Token-to-session mapping
   - Automatic token refresh

2. **Authorization-Aware SSE**
   - Token validation for SSE connections
   - Session isolation based on authorization

## Dependencies

### New Dependencies Required
- `@fastify/oauth2` (v8.1.2) - OAuth 2.1 flows
- `@fastify/jwt` - JWT token validation and preHandler hooks
- `fast-jwt` - Fast JWT implementation
- `get-jwks` - JWKS key retrieval
- `undici` - HTTP requests for token introspection (already in devDependencies)

## Security Considerations

### 1. Token Validation
- **Audience Validation**: Mandatory validation of `aud` claim matching resource URI
- **Token Passthrough Prevention**: Strict enforcement against token forwarding
- **JWT Verification**: Proper signature validation with JWKS

### 2. PKCE Implementation
- **S256 Method**: Prefer SHA256 challenge method over plain text
- **State Parameter**: CSRF protection via state validation
- **Secure Redirects**: Exact redirect URI matching

### 3. Communication Security
- **HTTPS Enforcement**: All authorization endpoints require TLS
- **Secure Headers**: Proper CORS and security headers
- **Token Scope Validation**: Verify token scopes match required permissions

## Testing Strategy

### 1. Unit Tests
- Token validation logic
- PreHandler hook behavior
- Metadata endpoint responses
- OAuth client flows

### 2. Integration Tests
- End-to-end authorization flows
- Multiple authorization server scenarios
- Session management with authorization
- SSE with token validation

### 3. Security Tests
- Token audience validation
- PKCE flow validation
- Invalid token handling
- Authorization bypass attempts

## Migration Strategy

### 1. Backward Compatibility
- Authorization is **OPTIONAL** by default
- Existing functionality unchanged when `authorization.enabled = false`
- Graceful degradation for non-OAuth clients

### 2. Configuration Migration
- Extend existing `MCPPluginOptions` interface
- No breaking changes to current API
- Clear documentation for authorization setup

### 3. Deployment Considerations
- Production readiness with Redis backend
- Horizontal scaling with distributed session storage
- Health checks for authorization endpoints

## Example Usage

```typescript
import mcpPlugin from '@platformatic/mcp'

app.register(mcpPlugin, {
  serverInfo: { name: 'My MCP Server', version: '1.0.0' },
  enableSSE: true,
  authorization: {
    enabled: true,
    authorizationServers: ['https://auth.example.com'],
    resourceUri: 'https://mcp.example.com',
    tokenValidation: {
      jwksUri: 'https://auth.example.com/.well-known/jwks.json',
      validateAudience: true
    }
  },
  redis: {
    host: 'localhost',
    port: 6379
  }
})
```

## Success Criteria

1. **Specification Compliance**: Full adherence to MCP authorization specification
2. **Security**: Robust token validation and audience binding
3. **Performance**: Minimal impact on existing MCP communication
4. **Compatibility**: Seamless integration with existing plugin architecture
5. **Documentation**: Clear setup and usage documentation
6. **Testing**: Comprehensive test coverage for all authorization flows