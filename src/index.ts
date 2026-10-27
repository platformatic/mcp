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
import type { CacheHint, CachingConfig } from './modern/handlers.ts'
import { drainTasks } from './task-registry.ts'
import { claimStdioRequest, registerShutdownSignal } from './stdio-trust.ts'
import { RequestStateSealer } from './modern/request-state.ts'
import { SubscriptionRegistry } from './modern/subscriptions.ts'
import {
  TaskInputChannel,
  TASK_INPUT_CANCEL_TOPIC,
  TASK_INPUT_TOPIC
} from './modern/task-inputs.ts'
import pubsubDecorators from './decorators/pubsub.ts'
import metaDecorators from './decorators/meta.ts'
import routes from './routes/mcp.ts'
import { resolveRouteUrl } from './utils/route-url.ts'
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
import { JSONRPC_VERSION } from './schema.ts'
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
  ElicitRequestURLParams,
  ElicitResult,
  CreateMessageResult,
  ListRootsResult
} from './schema.ts'

const REDIS_QUIT_TIMEOUT_MS = 2000
const TASK_CLEANUP_INTERVAL_MS = 10 * 60 * 1000
const DEFAULT_TASK_LEASE_MS = 15_000

declare module 'fastify' {
  interface FastifyInstance {
    mcpClient (options?: McpClientOptions): McpClient
  }
}

const mcpPlugin = fp(async function (app: FastifyInstance, opts: MCPPluginOptions) {
  // A single string would make the allow-list check a substring match, so fail loudly
  const allowedOrigins: unknown = opts.allowedOrigins
  if (allowedOrigins !== undefined && allowedOrigins !== true && allowedOrigins !== '*' &&
    !(Array.isArray(allowedOrigins) && allowedOrigins.every((origin) => typeof origin === 'string'))) {
    throw new TypeError(`allowedOrigins must be true, '*' or an array of origin strings, got ${JSON.stringify(allowedOrigins)}`)
  }

  const serverInfo: Implementation = opts.serverInfo ?? {
    name: '@platformatic/mcp',
    version: '1.0.0'
  }

  // The plugin can always broadcast list changes (mcpBroadcastNotification),
  // so by default it says so; without it, 2026-07-28 subscriptions/listen
  // could acknowledge nothing. `resources.subscribe` is declared once a
  // subscribe handler is registered. Explicit capabilities are used as given,
  // except that completion/complete is not implemented, so `completions` is
  // never advertised: clients that negotiate on it would only get -32601 back.
  const { completions, ...configuredCapabilities } = opts.capabilities ?? {
    tools: { listChanged: true },
    resources: { listChanged: true },
    prompts: { listChanged: true }
  }
  if (completions !== undefined) {
    app.log.warn('The "completions" capability is not supported (completion/complete is not implemented) and will not be advertised')
  }
  const capabilities: ServerCapabilities = configuredCapabilities

  // Several instances serve each other's MRTR retries, so they must share the
  // key that seals request state; without one each would refuse the others'.
  // Only 2026-07-28 multi round-trip requests need it, so a deployment serving
  // legacy clients keeps working after an upgrade, and is told why a retry
  // landing on another instance would fail.
  if (opts.redis && opts.requestStateSecret === undefined) {
    app.log.warn('MCP: redis is configured without requestStateSecret; a 2026-07-28 multi round-trip retry served by another instance will be refused. Set the same requestStateSecret on every instance')
  }

  // Recognise stdio-injected requests before any other hook (authorization
  // included) runs, and take their tokens out of the headers handlers see.
  app.addHook('onRequest', async (request) => {
    claimStdioRequest(request)
  })

  // Under a route prefix the endpoint is not /mcp: aim at the route this
  // registration serves.
  const mcpEndpoint = resolveRouteUrl(app.prefix, '/mcp')
  app.decorate('mcpClient', (clientOptions?: McpClientOptions) => {
    return createMcpClient(app, { ...clientOptions, endpoint: clientOptions?.endpoint ?? mcpEndpoint })
  })

  const enableSSE = opts.enableSSE ?? false
  const enableTasks = opts.enableTasks ?? false

  if (opts.sessionTtlMs !== undefined && !(Number.isFinite(opts.sessionTtlMs) && opts.sessionTtlMs > 0)) {
    throw new Error('sessionTtlMs must be a positive number of milliseconds')
  }
  // A NaN (an unset environment variable through `Number()`) would compare
  // false against every count, silently removing the limit.
  for (const name of ['subscriptionMaxStreams', 'subscriptionMaxStreamsPerPrincipal', 'subscriptionMaxResourceUris'] as const) {
    if (opts[name] !== undefined && (!Number.isSafeInteger(opts[name]) || opts[name] < 1)) {
      throw new TypeError(`${name} must be a positive integer`)
    }
  }
  // 0 turns the limit off, as it always has.
  if (opts.sseMaxConnectionMs !== undefined && (!Number.isFinite(opts.sseMaxConnectionMs) || opts.sseMaxConnectionMs < 0)) {
    throw new TypeError('sseMaxConnectionMs must be a non-negative number of milliseconds')
  }
  if (opts.taskMaxRetainedPerPrincipal !== undefined) {
    // Checked before any Redis connection is opened, so a bad value cannot leak one
    validateTaskLimit('taskMaxRetainedPerPrincipal', opts.taskMaxRetainedPerPrincipal)
  }
  // Everything below that can refuse an option runs before any Redis
  // connection is opened: a connection opened first would be left behind,
  // keeping the process alive after registration fails.
  // Cacheable results must always carry hints, so anything unconfigured
  // defaults to "immediately stale, never shared" — correct for every server,
  // and something deployments opt out of knowingly.
  const noCache: CacheHint = { ttlMs: 0, cacheScope: 'private' }
  const hintFor = (which: keyof CachingConfig): CacheHint => {
    const hint = opts.caching?.[which]
    if (hint === undefined) return noCache
    // `ttlMs` goes on the wire as a non-negative integer; NaN would serialize
    // as null and a fraction is not a valid value.
    if (!Number.isSafeInteger(hint.ttlMs) || hint.ttlMs < 0) {
      throw new Error(`caching.${which}.ttlMs must be a non-negative integer`)
    }
    if (hint.cacheScope !== 'public' && hint.cacheScope !== 'private') {
      throw new Error(`caching.${which}.cacheScope must be "public" or "private"`)
    }
    return hint
  }
  const caching: CachingConfig = {
    discover: hintFor('discover'),
    toolsList: hintFor('toolsList'),
    promptsList: hintFor('promptsList'),
    resourcesList: hintFor('resourcesList'),
    resourceTemplatesList: hintFor('resourceTemplatesList'),
    resourcesRead: hintFor('resourcesRead')
  }

  // A `public` hint lets shared caches serve one caller's result to another,
  // which is wrong when results depend on who asks.
  const perCaller = opts.authorization?.enabled === true || opts.resolveAuthorizationContext !== undefined || opts.canAccessTool !== undefined
  if (perCaller) {
    const shared = (Object.keys(caching) as Array<keyof CachingConfig>).filter(which => caching[which].cacheScope === 'public')
    if (shared.length > 0) {
      app.log.warn({ operations: shared }, 'MCP: cacheScope "public" is configured while results may differ per caller (authorization, resolveAuthorizationContext or canAccessTool); shared caches could serve one caller\'s result to another')
    }
  }

  // A NaN (say, an unset environment variable through `Number()`) would make
  // every retry fail as expired, silently.
  if (opts.requestStateTtlMs !== undefined && (!Number.isSafeInteger(opts.requestStateTtlMs) || opts.requestStateTtlMs <= 0)) {
    throw new Error('requestStateTtlMs must be a positive integer')
  }
  if (opts.taskMaxInputRounds !== undefined && (!Number.isSafeInteger(opts.taskMaxInputRounds) || opts.taskMaxInputRounds < 0)) {
    throw new Error('taskMaxInputRounds must be a non-negative integer')
  }
  if (opts.requestStateMaxAnswerBytes !== undefined && (!Number.isSafeInteger(opts.requestStateMaxAnswerBytes) || opts.requestStateMaxAnswerBytes < 0)) {
    throw new Error('requestStateMaxAnswerBytes must be a non-negative integer')
  }

  const sealer = new RequestStateSealer({
    secret: opts.requestStateSecret,
    audience: serverInfo.name,
    ttlMs: opts.requestStateTtlMs,
    maxAnswerBytes: opts.requestStateMaxAnswerBytes,
    // With identity resolution on, a request carrying no `userId` identifies
    // nobody, and two such callers would share the undefined principal — so state
    // sealed for one would verify for the other. Refuse rather than bind to
    // nobody.
    requirePrincipal: opts.authorization?.enabled === true || opts.resolveAuthorizationContext !== undefined
  })

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
    const { channelPrefix, ...redisOptions } = opts.redis
    if (channelPrefix !== undefined && (typeof channelPrefix !== 'string' || /[+#]/.test(channelPrefix))) {
      throw new Error('redis.channelPrefix must be a string without the topic wildcards + and #')
    }
    redis = new Redis(redisOptions)
    // Without an 'error' listener a dropped connection is reported as unhandled; log it and let ioredis reconnect.
    redis.on('error', (err) => {
      app.log.error({ err }, 'Redis connection error')
    })
    sessionStore = new RedisSessionStore({ redis, maxMessages: 100, sessionTtlMs: opts.sessionTtlMs })
    messageBroker = new RedisMessageBroker(redis, {
      channelPrefix: channelPrefix ?? `${redisOptions.keyPrefix ?? ''}db${redisOptions.db ?? 0}`,
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
      taskStore = new MemoryTaskStore({
        maxTasks: opts.taskStoreMaxTasks,
        maxTasksPerPrincipal: opts.taskMaxRetainedPerPrincipal
      })
    }
  }

  // Waiters are process-local by design: only the instance serving a given
  // tasks/result request needs to be woken when that task finishes.
  const taskWaiters = new TaskWaiters()
  const taskInputs = new TaskInputChannel(opts.taskMaxTtlMs ?? 3_600_000)

  // Aborted in preClose so calls blocked on work this instance does not own
  // (e.g. tasks/result for a task running elsewhere) give up instead of
  // holding the server open until that work finishes.
  const shutdownController = new AbortController()
  app.addHook('preClose', async () => {
    shutdownController.abort(new Error('Server is shutting down'))
  })
  registerShutdownSignal(app.server, shutdownController.signal)

  // Leases let any instance notice that the one running a task has died.
  const taskLeases = taskStore
    ? new TaskLeases(taskStore, opts.taskLeaseMs ?? DEFAULT_TASK_LEASE_MS, (err, taskId) => {
      app.log.warn({ err, taskId }, 'Failed to renew task lease')
    })
    : undefined

  if (enableTasks) {
    // Advertise which task operations we support. `tasks/list` is only offered
    // when identity resolution is configured; otherwise enumeration would
    // expose every task's metadata to anyone who can reach the server.
    //
    // This is the 2025-11-25 core shape, used only on the legacy path. Modern
    // clients see the `io.modelcontextprotocol/tasks` extension instead, which
    // `buildServerCapabilities` adds to the `server/discover` result.
    const canIdentifyRequestors = opts.authorization?.enabled === true || opts.resolveAuthorizationContext !== undefined
    capabilities.tasks = {
      ...(canIdentifyRequestors ? { list: {} } : {}),
      cancel: {},
      requests: {
        tools: { call: {} }
      }
    }
  }

  if (opts.requestStateSecret === undefined) {
    app.log.debug('MCP: no requestStateSecret configured; multi round-trip retries will only verify on the instance that issued them')
  } else if (opts.serverInfo === undefined) {
    // Sealed state names the server it was issued by; without serverInfo every
    // deployment shares the default name, so two sharing a secret would accept
    // each other's state.
    app.log.warn('MCP: requestStateSecret is set without serverInfo; set serverInfo.name so sealed state is bound to this server')
  }

  const subscriptions = new SubscriptionRegistry(app.log, undefined, undefined, serverInfo, {
    maxStreams: opts.subscriptionMaxStreams,
    maxStreamsPerPrincipal: opts.subscriptionMaxStreamsPerPrincipal
  })

  // A `tasks/update` can land on any instance, but the execution waiting for
  // those answers lives on exactly one. Route the wake-up through the broker so
  // it reaches that instance. A resolved publication is the broker contract's
  // delivery confirmation; only then may the durable outbox be acknowledged.
  taskInputs.setPublisher(async (taskId, inputResponses, deliveryId) => {
    await messageBroker.publish(TASK_INPUT_TOPIC, {
      jsonrpc: JSONRPC_VERSION,
      method: 'notifications/tasks/input',
      params: { taskId, inputResponses, deliveryId }
    })
  })
  taskInputs.setCancellationPublisher(async (taskId) => {
    await messageBroker.publish(TASK_INPUT_CANCEL_TOPIC, {
      jsonrpc: JSONRPC_VERSION,
      method: 'notifications/tasks/input_cancelled',
      params: { taskId }
    })
  })

  if (enableTasks) {
    await messageBroker.subscribe(TASK_INPUT_TOPIC, (message) => {
      const params = (message as {
        params?: { taskId?: unknown, inputResponses?: unknown, deliveryId?: unknown }
      }).params
      if (typeof params?.taskId !== 'string' || !params.inputResponses) return
      taskInputs.deliver(
        params.taskId,
        params.inputResponses as Record<string, unknown>,
        typeof params.deliveryId === 'string' ? params.deliveryId : undefined
      )
    })
    await messageBroker.subscribe(TASK_INPUT_CANCEL_TOPIC, (message) => {
      const params = (message as { params?: { taskId?: unknown } }).params
      if (typeof params?.taskId === 'string') {
        taskInputs.abort(params.taskId, 'task cancelled')
      }
    })
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
      stateSecret: opts.requestStateSecret,
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
    jsonSchemaValidator,
    capabilities
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
    taskInputs,
    sealer,
    caching,
    subscriptions,
    enableTasks,
    authPreHandler: mcpAuthPreHandler
  })

  // Streams must be closed in `preClose`: Fastify shuts the HTTP server down
  // before `onClose` runs, and an open SSE response is an in-flight request, so
  // waiting until `onClose` would deadlock the close on the very streams it is
  // trying to end.
  app.addHook('preClose', async () => {
    // Let running tasks finish (or record them as failed) while the task
    // channel and Redis are still up to carry their outcome.
    if (taskStore) await drainTasks(taskStore, opts.taskShutdownTimeoutMs ?? 5_000, taskWaiters)
    taskInputs.close()
    // Then end modern subscription streams with the graceful-closure
    // response, so clients can tell a shutdown from a dropped connection. Not
    // before: what the draining tasks change (a list, a resource) must still
    // reach them, since the graceful end tells them they missed nothing.
    subscriptions.closeAll()

    for (const streams of localStreams.values()) {
      for (const stream of streams) {
        try {
          if (stream.raw && !stream.raw.destroyed) {
            stream.raw.end()
          }
        } catch (error) {
          app.log.debug({ error }, 'Error ending SSE stream during shutdown')
        }
      }
    }
  })

  // The memory store only drops expired tasks lazily, so sweep it on a
  // schedule (the Redis store expires keys itself and prunes its indexes on
  // create and list). Each instance runs it at a jittered interval, so
  // instances deployed together do not all sweep at the same moment.
  const taskCleanup = taskStore
    ? setInterval(() => {
      taskStore.cleanup().catch((error) => app.log.debug({ err: error }, 'Task store cleanup failed'))
    }, Math.round(TASK_CLEANUP_INTERVAL_MS * (0.5 + Math.random()))).unref()
    : undefined

  // Add close hook to clean up Redis connections and authorization components
  app.addHook('onClose', async () => {
    if (taskCleanup) clearInterval(taskCleanup)
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

export { isStdioRequest } from './stdio-trust.ts'

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
  AuthorizationContextResolver,
  ToolAccessContext,
  ToolAccessOperation,
  McpCallToolContext,
  McpCallToolOutcome,
  MCPToolCallCompleteEvent,
  MCPClientResponseContext,
  MCPTool,
  MCPResource,
  MCPPrompt,
  HandlerContext,
  ToolDefinitionExtras,
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
  AuthorizationContext,
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
  ElicitRequestURLParams,
  ElicitResult,
  CreateMessageResult,
  ListRootsResult
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
  InputResponse,
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
export type { TaskStore, TaskRecord, TaskOutcome, TaskInputUpdate, TaskUpdateOptions, TaskListOptions, TaskListPage } from './stores/task-store.ts'
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
  McpClientCallToolOptions,
  McpClientInitializeOptions,
  McpClientResponse
} from './client.ts'
