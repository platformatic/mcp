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
  INVALID_REQUEST,
  INTERNAL_ERROR,
  METHOD_NOT_FOUND,
  HEADER_MISMATCH,
  MISSING_REQUIRED_CLIENT_CAPABILITY,
  UNSUPPORTED_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  MODERN_PROTOCOL_VERSIONS
} from '../schema.ts'
import type {
  CacheableResult,
  ClientCapabilities,
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
  emitToolCallComplete,
  resolveRegisteredTool,
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
import { collectHeaderParams, validateToolParamHeaders } from './headers.ts'
import type { TaskRecord, TaskStore } from '../stores/task-store.ts'
import { isTerminal } from '../stores/task-store.ts'
import { principalOf } from '../principal.ts'

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

/** The hint for a result that must not be cached at all. */
const UNCACHEABLE: CacheHint = { ttlMs: 0, cacheScope: 'private' }

export interface ModernDependencies extends HandlerDependencies {
  context: RequestContext
  sealer: RequestStateSealer
  caching: CachingConfig
  /** Advertised on `server/discover` and in version errors. */
  supportedVersions: readonly string[]
  enableTasks: boolean
  /**
   * Whether the transport mirrors body fields into headers. False for stdio,
   * which has no header layer, so there is nothing to reconcile.
   */
  headerLayer: boolean
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
  // `resultType` is the dispatcher's to set: a handler returning its own
  // would otherwise relabel the result, or forge an `input_required` that
  // skips the sealed-state path.
  const result: Result = { ...body, resultType: 'complete' }
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
function filterInvalidHeaderTools (
  response: JSONRPCResponse | JSONRPCError,
  dependencies: ModernDependencies
): JSONRPCResponse | JSONRPCError {
  if ('error' in response) return response

  const result = response.result as Record<string, unknown> | undefined
  if (!result || !Array.isArray(result.tools)) return response

  const tools = result.tools.filter((tool) => {
    if (!tool || typeof tool !== 'object' || !('inputSchema' in tool)) return true
    const collected = collectHeaderParams((tool as { inputSchema: unknown }).inputSchema)
    if (collected.ok) return true

    dependencies.app.log.warn({
      tool: (tool as { name?: unknown }).name,
      reason: collected.message
    }, 'Excluded tool with invalid x-mcp-header annotation')
    return false
  })

  if (tools.length === result.tools.length) return response
  return createResponse(response.id, { ...result, tools })
}

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
 * The client capabilities `inputRequests` would need but the client did not
 * declare, or `undefined` when it can answer all of them. The server must
 * never ask for something the client cannot do.
 */
function missingInputCapabilities (
  inputRequests: Record<string, unknown>,
  clientCapabilities: ClientCapabilities
): Record<string, Record<string, unknown>> | undefined {
  const missing: Record<string, Record<string, unknown>> = {}
  const need = (capability: string, sub?: string) => {
    const entry = missing[capability] ?? (missing[capability] = {})
    if (sub) entry[sub] = {}
  }

  for (const entry of Object.values(inputRequests)) {
    const needed = requiredCapabilityFor(entry as { method?: string })
    if (!needed) continue
    const params = (entry as { params?: Record<string, unknown> }).params ?? {}

    if (needed === 'elicitation') {
      // Form and URL mode are declared separately. An empty object is the
      // backwards-compatible way to declare form mode only, and a request
      // without `mode` is form mode.
      const declared = clientCapabilities.elicitation
      if (declared === undefined) {
        need('elicitation')
      } else if (params.mode === 'url') {
        if (declared.url === undefined) need('elicitation', 'url')
      } else if (declared.form === undefined && Object.keys(declared).length > 0) {
        need('elicitation', 'form')
      }
      continue
    }

    if (needed === 'sampling') {
      const declared = clientCapabilities.sampling
      if (declared === undefined) {
        need('sampling')
        continue
      }
      if ((params.tools !== undefined || params.toolChoice !== undefined) && declared.tools === undefined) {
        need('sampling', 'tools')
      }
      if (params.includeContext !== undefined && params.includeContext !== 'none' && declared.context === undefined) {
        need('sampling', 'context')
      }
      continue
    }

    if (clientCapabilities[needed] === undefined) need(needed)
  }
  return Object.keys(missing).length > 0 ? missing : undefined
}

/**
 * What is wrong with the `inputRequests` a handler produced, or `undefined`.
 *
 * Each entry must be an elicitation, sampling or roots request, and a URL-mode
 * elicitation must carry a valid URL. Anything else is a bug in the handler,
 * never something to forward to the client.
 */
function invalidInputRequests (inputRequests: Record<string, unknown>): string | undefined {
  for (const [key, entry] of Object.entries(inputRequests)) {
    if (!requiredCapabilityFor(entry as { method?: string })) {
      return `input request '${key}' has unsupported method '${(entry as { method?: unknown })?.method}'`
    }
    const params = (entry as { params?: { mode?: unknown, url?: unknown } }).params
    if (params?.mode === 'url' && (typeof params.url !== 'string' || !URL.canParse(params.url))) {
      return `input request '${key}' has an invalid URL`
    }
  }
  return undefined
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
    const invalid = invalidInputRequests(thrown.inputRequests)
    if (invalid) {
      dependencies.app.log.error({ method: request.method, reason: invalid }, 'Handler produced invalid input requests')
      return createError(request.id, INTERNAL_ERROR, 'Internal server error')
    }
    const missing = missingInputCapabilities(thrown.inputRequests, context.clientCapabilities)
    if (missing) return missingCapability(request.id, missing)
  }

  let requestState: string
  try {
    requestState = sealer.seal({
      principal: principalOf(authContext),
      method: request.method,
      params: request.params,
      payload: thrown.state ?? null,
      inputKeys: Object.keys(thrown.inputRequests ?? {})
    })
  } catch (error) {
    // Sealing refuses an unidentified caller when the deployment identifies
    // callers. Answer this request rather than escaping to a bare 500.
    dependencies.app.log.warn({ err: error, method: request.method }, 'Could not seal request state')
    return createError(request.id, INVALID_REQUEST, 'This request needs additional input, which requires an authenticated caller')
  }

  const result: InputRequiredResult = {
    resultType: 'input_required',
    ...(thrown.inputRequests ? { inputRequests: thrown.inputRequests } : {}),
    requestState
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
): { ok: true, payload: unknown, inputKeys?: string[] } | { ok: false, error: JSONRPCError } {
  const state = (request.params as { requestState?: unknown } | undefined)?.requestState
  if (state === undefined) return { ok: true, payload: undefined }

  if (typeof state !== 'string') {
    return { ok: false, error: createError(request.id, INVALID_PARAMS, 'Invalid "requestState": expected a string') }
  }

  const opened = dependencies.sealer.open(state, {
    principal: principalOf(dependencies.authContext),
    method: request.method,
    params: request.params
  })

  if (!opened.ok) {
    dependencies.app.log.warn({ reason: opened.reason, method: request.method }, 'Rejected MRTR request state')
    return { ok: false, error: createError(request.id, INVALID_PARAMS, `Invalid "requestState": ${opened.reason}`) }
  }

  return { ok: true, payload: opened.claims.payload, inputKeys: opened.claims.inputKeys ?? [] }
}

/**
 * Attach the MRTR fields so handlers see them on their context.
 *
 * `inputResponses` comes off the JSON-RPC params, not the HTTP request — the
 * two are easy to confuse here because `dependencies.request` is the Fastify
 * one. Only answers to keys the server actually asked for, as recorded in the
 * sealed state, reach the handler; anything else is information the server
 * does not recognise and ignores.
 */
function withMrtrContext (
  request: JSONRPCRequest,
  dependencies: ModernDependencies,
  opened: { payload: unknown, inputKeys?: string[] }
): ModernDependencies {
  const params = request.params as { inputResponses?: Record<string, unknown> } | undefined
  const asked = new Set(opened.inputKeys ?? [])
  const inputResponses = params?.inputResponses === undefined
    ? undefined
    : Object.fromEntries(Object.entries(params.inputResponses).filter(([key]) => asked.has(key)))

  return {
    ...dependencies,
    strictErrors: true,
    mrtr: {
      inputResponses,
      requestState: opened.payload
    }
  }
}

/** Is `inputResponses`, when present, an object as `InputResponses` requires? */
function invalidInputResponses (params: unknown): string | undefined {
  const value = (params as { inputResponses?: unknown } | undefined)?.inputResponses
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'Invalid "inputResponses": expected an object'
  }
  return undefined
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
 * can identify subjects at all. Without identity resolution the random task id
 * is the capability, which is why we never enumerate tasks.
 */
function taskVisibleTo (record: TaskRecord | null, dependencies: ModernDependencies): TaskRecord | null {
  if (!record) return null
  // 2025-11-25 core tasks share the store but not the protocol.
  if (record.era !== 'modern') return null
  const identifiesRequestors = dependencies.opts.authorization?.enabled === true ||
    dependencies.opts.resolveAuthorizationContext !== undefined
  if (!identifiesRequestors) return record

  const subject = principalOf(dependencies.authContext)
  if (subject === undefined || record.authSubject !== subject) return null
  return record
}

/**
 * Load a task for a `tasks/*` request, failing it first if the instance that
 * was running it has stopped renewing its lease. A crashed worker would
 * otherwise leave the task `working` until its ttl, and then just vanish.
 */
async function loadTask (taskId: string, dependencies: ModernDependencies): Promise<TaskRecord | null> {
  const store = dependencies.taskStore!
  const record = await store.get(taskId)
  if (!record || isTerminal(record.status) || record.leaseExpiresAt === undefined) return record
  const failed = await store.expireStaleLease(
    taskId,
    WORKER_LOST,
    createError(null, INTERNAL_ERROR, WORKER_LOST)
  )
  if (failed) {
    dependencies.app.log.warn({ taskId }, 'Task failed: the instance running it stopped renewing its lease')
    dependencies.taskWaiters?.notify(failed)
    return failed
  }
  return record
}

const WORKER_LOST = 'The server running this task stopped before it finished'

async function handleTasksGet (
  request: JSONRPCRequest,
  dependencies: ModernDependencies
): Promise<JSONRPCResponse | JSONRPCError> {
  const taskId = (request.params as { taskId?: unknown } | undefined)?.taskId
  if (typeof taskId !== 'string') {
    return createError(request.id, INVALID_PARAMS, 'Invalid "taskId": expected a string')
  }

  const record = taskVisibleTo(await loadTask(taskId, dependencies), dependencies)
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

  const record = taskVisibleTo(await loadTask(params.taskId, dependencies), dependencies)
  if (!record) {
    return createError(request.id, INVALID_PARAMS, `Task '${params.taskId}' not found`)
  }

  // Atomically move new answers into the store-backed publication outbox.
  // Previously this only marked keys answered, so a broker failure made the
  // values unrecoverable and a retry was silently ignored.
  const update = await dependencies.taskStore!.updateInputResponses(
    params.taskId,
    params.inputResponses as Record<string, unknown>,
    randomUUID()
  )
  if (!update) {
    return createError(request.id, INVALID_PARAMS, `Task '${params.taskId}' not found`)
  }

  const deliveries = new Map<string, Record<string, unknown>>()
  for (const [key, value] of Object.entries(update.responses)) {
    const deliveryId = update.responseIds[key]
    if (!deliveryId) throw new Error(`Task input '${key}' has no delivery id`)
    const batch = deliveries.get(deliveryId) ?? {}
    Object.defineProperty(batch, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true
    })
    deliveries.set(deliveryId, batch)
  }

  for (const [deliveryId, responses] of deliveries) {
    const keys = Object.keys(responses)
    dependencies.app.log.debug({ taskId: params.taskId, keys, deliveryId }, 'Publishing task input responses')

    // Publish the durable values but leave them in the outbox: the broker
    // accepting a message does not mean the waiting worker received it. The
    // worker acknowledges once it has the answers, and reads the outbox itself
    // if a publication goes missing. A retry republishes with the same
    // delivery id, which receivers deduplicate.
    await dependencies.taskInputs?.publish(params.taskId, responses, deliveryId)
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

  const record = taskVisibleTo(await loadTask(taskId, dependencies), dependencies)
  if (!record) {
    return createError(request.id, INVALID_PARAMS, `Task '${taskId}' not found`)
  }

  // Cancellation is cooperative: acknowledge the intent, and only move the task
  // if it has not already settled. A task that finished first stays finished.
  // A retry of an already-cancelled task republishes cancellation so a transient
  // broker failure cannot leave the owning instance parked until its ttl.
  let publishCancellation = record.status === 'cancelled'
  if (!isTerminal(record.status)) {
    try {
      const cancelled = await dependencies.taskStore!.updateStatus(taskId, 'cancelled', {
        statusMessage: 'Cancelled by the requestor',
        inputRequests: null,
        clearPendingInputResponses: true
      })
      if (cancelled) {
        dependencies.taskWaiters?.notify(cancelled)
        publishCancellation = true
      }
    } catch (error) {
      dependencies.app.log.debug({ err: error, taskId }, 'Task settled before cancellation took effect')
      // Another cancellation may have won but failed to publish. Re-read the
      // durable state so this successful retry republishes instead of silently
      // leaving the owning waiter blocked.
      const current = await dependencies.taskStore!.get(taskId)
      publishCancellation = current?.status === 'cancelled'
    }
  }
  if (publishCancellation) await dependencies.taskInputs?.cancel(taskId)

  return createResponse(request.id, complete({}, dependencies.serverInfo))
}

/** What a task's handler resumes with after an input round. */
interface TaskResume {
  inputResponses: Record<string, unknown>
  requestState: unknown
}

const DEFAULT_TASK_MAX_CONCURRENT = 1000
const DEFAULT_TASK_MAX_PER_PRINCIPAL = 100
const DEFAULT_TASK_LEASE_MS = 15_000
const TASK_SHUTDOWN_GRACE_MS = 1000
const SHUTTING_DOWN = 'The server shut down before this task finished'

/** Why a running task was stopped, recorded as its failure. */
class TaskStopped extends Error {}

interface LiveTask {
  /** Whose task it is, for the per-principal limit. Unidentified callers share ''. */
  principal: string
  stop: (reason: TaskStopped) => void
  done: Promise<void>
}

/** The background tasks one plugin instance is running, keyed by its task store. */
interface TaskRegistry {
  live: Map<string, LiveTask>
  closing: boolean
}

const registries = new WeakMap<object, TaskRegistry>()

function registryFor (store: object): TaskRegistry {
  let registry = registries.get(store)
  if (!registry) {
    registry = { live: new Map(), closing: false }
    registries.set(store, registry)
  }
  return registry
}

function sleep (ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms).unref())
}

/**
 * Stop taking new tasks and let running ones finish, for up to `timeoutMs`.
 * Whatever is still running then is aborted through its signal and recorded
 * as failed, so a restart never leaves a task `working` until its ttl.
 */
export async function drainModernTasks (store: TaskStore, timeoutMs: number): Promise<void> {
  const registry = registries.get(store)
  if (!registry) return
  registry.closing = true

  const running = () => [...registry.live.values()]
  await Promise.race([Promise.allSettled(running().map(task => task.done)), sleep(timeoutMs)])

  const remaining = [...registry.live.entries()]
  for (const [, task] of remaining) task.stop(new TaskStopped(SHUTTING_DOWN))
  await Promise.race([Promise.allSettled(remaining.map(([, task]) => task.done)), sleep(TASK_SHUTDOWN_GRACE_MS)])

  // A handler that ignores its signal is still running; record the outcome for it.
  for (const taskId of registry.live.keys()) {
    try {
      await store.updateStatus(taskId, 'failed', {
        statusMessage: SHUTTING_DOWN,
        outcome: createError(null, INTERNAL_ERROR, SHUTTING_DOWN),
        inputRequests: null,
        clearPendingInputResponses: true
      })
    } catch {
      // already terminal
    }
  }
}

/**
 * Wait until every key of a parked task's current input round is answered.
 *
 * A client may answer the outstanding requests in pieces, and resuming the
 * handler on the first piece would leave it to re-ask for the rest. So the
 * answers accumulate here until the round is complete, the task ends, or its
 * time runs out.
 */
async function awaitTaskRound (
  taskId: string,
  keys: string[],
  timeoutMs: number,
  stopped: AbortSignal,
  dependencies: ModernDependencies
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  const received: Record<string, unknown> = {}
  while (!keys.every(key => Object.hasOwn(received, key))) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('timed out waiting for client input')
    const batch = await awaitTaskInput(taskId, remaining, stopped, dependencies)
    for (const [key, value] of Object.entries(batch)) {
      Object.defineProperty(received, key, { value, enumerable: true, configurable: true, writable: true })
    }
  }
  return received
}

/**
 * Wait for the next answers to a parked task's current input round.
 *
 * The broker is the fast path, but a resolved publication only means the
 * broker took the message: it can still be lost on the way here, say while this
 * instance's subscriber is reconnecting. `tasks/update` therefore leaves the
 * answers in the task store's outbox, and this reads that outbox every poll
 * interval as well. The same read notices a task that ended while parked, so a
 * cancellation whose broker message was lost (or that came through the legacy
 * `tasks/cancel`) still releases the worker. Whichever source supplies the
 * answers, the outbox entries are acknowledged only once they are in hand.
 */
async function awaitTaskInput (
  taskId: string,
  timeoutMs: number,
  stopped: AbortSignal,
  dependencies: ModernDependencies
): Promise<Record<string, unknown>> {
  const taskStore = dependencies.taskStore!
  const taskInputs = dependencies.taskInputs!
  const settled = new AbortController()
  const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), settled.signal, stopped])

  let timer: NodeJS.Timeout | undefined
  const fromOutbox = new Promise<Record<string, unknown>>((resolve, reject) => {
    const check = async () => {
      try {
        const task = await taskStore.get(taskId)
        if (!task || isTerminal(task.status)) {
          reject(new Error('task ended while waiting for input'))
          return
        }
        const pending = currentRoundResponses(task)
        if (pending) {
          // A late broker copy of these must not reach a later round.
          for (const deliveryId of new Set(Object.values(pending.ids))) {
            taskInputs.markConsumed(taskId, deliveryId)
          }
          resolve(pending.responses)
          return
        }
      } catch (error) {
        dependencies.app.log.debug({ err: error, taskId }, 'Could not read the task input outbox')
      }
      if (!signal.aborted) timer = setTimeout(check, DEFAULT_POLL_INTERVAL_MS)
    }
    timer = setTimeout(check, DEFAULT_POLL_INTERVAL_MS)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }, { once: true })
  })

  let responses: Record<string, unknown>
  try {
    responses = await Promise.race([taskInputs.wait(taskId, signal), fromOutbox])
  } finally {
    settled.abort()
  }

  try {
    const ids = currentRoundResponses(await taskStore.get(taskId))?.ids ?? {}
    const received = Object.fromEntries(Object.keys(responses)
      .filter(key => ids[key] !== undefined)
      .map(key => [key, ids[key]]))
    await taskStore.acknowledgeInputResponses(taskId, received)
  } catch (error) {
    // The entries stay in the outbox, scoped to a round that is now over.
    dependencies.app.log.debug({ err: error, taskId }, 'Could not acknowledge task input responses')
  }

  return responses
}

/** The outbox entries answering the task's current input round, if any. */
function currentRoundResponses (
  task: TaskRecord | null
): { responses: Record<string, unknown>, ids: Record<string, string> } | undefined {
  if (!task?.pendingInputResponses) return undefined

  const round = task.inputRequestRound ?? 0
  const responses: Record<string, unknown> = {}
  const ids: Record<string, string> = {}
  for (const [key, value] of Object.entries(task.pendingInputResponses)) {
    const id = task.pendingInputResponseIds?.[key]
    if (id === undefined) continue
    if ((task.pendingInputResponseRounds?.[key] ?? round) !== round) continue
    responses[key] = value
    ids[key] = id
  }
  return Object.keys(responses).length > 0 ? { responses, ids } : undefined
}

/**
 * Give each of a handler's input requests a key not yet used on this task.
 *
 * Keys on the wire must stay unique for the task's lifetime, so a client can
 * tell a new question from a replay. A handler, though, may reasonably ask
 * again under the same key (a re-prompt after a declined answer, or an
 * MRTR-style handler re-asking for everything it still lacks), so a reused key
 * gets a fresh wire key and its answer is mapped back.
 */
function assignWireKeys (
  inputRequests: Record<string, unknown>,
  used: Set<string>
): { wire: Record<string, unknown>, handlerKeys: Map<string, string> } {
  const wire: Record<string, unknown> = {}
  const handlerKeys = new Map<string, string>()
  for (const [key, value] of Object.entries(inputRequests)) {
    let wireKey = key
    for (let attempt = 2; used.has(wireKey); attempt++) wireKey = `${key}~${attempt}`
    used.add(wireKey)
    handlerKeys.set(wireKey, key)
    Object.defineProperty(wire, wireKey, { value, enumerable: true, configurable: true, writable: true })
  }
  return { wire, handlerKeys }
}

/**
 * Run a tool call as a task and answer immediately with a `CreateTaskResult`.
 *
 * The task is created before we respond, so the `tasks/get` the client makes
 * next always resolves. Returns `undefined` when no task can be created right
 * now (the instance is at its task limit, the store is full, or the caller
 * cannot own one), leaving the caller to run the call synchronously or refuse.
 */
async function runAsTask (
  request: JSONRPCRequest,
  execute: (resume: TaskResume | undefined, signal: AbortSignal) => Promise<JSONRPCResponse | JSONRPCError>,
  dependencies: ModernDependencies
): Promise<JSONRPCResponse | JSONRPCError | undefined> {
  const { taskStore, taskWaiters, taskInputs, app, opts } = dependencies

  // When the deployment identifies callers, a task is visible only to its
  // creator. One created for an unidentified caller would be unreachable.
  const identifiesCallers = opts.authorization?.enabled === true || opts.resolveAuthorizationContext !== undefined
  if (identifiesCallers && dependencies.authContext?.userId === undefined) return undefined

  const registry = registryFor(taskStore!)
  if (registry.closing) return undefined
  const maxConcurrent = opts.taskMaxConcurrent ?? DEFAULT_TASK_MAX_CONCURRENT
  if (registry.live.size >= maxConcurrent) {
    app.log.warn({ running: registry.live.size, maxConcurrent }, 'Task limit reached; not creating another task')
    return undefined
  }
  // One caller must not be able to take every slot from everyone else.
  const principal = principalOf(dependencies.authContext) ?? ''
  const maxPerPrincipal = opts.taskMaxPerPrincipal ?? DEFAULT_TASK_MAX_PER_PRINCIPAL
  let mine = 0
  for (const task of registry.live.values()) if (task.principal === principal) mine++
  if (mine >= maxPerPrincipal) {
    app.log.warn({ running: mine, maxPerPrincipal }, 'Per-caller task limit reached; not creating another task')
    return undefined
  }

  const createdAt = Date.now()
  const now = new Date(createdAt).toISOString()
  const ttl = Math.min(opts.taskDefaultTtlMs ?? 60_000, opts.taskMaxTtlMs ?? 3600_000)
  const record: TaskRecord = {
    taskId: randomUUID(),
    status: 'working',
    createdAt: now,
    lastUpdatedAt: now,
    ttl,
    pollInterval: DEFAULT_POLL_INTERVAL_MS,
    method: request.method,
    authSubject: principalOf(dependencies.authContext),
    era: 'modern'
  }

  // A task outlives the request that created it, so its handler must not see
  // that request's disconnect. It is stopped by tasks/cancel, by its ttl, or
  // by a shutdown, and the reason becomes its recorded failure.
  const stopController = new AbortController()
  const stop = (reason: TaskStopped) => {
    if (!stopController.signal.aborted) stopController.abort(reason)
  }
  const stopped = stopController.signal
  const stopMessage = () => stopped.reason instanceof TaskStopped ? stopped.reason.message : 'Task stopped'

  // Reserve the slot before the first await, so concurrent requests cannot all
  // pass the limit check before any of them is counted.
  const live: LiveTask = { principal, stop, done: Promise.resolve() }
  registry.live.set(record.taskId, live)

  try {
    await taskStore!.create(record)
  } catch (error) {
    registry.live.delete(record.taskId)
    app.log.warn({ err: error }, 'Could not create task')
    return undefined
  }
  const expiresAt = createdAt + ttl

  // The lease lets any instance tell a crashed worker from a slow one. Each
  // renewal also reports the task's status, catching a cancellation whose
  // broker message was lost.
  const leaseMs = opts.taskLeaseMs ?? DEFAULT_TASK_LEASE_MS
  const renew = async () => {
    try {
      const current = await taskStore!.renewLease(record.taskId, leaseMs)
      if (current === null || isTerminal(current)) {
        stop(new TaskStopped(current === 'cancelled' ? 'Task cancelled' : 'Task ended'))
      }
    } catch (error) {
      app.log.debug({ err: error, taskId: record.taskId }, 'Could not renew task lease')
    }
  }
  await renew()
  const leaseTimer = setInterval(renew, Math.max(1, Math.floor(leaseMs / 3))).unref()

  // Past its ttl the task is gone for the client; stop the handler and free
  // the slot even if the handler ignores the signal.
  const ttlTimer = setTimeout(() => {
    stop(new TaskStopped('Task expired before it finished'))
    registry.live.delete(record.taskId)
  }, ttl).unref()

  const stopListening = taskInputs?.onCancel(record.taskId, () => stop(new TaskStopped('Task cancelled')))
  taskInputs?.claim(record.taskId)

  const execution = (async () => {
    let outcome: TaskRecord['outcome']
    let status: 'completed' | 'failed' = 'completed'
    let statusMessage: string | undefined

    // Answers gathered so far, keyed as the handler asked for them. A handler
    // may ask more than once, so they accumulate across rounds, and a later
    // answer to a key the handler asked again replaces the earlier one.
    let gathered: Record<string, unknown> | undefined
    // What the handler saved in `InputRequired.state` before its last round,
    // handed back as `context.requestState` exactly as an MRTR retry would.
    let state: unknown
    const usedWireKeys = new Set<string>()

    const fail = (message: string, error?: JSONRPCError) => {
      status = 'failed'
      statusMessage = message
      outcome = error ?? createError(request.id, INTERNAL_ERROR, message)
    }

    // Bound the number of rounds: a handler that asks for the same thing
    // forever would otherwise pin the task until its ttl elapses.
    for (let round = 0; round <= MAX_TASK_INPUT_ROUNDS; round++) {
      try {
        // A completed task's `result` is what the call would have returned
        // synchronously, envelope included.
        const response = adapt(
          await execute(
            (gathered || state !== undefined) ? { inputResponses: gathered ?? {}, requestState: state } : undefined,
            stopped
          ),
          dependencies.serverInfo
        )
        outcome = response
        if ('error' in response) {
          status = 'failed'
          statusMessage = response.error.message
        }
        // Whatever a stopped handler returned (often an error it caught from
        // the aborted signal), the task ends for the reason it was stopped.
        if (stopped.aborted) fail(stopMessage())
        break
      } catch (error: any) {
        if (stopped.aborted) {
          fail(stopMessage())
          break
        }
        if (!(error instanceof InputRequired) || !taskInputs || round >= MAX_TASK_INPUT_ROUNDS) {
          fail(`Tool execution failed: ${error?.message ?? error}`)
          break
        }

        // Nothing to ask the client: the handler only wants to resume with
        // its state, which a task can do at once, like an immediate MRTR retry.
        const requests = error.inputRequests ?? {}
        if (Object.keys(requests).length === 0) {
          state = error.state
          continue
        }

        const invalid = invalidInputRequests(requests)
        if (invalid) {
          app.log.error({ taskId: record.taskId, reason: invalid }, 'Task handler produced invalid input requests')
          fail('Internal server error')
          break
        }

        // Parking a request the client cannot answer would only leave the
        // task stuck in `input_required` until it expires.
        const missing = missingInputCapabilities(requests, dependencies.context.clientCapabilities)
        if (missing) {
          const refused = missingCapability(request.id, missing)
          fail(refused.error.message, refused)
          break
        }

        // The ttl bounds the task's whole lifetime, not each round.
        const remaining = expiresAt - Date.now()
        if (remaining <= 0) {
          fail('Timed out waiting for client input')
          break
        }

        const { wire, handlerKeys } = assignWireKeys(requests as Record<string, unknown>, usedWireKeys)
        try {
          const parked = await taskStore!.updateStatus(record.taskId, 'input_required', {
            statusMessage: error.message,
            inputRequests: wire,
            incrementInputRequestRound: true
          })
          if (parked) taskWaiters?.notify(parked)

          const responses = await awaitTaskRound(record.taskId, [...handlerKeys.keys()], remaining, stopped, dependencies)
          gathered = { ...(gathered ?? {}) }
          for (const [wireKey, value] of Object.entries(responses)) {
            const handlerKey = handlerKeys.get(wireKey)
            if (handlerKey === undefined) continue
            Object.defineProperty(gathered, handlerKey, { value, enumerable: true, configurable: true, writable: true })
          }
          state = error.state

          // Nothing is outstanding now, so nothing may be answered while the
          // handler runs, and the round's prompt no longer describes the task.
          await taskStore!.updateStatus(record.taskId, 'working', { inputRequests: null, statusMessage: null })
          continue
        } catch (waitError) {
          // Stopped (cancelled, expired, shutting down) or the wait timed out.
          fail(stopped.aborted ? stopMessage() : 'Timed out waiting for client input')
          app.log.debug({ err: waitError, taskId: record.taskId }, 'Task input wait ended without responses')
          break
        }
      }
    }

    try {
      const updated = await taskStore!.updateStatus(record.taskId, status, {
        statusMessage: statusMessage ?? null,
        outcome,
        inputRequests: null,
        clearPendingInputResponses: true
      })
      if (updated) taskWaiters?.notify(updated)
    } catch (error) {
      app.log.debug({ err: error, taskId: record.taskId }, 'Could not record task outcome')
    } finally {
      clearInterval(leaseTimer)
      clearTimeout(ttlTimer)
      stopListening?.()
      taskInputs?.forget(record.taskId)
    }
  })()

  live.done = execution
    .catch((error) => {
      app.log.error({ err: error, taskId: record.taskId }, 'Task execution failed unexpectedly')
    })
    .finally(() => {
      registry.live.delete(record.taskId)
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

  if (params.arguments !== undefined &&
      (!params.arguments || typeof params.arguments !== 'object' || Array.isArray(params.arguments))) {
    return createError(request.id, INVALID_PARAMS, 'Invalid tool call parameters: "arguments" must be an object')
  }

  const startedAt = performance.now()
  const args = (params.arguments ?? {}) as Record<string, unknown>

  // Resolve through the shared authorization gate. Denied and unknown tools
  // are deliberately indistinguishable so authorization cannot leak names.
  const resolved = await resolveRegisteredTool(params.name, dependencies)
  if (!resolved.ok) {
    const observed = resolved.reason === 'access-denied'
      ? { ok: false as const, reason: 'not-found' as const }
      : resolved
    await emitToolCallComplete('json-rpc', params.name, args, observed, startedAt, dependencies)
    return createError(request.id, INVALID_PARAMS, `Unknown tool: ${params.name}`)
  }
  const tool = resolved.tool

  // Any parameter the tool mirrors into a header must agree with the body.
  if ('inputSchema' in tool.definition) {
    // A malformed `x-mcp-header` annotation is the server's own bug, not a
    // client header mismatch. `tools/list` already hides such a tool, so
    // calling it looks the same as calling any other unknown tool.
    if (!collectHeaderParams(tool.definition.inputSchema).ok) {
      dependencies.app.log.warn({ tool: params.name }, 'Refusing call to tool with an invalid x-mcp-header annotation')
      await emitToolCallComplete('json-rpc', params.name, args, { ok: false, reason: 'not-found' }, startedAt, dependencies)
      return createError(request.id, INVALID_PARAMS, `Unknown tool: ${params.name}`)
    }

    const headerCheck = dependencies.headerLayer
      ? validateToolParamHeaders(dependencies.request.headers, tool.definition.inputSchema, params.arguments)
      : { ok: true as const }
    if (!headerCheck.ok) {
      await emitToolCallComplete('json-rpc', params.name, args, {
        ok: false,
        reason: 'invalid-arguments',
        detail: headerCheck.message
      }, startedAt, dependencies)
      return createError(request.id, HEADER_MISMATCH, headerCheck.message)
    }
  }

  const taskSupport = (tool.definition as any).execution?.taskSupport ?? 'forbidden'
  const clientHasTasks = supportsTasksExtension(dependencies.context.clientCapabilities)
  const tasksAvailable = dependencies.enableTasks && dependencies.taskStore !== undefined

  if (taskSupport === 'required') {
    if (!tasksAvailable) {
      await emitToolCallComplete('json-rpc', params.name, args, { ok: false, reason: 'task-required' }, startedAt, dependencies)
      return createError(request.id, INVALID_PARAMS, `Tool '${params.name}' requires task-augmented execution, which is not enabled`)
    }
    if (!clientHasTasks) {
      await emitToolCallComplete('json-rpc', params.name, args, { ok: false, reason: 'task-required' }, startedAt, dependencies)
      return missingCapability(request.id, { extensions: { [TASKS_EXTENSION]: {} } })
    }
  }

  const run = (
    resume: TaskResume | undefined,
    observation: { source: 'json-rpc' | 'task', startedAt: number },
    signal?: AbortSignal
  ) => executeToolCall(
    request,
    tool,
    { name: params.name as string, arguments: params.arguments as Record<string, unknown> | undefined },
    undefined,
    // On a task's later rounds the answers come from `tasks/update` and the
    // state from the handler's last `InputRequired`, not from the original
    // request, so the handler context is rebuilt around them. A task also
    // brings its own cancellation signal.
    {
      ...dependencies,
      ...(resume ? { mrtr: resume } : {}),
      ...(signal ? { signal } : {})
    },
    observation
  )

  // 2026-07-28 lets the server decide: a client that declared the extension may
  // get a task handle back without having asked for one per request.
  if (tasksAvailable && clientHasTasks && taskSupport !== 'forbidden') {
    const task = await runAsTask(
      request,
      (resume, signal) => run(resume, { source: 'task', startedAt: performance.now() }, signal),
      dependencies
    )
    if (task) return task
    // No task could be created right now. A tool that merely supports tasks
    // still works synchronously; one that requires a task cannot run.
    if (taskSupport === 'required') {
      await emitToolCallComplete('json-rpc', params.name, args, { ok: false, reason: 'task-required' }, startedAt, dependencies)
      return createError(request.id, INVALID_REQUEST, `Tool '${params.name}' requires a task, and none can be created for this request`)
    }
  }

  return adapt(await run(undefined, { source: 'json-rpc', startedAt }), dependencies.serverInfo)
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
  // Nothing on this path answers `completion/complete`, so advertising it
  // would be a promise the server cannot keep. `logging` stays: handlers log
  // to the request's stream through `context.log`.
  delete (capabilities as Record<string, unknown>).completions

  if (options.enableTasks) {
    capabilities.extensions = { ...capabilities.extensions, [TASKS_EXTENSION]: {} }
  }

  return capabilities
}

/** Is this the client coming back with answers to an `InputRequiredResult`? */
function isMrtrRetry (request: JSONRPCRequest): boolean {
  const params = request.params as { inputResponses?: unknown, requestState?: unknown } | undefined
  return params?.inputResponses !== undefined || params?.requestState !== undefined
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

  // A legacy revision named in `_meta` is still unsupported *here*: 2024-11-05
  // has no notion of `resultType` or caching hints, so serving it a modern
  // envelope would be worse than refusing. The error still advertises every
  // version we speak, so the client can drop back to the handshake.
  if (!MODERN_PROTOCOL_VERSIONS.includes(context.protocolVersion as never)) {
    return unsupportedVersion(request.id, context.protocolVersion, supportedVersions)
  }

  if (REMOVED_METHODS.has(request.method)) {
    return createError(
      request.id,
      METHOD_NOT_FOUND,
      `Method '${request.method}' was removed in protocol version ${context.protocolVersion}`
    )
  }

  const invalidResponses = invalidInputResponses(request.params)
  if (invalidResponses) return createError(request.id, INVALID_PARAMS, invalidResponses)

  const opened = openRequestState(request, dependencies)
  if (!opened.ok) return opened.error
  const scoped = withMrtrContext(request, dependencies, opened)

  // A result produced from `inputResponses`/`requestState` depends on inputs
  // that are not part of the cache key, so it must not be cached. Complete
  // results still must carry hints, so a retry says exactly that: stale at
  // once and never shared.
  const hint = (which: keyof CachingConfig): CacheHint =>
    isMrtrRetry(request) ? UNCACHEABLE : scoped.caching[which]

  try {
    switch (request.method) {
      case 'server/discover':
        return handleDiscover(request, scoped)

      case 'tools/list':
        return adapt(
          filterInvalidHeaderTools(await handleToolsList(request, scoped), scoped),
          scoped.serverInfo,
          hint('toolsList')
        )
      case 'resources/list':
        return adapt(handleResourcesList(request, scoped), scoped.serverInfo, hint('resourcesList'))
      case 'resources/templates/list':
        return adapt(handleResourceTemplatesList(request, scoped), scoped.serverInfo, hint('resourceTemplatesList'))
      case 'prompts/list':
        return adapt(handlePromptsList(request, scoped), scoped.serverInfo, hint('promptsList'))

      case 'tools/call':
        return await modernToolsCall(request, scoped)
      case 'resources/read':
        return adapt(await handleResourcesRead(request, undefined, scoped), scoped.serverInfo, hint('resourcesRead'))
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
