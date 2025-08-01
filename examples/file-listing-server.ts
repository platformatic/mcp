import Fastify from 'fastify'
import { promises as fs, watch } from 'fs'
import { join, relative } from 'path'
import { Type } from '@sinclair/typebox'
import mcpPlugin from '../src/index.ts'

const fastify = Fastify({
  logger: {
    level: 'info'
  }
})

// Register the MCP plugin with SSE enabled
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
  instructions: 'A file system listing server that can list files and directories',
  enableSSE: true
})

// Store active watchers with debounce state
interface WatcherData {
  watcher: any
  sessionId: string
  debounceTimers: Map<string, NodeJS.Timeout>
}

const activeWatchers = new Map<string, WatcherData>()

// Track active sessions internally for cleanup
const activeSessions = new Set<string>()

// Periodic cleanup for orphaned watchers
const cleanupInterval = setInterval(() => {
  const orphanedWatchers = []

  for (const [watchId, watcherData] of activeWatchers.entries()) {
    // In the new architecture, we can test if session is active by trying to send a message
    const sessionActive = activeSessions.has(watcherData.sessionId)

    if (!sessionActive) {
      orphanedWatchers.push(watchId)
    }
  }

  if (orphanedWatchers.length > 0) {
    fastify.log.info({
      orphanedWatchers
    }, `Cleaning up ${orphanedWatchers.length} orphaned watchers`)

    for (const watchId of orphanedWatchers) {
      const watcherData = activeWatchers.get(watchId)
      if (watcherData) {
        try {
          watcherData.watcher.close()
        } catch (error) {
          fastify.log.error(`Error closing orphaned watcher ${watchId}:`, error)
        }
        activeWatchers.delete(watchId)
      }
    }
  }
}, 60000) // Check every minute

// Clean up on server shutdown
fastify.addHook('onClose', async () => {
  fastify.log.info('Server shutting down, cleaning up resources...')

  // Clear the cleanup interval
  clearInterval(cleanupInterval)

  // Close all active watchers
  const watcherIds = Array.from(activeWatchers.keys())
  if (watcherIds.length > 0) {
    fastify.log.info({
      watcherIds
    }, `Closing ${watcherIds.length} active watchers`)

    for (const watchId of watcherIds) {
      const watcherData = activeWatchers.get(watchId)
      if (watcherData) {
        try {
          // Clear all debounce timers before closing
          for (const timer of watcherData.debounceTimers.values()) {
            clearTimeout(timer)
          }
          watcherData.debounceTimers.clear()

          watcherData.watcher.close()
        } catch (error) {
          fastify.log.error(`Error closing watcher ${watchId} during shutdown:`, error)
        }
      }
    }

    activeWatchers.clear()
  }
})

// Add a tool to list files in a directory
const ListFilesSchema = Type.Object({
  path: Type.Optional(Type.String({
    description: 'The directory path to list files from (defaults to current directory)',
    default: '.'
  })),
  showHidden: Type.Optional(Type.Boolean({
    description: 'Whether to show hidden files (files starting with .)',
    default: false
  }))
})

fastify.mcpAddTool({
  name: 'list_files',
  description: 'List files and directories in a given path',
  inputSchema: ListFilesSchema
}, async (params) => {
  const { path = '.', showHidden = false } = params

  try {
    const fullPath = join(process.cwd(), path)
    const items = await fs.readdir(fullPath, { withFileTypes: true })

    const filteredItems = items.filter(item => {
      if (!showHidden && item.name.startsWith('.')) {
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
const GetFileInfoSchema = Type.Object({
  path: Type.String({
    description: 'The file or directory path to get info about'
  })
})

fastify.mcpAddTool({
  name: 'get_file_info',
  description: 'Get detailed information about a file or directory',
  inputSchema: GetFileInfoSchema
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
const FileUriSchema = Type.String({
  pattern: '^file://read\\?path=.+',
  description: 'URI pattern for file reading with path parameter'
})

fastify.mcpAddResource({
  uriPattern: 'file://read',
  name: 'Read File',
  description: 'Read the contents of a file',
  mimeType: 'text/plain',
  uriSchema: FileUriSchema
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

// Add a tool to watch for file changes
const WatchFilesSchema = Type.Object({
  path: Type.Optional(Type.String({
    description: 'The directory path to watch for changes (defaults to current directory)',
    default: '.'
  })),
  watchId: Type.String({
    description: 'Unique identifier for this watch session'
  })
})

fastify.mcpAddTool({
  name: 'watch_files',
  description: 'Watch for file changes in a directory and send notifications via SSE to the current session',
  inputSchema: WatchFilesSchema
}, async (params, context) => {
  const { path = '.', watchId } = params
  const sessionId = context?.sessionId

  try {
    if (!sessionId) {
      return {
        content: [{
          type: 'text',
          text: 'Session ID is required for file watching. Make sure you are using SSE.'
        }],
        isError: true
      }
    }

    // Check if watcher already exists
    if (activeWatchers.has(watchId)) {
      return {
        content: [{
          type: 'text',
          text: `Watcher with ID '${watchId}' already exists. Use stop_watch to remove it first.`
        }],
        isError: true
      }
    }

    const fullPath = join(process.cwd(), path)

    // Verify path exists
    await fs.stat(fullPath)

    // Create file watcher
    const watcher = watch(fullPath, { recursive: true })
    activeWatchers.set(watchId, {
      watcher,
      sessionId,
      debounceTimers: new Map<string, NodeJS.Timeout>()
    })

    // Handle file change events with debouncing
    watcher.on('change', (eventType, filename) => {
      if (filename) {
        const watcherData = activeWatchers.get(watchId)
        if (!watcherData) return

        const fileKey = filename.toString()
        const debounceKey = `${eventType}:${fileKey}`

        // Clear existing timer for this file+event combination
        const existingTimer = watcherData.debounceTimers.get(debounceKey)
        if (existingTimer) {
          clearTimeout(existingTimer)
        }

        // Set new debounce timer (1 second)
        const timer = setTimeout(() => {
          const notification = {
            jsonrpc: '2.0' as const,
            method: 'notifications/file_changed',
            params: {
              watchId,
              event_type: eventType,
              filename: fileKey,
              full_path: join(fullPath, fileKey),
              relative_path: relative(process.cwd(), join(fullPath, fileKey)),
              timestamp: new Date().toISOString()
            }
          }

          // Send to specific session
          fastify.mcpSendToSession(sessionId, notification).then((sent) => {
            if (sent) {
              fastify.log.info(`File change sent to session ${sessionId}: ${eventType} ${fileKey}`)
              activeSessions.add(sessionId)
            } else {
              // Session no longer active, mark for cleanup
              activeSessions.delete(sessionId)
              fastify.log.warn({
                sessionId,
                eventType,
                filename: fileKey,
                watchId
              }, 'Failed to send file change - session no longer active')

              // Clean up watcher if session is no longer active
              fastify.log.info({
                watchId,
                sessionId
              }, 'Cleaning up watcher for inactive session')

              // Clear all debounce timers
              for (const timer of watcherData.debounceTimers.values()) {
                clearTimeout(timer)
              }
              watcherData.debounceTimers.clear()

              watcher.close()
              activeWatchers.delete(watchId)
            }
          }).catch((error) => {
            fastify.log.error('Error sending notification:', error)
          })

          // Clean up the timer from the map
          watcherData.debounceTimers.delete(debounceKey)
        }, 1000) // 1 second debounce

        // Store the timer
        watcherData.debounceTimers.set(debounceKey, timer)
      }
    })

    watcher.on('error', (error) => {
      const notification = {
        jsonrpc: '2.0' as const,
        method: 'notifications/watch_error',
        params: {
          watchId,
          error: error.message,
          timestamp: new Date().toISOString()
        }
      }
      fastify.mcpSendToSession(sessionId, notification)
      fastify.log.error(`Watch error for ${watchId}:`, error)

      // Clean up failed watcher and its timers
      const watcherData = activeWatchers.get(watchId)
      if (watcherData) {
        // Clear all debounce timers
        for (const timer of watcherData.debounceTimers.values()) {
          clearTimeout(timer)
        }
        watcherData.debounceTimers.clear()
      }
      activeWatchers.delete(watchId)
    })

    // Log session status when starting watch and track the session
    activeSessions.add(sessionId)
    fastify.log.info({
      watchId,
      sessionId,
      path
    }, 'Started file watcher for session')

    return {
      content: [{
        type: 'text',
        text: `Started watching '${path}' with ID '${watchId}' for session '${sessionId}'. File change notifications will be sent via SSE.`
      }]
    }
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Error starting file watcher: ${error.message}`
      }],
      isError: true
    }
  }
})

// Add a tool to stop watching files
const StopWatchSchema = Type.Object({
  watchId: Type.String({
    description: 'The watch ID to stop'
  })
})

fastify.mcpAddTool({
  name: 'stop_watch',
  description: 'Stop watching for file changes',
  inputSchema: StopWatchSchema
}, async (params) => {
  const { watchId } = params

  const watcherData = activeWatchers.get(watchId)
  if (!watcherData) {
    return {
      content: [{
        type: 'text',
        text: `No watcher found with ID '${watchId}'`
      }],
      isError: true
    }
  }

  try {
    // Clear all debounce timers before closing
    for (const timer of watcherData.debounceTimers.values()) {
      clearTimeout(timer)
    }
    watcherData.debounceTimers.clear()

    watcherData.watcher.close()
    activeWatchers.delete(watchId)

    return {
      content: [{
        type: 'text',
        text: `Stopped watching files for ID '${watchId}'`
      }]
    }
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Error stopping watcher: ${error.message}`
      }],
      isError: true
    }
  }
})

// Add a tool to list active watchers
const ListWatchersSchema = Type.Object({})

fastify.mcpAddTool({
  name: 'list_watchers',
  description: 'List all active file watchers',
  inputSchema: ListWatchersSchema
}, async (_params) => {
  const watcherEntries = Array.from(activeWatchers.entries())

  return {
    content: [{
      type: 'text',
      text: watcherEntries.length > 0
        ? `Active watchers:\n${watcherEntries.map(([id, data]) => `  - ${id} (session: ${data.sessionId})`).join('\n')}`
        : 'No active watchers'
    }]
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
  console.log('  - watch_files: Watch for file changes (requires SSE)')
  console.log('  - stop_watch: Stop watching files')
  console.log('  - list_watchers: List active watchers')
  console.log('📄 Available resources:')
  console.log('  - file://read?path=<filepath>: Read file contents')
  console.log('\nTo test the server:')
  console.log('  - JSON-RPC requests: POST http://localhost:3000/mcp')
  console.log('  - SSE notifications: GET http://localhost:3000/mcp')
} catch (err) {
  fastify.log.error(err)
  process.exit(1)
}
