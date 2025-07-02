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

// Add tools, resources, and prompts
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
})

app.mcpAddResource({
  uri: 'file://config.json',
  name: 'Application Config',
  description: 'Server configuration file',
  mimeType: 'application/json'
})

app.mcpAddPrompt({
  name: 'code-review',
  description: 'Generates code review comments',
  arguments: [{
    name: 'language',
    description: 'Programming language',
    required: true
  }]
})

await app.listen({ port: 3000 })
```

## API Reference

### Plugin Options

- `serverInfo`: Server identification (name, version)
- `capabilities`: MCP capabilities configuration
- `instructions`: Optional server instructions

### Decorators

The plugin adds three decorators to your Fastify instance:

- `app.mcpAddTool(tool)`: Register a tool
- `app.mcpAddResource(resource)`: Register a resource  
- `app.mcpAddPrompt(prompt)`: Register a prompt

### MCP Endpoint

The plugin exposes a POST endpoint at `/mcp` that handles JSON-RPC 2.0 messages according to the MCP specification.

## Supported MCP Methods

- `initialize`: Server initialization
- `ping`: Health check
- `tools/list`: List available tools
- `tools/call`: Execute a tool (returns not implemented by default)
- `resources/list`: List available resources
- `resources/read`: Read a resource (returns not found by default)
- `prompts/list`: List available prompts
- `prompts/get`: Get a prompt (returns not found by default)

## Testing

```bash
npm test
```

## License

MIT
