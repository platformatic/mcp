import {
  expectType,
  expectError,
  expectAssignable,
  expectNotAssignable,
} from 'tsd'
import { Type } from '@sinclair/typebox'
import type { FastifyReply, FastifyRequest, FastifySchema, HTTPMethods } from 'fastify'
import { RedisMessageBroker, MemoryMessageBroker, RedisSessionStore, MemorySessionStore } from '../dist/index.js'
import type {
  ToolHandler,
  ResourceHandler,
  PromptHandler,
  MCPTool,
  MCPResource,
  MCPPrompt,
  MCPPluginOptions,
  SSESession,
  UnsafeToolHandler,
  UnsafeResourceHandler,
  UnsafePromptHandler,
  UnsafeMCPTool,
  UnsafeMCPResource,
  UnsafeMCPPrompt,
  JSONRPCMessage,
  MessageBroker,
  SessionStore,
  SessionMetadata,
  ToolAccessContext,
  MCPRouteId,
  MCPRouteSchemaContext,
  MCPRouteSchemaTransformer,
} from '../dist/index.js'

// ─── ToolHandler ─────────────────────────────────────────────────────

// Typed handler infers params from TypeBox schema
const TestToolSchema = Type.Object({
  query: Type.String(),
  limit: Type.Number(),
})

const typedToolHandler: ToolHandler<typeof TestToolSchema> = async (
  params,
  _ctx
) => {
  expectType<string>(params.query)
  expectType<number>(params.limit)
  return { content: [{ type: 'text' as const, text: params.query }] }
}
expectType<ToolHandler<typeof TestToolSchema>>(typedToolHandler)

// Sync return is allowed
const syncToolHandler: ToolHandler<typeof TestToolSchema> = (params) => {
  return { content: [{ type: 'text' as const, text: params.query }] }
}
expectType<ToolHandler<typeof TestToolSchema>>(syncToolHandler)

// Wrong return type
expectError<ToolHandler<typeof TestToolSchema>>(async () => ({
  wrong: 'shape',
}))

// ─── ResourceHandler ─────────────────────────────────────────────────

// Default handler receives string uri
const resourceHandler: ResourceHandler = async (uri, _ctx) => {
  expectType<string>(uri)
  return { contents: [{ uri, text: 'content', mimeType: 'text/plain' }] }
}
expectType<ResourceHandler>(resourceHandler)

// Wrong return type
expectError<ResourceHandler>(async () => ({ wrong: 'shape' }))

// ─── PromptHandler ───────────────────────────────────────────────────

const TestPromptSchema = Type.Object({
  language: Type.String(),
  verbose: Type.Boolean(),
})

// Typed handler infers args from schema
const typedPromptHandler: PromptHandler<typeof TestPromptSchema> = async (
  _name,
  args
) => {
  expectType<string>(args.language)
  expectType<boolean>(args.verbose)
  return {
    messages: [
      {
        role: 'user' as const,
        content: { type: 'text' as const, text: args.language },
      },
    ],
  }
}
expectType<PromptHandler<typeof TestPromptSchema>>(typedPromptHandler)

// Wrong return type
expectError<PromptHandler<typeof TestPromptSchema>>(async () => ({
  wrong: 'shape',
}))

// ─── MCPTool ─────────────────────────────────────────────────────────

// Definition schema links to handler params
const mcpTool: MCPTool<typeof TestToolSchema> = {
  definition: {
    name: 'search',
    description: 'Search tool',
    inputSchema: TestToolSchema,
  },
  handler: async (params) => {
    expectType<string>(params.query)
    expectType<number>(params.limit)
    return { content: [{ type: 'text' as const, text: params.query }] }
  },
}
expectType<MCPTool<typeof TestToolSchema>>(mcpTool)

// Handler is optional
expectAssignable<MCPTool<typeof TestToolSchema>>({
  definition: { name: 'no-handler', inputSchema: TestToolSchema },
})

// ─── MCPResource ─────────────────────────────────────────────────────

// Basic resource without handler
expectAssignable<MCPResource>({
  definition: { name: 'test-resource', uri: 'file://test.txt' },
})

// Resource with uri schema and handler
const UriSchema = Type.String({ pattern: '^https://' })
expectAssignable<MCPResource<typeof UriSchema>>({
  definition: {
    name: 'web-resource',
    uri: 'https://example.com',
    uriSchema: UriSchema,
  },
  handler: async (uri) => {
    expectType<string>(uri)
    return { contents: [{ uri, text: 'data', mimeType: 'text/plain' }] }
  },
})

// ─── MCPPrompt ───────────────────────────────────────────────────────

// Prompt with typed argument schema
expectAssignable<MCPPrompt<typeof TestPromptSchema>>({
  definition: {
    name: 'explain',
    argumentSchema: TestPromptSchema,
  },
  handler: async (_name, args) => {
    expectType<string>(args.language)
    return {
      messages: [
        {
          role: 'user' as const,
          content: { type: 'text' as const, text: args.language },
        },
      ],
    }
  },
})

// Prompt without handler
expectAssignable<MCPPrompt>({
  definition: { name: 'bare-prompt' },
})

// ─── Unsafe Types (backward compatibility) ───────────────────────────

// UnsafeToolHandler accepts any params
const unsafeToolHandler: UnsafeToolHandler = async (params) => {
  return {
    content: [{ type: 'text' as const, text: String(params.anything) }],
  }
}
expectType<UnsafeToolHandler>(unsafeToolHandler)

// UnsafeResourceHandler accepts string uri
const unsafeResourceHandler: UnsafeResourceHandler = async (uri) => {
  return { contents: [{ uri, text: 'data', mimeType: 'text/plain' }] }
}
expectType<UnsafeResourceHandler>(unsafeResourceHandler)

// UnsafePromptHandler accepts any args
const unsafePromptHandler: UnsafePromptHandler = async (_name, args) => {
  return {
    messages: [
      {
        role: 'user' as const,
        content: { type: 'text' as const, text: String(args.anything) },
      },
    ],
  }
}
expectType<UnsafePromptHandler>(unsafePromptHandler)

// UnsafeMCP* interfaces accept any definition
expectAssignable<UnsafeMCPTool>({
  definition: { name: 'anything', arbitrary: true },
})
expectAssignable<UnsafeMCPResource>({ definition: { name: 'anything' } })
expectAssignable<UnsafeMCPPrompt>({ definition: { name: 'anything' } })

// ─── MCPPluginOptions ────────────────────────────────────────────────

// Empty options are valid
expectAssignable<MCPPluginOptions>({})

const routeSchemaContext: MCPRouteSchemaContext = {
  routeId: 'mcp.post',
  method: 'POST',
  url: '/mcp'
}
expectType<MCPRouteId>(routeSchemaContext.routeId)
expectType<HTTPMethods>(routeSchemaContext.method)

const routeSchemaTransformer: MCPRouteSchemaTransformer = (schema, context) => {
  const routeId: MCPRouteId = context.routeId
  expectType<MCPRouteSchemaContext>(context)

  return {
    ...schema,
    tags: [routeId]
  }
}

expectAssignable<MCPPluginOptions>({
  transformRouteSchema: routeSchemaTransformer
})

expectError<MCPRouteSchemaContext>({
  routeId: 'invalid.route',
  method: 'POST',
  url: '/mcp'
})

expectNotAssignable<MCPRouteSchemaTransformer>(async (schema: FastifySchema) => {
  return {
    ...schema,
    tags: ['async-not-allowed']
  }
})

expectNotAssignable<MCPRouteSchemaTransformer>((_schema: FastifySchema) => {
  return undefined
})

// Full options
expectAssignable<MCPPluginOptions>({
  serverInfo: { name: 'test', version: '1.0.0' },
  capabilities: { tools: { listChanged: true } },
  instructions: 'test instructions',
  enableSSE: true,
  sessionStore: 'redis',
  messageBroker: 'redis',
  redis: {
    host: 'localhost',
    port: 6379,
    password: 'secret',
    db: 0,
    tls: {},
  },
  authorization: { enabled: false },
})

// Invalid sessionStore value
expectNotAssignable<MCPPluginOptions>({ sessionStore: 'invalid' })

// Invalid messageBroker value
expectNotAssignable<MCPPluginOptions>({ messageBroker: 'invalid' })

// Redis config requires host and port
expectNotAssignable<MCPPluginOptions>({ redis: { host: 'localhost' } })
expectNotAssignable<MCPPluginOptions>({ redis: { port: 6379 } })

// ─── SSESession ──────────────────────────────────────────────────────

// Full session
expectAssignable<SSESession>({
  id: 'sess-1',
  eventId: 0,
  streams: new Set<FastifyReply>(),
  messageHistory: [],
})

// With optional fields
expectAssignable<SSESession>({
  id: 'sess-2',
  eventId: 5,
  streams: new Set<FastifyReply>(),
  lastEventId: 'evt-3',
  messageHistory: [
    {
      eventId: 'evt-1',
      message: { jsonrpc: '2.0', method: 'test' } as JSONRPCMessage,
    },
  ],
})

// Missing required fields
expectNotAssignable<SSESession>({ id: 'sess-1' })
expectNotAssignable<SSESession>({ id: 'sess-1', eventId: 0 })

// ─── Message brokers ────────────────────────────────────────────────

// Both broker implementations are importable from the package root
expectType<typeof RedisMessageBroker>(RedisMessageBroker)
expectType<typeof MemoryMessageBroker>(MemoryMessageBroker)

// MemoryMessageBroker satisfies the MessageBroker interface
expectAssignable<MessageBroker>(new MemoryMessageBroker())

// RedisMessageBroker's methods match the MessageBroker interface shape,
// checked via the prototype since constructing one needs a live Redis client
expectType<(topic: string, message: JSONRPCMessage) => Promise<void>>(
  RedisMessageBroker.prototype.publish
)
expectType<(topic: string, handler: (message: JSONRPCMessage) => void) => Promise<void>>(
  RedisMessageBroker.prototype.subscribe
)
expectType<(topic: string) => Promise<void>>(RedisMessageBroker.prototype.unsubscribe)
expectType<() => Promise<void>>(RedisMessageBroker.prototype.close)

// Constructor still requires a real Redis instance, not an arbitrary object
expectError(new RedisMessageBroker({}))

// ─── Session stores ─────────────────────────────────────────────────

// Both session store implementations are importable from the package root
expectType<typeof RedisSessionStore>(RedisSessionStore)
expectType<typeof MemorySessionStore>(MemorySessionStore)

// MemorySessionStore satisfies the SessionStore interface
expectAssignable<SessionStore>(new MemorySessionStore())

// RedisSessionStore's methods match the SessionStore interface shape,
// checked via the prototype since constructing one needs a live Redis client
expectType<(metadata: SessionMetadata) => Promise<void>>(RedisSessionStore.prototype.create)
expectType<(sessionId: string) => Promise<SessionMetadata | null>>(RedisSessionStore.prototype.get)
expectType<(sessionId: string) => Promise<void>>(RedisSessionStore.prototype.delete)

// Constructor still requires a real Redis instance, not an arbitrary object
expectError(new RedisSessionStore({}))
expectError(new RedisSessionStore())

// ─── canAccessTool hook ─────────────────────────────────────────────

// Hook parameters are fully typed: tool name plus per-request context
const accessHook: NonNullable<MCPPluginOptions['canAccessTool']> = (toolName, context) => {
  expectType<string>(toolName)
  expectAssignable<string[] | undefined>(context.authContext?.scopes)
  expectAssignable<string | undefined>(context.sessionId)
  return context.request !== undefined
}
expectAssignable<MCPPluginOptions>({ canAccessTool: accessHook })

// The context type is exported and carries a required request
expectAssignable<ToolAccessContext>({ request: {} as FastifyRequest })
expectNotAssignable<ToolAccessContext>({})

// Sync and async hooks are both accepted
expectAssignable<MCPPluginOptions>({ canAccessTool: () => true })
expectAssignable<MCPPluginOptions>({ canAccessTool: async () => false })

// Non-boolean returns and non-function values are rejected
expectNotAssignable<MCPPluginOptions>({ canAccessTool: () => 'yes' })
expectNotAssignable<MCPPluginOptions>({ canAccessTool: true })

// ─── Plugin options ─────────────────────────────────────────────────

// validateJsonSchemaInputs is an optional object
expectAssignable<MCPPluginOptions>({ validateJsonSchemaInputs: {} })

expectAssignable<MCPPluginOptions>({
  validateJsonSchemaInputs: {
    allErrors: true,
    useDefaults: false
  }
})

expectAssignable<MCPPluginOptions>({})

expectNotAssignable<MCPPluginOptions>({
  validateJsonSchemaInputs: true
})

expectNotAssignable<MCPPluginOptions>({
  validateJsonSchemaInputs: false
})

expectNotAssignable<MCPPluginOptions>({
  validateJsonSchemaInputs: 'yes'
})
