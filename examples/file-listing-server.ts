import Fastify from 'fastify'
import { promises as fs } from 'fs'
import { join, relative } from 'path'
import mcpPlugin from '../src/index.ts'

const fastify = Fastify({
  logger: {
    level: 'info'
  }
})

// Register the MCP plugin
await fastify.register(mcpPlugin, {
  serverInfo: {
    name: 'file-listing-server',
    version: '1.0.0'
  },
  capabilities: {
    tools: {},
    resources: {},
    prompts: {}
  },
  instructions: 'A file system listing server that can list files and directories'
})

// Add a tool to list files in a directory
fastify.mcpAddTool({
  name: 'list_files',
  description: 'List files and directories in a given path',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The directory path to list files from (defaults to current directory)',
        default: '.'
      },
      show_hidden: {
        type: 'boolean',
        description: 'Whether to show hidden files (files starting with .)',
        default: false
      }
    }
  }
}, async (params) => {
  const { path = '.', show_hidden = false } = params
  
  try {
    const fullPath = join(process.cwd(), path)
    const items = await fs.readdir(fullPath, { withFileTypes: true })
    
    const filteredItems = items.filter(item => {
      if (!show_hidden && item.name.startsWith('.')) {
        return false
      }
      return true
    })
    
    const fileList = filteredItems.map(item => ({
      name: item.name,
      type: item.isDirectory() ? 'directory' : 'file',
      path: relative(process.cwd(), join(fullPath, item.name))
    }))
    
    return {
      content: [{
        type: 'text',
        text: `Found ${fileList.length} items in ${path}:\n\n` +
              fileList.map(item => `${item.type === 'directory' ? '📁' : '📄'} ${item.name} (${item.path})`).join('\n')
      }]
    }
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Error listing files: ${error.message}`
      }],
      isError: true
    }
  }
})

// Add a tool to get file info
fastify.mcpAddTool({
  name: 'get_file_info',
  description: 'Get detailed information about a file or directory',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The file or directory path to get info about'
      }
    },
    required: ['path']
  }
}, async (params) => {
  const { path } = params
  
  try {
    const fullPath = join(process.cwd(), path)
    const stats = await fs.stat(fullPath)
    
    return {
      content: [{
        type: 'text',
        text: `File info for ${path}:\n\n` +
              `Type: ${stats.isDirectory() ? 'Directory' : 'File'}\n` +
              `Size: ${stats.size} bytes\n` +
              `Modified: ${stats.mtime.toISOString()}\n` +
              `Created: ${stats.birthtime.toISOString()}\n` +
              `Permissions: ${stats.mode.toString(8)}`
      }]
    }
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Error getting file info: ${error.message}`
      }],
      isError: true
    }
  }
})

// Add a resource to read file contents
fastify.mcpAddResource({
  uri: 'file://read',
  name: 'Read File',
  description: 'Read the contents of a file',
  mimeType: 'text/plain'
}, async (uri) => {
  // Extract file path from URI query parameter
  const url = new URL(uri)
  const filePath = url.searchParams.get('path')
  
  if (!filePath) {
    return {
      contents: [{
        uri,
        text: 'Error: No file path specified. Use ?path=<filepath>',
        mimeType: 'text/plain'
      }]
    }
  }
  
  try {
    const fullPath = join(process.cwd(), filePath)
    const content = await fs.readFile(fullPath, 'utf-8')
    
    return {
      contents: [{
        uri,
        text: content,
        mimeType: 'text/plain'
      }]
    }
  } catch (error) {
    return {
      contents: [{
        uri,
        text: `Error reading file: ${error.message}`,
        mimeType: 'text/plain'
      }]
    }
  }
})

// Start the server
try {
  const port = process.env.PORT ? Number(process.env.PORT) : 3000
  await fastify.listen({ port })
  console.log(`🚀 MCP File Listing Server started on port ${port}`)
  console.log('📁 Available tools:')
  console.log('  - list_files: List files in a directory')
  console.log('  - get_file_info: Get detailed file information')
  console.log('📄 Available resources:')
  console.log('  - file://read?path=<filepath>: Read file contents')
  console.log('\nTo test the server, send JSON-RPC requests to http://localhost:3000/mcp')
} catch (err) {
  fastify.log.error(err)
  process.exit(1)
}
