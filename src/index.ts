import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { Redis } from 'ioredis'
import type {
  ServerCapabilities,
  Implementation
} from './schema.ts'
import type { SessionStore } from './stores/session-store.ts'
import type { MessageBroker } from './brokers/message-broker.ts'
import { MemorySessionStore } from './stores/memory-session-store.ts'
import { MemoryMessageBroker } from './brokers/memory-message-broker.ts'
import { RedisSessionStore } from './stores/redis-session-store.ts'
import { RedisMessageBroker } from './brokers/redis-message-broker.ts'
import type { MCPPluginOptions, MCPTool, MCPResource, MCPPrompt } from './types.ts'
import pubsubDecorators from './decorators/pubsub.ts'
import metaDecorators from './decorators/meta.ts'
import routes from './routes.ts'

export default fp(async function (app: FastifyInstance, opts: MCPPluginOptions) {
  const serverInfo: Implementation = opts.serverInfo ?? {
    name: 'fastify-mcp-server',
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

  // Add close hook to clean up Redis connections
  app.addHook('onClose', async () => {
    if (redis) {
      await redis.quit()
    }
    await messageBroker.close()
  })
}, {
  name: 'fastify-mcp-server'
})
