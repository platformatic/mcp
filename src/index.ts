import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import fp from 'fastify-plugin'
import { Redis } from 'ioredis'
import type { SessionStore } from './stores/session-store.ts'
import type { MessageBroker } from './brokers/message-broker.ts'
import { MemorySessionStore } from './stores/memory-session-store.ts'
import { MemoryMessageBroker } from './brokers/memory-message-broker.ts'
import { RedisSessionStore } from './stores/redis-session-store.ts'
import { RedisMessageBroker } from './brokers/redis-message-broker.ts'
import type { TaskStore } from './stores/task-store.ts'
import { TaskWaiters, TaskLeases, validateTaskLimit } from './stores/task-store.ts'
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
import { quitWithTimeout } from './redis-quit-with-timeout.ts'
import { createJsonSchemaValidator } from './validation/json-schema-validator.ts'
import {
  createMcpClient,
  type McpClient,
  type McpClientOptions
} from './client.ts'

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

const REDIS_QUIT_TIMEOUT_MS = 2000
const DEFAULT_TASK_LEASE_MS = 30_000

declare module 'fastify' {
  interface FastifyInstance {
    mcpClient (options?: McpClientOptions): McpClient
  }
}

const mcpPlugin = fp(async function (app: FastifyInstance, opts: MCPPluginOptions) {
  const serverInfo: Implementation = opts.serverInfo ?? {
    name: '@platformatic/mcp',
    version: '1.0.0'
  }

  // completion/complete is not implemented, so never advertise `completions`:
  // clients that negotiate on it would only get -32601 back.
  const { completions, ...configuredCapabilities } = opts.capabilities ?? {
    tools: {},
    resources: {},
    prompts: {}
  }
  if (completions !== undefined) {
    app.log.warn('The "completions" capability is not supported (completion/complete is not implemented) and will not be advertised')
  }
  const capabilities: ServerCapabilities = configuredCapabilities

  app.decorate('mcpClient', (clientOptions?: McpClientOptions) => {
    return createMcpClient(app, clientOptions)
  })

  const enableSSE = opts.enableSSE ?? false
  const enableTasks = opts.enableTasks ?? false

  if (opts.sessionTtlMs !== undefined && !(Number.isFinite(opts.sessionTtlMs) && opts.sessionTtlMs > 0)) {
    throw new Error('sessionTtlMs must be a positive number of milliseconds')
  }
  if (opts.taskMaxRetainedPerPrincipal !== undefined) {
    // Checked before any Redis connection is opened, so a bad value cannot leak one
    validateTaskLimit('taskMaxRetainedPerPrincipal', opts.taskMaxRetainedPerPrincipal)
  }
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
    // Without an 'error' listener a dropped connection is reported as unhandled; log it and let ioredis reconnect.
    redis.on('error', (err) => {
      app.log.error({ err }, 'Redis connection error')
    })
    sessionStore = new RedisSessionStore({ redis, maxMessages: 100, sessionTtlMs: opts.sessionTtlMs })
    messageBroker = new RedisMessageBroker(redis, {
      onCloseTimeout: (closeTimeoutMs) => {
        app.log.warn({ closeTimeoutMs }, 'Redis message broker close timed out; forcing disconnect')
      },
      onError: (err) => {
        app.log.error({ err }, 'Redis message broker connection error')
      }
    })
    if (enableTasks) {
      taskStore = new RedisTaskStore({
        redis,
        defaultTtlMs: opts.taskDefaultTtlMs,
        maxTasksPerPrincipal: opts.taskMaxRetainedPerPrincipal
      })
    }
  } else {
    // Memory implementations for single-instance deployment
    sessionStore = new MemorySessionStore(100, { sessionTtlMs: opts.sessionTtlMs })
    messageBroker = new MemoryMessageBroker()
    if (enableTasks) {
      taskStore = new MemoryTaskStore({ maxTasksPerPrincipal: opts.taskMaxRetainedPerPrincipal })
    }
  }

  // Waiters are process-local by design: only the instance serving a given
  // tasks/result request needs to be woken when that task finishes.
  const taskWaiters = new TaskWaiters()

  // Aborted in preClose so calls blocked on work this instance does not own
  // (e.g. tasks/result for a task running elsewhere) give up instead of
  // holding the server open until that work finishes.
  const shutdownController = new AbortController()
  app.addHook('preClose', async () => {
    shutdownController.abort()
  })

  // Leases let any instance notice that the one running a task has died.
  const taskLeases = taskStore
    ? new TaskLeases(taskStore, opts.taskLeaseMs ?? DEFAULT_TASK_LEASE_MS, (err, taskId) => {
      app.log.warn({ err, taskId }, 'Failed to renew task lease')
    })
    : undefined

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

  // Redis expires idle sessions itself through key TTLs. The memory store has no
  // such mechanism, so sweep it periodically: otherwise every session a client
  // abandons without DELETE would stay in memory forever. Reads already treat an
  // expired session as gone; this sweep is what actually frees the memory.
  let sessionCleanupTimer: NodeJS.Timeout | undefined
  if (sessionStore instanceof MemorySessionStore) {
    const memoryStore = sessionStore
    const sweep = async () => {
      await memoryStore.cleanup()
      // An SSE session created by POST that never opened a stream keeps an empty
      // stream set and a broker subscription; drop both once the session is gone
      for (const [sessionId, streams] of localStreams) {
        if (streams.size === 0 && !(await memoryStore.get(sessionId))) {
          localStreams.delete(sessionId)
          await messageBroker.unsubscribe(`mcp/session/${sessionId}/message`)
        }
      }
    }
    sessionCleanupTimer = setInterval(() => {
      sweep().catch((err: unknown) => {
        app.log.error({ err }, 'Failed to clean up expired sessions')
      })
    }, Math.min(memoryStore.sessionTtlMs, 60_000))
    // Never keep the process alive just to sweep sessions
    sessionCleanupTimer.unref()
  }

  // Initialize authorization components if enabled
  let tokenValidator: TokenValidator | null = null
  // Set when only the MCP routes should be protected; attached per route
  let mcpAuthPreHandler: preHandlerHookHandler | undefined
  if (opts.authorization?.enabled) {
    tokenValidator = new TokenValidator(opts.authorization, app)

    const authPreHandler = createAuthPreHandler(opts.authorization, tokenValidator)
    if (opts.authorization.protectedRoutes === 'mcp') {
      mcpAuthPreHandler = authPreHandler
    } else {
      // Register authorization preHandler for all routes
      app.addHook('preHandler', authPreHandler)
    }

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

  // AJV instance and compiled-schema cache scoped to this plugin registration
  const jsonSchemaValidator = opts.validateJsonSchemaInputs
    ? createJsonSchemaValidator(opts.validateJsonSchemaInputs)
    : undefined

  // Register decorators first
  app.register(metaDecorators, {
    tools,
    resources,
    prompts,
    resourceHandlers,
    opts,
    jsonSchemaValidator
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
    taskWaiters,
    shutdownSignal: shutdownController.signal,
    taskLeases,
    jsonSchemaValidator,
    authPreHandler: mcpAuthPreHandler
  })

  // Add close hook to clean up Redis connections and authorization components
  app.addHook('onClose', async () => {
    clearInterval(sessionCleanupTimer)

    // Tasks still running here are abandoned: stop vouching for them so their
    // leases lapse and other instances report them failed.
    taskLeases?.close()

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

    try {
      await messageBroker.close()
    } finally {
      if (redis) {
        await quitWithTimeout(redis, REDIS_QUIT_TIMEOUT_MS, () => {
          app.log.warn({ timeoutMs: REDIS_QUIT_TIMEOUT_MS }, 'Redis client quit timed out; forcing disconnect')
        })
      }
    }

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

export type { ToolArgumentLimits } from './security.ts'

// Export plugin types
export type {
  MCPPluginOptions,
  MCPRouteId,
  MCPRouteSchemaContext,
  MCPRouteSchemaTransformer,
  ToolAccessContext,
  ToolAccessOperation,
  McpCallToolContext,
  McpCallToolOutcome,
  MCPToolCallCompleteEvent,
  MCPClientResponseContext,
  MCPTool,
  MCPResource,
  MCPPrompt,
  ToolHandler,
  ResourceHandler,
  ResourceHandlerContext,
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
  ResourceUnsubscribeHandler,
  TracerLike
} from './types.ts'

export type { AllowedOrigins } from './security.ts'

// Export telemetry utilities for advanced consumers
export { MCP_ATTR, buildSpanAttributes } from './telemetry-constants.ts'
export { withSpan } from './telemetry.ts'
export type { HandlerDependencies } from './handlers.ts'

// Export authorization types
export type {
  AuthorizationConfig,
  TokenValidationResult,
  ProtectedResourceMetadata,
  TokenIntrospectionResponse,
  IntrospectionAuthConfig,
  DCRRequest,
  DCRResponse,
  DCRHooks,
  ScopeImplies
} from './types/auth-types.ts'

export { colonScopeHierarchy } from './auth/prehandler.ts'

// Rate limiting helper
export { RateLimiter } from './security.ts'

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
export type { TaskStore, TaskRecord, TaskOutcome, TaskListOptions, TaskListPage } from './stores/task-store.ts'
export { InvalidTaskCursorError, DEFAULT_TASK_PAGE_SIZE, TaskLimitError, TASK_LIMIT_REACHED, DEFAULT_TASK_MAX_PER_PRINCIPAL } from './stores/task-store.ts'
export { MemoryTaskStore } from './stores/memory-task-store.ts'
export { RedisTaskStore } from './stores/redis-task-store.ts'

// Session storage, for callers that want to supply or inspect a backend
export type { SessionStore, SessionMetadata } from './stores/session-store.ts'
export { MemorySessionStore } from './stores/memory-session-store.ts'
export { RedisSessionStore } from './stores/redis-session-store.ts'

// In-process MCP client, for exercising a registered server via app.inject()
export { createMcpClient } from './client.ts'
export type {
  McpClient,
  McpClientOptions,
  McpClientRequestOptions,
  McpClientInitializeOptions,
  McpClientResponse
} from './client.ts'
