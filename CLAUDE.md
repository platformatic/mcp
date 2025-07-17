# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is FAMPS (Fastify Adapter MCP Server) - a production-ready Fastify adapter for the Model Context Protocol (MCP). The project implements a Fastify plugin that enables MCP communication through the JSON-RPC 2.0 specification with full horizontal scaling capabilities. The codebase includes MCP protocol specifications in the `spec/` directory that define the messaging format, lifecycle management, and various protocol features.

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
- **Test**: `npm run test` - Run Node.js test runner on test files
- **Test Individual**: `node --experimental-strip-types --no-warnings --test test/filename.test.ts` - Run a specific test file
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
- **54 tests total** covering all functionality
- **Memory backend tests**: Session management, message broadcasting, SSE handling
- **Redis backend tests**: Session persistence, cross-instance messaging, failover
- **Integration tests**: Full plugin lifecycle, multi-instance deployment
- **Test utilities**: Redis test helpers with automatic cleanup

Run tests with: `npm run test` (requires Redis running on localhost:6379)