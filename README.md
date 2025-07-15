# Fastify MCP

A Fastify plugin that implements the Model Context Protocol (MCP) server using JSON-RPC 2.0. This plugin enables Fastify applications to expose tools, resources, and prompts following the MCP specification.

## Installation

```bash
npm install fastify-mcp
```

## Features

- **Complete MCP Protocol Support**: Implements the full Model Context Protocol specification
- **SSE Streaming**: Server-Sent Events for real-time communication
- **Horizontal Scaling**: Redis-backed session management and message broadcasting
- **Session Persistence**: Message history and reconnection support with Last-Event-ID
- **Memory & Redis Backends**: Seamless switching between local and distributed storage
- **Production Ready**: Comprehensive test coverage and authentication support

## Quick Start

```typescript
import Fastify from 'fastify'
import mcpPlugin from 'fastify-mcp'

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
import mcpPlugin from 'fastify-mcp'

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
import mcpPlugin from 'fastify-mcp'

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

## Authentication & Security

### Bearer Token Authentication

For production deployments, it's recommended to secure the MCP endpoint using the `@fastify/bearer-auth` plugin:

```bash
npm install @fastify/bearer-auth
```

```typescript
import Fastify from 'fastify'
import mcpPlugin from 'fastify-mcp'

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

- `app.mcpAddTool(definition, handler?)`: Register a tool with optional handler function
- `app.mcpAddResource(definition, handler?)`: Register a resource with optional handler function
- `app.mcpAddPrompt(definition, handler?)`: Register a prompt with optional handler function
- `app.mcpBroadcastNotification(notification)`: Broadcast a notification to all connected SSE clients (works across Redis instances)
- `app.mcpSendToSession(sessionId, message)`: Send a message/request to a specific SSE session (works across Redis instances)

Handler functions are called when the corresponding MCP methods are invoked:
- Tool handlers receive the tool arguments and return `CallToolResult`
- Resource handlers receive the URI and return `ReadResourceResult`  
- Prompt handlers receive the prompt name and arguments, return `GetPromptResult`

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

MIT
