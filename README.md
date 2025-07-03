# Fastify MCP

A Fastify plugin that implements the Model Context Protocol (MCP) server using JSON-RPC 2.0. This plugin enables Fastify applications to expose tools, resources, and prompts following the MCP specification.

## Installation

```bash
npm install fastify-mcp
```

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

### Alternative Authentication Methods

You can also use other Fastify authentication plugins:
- `@fastify/jwt` for JWT-based authentication
- `@fastify/basic-auth` for basic authentication
- Custom authentication hooks

```typescript
// Custom authentication hook example
app.addHook('preHandler', async (request, reply) => {
  if (request.url.startsWith('/mcp')) {
    const token = request.headers.authorization?.replace('Bearer ', '')
    if (!token || !isValidToken(token)) {
      reply.code(401).send({ error: 'Unauthorized' })
      return
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

### Decorators

The plugin adds the following decorators to your Fastify instance:

- `app.mcpAddTool(definition, handler?)`: Register a tool with optional handler function
- `app.mcpAddResource(definition, handler?)`: Register a resource with optional handler function
- `app.mcpAddPrompt(definition, handler?)`: Register a prompt with optional handler function
- `app.mcpSessions`: Map<string, SSESession> - Session management for SSE connections

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

## Testing

```bash
npm test
```

## License

MIT
