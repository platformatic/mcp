import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import type {
  ServerCapabilities,
  Implementation
} from './schema.ts'
import type { SessionStore } from './stores/session-store.ts'
import type { MessageBroker } from './brokers/message-broker.ts'
import { MemorySessionStore } from './stores/memory-session-store.ts'
import { MemoryMessageBroker } from './brokers/memory-message-broker.ts'
import type { MCPPluginOptions, MCPTool, MCPResource, MCPPrompt } from './types.ts'
import mcpPubSubDecoratorsPlugin from './decorators/pubsub-decorators.ts'
import mcpPubSubRoutesPlugin from './routes.ts'

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

  // Initialize stores and brokers
  const sessionStore: SessionStore = new MemorySessionStore(100)
  const messageBroker: MessageBroker = new MemoryMessageBroker()

  // Local stream management per server instance
  const localStreams = new Map<string, Set<any>>()

  // Register decorators first
  await app.register(mcpPubSubDecoratorsPlugin, {
    enableSSE,
    tools,
    resources,
    prompts,
    sessionStore,
    messageBroker,
    localStreams
  })

  // Register routes
  await app.register(mcpPubSubRoutesPlugin, {
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
}, {
  name: 'fastify-mcp'
})
