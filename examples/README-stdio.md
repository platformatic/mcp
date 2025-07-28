# Stdio Transport for Fastify MCP

This directory contains an example of how to use the stdio transport utility with the Fastify MCP plugin.

## Overview

The stdio transport allows MCP clients to communicate with a Fastify MCP server over stdin/stdout, following the MCP stdio transport specification. This is useful for:

- Command-line tools that need to communicate with MCP servers
- Local development and testing
- Integration with text editors and IDEs
- Simple client-server communication without HTTP overhead

## Files

- `stdio-server.ts` - Example MCP server that runs over stdio transport
- `README-stdio.md` - This documentation file

## Usage

### Running the Example Server

```bash
node --experimental-strip-types --no-warnings examples/stdio-server.ts
```

### Testing with JSON-RPC Messages

You can test the server by sending JSON-RPC messages via stdin:

```bash
# Initialize the server
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test-client","version":"1.0.0"}}}' | node --experimental-strip-types --no-warnings examples/stdio-server.ts

# Ping the server
echo '{"jsonrpc":"2.0","id":2,"method":"ping"}' | node --experimental-strip-types --no-warnings examples/stdio-server.ts

# List available tools
echo '{"jsonrpc":"2.0","id":3,"method":"tools/list"}' | node --experimental-strip-types --no-warnings examples/stdio-server.ts

# Call the echo tool
echo '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"echo","arguments":{"text":"Hello, stdio!"}}}' | node --experimental-strip-types --no-warnings examples/stdio-server.ts
```

### Creating Your Own Stdio Server

```typescript
import fastify from 'fastify'
import mcpPlugin from '../src/index.ts'
import { runStdioServer } from '../src/stdio.ts'

// Create a Fastify server
const app = fastify({
  logger: false // Disable HTTP logging to avoid interference with stdio
})

// Register the MCP plugin
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
  name: 'my-tool',
  description: 'My custom tool',
  inputSchema: {
    type: 'object',
    properties: {
      input: { type: 'string' }
    }
  }
}, async (args) => {
  return {
    content: [{
      type: 'text',
      text: `Processed: ${args.input}`
    }]
  }
})

// Wait for the server to be ready
await app.ready()

// Start the stdio transport
await runStdioServer(app, {
  debug: process.env.DEBUG === 'true'
})
```

## API Reference

### `runStdioServer(app, options)`

Starts a Fastify MCP server in stdio mode.

**Parameters:**
- `app` - Fastify instance with MCP plugin registered
- `options` - Optional stdio transport options

**Options:**
- `debug` - Enable debug logging to stderr (default: false)
- `input` - Custom input stream (default: process.stdin)
- `output` - Custom output stream (default: process.stdout)
- `error` - Custom error stream (default: process.stderr)

### `createStdioTransport(app, options)`

Creates a stdio transport instance without starting it.

**Parameters:**
- `app` - Fastify instance with MCP plugin registered
- `options` - Optional stdio transport options

**Returns:** `StdioTransport` instance with `start()` and `stop()` methods

## Transport Protocol

The stdio transport follows the MCP stdio transport specification:

- Messages are exchanged over stdin/stdout
- Each message is a single line of JSON
- Messages are delimited by newlines
- Messages must NOT contain embedded newlines
- Server logs can be written to stderr
- Supports both single messages and batch requests

## Error Handling

The stdio transport provides comprehensive error handling:

- JSON parsing errors return appropriate JSON-RPC error responses
- Invalid method calls return "Method not found" errors
- Tool execution errors are captured and returned in the response
- Connection errors are logged to stderr

## Testing

The stdio transport includes comprehensive tests:

- Unit tests for transport creation and configuration
- Integration tests that spawn actual subprocess servers
- Tests for error handling and batch requests

Run the tests with:

```bash
npm test
```