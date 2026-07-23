import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
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
  SUPPORTED_PROTOCOL_VERSIONS,
  METHOD_NOT_FOUND,
  INTERNAL_ERROR,
  INVALID_PARAMS
} from './schema.ts'

import type { MCPTool, MCPResource, MCPPrompt, MCPPluginOptions, ResourceHandlers } from './types.ts'
import type { SessionStore } from './stores/session-store.ts'
import type { TaskStore, TaskRecord, TaskWaiters } from './stores/task-store.ts'
import { isTerminal, toWireTask } from './stores/task-store.ts'
import type { AuthorizationContext } from './types/auth-types.ts'
import {
  supportsTasks,
  supportsSchemaDialect,
  trimDefinitionToRevision,
  capabilitiesForRevision
} from './protocol-version.ts'
import { validate, CallToolRequestSchema, ReadResourceRequestSchema, GetPromptRequestSchema, isTypeBoxSchema } from './validation/index.ts'
import { sanitizeToolParams, assessToolSecurity, SECURITY_WARNINGS } from './security.ts'

type HandlerDependencies = {
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
  sessionStore?: SessionStore
  taskStore?: TaskStore
  taskWaiters?: TaskWaiters
  sessionId?: string
  /** The revision this client negotiated; responses are shaped to match it */
  protocolVersion?: string
}

export function createResponse (id: string | number, result: any): JSONRPCResponse {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    result
  }
}

export function createError (id: string | number, code: number, message: string, data?: any): JSONRPCError {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    error: { code, message, data }
  }
}

/**
 * Pick the protocol revision to use for this session.
 *
 * The spec requires that we echo back the client's requested version when we
 * support it, and otherwise respond with the newest version we do support so
 * the client can decide whether to continue or disconnect.
 */
export function negotiateProtocolVersion (requested: unknown): string {
  if (typeof requested === 'string' && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)) {
    return requested
  }
  return LATEST_PROTOCOL_VERSION
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

  // Remember what we agreed on so later requests can be checked against it
  if (sessionId && sessionStore) {
    const session = await sessionStore.get(sessionId)
    if (session) {
      session.protocolVersion = protocolVersion
      session.lastActivity = new Date()
      await sessionStore.update(session)
    }
  }

  const result: InitializeResult = {
    protocolVersion,
    // Never advertise a capability the agreed revision cannot express
    capabilities: capabilitiesForRevision(capabilities, protocolVersion),
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

function handleToolsList (request: JSONRPCRequest, dependencies: HandlerDependencies): JSONRPCResponse {
  const { tools, protocolVersion } = dependencies
  const result: ListToolsResult = {
    tools: Array.from(tools.values()).map(t => {
      const tool = trimDefinitionToRevision(t.definition, protocolVersion)
      // TypeBox schemas are already JSON Schema compatible
      const serialized: typeof tool = {
        ...tool,
        inputSchema: withSchemaDialect(tool.inputSchema, protocolVersion)
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

function handleResourcesList (request: JSONRPCRequest, dependencies: HandlerDependencies): JSONRPCResponse {
  const { resources, protocolVersion } = dependencies
  const result: ListResourcesResult = {
    resources: Array.from(resources.values())
      .filter(r => !isTemplateUri(r.definition.uri))
      .map(r => trimDefinitionToRevision(r.definition, protocolVersion)),
    nextCursor: undefined
  }
  return createResponse(request.id, result)
}

function handleResourceTemplatesList (request: JSONRPCRequest, dependencies: HandlerDependencies): JSONRPCResponse {
  const { resources, protocolVersion } = dependencies
  const result: ListResourceTemplatesResult = {
    resourceTemplates: Array.from(resources.values())
      .filter(r => isTemplateUri(r.definition.uri))
      .map(r => {
        const { uri, ...rest } = trimDefinitionToRevision(r.definition, protocolVersion)
        return { ...rest, uriTemplate: uri }
      }),
    nextCursor: undefined
  }
  return createResponse(request.id, result)
}

function handlePromptsList (request: JSONRPCRequest, dependencies: HandlerDependencies): JSONRPCResponse {
  const { prompts, protocolVersion } = dependencies
  const result: ListPromptsResult = {
    prompts: Array.from(prompts.values()).map(p => trimDefinitionToRevision(p.definition, protocolVersion)),
    nextCursor: undefined
  }
  return createResponse(request.id, result)
}

async function handleToolsCall (
  request: JSONRPCRequest,
  sessionId: string | undefined,
  dependencies: HandlerDependencies
): Promise<JSONRPCResponse | JSONRPCError> {
  const { tools } = dependencies

  // Validate the request parameters structure
  const paramsValidation = validate(CallToolRequestSchema, request.params)
  if (!paramsValidation.success) {
    return createError(request.id, INVALID_PARAMS, 'Invalid tool call parameters', {
      validation: paramsValidation.error
    })
  }

  const params = paramsValidation.data
  const toolName = params.name

  const tool = tools.get(toolName)
  if (!tool) {
    return createError(request.id, METHOD_NOT_FOUND, `Tool '${toolName}' not found`)
  }

  // Decide up front whether this call runs as a task, so the rest of the
  // handler can stay unaware of it.
  // A client on an older revision cannot have meant `task`, because we never
  // declared the capability to it. The spec says to ignore it in that case.
  const taskParams = supportsTasks(dependencies.protocolVersion)
    ? (request.params as { task?: { ttl?: number } } | undefined)?.task
    : undefined
  const augmentation = resolveTaskAugmentation(tool, taskParams !== undefined)
  if ('error' in augmentation) {
    return createError(request.id, METHOD_NOT_FOUND, augmentation.error)
  }
  if (augmentation.mode === 'task') {
    return await runToolCallAsTask(
      request,
      taskParams?.ttl,
      () => executeToolCall(request, tool, params, sessionId, dependencies),
      dependencies
    )
  }

  return await executeToolCall(request, tool, params, sessionId, dependencies)
}

async function executeToolCall (
  request: JSONRPCRequest,
  tool: MCPTool,
  params: { name: string, arguments?: Record<string, unknown> },
  sessionId: string | undefined,
  dependencies: HandlerDependencies
): Promise<JSONRPCResponse | JSONRPCError> {
  const toolName = params.name

  if (!tool.handler) {
    const result: CallToolResult = {
      content: [{
        type: 'text',
        text: `Tool '${toolName}' has no handler implementation`
      }],
      isError: true
    }
    return createResponse(request.id, result)
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
  let toolArguments = params.arguments || {}

  try {
    // Sanitize arguments to prevent injection attacks
    toolArguments = sanitizeToolParams(toolArguments)
  } catch (sanitizeError) {
    dependencies.app.log.warn({
      tool: toolName,
      sessionId,
      error: sanitizeError instanceof Error ? sanitizeError.message : 'Unknown sanitization error'
    }, 'Tool arguments sanitization failed')

    // SEP-1303: input validation failures are tool execution errors, not protocol
    // errors, so the model gets a chance to correct itself.
    const result: CallToolResult = {
      content: [{
        type: 'text',
        text: `${SECURITY_WARNINGS.UNVALIDATED_INPUT}: ${sanitizeError instanceof Error ? sanitizeError.message : 'Sanitization failed'}`
      }],
      isError: true
    }
    return createResponse(request.id, result)
  }
  if ('inputSchema' in tool.definition) {
    // Check if it's a TypeBox schema
    const schema = tool.definition.inputSchema
    if (isTypeBoxSchema(schema)) {
      // TypeBox schema - use our validation
      const argumentsValidation = validate(schema, toolArguments)
      if (!argumentsValidation.success) {
        const result: CallToolResult = {
          content: [{
            type: 'text',
            text: `Invalid tool arguments: ${argumentsValidation.error.message}`
          }],
          isError: true
        }
        return createResponse(request.id, result)
      }

      // Use validated arguments
      try {
        const result = await tool.handler(argumentsValidation.data, { sessionId, request: dependencies.request, reply: dependencies.reply, authContext: dependencies.authContext })
        return createResponse(request.id, result)
      } catch (error: any) {
        const result: CallToolResult = {
          content: [{
            type: 'text',
            text: `Tool execution failed: ${error.message || error}`
          }],
          isError: true
        }
        return createResponse(request.id, result)
      }
    } else {
      // Regular JSON Schema - basic validation or pass through
      try {
        const result = await tool.handler(toolArguments, { sessionId, request: dependencies.request, reply: dependencies.reply, authContext: dependencies.authContext })
        return createResponse(request.id, result)
      } catch (error: any) {
        const result: CallToolResult = {
          content: [{
            type: 'text',
            text: `Tool execution failed: ${error.message || error}`
          }],
          isError: true
        }
        return createResponse(request.id, result)
      }
    }
  } else {
    // Unsafe tool without schema - pass arguments as-is
    try {
      const result = await tool.handler(toolArguments, {
        sessionId,
        request: dependencies.request,
        reply: dependencies.reply,
        authContext: dependencies.authContext
      })
      return createResponse(request.id, result)
    } catch (error: any) {
      const result: CallToolResult = {
        content: [{
          type: 'text',
          text: `Tool execution failed: ${error.message || error}`
        }],
        isError: true
      }
      return createResponse(request.id, result)
    }
  }
}

async function handleResourcesRead (
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

  if (!resource) {
    return createError(request.id, METHOD_NOT_FOUND, `Resource '${uri}' not found`)
  }

  if (!resource.handler) {
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
        const result: ReadResourceResult = {
          contents: [{
            uri,
            text: `Invalid resource URI: ${uriValidation.error.message}`,
            mimeType: 'text/plain'
          }]
        }
        return createResponse(request.id, result)
      }
    }
  }

  try {
    const result = await resource.handler(uri, {
      sessionId,
      request: dependencies.request,
      reply: dependencies.reply,
      authContext: dependencies.authContext
    })
    return createResponse(request.id, result)
  } catch (error: any) {
    const result: ReadResourceResult = {
      contents: [{
        uri,
        text: `Resource read failed: ${error.message || error}`,
        mimeType: 'text/plain'
      }]
    }
    return createResponse(request.id, result)
  }
}

async function handlePromptsGet (
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
    return createError(request.id, METHOD_NOT_FOUND, `Prompt '${promptName}' not found`)
  }

  if (!prompt.handler) {
    const result: GetPromptResult = {
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Prompt '${promptName}' has no handler implementation`
        }
      }]
    }
    return createResponse(request.id, result)
  }

  // Validate prompt arguments against the prompt's argument schema
  const promptArguments = params.arguments || {}
  if ('argumentSchema' in prompt.definition && prompt.definition.argumentSchema) {
    // Check if it's a TypeBox schema
    const schema = prompt.definition.argumentSchema
    if (isTypeBoxSchema(schema)) {
      // TypeBox schema - use our validation
      const argumentsValidation = validate(schema, promptArguments)
      if (!argumentsValidation.success) {
        const result: GetPromptResult = {
          messages: [{
            role: 'user',
            content: {
              type: 'text',
              text: `Invalid prompt arguments: ${argumentsValidation.error.message}`
            }
          }]
        }
        return createResponse(request.id, result)
      }

      // Use validated arguments
      try {
        const result = await prompt.handler(promptName, argumentsValidation.data, {
          sessionId,
          request: dependencies.request,
          reply: dependencies.reply,
          authContext: dependencies.authContext
        })
        return createResponse(request.id, result)
      } catch (error: any) {
        const result: GetPromptResult = {
          messages: [{
            role: 'user',
            content: {
              type: 'text',
              text: `Prompt execution failed: ${error.message || error}`
            }
          }]
        }
        return createResponse(request.id, result)
      }
    } else {
      // Regular JSON Schema - basic validation or pass through
      try {
        const result = await prompt.handler(promptName, promptArguments, {
          sessionId,
          request: dependencies.request,
          reply: dependencies.reply,
          authContext: dependencies.authContext
        })
        return createResponse(request.id, result)
      } catch (error: any) {
        const result: GetPromptResult = {
          messages: [{
            role: 'user',
            content: {
              type: 'text',
              text: `Prompt execution failed: ${error.message || error}`
            }
          }]
        }
        return createResponse(request.id, result)
      }
    }
  } else {
    // Unsafe prompt without schema - pass arguments as-is
    try {
      const result = await prompt.handler(promptName, promptArguments, {
        sessionId,
        request: dependencies.request,
        reply: dependencies.reply,
        authContext: dependencies.authContext
      })
      return createResponse(request.id, result)
    } catch (error: any) {
      const result: GetPromptResult = {
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: `Prompt execution failed: ${error.message || error}`
          }
        }]
      }
      return createResponse(request.id, result)
    }
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
 * The authorization subject a task belongs to.
 *
 * When the deployment cannot identify requestors this is undefined, and tasks
 * are reachable by anyone holding the (cryptographically random) task id. That
 * limitation is why `tasks/list` is only advertised when auth is in play.
 */
function taskSubject (dependencies: HandlerDependencies): string | undefined {
  return dependencies.authContext?.userId
}

/**
 * Enforce task isolation: a requestor may only touch its own tasks.
 * Returns an "invalid params" error rather than a distinct "forbidden" code so
 * that probing for task ids cannot distinguish existence from ownership.
 */
function assertTaskAccess (task: TaskRecord | null, dependencies: HandlerDependencies): TaskRecord | null {
  if (!task) return null
  if (task.authSubject !== taskSubject(dependencies)) return null
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

function newTaskRecord (method: string, ttl: number | undefined, subject: string | undefined): TaskRecord {
  const now = new Date().toISOString()
  const requested = ttl ?? DEFAULT_TASK_TTL
  return {
    taskId: randomUUID(),
    status: 'working',
    createdAt: now,
    lastUpdatedAt: now,
    // Receivers may override the requested ttl; we cap it
    ttl: Math.min(requested, MAX_TASK_TTL),
    pollInterval: DEFAULT_POLL_INTERVAL,
    method,
    authSubject: subject
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

  const task = assertTaskAccess(await taskStore.get(taskId), dependencies)
  if (!task) {
    return createError(request.id, INVALID_PARAMS, 'Failed to retrieve task: Task not found')
  }

  return createResponse(request.id, toWireTask(task))
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

  let task = assertTaskAccess(await taskStore.get(taskId), dependencies)
  if (!task) {
    return createError(request.id, INVALID_PARAMS, 'Failed to retrieve task: Task not found')
  }

  // `tasks/result` blocks until the task is terminal. Works across instances:
  // see awaitTaskTerminal.
  if (!isTerminal(task.status)) {
    const controller = new AbortController()
    dependencies.request.raw.on('close', () => controller.abort())
    try {
      const settled = await awaitTaskTerminal(taskId, task, dependencies, controller.signal)
      if (!settled) {
        return createError(request.id, INVALID_PARAMS, 'Failed to retrieve task: Task not found')
      }
      task = settled
    } catch {
      return createError(request.id, INTERNAL_ERROR, 'Client disconnected while awaiting task result')
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

  const tasks = await taskStore.list(taskSubject(dependencies))
  const result: ListTasksResult = {
    tasks: tasks.map(toWireTask),
    nextCursor: undefined
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

  const cancelled = await taskStore.updateStatus(taskId, 'cancelled', {
    statusMessage: 'The task was cancelled by request.',
    outcome: createError(request.id, INTERNAL_ERROR, 'Task was cancelled')
  })

  if (!cancelled) {
    return createError(request.id, INVALID_PARAMS, 'Failed to retrieve task: Task not found')
  }

  dependencies.taskWaiters?.notify(cancelled)
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
  execute: () => Promise<JSONRPCResponse | JSONRPCError>,
  dependencies: HandlerDependencies
): Promise<JSONRPCResponse | JSONRPCError> {
  const { taskStore, taskWaiters, app } = dependencies
  if (!taskStore) {
    return createError(request.id, METHOD_NOT_FOUND, 'Tasks are not enabled on this server')
  }

  const task = newTaskRecord('tools/call', ttl, taskSubject(dependencies))
  await taskStore.create(task)

  // Deliberately not awaited: the point of a task is to return control now.
  const execution = (async () => {
    let outcome: TaskRecord['outcome']
    let status: 'completed' | 'failed' = 'completed'
    let statusMessage: string | undefined

    try {
      const result = await execute()
      outcome = result
      // A tool result carrying isError counts as a failed task
      if ('result' in result && (result.result as CallToolResult)?.isError === true) {
        status = 'failed'
        statusMessage = 'Tool execution reported an error'
      } else if ('error' in result) {
        status = 'failed'
        statusMessage = result.error.message
      }
    } catch (error: any) {
      status = 'failed'
      statusMessage = `Tool execution failed: ${error?.message || error}`
      outcome = createError(request.id, INTERNAL_ERROR, statusMessage)
    }

    try {
      const updated = await taskStore.updateStatus(task.taskId, status, { statusMessage, outcome })
      if (updated) {
        taskWaiters?.notify(updated)
        await notifyTaskStatus(updated, dependencies)
      }
    } catch (error) {
      // The task was cancelled or expired while the tool was still running
      app.log.debug({ err: error, taskId: task.taskId }, 'Could not record task outcome')
    }
  })()

  // Nothing awaits `execution`; keep an explicit rejection guard so an
  // unexpected throw can never become an unhandled rejection.
  execution.catch((error) => {
    app.log.error({ err: error, taskId: task.taskId }, 'Task execution failed unexpectedly')
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
    const result = await resourceHandlers.subscribeHandler(params, {
      sessionId,
      request: dependencies.request,
      reply: dependencies.reply,
      authContext: dependencies.authContext
    })
    return createResponse(request.id, result)
  } catch (error: any) {
    return createError(request.id, INTERNAL_ERROR, `Subscribe failed: ${error.message || error}`)
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
    const result = await resourceHandlers.unsubscribeHandler(params, {
      sessionId,
      request: dependencies.request,
      reply: dependencies.reply,
      authContext: dependencies.authContext
    })
    return createResponse(request.id, result)
  } catch (error: any) {
    return createError(request.id, INTERNAL_ERROR, `Unsubscribe failed: ${error.message || error}`)
  }
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
    switch (request.method) {
      case 'initialize':
        return await handleInitialize(request, sessionId, dependencies)
      case 'ping':
        return handlePing(request)
      case 'tools/list':
        return handleToolsList(request, dependencies)
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
  } catch (error) {
    return createError(request.id, INTERNAL_ERROR, 'Internal server error', error)
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

export async function processMessage (
  message: JSONRPCMessage,
  sessionId: string | undefined,
  dependencies: HandlerDependencies
): Promise<JSONRPCResponse | JSONRPCError | null> {
  if ('id' in message && 'method' in message) {
    return await handleRequest(message as JSONRPCRequest, sessionId, dependencies)
  } else if ('method' in message) {
    handleNotification(message as JSONRPCNotification, dependencies.app)
    return null
  } else {
    throw new Error('Invalid JSON-RPC message')
  }
}
