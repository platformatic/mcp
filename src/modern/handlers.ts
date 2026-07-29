/**
 * Request dispatch for the 2026-07-28 revision.
 *
 * The business logic — looking a tool up, validating arguments, running the
 * handler — is shared with the legacy path; what differs is the envelope. Every
 * result here carries `resultType`, servers identify themselves in `_meta`,
 * cacheable operations carry freshness hints, and anything the server needs
 * from the client comes back as an `InputRequiredResult` instead of a
 * server-initiated request on a stream.
 */

import { randomUUID } from 'node:crypto'
import type {
  JSONRPCRequest,
  JSONRPCResponse,
  JSONRPCError,
  Implementation
} from '../schema.ts'
import {
  INVALID_PARAMS,
  INTERNAL_ERROR,
  METHOD_NOT_FOUND,
  HEADER_MISMATCH,
  MISSING_REQUIRED_CLIENT_CAPABILITY,
  UNSUPPORTED_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS
} from '../schema.ts'
import type {
  CacheableResult,
  DiscoverResult,
  InputRequests,
  InputRequiredResult,
  Result,
  ServerCapabilities,
  Task,
  TaskStatus
} from '../schema-2026.ts'
import { META_SERVER_INFO, TASKS_EXTENSION } from '../schema-2026.ts'
import type { HandlerDependencies } from '../handlers.ts'
import {
  createError,
  createResponse,
  executeToolCall,
  handleToolsList,
  handleResourcesList,
  handleResourceTemplatesList,
  handlePromptsList,
  handleResourcesRead,
  handlePromptsGet
} from '../handlers.ts'
import type { RequestContext } from './request-meta.ts'
import { supportsTasksExtension } from './request-meta.ts'
import { InputRequired, requiredCapabilityFor } from './input-required.ts'
import type { RequestStateSealer } from './request-state.ts'
import { validateToolParamHeaders } from './headers.ts'
import type { TaskRecord } from '../stores/task-store.ts'
import { isTerminal } from '../stores/task-store.ts'

/** Freshness hints applied to one cacheable operation. */
export interface CacheHint {
  ttlMs: number
  cacheScope: 'public' | 'private'
}

export interface CachingConfig {
  discover: CacheHint
  toolsList: CacheHint
  promptsList: CacheHint
  resourcesList: CacheHint
  resourceTemplatesList: CacheHint
  resourcesRead: CacheHint
}

export interface ModernDependencies extends HandlerDependencies {
  context: RequestContext
  sealer: RequestStateSealer
  caching: CachingConfig
  /** Advertised on `server/discover` and in version errors. */
  supportedVersions: readonly string[]
  enableTasks: boolean
}

/**
 * Methods this revision removed. Answering `-32601` (rather than silently
 * doing something) is what lets a dual-era client tell a modern server from a
 * legacy one.
 */
const REMOVED_METHODS = new Set([
  'initialize',
  'ping',
  'logging/setLevel',
  'resources/subscribe',
  'resources/unsubscribe',
  'tasks/list',
  'tasks/result'
])

/** Stamp the envelope fields every modern result carries. */
function complete<T extends Record<string, unknown>> (
  body: T,
  serverInfo: Implementation | undefined
): Result {
  const result: Result = { resultType: 'complete', ...body }
  if (serverInfo) {
    result._meta = { ...(result._meta ?? {}), [META_SERVER_INFO]: serverInfo }
  }
  return result
}

function withCache<T extends Record<string, unknown>> (
  body: T,
  hint: CacheHint,
  serverInfo: Implementation | undefined
): CacheableResult {
  return {
    ...complete(body, serverInfo),
    ttlMs: Math.max(0, hint.ttlMs),
    cacheScope: hint.cacheScope
  } as CacheableResult
}

/**
 * Rewrap a legacy handler's response in the modern envelope.
 *
 * The legacy path answers "not found" for tools, resources and prompts with
 * `-32601`; this revision requires `-32602` for all three, so remap rather than
 * duplicate the lookups.
 */
function adapt (
  response: JSONRPCResponse | JSONRPCError,
  serverInfo: Implementation | undefined,
  hint?: CacheHint
): JSONRPCResponse | JSONRPCError {
  if ('error' in response) {
    if (response.error.code === METHOD_NOT_FOUND) {
      return createError(response.id ?? null, INVALID_PARAMS, response.error.message, response.error.data)
    }
    return response
  }

  const body = (response.result ?? {}) as Record<string, unknown>
  return createResponse(
    response.id,
    hint ? withCache(body, hint, serverInfo) : complete(body, serverInfo)
  )
}

function unsupportedVersion (id: JSONRPCRequest['id'], requested: string, supported: readonly string[]): JSONRPCError {
  return createError(
    id,
    UNSUPPORTED_PROTOCOL_VERSION,
    'Unsupported protocol version',
    { supported: [...supported], requested }
  )
}

function missingCapability (
  id: JSONRPCRequest['id'],
  requiredCapabilities: Record<string, unknown>
): JSONRPCError {
  return createError(
    id,
    MISSING_REQUIRED_CLIENT_CAPABILITY,
    'The request requires a client capability that was not declared',
    { requiredCapabilities }
  )
}

/**
 * Turn a handler's {@link InputRequired} into the wire result.
 *
 * The state is sealed here rather than by the handler so that integrity,
 * expiry and principal binding cannot be forgotten at a call site.
 */
function inputRequired (
  request: JSONRPCRequest,
  thrown: InputRequired,
  dependencies: ModernDependencies
): JSONRPCResponse | JSONRPCError {
  const { context, sealer, serverInfo, authContext } = dependencies

  if (thrown.inputRequests) {
    // Never ask for something the client did not declare it can do.
    const missing: Record<string, unknown> = {}
    for (const entry of Object.values(thrown.inputRequests)) {
      const needed = requiredCapabilityFor(entry as { method?: string })
      if (needed && context.clientCapabilities[needed] === undefined) {
        missing[needed] = {}
      }
    }
    if (Object.keys(missing).length > 0) {
      return missingCapability(request.id, missing)
    }
  }

  const result: InputRequiredResult = {
    resultType: 'input_required',
    ...(thrown.inputRequests ? { inputRequests: thrown.inputRequests } : {}),
    requestState: sealer.seal({
      principal: authContext?.userId,
      method: request.method,
      params: request.params,
      payload: thrown.state ?? null
    })
  }

  if (serverInfo) {
    result._meta = { [META_SERVER_INFO]: serverInfo }
  }

  return createResponse(request.id, result)
}

/**
 * Open the `requestState` a client echoed back, if any.
 *
 * Failing verification is reported as invalid params: the state is either
 * forged, stale, or belongs to a different caller or request, and in every case
 * the right move is for the client to start the exchange again.
 */
function openRequestState (
  request: JSONRPCRequest,
  dependencies: ModernDependencies
): { ok: true, payload: unknown } | { ok: false, error: JSONRPCError } {
  const state = (request.params as { requestState?: unknown } | undefined)?.requestState
  if (state === undefined) return { ok: true, payload: undefined }

  if (typeof state !== 'string') {
    return { ok: false, error: createError(request.id, INVALID_PARAMS, 'Invalid "requestState": expected a string') }
  }

  const opened = dependencies.sealer.open(state, {
    principal: dependencies.authContext?.userId,
    method: request.method,
    params: request.params
  })

  if (!opened.ok) {
    dependencies.app.log.warn({ reason: opened.reason, method: request.method }, 'Rejected MRTR request state')
    return { ok: false, error: createError(request.id, INVALID_PARAMS, `Invalid "requestState": ${opened.reason}`) }
  }

  return { ok: true, payload: opened.claims.payload }
}

/**
 * Attach the MRTR fields so handlers see them on their context.
 *
 * `inputResponses` comes off the JSON-RPC params, not the HTTP request — the
 * two are easy to confuse here because `dependencies.request` is the Fastify
 * one.
 */
function withMrtrContext (
  request: JSONRPCRequest,
  dependencies: ModernDependencies,
  payload: unknown
): ModernDependencies {
  const params = request.params as { inputResponses?: Record<string, unknown> } | undefined
  return {
    ...dependencies,
    mrtr: {
      inputResponses: params?.inputResponses,
      requestState: payload
    }
  }
}

/* ------------------------------------------------------------------ */
/* Tasks extension                                                     */
/* ------------------------------------------------------------------ */

const DEFAULT_POLL_INTERVAL_MS = 1000

/**
 * How many times a task's handler may come back asking for more input before we
 * give up on it. Bounded so a handler that keeps asking cannot pin the task for
 * its whole ttl.
 */
const MAX_TASK_INPUT_ROUNDS = 8

/** Project a stored record onto the extension's wire `Task`. */
function toExtensionTask (record: TaskRecord): Task {
  return {
    taskId: record.taskId,
    status: record.status as TaskStatus,
    ...(record.statusMessage !== undefined ? { statusMessage: record.statusMessage } : {}),
    createdAt: record.createdAt,
    lastUpdatedAt: record.lastUpdatedAt,
    ttlMs: record.ttl ?? null,
    pollIntervalMs: record.pollInterval ?? DEFAULT_POLL_INTERVAL_MS
  }
}

/**
 * The full task state `tasks/get` returns, with the status-specific payload
 * inlined. The 2025-11-25 split between `tasks/get` and a blocking
 * `tasks/result` is gone: everything a poller needs is in one response.
 */
function toDetailedTask (record: TaskRecord): Record<string, unknown> {
  const task: Record<string, unknown> = { ...toExtensionTask(record) }

  switch (record.status) {
    case 'input_required':
      task.inputRequests = record.inputRequests ?? {}
      break
    case 'completed':
      task.result = record.outcome && 'result' in record.outcome ? record.outcome.result : {}
      break
    case 'failed':
      task.error = record.outcome && 'error' in record.outcome
        ? record.outcome.error
        : { code: INTERNAL_ERROR, message: record.statusMessage ?? 'Task failed' }
      break
  }

  return task
}

/**
 * A task is reachable only by the subject that created it, when the deployment
 * can identify subjects at all. Without authorization the random task id is the
 * capability, which is why we never enumerate tasks.
 */
function taskVisibleTo (record: TaskRecord | null, dependencies: ModernDependencies): TaskRecord | null {
  if (!record) return null
  if (dependencies.opts.authorization?.enabled !== true) return record

  const subject = dependencies.authContext?.userId
  if (subject === undefined || record.authSubject !== subject) return null
  return record
}

async function handleTasksGet (
  request: JSONRPCRequest,
  dependencies: ModernDependencies
): Promise<JSONRPCResponse | JSONRPCError> {
  const taskId = (request.params as { taskId?: unknown } | undefined)?.taskId
  if (typeof taskId !== 'string') {
    return createError(request.id, INVALID_PARAMS, 'Invalid "taskId": expected a string')
  }

  const record = taskVisibleTo(await dependencies.taskStore!.get(taskId), dependencies)
  if (!record) {
    return createError(request.id, INVALID_PARAMS, `Task '${taskId}' not found`)
  }

  return createResponse(request.id, complete(toDetailedTask(record), dependencies.serverInfo))
}

async function handleTasksUpdate (
  request: JSONRPCRequest,
  dependencies: ModernDependencies
): Promise<JSONRPCResponse | JSONRPCError> {
  const params = request.params as { taskId?: unknown, inputResponses?: unknown } | undefined
  if (typeof params?.taskId !== 'string') {
    return createError(request.id, INVALID_PARAMS, 'Invalid "taskId": expected a string')
  }
  if (!params.inputResponses || typeof params.inputResponses !== 'object' || Array.isArray(params.inputResponses)) {
    return createError(request.id, INVALID_PARAMS, 'Invalid "inputResponses": expected an object')
  }

  const record = taskVisibleTo(await dependencies.taskStore!.get(params.taskId), dependencies)
  if (!record) {
    return createError(request.id, INVALID_PARAMS, `Task '${params.taskId}' not found`)
  }

  const responses = params.inputResponses as Record<string, unknown>
  const outstanding = record.inputRequests ?? {}
  const answered = new Set(record.answeredInputKeys ?? [])

  // Responses for keys we never issued, or already satisfied, are ignored
  // rather than rejected — the spec makes this explicit so a client retrying a
  // partially-delivered update cannot get stuck.
  const accepted: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(responses)) {
    if (key in outstanding && !answered.has(key)) {
      accepted[key] = value
    }
  }

  if (Object.keys(accepted).length > 0) {
    dependencies.app.log.debug({
      taskId: params.taskId,
      keys: Object.keys(accepted)
    }, 'Accepted task input responses')

    const remaining = Object.fromEntries(
      Object.entries(outstanding).filter(([key]) => !(key in accepted))
    )

    await dependencies.taskStore!.updateStatus(params.taskId, record.status, {
      inputRequests: Object.keys(remaining).length > 0 ? remaining : null,
      answeredInputKeys: Object.keys(accepted)
    })

    dependencies.taskInputs?.deliver(params.taskId, accepted)
  }

  return createResponse(request.id, complete({}, dependencies.serverInfo))
}

async function handleTasksCancel (
  request: JSONRPCRequest,
  dependencies: ModernDependencies
): Promise<JSONRPCResponse | JSONRPCError> {
  const taskId = (request.params as { taskId?: unknown } | undefined)?.taskId
  if (typeof taskId !== 'string') {
    return createError(request.id, INVALID_PARAMS, 'Invalid "taskId": expected a string')
  }

  const record = taskVisibleTo(await dependencies.taskStore!.get(taskId), dependencies)
  if (!record) {
    return createError(request.id, INVALID_PARAMS, `Task '${taskId}' not found`)
  }

  // Cancellation is cooperative: acknowledge the intent, and only move the task
  // if it has not already settled. A task that finished first stays finished.
  if (!isTerminal(record.status)) {
    try {
      const cancelled = await dependencies.taskStore!.updateStatus(taskId, 'cancelled', {
        statusMessage: 'Cancelled by the requestor'
      })
      if (cancelled) {
        dependencies.taskWaiters?.notify(cancelled)
      }
    } catch (error) {
      dependencies.app.log.debug({ err: error, taskId }, 'Task settled before cancellation took effect')
    }
  }

  return createResponse(request.id, complete({}, dependencies.serverInfo))
}

/**
 * Run a tool call as a task and answer immediately with a `CreateTaskResult`.
 *
 * The task is created before we respond, so the `tasks/get` the client makes
 * next always resolves.
 */
async function runAsTask (
  request: JSONRPCRequest,
  execute: (inputResponses?: Record<string, unknown>) => Promise<JSONRPCResponse | JSONRPCError>,
  dependencies: ModernDependencies
): Promise<JSONRPCResponse | JSONRPCError> {
  const { taskStore, taskWaiters, taskInputs, app, opts } = dependencies

  const now = new Date().toISOString()
  const ttl = Math.min(opts.taskDefaultTtlMs ?? 60_000, opts.taskMaxTtlMs ?? 3600_000)
  const record: TaskRecord = {
    taskId: randomUUID(),
    status: 'working',
    createdAt: now,
    lastUpdatedAt: now,
    ttl,
    pollInterval: DEFAULT_POLL_INTERVAL_MS,
    method: request.method,
    authSubject: dependencies.authContext?.userId
  }

  await taskStore!.create(record)

  const execution = (async () => {
    let outcome: TaskRecord['outcome']
    let status: 'completed' | 'failed' = 'completed'
    let statusMessage: string | undefined

    // Answers gathered so far. A handler may ask more than once, so responses
    // accumulate across rounds rather than replacing each other.
    let gathered: Record<string, unknown> | undefined

    // Bound the number of rounds: a handler that asks for the same thing
    // forever would otherwise pin the task until its ttl elapses.
    for (let round = 0; round <= MAX_TASK_INPUT_ROUNDS; round++) {
      try {
        const response = await execute(gathered)
        outcome = response
        if ('error' in response) {
          status = 'failed'
          statusMessage = response.error.message
        }
        break
      } catch (error: any) {
        // The handler cannot continue without something from the client. Park
        // the task in `input_required` and let `tasks/update` deliver it —
        // this is the extension's equivalent of an `InputRequiredResult`.
        if (error instanceof InputRequired && error.inputRequests && taskInputs && round < MAX_TASK_INPUT_ROUNDS) {
          try {
            const parked = await taskStore!.updateStatus(record.taskId, 'input_required', {
              statusMessage: error.message,
              inputRequests: error.inputRequests as Record<string, unknown>
            })
            if (parked) taskWaiters?.notify(parked)

            const responses = await taskInputs.wait(record.taskId, AbortSignal.timeout(ttl))
            gathered = { ...(gathered ?? {}), ...responses }

            await taskStore!.updateStatus(record.taskId, 'working')
            continue
          } catch (waitError) {
            // Cancelled, expired, or the wait timed out.
            status = 'failed'
            statusMessage = 'Timed out waiting for client input'
            outcome = createError(request.id, INTERNAL_ERROR, statusMessage)
            app.log.debug({ err: waitError, taskId: record.taskId }, 'Task input wait ended without responses')
            break
          }
        }

        status = 'failed'
        statusMessage = `Tool execution failed: ${error?.message ?? error}`
        outcome = createError(request.id, INTERNAL_ERROR, statusMessage)
        break
      }
    }

    try {
      const updated = await taskStore!.updateStatus(record.taskId, status, { statusMessage, outcome, inputRequests: null })
      if (updated) taskWaiters?.notify(updated)
    } catch (error) {
      app.log.debug({ err: error, taskId: record.taskId }, 'Could not record task outcome')
    }
  })()

  execution.catch((error) => {
    app.log.error({ err: error, taskId: record.taskId }, 'Task execution failed unexpectedly')
  })

  const result: Result = {
    resultType: 'task',
    ...toExtensionTask(record)
  }
  if (dependencies.serverInfo) {
    result._meta = { [META_SERVER_INFO]: dependencies.serverInfo }
  }

  return createResponse(request.id, result)
}

/* ------------------------------------------------------------------ */
/* tools/call                                                          */
/* ------------------------------------------------------------------ */

async function modernToolsCall (
  request: JSONRPCRequest,
  dependencies: ModernDependencies
): Promise<JSONRPCResponse | JSONRPCError> {
  const params = request.params as { name?: unknown, arguments?: unknown } | undefined
  if (typeof params?.name !== 'string') {
    return createError(request.id, INVALID_PARAMS, 'Invalid tool call parameters: "name" is required')
  }

  const tool = dependencies.tools.get(params.name)
  if (!tool) {
    return createError(request.id, INVALID_PARAMS, `Unknown tool: ${params.name}`)
  }

  // Any parameter the tool mirrors into a header must agree with the body.
  if ('inputSchema' in tool.definition) {
    const headerCheck = validateToolParamHeaders(
      dependencies.request.headers,
      tool.definition.inputSchema,
      params.arguments
    )
    if (!headerCheck.ok) {
      return createError(request.id, HEADER_MISMATCH, headerCheck.message)
    }
  }

  const taskSupport = (tool.definition as any).execution?.taskSupport ?? 'forbidden'
  const clientHasTasks = supportsTasksExtension(dependencies.context.clientCapabilities)
  const tasksAvailable = dependencies.enableTasks && dependencies.taskStore !== undefined

  if (taskSupport === 'required') {
    if (!tasksAvailable) {
      return createError(request.id, INVALID_PARAMS, `Tool '${params.name}' requires task-augmented execution, which is not enabled`)
    }
    if (!clientHasTasks) {
      return missingCapability(request.id, { extensions: { [TASKS_EXTENSION]: {} } })
    }
  }

  const run = (inputResponses?: Record<string, unknown>) => executeToolCall(
    request,
    tool,
    { name: params.name as string, arguments: params.arguments as Record<string, unknown> | undefined },
    undefined,
    // On a task's later rounds the answers come from `tasks/update`, not from
    // the original request, so the handler context is rebuilt around them.
    inputResponses
      ? { ...dependencies, mrtr: { ...dependencies.mrtr, inputResponses } }
      : dependencies
  )

  // 2026-07-28 lets the server decide: a client that declared the extension may
  // get a task handle back without having asked for one per request.
  if (tasksAvailable && clientHasTasks && taskSupport !== 'forbidden') {
    return await runAsTask(request, run, dependencies)
  }

  return adapt(await run(), dependencies.serverInfo)
}

/* ------------------------------------------------------------------ */
/* Dispatch                                                            */
/* ------------------------------------------------------------------ */

export function buildServerCapabilities (
  base: ServerCapabilities,
  options: { enableTasks: boolean }
): ServerCapabilities {
  const capabilities: ServerCapabilities = { ...base }

  // The 2025-11-25 core `tasks` capability has no meaning in this revision;
  // support is advertised as an extension instead.
  delete (capabilities as Record<string, unknown>).tasks

  if (options.enableTasks) {
    capabilities.extensions = { ...capabilities.extensions, [TASKS_EXTENSION]: {} }
  }

  return capabilities
}

function handleDiscover (
  request: JSONRPCRequest,
  dependencies: ModernDependencies
): JSONRPCResponse {
  const result: DiscoverResult = {
    ...withCache({
      supportedVersions: [...dependencies.supportedVersions],
      capabilities: buildServerCapabilities(dependencies.capabilities, {
        enableTasks: dependencies.enableTasks
      }),
      ...(dependencies.opts.instructions ? { instructions: dependencies.opts.instructions } : {})
    }, dependencies.caching.discover, dependencies.serverInfo)
  } as DiscoverResult

  return createResponse(request.id, result)
}

/**
 * Dispatch one modern request.
 *
 * `subscriptions/listen` is not handled here: it answers with a long-lived
 * stream rather than a value, so the transport owns it.
 */
export async function dispatchModern (
  request: JSONRPCRequest,
  dependencies: ModernDependencies
): Promise<JSONRPCResponse | JSONRPCError> {
  const { app, context, supportedVersions } = dependencies

  app.log.info({
    method: request.method,
    id: request.id,
    protocolVersion: context.protocolVersion,
    client: context.clientInfo?.name
  }, `MCP request: ${request.method}`)

  if (!supportedVersions.includes(context.protocolVersion)) {
    return unsupportedVersion(request.id, context.protocolVersion, supportedVersions)
  }

  if (REMOVED_METHODS.has(request.method)) {
    return createError(
      request.id,
      METHOD_NOT_FOUND,
      `Method '${request.method}' was removed in protocol version ${context.protocolVersion}`
    )
  }

  const opened = openRequestState(request, dependencies)
  if (!opened.ok) return opened.error
  const scoped = withMrtrContext(request, dependencies, opened.payload)

  try {
    switch (request.method) {
      case 'server/discover':
        return handleDiscover(request, scoped)

      case 'tools/list':
        return adapt(await handleToolsList(request, scoped), scoped.serverInfo, scoped.caching.toolsList)
      case 'resources/list':
        return adapt(handleResourcesList(request, scoped), scoped.serverInfo, scoped.caching.resourcesList)
      case 'resources/templates/list':
        return adapt(handleResourceTemplatesList(request, scoped), scoped.serverInfo, scoped.caching.resourceTemplatesList)
      case 'prompts/list':
        return adapt(handlePromptsList(request, scoped), scoped.serverInfo, scoped.caching.promptsList)

      case 'tools/call':
        return await modernToolsCall(request, scoped)
      case 'resources/read':
        return adapt(await handleResourcesRead(request, undefined, scoped), scoped.serverInfo, scoped.caching.resourcesRead)
      case 'prompts/get':
        return adapt(await handlePromptsGet(request, undefined, scoped), scoped.serverInfo)

      case 'tasks/get':
      case 'tasks/update':
      case 'tasks/cancel': {
        if (!scoped.enableTasks || !scoped.taskStore) {
          return createError(request.id, METHOD_NOT_FOUND, `Method '${request.method}' not found`)
        }
        if (!supportsTasksExtension(context.clientCapabilities)) {
          return missingCapability(request.id, { extensions: { [TASKS_EXTENSION]: {} } })
        }
        if (request.method === 'tasks/get') return await handleTasksGet(request, scoped)
        if (request.method === 'tasks/update') return await handleTasksUpdate(request, scoped)
        return await handleTasksCancel(request, scoped)
      }

      default:
        return createError(request.id, METHOD_NOT_FOUND, `Method '${request.method}' not found`)
    }
  } catch (error) {
    if (error instanceof InputRequired) {
      return inputRequired(request, error, scoped)
    }
    app.log.error({ err: error, method: request.method }, 'Unhandled error in MCP request')
    return createError(request.id, INTERNAL_ERROR, 'Internal server error')
  }
}

export type { InputRequests }
export { SUPPORTED_PROTOCOL_VERSIONS }
