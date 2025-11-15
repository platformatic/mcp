import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { Redis } from 'ioredis'
import type { SessionStore } from './stores/session-store.ts'
import type { MessageBroker } from './brokers/message-broker.ts'
import { MemorySessionStore } from './stores/memory-session-store.ts'
import { MemoryMessageBroker } from './brokers/memory-message-broker.ts'
import { RedisSessionStore } from './stores/redis-session-store.ts'
import { RedisMessageBroker } from './brokers/redis-message-broker.ts'
import type { MCPPluginOptions, MCPTool, MCPResource, MCPPrompt } from './types.ts'
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
  JSONRPCError,
  JSONRPCNotification,
  ServerCapabilities,
  ClientCapabilities,
  Implementation,
  Tool,
  Resource,
  Prompt,
  CallToolResult,
  ReadResourceResult,
  GetPromptResult,
  IconResource,
  FormElicitationParams,
  URLElicitationParams,
  SamplingTool,
  ToolChoice,
  ToolUseContent,
  ToolResultContent,
  TaskStatus,
  TaskAugmentation,
  CreateTaskResult,
  TaskCapabilities
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
  const tools = new Map<string, MCPTool>()
  const resources = new Map<string, MCPResource>()
  const prompts = new Map<string, MCPPrompt>()

  // Initialize stores and brokers based on configuration
  let sessionStore: SessionStore
  let messageBroker: MessageBroker
  let redis: Redis | null = null

  if (opts.redis) {
    // Redis implementations for horizontal scaling
    redis = new Redis(opts.redis)
    sessionStore = new RedisSessionStore({ redis, maxMessages: 100 })
    messageBroker = new RedisMessageBroker(redis)
  } else {
    // Memory implementations for single-instance deployment
    sessionStore = new MemorySessionStore(100)
    messageBroker = new MemoryMessageBroker()
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
    await app.register(authRoutesPlugin, { sessionStore })
  }

  // Register decorators first
  app.register(metaDecorators, {
    tools,
    resources,
    prompts
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
    sessionStore,
    messageBroker,
    localStreams
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
  SSESession
} from './types.ts'

// Export authorization types
export type {
  AuthorizationConfig,
  TokenValidationResult,
  ProtectedResourceMetadata,
  TokenIntrospectionResponse,
  AuthorizationServerMetadata,
  ClientMetadata,
  AuthorizationContext,
  TokenRefreshInfo
} from './types/auth-types.ts'

// Export authorization utility functions
export {
  discoverAuthorizationServer,
  fetchJWKS,
  fetchClientMetadata
} from './auth/discovery.ts'

export {
  generateClientMetadata,
  validateClientMetadata
} from './auth/client-metadata.ts'

export {
  createScopeChallenge,
  createAuthChallenge,
  parseTokenScopes,
  hasRequiredScopes,
  getMissingScopes
} from './auth/scope-challenge.ts'

export type {
  JSONRPCMessage,
  JSONRPCRequest,
  JSONRPCResponse,
  JSONRPCError,
  JSONRPCNotification,
  ServerCapabilities,
  ClientCapabilities,
  Implementation,
  Tool,
  Resource,
  Prompt,
  CallToolResult,
  ReadResourceResult,
  GetPromptResult,
  IconResource,
  FormElicitationParams,
  URLElicitationParams,
  SamplingTool,
  ToolChoice,
  ToolUseContent,
  ToolResultContent,
  TaskStatus,
  TaskAugmentation,
  CreateTaskResult,
  TaskCapabilities
}
