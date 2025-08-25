# Fastify MCP Server

A Fastify plugin that implements the Model Context Protocol (MCP) server using JSON-RPC 2.0. This plugin enables Fastify applications to expose tools, resources, and prompts following the MCP 2025-06-18 specification with full elicitation support.

## Installation

```bash
npm install @platformatic/mcp
```

### TypeBox Support (Optional)

For type-safe schema validation, install TypeBox:

```bash
npm install @sinclair/typebox
```

## Features

- **Complete MCP 2025-06-18 Support**: Implements the full Model Context Protocol specification with elicitation
- **Elicitation Support**: Server-to-client information requests with schema validation
- **TypeBox Validation**: Type-safe schema validation with automatic TypeScript inference
- **Security Enhancements**: Input sanitization, rate limiting, and security assessment
- **Multiple Transport Support**: HTTP/SSE and stdio transports for flexible communication
- **SSE Streaming**: Server-Sent Events for real-time communication
- **Horizontal Scaling**: Redis-backed session management and message broadcasting
- **Session Persistence**: Message history and reconnection support with Last-Event-ID
- **Memory & Redis Backends**: Seamless switching between local and distributed storage
- **Production Ready**: Comprehensive test coverage, security features, and authentication support

## Quick Start

```typescript
import Fastify from 'fastify'
import mcpPlugin from '@platformatic/mcp'
// Or use named import:
// import { mcpPlugin } from '@platformatic/mcp'

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

## Elicitation Support (MCP 2025-06-18)

The plugin supports the elicitation capability, allowing servers to request structured information from clients. This enables dynamic data collection with schema validation.

### Basic Elicitation

```typescript
import { Type } from '@sinclair/typebox'

// Register plugin with elicitation support
await app.register(mcpPlugin, {
  enableSSE: true, // Required for elicitation
  capabilities: {
    elicitation: {} // Enable elicitation capability
  }
})

// In your tool handler, request information from the client
app.mcpAddTool({
  name: 'collect-user-info',
  description: 'Collect user information',
  inputSchema: Type.Object({})
}, async (params, { sessionId }) => {
  if (!sessionId) {
    return { 
      content: [{ type: 'text', text: 'No session available' }],
      isError: true 
    }
  }

  // Request user details with schema validation
  const success = await app.mcpElicit(sessionId, 'Please enter your details', {
    type: 'object',
    properties: {
      name: { 
        type: 'string', 
        description: 'Your full name',
        minLength: 1,
        maxLength: 100
      },
      email: {
        type: 'string',
        description: 'Your email address',
        format: 'email'
      },
      age: {
        type: 'integer',
        description: 'Your age',
        minimum: 0,
        maximum: 150
      },
      preferences: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['newsletter', 'updates', 'marketing']
        },
        description: 'Communication preferences'
      }
    },
    required: ['name', 'email']
  })

  if (success) {
    return { 
      content: [{ type: 'text', text: 'Information request sent to client' }] 
    }
  } else {
    return { 
      content: [{ type: 'text', text: 'Failed to send elicitation request' }],
      isError: true 
    }
  }
})
```

### Advanced Elicitation with Custom Request IDs

```typescript
// Request with custom ID for tracking
const requestId = 'user-profile-123'
const success = await app.mcpElicit(
  sessionId, 
  'Complete your profile setup',
  {
    type: 'object',
    properties: {
      avatar: { type: 'string', description: 'Avatar URL' },
      bio: { type: 'string', maxLength: 500, description: 'Short bio' },
      skills: {
        type: 'array',
        items: { type: 'string' },
        maxItems: 10,
        description: 'Your skills'
      }
    }
  },
  requestId
)
```

### Security Considerations for Elicitation

⚠️ **Important Security Notes:**

- Elicitation requests are automatically validated for length and complexity
- Schema depth and size are limited to prevent DoS attacks
- Rate limiting should be implemented for production use
- Always validate client responses before using the data
- Never request sensitive information without explicit user consent

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
import mcpPlugin from '@platformatic/mcp'

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
import mcpPlugin from '@platformatic/mcp'

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
import mcpPlugin from '@platformatic/mcp'

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
import mcpPlugin, { runStdioServer } from '@platformatic/mcp'

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
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test-client","version":"1.0.0"}}}' | node server.js

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

## OAuth 2.1 Authorization Integration

The plugin includes comprehensive OAuth 2.1 authorization support for secure MCP communication. This enables token-based authentication, session management, and secure multi-user environments.

### Key Features

- **Complete OAuth 2.1 Support**: Authorization Code Flow with PKCE
- **Session-Based Authorization**: Token-to-session mapping with secure context
- **Authorization-Aware SSE**: User-specific session isolation and message routing
- **Automatic Token Refresh**: Background token refresh with retry logic
- **JWT Token Validation**: Support for JWT tokens with JWKS endpoints
- **Token Introspection**: RFC 7662 compliant token introspection
- **Dynamic Client Registration**: RFC 7591 compliant client registration
- **Horizontal Scaling**: Redis-backed authorization context persistence

### Quick OAuth Setup

```typescript
import Fastify from 'fastify'
import mcpPlugin from '@platformatic/mcp'

const app = Fastify({ logger: true })

await app.register(mcpPlugin, {
  serverInfo: {
    name: 'secure-mcp-server',
    version: '1.0.0'
  },
  capabilities: {
    tools: {},
    resources: {},
    prompts: {}
  },
  enableSSE: true, // Required for session-based authorization
  // Enable OAuth 2.1 authorization
  authorization: {
    enabled: true,
    // JWT Token Validation
    tokenValidation: {
      jwksUri: 'https://auth.example.com/.well-known/jwks.json',
      validateAudience: ['https://api.example.com'],
      validateIssuer: 'https://auth.example.com'
    },
    // OAuth 2.1 Client Configuration
    oauthClient: {
      clientId: process.env.OAUTH_CLIENT_ID,
      clientSecret: process.env.OAUTH_CLIENT_SECRET,
      authorizationEndpoint: 'https://auth.example.com/oauth/authorize',
      tokenEndpoint: 'https://auth.example.com/oauth/token',
      redirectUri: 'https://yourapp.com/oauth/callback',
      scopes: ['read', 'write']
    }
  },
  // Redis for session persistence (recommended)
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379')
  }
})

await app.listen({ port: 3000 })
```

### Authorization Workflow

#### 1. OAuth Authorization Flow

```typescript
// Start OAuth authorization
const authResponse = await fetch('/oauth/authorize?redirect_uri=https://yourapp.com/dashboard')

// Handle callback with authorization code
const tokenResponse = await fetch('/oauth/callback', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    code: 'auth_code_from_callback',
    state: 'csrf_state_token'
  })
})

const { access_token, refresh_token } = await tokenResponse.json()
```

#### 2. Authenticated MCP Requests

```typescript
// Use access token for MCP requests
const mcpResponse = await fetch('/mcp', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${access_token}`,
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream' // For SSE
  },
  body: JSON.stringify({
    jsonrpc: '2.0',
    method: 'tools/list',
    id: 1
  })
})
```

#### 3. Session-Based SSE Connections

```typescript
// SSE connection with authorization
const eventSource = new EventSource('/mcp', {
  headers: {
    'Authorization': `Bearer ${access_token}`,
    'Accept': 'text/event-stream'
  }
})

eventSource.onmessage = (event) => {
  const message = JSON.parse(event.data)
  console.log('Received:', message)
}

// Server can send user-specific messages
// app.mcpSendToUser(userId, notification)
```

### Authorization Configuration

#### JWT Token Validation

```typescript
authorization: {
  enabled: true,
  tokenValidation: {
    // JWKS endpoint for public key retrieval
    jwksUri: 'https://auth.example.com/.well-known/jwks.json',
    
    // Validate token audience
    validateAudience: ['https://api.example.com', 'mcp-server'],
    
    // Validate token issuer
    validateIssuer: 'https://auth.example.com',
    
    // Optional: Custom validation function
    customValidation: async (payload, token) => {
      // Custom validation logic
      return payload.sub && payload.scope?.includes('mcp:access')
    }
  }
}
```

#### Token Introspection (RFC 7662)

```typescript
authorization: {
  enabled: true,
  tokenValidation: {
    // Use token introspection instead of JWT
    introspectionEndpoint: 'https://auth.example.com/oauth/introspect',
    clientId: process.env.OAUTH_CLIENT_ID,
    clientSecret: process.env.OAUTH_CLIENT_SECRET
  }
}
```

#### OAuth Client Configuration

```typescript
authorization: {
  enabled: true,
  oauthClient: {
    clientId: process.env.OAUTH_CLIENT_ID,
    clientSecret: process.env.OAUTH_CLIENT_SECRET,
    
    // Authorization server endpoints
    authorizationEndpoint: 'https://auth.example.com/oauth/authorize',
    tokenEndpoint: 'https://auth.example.com/oauth/token',
    
    // Application configuration
    redirectUri: 'https://yourapp.com/oauth/callback',
    scopes: ['read', 'write', 'admin'],
    
    // Optional: Dynamic client registration
    registrationEndpoint: 'https://auth.example.com/oauth/register',
    
    // PKCE configuration (recommended)
    usePKCE: true
  }
}
```

### Session-Based Authorization

The plugin maps OAuth tokens to MCP sessions for efficient authorization:

```typescript
// Authorization context automatically added to sessions
interface SessionMetadata {
  id: string
  authorization?: {
    userId: string
    clientId: string
    scopes: string[]
    tokenHash: string // Secure hash of access token
    expiresAt: Date
    // ... additional context
  }
  tokenRefresh?: {
    refreshToken: string
    clientId: string
    authorizationServer: string
    scopes: string[]
  }
}
```

### User-Specific Message Routing

Send messages to specific users across all their sessions:

```typescript
// In your tool handler
app.mcpAddTool({
  name: 'notify-user',
  description: 'Send notification to user',
  inputSchema: Type.Object({
    userId: Type.String(),
    message: Type.String()
  })
}, async (params, { sessionId, authContext }) => {
  // Send to all sessions for this user
  await app.mcpSendToUser(params.userId, {
    jsonrpc: '2.0',
    method: 'notifications/message',
    params: {
      level: 'info',
      message: params.message
    }
  })
  
  return { content: [{ type: 'text', text: 'Notification sent' }] }
})
```

### Automatic Token Refresh

The plugin includes a background service for automatic token refresh:

```typescript
// Token refresh configuration
authorization: {
  enabled: true,
  tokenRefresh: {
    // Check for expiring tokens every 5 minutes
    checkIntervalMs: 5 * 60 * 1000,
    
    // Refresh tokens 5 minutes before expiry
    refreshBufferMinutes: 5,
    
    // Maximum refresh attempts
    maxRetries: 3
  }
}

// Manual token refresh
const success = await app.tokenRefreshService.refreshSessionToken(sessionId)

// Token refresh notifications sent via SSE
// Client receives: { method: 'notifications/token_refreshed', params: { access_token: '...' } }
```

### Authorization-Aware Tools

Access authorization context in tool handlers:

```typescript
app.mcpAddTool({
  name: 'user-profile',
  description: 'Get user profile information',
  inputSchema: Type.Object({})
}, async (params, { authContext }) => {
  if (!authContext?.userId) {
    return {
      content: [{ type: 'text', text: 'Authentication required' }],
      isError: true
    }
  }
  
  // Check required scopes
  if (!authContext.scopes?.includes('profile:read')) {
    return {
      content: [{ type: 'text', text: 'Insufficient permissions' }],
      isError: true
    }
  }
  
  // Use user context
  const profile = await getUserProfile(authContext.userId)
  
  return {
    content: [{
      type: 'text',
      text: `Profile: ${JSON.stringify(profile, null, 2)}`
    }]
  }
})
```

### OAuth Routes

The plugin automatically registers OAuth management routes:

- `GET /oauth/authorize` - Start OAuth authorization flow
- `POST /oauth/callback` - Handle authorization callback
- `POST /oauth/refresh` - Refresh access tokens
- `POST /oauth/validate` - Validate token
- `GET /oauth/status` - Check authorization status
- `POST /oauth/logout` - Revoke tokens and end session
- `POST /oauth/register` - Dynamic client registration (if enabled)

### Well-Known Endpoints

Authorization-aware metadata endpoints:

- `GET /.well-known/mcp-server` - Server metadata (protected)
- `GET /health` - Health check (public)

### Security Considerations

#### Token Security

- **Secure Token Storage**: Tokens are hashed using SHA-256 for session mapping
- **Token Expiration**: Automatic cleanup of expired tokens and sessions
- **Scope Validation**: Granular permission checking in tool handlers
- **PKCE Support**: Proof Key for Code Exchange prevents authorization code interception

#### Session Isolation

- **User-Specific Sessions**: Sessions are isolated by user ID
- **Cross-Session Protection**: Users can only access their own sessions
- **Token Binding**: Sessions are cryptographically bound to specific tokens

#### Production Deployment

```typescript
// Production security configuration
authorization: {
  enabled: true,
  tokenValidation: {
    jwksUri: 'https://auth.company.com/.well-known/jwks.json',
    validateAudience: ['https://mcp.company.com'],
    validateIssuer: 'https://auth.company.com',
    
    // Custom security validation
    customValidation: async (payload, token) => {
      // Check token blacklist
      const isBlacklisted = await checkTokenBlacklist(token)
      if (isBlacklisted) return false
      
      // Validate custom claims
      return payload.department === 'engineering' && 
             payload.clearance_level >= 3
    }
  },
  
  // Rate limiting for auth endpoints
  rateLimiting: {
    enabled: true,
    maxRequests: 100,
    windowMs: 60000 // 1 minute
  }
}
```

### Testing Authorization

```typescript
// Test with valid token
const response = await app.inject({
  method: 'POST',
  url: '/mcp',
  headers: {
    'Authorization': 'Bearer valid-jwt-token',
    'Content-Type': 'application/json'
  },
  payload: {
    jsonrpc: '2.0',
    method: 'tools/list',
    id: 1
  }
})

// Test authorization failure
const unauthorized = await app.inject({
  method: 'POST',
  url: '/mcp',
  payload: { jsonrpc: '2.0', method: 'tools/list', id: 1 }
})
assert.strictEqual(unauthorized.statusCode, 401)
```

## Authentication & Security

The plugin implements comprehensive security measures to protect against common attacks and ensure safe operation with untrusted inputs.

### Security Features

- **OAuth 2.1 Authorization**: Complete authorization framework with session management
- **Input Sanitization**: Automatic sanitization of tool parameters and elicitation requests
- **Schema Validation**: TypeBox-based validation with length and complexity limits
- **Rate Limiting**: Built-in rate limiting capabilities for high-risk operations
- **Security Assessment**: Automatic risk assessment for tool annotations
- **DoS Protection**: Object depth limits, string length limits, and circular reference detection

### Tool Security Assessment

The plugin automatically assesses tool security risks based on annotations:

```typescript
app.mcpAddTool({
  name: 'file-operations',
  description: 'File system operations',
  annotations: {
    destructiveHint: true,  // ⚠️ High risk - logs security warning
    openWorldHint: false,   // 🔒 Closed world - medium risk
    readOnlyHint: false     // ✏️ Can modify environment
  },
  inputSchema: Type.Object({
    operation: Type.Union([
      Type.Literal('read'),
      Type.Literal('write'), 
      Type.Literal('delete')
    ]),
    path: Type.String({ maxLength: 1000 })
  })
}, async (params) => {
  // Tool parameters are automatically sanitized and validated
  // Security warnings are logged for high-risk operations
  return { content: [{ type: 'text', text: 'Operation completed' }] }
})
```

### Input Validation and Sanitization

All inputs undergo automatic security processing:

```typescript
// Automatic security measures applied:
// ✅ String length limits (max 10,000 chars)
// ✅ Object depth limits (max 10 levels)
// ✅ Property count limits (max 100 per object)
// ✅ Control character removal
// ✅ Circular reference detection
// ✅ Schema complexity validation
```

### Rate Limiting

Implement rate limiting for production deployments:

```typescript
import { RateLimiter } from '@platformatic/mcp/security'

const rateLimiter = new RateLimiter(100, 60000) // 100 requests per minute

// Use in tool handlers
app.mcpAddTool({
  name: 'rate-limited-tool',
  description: 'Tool with rate limiting',
  inputSchema: Type.Object({})
}, async (params, { sessionId }) => {
  if (sessionId && !rateLimiter.isAllowed(sessionId)) {
    return {
      content: [{ type: 'text', text: 'Rate limit exceeded' }],
      isError: true
    }
  }
  
  // Process request...
  return { content: [{ type: 'text', text: 'Success' }] }
})
```

### Bearer Token Authentication

For production deployments, secure the MCP endpoint using the `@fastify/bearer-auth` plugin:

```bash
npm install @fastify/bearer-auth
```

```typescript
import Fastify from 'fastify'
import mcpPlugin from '@platformatic/mcp'

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
- `authorization`: OAuth 2.1 authorization configuration (optional)
  - `enabled`: Enable OAuth 2.1 authorization (default: false)
  - `tokenValidation`: JWT token validation configuration
    - `jwksUri`: JWKS endpoint URL for JWT signature verification
    - `validateAudience`: Expected token audience(s)
    - `validateIssuer`: Expected token issuer
    - `customValidation`: Custom validation function
    - `introspectionEndpoint`: Token introspection endpoint (alternative to JWT)
    - `clientId`: OAuth client ID for introspection
    - `clientSecret`: OAuth client secret for introspection
  - `oauthClient`: OAuth 2.1 client configuration
    - `clientId`: OAuth client identifier
    - `clientSecret`: OAuth client secret
    - `authorizationEndpoint`: Authorization server authorization endpoint
    - `tokenEndpoint`: Authorization server token endpoint
    - `redirectUri`: OAuth redirect URI
    - `scopes`: Requested OAuth scopes
    - `registrationEndpoint`: Dynamic client registration endpoint (optional)
    - `usePKCE`: Enable PKCE (Proof Key for Code Exchange)
  - `tokenRefresh`: Automatic token refresh configuration
    - `checkIntervalMs`: Token refresh check interval
    - `refreshBufferMinutes`: Minutes before expiry to refresh tokens
    - `maxRetries`: Maximum refresh attempts
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
  handler?: (params: Static<TSchema>, context?: { 
    sessionId?: string,
    request?: FastifyRequest,
    reply?: FastifyReply,
    authContext?: AuthorizationContext
  }) => Promise<CallToolResult>
)

// Without schema (unsafe)
app.mcpAddTool(
  definition: { name: string, description: string },
  handler?: (params: any, context?: { 
    sessionId?: string,
    request?: FastifyRequest,
    reply?: FastifyReply,
    authContext?: AuthorizationContext
  }) => Promise<CallToolResult>
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

#### HTTP Context Access in Tool Handlers

Tool handlers can access the Fastify request and reply objects through the context parameter, enabling tools to interact with HTTP-specific features like headers, query parameters, and custom response headers.

```typescript
app.mcpAddTool({
  name: 'context-aware-tool',
  description: 'Tool that uses HTTP context',
  inputSchema: Type.Object({
    message: Type.String()
  })
}, async (params, context) => {
  // Access request information
  const userAgent = context?.request?.headers['user-agent']
  const queryParams = context?.request?.query
  const requestUrl = context?.request?.url
  
  // Set custom response headers
  if (context?.reply) {
    context.reply.header('x-processed-by', 'mcp-tool')
    context.reply.header('x-request-id', Date.now().toString())
  }
  
  return {
    content: [{
      type: 'text',
      text: `Processed "${params.message}" from ${userAgent || 'unknown client'}`
    }]
  }
})
```

#### Available Context Properties

- `context.request`: Full Fastify request object with access to:
  - `headers`: HTTP request headers
  - `query`: Query string parameters
  - `params`: Route parameters
  - `url`: Request URL
  - `method`: HTTP method
  - `body`: Request body (when applicable)
- `context.reply`: Fastify reply object for setting response headers
- `context.sessionId`: Session identifier (when using SSE)
- `context.authContext`: Authorization context (when OAuth is enabled)

#### Backward Compatibility

Existing tool handlers continue to work unchanged. The request and reply objects are optional in the context parameter:

```typescript
// Existing handler (still works)
app.mcpAddTool({
  name: 'legacy-tool',
  description: 'Works as before',
  inputSchema: Type.Object({ msg: Type.String() })
}, async (params) => {
  return { content: [{ type: 'text', text: params.msg }] }
})

// Handler using only sessionId (still works)
app.mcpAddTool({
  name: 'session-tool',
  description: 'Uses session ID only',
  inputSchema: Type.Object({})
}, async (params, { sessionId }) => {
  return { content: [{ type: 'text', text: `Session: ${sessionId}` }] }
})
```

### Messaging Functions

- `app.mcpBroadcastNotification(notification)`: Broadcast a notification to all connected SSE clients (works across Redis instances)
- `app.mcpSendToSession(sessionId, message)`: Send a message/request to a specific SSE session (works across Redis instances)
- `app.mcpSendToUser(userId, message)`: Send a message to all sessions for a specific user (authorization-aware)

#### Authorization Functions

- `app.tokenRefreshService`: Token refresh service instance for manual token refresh
  - `refreshSessionToken(sessionId)`: Manually refresh token for a session
  - `notifyTokenRefresh(sessionId, token, response)`: Send token refresh notification

Handler functions are called when the corresponding MCP methods are invoked:
- Tool handlers receive validated, typed arguments and return `CallToolResult`
- Resource handlers receive validated URIs and return `ReadResourceResult`  
- Prompt handlers receive the prompt name and validated, typed arguments, return `GetPromptResult`

### MCP Endpoints

The plugin exposes the following endpoints:

- `POST /mcp`: Handles JSON-RPC 2.0 messages according to the MCP specification
  - Supports both regular JSON responses and SSE streams based on `Accept` header
  - Returns `Content-Type: application/json` or `Content-Type: text/event-stream`
  - Authorization-aware when OAuth is enabled
- `GET /mcp`: Long-lived SSE streams for server-initiated communication (when SSE is enabled)
  - Returns `Content-Type: text/event-stream` with periodic heartbeats
  - Authorization-aware with user-specific session isolation

### OAuth Endpoints (when authorization is enabled)

- `GET /oauth/authorize`: Start OAuth authorization flow with PKCE
- `POST /oauth/callback`: Handle authorization callback and exchange code for tokens
- `POST /oauth/refresh`: Refresh access tokens using refresh tokens
- `POST /oauth/validate`: Validate access tokens (JWT or introspection)
- `GET /oauth/status`: Check current authorization status
- `POST /oauth/logout`: Revoke tokens and end OAuth session
- `POST /oauth/register`: Dynamic client registration (if enabled)

### Well-Known Endpoints

- `GET /.well-known/mcp-server`: Server metadata and capabilities (protected when authorization is enabled)
- `GET /health`: Health check endpoint (always public)

## Supported MCP Methods

- `initialize`: Server initialization
- `ping`: Health check
- `tools/list`: List available tools
- `tools/call`: Execute a tool (calls registered handler or returns error)
- `resources/list`: List available resources
- `resources/read`: Read a resource (calls registered handler or returns error)
- `prompts/list`: List available prompts
- `prompts/get`: Get a prompt (calls registered handler or returns error)

## Security Best Practices

This section outlines security considerations and best practices when using the Fastify MCP plugin implementation.

### ⚠️ Important Security Notices

#### Tool Annotations Are Hints Only

**🚨 CRITICAL:** Tool annotations (such as `destructiveHint`, `openWorldHint`, etc.) are **hints from potentially untrusted servers** and should **NEVER** be used for security decisions.

- Annotations can be provided by untrusted MCP servers
- They are not guaranteed to accurately describe tool behavior  
- Always implement your own security validation regardless of annotations
- Use annotations only for UI/UX improvements, not security controls

#### Elicitation Security

When using the elicitation feature (server-to-client information requests):

- **Validate all user inputs** before processing elicitation responses
- **Limit elicitation message length** to prevent DoS attacks
- **Validate schema complexity** to prevent resource exhaustion
- **Implement rate limiting** for elicitation requests
- **Always require user consent** before sharing sensitive information

### Input Validation and Sanitization

#### Tool Parameters

The plugin automatically sanitizes tool parameters to prevent common attacks:

- **String length limits:** Maximum 10,000 characters per string
- **Object depth limits:** Maximum 10 levels of nesting
- **Property count limits:** Maximum 100 properties per object
- **Control character removal:** Strips null bytes and control characters
- **Circular reference detection:** Prevents infinite loops

#### Schema Validation

All inputs are validated against TypeBox schemas:

```typescript
// Example: Secure tool definition
app.mcpAddTool({
  name: 'secure-tool',
  description: 'A tool with proper validation',
  inputSchema: Type.Object({
    message: Type.String({ 
      minLength: 1, 
      maxLength: 1000,
      description: 'User message'
    }),
    priority: Type.Union([
      Type.Literal('low'),
      Type.Literal('medium'), 
      Type.Literal('high')
    ])
  })
}, async (params) => {
  // params are automatically validated and sanitized
  return { content: [{ type: 'text', text: 'OK' }] }
})
```

### Tool Security Assessment

The plugin automatically assesses tool security risks:

#### Risk Levels

- **Low Risk:** Read-only tools with closed-world domains
- **Medium Risk:** Tools that interact with external entities
- **High Risk:** Destructive tools that modify the environment

#### Security Warnings

The following warnings are logged for different tool types:

```typescript
// High-risk tool example
app.mcpAddTool({
  name: 'file-delete',
  description: 'Delete files',
  annotations: {
    destructiveHint: true,  // ⚠️ Triggers high-risk warning
    openWorldHint: false
  },
  inputSchema: Type.Object({
    path: Type.String()
  })
}, handler)
```

### Rate Limiting

Implement rate limiting to prevent abuse:

```typescript
import { RateLimiter } from '@platformatic/mcp/security'

const rateLimiter = new RateLimiter(100, 60000) // 100 requests per minute

// Check before processing requests
if (!rateLimiter.isAllowed(sessionId)) {
  throw new Error('Rate limit exceeded')
}
```

### Redis Security (Production Deployments)

When using Redis for horizontal scaling:

#### Connection Security

```typescript
await app.register(mcpPlugin, {
  enableSSE: true,
  redis: {
    host: 'your-redis-host',
    port: 6379,
    password: process.env.REDIS_PASSWORD, // Always use authentication
    db: 0,
    // Enable TLS for production
    tls: {
      rejectUnauthorized: true
    }
  }
})
```

#### Redis Best Practices

- **Always use authentication:** Set `requirepass` in Redis config
- **Enable TLS encryption:** Especially for remote Redis instances
- **Use dedicated Redis database:** Isolate MCP data with `db` parameter
- **Implement network security:** Use VPCs, security groups, firewalls
- **Regular updates:** Keep Redis version up-to-date
- **Monitor access:** Log and monitor Redis access patterns

### Session Security

#### Session Management

- **Session IDs are cryptographically secure:** Generated using Node.js crypto
- **Automatic cleanup:** Sessions expire after 1 hour by default
- **Message history limits:** Prevents unbounded memory growth
- **Cross-instance isolation:** Sessions are properly isolated between instances

#### SSE Security

Server-Sent Events implementation includes:

- **Proper CORS handling:** Configure CORS policies appropriately
- **Connection limits:** Implement connection limits per client
- **Heartbeat monitoring:** Automatic cleanup of dead connections
- **Message replay security:** Last-Event-ID validation

### Environment Security

#### Environment Variables

Never expose sensitive configuration:

```bash
# ✅ Good: Use environment variables
REDIS_PASSWORD=your-secure-password
MCP_SECRET_KEY=your-secret-key

# ❌ Bad: Hardcoded secrets
const redis = { password: 'hardcoded-password' }
```

#### Logging Security

- **Sanitize log output:** Remove sensitive data from logs
- **Log security events:** Tool executions, validation failures
- **Monitor logs:** Set up alerts for suspicious activity

```typescript
// Example: Secure logging
app.log.info({
  tool: toolName,
  sessionId,
  // ❌ Never log sensitive parameters
  // params: toolParams
}, 'Tool executed successfully')
```

### Transport Security

#### HTTPS Requirements

**Always use HTTPS in production:**

```typescript
const app = fastify({
  https: {
    key: fs.readFileSync('path/to/key.pem'),
    cert: fs.readFileSync('path/to/cert.pem')
  }
})
```

### Error Handling Security

#### Information Disclosure

Prevent information leakage in error messages:

```typescript
// ✅ Good: Generic error messages
return createError(request.id, INVALID_PARAMS, 'Invalid parameters')

// ❌ Bad: Detailed error messages
return createError(request.id, INVALID_PARAMS, `SQL injection attempt detected: ${details}`)
```

#### Error Logging

Log detailed errors securely:

```typescript
try {
  // risky operation
} catch (error) {
  // Log detailed error for debugging
  app.log.error({ error, sessionId, toolName }, 'Tool execution failed')
  
  // Return generic error to client
  return { content: [{ type: 'text', text: 'Operation failed' }], isError: true }
}
```

### Security Monitoring and Alerting

#### Security Metrics

Monitor these security-related metrics:

- Failed validation attempts per session
- Rate limit violations
- High-risk tool executions  
- Unusual session patterns
- Redis connection failures

#### Alert Conditions

Set up alerts for:

- Multiple validation failures from same IP
- Rapid tool execution patterns
- Large payload sizes
- Suspicious schema patterns in elicitation

### Security Updates

#### Keeping Secure

- **Regular updates:** Keep all dependencies up-to-date
- **Security advisories:** Subscribe to security notifications
- **Vulnerability scanning:** Regularly scan for known vulnerabilities
- **Security testing:** Include security tests in your CI/CD pipeline

### Quick Security Checklist

- [ ] All tool inputs are validated with TypeBox schemas
- [ ] Rate limiting is implemented for high-risk operations
- [ ] Redis authentication and TLS are configured
- [ ] HTTPS is enabled in production
- [ ] Error messages don't leak sensitive information
- [ ] Security monitoring and alerting are in place
- [ ] Regular security updates are applied
- [ ] Audit logging is configured
- [ ] Tool annotations are treated as untrusted hints only
- [ ] Elicitation requests include user consent mechanisms

Remember: Security is a layered approach. No single measure provides complete protection.

## Migration from Earlier Versions

### Upgrading to MCP 2025-06-18

This version introduces elicitation support and enhanced security features:

**New Features:**
- Elicitation capability for server-to-client information requests
- Enhanced input sanitization and validation
- Automatic security assessment for tool annotations
- Built-in rate limiting utilities

**Breaking Changes:**
- Protocol version updated to `2025-06-18`
- Enhanced validation may reject previously accepted inputs
- Security logging may produce additional log entries

**Migration Steps:**
1. Update client applications to support MCP 2025-06-18
2. Add elicitation capability if needed: `capabilities: { elicitation: {} }`
3. Review security logs for any validation warnings
4. Consider implementing rate limiting for production deployments

## License

Apache 2.0
