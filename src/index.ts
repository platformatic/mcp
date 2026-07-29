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
import type { CacheHint, CachingConfig } from './modern/handlers.ts'
import { RequestStateSealer } from './modern/request-state.ts'
import { SubscriptionRegistry } from './modern/subscriptions.ts'
import { TaskInputChannel } from './modern/task-inputs.ts'
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

  const capabilities: ServerCapabilities = opts.capabilities ?? {
    tools: {},
    resources: {},
    prompts: {}
  }

  app.decorate('mcpClient', (clientOptions?: McpClientOptions) => {
    return createMcpClient(app, clientOptions)
  })

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
    messageBroker = new RedisMessageBroker(redis, {
      onCloseTimeout: (closeTimeoutMs) => {
        app.log.warn({ closeTimeoutMs }, 'Redis message broker close timed out; forcing disconnect')
      }
    })
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
  const taskInputs = new TaskInputChannel()

  if (enableTasks) {
    // Advertise which task operations we support. `tasks/list` is only offered
    // when authorization is on, because without an identifiable requestor it
    // would expose every task's metadata to anyone who can reach the server.
    //
    // This is the 2025-11-25 core shape, used only on the legacy path. Modern
    // clients see the `io.modelcontextprotocol/tasks` extension instead, which
    // `buildServerCapabilities` adds to the `server/discover` result.
    const canIdentifyRequestors = opts.authorization?.enabled === true
    capabilities.tasks = {
      ...(canIdentifyRequestors ? { list: {} } : {}),
      cancel: {},
      requests: {
        tools: { call: {} }
      }
    }
  }

  // Cacheable results must always carry hints, so anything unconfigured
  // defaults to "immediately stale, never shared" — correct for every server,
  // and something deployments opt out of knowingly.
  const noCache: CacheHint = { ttlMs: 0, cacheScope: 'private' }
  const caching: CachingConfig = {
    discover: opts.caching?.discover ?? noCache,
    toolsList: opts.caching?.toolsList ?? noCache,
    promptsList: opts.caching?.promptsList ?? noCache,
    resourcesList: opts.caching?.resourcesList ?? noCache,
    resourceTemplatesList: opts.caching?.resourceTemplatesList ?? noCache,
    resourcesRead: opts.caching?.resourcesRead ?? noCache
  }

  const sealer = new RequestStateSealer({
    secret: opts.requestStateSecret,
    ttlMs: opts.requestStateTtlMs
  })

  if (!opts.requestStateSecret) {
    app.log.debug('MCP: no requestStateSecret configured; multi round-trip retries will only verify on the instance that issued them')
  }

  const subscriptions = new SubscriptionRegistry(app.log)

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
    jsonSchemaValidator,
    taskInputs,
    sealer,
    caching,
    subscriptions,
    enableTasks
  })

  // Add close hook to clean up Redis connections and authorization components
  app.addHook('onClose', async () => {
    // End modern subscription streams with the graceful-closure response, so
    // clients can tell a shutdown from a dropped connection.
    subscriptions.closeAll()

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

// Export plugin types
export type {
  MCPPluginOptions,
  MCPRouteId,
  MCPRouteSchemaContext,
  MCPRouteSchemaTransformer,
  ToolAccessContext,
  McpCallToolContext,
  McpCallToolOutcome,
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
  LATEST_LEGACY_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  MODERN_PROTOCOL_VERSIONS,
  LEGACY_PROTOCOL_VERSIONS,
  DEFAULT_NEGOTIATED_PROTOCOL_VERSION,
  JSONRPC_VERSION,
  URL_ELICITATION_REQUIRED,
  HEADER_MISMATCH,
  MISSING_REQUIRED_CLIENT_CAPABILITY,
  UNSUPPORTED_PROTOCOL_VERSION
} from './schema.ts'

/* ---------------------------------------------------------------- */
/* 2026-07-28                                                        */
/* ---------------------------------------------------------------- */

// Multi round-trip requests: how a handler asks the client for something.
export {
  InputRequired,
  elicitForm,
  elicitUrl,
  requestSampling,
  requestRoots
} from './modern/input-required.ts'

// Reserved `_meta` keys and the tasks extension identifier.
export {
  META_PROTOCOL_VERSION,
  META_CLIENT_INFO,
  META_CLIENT_CAPABILITIES,
  META_LOG_LEVEL,
  META_SUBSCRIPTION_ID,
  META_SERVER_INFO,
  TASKS_EXTENSION
} from './schema-2026.ts'

// Header mirroring, for clients and for tests.
export { encodeHeaderValue, decodeHeaderValue } from './modern/headers.ts'

export { RequestStateSealer } from './modern/request-state.ts'
export { SubscriptionRegistry } from './modern/subscriptions.ts'

export type {
  ClientCapabilities as ModernClientCapabilities,
  ServerCapabilities as ModernServerCapabilities,
  DiscoverResult,
  CacheableResult,
  InputRequests,
  InputResponses,
  InputRequiredResult,
  RequestMetaObject,
  ResultType,
  SubscriptionFilter,
  Task as ExtensionTask,
  TaskStatus as ExtensionTaskStatus,
  CreateTaskResult as ExtensionCreateTaskResult,
  DetailedTask
} from './schema-2026.ts'

export type { CacheHint, CachingConfig } from './modern/handlers.ts'

// Task storage, for callers that want to supply or inspect a backend
export type { TaskStore, TaskRecord, TaskOutcome } from './stores/task-store.ts'
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
