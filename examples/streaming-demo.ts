#!/usr/bin/env node

import Fastify from 'fastify'
import mcpPlugin from '../src/index.js'

const app = Fastify({ logger: true })

// Register MCP plugin with SSE enabled for streaming support
await app.register(mcpPlugin, {
  serverInfo: { name: 'streaming-demo', version: '1.0.0' },
  enableSSE: true
})

// Regular tool that returns immediate results
app.mcpAddTool({
  name: 'immediate_response',
  description: 'Tool that returns an immediate response',
  inputSchema: {
    type: 'object',
    properties: {
      message: { type: 'string' }
    },
    required: ['message']
  }
}, async (params) => {
  return {
    content: [{ type: 'text', text: `Immediate: ${params.message}` }]
  }
})

// Streaming tool using async generator
app.mcpAddTool({
  name: 'streaming_response',
  description: 'Tool that streams responses using async generator',
  inputSchema: {
    type: 'object',
    properties: {
      count: { type: 'number', minimum: 1, maximum: 10 },
      delay: { type: 'number', minimum: 100, maximum: 2000, default: 500 }
    },
    required: ['count']
  }
}, async function * (params) {
  const delay = params.delay ?? 500

  // Yield incremental chunks
  for (let i = 1; i <= params.count; i++) {
    yield {
      content: [{
        type: 'text',
        text: `Streaming chunk ${i}/${params.count}: Processing...`
      }]
    }

    // Simulate async work
    await new Promise(resolve => setTimeout(resolve, delay))
  }

  // Final result
  return {
    content: [{
      type: 'text',
      text: `✅ Completed all ${params.count} processing steps!`
    }]
  }
})

// Streaming tool that simulates file processing
app.mcpAddTool({
  name: 'file_processor',
  description: 'Simulates processing multiple files with streaming updates',
  inputSchema: {
    type: 'object',
    properties: {
      files: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: 5
      }
    },
    required: ['files']
  }
}, async function * (params) {
  for (const [index, filename] of params.files.entries()) {
    // Simulate processing each file
    yield {
      content: [{
        type: 'text',
        text: `📁 Processing file ${index + 1}/${params.files.length}: ${filename}`
      }]
    }

    // Simulate processing time
    await new Promise(resolve => setTimeout(resolve, 800))

    yield {
      content: [{
        type: 'text',
        text: `✅ Completed processing: ${filename}`
      }]
    }
  }

  // Final summary
  return {
    content: [{
      type: 'text',
      text: `🎉 All ${params.files.length} files processed successfully!`
    }]
  }
})

// Error demonstration tool
app.mcpAddTool({
  name: 'error_demo',
  description: 'Demonstrates error handling in streaming',
  inputSchema: {
    type: 'object',
    properties: {
      errorAfter: { type: 'number', minimum: 1, maximum: 5, default: 3 }
    }
  }
}, async function * (params) {
  const errorAfter = params.errorAfter ?? 3

  for (let i = 1; i <= 5; i++) {
    if (i === errorAfter) {
      throw new Error(`Simulated error at step ${i}`)
    }

    yield {
      content: [{
        type: 'text',
        text: `Step ${i}: Everything working fine...`
      }]
    }

    await new Promise(resolve => setTimeout(resolve, 300))
  }

  return {
    content: [{
      type: 'text',
      text: 'This should not be reached due to the error'
    }]
  }
})

// Start the server
const port = parseInt(process.env.PORT || '3000', 10)
const host = process.env.HOST || '127.0.0.1'

try {
  await app.listen({ port, host })
  console.log(`🚀 MCP Streaming Demo Server running on http://${host}:${port}`)
  console.log('\n📖 Usage Examples:')
  console.log(`
  # Test immediate response (returns JSON)
  curl -X POST http://${host}:${port}/mcp \\
    -H "Content-Type: application/json" \\
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"immediate_response","arguments":{"message":"Hello World"}}}'

  # Test streaming response (returns text/event-stream)
  curl -X POST http://${host}:${port}/mcp \\
    -H "Content-Type: application/json" \\
    -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"streaming_response","arguments":{"count":3,"delay":1000}}}'

  # Test file processing simulation
  curl -X POST http://${host}:${port}/mcp \\
    -H "Content-Type: application/json" \\
    -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"file_processor","arguments":{"files":["doc1.pdf","image.jpg","data.csv"]}}}'

  # Test error handling
  curl -X POST http://${host}:${port}/mcp \\
    -H "Content-Type: application/json" \\
    -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"error_demo","arguments":{"errorAfter":2}}}'

  # List all available tools
  curl -X POST http://${host}:${port}/mcp \\
    -H "Content-Type: application/json" \\
    -d '{"jsonrpc":"2.0","id":5,"method":"tools/list","params":{}}'
  `)
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
