# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is a production-ready Fastify adapter for the Model Context Protocol (MCP). The project implements a Fastify plugin that enables MCP communication through the JSON-RPC 2.0 specification with full horizontal scaling capabilities. The codebase includes MCP protocol specifications in the `spec/` directory that define the messaging format, lifecycle management, and various protocol features.

## Key Features

- **Complete MCP Protocol Support**: Implements the full Model Context Protocol specification
- **Server-Sent Events (SSE)**: Real-time streaming communication with session management
- **Horizontal Scaling**: Redis-backed session management and message broadcasting
- **Session Persistence**: Message history and reconnection support with Last-Event-ID
- **Dual Backend Support**: Memory-based for development, Redis-based for production
- **Cross-Instance Broadcasting**: Messages sent from any instance reach all connected clients
- **High Availability**: Sessions survive server restarts with automatic cleanup

## Development Commands

- **Build**: `npm run build` - Compiles TypeScript to `dist/` directory
- **Lint**: `npm run lint` - Run ESLint with caching
- **Lint Fix**: `npm run lint:fix` - Run ESLint with auto-fix
- **Type Check**: `npm run typecheck` - Run TypeScript compiler without emitting files
- **Test Individual**: `node --experimental-strip-types --no-warnings --test test/filename.test.ts` - Run a specific test file
- **Test**: `npm run test` - Run Node.js test runner on test files, do not use `npm run test -- individual.ts` to run individual test file
- **CI**: `npm run ci` - Full CI pipeline (build + lint + test)

## Architecture

The main entry point is `src/index.ts` which exports a Fastify plugin built with `fastify-plugin`. The plugin structure follows Fastify's standard plugin pattern with proper TypeScript types and supports both memory and Redis backends for horizontal scaling.

### Core Components

**Session Management:**
- `SessionStore` interface with `MemorySessionStore` and `RedisSessionStore` implementations
- Session metadata storage with automatic TTL (1-hour expiration)
- Message history storage with configurable limits and automatic trimming

**Message Broadcasting:**
- `MessageBroker` interface with `MemoryMessageBroker` and `RedisMessageBroker` implementations
- Topic-based pub/sub using MQEmitter (memory) or MQEmitter-Redis (distributed)
- Session-specific topics: `mcp/session/{sessionId}/message`
- Broadcast topics: `mcp/broadcast/notification`

**SSE Integration:**
- Complete SSE support with session management and persistence
- Message replay using Last-Event-ID for resumable connections
- Heartbeat mechanism for connection health monitoring
- Support for both GET and POST endpoints

### File Structure

```
src/
├── brokers/
│   ├── message-broker.ts          # Interface definition
│   ├── memory-message-broker.ts   # MQEmitter implementation
│   └── redis-message-broker.ts    # Redis-backed implementation
├── stores/
│   ├── session-store.ts           # Interface definition
│   ├── memory-session-store.ts    # In-memory implementation
│   └── redis-session-store.ts     # Redis-backed implementation
├── decorators/
│   ├── decorators.ts              # Core MCP decorators
│   └── pubsub-decorators.ts       # Pub/sub decorators
├── handlers.ts                    # MCP protocol handlers
├── routes.ts                      # SSE connection handling
├── index.ts                       # Plugin entry point with backend selection
├── schema.ts                      # MCP protocol types
└── types.ts                       # Plugin types
```

The complete MCP protocol TypeScript definitions are in `src/schema.ts`, which includes:
- JSON-RPC 2.0 message types (requests, responses, notifications, batches)
- MCP protocol lifecycle (initialization, capabilities, ping)
- Core features: resources, prompts, tools, logging, sampling
- Client/server request/response/notification types
- Content types (text, image, audio, embedded resources)
- Protocol constants and error codes

Key dependencies:
- `fastify-plugin` for plugin registration
- `typed-rpc` for RPC communication
- `neostandard` for ESLint configuration
- `ioredis` for Redis connectivity
- `mqemitter` and `mqemitter-redis` for message broadcasting

The project uses ESM modules (`"type": "module"`) and includes comprehensive MCP protocol specifications in markdown format under `spec/` covering the same areas as the TypeScript schema.

## Configuration Options

### Plugin Options
- `serverInfo`: Server identification (name, version)
- `capabilities`: MCP capabilities configuration
- `instructions`: Optional server instructions
- `enableSSE`: Enable Server-Sent Events support (default: false)
- `redis`: Redis configuration for horizontal scaling (optional)
  - `host`: Redis server hostname
  - `port`: Redis server port
  - `db`: Redis database number
  - `password`: Redis authentication password
  - Additional ioredis connection options supported

### Backend Selection
The plugin automatically selects the appropriate backend based on configuration:
- **Memory backends**: Used when `redis` option is not provided (development/single-instance)
- **Redis backends**: Used when `redis` option is provided (production/multi-instance)

## TypeScript Configuration

Uses a base TypeScript configuration (`tsconfig.base.json`) extended by the main `tsconfig.json`. The build targets ES modules with strict type checking enabled.

## Testing

The project includes comprehensive test coverage:
- **178 tests total** covering all functionality including OAuth 2.1 authorization
- **Memory backend tests**: Session management, message broadcasting, SSE handling
- **Redis backend tests**: Session persistence, cross-instance messaging, failover
- **Integration tests**: Full plugin lifecycle, multi-instance deployment
- **Authorization tests**: JWT validation, token introspection, OAuth 2.1 compliance
- **Test utilities**: Redis test helpers with automatic cleanup, JWT utilities with dynamic JWKS generation

Run tests with: `npm run test` (requires Redis running on localhost:6379)

### SSE Testing Best Practices

When testing Server-Sent Events (SSE) endpoints, it's critical to properly clean up streams to prevent hanging event loops:

```typescript
// ✅ Correct way to test SSE endpoints
const response = await app.inject({
  method: 'GET',
  url: '/mcp',
  payloadAsStream: true,  // Required for SSE responses
  headers: {
    accept: 'text/event-stream'
  }
})

t.assert.strictEqual(response.statusCode, 200)
t.assert.strictEqual(response.headers['content-type'], 'text/event-stream')
response.stream().destroy()  // ⚠️ CRITICAL: Always destroy the stream
```

**Why this is important:**
- SSE responses create readable streams that keep the event loop alive
- Without explicit cleanup, tests will hang with "Promise resolution is still pending" errors
- The `payloadAsStream: true` option is required for proper SSE response handling
- Always call `response.stream().destroy()` after assertions to clean up resources

### Test Utilities

**JWT Testing**: Uses dynamic JWKS generation with proper RSA key pairs:
- `generateMockJWKSResponse()`: Dynamically generates JWKS from RSA public key
- `setupMockAgent()`: Uses undici MockAgent for HTTP mocking instead of custom fetch mocks
- `createTestJWT()`: Creates properly signed JWT tokens for testing

**Mock HTTP Requests**: Uses undici's MockAgent for robust HTTP mocking:
```typescript
const restoreMock = setupMockAgent({
  'https://auth.example.com/.well-known/jwks.json': generateMockJWKSResponse()
})
// Test code here
restoreMock() // Clean up
```
