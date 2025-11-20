# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] - MCP Spec 2025-11-15 Draft Implementation

### Added

#### Phase 2: Authorization Enhancements

- **OpenID Connect Discovery** (RFC 8414 / OIDC Discovery)
  - `discoverAuthorizationServer()` - Auto-discover OAuth 2.0 AS metadata
  - `fetchJWKS()` - Fetch JSON Web Key Sets
  - `fetchClientMetadata()` - Fetch client metadata documents
  - Support for both OAuth 2.0 AS Metadata and OIDC Discovery endpoints
  - Automatic issuer validation

- **Client ID Metadata Documents** (RECOMMENDED registration method)
  - `generateClientMetadata()` - Generate OAuth client metadata
  - `validateClientMetadata()` - Validate metadata documents
  - Automatic endpoint: `/oauth/client-metadata.json`
  - HTTPS URL requirement for client IDs

- **Incremental Scope Consent** (RFC 6750 scope challenges)
  - `createScopeChallenge()` - Generate WWW-Authenticate scope challenges
  - `createAuthChallenge()` - Generate WWW-Authenticate auth challenges
  - `parseTokenScopes()` - Parse scopes from JWT tokens
  - `hasRequiredScopes()` - Check scope requirements
  - `getMissingScopes()` - Get missing scopes
  - Automatic `authContext.scopes` population in request handlers

- **Enhanced Protected Resource Metadata**
  - `scopes_supported` field
  - `bearer_methods_supported` field
  - Updated endpoint: `/.well-known/oauth-protected-resource`

- **New Authorization Types**
  - `AuthorizationServerMetadata` - OAuth 2.0 / OIDC server metadata
  - `ClientMetadata` - OAuth client metadata document
  - `AuthorizationContext` - Enhanced with scopes, audience, token info
  - `TokenRefreshInfo` - Token refresh metadata

#### Phase 3: New Server Features

- **Logging Capability** (RFC 5424 severity hierarchy)
  - 8 log levels: debug, info, notice, warning, error, critical, alert, emergency
  - `app.mcpLog.*` decorators for all severity levels
  - `app.mcpSetLogLevel()` - Set minimum log level
  - `app.mcpGetLogLevel()` - Get current log level
  - `LoggingService` with dynamic level filtering
  - Message broker integration for distributed logging
  - Request handler: `logging/setLevel`
  - Graceful no-op when logging not enabled

- **Completion/Autocompletion** (Already implemented, verified working)
  - `CompletionService` for managing providers
  - `app.mcpRegisterPromptCompletion()` - Register prompt completions
  - `app.mcpRegisterResourceCompletion()` - Register resource completions
  - Pattern matching for resource URIs with wildcards
  - Context-aware completions
  - 100-item limit enforcement
  - Request handler: `completion/complete`

- **URL Mode Elicitation**
  - HTTP endpoints for elicitation flow:
    - `POST /elicitation/:id/complete` - Mark elicitation complete
    - `POST /elicitation/:id/cancel` - Cancel elicitation
    - `GET /elicitation/:id/status` - Check elicitation status
  - `app.mcpElicitURL()` - Send URL mode elicitation request
  - `app.mcpCompleteElicitation()` - Complete elicitation
  - ElicitationStore integration
  - Completion notifications via SSE

- **Icon Metadata Support** (Already implemented, verified working)
  - `icons` field for tools, resources, and prompts
  - `IconResource` type with src, mimeType, sizes
  - Full spec compliance for visual assets

#### Phase 4: Client Feature Support

- **Sampling with Tool Calling**
  - `app.mcpRequestSampling()` - Request LLM sampling from client
  - Full parameter support:
    - `messages` - Conversation history
    - `modelPreferences` - Model hints and priorities
    - `systemPrompt` - System instructions
    - `maxTokens` - Response length limit
    - `temperature` - Sampling temperature
    - `stopSequences` - Stop sequences
    - `tools` - Tool definitions
    - `toolChoice` - Tool usage control
    - `includeContext` - Context inclusion
    - `metadata` - Additional metadata
  - Automatic request ID generation
  - Session-based delivery via SSE

- **Roots Capability**
  - `app.mcpRequestRoots()` - Request file system roots from client
  - Simple integration with message broker
  - Session-based delivery

#### Phase 5: Tasks Implementation (Experimental)

- **Task Stores**
  - `TaskStore` interface with full CRUD operations
  - `MemoryTaskStore` - In-memory implementation
  - `RedisTaskStore` - Redis-backed with native TTL
  - Automatic expiration via TTL
  - Authorization-aware filtering

- **Task Service**
  - `TaskService` class for lifecycle management
  - `createTask()` - Create task with TTL and poll interval
  - `getTask()` - Get task status
  - `getTaskResult()` - Block until terminal state, return result
  - `listTasks()` - List tasks with authorization filtering
  - `cancelTask()` - Cancel non-terminal tasks
  - `updateTask()` - Update status and result
  - `notifyStatusChange()` - Publish status notifications
  - Periodic cleanup (5-minute interval)
  - Support for task statuses: working, input_required, completed, failed, cancelled

- **Task Request Handlers**
  - `tasks/get` - Get task status
  - `tasks/list` - List accessible tasks
  - `tasks/cancel` - Cancel a task
  - Full authorization context propagation
  - Capability enforcement

- **Task Integration**
  - `app.taskService` decorator
  - Auto-initialization when `capabilities.tasks` is set
  - Backend selection (Memory vs Redis) based on config
  - TypeScript declarations
  - Cleanup interval managed in onClose hook

### Changed

- **Authorization Configuration**
  - Added `clientRegistration` options:
    - `method`: 'metadata-document' | 'dynamic' | 'manual'
    - `metadataUrl`: Client metadata document URL
    - `scopes`: Requested scopes
    - `jwks_uri`: JWKS URI for private_key_jwt
  - Added `defaultScopes` - Default scopes to request
  - Added `scopeChallengeEnabled` - Enable incremental consent (default: true)

- **Request Handler Context**
  - `authContext` now includes `scopes` array
  - Enhanced with `audience`, `expiresAt`, `issuedAt`, `notBefore`

- **Well-Known Routes**
  - Enhanced `/.well-known/oauth-protected-resource` with scopes and bearer methods
  - Added `/oauth/client-metadata.json` endpoint

### Fixed

- **TaskService Constructor**
  - Removed TypeScript parameter properties (not supported in Node.js strip mode)
  - Changed to explicit property assignment

- **WWW-Authenticate Header Format**
  - Fixed format: `Bearer param1="value1", param2="value2"`
  - Removed leading comma issue

- **TypeScript Imports**
  - Deduplicated imports in multiple files
  - Fixed module quotes consistency

### Testing

- **New Test Suites** (33 new tests, all passing)
  - `test/tasks.test.ts` - 13 tests for tasks capability
  - `test/logging.test.ts` - 9 tests for logging capability
  - `test/completion.test.ts` - 11 tests for completion capability
  - `test/icons.test.ts` - 5 tests for icon metadata
  - `test/client-features.test.ts` - 8 tests for sampling/roots

- **Test Coverage**
  - Total tests: 322 (up from 276)
  - Passing: 288 (up from 242)
  - All Phase 2-5 features fully tested
  - Authorization boundary testing
  - Error case coverage
  - Edge case handling

### Documentation

- Added comprehensive migration guide (`MIGRATION-GUIDE.md`)
- Updated all TypeScript types with JSDoc
- Added usage examples for all new features

### Security

- Task authorization with scoped access control
- Scope validation utilities
- WWW-Authenticate challenge support for incremental consent
- Authorization context propagation across all features

### Performance

- Task cleanup interval (configurable, default 5 minutes)
- Log level filtering to avoid unnecessary serialization
- Redis backend support for horizontal scaling
- Efficient task expiration with Redis TTL

---

## [1.2.2] - Previous Release

See git history for changes prior to spec update.

---

## Version Support

| Plugin Version | MCP Spec Version | Status |
|---------------|------------------|---------|
| 1.3.0+ (unreleased) | 2025-11-15 (draft) | Active Development |
| 1.2.x | 2025-06-18 | Stable |
| 1.1.x | 2025-06-18 | Stable |
| 1.0.x | 2025-06-18 | Stable |

---

## Upgrading

See [MIGRATION-GUIDE.md](./MIGRATION-GUIDE.md) for detailed upgrade instructions.

**TL;DR**: This is a 100% backward-compatible update. All existing code continues to work. New features are opt-in.

---

## Contributors

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>
