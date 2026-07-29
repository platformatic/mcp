import type { FastifyReply, FastifyRequest, FastifySchema, HTTPMethods } from 'fastify'
import type { Options } from 'ajv'
import type {
  JSONRPCMessage,
  JSONRPCNotification,
  CallToolResult,
  ReadResourceResult,
  GetPromptResult,
  ServerCapabilities,
  Implementation,
  Tool,
  Resource,
  Prompt,
  ElicitRequestFormParams,
  RequestId
} from './schema.ts'
import type { Static, TSchema, TObject, TString } from '@sinclair/typebox'
import type { AuthorizationConfig, AuthorizationContext } from './types/auth-types.ts'
import type { AllowedOrigins } from './security.ts'
import type { CacheHint } from './modern/handlers.ts'

export type { CacheHint }

// Context interface for all handler types
export interface HandlerContext {
  sessionId?: string
  request: FastifyRequest
  reply: FastifyReply
  authContext?: AuthorizationContext
  /**
   * Answers to a previous `InputRequiredResult`, keyed the way the handler
   * keyed its `inputRequests` (2026-07-28 multi round-trip requests). Absent on
   * a first attempt, and always absent on the legacy path.
   */
  inputResponses?: Record<string, unknown>
  /**
   * The value the handler passed as `state` when it threw `InputRequired`,
   * verified and unsealed. Absent unless the client is retrying.
   */
  requestState?: unknown
}

// Resource subscription handler types
export type ResourceSubscribeHandler = (
  params: { uri: string },
  context: HandlerContext
) => Promise<Record<string, unknown>> | Record<string, unknown>

export type ResourceUnsubscribeHandler = (
  params: { uri: string },
  context: HandlerContext
) => Promise<Record<string, unknown>> | Record<string, unknown>

// Resource handlers container
export interface ResourceHandlers {
  subscribeHandler?: ResourceSubscribeHandler
  unsubscribeHandler?: ResourceUnsubscribeHandler
}

// Generic handler types with TypeBox schema support
export type ToolHandler<TSchema extends TObject = TObject> = (
  params: Static<TSchema>,
  context: HandlerContext
) => Promise<CallToolResult> | CallToolResult

export type ResourceHandler<TUriSchema extends TSchema = TString> = (
  uri: Static<TUriSchema>,
  context: HandlerContext
) => Promise<ReadResourceResult> | ReadResourceResult

export type PromptHandler<TArgsSchema extends TObject = TObject> = (
  name: string,
  args: Static<TArgsSchema>,
  context: HandlerContext
) => Promise<GetPromptResult> | GetPromptResult

// Generic MCP interfaces with TypeBox schema support
export interface MCPTool<TSchema extends TObject = TObject> {
  definition: Tool & {
    inputSchema: TSchema
  }
  handler?: ToolHandler<TSchema>
}

export interface MCPResource<TUriSchema extends TSchema = TString> {
  definition: Resource & {
    uriSchema?: TUriSchema
  }
  handler?: ResourceHandler<TUriSchema>
}

export interface MCPPrompt<TArgsSchema extends TObject = TObject> {
  definition: Prompt & {
    argumentSchema?: TArgsSchema
  }
  handler?: PromptHandler<TArgsSchema>
}

// Enhanced Fastify module declaration with generic types
declare module 'fastify' {
  interface FastifyInstance {
    // Overloaded methods to support both TypeBox schemas and unsafe usage
    mcpAddTool<TSchema extends TObject>(
      definition: Omit<Tool, 'inputSchema'> & { inputSchema: TSchema },
      handler?: ToolHandler<TSchema>
    ): void
    mcpAddTool(
      definition: any,
      handler?: UnsafeToolHandler
    ): void

    mcpCallTool(
      name: string,
      args: Record<string, unknown>,
      context: McpCallToolContext
    ): Promise<McpCallToolOutcome>
    mcpHasTool(name: string): boolean
    mcpListToolNames(): readonly string[]

    mcpAddResource<TUriSchema extends TSchema = TString>(
      definition: Omit<Resource, 'uri'> & {
        uriPattern: string,
        uriSchema?: TUriSchema
      },
      handler?: ResourceHandler<TUriSchema>
    ): void
    mcpAddResource(
      definition: any,
      handler?: UnsafeResourceHandler
    ): void

    mcpAddPrompt<TArgsSchema extends TObject>(
      definition: Omit<Prompt, 'arguments'> & {
        argumentSchema?: TArgsSchema
      },
      handler?: PromptHandler<TArgsSchema>
    ): void
    mcpAddPrompt(
      definition: any,
      handler?: UnsafePromptHandler
    ): void

    mcpBroadcastNotification: (notification: JSONRPCNotification) => Promise<void>
    mcpSendToSession: (sessionId: string, message: JSONRPCMessage) => Promise<boolean>
    mcpElicit: (
      sessionId: string,
      message: string,
      requestedSchema: ElicitRequestFormParams['requestedSchema'],
      requestId?: RequestId
    ) => Promise<boolean>

    /**
     * Send a URL mode elicitation request. Resolves to the elicitation id on
     * success (use it to correlate the later completion notification), or null
     * if the request could not be sent.
     */
    mcpElicitUrl: (
      sessionId: string,
      message: string,
      url: string,
      elicitationId?: string,
      requestId?: RequestId
    ) => Promise<string | null>

    /** Signal that an out-of-band URL elicitation has completed */
    mcpNotifyElicitationComplete: (
      sessionId: string,
      elicitationId: string
    ) => Promise<boolean>

    // Resource subscription handler setters
    mcpSetResourceSubscribeHandler: (handler: ResourceSubscribeHandler) => void
    mcpSetResourceUnsubscribeHandler: (handler: ResourceUnsubscribeHandler) => void
  }
}

// Unsafe handler types for backward compatibility
export type UnsafeToolHandler = (params: any, context: HandlerContext) => Promise<CallToolResult> | CallToolResult
export type UnsafeResourceHandler = (uri: string, context: HandlerContext) => Promise<ReadResourceResult> | ReadResourceResult
export type UnsafePromptHandler = (name: string, args: any, context: HandlerContext) => Promise<GetPromptResult> | GetPromptResult

// Unsafe interfaces for backward compatibility
export interface UnsafeMCPTool {
  definition: any
  handler?: UnsafeToolHandler
}

export interface UnsafeMCPResource {
  definition: any
  handler?: UnsafeResourceHandler
}

export interface UnsafeMCPPrompt {
  definition: any
  handler?: UnsafePromptHandler
}

/** Per-request context handed to the `canAccessTool` hook. */
export interface ToolAccessContext {
  authContext?: AuthorizationContext
  request: FastifyRequest
  sessionId?: string
}

export type MCPRouteId =
  | 'mcp.post'
  | 'mcp.get'
  | 'mcp.delete'

export interface MCPRouteSchemaContext {
  routeId: MCPRouteId
  method: HTTPMethods
  url: string
}

export type MCPRouteSchemaTransformer = (
  schema: FastifySchema,
  context: MCPRouteSchemaContext
) => FastifySchema

export interface McpCallToolContext {
  request: FastifyRequest
  reply: FastifyReply
  authContext?: AuthorizationContext
}

export type McpCallToolOutcome =
  | { ok: true, result: CallToolResult }
  | { ok: false, reason: 'not-found' }
  | { ok: false, reason: 'invalid-arguments', detail: string }
  | { ok: false, reason: 'task-required' }

export interface MCPPluginOptions {
  serverInfo?: Implementation
  capabilities?: ServerCapabilities
  instructions?: string
  enableSSE?: boolean
  /**
   * Close an SSE stream after this many milliseconds so the client falls back to
   * polling and reconnects with `Last-Event-ID` (SEP-1699). Omit to keep streams
   * open indefinitely, which stays valid.
   */
  sseMaxConnectionMs?: number
  /**
   * Enable task-augmented execution (2025-11-25, experimental). Tools opt in
   * individually via `execution.taskSupport`.
   */
  enableTasks?: boolean
  /**
   * Retention for a task whose creator did not request a `ttl`, in milliseconds
   * (default 60000). Raise it when tools can run longer than a minute, so their
   * tasks do not expire before completing.
   */
  taskDefaultTtlMs?: number
  /**
   * Ceiling on task retention, in milliseconds (default 3600000). A requested
   * `ttl` above this is capped, so a client cannot pin resources indefinitely.
   */
  taskMaxTtlMs?: number
  /**
   * Freshness hints for the operations 2026-07-28 makes cacheable. Every
   * cacheable result must carry `ttlMs` and `cacheScope`, so anything omitted
   * here falls back to `{ ttlMs: 0, cacheScope: 'private' }` — immediately
   * stale and never shared between callers, which is always safe.
   *
   * Raise `ttlMs` for lists that rarely change; combined with `listChanged`
   * notifications the client gets both a cheap steady state and prompt
   * invalidation. Only mark something `public` when the result genuinely does
   * not vary per user, since a shared cache may serve it across access tokens.
   */
  caching?: {
    discover?: CacheHint
    toolsList?: CacheHint
    promptsList?: CacheHint
    resourcesList?: CacheHint
    resourceTemplatesList?: CacheHint
    resourcesRead?: CacheHint
  }
  /**
   * Secret used to seal the `requestState` blob that carries multi round-trip
   * context through the client. It must be shared by every instance that can
   * serve a retry, otherwise a retry landing on another replica is rejected.
   * Defaults to a per-process random key, which is correct for a single
   * instance only.
   */
  requestStateSecret?: string
  /** How long a sealed `requestState` stays valid. Defaults to 5 minutes. */
  requestStateTtlMs?: number
  /**
   * Origins accepted on the MCP endpoints, to prevent DNS rebinding attacks.
   * Omit to disable validation (non-browser deployments), pass `'*'` or `true`
   * to accept any origin, or list exact origins to allow.
   */
  allowedOrigins?: AllowedOrigins
  /**
   * Per-request tool authorization, keyed by tool name. Consulted by both
   * `tools/list` (a denied tool is omitted) and `tools/call` (a denied tool
   * answers with the same "not found" error as an unknown tool, so callers
   * cannot probe for tools they are not allowed to see by response shape).
   * `tools/call` runs the hook even for unknown names. Response timing is not
   * guaranteed to be indistinguishable: it depends on what the hook itself
   * does per name. A hook that throws denies access.
   * Omit to keep every registered tool visible and callable.
   */
  canAccessTool?: (
    toolName: string,
    context: ToolAccessContext
  ) => boolean | Promise<boolean>
  /**
   * Customize Fastify/OpenAPI schema metadata for MCP transport routes.
   * This callback runs once per registered route during startup.
   */
  transformRouteSchema?: MCPRouteSchemaTransformer
  /**
   * Validate plain JSON Schema tool inputs using AJV.
   * Omit this option to disable validation, or provide an object to enable it.
   * Options override the default Fastify-compatible AJV configuration.
   */
  validateJsonSchemaInputs?: Options
  sessionStore?: 'memory' | 'redis'
  messageBroker?: 'memory' | 'redis'
  redis?: {
    host: string
    port: number
    password?: string
    db?: number
    tls?: Record<string, unknown>
  }
  authorization?: AuthorizationConfig
}

export interface SSESession {
  id: string
  eventId: number
  streams: Set<FastifyReply>
  lastEventId?: string
  messageHistory: Array<{ eventId: string, message: JSONRPCMessage }>
}
