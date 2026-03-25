import {
  expectType,
  expectError,
  expectAssignable,
  expectNotAssignable,
} from 'tsd'
import { Type } from '@sinclair/typebox'
import type { FastifyReply } from 'fastify'
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
