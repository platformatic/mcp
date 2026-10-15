import type { FastifyReply, FastifyRequest, FastifySchema, HTTPMethods } from 'fastify'
import type { Options } from 'ajv'
import type { RedisOptions } from 'ioredis'
import type {
  JSONRPCMessage,
  JSONRPCNotification,
  JSONRPCResponse,
  CallToolResult,
  ReadResourceResult,
  GetPromptResult,
  ServerCapabilities,
  Implementation,
  Tool,
  Resource,
  Prompt,
  ElicitRequestFormParams,
  RequestId,
  LoggingLevel
} from './schema.ts'
import type { Static, TSchema, TObject, TString } from '@sinclair/typebox'
import type { AuthorizationConfig, AuthorizationContext } from './types/auth-types.ts'
import type { AllowedOrigins, ToolArgumentLimits } from './security.ts'
import type { CacheHint } from './modern/handlers.ts'
import type { ClientCapabilities as ModernClientCapabilities, ServerCapabilities as ModernServerCapabilities, InputRequests } from './schema-2026.ts'

export type { CacheHint }

// Context interface for all handler types
export interface HandlerContext {
  sessionId?: string
  /**
   * The protocol revision this request is served under: the per-request
   * version on 2026-07-28, the negotiated one on earlier revisions.
   */
  protocolVersion?: string
  /**
   * What the client declared it supports on this request (2026-07-28), so a
   * handler can choose, say, URL-mode over form elicitation, or skip asking
   * at all. Absent on the legacy path.
   */
  clientCapabilities?: ModernClientCapabilities
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
  /**
   * Aborts when the request is cancelled, so the handler can stop work early:
   * a 2026-07-28 client that disconnects before the response,
   * `notifications/cancelled` on stdio, or the cancellation of the task the
   * handler is running in. A legacy HTTP disconnect does not abort it, since
   * it is not a cancellation on those revisions.
   */
  signal: AbortSignal
  /**
   * Report progress on this request (`notifications/progress`). Only sent to
   * a 2026-07-28 client that asked for it with a `progressToken`; `progress`
   * must increase with each call, and smaller values are dropped. A no-op
   * otherwise.
   */
  sendProgress: (progress: number, total?: number, message?: string) => void
  /**
   * Log a message to the client (`notifications/message`). Only sent to a
   * 2026-07-28 client that set `io.modelcontextprotocol/logLevel`, and only at
   * or above that level. A no-op otherwise.
   */
  log: (level: LoggingLevel, data: unknown, logger?: string) => void
}

// Context passed to resource read handlers
export interface ResourceHandlerContext extends HandlerContext {
  /**
   * Values extracted from the requested URI when it was matched against a
   * registered URI template, e.g. `{ id: '42' }` for `diary://{id}`.
   */
  uriParams?: Record<string, string>
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
  context: ResourceHandlerContext
) => Promise<ReadResourceResult> | ReadResourceResult

export type PromptHandler<TArgsSchema extends TObject = TObject> = (
  name: string,
  args: Static<TArgsSchema>,
  context: HandlerContext
) => Promise<GetPromptResult> | GetPromptResult

// Generic MCP interfaces with TypeBox schema support
/**
 * Plugin-only fields of a tool definition. They are never listed to clients.
 */
export interface ToolDefinitionExtras {
  /**
   * The client capabilities this tool's handler may need when it throws
   * `InputRequired` (e.g. `{ elicitation: { form: {} } }`). A 2026-07-28
   * request can only stream progress before the result once the server knows
   * it will not have to refuse it with `-32021` and a 400, so progress is held
   * back unless the client declared every capability the tool may need. Left
   * out, that is every capability an input request can need. A handler that
   * asks for more than it declared, after progress has streamed, gets an
   * internal error.
   */
  inputCapabilities?: ModernClientCapabilities
}

export interface MCPTool<TSchema extends TObject = TObject> {
  definition: Tool & ToolDefinitionExtras & {
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
      definition: Omit<Tool, 'inputSchema'> & ToolDefinitionExtras & { inputSchema: TSchema },
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
export type UnsafeResourceHandler = (uri: string, context: ResourceHandlerContext) => Promise<ReadResourceResult> | ReadResourceResult
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

/**
 * Minimal tracer interface compatible with `@opentelemetry/api`'s `Tracer`.
 * Defined locally so consumers don't need `@opentelemetry/api` installed just
 * to import this package's types. Any real OTel `Tracer` satisfies this structurally.
 *
 * @see https://open-telemetry.github.io/opentelemetry-js/interfaces/_opentelemetry_api.Tracer.html
 */
export interface TracerLike {
  startActiveSpan (name: string, options: any, fn: (span: any) => any): any
  startActiveSpan (name: string, options: any, context: any, fn: (span: any) => any): any
}

/**
 * Which operation `canAccessTool` is deciding: `list` for `tools/list`
 * visibility, `call` for `tools/call` execution (including HTTP,
 * task-augmented, and `mcpCallTool()` calls, and calls to unknown tools).
 */
export type ToolAccessOperation = 'list' | 'call'

/** Resolve an application-authenticated identity from a Fastify request. */
export type AuthorizationContextResolver = (
  request: FastifyRequest
) => AuthorizationContext | undefined | Promise<AuthorizationContext | undefined>

/** Per-request context handed to the `canAccessTool` hook. */
export interface ToolAccessContext {
  authContext?: AuthorizationContext
  request: FastifyRequest
  sessionId?: string
  operation: ToolAccessOperation
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
  | { ok: false, reason: 'access-denied' }
  | { ok: false, reason: 'invalid-arguments', detail: string }
  | { ok: false, reason: 'task-required' }
  /**
   * The handler threw `InputRequired`: it needs the client to answer
   * `inputRequests` first. In-process there is no client to ask, so the call
   * cannot complete.
   */
  | { ok: false, reason: 'input-required', inputRequests: InputRequests }
  /**
   * A 2026-07-28 task ended `failed` or `cancelled` although its last round
   * returned a result or asked for input: it was cancelled after the handler
   * returned, ran out of input rounds, or timed out waiting for input.
   */
  | { ok: false, reason: 'task-ended', status: 'failed' | 'cancelled', message: string }

interface MCPToolCallCompleteEventBase {
  toolName: string
  arguments: Record<string, unknown>
  authContext?: AuthorizationContext
  sessionId?: string
  /** Correlates this event back to the originating request, for every source */
  requestId: string
  durationMs: number
  outcome: McpCallToolOutcome
}

/**
 * `source: 'task'` fires after the original HTTP response may already have
 * completed, so it must not carry the (possibly finished) `request`/`reply`
 * objects that the synchronous sources expose.
 */
export type MCPToolCallCompleteEvent =
  | (MCPToolCallCompleteEventBase & {
    source: 'json-rpc' | 'in-process'
    request: FastifyRequest
    reply: FastifyReply
  })
  | (MCPToolCallCompleteEventBase & {
    source: 'task'
    request?: undefined
    reply?: undefined
  })

export interface MCPClientResponseContext {
  sessionId?: string
  request: FastifyRequest
  authContext?: AuthorizationContext
}

export interface MCPPluginOptions {
  serverInfo?: Implementation
  /**
   * What the server supports. `extensions` is advertised by 2026-07-28's
   * `server/discover` only; the handshake revisions never see it.
   */
  capabilities?: ServerCapabilities & Pick<ModernServerCapabilities, 'extensions'>
  instructions?: string
  enableSSE?: boolean
  /**
   * Close an SSE stream after this many milliseconds so the client falls back to
   * polling and reconnects with `Last-Event-ID` (SEP-1699). Omit to keep streams
   * open indefinitely, which stays valid. With authorization enabled, a stream is
   * also closed when the token that opened it expires (its `exp` claim), whichever
   * comes first, so the client reconnects with a fresh token.
   */
  sseMaxConnectionMs?: number
  /**
   * Expire a session after this many milliseconds without activity (default
   * 3600000, one hour). Any request carrying the session id and every SSE
   * heartbeat count as activity, so sessions in use are kept; sessions a client
   * abandons without `DELETE /mcp` are removed. Applies to both the memory and
   * the Redis session store.
   */
  sessionTtlMs?: number
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
   * Most tasks one instance runs in the background at once, for both protocol
   * eras (default 1000). A task counts until its handler settles, even past
   * its ttl. Past the limit, a 2026-07-28 tool that only optionally supports
   * tasks runs synchronously, and a task is otherwise refused.
   */
  taskMaxConcurrent?: number
  /**
   * Most tasks one caller (a user at an issuer, whichever OAuth client they
   * come through) may run on an instance at once, for both protocol eras
   * (default 100). Not applied to callers the deployment cannot identify,
   * who are bounded by `taskMaxConcurrent` only. Past it, the same fallback
   * as `taskMaxConcurrent` applies.
   */
  taskMaxPerPrincipal?: number
  /**
   * Most tasks the in-memory task store holds, finished ones included until
   * their ttl (default 1000). At the cap the oldest finished task is evicted;
   * if every stored task is still running, new tasks are refused.
   */
  taskStoreMaxTasks?: number
  /**
   * Most tasks one caller (a user at an issuer, whichever OAuth client they
   * come through) may keep stored, finished ones included (default 100). At
   * the cap, the caller's oldest finished task is evicted; if all of them are
   * still running, the call fails with "Task limit reached". Unlike
   * `taskMaxPerPrincipal`, which bounds the tasks running on one instance,
   * this bounds what the store retains across instances.
   */
  taskMaxRetainedPerPrincipal?: number
  /**
   * How long a running task's worker lease lasts, for both protocol eras, in
   * milliseconds (default 15000; renewed every third of it). When an instance
   * dies, its tasks are reported failed this long after its last renewal
   * instead of staying `working` until their ttl runs out.
   */
  taskLeaseMs?: number
  /**
   * How many times a 2026-07-28 task's handler may throw `InputRequired`
   * before the task fails (default 32). A round that asks the client nothing
   * and only carries state waits the task's poll interval before running
   * again, so it cannot spin.
   */
  taskMaxInputRounds?: number
  /** Most `subscriptions/listen` streams one instance holds open (default 1000). */
  subscriptionMaxStreams?: number
  /**
   * Most `subscriptions/listen` streams one caller (a user at an issuer,
   * whichever OAuth client they come through) may hold open on an instance
   * (default 10). Not applied to callers the deployment cannot identify, who
   * are bounded by `subscriptionMaxStreams` only. Further streams are refused
   * with HTTP 429.
   */
  subscriptionMaxStreamsPerPrincipal?: number
  /** Most `resourceSubscriptions` URIs one stream may name (default 1000). */
  subscriptionMaxResourceUris?: number
  /**
   * On close, how long to wait for running tasks (both eras) to finish before
   * aborting them and recording them as failed, in milliseconds (default
   * 5000). Fastify bounds close hooks by its `pluginTimeout` (10s by default),
   * so keep this comfortably below it.
   */
  taskShutdownTimeoutMs?: number
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
   * How many bytes of JSON of earlier answers a sealed `requestState` carries
   * into later rounds. When the answers exceed it the oldest are dropped, so
   * a handler that must keep a large or old answer stores what it needs in
   * its own state. `0` disables carrying. Defaults to 64 KiB.
   */
  requestStateMaxAnswerBytes?: number
  /**
   * Resolve identities established by application-owned authentication hooks.
   * When present, this resolver is authoritative instead of the built-in OAuth
   * token payload. It runs once per MCP POST after Fastify preHandlers.
   *
   * The application remains responsible for rejecting unauthenticated requests.
   * Return a context with `userId` to bind request state and tasks to a principal.
   */
  resolveAuthorizationContext?: AuthorizationContextResolver
  /**
   * Origins accepted on the MCP endpoints, to prevent DNS rebinding attacks.
   * Omit to disable validation (non-browser deployments), pass `'*'` or `true`
   * to accept any origin, or list exact origins to allow.
   */
  allowedOrigins?: AllowedOrigins
  /**
   * Limits applied to every tool's arguments before the handler runs. Defaults:
   * `maxStringLength` 10000, `maxObjectProperties` 100, `maxDepth` 10,
   * `maxArrayLength` unlimited. Arrays are not counted as object properties.
   * Pass `Infinity` to disable a limit; Fastify's `bodyLimit` still caps the
   * total request size.
   */
  toolArgumentLimits?: ToolArgumentLimits
  /**
   * Per-request tool authorization, keyed by tool name. Consulted by both
   * `tools/list` (a denied tool is omitted) and `tools/call` (a denied tool
   * answers with the same "not found" error as an unknown tool, so callers
   * cannot probe for tools they are not allowed to see by response shape).
   * `tools/call` runs the hook even for unknown names. Response timing is not
   * guaranteed to be indistinguishable: it depends on what the hook itself
   * does per name. A hook that throws denies access.
   * `context.operation` tells the hook which decision it is making: `'list'`
   * for `tools/list` visibility, `'call'` for execution (HTTP, task-augmented,
   * and `mcpCallTool()` calls, and unknown tool names, all use `'call'`).
   * Visibility and execution policies may intentionally differ.
   * Omit to keep every registered tool visible and callable.
   */
  canAccessTool?: (
    toolName: string,
    context: ToolAccessContext
  ) => boolean | Promise<boolean>
  /**
   * Fires once per tool call, after it settles, regardless of transport
   * (JSON-RPC, `app.mcpCallTool()`, or a completed task). Not called for
   * `tools/list`, initialization/ping, or malformed requests where no tool
   * name was resolved. Awaited before the response is sent, so keep it fast;
   * a throwing hook is logged and otherwise ignored, it never changes the
   * tool response. `event.arguments` are the raw, unredacted tool
   * arguments, so redact sensitive values yourself before logging them.
   */
  onToolCallComplete?: (
    event: MCPToolCallCompleteEvent
  ) => void | Promise<void>
  /**
   * Receives the JSON-RPC responses a client POSTs back for server-initiated
   * requests, such as the `ElicitResult` answering `app.mcpElicit()`; match it
   * to the request by `response.id`. The POST is acknowledged with 202 either
   * way. It fires on whichever instance received the POST, which in a Redis
   * deployment may not be the one that sent the request. A throwing hook is
   * logged and otherwise ignored.
   */
  onClientResponse?: (
    response: JSONRPCResponse,
    context: MCPClientResponseContext
  ) => void | Promise<void>
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
  /**
   * Redis connection options, passed as-is to the ioredis constructor.
   * Providing this option switches sessions, messaging and tasks to the Redis backends.
   */
  redis?: RedisOptions
  authorization?: AuthorizationConfig
  /**
   * Optional OpenTelemetry instrumentation.
   * Provide a Tracer to enable per-operation spans with MCP semantic convention attributes.
   * Any `Tracer` from `@opentelemetry/api` satisfies `TracerLike`.
   * `@opentelemetry/api` must be installed as a peer dependency when using this option.
   */
  telemetry?: {
    tracer: TracerLike
  }
}

export interface SSESession {
  id: string
  eventId: number
  streams: Set<FastifyReply>
  lastEventId?: string
  messageHistory: Array<{ eventId: string, message: JSONRPCMessage }>
}
