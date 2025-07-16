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
    name: 'fastify-mcp-stdio-example',
    version: '1.0.0'
  },
  capabilities: {
    tools: {},
    resources: {},
    prompts: {}
  },
  instructions: 'This is an example MCP server running over stdio transport.'
})

// Example: Register a simple tool
app.mcpAddTool({
  name: 'echo',
  description: 'Echo back the input text',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Text to echo back' }
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

// Example: Register a simple resource
app.mcpAddResource({
  uri: 'system://info',
  name: 'System Information',
  description: 'Basic system information',
  mimeType: 'application/json'
}, async (uri) => {
  return {
    contents: [{
      uri,
      text: JSON.stringify({
        platform: process.platform,
        nodeVersion: process.version,
        pid: process.pid,
        uptime: process.uptime()
      }, null, 2),
      mimeType: 'application/json'
    }]
  }
})

// Example: Register a simple prompt
app.mcpAddPrompt({
  name: 'greeting',
  description: 'A greeting prompt',
  arguments: [{
    name: 'name',
    description: 'Name to greet',
    required: true
  }]
}, async (_name, args) => {
  return {
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: `Hello, ${args.name}! How can I help you today?`
      }
    }]
  }
})

// Wait for the server to be ready
await app.ready()

// Start the stdio transport
await runStdioServer(app, {
  debug: process.env.DEBUG === 'true'
})
