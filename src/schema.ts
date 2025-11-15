/* JSON-RPC types */
/**
MIT License

Copyright (c) 2024–2025 Anthropic, PBC and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

/**
 * Refers to any valid JSON-RPC object that can be decoded off the wire, or encoded to be sent.
 *
 * @internal
 */
export type JSONRPCMessage =
  | JSONRPCRequest
  | JSONRPCNotification
  | JSONRPCResponse
  | JSONRPCError

/** @internal */
export const LATEST_PROTOCOL_VERSION = 'draft'
/** @internal */
export const JSONRPC_VERSION = '2.0'

/**
 * A progress token, used to associate progress notifications with the original request.
 */
export type ProgressToken = string | number

/**
 * An opaque token used to represent a cursor for pagination.
 */
export type Cursor = string

/** @internal */
export interface Request {
  method: string;
  params?: {
    /**
     * See [specification/2025-06-18/basic/index#general-fields] for notes on _meta usage.
     */
    _meta?: {
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken?: ProgressToken;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
}

/** @internal */
export interface Notification {
  method: string;
  params?: {
    /**
     * See [specification/2025-06-18/basic/index#general-fields] for notes on _meta usage.
     */
    _meta?: { [key: string]: unknown };
    [key: string]: unknown;
  };
}

export interface Result {
  /**
   * See [specification/2025-06-18/basic/index#general-fields] for notes on _meta usage.
   */
  _meta?: { [key: string]: unknown };
  [key: string]: unknown;
}

/**
 * A uniquely identifying ID for a request in JSON-RPC.
 */
export type RequestId = string | number

/**
 * A request that expects a response.
 */
export interface JSONRPCRequest extends Request {
  jsonrpc: typeof JSONRPC_VERSION;
  id: RequestId;
}

/**
 * A notification which does not expect a response.
 */
export interface JSONRPCNotification extends Notification {
  jsonrpc: typeof JSONRPC_VERSION;
}

/**
 * A successful (non-error) response to a request.
 */
export interface JSONRPCResponse {
  jsonrpc: typeof JSONRPC_VERSION;
  id: RequestId;
  result: Result;
}

// Standard JSON-RPC error codes
/** @internal */
export const PARSE_ERROR = -32700
/** @internal */
export const INVALID_REQUEST = -32600
/** @internal */
export const METHOD_NOT_FOUND = -32601
/** @internal */
export const INVALID_PARAMS = -32602
/** @internal */
export const INTERNAL_ERROR = -32603

/**
 * A response to a request that indicates an error occurred.
 */
export interface JSONRPCError {
  jsonrpc: typeof JSONRPC_VERSION;
  id: RequestId;
  error: {
    /**
     * The error type that occurred.
     */
    code: number;
    /**
     * A short description of the error. The message SHOULD be limited to a concise single sentence.
     */
    message: string;
    /**
     * Additional information about the error. The value of this member is defined by the sender (e.g. detailed error information, nested errors etc.).
     */
    data?: unknown;
  };
}

/* Empty result */
/**
 * A response that indicates success but carries no data.
 */
export type EmptyResult = Result

/* Cancellation */
/**
 * This notification can be sent by either side to indicate that it is cancelling a previously-issued request.
 *
 * The request SHOULD still be in-flight, but due to communication latency, it is always possible that this notification MAY arrive after the request has already finished.
 *
 * This notification indicates that the result will be unused, so any associated processing SHOULD cease.
 *
 * A client MUST NOT attempt to cancel its `initialize` request.
 *
 * @category notifications/cancelled
 */
export interface CancelledNotification extends Notification {
  method: 'notifications/cancelled';
  params: {
    /**
     * The ID of the request to cancel.
     *
     * This MUST correspond to the ID of a request previously issued in the same direction.
     */
    requestId: RequestId;

    /**
     * An optional string describing the reason for the cancellation. This MAY be logged or presented to the user.
     */
    reason?: string;
  };
}

/* Initialization */
/**
 * This request is sent from the client to the server when it first connects, asking it to begin initialization.
 *
 * @category initialize
 */
export interface InitializeRequest extends Request {
  method: 'initialize';
  params: {
    /**
     * The latest version of the Model Context Protocol that the client supports. The client MAY decide to support older versions as well.
     */
    protocolVersion: string;
    capabilities: ClientCapabilities;
    clientInfo: Implementation;
  };
}

/**
 * After receiving an initialize request from the client, the server sends this response.
 *
 * @category initialize
 */
export interface InitializeResult extends Result {
  /**
   * The version of the Model Context Protocol that the server wants to use. This may not match the version that the client requested. If the client cannot support this version, it MUST disconnect.
   */
  protocolVersion: string;
  capabilities: ServerCapabilities;
  serverInfo: Implementation;

  /**
   * Instructions describing how to use the server and its features.
   *
   * This can be used by clients to improve the LLM's understanding of available tools, resources, etc. It can be thought of like a "hint" to the model. For example, this information MAY be added to the system prompt.
   */
  instructions?: string;
}

/**
 * This notification is sent from the client to the server after initialization has finished.
 *
 * @category notifications/initialized
 */
export interface InitializedNotification extends Notification {
  method: 'notifications/initialized';
}

/**
 * Capabilities a client may support. Known capabilities are defined here, in this schema, but this is not a closed set: any client can define its own, additional capabilities.
 */
export interface ClientCapabilities {
  /**
   * Experimental, non-standard capabilities that the client supports.
   */
  experimental?: { [key: string]: object };
  /**
   * Present if the client supports listing roots.
   */
  roots?: {
    /**
     * Whether the client supports notifications for changes to the roots list.
     */
    listChanged?: boolean;
  };
  /**
   * Present if the client supports sampling from an LLM.
   */
  sampling?: {
    /**
     * Present if the client supports tool use in sampling requests.
     */
    tools?: {};
  };
  /**
   * Present if the client supports elicitation from the server.
   */
  elicitation?: {};
  /**
   * Present if the client supports tasks (experimental).
   */
  tasks?: TaskCapabilities;
}

/**
 * Capabilities that a server may support. Known capabilities are defined here, in this schema, but this is not a closed set: any server can define its own, additional capabilities.
 */
export interface ServerCapabilities {
  /**
   * Experimental, non-standard capabilities that the server supports.
   */
  experimental?: { [key: string]: object };
  /**
   * Present if the server supports sending log messages to the client.
   */
  logging?: {};
  /**
   * Present if the server supports argument autocompletion suggestions.
   */
  completions?: {};
  /**
   * Present if the server offers any prompt templates.
   */
  prompts?: {
    /**
     * Whether this server supports notifications for changes to the prompt list.
     */
    listChanged?: boolean;
  };
  /**
   * Present if the server offers any resources to read.
   */
  resources?: {
    /**
     * Whether this server supports subscribing to resource updates.
     */
    subscribe?: boolean;
    /**
     * Whether this server supports notifications for changes to the resource list.
     */
    listChanged?: boolean;
  };
  /**
   * Present if the server offers any tools to call.
   */
  tools?: {
    /**
     * Whether this server supports notifications for changes to the tool list.
     */
    listChanged?: boolean;
    /**
     * Hint about task support for tool calls.
     * - "never": Tool calls cannot be task-augmented
     * - "optional": Tool calls may be task-augmented
     * - "always": Tool calls must be task-augmented
     */
    taskHint?: 'never' | 'optional' | 'always';
  };
  /**
   * Present if the server supports tasks (experimental).
   */
  tasks?: TaskCapabilities;
}

/**
 * Base interface for metadata with name (identifier) and title (display name) properties.
 *
 * @internal
 */
export interface BaseMetadata {
  /**
   * Intended for programmatic or logical use, but used as a display name in past specs or fallback (if title isn't present).
   */
  name: string;

  /**
   * Intended for UI and end-user contexts — optimized to be human-readable and easily understood,
   * even by those unfamiliar with domain-specific terminology.
   *
   * If not provided, the name should be used for display (except for Tool,
   * where `annotations.title` should be given precedence over using `name`,
   * if present).
   */
  title?: string;
}

/**
 * Describes the name and version of an MCP implementation, with an optional title for UI representation.
 */
export interface Implementation extends BaseMetadata {
  version: string;
  /**
   * Optional human-readable description of the implementation.
   */
  description?: string;
}

/**
 * Icon resource metadata for tools, resources, prompts, and resource templates.
 * Allows servers to expose visual assets for UI display.
 */
export interface IconResource {
  /**
   * URL to the icon image.
   * @format uri
   */
  src: string;
  /**
   * MIME type of the icon (e.g., "image/png", "image/svg+xml").
   */
  mimeType?: string;
  /**
   * Size of the icon in pixels (e.g., "16x16", "32x32", "16x16 32x32").
   */
  sizes?: string;
}

/* Ping */
/**
 * A ping, issued by either the server or the client, to check that the other party is still alive. The receiver must promptly respond, or else may be disconnected.
 *
 * @category ping
 */
export interface PingRequest extends Request {
  method: 'ping';
}

/* Progress notifications */
/**
 * An out-of-band notification used to inform the receiver of a progress update for a long-running request.
 *
 * @category notifications/progress
 */
export interface ProgressNotification extends Notification {
  method: 'notifications/progress';
  params: {
    /**
     * The progress token which was given in the initial request, used to associate this notification with the request that is proceeding.
     */
    progressToken: ProgressToken;
    /**
     * The progress thus far. This should increase every time progress is made, even if the total is unknown.
     *
     * @TJS-type number
     */
    progress: number;
    /**
     * Total number of items to process (or total progress required), if known.
     *
     * @TJS-type number
     */
    total?: number;
    /**
     * An optional message describing the current progress.
     */
    message?: string;
  };
}

/* Pagination */
/** @internal */
export interface PaginatedRequest extends Request {
  params?: {
    /**
     * An opaque token representing the current pagination position.
     * If provided, the server should return results starting after this cursor.
     */
    cursor?: Cursor;
  };
}

/** @internal */
export interface PaginatedResult extends Result {
  /**
   * An opaque token representing the pagination position after the last returned result.
   * If present, there may be more results available.
   */
  nextCursor?: Cursor;
}

/* Resources */
/**
 * Sent from the client to request a list of resources the server has.
 *
 * @category resources/list
 */
export interface ListResourcesRequest extends PaginatedRequest {
  method: 'resources/list';
}

/**
 * The server's response to a resources/list request from the client.
 *
 * @category resources/list
 */
export interface ListResourcesResult extends PaginatedResult {
  resources: Resource[];
}

/**
 * Sent from the client to request a list of resource templates the server has.
 *
 * @category resources/templates/list
 */
export interface ListResourceTemplatesRequest extends PaginatedRequest {
  method: 'resources/templates/list';
}

/**
 * The server's response to a resources/templates/list request from the client.
 *
 * @category resources/templates/list
 */
export interface ListResourceTemplatesResult extends PaginatedResult {
  resourceTemplates: ResourceTemplate[];
}

/**
 * Sent from the client to the server, to read a specific resource URI.
 *
 * @category resources/read
 */
export interface ReadResourceRequest extends Request {
  method: 'resources/read';
  params: {
    /**
     * The URI of the resource to read. The URI can use any protocol; it is up to the server how to interpret it.
     *
     * @format uri
     */
    uri: string;
  };
}

/**
 * The server's response to a resources/read request from the client.
 *
 * @category resources/read
 */
export interface ReadResourceResult extends Result {
  contents: (TextResourceContents | BlobResourceContents)[];
}

/**
 * An optional notification from the server to the client, informing it that the list of resources it can read from has changed. This may be issued by servers without any previous subscription from the client.
 *
 * @category notifications/resources/list_changed
 */
export interface ResourceListChangedNotification extends Notification {
  method: 'notifications/resources/list_changed';
}

/**
 * Sent from the client to request resources/updated notifications from the server whenever a particular resource changes.
 *
 * @category resources/subscribe
 */
export interface SubscribeRequest extends Request {
  method: 'resources/subscribe';
  params: {
    /**
     * The URI of the resource to subscribe to. The URI can use any protocol; it is up to the server how to interpret it.
     *
     * @format uri
     */
    uri: string;
  };
}

/**
 * Sent from the client to request cancellation of resources/updated notifications from the server. This should follow a previous resources/subscribe request.
 *
 * @category resources/unsubscribe
 */
export interface UnsubscribeRequest extends Request {
  method: 'resources/unsubscribe';
  params: {
    /**
     * The URI of the resource to unsubscribe from.
     *
     * @format uri
     */
    uri: string;
  };
}

/**
 * A notification from the server to the client, informing it that a resource has changed and may need to be read again. This should only be sent if the client previously sent a resources/subscribe request.
 *
 * @category notifications/resources/updated
 */
export interface ResourceUpdatedNotification extends Notification {
  method: 'notifications/resources/updated';
  params: {
    /**
     * The URI of the resource that has been updated. This might be a sub-resource of the one that the client actually subscribed to.
     *
     * @format uri
     */
    uri: string;
  };
}

/**
 * A known resource that the server is capable of reading.
 */
export interface Resource extends BaseMetadata {
  /**
   * The URI of this resource.
   *
   * @format uri
   */
  uri: string;

  /**
   * A description of what this resource represents.
   *
   * This can be used by clients to improve the LLM's understanding of available resources. It can be thought of like a "hint" to the model.
   */
  description?: string;

  /**
   * The MIME type of this resource, if known.
   */
  mimeType?: string;

  /**
   * Optional icon resources for UI display.
   */
  icons?: IconResource[];

  /**
   * Optional annotations for the client.
   */
  annotations?: Annotations;

  /**
   * The size of the raw resource content, in bytes (i.e., before base64 encoding or any tokenization), if known.
   *
   * This can be used by Hosts to display file sizes and estimate context window usage.
   */
  size?: number;

  /**
   * See [specification/draft/basic/index#general-fields] for notes on _meta usage.
   */
  _meta?: { [key: string]: unknown };
}

/**
 * A template description for resources available on the server.
 */
export interface ResourceTemplate extends BaseMetadata {
  /**
   * A URI template (according to RFC 6570) that can be used to construct resource URIs.
   *
   * @format uri-template
   */
  uriTemplate: string;

  /**
   * A description of what this template is for.
   *
   * This can be used by clients to improve the LLM's understanding of available resources. It can be thought of like a "hint" to the model.
   */
  description?: string;

  /**
   * The MIME type for all resources that match this template. This should only be included if all resources matching this template have the same type.
   */
  mimeType?: string;

  /**
   * Optional icon resources for UI display.
   */
  icons?: IconResource[];

  /**
   * Optional annotations for the client.
   */
  annotations?: Annotations;

  /**
   * See [specification/draft/basic/index#general-fields] for notes on _meta usage.
   */
  _meta?: { [key: string]: unknown };
}

/**
 * The contents of a specific resource or sub-resource.
 */
export interface ResourceContents {
  /**
   * The URI of this resource.
   *
   * @format uri
   */
  uri: string;
  /**
   * The MIME type of this resource, if known.
   */
  mimeType?: string;

  /**
   * See [specification/2025-06-18/basic/index#general-fields] for notes on _meta usage.
   */
  _meta?: { [key: string]: unknown };
}

export interface TextResourceContents extends ResourceContents {
  /**
   * The text of the item. This must only be set if the item can actually be represented as text (not binary data).
   */
  text: string;
}

export interface BlobResourceContents extends ResourceContents {
  /**
   * A base64-encoded string representing the binary data of the item.
   *
   * @format byte
   */
  blob: string;
}

/* Prompts */
/**
 * Sent from the client to request a list of prompts and prompt templates the server has.
 *
 * @category prompts/list
 */
export interface ListPromptsRequest extends PaginatedRequest {
  method: 'prompts/list';
}

/**
 * The server's response to a prompts/list request from the client.
 *
 * @category prompts/list
 */
export interface ListPromptsResult extends PaginatedResult {
  prompts: Prompt[];
}

/**
 * Used by the client to get a prompt provided by the server.
 *
 * @category prompts/get
 */
export interface GetPromptRequest extends Request {
  method: 'prompts/get';
  params: {
    /**
     * The name of the prompt or prompt template.
     */
    name: string;
    /**
     * Arguments to use for templating the prompt.
     */
    arguments?: { [key: string]: string };
  };
}

/**
 * The server's response to a prompts/get request from the client.
 *
 * @category prompts/get
 */
export interface GetPromptResult extends Result {
  /**
   * An optional description for the prompt.
   */
  description?: string;
  messages: PromptMessage[];
}

/**
 * A prompt or prompt template that the server offers.
 */
export interface Prompt extends BaseMetadata {
  /**
   * An optional description of what this prompt provides
   */
  description?: string;
  /**
   * A list of arguments to use for templating the prompt.
   */
  arguments?: PromptArgument[];

  /**
   * Optional icon resources for UI display.
   */
  icons?: IconResource[];

  /**
   * See [specification/draft/basic/index#general-fields] for notes on _meta usage.
   */
  _meta?: { [key: string]: unknown };
}

/**
 * Describes an argument that a prompt can accept.
 */
export interface PromptArgument extends BaseMetadata {
  /**
   * A human-readable description of the argument.
   */
  description?: string;
  /**
   * Whether this argument must be provided.
   */
  required?: boolean;
}

/**
 * The sender or recipient of messages and data in a conversation.
 */
export type Role = 'user' | 'assistant'

/**
 * Describes a message returned as part of a prompt.
 *
 * This is similar to `SamplingMessage`, but also supports the embedding of
 * resources from the MCP server.
 */
export interface PromptMessage {
  role: Role;
  content: ContentBlock;
}

/**
 * A resource that the server is capable of reading, included in a prompt or tool call result.
 *
 * Note: resource links returned by tools are not guaranteed to appear in the results of `resources/list` requests.
 */
export interface ResourceLink extends Resource {
  type: 'resource_link';
}

/**
 * The contents of a resource, embedded into a prompt or tool call result.
 *
 * It is up to the client how best to render embedded resources for the benefit
 * of the LLM and/or the user.
 */
export interface EmbeddedResource {
  type: 'resource';
  resource: TextResourceContents | BlobResourceContents;

  /**
   * Optional annotations for the client.
   */
  annotations?: Annotations;

  /**
   * See [specification/2025-06-18/basic/index#general-fields] for notes on _meta usage.
   */
  _meta?: { [key: string]: unknown };
}
/**
 * An optional notification from the server to the client, informing it that the list of prompts it offers has changed. This may be issued by servers without any previous subscription from the client.
 *
 * @category notifications/prompts/list_changed
 */
export interface PromptListChangedNotification extends Notification {
  method: 'notifications/prompts/list_changed';
}

/* Tools */
/**
 * Sent from the client to request a list of tools the server has.
 *
 * @category tools/list
 */
export interface ListToolsRequest extends PaginatedRequest {
  method: 'tools/list';
}

/**
 * The server's response to a tools/list request from the client.
 *
 * @category tools/list
 */
export interface ListToolsResult extends PaginatedResult {
  tools: Tool[];
}

/**
 * The server's response to a tool call.
 *
 * @category tools/call
 */
export interface CallToolResult extends Result {
  /**
   * A list of content objects that represent the unstructured result of the tool call.
   */
  content: ContentBlock[];

  /**
   * An optional JSON object that represents the structured result of the tool call.
   */
  structuredContent?: { [key: string]: unknown };

  /**
   * Whether the tool call ended in an error.
   *
   * If not set, this is assumed to be false (the call was successful).
   *
   * Any errors that originate from the tool SHOULD be reported inside the result
   * object, with `isError` set to true, _not_ as an MCP protocol-level error
   * response. Otherwise, the LLM would not be able to see that an error occurred
   * and self-correct.
   *
   * However, any errors in _finding_ the tool, an error indicating that the
   * server does not support tool calls, or any other exceptional conditions,
   * should be reported as an MCP error response.
   */
  isError?: boolean;
}

/**
 * Used by the client to invoke a tool provided by the server.
 *
 * @category tools/call
 */
export interface CallToolRequest extends Request {
  method: 'tools/call';
  params: {
    name: string;
    arguments?: { [key: string]: unknown };
  };
}

/**
 * An optional notification from the server to the client, informing it that the list of tools it offers has changed. This may be issued by servers without any previous subscription from the client.
 *
 * @category notifications/tools/list_changed
 */
export interface ToolListChangedNotification extends Notification {
  method: 'notifications/tools/list_changed';
}

/**
 * Additional properties describing a Tool to clients.
 *
 * NOTE: all properties in ToolAnnotations are **hints**.
 * They are not guaranteed to provide a faithful description of
 * tool behavior (including descriptive properties like `title`).
 *
 * Clients should never make tool use decisions based on ToolAnnotations
 * received from untrusted servers.
 */
export interface ToolAnnotations {
  /**
   * A human-readable title for the tool.
   */
  title?: string;

  /**
   * If true, the tool does not modify its environment.
   *
   * Default: false
   */
  readOnlyHint?: boolean;

  /**
   * If true, the tool may perform destructive updates to its environment.
   * If false, the tool performs only additive updates.
   *
   * (This property is meaningful only when `readOnlyHint == false`)
   *
   * Default: true
   */
  destructiveHint?: boolean;

  /**
   * If true, calling the tool repeatedly with the same arguments
   * will have no additional effect on the its environment.
   *
   * (This property is meaningful only when `readOnlyHint == false`)
   *
   * Default: false
   */
  idempotentHint?: boolean;

  /**
   * If true, this tool may interact with an "open world" of external
   * entities. If false, the tool's domain of interaction is closed.
   * For example, the world of a web search tool is open, whereas that
   * of a memory tool is not.
   *
   * Default: true
   */
  openWorldHint?: boolean;
}

/**
 * Definition for a tool the client can call.
 */
export interface Tool extends BaseMetadata {
  /**
   * A human-readable description of the tool.
   *
   * This can be used by clients to improve the LLM's understanding of available tools. It can be thought of like a "hint" to the model.
   */
  description?: string;

  /**
   * A JSON Schema object defining the expected parameters for the tool.
   */
  inputSchema: {
    type: 'object';
    properties?: { [key: string]: object };
    required?: string[];
  };

  /**
   * An optional JSON Schema object defining the structure of the tool's output returned in
   * the structuredContent field of a CallToolResult.
   */
  outputSchema?: {
    type: 'object';
    properties?: { [key: string]: object };
    required?: string[];
  };

  /**
   * Optional icon resources for UI display.
   */
  icons?: IconResource[];

  /**
   * Optional additional tool information.
   *
   * Display name precedence order is: title, annotations.title, then name.
   */
  annotations?: ToolAnnotations;

  /**
   * See [specification/draft/basic/index#general-fields] for notes on _meta usage.
   */
  _meta?: { [key: string]: unknown };
}

/* Logging */
/**
 * A request from the client to the server, to enable or adjust logging.
 *
 * @category logging/setLevel
 */
export interface SetLevelRequest extends Request {
  method: 'logging/setLevel';
  params: {
    /**
     * The level of logging that the client wants to receive from the server. The server should send all logs at this level and higher (i.e., more severe) to the client as notifications/message.
     */
    level: LoggingLevel;
  };
}

/**
 * Notification of a log message passed from server to client. If no logging/setLevel request has been sent from the client, the server MAY decide which messages to send automatically.
 *
 * @category notifications/message
 */
export interface LoggingMessageNotification extends Notification {
  method: 'notifications/message';
  params: {
    /**
     * The severity of this log message.
     */
    level: LoggingLevel;
    /**
     * An optional name of the logger issuing this message.
     */
    logger?: string;
    /**
     * The data to be logged, such as a string message or an object. Any JSON serializable type is allowed here.
     */
    data: unknown;
  };
}

/**
 * The severity of a log message.
 *
 * These map to syslog message severities, as specified in RFC-5424:
 * https://datatracker.ietf.org/doc/html/rfc5424#section-6.2.1
 */
export type LoggingLevel =
  | 'debug'
  | 'info'
  | 'notice'
  | 'warning'
  | 'error'
  | 'critical'
  | 'alert'
  | 'emergency'

/* Sampling */

/**
 * Tool definition for sampling requests.
 * Allows the model to invoke tools during sampling.
 */
export interface SamplingTool {
  /**
   * Tool name (unique identifier)
   */
  name: string;
  /**
   * Human-readable description of what the tool does
   */
  description: string;
  /**
   * JSON Schema defining the tool's input parameters
   */
  inputSchema: {
    type: 'object';
    properties?: { [key: string]: object };
    required?: string[];
  };
}

/**
 * Controls how the model uses tools during sampling.
 */
export type ToolChoice =
  | { mode: 'auto' }      // Model decides whether to use tools
  | { mode: 'required' }  // Model must use at least one tool
  | { mode: 'none' }      // Model cannot use tools

/**
 * A request from the server to sample an LLM via the client. The client has full discretion over which model to select. The client should also inform the user before beginning sampling, to allow them to inspect the request (human in the loop) and decide whether to approve it.
 *
 * @category sampling/createMessage
 */
export interface CreateMessageRequest extends Request {
  method: 'sampling/createMessage';
  params: {
    messages: SamplingMessage[];
    /**
     * The server's preferences for which model to select. The client MAY ignore these preferences.
     */
    modelPreferences?: ModelPreferences;
    /**
     * An optional system prompt the server wants to use for sampling. The client MAY modify or omit this prompt.
     */
    systemPrompt?: string;
    /**
     * A request to include context from one or more MCP servers (including the caller), to be attached to the prompt. The client MAY ignore this request.
     */
    includeContext?: 'none' | 'thisServer' | 'allServers';
    /**
     * @TJS-type number
     */
    temperature?: number;
    /**
     * The maximum number of tokens to sample, as requested by the server. The client MAY choose to sample fewer tokens than requested.
     */
    maxTokens: number;
    stopSequences?: string[];
    /**
     * Optional metadata to pass through to the LLM provider. The format of this metadata is provider-specific.
     */
    metadata?: object;
    /**
     * Optional list of tools available to the model.
     * Servers MUST NOT send tool-enabled sampling requests to clients that have not declared
     * support for tool use via the sampling.tools capability.
     */
    tools?: SamplingTool[];
    /**
     * Controls how the model uses tools.
     */
    toolChoice?: ToolChoice;
  };
}

/**
 * The client's response to a sampling/create_message request from the server. The client should inform the user before returning the sampled message, to allow them to inspect the response (human in the loop) and decide whether to allow the server to see it.
 *
 * @category sampling/createMessage
 */
export interface CreateMessageResult extends Result, SamplingMessage {
  /**
   * The name of the model that generated the message.
   */
  model: string;
  /**
   * The reason why sampling stopped, if known.
   */
  stopReason?: 'endTurn' | 'stopSequence' | 'maxTokens' | 'toolUse' | string;
}

/**
 * Describes a message issued to or received from an LLM API.
 */
export interface SamplingMessage {
  role: Role;
  content: SamplingContent | SamplingContent[];
}

/**
 * Content types supported in sampling messages.
 */
export type SamplingContent =
  | TextContent
  | ImageContent
  | AudioContent
  | ToolUseContent
  | ToolResultContent

/**
 * Optional annotations for the client. The client can use annotations to inform how objects are used or displayed
 */
export interface Annotations {
  /**
   * Describes who the intended customer of this object or data is.
   *
   * It can include multiple entries to indicate content useful for multiple audiences (e.g., `["user", "assistant"]`).
   */
  audience?: Role[];

  /**
   * Describes how important this data is for operating the server.
   *
   * A value of 1 means "most important," and indicates that the data is
   * effectively required, while 0 means "least important," and indicates that
   * the data is entirely optional.
   *
   * @TJS-type number
   * @minimum 0
   * @maximum 1
   */
  priority?: number;

  /**
   * The moment the resource was last modified, as an ISO 8601 formatted string.
   *
   * Should be an ISO 8601 formatted string (e.g., "2025-01-12T15:00:58Z").
   *
   * Examples: last activity timestamp in an open file, timestamp when the resource
   * was attached, etc.
   */
  lastModified?: string;
}

export type ContentBlock =
  | TextContent
  | ImageContent
  | AudioContent
  | ResourceLink
  | EmbeddedResource

/**
 * Tool use content - represents the model invoking a tool.
 * Appears in assistant messages when the model decides to use a tool.
 */
export interface ToolUseContent {
  type: 'tool_use';
  /**
   * Unique identifier for this tool invocation.
   * Used to match with corresponding tool_result in follow-up message.
   */
  id: string;
  /**
   * Name of the tool being invoked.
   * Must match a tool name from the sampling request.
   */
  name: string;
  /**
   * Parameters for the tool invocation.
   * Must match the tool's inputSchema.
   */
  input: object;
}

/**
 * Tool result content - represents the result of a tool invocation.
 * Appears in user messages following assistant messages with tool_use.
 *
 * IMPORTANT: When a user message contains tool results, it MUST contain ONLY
 * tool results. Mixing tool results with other content types is not allowed.
 */
export interface ToolResultContent {
  type: 'tool_result';
  /**
   * The ID of the tool use this is a result for.
   * Must match an id from a ToolUseContent in a previous assistant message.
   */
  toolUseId: string;
  /**
   * The result content (optional if isError is true).
   */
  content?: string | TextContent[];
  /**
   * Whether this represents an error result.
   */
  isError?: boolean;
}

/**
 * Text provided to or from an LLM.
 */
export interface TextContent {
  type: 'text';

  /**
   * The text content of the message.
   */
  text: string;

  /**
   * Optional annotations for the client.
   */
  annotations?: Annotations;

  /**
   * See [specification/2025-06-18/basic/index#general-fields] for notes on _meta usage.
   */
  _meta?: { [key: string]: unknown };
}

/**
 * An image provided to or from an LLM.
 */
export interface ImageContent {
  type: 'image';

  /**
   * The base64-encoded image data.
   *
   * @format byte
   */
  data: string;

  /**
   * The MIME type of the image. Different providers may support different image types.
   */
  mimeType: string;

  /**
   * Optional annotations for the client.
   */
  annotations?: Annotations;

  /**
   * See [specification/2025-06-18/basic/index#general-fields] for notes on _meta usage.
   */
  _meta?: { [key: string]: unknown };
}

/**
 * Audio provided to or from an LLM.
 */
export interface AudioContent {
  type: 'audio';

  /**
   * The base64-encoded audio data.
   *
   * @format byte
   */
  data: string;

  /**
   * The MIME type of the audio. Different providers may support different audio types.
   */
  mimeType: string;

  /**
   * Optional annotations for the client.
   */
  annotations?: Annotations;

  /**
   * See [specification/2025-06-18/basic/index#general-fields] for notes on _meta usage.
   */
  _meta?: { [key: string]: unknown };
}

/**
 * The server's preferences for model selection, requested of the client during sampling.
 *
 * Because LLMs can vary along multiple dimensions, choosing the "best" model is
 * rarely straightforward.  Different models excel in different areas—some are
 * faster but less capable, others are more capable but more expensive, and so
 * on. This interface allows servers to express their priorities across multiple
 * dimensions to help clients make an appropriate selection for their use case.
 *
 * These preferences are always advisory. The client MAY ignore them. It is also
 * up to the client to decide how to interpret these preferences and how to
 * balance them against other considerations.
 */
export interface ModelPreferences {
  /**
   * Optional hints to use for model selection.
   *
   * If multiple hints are specified, the client MUST evaluate them in order
   * (such that the first match is taken).
   *
   * The client SHOULD prioritize these hints over the numeric priorities, but
   * MAY still use the priorities to select from ambiguous matches.
   */
  hints?: ModelHint[];

  /**
   * How much to prioritize cost when selecting a model. A value of 0 means cost
   * is not important, while a value of 1 means cost is the most important
   * factor.
   *
   * @TJS-type number
   * @minimum 0
   * @maximum 1
   */
  costPriority?: number;

  /**
   * How much to prioritize sampling speed (latency) when selecting a model. A
   * value of 0 means speed is not important, while a value of 1 means speed is
   * the most important factor.
   *
   * @TJS-type number
   * @minimum 0
   * @maximum 1
   */
  speedPriority?: number;

  /**
   * How much to prioritize intelligence and capabilities when selecting a
   * model. A value of 0 means intelligence is not important, while a value of 1
   * means intelligence is the most important factor.
   *
   * @TJS-type number
   * @minimum 0
   * @maximum 1
   */
  intelligencePriority?: number;
}

/**
 * Hints to use for model selection.
 *
 * Keys not declared here are currently left unspecified by the spec and are up
 * to the client to interpret.
 */
export interface ModelHint {
  /**
   * A hint for a model name.
   *
   * The client SHOULD treat this as a substring of a model name; for example:
   *  - `claude-3-5-sonnet` should match `claude-3-5-sonnet-20241022`
   *  - `sonnet` should match `claude-3-5-sonnet-20241022`, `claude-3-sonnet-20240229`, etc.
   *  - `claude` should match any Claude model
   *
   * The client MAY also map the string to a different provider's model name or a different model family, as long as it fills a similar niche; for example:
   *  - `gemini-1.5-flash` could match `claude-3-haiku-20240307`
   */
  name?: string;
}

/* Autocomplete */
/**
 * A request from the client to the server, to ask for completion options.
 *
 * @category completion/complete
 */
export interface CompleteRequest extends Request {
  method: 'completion/complete';
  params: {
    ref: PromptReference | ResourceTemplateReference;
    /**
     * The argument's information
     */
    argument: {
      /**
       * The name of the argument
       */
      name: string;
      /**
       * The value of the argument to use for completion matching.
       */
      value: string;
    };

    /**
     * Additional, optional context for completions
     */
    context?: {
      /**
       * Previously-resolved variables in a URI template or prompt.
       */
      arguments?: { [key: string]: string };
    };
  };
}

/**
 * The server's response to a completion/complete request
 *
 * @category completion/complete
 */
export interface CompleteResult extends Result {
  completion: {
    /**
     * An array of completion values. Must not exceed 100 items.
     */
    values: string[];
    /**
     * The total number of completion options available. This can exceed the number of values actually sent in the response.
     */
    total?: number;
    /**
     * Indicates whether there are additional completion options beyond those provided in the current response, even if the exact total is unknown.
     */
    hasMore?: boolean;
  };
}

/**
 * A reference to a resource or resource template definition.
 */
export interface ResourceTemplateReference {
  type: 'ref/resource';
  /**
   * The URI or URI template of the resource.
   *
   * @format uri-template
   */
  uri: string;
}

/**
 * Identifies a prompt.
 */
export interface PromptReference extends BaseMetadata {
  type: 'ref/prompt';
}

/* Roots */
/**
 * Sent from the server to request a list of root URIs from the client. Roots allow
 * servers to ask for specific directories or files to operate on. A common example
 * for roots is providing a set of repositories or directories a server should operate
 * on.
 *
 * This request is typically used when the server needs to understand the file system
 * structure or access specific locations that the client has permission to read from.
 *
 * @category roots/list
 */
export interface ListRootsRequest extends Request {
  method: 'roots/list';
}

/**
 * The client's response to a roots/list request from the server.
 * This result contains an array of Root objects, each representing a root directory
 * or file that the server can operate on.
 *
 * @category roots/list
 */
export interface ListRootsResult extends Result {
  roots: Root[];
}

/**
 * Represents a root directory or file that the server can operate on.
 */
export interface Root {
  /**
   * The URI identifying the root. This *must* start with file:// for now.
   * This restriction may be relaxed in future versions of the protocol to allow
   * other URI schemes.
   *
   * @format uri
   */
  uri: string;
  /**
   * An optional name for the root. This can be used to provide a human-readable
   * identifier for the root, which may be useful for display purposes or for
   * referencing the root in other parts of the application.
   */
  name?: string;

  /**
   * See [specification/2025-06-18/basic/index#general-fields] for notes on _meta usage.
   */
  _meta?: { [key: string]: unknown };
}

/**
 * A notification from the client to the server, informing it that the list of roots has changed.
 * This notification should be sent whenever the client adds, removes, or modifies any root.
 * The server should then request an updated list of roots using the ListRootsRequest.
 *
 * @category notifications/roots/list_changed
 */
export interface RootsListChangedNotification extends Notification {
  method: 'notifications/roots/list_changed';
}

/**
 * A request from the server to elicit additional information from the user via the client.
 * Supports two modes: form mode (structured data via JSON schema) and URL mode (out-of-band interaction).
 *
 * @category elicitation/create
 */
export interface ElicitRequest extends Request {
  method: 'elicitation/create';
  params: FormElicitationParams | URLElicitationParams;
}

/**
 * Form mode elicitation: structured data collection via JSON schema.
 * User responses are exposed to the MCP client.
 */
export interface FormElicitationParams {
  /**
   * Elicitation mode
   */
  mode: 'form';
  /**
   * The message to present to the user.
   */
  message: string;
  /**
   * A restricted subset of JSON Schema.
   * Only top-level properties are allowed, without nesting.
   */
  requestedSchema: {
    type: 'object';
    properties: {
      [key: string]: PrimitiveSchemaDefinition;
    };
    required?: string[];
  };
  /**
   * Optional metadata.
   */
  _meta?: { [key: string]: unknown };
  [key: string]: unknown;
}

/**
 * URL mode elicitation: out-of-band interaction via external URL.
 * Sensitive data remains outside the MCP client context.
 * Used for OAuth flows, external forms, and sensitive credential collection.
 */
export interface URLElicitationParams {
  /**
   * Elicitation mode
   */
  mode: 'url';
  /**
   * Unique identifier for this elicitation request.
   * Used to track completion and prevent CSRF attacks.
   */
  elicitationId: string;
  /**
   * HTTPS URL where the user should complete the interaction.
   * MUST use HTTPS in production (localhost allowed for development).
   */
  url: string;
  /**
   * The message to present to the user explaining the interaction.
   */
  message: string;
  /**
   * Optional metadata.
   */
  _meta?: { [key: string]: unknown };
  [key: string]: unknown;
}

/**
 * Notification sent when a URL mode elicitation has been completed.
 *
 * @category notifications/elicitation/complete
 */
export interface ElicitationCompleteNotification extends Notification {
  method: 'notifications/elicitation/complete';
  params: {
    /**
     * The elicitation ID that has been completed.
     */
    elicitationId: string;
  };
}

/**
 * Restricted schema definitions that only allow primitive types
 * without nested objects or arrays.
 */
export type PrimitiveSchemaDefinition =
  | StringSchema
  | NumberSchema
  | BooleanSchema
  | EnumSchema

export interface StringSchema {
  type: 'string';
  title?: string;
  description?: string;
  minLength?: number;
  maxLength?: number;
  format?: 'email' | 'uri' | 'date' | 'date-time';
}

export interface NumberSchema {
  type: 'number' | 'integer';
  title?: string;
  description?: string;
  minimum?: number;
  maximum?: number;
}

export interface BooleanSchema {
  type: 'boolean';
  title?: string;
  description?: string;
  default?: boolean;
}

/**
 * Enum schemas support both titled and untitled variants,
 * as well as single-select and multi-select modes.
 */
export type EnumSchema =
  | UntitledSingleSelectEnumSchema
  | TitledSingleSelectEnumSchema
  | UntitledMultiSelectEnumSchema
  | TitledMultiSelectEnumSchema

/**
 * Untitled single-select enum (simple array of values)
 */
export interface UntitledSingleSelectEnumSchema {
  type: 'string' | 'number';
  title?: string;
  description?: string;
  enum: Array<string | number>;
  default?: string | number;
}

/**
 * Titled single-select enum (with display names for each option)
 */
export interface TitledSingleSelectEnumSchema {
  type: 'string' | 'number';
  title?: string;
  description?: string;
  oneOf: Array<{
    const: string | number;
    title: string;
  }>;
  default?: string | number;
}

/**
 * Untitled multi-select enum (array of simple values)
 */
export interface UntitledMultiSelectEnumSchema {
  type: 'array';
  title?: string;
  description?: string;
  items: {
    type: 'string' | 'number';
    enum: Array<string | number>;
  };
  minItems?: number;
  maxItems?: number;
  default?: Array<string | number>;
}

/**
 * Titled multi-select enum (array with display names)
 */
export interface TitledMultiSelectEnumSchema {
  type: 'array';
  title?: string;
  description?: string;
  items: {
    type: 'string' | 'number';
    oneOf: Array<{
      const: string | number;
      title: string;
    }>;
  };
  minItems?: number;
  maxItems?: number;
  default?: Array<string | number>;
}

/**
 * The client's response to an elicitation request.
 *
 * @category elicitation/create
 */
export interface ElicitResult extends Result {
  /**
   * The user action in response to the elicitation.
   * - "accept": User submitted the form/confirmed the action
   * - "decline": User explicitly declined the action
   * - "cancel": User dismissed without making an explicit choice
   */
  action: 'accept' | 'decline' | 'cancel';

  /**
   * The submitted form data, only present when action is "accept".
   * Contains values matching the requested schema.
   */
  content?: { [key: string]: string | number | boolean };
}

/* Tasks (Experimental) */

/**
 * Task status states.
 */
export type TaskStatus =
  | 'working'          // Task is in progress
  | 'input_required'   // Receiver needs requestor input before continuing
  | 'completed'        // Task finished successfully
  | 'failed'           // Task failed with error
  | 'cancelled'        // Task was cancelled by user

/**
 * Task augmentation for requests.
 * When included in a request, creates a task for asynchronous processing.
 */
export interface TaskAugmentation {
  /**
   * Time-to-live in milliseconds.
   * After this time, the receiver may delete the task and its results.
   */
  ttl?: number;
}

/**
 * Result when a task is created.
 * Returned instead of the actual operation result.
 */
export interface CreateTaskResult extends Result {
  task: {
    /**
     * Unique identifier for this task.
     */
    taskId: string;
    /**
     * Current status of the task.
     */
    status: TaskStatus;
    /**
     * Optional human-readable status message.
     */
    statusMessage?: string;
    /**
     * ISO 8601 timestamp when the task was created.
     */
    createdAt: string;
    /**
     * Time-to-live in milliseconds from creation.
     */
    ttl: number;
    /**
     * Suggested polling interval in milliseconds.
     * Requestors SHOULD respect this value.
     */
    pollInterval?: number;
  };
  /**
   * Optional metadata for task tracking.
   */
  _meta?: {
    /**
     * Task relationship metadata.
     */
    'io.modelcontextprotocol/related-task'?: {
      taskId: string;
    };
    /**
     * Immediate response for model to process while task executes.
     */
    'io.modelcontextprotocol/model-immediate-response'?: string;
    [key: string]: unknown;
  };
}

/**
 * Get task status request.
 *
 * @category tasks/get
 */
export interface GetTaskRequest extends Request {
  method: 'tasks/get';
  params: {
    /**
     * The ID of the task to query.
     */
    taskId: string;
  };
}

/**
 * Task status result.
 *
 * @category tasks/get
 */
export interface TaskStatusResult extends Result {
  taskId: string;
  status: TaskStatus;
  statusMessage?: string;
  createdAt: string;
  ttl: number;
  pollInterval?: number;
}

/**
 * Get task result request.
 * Blocks until the task reaches a terminal status if not already terminal.
 *
 * @category tasks/result
 */
export interface GetTaskResultRequest extends Request {
  method: 'tasks/result';
  params: {
    /**
     * The ID of the task whose result to retrieve.
     */
    taskId: string;
  };
}

/**
 * List tasks request.
 *
 * @category tasks/list
 */
export interface ListTasksRequest extends Request {
  method: 'tasks/list';
  params?: {
    /**
     * Optional cursor for pagination.
     */
    cursor?: string;
  };
}

/**
 * List tasks result.
 *
 * @category tasks/list
 */
export interface ListTasksResult extends Result {
  tasks: TaskStatusResult[];
  /**
   * Cursor for next page of results.
   */
  nextCursor?: string;
}

/**
 * Cancel task request.
 *
 * @category tasks/cancel
 */
export interface CancelTaskRequest extends Request {
  method: 'tasks/cancel';
  params: {
    /**
     * The ID of the task to cancel.
     */
    taskId: string;
  };
}

/**
 * Optional notification sent when a task's status changes.
 *
 * @category notifications/tasks/status
 */
export interface TaskStatusNotification extends Notification {
  method: 'notifications/tasks/status';
  params: TaskStatusResult;
}

/**
 * Task capability configuration.
 */
export interface TaskCapabilities {
  /**
   * Support for listing tasks.
   */
  list?: {};
  /**
   * Support for cancelling tasks.
   */
  cancel?: {};
  /**
   * Support for task-augmented requests.
   */
  requests?: {
    tools?: {
      call?: {};
    };
    sampling?: {
      createMessage?: {};
    };
    elicitation?: {
      create?: {};
    };
  };
}

/* Client messages */
/** @internal */
export type ClientRequest =
  | PingRequest
  | InitializeRequest
  | CompleteRequest
  | SetLevelRequest
  | GetPromptRequest
  | ListPromptsRequest
  | ListResourcesRequest
  | ListResourceTemplatesRequest
  | ReadResourceRequest
  | SubscribeRequest
  | UnsubscribeRequest
  | CallToolRequest
  | ListToolsRequest
  | GetTaskRequest
  | GetTaskResultRequest
  | ListTasksRequest
  | CancelTaskRequest

/** @internal */
export type ClientNotification =
  | CancelledNotification
  | ProgressNotification
  | InitializedNotification
  | RootsListChangedNotification

/** @internal */
export type ClientResult =
  | EmptyResult
  | CreateMessageResult
  | ListRootsResult
  | ElicitResult

/* Server messages */
/** @internal */
export type ServerRequest =
  | PingRequest
  | CreateMessageRequest
  | ListRootsRequest
  | ElicitRequest

/** @internal */
export type ServerNotification =
  | CancelledNotification
  | ProgressNotification
  | LoggingMessageNotification
  | ResourceUpdatedNotification
  | ResourceListChangedNotification
  | ToolListChangedNotification
  | PromptListChangedNotification

/** @internal */
export type ServerResult =
  | EmptyResult
  | InitializeResult
  | CompleteResult
  | GetPromptResult
  | ListPromptsResult
  | ListResourceTemplatesResult
  | ListResourcesResult
  | ReadResourceResult
  | CallToolResult
  | ListToolsResult
