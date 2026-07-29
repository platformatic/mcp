/**
 * Types introduced or reshaped by the 2026-07-28 revision.
 *
 * Everything that survived the revision unchanged — content blocks, tool and
 * resource definitions, elicitation and sampling shapes — is re-exported from
 * {@link ./schema.ts} rather than duplicated, so there is one definition of each.
 * What lives here is what 2026-07-28 actually changed: per-request metadata in
 * place of the handshake, `resultType` on every result, caching hints, the
 * multi round-trip request types, subscriptions, and `server/discover`.
 */

import type {
  Implementation,
  JSONRPCRequest,
  JSONRPCErrorResponse,
  JSONRPCNotification,
  LoggingLevel,
  RequestId,
  ProgressToken,
  Cursor,
  Tool,
  Resource,
  ResourceTemplate,
  Prompt,
  PromptMessage,
  ResourceContents,
  ContentBlock,
  ElicitRequest,
  ElicitResult,
  CreateMessageRequest,
  CreateMessageResult,
  ListRootsRequest,
  ListRootsResult
} from './schema.ts'

export type {
  Implementation,
  Tool,
  Resource,
  ResourceTemplate,
  Prompt,
  PromptMessage,
  ResourceContents,
  ContentBlock,
  RequestId,
  ProgressToken,
  Cursor,
  LoggingLevel
}

/** JSON values, as the 2026-07-28 schema models them. */
export type JSONValue = string | number | boolean | null | JSONObject | JSONArray
export type JSONObject = { [key: string]: JSONValue }
export type JSONArray = JSONValue[]

/* ------------------------------------------------------------------ */
/* Reserved `_meta` keys                                               */
/* ------------------------------------------------------------------ */

/** Protocol version this request speaks. Required on every modern request. */
export const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion'
/** Client name and version. SHOULD be present, but never load-bearing. */
export const META_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo'
/** Capabilities for this request alone. Required; `{}` means "none". */
export const META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities'
/** Opts this request into `notifications/message`, replacing `logging/setLevel`. */
export const META_LOG_LEVEL = 'io.modelcontextprotocol/logLevel'
/** Correlates a notification with the `subscriptions/listen` that asked for it. */
export const META_SUBSCRIPTION_ID = 'io.modelcontextprotocol/subscriptionId'
/** Server name and version, echoed on results. */
export const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo'

/** Identifier of the official tasks extension. */
export const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks'

/* ------------------------------------------------------------------ */
/* Metadata objects                                                    */
/* ------------------------------------------------------------------ */

export type MetaObject = Record<string, unknown>

/**
 * `_meta` as it appears on a modern request. `protocolVersion` and
 * `clientCapabilities` are required by the spec; a request missing either is
 * malformed and answered with `-32602`.
 */
export interface RequestMetaObject extends MetaObject {
  progressToken?: ProgressToken
  'io.modelcontextprotocol/protocolVersion': string
  'io.modelcontextprotocol/clientInfo'?: Implementation
  'io.modelcontextprotocol/clientCapabilities': ClientCapabilities
  /** @deprecated Deprecated in 2026-07-28 (SEP-2577) along with Logging. */
  'io.modelcontextprotocol/logLevel'?: LoggingLevel
}

export interface NotificationMetaObject extends MetaObject {
  'io.modelcontextprotocol/subscriptionId'?: RequestId
}

export interface ResultMetaObject extends MetaObject {
  'io.modelcontextprotocol/serverInfo'?: Implementation
}

export interface RequestParams {
  _meta: RequestMetaObject
}

/* ------------------------------------------------------------------ */
/* Results                                                             */
/* ------------------------------------------------------------------ */

/**
 * Discriminator on every result. The core protocol defines `complete` and
 * `input_required`; the tasks extension adds `task`.
 */
export type ResultType = 'complete' | 'input_required' | 'task' | string

export interface Result {
  _meta?: ResultMetaObject
  resultType: ResultType
  [key: string]: unknown
}

export type EmptyResult = Result

/**
 * Results that carry freshness hints. Both fields are required on
 * `resultType: "complete"` results of the cacheable operations.
 */
export interface CacheableResult extends Result {
  /** Milliseconds the client may consider this fresh. Never negative. */
  ttlMs: number
  cacheScope: 'public' | 'private'
}

export interface PaginatedResult extends Result {
  nextCursor?: Cursor
}

/* ------------------------------------------------------------------ */
/* Capabilities                                                        */
/* ------------------------------------------------------------------ */

export interface ClientCapabilities {
  experimental?: { [key: string]: JSONObject }
  /** @deprecated Deprecated in 2026-07-28 (SEP-2577). */
  roots?: Record<string, never>
  /** @deprecated Deprecated in 2026-07-28 (SEP-2577). */
  sampling?: {
    context?: JSONObject
    tools?: JSONObject
  }
  elicitation?: {
    form?: JSONObject
    url?: JSONObject
  }
  extensions?: { [key: string]: JSONObject }
}

export interface ServerCapabilities {
  experimental?: { [key: string]: JSONObject }
  /** @deprecated Deprecated in 2026-07-28 (SEP-2577). */
  logging?: JSONObject
  completions?: JSONObject
  prompts?: { listChanged?: boolean }
  resources?: { subscribe?: boolean, listChanged?: boolean }
  tools?: { listChanged?: boolean }
  extensions?: { [key: string]: JSONObject }
}

/* ------------------------------------------------------------------ */
/* server/discover                                                     */
/* ------------------------------------------------------------------ */

export interface DiscoverRequest extends JSONRPCRequest {
  method: 'server/discover'
  params: RequestParams
}

export interface DiscoverResult extends CacheableResult {
  supportedVersions: string[]
  capabilities: ServerCapabilities
  instructions?: string
}

/* ------------------------------------------------------------------ */
/* Multi round-trip requests (MRTR)                                    */
/* ------------------------------------------------------------------ */

export type InputRequest = CreateMessageRequest | ListRootsRequest | ElicitRequest
export type InputResponse = CreateMessageResult | ListRootsResult | ElicitResult

/** Server-assigned key -> the request the client must fulfil. */
export interface InputRequests {
  [key: string]: InputRequest
}

/** The same keys, carrying the client's answers on the retry. */
export interface InputResponses {
  [key: string]: InputResponse
}

/**
 * Returned in place of the real result when the server needs something from the
 * client first. At least one of `inputRequests` or `requestState` is present.
 */
export interface InputRequiredResult extends Result {
  resultType: 'input_required'
  inputRequests?: InputRequests
  /** Opaque to the client, which must echo it back verbatim on the retry. */
  requestState?: string
}

/** Params any MRTR-capable request may carry on a retry. */
export interface InputResponseRequestParams extends RequestParams {
  inputResponses?: InputResponses
  requestState?: string
}

/* ------------------------------------------------------------------ */
/* Subscriptions                                                       */
/* ------------------------------------------------------------------ */

export interface SubscriptionFilter {
  toolsListChanged?: boolean
  promptsListChanged?: boolean
  resourcesListChanged?: boolean
  resourceSubscriptions?: string[]
}

export interface SubscriptionsListenRequestParams extends RequestParams {
  notifications: SubscriptionFilter
}

export interface SubscriptionsListenRequest extends JSONRPCRequest {
  method: 'subscriptions/listen'
  params: SubscriptionsListenRequestParams
}

export interface SubscriptionsAcknowledgedNotification extends JSONRPCNotification {
  method: 'notifications/subscriptions/acknowledged'
  params: {
    _meta: NotificationMetaObject & { 'io.modelcontextprotocol/subscriptionId': RequestId }
    notifications: SubscriptionFilter
  }
}

/* ------------------------------------------------------------------ */
/* Cacheable list/read results                                         */
/* ------------------------------------------------------------------ */

export interface ListToolsResult extends PaginatedResult, CacheableResult {
  tools: Tool[]
}

export interface ListResourcesResult extends PaginatedResult, CacheableResult {
  resources: Resource[]
}

export interface ListResourceTemplatesResult extends PaginatedResult, CacheableResult {
  resourceTemplates: ResourceTemplate[]
}

export interface ListPromptsResult extends PaginatedResult, CacheableResult {
  prompts: Prompt[]
}

export interface ReadResourceResult extends CacheableResult {
  contents: ResourceContents[]
}

export interface GetPromptResult extends Result {
  description?: string
  messages: PromptMessage[]
}

export interface CallToolResult extends Result {
  content: ContentBlock[]
  structuredContent?: unknown
  isError?: boolean
}

export interface CompleteResult extends Result {
  completion: {
    values: string[]
    total?: number
    hasMore?: boolean
  }
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export interface UnsupportedProtocolVersionError extends Omit<JSONRPCErrorResponse, 'error'> {
  error: {
    code: -32022
    message: string
    data: {
      supported: string[]
      requested: string
    }
  }
}

export interface MissingRequiredClientCapabilityError extends Omit<JSONRPCErrorResponse, 'error'> {
  error: {
    code: -32021
    message: string
    data: {
      requiredCapabilities: ClientCapabilities
    }
  }
}

export interface HeaderMismatchError extends Omit<JSONRPCErrorResponse, 'error'> {
  error: {
    code: -32020
    message: string
  }
}

/* ------------------------------------------------------------------ */
/* Tasks extension (io.modelcontextprotocol/tasks)                     */
/* ------------------------------------------------------------------ */

export type TaskStatus = 'working' | 'input_required' | 'completed' | 'cancelled' | 'failed'

export interface Task {
  taskId: string
  status: TaskStatus
  statusMessage?: string
  /** ISO 8601 */
  createdAt: string
  /** ISO 8601 */
  lastUpdatedAt: string
  /** Milliseconds from creation, or null for unlimited. */
  ttlMs: number | null
  pollIntervalMs?: number
}

/** Returned in place of the real result; `resultType` is `"task"`. */
export interface CreateTaskResult extends Result, Task {
  resultType: 'task'
}

export interface WorkingTask extends Task { status: 'working' }
export interface InputRequiredTask extends Task {
  status: 'input_required'
  inputRequests: InputRequests
}
export interface CompletedTask extends Task {
  status: 'completed'
  result: Record<string, unknown>
}
export interface FailedTask extends Task {
  status: 'failed'
  error: Record<string, unknown>
}
export interface CancelledTask extends Task { status: 'cancelled' }

export type DetailedTask =
  | WorkingTask
  | InputRequiredTask
  | CompletedTask
  | FailedTask
  | CancelledTask

/** `tasks/get` returns the full task state; `resultType` is `"complete"`. */
export type GetTaskResult = Result & DetailedTask

export interface TaskStatusNotification extends JSONRPCNotification {
  method: 'notifications/tasks'
  params: Task & { _meta?: NotificationMetaObject }
}
