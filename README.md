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

## API Reference

### Plugin Options

- `serverInfo`: Server identification (name, version)
- `capabilities`: MCP capabilities configuration
- `instructions`: Optional server instructions

### Decorators

The plugin adds three decorators to your Fastify instance:

- `app.mcpAddTool(definition, handler?)`: Register a tool with optional handler function
- `app.mcpAddResource(definition, handler?)`: Register a resource with optional handler function
- `app.mcpAddPrompt(definition, handler?)`: Register a prompt with optional handler function

Handler functions are called when the corresponding MCP methods are invoked:
- Tool handlers receive the tool arguments and return `CallToolResult`
- Resource handlers receive the URI and return `ReadResourceResult`  
- Prompt handlers receive the prompt name and arguments, return `GetPromptResult`

### MCP Endpoint

The plugin exposes a POST endpoint at `/mcp` that handles JSON-RPC 2.0 messages according to the MCP specification.

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
