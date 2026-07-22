import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { Redis } from 'ioredis'
import type { SessionStore } from './stores/session-store.ts'
import type { MessageBroker } from './brokers/message-broker.ts'
import { MemorySessionStore } from './stores/memory-session-store.ts'
import { MemoryMessageBroker } from './brokers/memory-message-broker.ts'
import { RedisSessionStore } from './stores/redis-session-store.ts'
import { RedisMessageBroker } from './brokers/redis-message-broker.ts'
import type { TaskStore } from './stores/task-store.ts'
import { TaskWaiters } from './stores/task-store.ts'
import { MemoryTaskStore } from './stores/memory-task-store.ts'
import { RedisTaskStore } from './stores/redis-task-store.ts'
import type { MCPPluginOptions, MCPTool, MCPResource, MCPPrompt, ResourceHandlers } from './types.ts'
import pubsubDecorators from './decorators/pubsub.ts'
import metaDecorators from './decorators/meta.ts'
import routes from './routes/mcp.ts'
import wellKnownRoutes from './routes/well-known.ts'
import { TokenValidator } from './auth/token-validator.ts'
import { createAuthPreHandler } from './auth/prehandler.ts'
import oauthClientPlugin from './auth/oauth-client.ts'
import authRoutesPlugin from './routes/auth-routes.ts'

// Import and export MCP protocol types
import type {
  JSONRPCMessage,
  JSONRPCRequest,
  JSONRPCResponse,
  JSONRPCResultResponse,
  JSONRPCErrorResponse,
  JSONRPCError,
  JSONRPCNotification,
  ServerCapabilities,
  Implementation,
  Tool,
  Resource,
  Prompt,
  Icon,
  CallToolResult,
  ReadResourceResult,
  GetPromptResult,
  Task,
  TaskStatus,
  CreateTaskResult,
  ListTasksResult,
  ElicitRequestFormParams,
  ElicitRequestURLParams
} from './schema.ts'

const mcpPlugin = fp(async function (app: FastifyInstance, opts: MCPPluginOptions) {
  const serverInfo: Implementation = opts.serverInfo ?? {
    name: '@platformatic/mcp',
    version: '1.0.0'
  }

  const capabilities: ServerCapabilities = opts.capabilities ?? {
    tools: {},
    resources: {},
    prompts: {}
  }

  const enableSSE = opts.enableSSE ?? false
  const enableTasks = opts.enableTasks ?? false
  const tools = new Map<string, MCPTool>()
  const resources = new Map<string, MCPResource>()
  const prompts = new Map<string, MCPPrompt>()
  const resourceHandlers: ResourceHandlers = {}

  // Initialize stores and brokers based on configuration
  let sessionStore: SessionStore
  let messageBroker: MessageBroker
  let redis: Redis | null = null

  let taskStore: TaskStore | undefined

  if (opts.redis) {
    // Redis implementations for horizontal scaling
    redis = new Redis(opts.redis)
    sessionStore = new RedisSessionStore({ redis, maxMessages: 100 })
    messageBroker = new RedisMessageBroker(redis)
    if (enableTasks) {
      taskStore = new RedisTaskStore({ redis, defaultTtlMs: opts.taskDefaultTtlMs })
    }
  } else {
    // Memory implementations for single-instance deployment
    sessionStore = new MemorySessionStore(100)
    messageBroker = new MemoryMessageBroker()
    if (enableTasks) {
      taskStore = new MemoryTaskStore()
    }
  }

  // Waiters are process-local by design: only the instance serving a given
  // tasks/result request needs to be woken when that task finishes.
  const taskWaiters = new TaskWaiters()

  if (enableTasks) {
    // Advertise which task operations we support. `tasks/list` is only offered
    // when authorization is on, because without an identifiable requestor it
    // would expose every task's metadata to anyone who can reach the server.
    const canIdentifyRequestors = opts.authorization?.enabled === true
    capabilities.tasks = {
      ...(canIdentifyRequestors ? { list: {} } : {}),
      cancel: {},
      requests: {
        tools: { call: {} }
      }
    }
  }

  // Local stream management per server instance
  const localStreams = new Map<string, Set<any>>()

  // Initialize authorization components if enabled
  let tokenValidator: TokenValidator | null = null
  if (opts.authorization?.enabled) {
    tokenValidator = new TokenValidator(opts.authorization, app)

    // Register authorization preHandler for all routes
    app.addHook('preHandler', createAuthPreHandler(opts.authorization, tokenValidator))

    // Register OAuth client plugin if configured
    if (opts.authorization.oauth2Client) {
      await app.register(oauthClientPlugin, opts.authorization.oauth2Client)
    }
  }

  // Register well-known routes for OAuth metadata
  await app.register(wellKnownRoutes, {
    authConfig: opts.authorization
  })

  // Register OAuth client routes if OAuth client is configured
  if (opts.authorization?.enabled && opts.authorization?.oauth2Client) {
    await app.register(authRoutesPlugin, {
      sessionStore,
      dcrHooks: opts.authorization.dcrHooks
    })
  }

  // Register decorators first
  app.register(metaDecorators, {
    tools,
    resources,
    prompts,
    resourceHandlers
  })
  app.register(pubsubDecorators, {
    enableSSE,
    sessionStore,
    messageBroker,
    localStreams
  })

  // Register routes
  await app.register(routes, {
    enableSSE,
    opts,
    capabilities,
    serverInfo,
    tools,
    resources,
    prompts,
    resourceHandlers,
    sessionStore,
    messageBroker,
    localStreams,
    taskStore,
    taskWaiters
  })

  // Add close hook to clean up Redis connections and authorization components
  app.addHook('onClose', async () => {
    // Clean up all SSE streams and sessions
    const unsubscribePromises: Promise<void>[] = []
    for (const [sessionId, streams] of localStreams.entries()) {
      for (const stream of streams) {
        try {
          if (stream.raw && !stream.raw.destroyed) {
            stream.raw.destroy()
          }
        } catch (error) {
          app.log.debug({ error, sessionId }, 'Error destroying SSE stream')
        }
      }
      streams.clear()
      // Collect unsubscribe promises for parallel execution
      unsubscribePromises.push(messageBroker.unsubscribe(`mcp/session/${sessionId}/message`))
    }
    localStreams.clear()

    // Execute all unsubscribes in parallel
    await Promise.all(unsubscribePromises)

    if (redis) {
      await redis.quit()
    }
    await messageBroker.close()

    // Clean up token validator
    if (tokenValidator) {
      tokenValidator.close()
    }
  })
}, {
  name: '@platformatic/mcp'
})

// Export the plugin as both default and named export
export default mcpPlugin
export { mcpPlugin }

// Export stdio transport functionality
export {
  StdioTransport,
  createStdioTransport,
  runStdioServer
} from './stdio.ts'

export type {
  StdioTransportOptions
} from './stdio.ts'

// Export message broker implementations and interface
export {
  RedisMessageBroker
} from './brokers/redis-message-broker.ts'

export {
  MemoryMessageBroker
} from './brokers/memory-message-broker.ts'

export type {
  MessageBroker
} from './brokers/message-broker.ts'

// Export plugin types
export type {
  MCPPluginOptions,
  MCPTool,
  MCPResource,
  MCPPrompt,
  ToolHandler,
  ResourceHandler,
  PromptHandler,
  UnsafeMCPTool,
  UnsafeMCPResource,
  UnsafeMCPPrompt,
  UnsafeToolHandler,
  UnsafeResourceHandler,
  UnsafePromptHandler,
  SSESession,
  ResourceHandlers,
  ResourceSubscribeHandler,
  ResourceUnsubscribeHandler
} from './types.ts'

// Export authorization types
export type {
  AuthorizationConfig,
  TokenValidationResult,
  ProtectedResourceMetadata,
  TokenIntrospectionResponse,
  IntrospectionAuthConfig,
  DCRRequest,
  DCRResponse,
  DCRHooks
} from './types/auth-types.ts'

export type {
  JSONRPCMessage,
  JSONRPCRequest,
  JSONRPCResponse,
  JSONRPCResultResponse,
  JSONRPCErrorResponse,
  JSONRPCError,
  JSONRPCNotification,
  ServerCapabilities,
  Implementation,
  Tool,
  Resource,
  Prompt,
  Icon,
  CallToolResult,
  ReadResourceResult,
  GetPromptResult,
  Task,
  TaskStatus,
  CreateTaskResult,
  ListTasksResult,
  ElicitRequestFormParams,
  ElicitRequestURLParams
}

// Protocol constants, so consumers can negotiate and branch on the revision
export {
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  DEFAULT_NEGOTIATED_PROTOCOL_VERSION,
  JSONRPC_VERSION,
  URL_ELICITATION_REQUIRED
} from './schema.ts'

// Task storage, for callers that want to supply or inspect a backend
export type { TaskStore, TaskRecord, TaskOutcome } from './stores/task-store.ts'
export { MemoryTaskStore } from './stores/memory-task-store.ts'
export { RedisTaskStore } from './stores/redis-task-store.ts'
