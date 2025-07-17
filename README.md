# FAMPS - Fastify Adapter MCP Server

A Fastify plugin that implements the Model Context Protocol (MCP) server using JSON-RPC 2.0. This plugin enables Fastify applications to expose tools, resources, and prompts following the MCP specification.

## Installation

```bash
npm install famps
```

### TypeBox Support (Optional)

For type-safe schema validation, install TypeBox:

```bash
npm install @sinclair/typebox
```

## Features

- **Complete MCP Protocol Support**: Implements the full Model Context Protocol specification
- **TypeBox Validation**: Type-safe schema validation with automatic TypeScript inference
- **Multiple Transport Support**: HTTP/SSE and stdio transports for flexible communication
- **SSE Streaming**: Server-Sent Events for real-time communication
- **Horizontal Scaling**: Redis-backed session management and message broadcasting
- **Session Persistence**: Message history and reconnection support with Last-Event-ID
- **Memory & Redis Backends**: Seamless switching between local and distributed storage
- **Production Ready**: Comprehensive test coverage and authentication support

## Quick Start

```typescript
import Fastify from 'fastify'
import mcpPlugin from 'famps'

const app = Fastify({ logger: true })

// Register the MCP plugin
await app.register(mcpPlugin, {
  serverInfo: {
    name: 'my-mcp-server',
    version: '1.0.0'
  },
  capabilities: {
    tools: { listChanged: true },
    resources: { subscribe: true },
    prompts: {}
  },
  instructions: 'This server provides custom tools and resources'
})

// Add tools, resources, and prompts with handlers
app.mcpAddTool({
  name: 'calculator',
  description: 'Performs basic arithmetic operations',
  inputSchema: {
    type: 'object',
    properties: {
      operation: { type: 'string', enum: ['add', 'subtract', 'multiply', 'divide'] },
      a: { type: 'number' },
      b: { type: 'number' }
    },
    required: ['operation', 'a', 'b']
  }
}, async (params) => {
  const { operation, a, b } = params
  let result
  switch (operation) {
    case 'add': result = a + b; break
    case 'subtract': result = a - b; break
    case 'multiply': result = a * b; break
    case 'divide': result = a / b; break
    default: throw new Error('Invalid operation')
  }
  return {
    content: [{ type: 'text', text: `Result: ${result}` }]
  }
})

app.mcpAddResource({
  uri: 'file://config.json',
  name: 'Application Config',
  description: 'Server configuration file',
  mimeType: 'application/json'
}, async (uri) => {
  // Read and return the configuration file
  const config = { setting1: 'value1', setting2: 'value2' }
  return {
    contents: [{
      uri,
      text: JSON.stringify(config, null, 2),
      mimeType: 'application/json'
    }]
  }
})

app.mcpAddPrompt({
  name: 'code-review',
  description: 'Generates code review comments',
  arguments: [{
    name: 'language',
    description: 'Programming language',
    required: true
  }]
}, async (name, args) => {
  const language = args?.language || 'javascript'
  return {
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: `Please review this ${language} code for best practices, potential bugs, and improvements.`
      }
    }]
  }
})

await app.listen({ port: 3000 })
```

## TypeBox Schema Validation

The plugin supports TypeBox schemas for type-safe validation with automatic TypeScript inference. This eliminates the need for manual type definitions and provides compile-time type checking.

### Benefits

- **Type Safety**: Automatic TypeScript type inference from schemas
- **Runtime Validation**: Input validation with structured error messages
- **Zero Duplication**: Single source of truth for both types and validation
- **IDE Support**: Full autocomplete and IntelliSense for validated parameters
- **Performance**: Compiled validators with caching for optimal performance

### Basic Usage

```typescript
import { Type } from '@sinclair/typebox'
import Fastify from 'fastify'
import mcpPlugin from 'famps'

const app = Fastify({ logger: true })

await app.register(mcpPlugin, {
  serverInfo: { name: 'my-server', version: '1.0.0' },
  capabilities: { tools: {} }
})

// Define TypeBox schema
const SearchToolSchema = Type.Object({
  query: Type.String({ minLength: 1, description: 'Search query' }),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100, description: 'Maximum results' })),
  filters: Type.Optional(Type.Array(Type.String(), { description: 'Filter criteria' }))
})

// Register tool with TypeBox schema
app.mcpAddTool({
  name: 'search',
  description: 'Search for files',
  inputSchema: SearchToolSchema
}, async (params) => {
  // params is automatically typed as:
  // {
  //   query: string;
  //   limit?: number;
  //   filters?: string[];
  // }
  const { query, limit = 10, filters = [] } = params
  
  return {
    content: [{
      type: 'text',
      text: `Searching for "${query}" with limit ${limit} and filters: ${filters.join(', ')}`
    }]
  }
})
```

### Schema Types

#### Tool Input Schemas

```typescript
// Complex nested schema
const ComplexToolSchema = Type.Object({
  user: Type.Object({
    name: Type.String(),
    age: Type.Number({ minimum: 0 })
  }),
  preferences: Type.Object({
    theme: Type.Union([
      Type.Literal('light'),
      Type.Literal('dark'),
      Type.Literal('auto')
    ]),
    notifications: Type.Boolean()
  }),
  tags: Type.Array(Type.String())
})

app.mcpAddTool({
  name: 'update-profile',
  description: 'Update user profile',
  inputSchema: ComplexToolSchema
}, async (params) => {
  // Fully typed nested object
  const { user, preferences, tags } = params
  return { content: [{ type: 'text', text: `Updated profile for ${user.name}` }] }
})
```

#### Resource URI Schemas

```typescript
// URI validation schema
const FileUriSchema = Type.String({
  pattern: '^file://.+',
  description: 'File URI pattern'
})

app.mcpAddResource({
  uriPattern: 'file://documents/*',
  name: 'Document Files',
  description: 'Access document files',
  uriSchema: FileUriSchema
}, async (uri) => {
  // uri is validated against the schema
  const content = await readFile(uri)
  return {
    contents: [{ uri, text: content, mimeType: 'text/plain' }]
  }
})
```

#### Prompt Argument Schemas

```typescript
// Prompt with automatic argument generation
const CodeReviewSchema = Type.Object({
  language: Type.Union([
    Type.Literal('javascript'),
    Type.Literal('typescript'),
    Type.Literal('python')
  ], { description: 'Programming language' }),
  complexity: Type.Optional(Type.Union([
    Type.Literal('low'),
    Type.Literal('medium'),
    Type.Literal('high')
  ], { description: 'Code complexity level' }))
})

app.mcpAddPrompt({
  name: 'code-review',
  description: 'Generate code review',
  argumentSchema: CodeReviewSchema
  // arguments array is automatically generated from schema
}, async (name, args) => {
  // args is typed as: { language: 'javascript' | 'typescript' | 'python', complexity?: 'low' | 'medium' | 'high' }
  return {
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: `Review this ${args.language} code with ${args.complexity || 'medium'} complexity`
      }
    }]
  }
})
```

### Error Handling

TypeBox validation provides structured error messages:

```typescript
// When validation fails, structured errors are returned:
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "isError": true,
    "content": [{
      "type": "text",
      "text": "Invalid tool arguments: Validation failed with 2 errors:\n/query: Expected string, received number\n/limit: Expected number <= 100, received 150"
    }]
  }
}
```

### Backward Compatibility

The plugin maintains backward compatibility with JSON Schema and unvalidated tools:

```typescript
// JSON Schema (still supported)
app.mcpAddTool({
  name: 'legacy-tool',
  description: 'Uses JSON Schema',
  inputSchema: {
    type: 'object',
    properties: {
      param: { type: 'string' }
    }
  }
}, async (params) => {
  // params is typed as 'any'
  return { content: [{ type: 'text', text: 'OK' }] }
})

// Unvalidated tool (unsafe)
app.mcpAddTool({
  name: 'unsafe-tool',
  description: 'No validation'
}, async (params) => {
  // params is typed as 'any' - no validation performed
  return { content: [{ type: 'text', text: 'OK' }] }
})
```

### Performance

TypeBox validation is highly optimized:

- **Compiled Validators**: Schemas are compiled to optimized validation functions
- **Caching**: Compiled validators are cached for reuse
- **Minimal Overhead**: Less than 1ms validation overhead for typical schemas
- **Memory Efficient**: Shared validator instances across requests

## Server-Sent Events (SSE) Support

This plugin supports the MCP Streamable HTTP transport specification, enabling both regular JSON responses and Server-Sent Events for streaming communication.

### SSE Configuration

```typescript
await app.register(mcpPlugin, {
  enableSSE: true, // Enable SSE support (default: false)
  // ... other options
})
```

## Redis Configuration for Horizontal Scaling

The plugin supports Redis-backed session management and message broadcasting for horizontal scaling across multiple server instances.

### Why Redis is Critical for Scalability

**Without Redis (Memory-only):**
- Each server instance maintains isolated session stores
- SSE connections are tied to specific server instances  
- No cross-instance message broadcasting
- Session data is lost when servers restart
- Load balancers can't route clients to different instances

**With Redis (Distributed):**
- **Shared Session State**: All instances access the same session data from Redis
- **Cross-Instance Broadcasting**: Messages sent from any instance reach all connected clients
- **Session Persistence**: Sessions survive server restarts with 1-hour TTL
- **High Availability**: Clients can reconnect to any instance and resume from last event
- **True Horizontal Scaling**: Add more instances without architectural changes

This transforms the plugin from a single-instance application into a distributed system capable of serving thousands of concurrent SSE connections with real-time global synchronization.

### Redis Setup

```typescript
import Fastify from 'fastify'
import mcpPlugin from 'famps'

const app = Fastify({ logger: true })

await app.register(mcpPlugin, {
  enableSSE: true,
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    db: parseInt(process.env.REDIS_DB || '0'),
    password: process.env.REDIS_PASSWORD,
    // Additional ioredis options
    retryDelayOnFailover: 100,
    maxRetriesPerRequest: 3
  },
  serverInfo: {
    name: 'scalable-mcp-server',
    version: '1.0.0'
  }
})
```

### Multi-Instance Deployment

With Redis configuration, you can run multiple instances of your MCP server:

```bash
# Instance 1
PORT=3000 REDIS_HOST=redis.example.com node server.js

# Instance 2  
PORT=3001 REDIS_HOST=redis.example.com node server.js

# Instance 3
PORT=3002 REDIS_HOST=redis.example.com node server.js
```

### Session Persistence Features

**Automatic Session Management:**
- Sessions persist across server restarts
- 1-hour session TTL with automatic cleanup
- Message history stored in Redis Streams

**Message Replay:**
```javascript
// Client reconnection with Last-Event-ID
const eventSource = new EventSource('/mcp', {
  headers: { 
    'Accept': 'text/event-stream',
    'Last-Event-ID': '1234' // Resume from this event
  }
})
```

**Cross-Instance Broadcasting:**
```typescript
// Any server instance can broadcast to all connected clients
app.mcpBroadcastNotification({
  jsonrpc: '2.0',
  method: 'notifications/message',
  params: { message: 'Global update from instance 2' }
})

// Send to specific session (works across instances)
app.mcpSendToSession('session-xyz', {
  jsonrpc: '2.0',
  method: 'notifications/progress',
  params: { progress: 75 }
})
```

### Content-Type Negotiation

Clients can request SSE streams by including `text/event-stream` in the `Accept` header:

```javascript
// Request SSE stream
fetch('/mcp', {
  method: 'POST',
  headers: {
    'Accept': 'text/event-stream',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 })
})

// Request regular JSON
fetch('/mcp', {
  method: 'POST', 
  headers: {
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 })
})
```

### GET Endpoint for Long-lived Streams

The plugin also provides a GET endpoint for server-initiated communication:

```javascript
// Long-lived SSE stream
const eventSource = new EventSource('/mcp', {
  headers: { 'Accept': 'text/event-stream' }
})
```

### Server-Initiated Notifications

The plugin provides methods to send notifications and messages to connected SSE clients:

```typescript
import Fastify from 'fastify'
import mcpPlugin from 'famps'

const app = Fastify({ logger: true })

await app.register(mcpPlugin, {
  enableSSE: true,
  // ... other options
})

// Broadcast a notification to all connected SSE clients
app.mcpBroadcastNotification({
  jsonrpc: '2.0',
  method: 'notifications/message',
  params: {
    level: 'info',
    message: 'Server status update'
  }
})

// Send a message to a specific session
const success = app.mcpSendToSession('session-id', {
  jsonrpc: '2.0',
  method: 'notifications/progress',
  params: {
    progressToken: 'task-123',
    progress: 50,
    total: 100
  }
})

// Send a request to a specific session (expecting a response)
app.mcpSendToSession('session-id', {
  jsonrpc: '2.0',
  id: 'req-456',
  method: 'sampling/createMessage',
  params: {
    messages: [
      {
        role: 'user',
        content: { type: 'text', text: 'Hello from server!' }
      }
    ]
  }
})

// Example: Broadcast tool list changes
app.mcpBroadcastNotification({
  jsonrpc: '2.0',
  method: 'notifications/tools/list_changed'
})

// Example: Send resource updates
app.mcpBroadcastNotification({
  jsonrpc: '2.0',
  method: 'notifications/resources/updated',
  params: {
    uri: 'file://config.json'
  }
})
```

### Real-time Updates Example

```typescript
// Set up a timer to send periodic updates
setInterval(() => {
  app.mcpBroadcastNotification({
    jsonrpc: '2.0',
    method: 'notifications/message',
    params: {
      level: 'info',
      message: `Server time: ${new Date().toISOString()}`
    }
  })
}, 30000) // Every 30 seconds

// Send updates when data changes
function onDataChange(newData: any) {
  app.mcpBroadcastNotification({
    jsonrpc: '2.0',
    method: 'notifications/resources/list_changed'
  })
}
```

## Stdio Transport

The plugin includes a built-in stdio transport utility for MCP communication over stdin/stdout, following the MCP stdio transport specification. This enables command-line tools and local applications to communicate with your Fastify MCP server.

### Key Features

- **Complete MCP stdio transport implementation** following the official specification
- **Fastify integration** using the `.inject()` method for consistency with HTTP routes
- **Comprehensive error handling** with proper JSON-RPC error responses
- **Batch request support** for processing multiple messages at once
- **Debug logging** to stderr without interfering with the stdio protocol

### Quick Start

```typescript
import fastify from 'fastify'
import mcpPlugin from 'famps'
import { runStdioServer } from 'famps/stdio'

const app = fastify({
  logger: false // Disable HTTP logging to avoid interference with stdio
})

await app.register(mcpPlugin, {
  serverInfo: {
    name: 'my-mcp-server',
    version: '1.0.0'
  },
  capabilities: {
    tools: {},
    resources: {},
    prompts: {}
  }
})

// Register your tools, resources, and prompts
app.mcpAddTool({
  name: 'echo',
  description: 'Echo back the input text',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string' }
    },
    required: ['text']
  }
}, async (args) => {
  return {
    content: [{
      type: 'text',
      text: `Echo: ${args.text}`
    }]
  }
})

await app.ready()

// Start the stdio transport
await runStdioServer(app, {
  debug: process.env.DEBUG === 'true'
})
```

### Usage Examples

```bash
# Initialize the server
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test-client","version":"1.0.0"}}}' | node server.js

# Ping the server
echo '{"jsonrpc":"2.0","id":2,"method":"ping"}' | node server.js

# List available tools
echo '{"jsonrpc":"2.0","id":3,"method":"tools/list"}' | node server.js

# Call a tool
echo '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"echo","arguments":{"text":"Hello, stdio!"}}}' | node server.js
```

### API Reference

#### `runStdioServer(app, options)`

Starts a Fastify MCP server in stdio mode.

**Parameters:**
- `app` - Fastify instance with MCP plugin registered
- `options` - Optional stdio transport options

**Options:**
- `debug` - Enable debug logging to stderr (default: false)
- `input` - Custom input stream (default: process.stdin)
- `output` - Custom output stream (default: process.stdout)
- `error` - Custom error stream (default: process.stderr)

#### `createStdioTransport(app, options)`

Creates a stdio transport instance without starting it.

**Parameters:**
- `app` - Fastify instance with MCP plugin registered
- `options` - Optional stdio transport options

**Returns:** `StdioTransport` instance with `start()` and `stop()` methods

### Transport Protocol

The stdio transport follows the MCP stdio transport specification:

- Messages are exchanged over stdin/stdout
- Each message is a single line of JSON
- Messages are delimited by newlines
- Messages must NOT contain embedded newlines
- Server logs can be written to stderr
- Supports both single messages and batch requests

### Error Handling

The stdio transport provides comprehensive error handling:

- JSON parsing errors return appropriate JSON-RPC error responses
- Invalid method calls return "Method not found" errors
- Tool execution errors are captured and returned in the response
- Connection errors are logged to stderr

### Use Cases

The stdio transport is particularly useful for:

- **Command-line tools** that need to communicate with MCP servers
- **Local development and testing** without HTTP overhead
- **Integration with text editors and IDEs** that support stdio protocols
- **Simple client-server communication** in controlled environments
- **Batch processing** of MCP requests from scripts

## Authentication & Security

### Bearer Token Authentication

For production deployments, it's recommended to secure the MCP endpoint using the `@fastify/bearer-auth` plugin:

```bash
npm install @fastify/bearer-auth
```

```typescript
import Fastify from 'fastify'
import mcpPlugin from 'famps'

const app = Fastify({ logger: true })

// Register bearer authentication
await app.register(import('@fastify/bearer-auth'), {
  keys: new Set(['your-secret-bearer-token']),
  auth: {
    // Apply to all routes matching this prefix
    extractToken: (request) => {
      return request.headers.authorization?.replace('Bearer ', '')
    }
  }
})

// Register MCP plugin (routes will inherit authentication)
await app.register(mcpPlugin, {
  // ... your configuration
})

// Usage with authentication
fetch('/mcp', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer your-secret-bearer-token',
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  },
  body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 })
})
```

### Environment-based Token Configuration

```typescript
await app.register(import('@fastify/bearer-auth'), {
  keys: new Set([process.env.MCP_BEARER_TOKEN || 'default-dev-token']),
  auth: {
    extractToken: (request) => {
      return request.headers.authorization?.replace('Bearer ', '')
    }
  }
})
```

## API Reference

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

### Decorators

The plugin adds the following decorators to your Fastify instance:

#### Type-Safe Tool Registration

```typescript
// With TypeBox schema (recommended)
app.mcpAddTool<TSchema extends TObject>(
  definition: { name: string, description: string, inputSchema: TSchema },
  handler?: (params: Static<TSchema>, context?: { sessionId?: string }) => Promise<CallToolResult>
)

// Without schema (unsafe)
app.mcpAddTool(
  definition: { name: string, description: string },
  handler?: (params: any, context?: { sessionId?: string }) => Promise<CallToolResult>
)
```

#### Type-Safe Resource Registration

```typescript
// With URI schema
app.mcpAddResource<TUriSchema extends TSchema>(
  definition: { uriPattern: string, name: string, description: string, uriSchema?: TUriSchema },
  handler?: (uri: Static<TUriSchema>) => Promise<ReadResourceResult>
)

// Without schema
app.mcpAddResource(
  definition: { uriPattern: string, name: string, description: string },
  handler?: (uri: string) => Promise<ReadResourceResult>
)
```

#### Type-Safe Prompt Registration

```typescript
// With argument schema (automatically generates arguments array)
app.mcpAddPrompt<TArgsSchema extends TObject>(
  definition: { name: string, description: string, argumentSchema?: TArgsSchema },
  handler?: (name: string, args: Static<TArgsSchema>) => Promise<GetPromptResult>
)

// Without schema
app.mcpAddPrompt(
  definition: { name: string, description: string, arguments?: PromptArgument[] },
  handler?: (name: string, args: any) => Promise<GetPromptResult>
)
```

#### Messaging Functions

- `app.mcpBroadcastNotification(notification)`: Broadcast a notification to all connected SSE clients (works across Redis instances)
- `app.mcpSendToSession(sessionId, message)`: Send a message/request to a specific SSE session (works across Redis instances)

Handler functions are called when the corresponding MCP methods are invoked:
- Tool handlers receive validated, typed arguments and return `CallToolResult`
- Resource handlers receive validated URIs and return `ReadResourceResult`  
- Prompt handlers receive the prompt name and validated, typed arguments, return `GetPromptResult`

### MCP Endpoints

The plugin exposes the following endpoints:

- `POST /mcp`: Handles JSON-RPC 2.0 messages according to the MCP specification
  - Supports both regular JSON responses and SSE streams based on `Accept` header
  - Returns `Content-Type: application/json` or `Content-Type: text/event-stream`
- `GET /mcp`: Long-lived SSE streams for server-initiated communication (when SSE is enabled)
  - Returns `Content-Type: text/event-stream` with periodic heartbeats

## Supported MCP Methods

- `initialize`: Server initialization
- `ping`: Health check
- `tools/list`: List available tools
- `tools/call`: Execute a tool (calls registered handler or returns error)
- `resources/list`: List available resources
- `resources/read`: Read a resource (calls registered handler or returns error)
- `prompts/list`: List available prompts
- `prompts/get`: Get a prompt (calls registered handler or returns error)

## License

Apache 2.0
