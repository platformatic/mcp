import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import createFastifyError from 'fastify-error'
import type { TSchema } from '@sinclair/typebox'
import type {
  JSONRPCMessage,
  JSONRPCRequest,
  JSONRPCResponse,
  JSONRPCError,
  JSONRPCNotification,
  InitializeResult,
  EmptyResult,
  ListToolsResult,
  ListResourcesResult,
  ListResourceTemplatesResult,
  Resource,
  ResourceTemplate,
  ListPromptsResult,
  CallToolResult,
  ReadResourceResult,
  GetPromptResult,
  CreateTaskResult,
  ListTasksResult
} from './schema.ts'

import {
  JSONRPC_VERSION,
  LATEST_PROTOCOL_VERSION,
  LATEST_LEGACY_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  METHOD_NOT_FOUND,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  RESOURCE_NOT_FOUND
} from './schema.ts'
import type { ClientCapabilities, RequestId } from './schema.ts'
import type { ClientCapabilities as ModernClientCapabilities } from './schema-2026.ts'

import type {
  MCPTool,
  MCPResource,
  MCPPrompt,
  MCPPluginOptions,
  ResourceHandlers,
  HandlerContext,
  McpCallToolOutcome,
  ToolAccessOperation,
  MCPToolCallCompleteEvent,
  TracerLike
} from './types.ts'
import type { SessionStore } from './stores/session-store.ts'
import type { TaskStore, TaskRecord, TaskWaiters, TaskLeases } from './stores/task-store.ts'
import { InvalidTaskCursorError, TaskLimitError, TASK_LIMIT_REACHED, TASK_OWNER_LOST, decodeTaskCursor, isTerminal, ownerLostOutcome, toWireTask } from './stores/task-store.ts'
import type { AuthorizationContext } from './types/auth-types.ts'
import { principalOf } from './principal.ts'
import { TASK_CANCELLED, TaskStopped, isRunningHere, quotaKeyOf, reserveTask, setLongTimeout } from './task-registry.ts'
import type { TaskInputChannel } from './modern/task-inputs.ts'
import { InputRequired } from './modern/input-required.ts'
import type { RequestNotifiers } from './modern/request-stream.ts'
import { isStdioRequest } from './stdio-trust.ts'
import {
  atLeast,
  supportsTasks,
  supportsSchemaDialect,
  trimDefinitionToRevision,
  capabilitiesForRevision
} from './protocol-version.ts'
import { validate, CallToolRequestSchema, ReadResourceRequestSchema, GetPromptRequestSchema, isTypeBoxSchema } from './validation/index.ts'
import type { JsonSchemaValidator } from './validation/json-schema-validator.ts'
import { createJsonSchemaValidator } from './validation/json-schema-validator.ts'
import { sanitizeToolParams, assessToolSecurity } from './security.ts'
import { MCP_ATTR, type SpanAttributeValue } from './telemetry-constants.ts'

// Lazy-loaded telemetry module — only imported when a tracer is configured
let _telemetry: typeof import('./telemetry.ts') | undefined
async function getTelemetry () {
  if (!_telemetry) _telemetry = await import('./telemetry.ts')
  return _telemetry
}

export type HandlerDependencies = {
  app: FastifyInstance
  opts: MCPPluginOptions
  capabilities: any
  serverInfo: any
  tools: Map<string, MCPTool>
  resources: Map<string, MCPResource>
  prompts: Map<string, MCPPrompt>
  resourceHandlers: ResourceHandlers
  request: FastifyRequest
  reply: FastifyReply
  authContext?: AuthorizationContext
  tracer?: TracerLike
  sessionStore?: SessionStore
  taskStore?: TaskStore
  taskWaiters?: TaskWaiters
  /** Aborted when the plugin starts closing, to release blocked calls */
  shutdownSignal?: AbortSignal
  taskLeases?: TaskLeases
  jsonSchemaValidator?: JsonSchemaValidator
  sessionId?: string
  /** The revision this client negotiated; responses are shaped to match it */
  protocolVersion?: string
  /**
   * Multi round-trip state for the 2026-07-28 path: what the client sent back
   * in answer to a previous `InputRequiredResult`. Absent on a first attempt
   * and on the legacy path.
   */
  mrtr?: {
    inputResponses?: Record<string, unknown>
    /** The payload the handler sealed into `requestState`, already verified. */
    requestState?: unknown
  }
  /** Wakes task executions when `tasks/update` delivers their input. */
  taskInputs?: TaskInputChannel
  /**
   * Report failures as JSON-RPC errors rather than as successful content.
   * Set on the 2026-07-28 path, where a successful `resources/read` carries
   * caching hints and an error must never be cached as the resource.
   */
  strictErrors?: boolean
  /** Aborts when the request is cancelled; see `HandlerContext.signal`. */
  signal?: AbortSignal
  /** Request-scoped notifications; see `HandlerContext.sendProgress` and `log`. */
  notifiers?: RequestNotifiers
  /** What the client declared on this request; see `HandlerContext.clientCapabilities`. */
  clientCapabilities?: ModernClientCapabilities
}

export type ToolCallDependencies = Pick<HandlerDependencies,
  'app' |
  'opts' |
  'tools' |
  'request' |
  'reply' |
  'authContext' |
  'jsonSchemaValidator' |
  'sessionId' |
  'mrtr' |
  'signal' |
  'protocolVersion' |
  'notifiers' |
  'clientCapabilities'
>

export function createResponse (id: string | number, result: any): JSONRPCResponse {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    result
  }
}

export function createError (id: string | number | null, code: number, message: string, data?: any): JSONRPCError {
  return {
    jsonrpc: JSONRPC_VERSION,
    // JSON-RPC requires an explicit null id when the request id is unknown
    // (e.g. an unparseable batch); RequestId does not model null, so cast.
    id: id as RequestId,
    error: { code, message, data }
  }
}

/**
 * Requests MUST carry a string or integer id, and responses MUST echo it. A
 * numeric id outside the safe integer range has already lost precision in
 * JSON.parse, so answering it would echo a different id; refuse it instead.
 * Returns the error to send, or null if the id is acceptable.
 */
export function checkRequestId (message: unknown): JSONRPCError | null {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return null
  const id = (message as { id?: unknown }).id
  if (typeof id === 'number' && !Number.isSafeInteger(id)) {
    return createError(null, INVALID_REQUEST, 'Invalid Request: numeric id must be a safe integer')
  }
  return null
}

/**
 * The context every user handler receives.
 *
 * Built in one place so the multi round-trip fields cannot be plumbed into some
 * handler kinds and forgotten in others.
 */
/** For requests nothing can cancel. */
const NEVER_ABORTED = new AbortController().signal
const NO_NOTIFIERS: RequestNotifiers = { sendProgress: () => {}, log: () => {} }

export function handlerContext (
  dependencies: Pick<HandlerDependencies, 'request' | 'reply' | 'authContext' | 'mrtr' | 'signal' | 'notifiers' | 'protocolVersion' | 'clientCapabilities'>,
  sessionId: string | undefined
): HandlerContext {
  return {
    sessionId,
    protocolVersion: dependencies.protocolVersion,
    clientCapabilities: dependencies.clientCapabilities,
    request: dependencies.request,
    reply: dependencies.reply,
    authContext: dependencies.authContext,
    inputResponses: dependencies.mrtr?.inputResponses,
    requestState: dependencies.mrtr?.requestState,
    signal: dependencies.signal ?? NEVER_ABORTED,
    sendProgress: (dependencies.notifiers ?? NO_NOTIFIERS).sendProgress,
    log: (dependencies.notifiers ?? NO_NOTIFIERS).log
  }
}

/** Answered (to nobody) when a request is cancelled before its handler started. */
const CANCELLED_BEFORE_START = 'The request was cancelled before its handler started'

/**
 * A handler asking for client input is a protocol outcome, not a failure, so it
 * must escape the catch-alls that turn thrown errors into `isError` results.
 */
function rethrowIfInputRequired (error: unknown): void {
  if (error instanceof InputRequired) throw error
}

/** The {@link InputRequired} behind each `input-required` tool outcome. */
const inputRequiredErrors = new WeakMap<McpCallToolOutcome, InputRequired>()

/**
 * A tool asking for client input reports it as an outcome, so in-process
 * callers and `onToolCallComplete` see it like any other. The JSON-RPC paths
 * turn it back into the error the dispatchers handle.
 */
function inputRequiredOutcome (error: InputRequired): McpCallToolOutcome {
  const outcome: McpCallToolOutcome = { ok: false, reason: 'input-required', inputRequests: error.inputRequests ?? {} }
  inputRequiredErrors.set(outcome, error)
  return outcome
}

/**
 * Pick the protocol revision for a client that arrived via `initialize`.
 *
 * We echo back what was asked for when we implement it, and otherwise answer
 * with the newest revision we support that still has a handshake. Answering
 * with 2026-07-28 would be nonsense here: a client capable of it would not be
 * sending `initialize` in the first place.
 */
export function negotiateProtocolVersion (requested: unknown): string {
  if (typeof requested === 'string' &&
      requested !== LATEST_PROTOCOL_VERSION &&
      (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)) {
    return requested
  }
  return LATEST_LEGACY_PROTOCOL_VERSION
}

async function handleInitialize (
  request: JSONRPCRequest,
  sessionId: string | undefined,
  dependencies: HandlerDependencies
): Promise<JSONRPCResponse> {
  const { app, opts, capabilities, serverInfo, sessionStore } = dependencies

  const requested = (request.params as { protocolVersion?: unknown } | undefined)?.protocolVersion
  const protocolVersion = negotiateProtocolVersion(requested)

  if (requested !== undefined && requested !== protocolVersion) {
    app.log.warn({
      requested,
      offered: protocolVersion,
      sessionId
    }, 'Unsupported protocol version requested, offering latest supported version')
  }

  // Remember what we agreed on so later requests can be checked against it,
  // and what the client can handle so server-initiated requests (elicitation)
  // are only sent when the client declared support for them
  if (sessionId && sessionStore) {
    const session = await sessionStore.get(sessionId)
    if (session) {
      session.protocolVersion = protocolVersion
      const declared = (request.params as { capabilities?: unknown } | undefined)?.capabilities
      session.clientCapabilities = declared && typeof declared === 'object' ? declared as ClientCapabilities : {}
      session.lastActivity = new Date()
      await sessionStore.update(session)
    }
  }

  const result: InitializeResult = {
    protocolVersion,
    // Never advertise a capability the agreed revision cannot express, nor a
    // list-change notification a legacy client has no SSE channel to receive.
    // stdio has none either: its client never opens a GET stream.
    capabilities: withoutLogging(withoutUndeliverableNotifications(
      capabilitiesForRevision(capabilities, protocolVersion),
      opts.enableSSE === true && !isStdioRequest(dependencies.request)
    )),
    serverInfo,
    instructions: opts.instructions
  }
  return createResponse(request.id, result)
}

function handlePing (request: JSONRPCRequest): JSONRPCResponse {
  const result: EmptyResult = {}
  return createResponse(request.id, result)
}

/**
 * SEP-1613 made JSON Schema 2020-12 the default dialect for MCP schemas.
 * We declare it explicitly on the schemas we publish so clients never have to
 * guess, while leaving an author-supplied `$schema` untouched.
 */
const JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema'

function withSchemaDialect<T> (schema: T, protocolVersion: string | undefined): T {
  if (!supportsSchemaDialect(protocolVersion)) return schema
  if (!schema || typeof schema !== 'object') return schema
  if ('$schema' in (schema as Record<string, unknown>)) return schema
  return { $schema: JSON_SCHEMA_DIALECT, ...(schema as Record<string, unknown>) } as T
}

/**
 * A legacy client only receives notifications on its SSE stream. Without one,
 * advertising `listChanged` or resource `subscribe` would promise
 * notifications that can never arrive.
 */
function withoutUndeliverableNotifications<T extends Record<string, any>> (capabilities: T, deliverable: boolean): T {
  if (deliverable) return capabilities
  const trimmed: Record<string, any> = { ...capabilities }
  for (const list of ['tools', 'resources', 'prompts']) {
    if (trimmed[list]?.listChanged || (list === 'resources' && trimmed[list]?.subscribe)) {
      const { listChanged, ...rest } = trimmed[list]
      if (list === 'resources') delete rest.subscribe
      trimmed[list] = rest
    }
  }
  return trimmed as T
}

/**
 * Legacy logging is driven by `logging/setLevel`, which this server does not
 * implement, and `context.log` writes nothing on this path, so a client told
 * `logging` is supported would only get errors back.
 */
function withoutLogging<T extends Record<string, any>> (capabilities: T): T {
  if (!('logging' in capabilities)) return capabilities
  const { logging, ...rest } = capabilities
  return rest as T
}

/**
 * Evaluate the `canAccessTool` hook for one tool. No hook means every tool is
 * accessible. A hook that throws denies access (fail closed) rather than
 * exposing a tool the deployment meant to gate; the error is logged so a
 * misbehaving hook is visible to the operator.
 */
async function checkToolAccess (
  toolName: string,
  operation: ToolAccessOperation,
  dependencies: ToolCallDependencies
): Promise<boolean> {
  const hook = dependencies.opts.canAccessTool
  if (!hook) return true
  try {
    return await hook(toolName, {
      authContext: dependencies.authContext,
      request: dependencies.request,
      sessionId: dependencies.sessionId,
      operation
    }) === true
  } catch (error) {
    dependencies.request.log.warn({
      err: error,
      tool: toolName,
      operation
    }, 'canAccessTool hook threw; denying access')
    return false
  }
}

const TOOL_ACCESS_CONCURRENCY = 8

const UnhandledToolCallOutcomeError = createFastifyError(
  'MCP_ERR_UNHANDLED_TOOL_CALL_OUTCOME',
  'Unhandled tool call outcome: %s'
)

async function mapWithConcurrency<T, R> (items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  async function worker (): Promise<void> {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

export async function handleToolsList (request: JSONRPCRequest, dependencies: HandlerDependencies): Promise<JSONRPCResponse> {
  const { tools, protocolVersion } = dependencies
  // Per-tool checks run concurrently (bounded); order stays registration order
  const registeredTools = Array.from(tools.values())
  const accessResults = await mapWithConcurrency(
    registeredTools,
    TOOL_ACCESS_CONCURRENCY,
    tool => checkToolAccess(tool.definition.name, 'list', dependencies)
  )
  const accessibleTools = registeredTools.filter((_tool, index) => accessResults[index])
  const result: ListToolsResult = {
    tools: accessibleTools.map(t => {
      const { inputCapabilities, ...tool } = trimDefinitionToRevision(t.definition, protocolVersion)
      // TypeBox schemas are already JSON Schema compatible
      const serialized: typeof tool = {
        ...tool,
        // `inputSchema` is required, and must be an object schema; a tool
        // registered without one takes an object of anything.
        inputSchema: withSchemaDialect(tool.inputSchema ?? { type: 'object' }, protocolVersion)
      }
      if (serialized.outputSchema) {
        serialized.outputSchema = withSchemaDialect(serialized.outputSchema, protocolVersion)
      }
      return serialized
    }),
    nextCursor: undefined
  }
  return createResponse(request.id, result)
}

const URI_TEMPLATE_REGEX = /\{[^}]+\}/

function isTemplateUri (uri: string): boolean {
  return URI_TEMPLATE_REGEX.test(uri)
}

interface CompiledUriTemplate {
  regex: RegExp
  names: string[]
}

const compiledUriTemplates = new Map<string, CompiledUriTemplate | null>()

/**
 * Compile an RFC 6570 level-1 template (`{name}` placeholders only) into an
 * anchored regex. Each placeholder matches one non-empty, slash-bounded
 * segment; everything else must match literally. Templates using operators
 * (`{+x}`, `{?x}`, ...) are not supported and never match.
 */
function compileUriTemplate (template: string): CompiledUriTemplate | null {
  let compiled = compiledUriTemplates.get(template)
  if (compiled !== undefined) return compiled

  const names: string[] = []
  let source = '^'
  let lastIndex = 0
  let supported = true
  for (const match of template.matchAll(/\{([^}]*)\}/g)) {
    const name = match[1]
    if (!/^[A-Za-z0-9_]+$/.test(name)) {
      supported = false
      break
    }
    source += escapeRegExp(template.slice(lastIndex, match.index)) + '([^/]+)'
    names.push(name)
    lastIndex = match.index + match[0].length
  }
  source += escapeRegExp(template.slice(lastIndex)) + '$'

  compiled = supported ? { regex: new RegExp(source), names } : null
  compiledUriTemplates.set(template, compiled)
  return compiled
}

function escapeRegExp (value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function matchUriTemplate (template: string, uri: string): Record<string, string> | null {
  const compiled = compileUriTemplate(template)
  if (!compiled) return null

  const match = compiled.regex.exec(uri)
  if (!match) return null

  const params: Record<string, string> = {}
  compiled.names.forEach((name, i) => {
    const raw = match[i + 1]
    try {
      params[name] = decodeURIComponent(raw)
    } catch {
      params[name] = raw
    }
  })
  return params
}

// Fields shared by the spec Resource and ResourceTemplate shapes. Anything else
// on a registered definition (uriPattern, uriSchema, ...) is a registration
// input and must not be listed: uriSchema would leak validation patterns.
const RESOURCE_METADATA_FIELDS = ['name', 'title', 'description', 'mimeType', 'icons', 'annotations', '_meta'] as const

function pickResourceMetadata (definition: Record<string, any>, fields: readonly string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {}
  for (const field of fields) {
    if (definition[field] !== undefined) {
      picked[field] = definition[field]
    }
  }
  return picked
}

export function handleResourcesList (request: JSONRPCRequest, dependencies: HandlerDependencies): JSONRPCResponse {
  const { resources, protocolVersion } = dependencies
  const result: ListResourcesResult = {
    resources: Array.from(resources.values())
      .filter(r => !isTemplateUri(r.definition.uri))
      .map(r => {
        const definition = trimDefinitionToRevision(r.definition, protocolVersion)
        return {
          uri: definition.uri,
          ...pickResourceMetadata(definition, [...RESOURCE_METADATA_FIELDS, 'size'])
        } as Resource
      }),
    nextCursor: undefined
  }
  return createResponse(request.id, result)
}

export function handleResourceTemplatesList (request: JSONRPCRequest, dependencies: HandlerDependencies): JSONRPCResponse {
  const { resources, protocolVersion } = dependencies
  const result: ListResourceTemplatesResult = {
    resourceTemplates: Array.from(resources.values())
      .filter(r => isTemplateUri(r.definition.uri))
      .map(r => {
        const definition = trimDefinitionToRevision(r.definition, protocolVersion)
        return {
          uriTemplate: definition.uri,
          ...pickResourceMetadata(definition, RESOURCE_METADATA_FIELDS)
        } as ResourceTemplate
      }),
    nextCursor: undefined
  }
  return createResponse(request.id, result)
}

export function handlePromptsList (request: JSONRPCRequest, dependencies: HandlerDependencies): JSONRPCResponse {
  const { prompts, protocolVersion } = dependencies
  const result: ListPromptsResult = {
    prompts: Array.from(prompts.values()).map(p => {
      // argumentSchema is our validation input, not part of the spec Prompt shape
      const { argumentSchema, ...definition } = p.definition
      return trimDefinitionToRevision(definition, protocolVersion)
    }),
    nextCursor: undefined
  }
  return createResponse(request.id, result)
}

async function handleToolsCall (
  request: JSONRPCRequest,
  sessionId: string | undefined,
  dependencies: HandlerDependencies
): Promise<JSONRPCResponse | JSONRPCError> {
  // Validate the request parameters structure
  const paramsValidation = validate(CallToolRequestSchema, request.params)
  if (!paramsValidation.success) {
    return createError(request.id, INVALID_PARAMS, 'Invalid tool call parameters', {
      validation: paramsValidation.error
    })
  }

  const params = paramsValidation.data
  const toolName = params.name

  // A client on an older revision cannot have meant `task`, because we never
  // declared the capability to it. The spec says to ignore it in that case.
  const taskParams = supportsTasks(dependencies.protocolVersion)
    ? (request.params as { task?: { ttl?: unknown } | null } | undefined)?.task
    : undefined
  const ttl = taskParams?.ttl ?? undefined
  if (ttl !== undefined && !isValidTaskTtl(ttl)) {
    return createError(request.id, INVALID_PARAMS, 'Invalid task ttl: expected a non-negative integer number of milliseconds')
  }
  const startedAt = performance.now()

  // A denied tool answers exactly like an unknown one, so a caller cannot
  // distinguish "does not exist" from "exists but not for you" by the protocol
  // response (mirrors the tools/list filtering). The hook runs even for
  // unknown names. No timing guarantee: latency depends on what the hook
  // itself does per name.
  // Authorization is a protocol-level rejection, not a SEP-1303 tool error:
  // the model cannot correct itself out of missing access.
  const resolved = await resolveRegisteredTool(toolName, dependencies)
  if (!resolved.ok) {
    // Keep the JSON-RPC observer aligned with the privacy-preserving protocol
    // response: denied registered tools are indistinguishable from unknown ones.
    const observedOutcome: McpCallToolOutcome = resolved.reason === 'access-denied'
      ? { ok: false, reason: 'not-found' }
      : resolved
    await emitToolCallComplete('json-rpc', toolName, params.arguments || {}, observedOutcome, startedAt, dependencies)
    return toolCallOutcomeToJsonRpc(request.id, toolName, resolved)
  }

  // Decide up front whether this call runs as a task, so the rest of the
  // handler can stay unaware of it.
  const augmentation = resolveTaskAugmentation(resolved.tool, taskParams !== undefined)
  if ('error' in augmentation) {
    await emitToolCallComplete('json-rpc', toolName, params.arguments || {}, { ok: false, reason: 'task-required' }, startedAt, dependencies)
    return createError(request.id, METHOD_NOT_FOUND, augmentation.error)
  }
  if (augmentation.mode === 'task') {
    const response = await runToolCallAsTask(
      request,
      ttl,
      // Timed from when the task actually starts executing, not from when it
      // was queued, so `durationMs` reflects work done rather than wait time.
      (signal, defer) => executeToolCall(request, resolved.tool, params, sessionId, { ...dependencies, signal }, { source: 'task', startedAt: performance.now(), defer }),
      dependencies
    )
    // Refused at a limit, the call never ran; it still happened, as on 2026-07-28.
    if ('error' in response && response.error.code === TASK_LIMIT_REACHED) {
      await emitToolCallComplete('json-rpc', toolName, params.arguments || {}, { ok: false, reason: 'task-limit', message: response.error.message }, startedAt, dependencies)
    }
    return response
  }

  return await executeToolCall(request, resolved.tool, params, sessionId, dependencies, { source: 'json-rpc', startedAt })
}

/** An observability failure must never change the tool response. */
export async function emitToolCallComplete (
  source: MCPToolCallCompleteEvent['source'],
  toolName: string,
  args: Record<string, unknown>,
  outcome: McpCallToolOutcome,
  startedAt: number,
  dependencies: ToolCallDependencies
): Promise<void> {
  const hook = dependencies.opts.onToolCallComplete
  if (!hook) {
    return
  }

  const common = {
    toolName,
    arguments: args,
    authContext: dependencies.authContext,
    sessionId: dependencies.sessionId,
    requestId: dependencies.request.id,
    durationMs: performance.now() - startedAt,
    outcome
  }

  // Tasks may complete after the originating HTTP response has already been
  // sent, so they must never carry the (possibly finished) request/reply.
  const event: MCPToolCallCompleteEvent = source === 'task'
    ? { ...common, source }
    : { ...common, source, request: dependencies.request, reply: dependencies.reply }

  try {
    await hook(event)
  } catch (error) {
    if (source === 'task') {
      // request.log may belong to an already-finished request; app.log plus
      // the correlation id is the safe choice for task-time failures.
      dependencies.app.log.error({ err: error, tool: toolName, requestId: common.requestId }, 'onToolCallComplete hook failed')
    } else {
      dependencies.request.log.error({ err: error, tool: toolName }, 'onToolCallComplete hook failed')
    }
  }
}

type RegisteredToolResolution =
  | { ok: true, tool: MCPTool }
  | { ok: false, reason: 'not-found' }
  | { ok: false, reason: 'access-denied' }

export async function resolveRegisteredTool (
  toolName: string,
  dependencies: ToolCallDependencies
): Promise<RegisteredToolResolution> {
  const isAllowed = await checkToolAccess(toolName, 'call', dependencies)
  const tool = dependencies.tools.get(toolName)

  if (!tool) {
    return { ok: false, reason: 'not-found' }
  }

  if (!isAllowed) {
    return { ok: false, reason: 'access-denied' }
  }

  return { ok: true, tool }
}

function toolCallOutcomeToJsonRpc (
  id: RequestId,
  toolName: string,
  outcome: McpCallToolOutcome
): JSONRPCResponse | JSONRPCError {
  if (outcome.ok) {
    return createResponse(id, outcome.result)
  }

  switch (outcome.reason) {
    case 'invalid-arguments': {
      const result: CallToolResult = {
        content: [{
          type: 'text',
          text: `Invalid tool arguments: ${outcome.detail}`
        }],
        isError: true
      }
      return createResponse(id, result)
    }
    case 'not-found':
    case 'access-denied':
      // tools.md, Error Handling: unknown tools are an Invalid params protocol error
      return createError(id, INVALID_PARAMS, `Tool '${toolName}' not found`)
    // Unreachable from the JSON-RPC path today (handleToolsCall resolves task
    // augmentation itself), but kept in the mapping so the two paths stay
    // consistent if they ever converge. Mirrors resolveTaskAugmentation's error.
    case 'task-required':
      return createError(id, METHOD_NOT_FOUND, `Tool '${toolName}' requires task-augmented execution`)
    // The multi round-trip machinery answers this, not a tool result.
    case 'input-required':
      throw inputRequiredErrors.get(outcome) ?? new InputRequired({ inputRequests: outcome.inputRequests })
    // Only ever reported to onToolCallComplete, when a task could not be created.
    case 'task-limit':
      return createError(id, INVALID_REQUEST, `Cannot create a task: ${outcome.message}`)
    // Only ever reported to onToolCallComplete, once a task has ended.
    case 'task-ended':
      return createError(id, INTERNAL_ERROR, outcome.message)
    default: {
      const unhandled: never = outcome
      throw new UnhandledToolCallOutcomeError(JSON.stringify(unhandled))
    }
  }
}

export async function callRegisteredTool (
  name: string,
  args: Record<string, unknown>,
  dependencies: ToolCallDependencies
): Promise<McpCallToolOutcome> {
  const startedAt = performance.now()

  const resolved = await resolveRegisteredTool(name, dependencies)
  if (!resolved.ok) {
    await emitToolCallComplete('in-process', name, args, resolved, startedAt, dependencies)
    return resolved
  }

  const augmentation = resolveTaskAugmentation(resolved.tool, false)
  if ('error' in augmentation) {
    const outcome: McpCallToolOutcome = { ok: false, reason: 'task-required' }
    await emitToolCallComplete('in-process', name, args, outcome, startedAt, dependencies)
    return outcome
  }

  const outcome = await executeRegisteredTool(resolved.tool, name, args, dependencies)
  await emitToolCallComplete('in-process', name, args, outcome, startedAt, dependencies)
  return outcome
}

interface ToolCallObservationContext {
  source: MCPToolCallCompleteEvent['source']
  startedAt: number
  /**
   * A task's round is not necessarily the end of the call: the event is
   * handed here instead of being emitted, so the task can emit it once it
   * ends, with a different outcome if the task ended differently.
   */
  defer?: (outcome: McpCallToolOutcome, emit: (override?: McpCallToolOutcome) => Promise<void>) => void
}

export async function executeToolCall (
  request: JSONRPCRequest,
  tool: MCPTool,
  params: { name: string, arguments?: Record<string, unknown> },
  sessionId: string | undefined,
  dependencies: HandlerDependencies,
  observation: ToolCallObservationContext
): Promise<JSONRPCResponse | JSONRPCError> {
  const toolName = params.name
  const args = params.arguments || {}

  const callDependencies = { ...dependencies, sessionId }
  const outcome = await executeRegisteredTool(tool, toolName, args, callDependencies)
  const emit = (override?: McpCallToolOutcome) =>
    emitToolCallComplete(observation.source, toolName, args, override ?? outcome, observation.startedAt, callDependencies)
  if (observation.defer) {
    observation.defer(outcome, emit)
  } else {
    await emit()
  }
  return toolCallOutcomeToJsonRpc(request.id, toolName, outcome)
}

/** The revision that introduced `outputSchema` and `structuredContent`. */
const OUTPUT_SCHEMA_REVISION = '2025-06-18'

/**
 * Validates tool output. Unlike the input validator it must never change what
 * it checks: the result goes to the client exactly as the tool produced it.
 */
let outputValidator: JsonSchemaValidator | undefined
export function getOutputValidator (): JsonSchemaValidator {
  outputValidator ??= createJsonSchemaValidator({
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false
  })
  return outputValidator
}

/**
 * Hold a successful result to the tool's `outputSchema`: when one is declared,
 * the server MUST provide structured content that conforms to it. A result
 * that does not is the tool's bug, reported as a tool error rather than handed
 * to a client that may trust the schema. Error results are exempt.
 */
function conformToOutputSchema (
  tool: MCPTool,
  toolName: string,
  outcome: McpCallToolOutcome,
  dependencies: ToolCallDependencies
): McpCallToolOutcome {
  const schema = (tool.definition as { outputSchema?: unknown }).outputSchema
  if (!outcome.ok || schema === undefined || outcome.result.isError) return outcome
  // Revisions before 2025-06-18 have no `structuredContent`, so a text-only
  // result is correct there. An in-process call has no revision and is held
  // to the current rules.
  const version = dependencies.protocolVersion
  if (version !== undefined && !atLeast(version, OUTPUT_SCHEMA_REVISION)) return outcome

  const structured = outcome.result.structuredContent
  let problem: string | null = null
  if (structured === undefined) {
    problem = 'missing structuredContent'
  } else {
    try {
      // Validate what the client will receive: a Date or anything with
      // `toJSON` conforms by its serialized form, not its in-memory one.
      const wire = JSON.parse(JSON.stringify(structured))
      if (isTypeBoxSchema(schema)) {
        const checked = validate(schema as TSchema, wire)
        if (!checked.success) problem = checked.error.message
      } else {
        problem = getOutputValidator().validate(schema as Record<string, unknown>, wire)
      }
    } catch (error) {
      problem = `structured content cannot be validated: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  if (problem === null) return outcome

  dependencies.app.log.error({ tool: toolName, problem }, 'Tool result does not conform to its outputSchema')
  return {
    ok: true,
    result: {
      content: [{ type: 'text', text: `Tool '${toolName}' returned a result that does not match its output schema` }],
      isError: true
    }
  }
}

async function executeRegisteredTool (
  tool: MCPTool,
  toolName: string,
  args: Record<string, unknown>,
  dependencies: ToolCallDependencies
): Promise<McpCallToolOutcome> {
  return conformToOutputSchema(tool, toolName, await runRegisteredTool(tool, toolName, args, dependencies), dependencies)
}

async function runRegisteredTool (
  tool: MCPTool,
  toolName: string,
  args: Record<string, unknown>,
  dependencies: ToolCallDependencies
): Promise<McpCallToolOutcome> {
  const sessionId = dependencies.sessionId

  if (!tool.handler) {
    const result: CallToolResult = {
      content: [{
        type: 'text',
        text: `Tool '${toolName}' has no handler implementation`
      }],
      isError: true
    }
    return { ok: true, result }
  }

  // The caller may have gone (or cancelled) while the access check ran: a
  // tool must not start for a request nobody is waiting on any more.
  if (dependencies.signal?.aborted) {
    return { ok: true, result: { content: [{ type: 'text', text: CANCELLED_BEFORE_START }], isError: true } }
  }

  // Assess security risks from tool annotations
  const securityAssessment = assessToolSecurity(tool.definition.annotations)

  // Log security warnings for high-risk tools
  if (securityAssessment.riskLevel === 'high') {
    dependencies.app.log.warn({
      tool: toolName,
      sessionId,
      warnings: securityAssessment.warnings
    }, 'High-risk tool execution attempted')
  }

  // Validate and sanitize tool arguments against the tool's input schema
  let toolArguments = args

  try {
    // Sanitize arguments to prevent injection attacks
    toolArguments = sanitizeToolParams(toolArguments, dependencies.opts.toolArgumentLimits)
  } catch (sanitizeError) {
    dependencies.app.log.warn({
      tool: toolName,
      sessionId,
      error: sanitizeError instanceof Error ? sanitizeError.message : 'Unknown sanitization error'
    }, 'Tool arguments sanitization failed')

    // A pre-handler rejection, same as the TypeBox/AJV validation branches
    // below: the handler never runs.
    return {
      ok: false,
      reason: 'invalid-arguments',
      detail: sanitizeError instanceof Error ? sanitizeError.message : 'Tool arguments failed sanitization'
    }
  }
  if ('inputSchema' in tool.definition) {
    // Check if it's a TypeBox schema
    const schema = tool.definition.inputSchema
    if (isTypeBoxSchema(schema)) {
      // TypeBox schema - use our validation
      const argumentsValidation = validate(schema, toolArguments)
      if (!argumentsValidation.success) {
        return { ok: false, reason: 'invalid-arguments', detail: argumentsValidation.error.message }
      }

      // Use validated arguments
      try {
        const result = await tool.handler(argumentsValidation.data, handlerContext(dependencies, sessionId))
        return { ok: true, result }
      } catch (error: any) {
        if (error instanceof InputRequired) return inputRequiredOutcome(error)
        const result: CallToolResult = {
          content: [{
            type: 'text',
            text: `Tool execution failed: ${errorText(error)}`
          }],
          isError: true
        }
        return { ok: true, result }
      }
    } else {
      // Regular JSON Schema - validated with AJV when opted in, pass through otherwise
      if (dependencies.jsonSchemaValidator) {
        const validationError = dependencies.jsonSchemaValidator.validate(schema, toolArguments)
        if (validationError !== null) {
          // SEP-1303: a tool execution error, not a protocol error (same as the
          // TypeBox branch above)
          return { ok: false, reason: 'invalid-arguments', detail: validationError }
        }
      }
      try {
        const result = await tool.handler(toolArguments, handlerContext(dependencies, sessionId))
        return { ok: true, result }
      } catch (error: any) {
        if (error instanceof InputRequired) return inputRequiredOutcome(error)
        const result: CallToolResult = {
          content: [{
            type: 'text',
            text: `Tool execution failed: ${errorText(error)}`
          }],
          isError: true
        }
        return { ok: true, result }
      }
    }
  } else {
    // Unsafe tool without schema - pass arguments as-is
    try {
      const result = await tool.handler(toolArguments, handlerContext(dependencies, sessionId))
      return { ok: true, result }
    } catch (error: any) {
      if (error instanceof InputRequired) return inputRequiredOutcome(error)
      const result: CallToolResult = {
        content: [{
          type: 'text',
          text: `Tool execution failed: ${errorText(error)}`
        }],
        isError: true
      }
      return { ok: true, result }
    }
  }
}

export async function handleResourcesRead (
  request: JSONRPCRequest,
  sessionId: string | undefined,
  dependencies: HandlerDependencies
): Promise<JSONRPCResponse | JSONRPCError> {
  const { resources } = dependencies

  // Validate the request parameters structure
  const paramsValidation = validate(ReadResourceRequestSchema, request.params)
  if (!paramsValidation.success) {
    return createError(request.id, INVALID_PARAMS, 'Invalid resource read parameters', {
      validation: paramsValidation.error
    })
  }

  const params = paramsValidation.data
  const uri = params.uri

  // Try exact match first
  let resource = resources.get(uri)

  // If not found and URI has query params, try base URI for resources with uriSchema
  if (!resource && uri.includes('?')) {
    const baseUri = uri.split('?')[0]
    const baseResource = resources.get(baseUri)
    // Only use base resource if it has a uriSchema (expects query params)
    if (baseResource?.definition?.uriSchema) {
      resource = baseResource
    }
  }

  // Otherwise look for a registered template the concrete URI expands from
  let uriParams: Record<string, string> | undefined
  if (!resource) {
    for (const candidate of resources.values()) {
      if (!isTemplateUri(candidate.definition.uri)) continue
      const params = matchUriTemplate(candidate.definition.uri, uri)
      if (params) {
        resource = candidate
        uriParams = params
        break
      }
    }
  }

  if (!resource) {
    // resources.md, Error Handling: "Resource not found: -32002"
    return createError(request.id, RESOURCE_NOT_FOUND, `Resource '${uri}' not found`, { uri })
  }

  if (!resource.handler) {
    if (dependencies.strictErrors) {
      return createError(request.id, INTERNAL_ERROR, `Resource '${uri}' has no handler implementation`)
    }
    const result: ReadResourceResult = {
      contents: [{
        uri,
        text: 'Resource has no handler implementation',
        mimeType: 'text/plain'
      }]
    }
    return createResponse(request.id, result)
  }

  // Validate URI against resource's URI schema if present
  if ('uriSchema' in resource.definition && resource.definition.uriSchema) {
    const schema = resource.definition.uriSchema
    if (isTypeBoxSchema(schema)) {
      // TypeBox schema - use our validation
      const uriValidation = validate(schema, uri)
      if (!uriValidation.success) {
        return createError(request.id, INVALID_PARAMS, `Invalid resource URI: ${uriValidation.error.message}`, {
          validation: uriValidation.error
        })
      }
    }
  }

  if (dependencies.signal?.aborted) return createError(request.id, INTERNAL_ERROR, CANCELLED_BEFORE_START)

  try {
    const result = await resource.handler(uri, { ...handlerContext(dependencies, sessionId), uriParams })
    // A resource with no contents does not exist: answering an empty array
    // for it is not allowed, so report it the way a missing resource is.
    if (dependencies.strictErrors && Array.isArray(result?.contents) && result.contents.length === 0) {
      return createError(request.id, INVALID_PARAMS, `Resource '${uri}' not found`)
    }
    return createResponse(request.id, result)
  } catch (error: any) {
    rethrowIfInputRequired(error)
    dependencies.app.log.error({ err: error, uri }, 'Resource read handler failed')
    // On 2026-07-28 the handler's error may carry internals: it goes to the
    // log only. The legacy path keeps reporting its message.
    if (dependencies.strictErrors) return createError(request.id, INTERNAL_ERROR, 'Resource read failed')
    return createError(request.id, INTERNAL_ERROR, `Resource read failed: ${errorText(error)}`)
  }
}

export async function handlePromptsGet (
  request: JSONRPCRequest,
  sessionId: string | undefined,
  dependencies: HandlerDependencies
): Promise<JSONRPCResponse | JSONRPCError> {
  const { prompts } = dependencies

  // Validate the request parameters structure
  const paramsValidation = validate(GetPromptRequestSchema, request.params)
  if (!paramsValidation.success) {
    return createError(request.id, INVALID_PARAMS, 'Invalid prompt get parameters', {
      validation: paramsValidation.error
    })
  }

  const params = paramsValidation.data
  const promptName = params.name

  const prompt = prompts.get(promptName)
  if (!prompt) {
    // prompts.md, Error Handling: "Invalid prompt name: -32602 (Invalid params)"
    return createError(request.id, INVALID_PARAMS, `Prompt '${promptName}' not found`)
  }

  // Failures are JSON-RPC errors: -32602 for the client's arguments, -32603
  // otherwise. On 2026-07-28 a handler's error text stays in the server log;
  // the legacy path still reports it, and a prompt with no handler there is
  // still answered with a message.
  const strict = dependencies.strictErrors === true
  const asMessage = (text: string): JSONRPCResponse => createResponse(request.id, {
    messages: [{ role: 'user', content: { type: 'text', text } }]
  } satisfies GetPromptResult)
  const failed = (error: any): JSONRPCError => {
    dependencies.app.log.error({ err: error, prompt: promptName }, 'Prompt handler failed')
    if (!strict) return createError(request.id, INTERNAL_ERROR, `Prompt execution failed: ${errorText(error)}`)
    return createError(request.id, INTERNAL_ERROR, 'Internal server error')
  }

  if (!prompt.handler) {
    if (!strict) return asMessage(`Prompt '${promptName}' has no handler implementation`)
    dependencies.app.log.error({ prompt: promptName }, 'Prompt has no handler implementation')
    return createError(request.id, INTERNAL_ERROR, 'Internal server error')
  }

  // Validate prompt arguments against the prompt's argument schema
  const promptArguments: Record<string, unknown> = params.arguments || {}
  let handlerArguments: Record<string, unknown> = promptArguments
  const { argumentSchema } = prompt.definition
  if (argumentSchema && isTypeBoxSchema(argumentSchema)) {
    const argumentsValidation = validate(argumentSchema, promptArguments)
    if (!argumentsValidation.success) {
      return createError(request.id, INVALID_PARAMS, `Invalid prompt arguments: ${argumentsValidation.error.message}`, {
        validation: argumentsValidation.error
      })
    }
    handlerArguments = argumentsValidation.data as Record<string, unknown>
  } else {
    // No TypeBox schema: enforce the `required` flags declared in `arguments`
    const missing = (prompt.definition.arguments ?? [])
      .filter(argument => argument.required && promptArguments[argument.name] === undefined)
      .map(argument => argument.name)
    if (missing.length > 0) {
      return createError(request.id, INVALID_PARAMS, `Missing required prompt arguments: ${missing.join(', ')}`, { missing })
    }
  }

  if (dependencies.signal?.aborted) return createError(request.id, INTERNAL_ERROR, CANCELLED_BEFORE_START)

  try {
    const result = await prompt.handler(promptName, handlerArguments as any, handlerContext(dependencies, sessionId))
    return createResponse(request.id, result)
  } catch (error: any) {
    rethrowIfInputRequired(error)
    return failed(error)
  }
}

/* ---------------------------------------------------------------- tasks --- */

/** `_meta` key that ties every task-related message back to its task */
export const RELATED_TASK_META_KEY = 'io.modelcontextprotocol/related-task'

/** Suggested client polling interval, in milliseconds */
const DEFAULT_POLL_INTERVAL = 1000

/** Retention applied when the requestor does not ask for a specific ttl */
const DEFAULT_TASK_TTL = 60_000

/** Ceiling on retention, so a client cannot pin resources indefinitely */
const MAX_TASK_TTL = 3600_000

/**
 * Floor on retention. A smaller ttl (0 included) would let the task expire
 * before the requestor could poll it, and Redis keys have 1s granularity anyway.
 */
const MIN_TASK_TTL = 1000

/**
 * The spec types `ttl` as a number of milliseconds. Anything else (a string,
 * NaN, a negative or fractional value) is rejected rather than coerced, since it
 * would otherwise yield a task that never expires or one that is gone at once.
 */
function isValidTaskTtl (ttl: unknown): ttl is number {
  return Number.isSafeInteger(ttl) && (ttl as number) >= 0
}

/**
 * Resolve the effective task ttl bounds from plugin options. Tasks are meant for
 * long-running work, so a deployment whose tools outlive the 60s default can
 * raise `taskDefaultTtlMs` / `taskMaxTtlMs` rather than have tasks expire before
 * they finish (an expired task's `tasks/result` returns "not found").
 */
function taskTtlBounds (dependencies: HandlerDependencies): { defaultTtl: number, maxTtl: number } {
  return {
    defaultTtl: dependencies.opts.taskDefaultTtlMs ?? DEFAULT_TASK_TTL,
    maxTtl: dependencies.opts.taskMaxTtlMs ?? MAX_TASK_TTL
  }
}

/**
 * The principal a task belongs to: user, OAuth client and issuer, so another
 * app acting for the same user cannot read or cancel the task.
 *
 * When the deployment cannot identify requestors it is undefined, and tasks
 * are reachable by anyone holding the (cryptographically random) task id. That
 * limitation is why `tasks/list` is only advertised when auth is in play.
 */
function taskSubject (dependencies: HandlerDependencies): string | undefined {
  return principalOf(dependencies.authContext)
}

/**
 * Whether this deployment can tie a task to a requestor.
 *
 * Mirrors the gate in `index.ts` that decides whether to advertise
 * `tasks.list`. Without an identity resolver every task shares the undefined
 * subject,
 * so listing would hand every task's id to any caller — defeating the "random
 * task id is the capability" model that protects `tasks/get|result|cancel`.
 */
function canIdentifyRequestors (dependencies: HandlerDependencies): boolean {
  return dependencies.opts.authorization?.enabled === true || dependencies.opts.resolveAuthorizationContext !== undefined
}

/**
 * Enforce task isolation: a requestor may only touch its own tasks.
 * Returns null (surfaced as "invalid params") rather than a distinct "forbidden"
 * code so that probing for task ids cannot distinguish existence from ownership.
 */
function assertTaskAccess (task: TaskRecord | null, dependencies: HandlerDependencies): TaskRecord | null {
  if (!task) return null
  // 2026-07-28 tasks have a different shape and lifecycle (input rounds
  // answered through `tasks/update`), which a 2025-11-25 client cannot use.
  if (task.era === 'modern') return null

  if (canIdentifyRequestors(dependencies)) {
    // Identity resolution on: a task is reachable only by its exact owner. A
    // context without a `userId` identifies no one, so an undefined subject
    // must never match another subject-less task via `undefined === undefined`.
    const subject = taskSubject(dependencies)
    if (subject === undefined || task.authSubject !== subject) return null
    return task
  }

  // No identity resolver: the random task id is the capability and every
  // subject-less task is reachable by whoever holds it.
  return task
}

function relatedTaskMeta (taskId: string): Record<string, unknown> {
  return { [RELATED_TASK_META_KEY]: { taskId } }
}

/**
 * Should this `tools/call` run as a task?
 *
 * Combines the `task` request field with the tool's own `execution.taskSupport`
 * declaration, which the spec layers on top of the server capability.
 */
export function resolveTaskAugmentation (
  tool: MCPTool,
  requested: boolean
): { mode: 'task' | 'direct' } | { error: string } {
  const support = (tool.definition as any).execution?.taskSupport ?? 'forbidden'

  if (requested && support === 'forbidden') {
    return { error: `Tool '${tool.definition.name}' does not support task-augmented execution` }
  }
  if (!requested && support === 'required') {
    return { error: `Tool '${tool.definition.name}' requires task-augmented execution` }
  }
  return { mode: requested ? 'task' : 'direct' }
}

function newTaskRecord (
  method: string,
  ttl: number | undefined,
  subject: string | undefined,
  quotaKey: string | undefined,
  bounds: { defaultTtl: number, maxTtl: number },
  leaseMs?: number
): TaskRecord {
  const now = new Date().toISOString()
  const requested = ttl ?? bounds.defaultTtl
  return {
    taskId: randomUUID(),
    status: 'working',
    createdAt: now,
    lastUpdatedAt: now,
    // Receivers may override the requested ttl; we clamp it
    ttl: Math.min(Math.max(requested, MIN_TASK_TTL), bounds.maxTtl),
    pollInterval: DEFAULT_POLL_INTERVAL,
    method,
    authSubject: subject,
    quotaKey,
    era: 'legacy',
    // Leased from the start, so a worker that dies before its first renewal is
    // still reaped. The store stamps it with its own clock.
    ...(leaseMs !== undefined ? { leaseExpiresAt: Date.now() + leaseMs } : {})
  }
}

async function handleTasksGet (
  request: JSONRPCRequest,
  dependencies: HandlerDependencies
): Promise<JSONRPCResponse | JSONRPCError> {
  const { taskStore } = dependencies
  if (!taskStore) {
    return createError(request.id, METHOD_NOT_FOUND, 'Tasks are not enabled on this server')
  }

  const taskId = (request.params as { taskId?: string } | undefined)?.taskId
  if (!taskId) {
    return createError(request.id, INVALID_PARAMS, 'Missing required parameter: taskId')
  }

  const found = assertTaskAccess(await taskStore.get(taskId), dependencies)
  const task = found && await failIfOwnerLost(found, dependencies)
  if (!task) {
    return createError(request.id, INVALID_PARAMS, 'Failed to retrieve task: Task not found')
  }

  return createResponse(request.id, toWireTask(task))
}

/**
 * If the instance running `task` has stopped renewing its lease (it died or
 * shut down), mark the task failed rather than let it read `working` until its
 * ttl. The store does this as a compare-and-set, so a renewal or completion that
 * lands first wins. Returns the task as it now stands.
 *
 * Whether the lease has lapsed is decided by the store alone (RedisTaskStore
 * uses the Redis server clock): comparing against this instance's clock would
 * let a reader running behind keep a dead task `working`. The store is only
 * skipped for tasks that cannot have a lapsed lease at all.
 */
async function failIfOwnerLost (task: TaskRecord, dependencies: HandlerDependencies): Promise<TaskRecord | null> {
  const { taskStore, taskWaiters } = dependencies
  if (!taskStore || isTerminal(task.status) || typeof task.leaseExpiresAt !== 'number') {
    return task
  }

  const failed = await taskStore.expireStaleLease(task.taskId, TASK_OWNER_LOST, ownerLostOutcome())
  if (!failed) return task
  dependencies.app.log.warn({ taskId: task.taskId }, 'Task failed: the instance running it stopped renewing its lease')
  taskWaiters?.notify(failed)
  return failed
}

/**
 * Suspend for `ms`, or reject as soon as `signal` aborts.
 */
function delay (ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    if (typeof timer.unref === 'function') timer.unref()
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Block until the task reaches a terminal status, or throw when `signal` aborts.
 *
 * Two mechanisms run together:
 *  - an in-process waiter that fires the instant *this* instance completes the
 *    task, giving zero-latency wake-ups for single-instance and same-instance
 *    cases; and
 *  - bounded polling of the shared task store, which is what makes this correct
 *    across instances: with a Redis-backed store the task may complete on a
 *    different instance, whose `notify()` this process never sees, so polling is
 *    the only mechanism guaranteed to observe the terminal state.
 *
 * Returns null if the task disappears (expires or is deleted) while waiting.
 */
async function awaitTaskTerminal (
  taskId: string,
  initial: TaskRecord,
  dependencies: HandlerDependencies,
  signal: AbortSignal
): Promise<TaskRecord | null> {
  const { taskStore, taskWaiters } = dependencies
  if (!taskStore) return initial

  // A single waiter for the whole call. Resolves to a terminal task when this
  // instance completes it, or to null when aborted — caught here so that losing
  // the race below can never surface as an unhandled rejection.
  const accelerator: Promise<TaskRecord | null> = taskWaiters
    ? taskWaiters.wait(taskId, signal).then(task => task).catch(() => null)
    : new Promise<TaskRecord | null>(() => {})

  let task: TaskRecord | null = initial
  while (task && !isTerminal(task.status)) {
    // Once aborted, both racers settle at once: an abort that landed while
    // the store was being read would otherwise turn this into a busy loop.
    signal.throwIfAborted()
    const pollDelay = task.pollInterval ?? DEFAULT_POLL_INTERVAL
    const winner = await Promise.race([
      accelerator,
      delay(pollDelay, signal).then(() => null)
    ])

    if (winner && isTerminal(winner.status)) {
      return winner
    }
    // The poll timer elapsed (or the accelerator aborted); the shared store is
    // the source of truth, so re-read it before deciding whether to loop again.
    task = await taskStore.get(taskId)
    if (task) task = await failIfOwnerLost(task, dependencies)
  }

  return task
}

async function handleTasksResult (
  request: JSONRPCRequest,
  dependencies: HandlerDependencies
): Promise<JSONRPCResponse | JSONRPCError> {
  const { taskStore } = dependencies
  if (!taskStore) {
    return createError(request.id, METHOD_NOT_FOUND, 'Tasks are not enabled on this server')
  }

  const taskId = (request.params as { taskId?: string } | undefined)?.taskId
  if (!taskId) {
    return createError(request.id, INVALID_PARAMS, 'Missing required parameter: taskId')
  }

  const found = assertTaskAccess(await taskStore.get(taskId), dependencies)
  let task = found && await failIfOwnerLost(found, dependencies)
  if (!task) {
    return createError(request.id, INVALID_PARAMS, 'Failed to retrieve task: Task not found')
  }

  // `tasks/result` blocks until the task is terminal. Works across instances:
  // see awaitTaskTerminal.
  if (!isTerminal(task.status)) {
    // Watch the response, not the request: the IncomingMessage emits 'close'
    // as soon as its body is consumed, long before this handler runs.
    const res = dependencies.reply.raw
    const controller = new AbortController()
    const onClose = () => controller.abort()
    res.on('close', onClose)
    if (res.destroyed || res.socket?.destroyed) controller.abort()
    // On stdio the client cancels with `notifications/cancelled`, which only
    // the request's own signal reports. A shutdown gives up on tasks running
    // elsewhere, but one running here is drained, and its outcome is recorded
    // before the server closes: wait for that instead.
    const { shutdownSignal } = dependencies
    const local = dependencies.taskStore !== undefined && isRunningHere(dependencies.taskStore, taskId)
    const signal = AbortSignal.any([
      controller.signal,
      ...(shutdownSignal && !local ? [shutdownSignal] : []),
      ...(dependencies.signal ? [dependencies.signal] : [])
    ])
    try {
      const settled = await awaitTaskTerminal(taskId, task, dependencies, signal)
      if (!settled) {
        return createError(request.id, INVALID_PARAMS, 'Failed to retrieve task: Task not found')
      }
      task = settled
    } catch {
      if (shutdownSignal?.aborted) {
        // The server is past closing idle sockets; don't leave a keep-alive
        // connection behind for close() to wait on.
        dependencies.reply.header('connection', 'close')
        return createError(request.id, INTERNAL_ERROR, 'Server shutting down')
      }
      return createError(request.id, INTERNAL_ERROR, 'Client disconnected while awaiting task result')
    } finally {
      res.removeListener('close', onClose)
      // Release the TaskWaiters entry: it is only removed by a local notify()
      // or an abort, and polling may have answered this call instead.
      controller.abort()
    }
  }

  if (!isTerminal(task.status)) {
    return createError(request.id, INTERNAL_ERROR, 'Task did not reach a terminal status')
  }

  if (!task.outcome) {
    return createError(request.id, INTERNAL_ERROR, 'Task completed without recording a result')
  }

  // Return exactly what the underlying request would have returned, re-tagged
  // with this request's id and the related-task metadata the spec requires.
  if ('error' in task.outcome) {
    return {
      jsonrpc: JSONRPC_VERSION,
      id: request.id,
      error: task.outcome.error
    }
  }

  return createResponse(request.id, {
    ...task.outcome.result,
    _meta: {
      ...(task.outcome.result as any)._meta,
      ...relatedTaskMeta(taskId)
    }
  })
}

async function handleTasksList (
  request: JSONRPCRequest,
  dependencies: HandlerDependencies
): Promise<JSONRPCResponse | JSONRPCError> {
  const { taskStore } = dependencies
  if (!taskStore) {
    return createError(request.id, METHOD_NOT_FOUND, 'Tasks are not enabled on this server')
  }

  // Never advertised without auth (see index.ts), so treat it as nonexistent
  // rather than leaking every anonymous task's id to the caller.
  if (!canIdentifyRequestors(dependencies)) {
    return createError(request.id, METHOD_NOT_FOUND, 'Method tasks/list not found')
  }

  const cursor = (request.params as { cursor?: unknown } | undefined)?.cursor
  if (cursor !== undefined) {
    try {
      decodeTaskCursor(cursor)
    } catch {
      return createError(request.id, INVALID_PARAMS, 'Invalid cursor')
    }
  }

  const subject = taskSubject(dependencies)
  if (subject === undefined) {
    // Identity resolution is on but this caller carries no user, so it owns
    // nothing we can identify. Listing the ownerless tasks would expose every
    // other such caller's tasks, so return an empty set instead.
    return createResponse(request.id, { tasks: [], nextCursor: undefined } as ListTasksResult)
  }

  let page
  try {
    page = await taskStore.list(subject, { cursor: cursor as string | undefined, era: 'legacy' })
  } catch (err) {
    if (err instanceof InvalidTaskCursorError) {
      return createError(request.id, INVALID_PARAMS, 'Invalid cursor')
    }
    throw err
  }
  const result: ListTasksResult = {
    tasks: page.tasks.map(toWireTask),
    nextCursor: page.nextCursor
  }
  return createResponse(request.id, result)
}

async function handleTasksCancel (
  request: JSONRPCRequest,
  dependencies: HandlerDependencies
): Promise<JSONRPCResponse | JSONRPCError> {
  const { taskStore } = dependencies
  if (!taskStore) {
    return createError(request.id, METHOD_NOT_FOUND, 'Tasks are not enabled on this server')
  }

  const taskId = (request.params as { taskId?: string } | undefined)?.taskId
  if (!taskId) {
    return createError(request.id, INVALID_PARAMS, 'Missing required parameter: taskId')
  }

  const task = assertTaskAccess(await taskStore.get(taskId), dependencies)
  if (!task) {
    return createError(request.id, INVALID_PARAMS, 'Failed to retrieve task: Task not found')
  }

  if (isTerminal(task.status)) {
    return createError(request.id, INVALID_PARAMS, `Cannot cancel task: already in terminal status '${task.status}'`)
  }

  let cancelled: TaskRecord | null
  try {
    cancelled = await taskStore.updateStatus(taskId, 'cancelled', {
      statusMessage: 'The task was cancelled by request.',
      outcome: createError(request.id, INTERNAL_ERROR, 'Task was cancelled'),
      inputRequests: null,
      clearPendingInputResponses: true
    })
  } catch {
    // The task reached a terminal status between our check above and the write
    // (it completed or was cancelled concurrently). The spec maps this to
    // invalid params, not an internal error.
    return createError(request.id, INVALID_PARAMS, 'Cannot cancel task: the task reached a terminal status before it could be cancelled')
  }

  if (!cancelled) {
    return createError(request.id, INVALID_PARAMS, 'Failed to retrieve task: Task not found')
  }

  dependencies.taskWaiters?.notify(cancelled)
  // Stop the worker wherever it runs (it listens for this cancellation), not
  // only when its next lease renewal finds the task ended.
  try {
    await dependencies.taskInputs?.cancel(taskId)
  } catch (error) {
    dependencies.app.log.debug({ err: error, taskId }, 'Could not publish task input cancellation')
  }
  await notifyTaskStatus(cancelled, dependencies)

  return createResponse(request.id, toWireTask(cancelled))
}

/**
 * Push a `notifications/tasks/status` to the session that owns the task.
 * Optional per the spec — requestors must keep polling regardless — so a failure
 * to deliver is logged and swallowed.
 */
async function notifyTaskStatus (task: TaskRecord, dependencies: HandlerDependencies): Promise<void> {
  const { app, sessionId } = dependencies
  if (!sessionId || typeof (app as any).mcpSendToSession !== 'function') return

  try {
    await (app as any).mcpSendToSession(sessionId, {
      jsonrpc: JSONRPC_VERSION,
      method: 'notifications/tasks/status',
      params: toWireTask(task)
    })
  } catch (error) {
    app.log.debug({ err: error, taskId: task.taskId }, 'Failed to deliver task status notification')
  }
}

/**
 * Run a tool call as a task: record it, answer immediately with a
 * `CreateTaskResult`, and let execution finish in the background.
 */
async function runToolCallAsTask (
  request: JSONRPCRequest,
  ttl: number | undefined,
  execute: (signal: AbortSignal, defer: NonNullable<ToolCallObservationContext['defer']>) => Promise<JSONRPCResponse | JSONRPCError>,
  dependencies: HandlerDependencies
): Promise<JSONRPCResponse | JSONRPCError> {
  const { taskStore, taskWaiters, taskLeases, app } = dependencies
  if (!taskStore) {
    return createError(request.id, METHOD_NOT_FOUND, 'Tasks are not enabled on this server')
  }

  // When the deployment identifies callers a task is visible only to its
  // creator, so one created for a caller without an identity would be
  // unreachable, and would escape the per-caller limit too.
  const subject = taskSubject(dependencies)
  if (canIdentifyRequestors(dependencies) && subject === undefined) {
    return createError(request.id, INVALID_REQUEST, 'Cannot create a task: the caller is not identified')
  }

  const task = newTaskRecord('tools/call', ttl, subject, quotaKeyOf(dependencies.authContext), taskTtlBounds(dependencies), taskLeases?.leaseMs)

  // Legacy tasks share the limits, ttl abort and shutdown drain of the
  // 2026-07-28 ones, so neither era can starve the other.
  const reservation = reserveTask(taskStore, task.taskId, quotaKeyOf(dependencies.authContext), dependencies.opts)
  if (!reservation.ok) {
    // A limit is the caller's to wait out, as for the store's own cap; only a
    // shutdown is the server's fault.
    return reservation.limited
      ? createError(request.id, TASK_LIMIT_REACHED, reservation.reason)
      : createError(request.id, INTERNAL_ERROR, `Cannot create a task: ${reservation.reason}`)
  }
  // Stoppable from the moment it holds a slot: a shutdown that begins while
  // the task is still being created must reach it too.
  const stopController = new AbortController()
  const stopped = stopController.signal
  reservation.live.stop = (reason: TaskStopped) => {
    if (!stopped.aborted) stopController.abort(reason)
  }
  try {
    await taskStore.create(task)
  } catch (error) {
    reservation.release()
    if (error instanceof TaskLimitError) {
      return createError(request.id, TASK_LIMIT_REACHED, 'Task limit reached')
    }
    throw error
  }
  // The lease lets any instance tell a crashed worker from a slow one. A
  // renewal that finds the task ended (a cancellation whose broker message was
  // lost) stops the handler too.
  try {
    await taskLeases?.start(task.taskId, (status) => {
      reservation.live.stop(new TaskStopped(status === 'cancelled' ? TASK_CANCELLED : 'Task ended'))
    })
  } catch (error) {
    // Without a lease the task simply cannot be reaped early; it still runs
    app.log.warn({ err: error, taskId: task.taskId }, 'Failed to take task lease')
  }

  // `tasks/cancel` may arrive on any instance; it reaches the worker here.
  const stopListening = dependencies.taskInputs?.onCancel(task.taskId, () => {
    reservation.live.stop(new TaskStopped(TASK_CANCELLED))
  })
  // The slot stays held until the handler settles, even past the ttl, so a
  // caller cannot pile up background work by outliving it.
  const taskTtl = task.ttl ?? undefined
  const ttlTimer = taskTtl !== undefined && Number.isFinite(taskTtl)
    ? setLongTimeout(() => {
      reservation.live.stop(new TaskStopped('Task expired before it finished'))
    }, taskTtl)
    : undefined

  // Deliberately not awaited: the point of a task is to return control now.
  const execution = (async () => {
    let outcome: TaskRecord['outcome']
    let status: 'completed' | 'failed' = 'completed'
    let statusMessage: string | undefined
    // The call's event waits for the task to end, which may not be how the
    // handler's own result read (it was cancelled while running, say).
    let handlerOutcome: McpCallToolOutcome | undefined
    let unreported: ((override?: McpCallToolOutcome) => Promise<void>) | undefined

    try {
      // Stopped before it ever ran: the handler must not start.
      if (stopped.aborted) throw stopped.reason
      const result = await execute(stopped, (handled, emit) => {
        handlerOutcome = handled
        unreported = emit
      })
      // Stored as it will be read back: a result the store cannot hold (a
      // BigInt, a cycle) fails the task, as the call would answer -32603.
      let stored: JSONRPCResponse | JSONRPCError | undefined
      try {
        stored = JSON.parse(JSON.stringify(result))
      } catch (resultError) {
        app.log.error({ err: resultError, taskId: task.taskId }, 'Task result could not be serialized')
      }
      outcome = stored ?? createError(request.id, INTERNAL_ERROR, 'Internal server error')
      if (!stored) {
        status = 'failed'
        statusMessage = 'Internal server error'
      } else if ('result' in result && (result.result as CallToolResult)?.isError === true) {
        status = 'failed'
        statusMessage = 'Tool execution reported an error'
      } else if ('error' in result) {
        status = 'failed'
        statusMessage = result.error.message
      }
    } catch (error: any) {
      status = 'failed'
      statusMessage = `Tool execution failed: ${errorText(error)}`
      outcome = createError(request.id, INTERNAL_ERROR, statusMessage)
    }
    // A stopped task ends for the reason it was stopped.
    let ended: McpCallToolOutcome | undefined
    if (stopped.aborted && stopped.reason instanceof TaskStopped) {
      status = 'failed'
      statusMessage = stopped.reason.message
      outcome = createError(request.id, INTERNAL_ERROR, statusMessage)
      if (handlerOutcome?.ok || handlerOutcome?.reason === 'input-required') {
        const endStatus = stopped.reason.message === TASK_CANCELLED ? 'cancelled' : 'failed'
        ended = { ok: false, reason: 'task-ended', status: endStatus, message: statusMessage }
      }
    }
    await unreported?.(ended)

    try {
      const updated = await taskStore.updateStatus(task.taskId, status, { statusMessage, outcome })
      if (updated) {
        taskWaiters?.notify(updated)
        await notifyTaskStatus(updated, dependencies)
      }
    } catch (error) {
      // The task was cancelled or expired while the tool was still running
      app.log.debug({ err: error, taskId: task.taskId }, 'Could not record task outcome')
    } finally {
      taskLeases?.stop(task.taskId)
    }
  })()

  // Nothing awaits `execution`; keep an explicit rejection guard so an
  // unexpected throw can never become an unhandled rejection.
  execution
    .catch((error) => {
      app.log.error({ err: error, taskId: task.taskId }, 'Task execution failed unexpectedly')
    })
    .finally(() => {
      ttlTimer?.clear()
      stopListening?.()
      reservation.release()
    })

  const result: CreateTaskResult = { task: toWireTask(task) }
  return createResponse(request.id, result)
}

async function handleResourcesSubscribe (
  request: JSONRPCRequest,
  sessionId: string | undefined,
  dependencies: HandlerDependencies
): Promise<JSONRPCResponse | JSONRPCError> {
  const { resourceHandlers } = dependencies

  if (!resourceHandlers.subscribeHandler) {
    return createError(request.id, METHOD_NOT_FOUND, 'resources/subscribe handler not configured')
  }

  const params = request.params as { uri: string }
  if (!params?.uri) {
    return createError(request.id, INVALID_PARAMS, 'Missing required parameter: uri')
  }

  try {
    const result = await resourceHandlers.subscribeHandler(params, handlerContext(dependencies, sessionId))
    // Remember the subscription so resources/updated broadcasts only reach
    // the sessions that asked for this URI
    if (sessionId && dependencies.sessionStore) {
      await dependencies.sessionStore.addResourceSubscription(sessionId, params.uri)
    }
    return createResponse(request.id, result)
  } catch (error: any) {
    return createError(request.id, INTERNAL_ERROR, `Subscribe failed: ${errorText(error)}`)
  }
}

async function handleResourcesUnsubscribe (
  request: JSONRPCRequest,
  sessionId: string | undefined,
  dependencies: HandlerDependencies
): Promise<JSONRPCResponse | JSONRPCError> {
  const { resourceHandlers } = dependencies

  if (!resourceHandlers.unsubscribeHandler) {
    return createError(request.id, METHOD_NOT_FOUND, 'resources/unsubscribe handler not configured')
  }

  const params = request.params as { uri: string }
  if (!params?.uri) {
    return createError(request.id, INVALID_PARAMS, 'Missing required parameter: uri')
  }

  try {
    // Only the session holding the subscription undoes it: without one there
    // is nothing of this caller's to stop, and the handler would stop a
    // watcher someone else depends on.
    const session = sessionId && dependencies.sessionStore ? await dependencies.sessionStore.get(sessionId) : null
    if (!session?.resourceSubscriptions?.includes(params.uri)) {
      return createResponse(request.id, {})
    }
    const result = await resourceHandlers.unsubscribeHandler(params, handlerContext(dependencies, sessionId))
    await dependencies.sessionStore!.removeResourceSubscription(sessionId!, params.uri)
    return createResponse(request.id, result)
  } catch (error: any) {
    return createError(request.id, INTERNAL_ERROR, `Unsubscribe failed: ${errorText(error)}`)
  }
}

/** What a handler threw, as text: it may have thrown anything, null and symbols included. */
export function errorText (error: unknown): string {
  try {
    return String((error as { message?: unknown } | null | undefined)?.message || error)
  } catch {
    return 'Unknown error'
  }
}

function mcpContextCarrier (params: unknown): Record<string, string | string[]> | undefined {
  if (typeof params !== 'object' || params === null || !('_meta' in params)) return undefined
  const meta = params._meta
  if (typeof meta !== 'object' || meta === null) return undefined

  const carrier: Record<string, string | string[]> = {}
  for (const [key, value] of Object.entries(meta)) {
    if (typeof value === 'string' || (Array.isArray(value) && value.every(item => typeof item === 'string'))) {
      carrier[key] = value as string | string[]
    }
  }
  return Object.keys(carrier).length > 0 ? carrier : undefined
}

function normalizedNetworkProtocolVersion (version: string): string {
  return version.endsWith('.0') ? version.slice(0, -2) : version
}

export async function withMcpServerSpan<T> (
  message: JSONRPCRequest | JSONRPCNotification,
  sessionId: string | undefined,
  dependencies: HandlerDependencies,
  fn: () => Promise<T>
): Promise<T> {
  const { tracer, request } = dependencies
  if (!tracer) return fn()

  const params = message.params as any
  const extraAttrs: Record<string, SpanAttributeValue> = {}
  let target: string | undefined

  if ('id' in message && message.id !== null && message.id !== undefined) {
    extraAttrs[MCP_ATTR.JSONRPC_REQUEST_ID] = String(message.id)
  }

  if (message.method === 'tools/call' && params?.name) {
    target = params.name
    extraAttrs[MCP_ATTR.TOOL_NAME] = params.name
    extraAttrs[MCP_ATTR.OPERATION_NAME] = 'execute_tool'
  }
  if (message.method === 'prompts/get' && params?.name) {
    target = params.name
    extraAttrs[MCP_ATTR.PROMPT_NAME] = params.name
  }
  if (['resources/read', 'resources/subscribe', 'resources/unsubscribe', 'notifications/resources/updated'].includes(message.method) && params?.uri) {
    extraAttrs[MCP_ATTR.RESOURCE_URI] = params.uri
  }

  const protocolVersion = message.method === 'initialize'
    ? negotiateProtocolVersion(params?.protocolVersion)
    : dependencies.protocolVersion
  if (protocolVersion) extraAttrs[MCP_ATTR.PROTOCOL_VERSION] = protocolVersion

  // The plain transport header is only a hint any HTTP client could send;
  // trusting it would let a caller drop its address from the span.
  const isStdio = isStdioRequest(request)
  if (isStdio) {
    extraAttrs[MCP_ATTR.NETWORK_TRANSPORT] = 'pipe'
  } else {
    const httpVersion = request.raw.httpVersion
    extraAttrs[MCP_ATTR.NETWORK_TRANSPORT] = httpVersion.startsWith('3') ? 'quic' : 'tcp'
    extraAttrs[MCP_ATTR.NETWORK_PROTOCOL_NAME] = 'http'
    extraAttrs[MCP_ATTR.NETWORK_PROTOCOL_VERSION] = normalizedNetworkProtocolVersion(httpVersion)
    if (request.ip) extraAttrs[MCP_ATTR.CLIENT_ADDRESS] = request.ip
    if (request.socket.remotePort !== undefined) extraAttrs[MCP_ATTR.CLIENT_PORT] = request.socket.remotePort
  }

  const { withSpan, buildSpanAttributes } = await getTelemetry()
  const spanName = target ? `${message.method} ${target}` : message.method
  return withSpan(
    tracer,
    spanName,
    buildSpanAttributes(message.method, sessionId, extraAttrs),
    fn,
    {
      kind: 'server',
      carrier: mcpContextCarrier(params),
      recordMcpResponse: true
    }
  )
}

export async function handleRequest (
  request: JSONRPCRequest,
  sessionId: string | undefined,
  dependencies: HandlerDependencies
): Promise<JSONRPCResponse | JSONRPCError> {
  const { app } = dependencies

  app.log.info({
    method: request.method,
    id: request.id,
    sessionId
  }, `JSON-RPC method invoked: ${request.method}`)

  try {
    return await withMcpServerSpan(request, sessionId, dependencies, async () => {
      switch (request.method) {
        case 'initialize':
          return await handleInitialize(request, sessionId, dependencies)
        case 'ping':
          return handlePing(request)
        case 'tools/list':
          return await handleToolsList(request, dependencies)
        case 'resources/list':
          return handleResourcesList(request, dependencies)
        case 'resources/templates/list':
          return handleResourceTemplatesList(request, dependencies)
        case 'prompts/list':
          return handlePromptsList(request, dependencies)
        case 'tools/call':
          return await handleToolsCall(request, sessionId, dependencies)
        case 'resources/read':
          return await handleResourcesRead(request, sessionId, dependencies)
        case 'resources/subscribe':
          return await handleResourcesSubscribe(request, sessionId, dependencies)
        case 'resources/unsubscribe':
          return await handleResourcesUnsubscribe(request, sessionId, dependencies)
        case 'prompts/get':
          return await handlePromptsGet(request, sessionId, dependencies)
        case 'tasks/get':
        case 'tasks/result':
        case 'tasks/list':
        case 'tasks/cancel':
          // Tasks arrived in 2025-11-25; to an older client these methods simply
          // do not exist, and we never advertised them.
          if (!supportsTasks(dependencies.protocolVersion)) {
            return createError(request.id, METHOD_NOT_FOUND, `Method ${request.method} not found`)
          }
          if (request.method === 'tasks/get') return await handleTasksGet(request, dependencies)
          if (request.method === 'tasks/result') return await handleTasksResult(request, dependencies)
          if (request.method === 'tasks/list') return await handleTasksList(request, dependencies)
          return await handleTasksCancel(request, dependencies)
        default:
          return createError(request.id, METHOD_NOT_FOUND, `Method ${request.method} not found`)
      }
    })
  } catch (error) {
    // Never serialize the thrown value: an `InputRequired` carries the
    // handler's private state, and any other error may carry internals.
    if (error instanceof InputRequired) {
      return createError(
        request.id,
        INTERNAL_ERROR,
        'This request needs additional client input, which requires protocol version 2026-07-28'
      )
    }
    app.log.error({ err: error, method: request.method }, 'Unhandled error in MCP request')
    return createError(request.id, INTERNAL_ERROR, 'Internal server error')
  }
}

export function handleNotification (notification: JSONRPCNotification, app: FastifyInstance): void {
  switch (notification.method) {
    case 'notifications/initialized':
      app.log.info('MCP client initialized')
      break
    case 'notifications/cancelled':
      app.log.info('Request cancelled', notification.params)
      break
    default:
      app.log.warn(`Unknown notification: ${notification.method}`)
  }
}

async function handleClientResponse (response: JSONRPCResponse, dependencies: HandlerDependencies): Promise<void> {
  const hook = dependencies.opts.onClientResponse
  if (!hook) {
    dependencies.request.log.debug({ id: response.id, sessionId: dependencies.sessionId }, 'Ignoring client response: no onClientResponse hook')
    return
  }
  try {
    await hook(response, {
      sessionId: dependencies.sessionId,
      request: dependencies.request,
      authContext: dependencies.authContext
    })
  } catch (error) {
    dependencies.request.log.error({ err: error, id: response.id }, 'onClientResponse hook failed')
  }
}

export async function processMessage (
  message: JSONRPCMessage,
  sessionId: string | undefined,
  dependencies: HandlerDependencies
): Promise<JSONRPCResponse | JSONRPCError | null> {
  if (Array.isArray(message)) {
    // JSON-RPC batching was removed in the 2025-06-18 revision. Refuse it with a
    // proper protocol error rather than throwing, which the transport would
    // otherwise surface as an opaque HTTP 500.
    return createError(null, INVALID_REQUEST, 'Batch requests are not supported')
  }
  if ('id' in message && 'method' in message) {
    return await handleRequest(message as JSONRPCRequest, sessionId, dependencies)
  } else if ('method' in message) {
    return await withMcpServerSpan(message as JSONRPCNotification, sessionId, dependencies, async () => {
      handleNotification(message as JSONRPCNotification, dependencies.app)
      return null
    })
  } else if ('result' in message || 'error' in message) {
    // The client answering a server-initiated request (e.g. elicitation/create).
    // The transport acknowledges it with 202; hand it to the application.
    await handleClientResponse(message as JSONRPCResponse, dependencies)
    return null
  } else {
    throw new Error('Invalid JSON-RPC message')
  }
}
