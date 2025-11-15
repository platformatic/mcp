# MCP Specification Update Implementation Plan

This document outlines the plan to update `fastify-mcp` from protocol version `2025-06-18` to the latest `draft` specification.

## Table of Contents

1. [Overview](#overview)
2. [Breaking Changes](#breaking-changes)
3. [Implementation Phases](#implementation-phases)
4. [Feature Breakdown](#feature-breakdown)
5. [Testing Strategy](#testing-strategy)
6. [Migration Guide](#migration-guide)

## Overview

### Current State (2025-06-18)

**Implemented Features:**
- ✅ JSON-RPC 2.0 messaging
- ✅ Lifecycle management (initialize, initialized)
- ✅ HTTP with SSE transport
- ✅ Tools, Resources, Prompts
- ✅ OAuth 2.1 Authorization (basic)
- ✅ Session management (Memory/Redis)
- ✅ Message broadcasting
- ✅ Elicitation (basic form mode)
- ✅ Progress notifications
- ✅ Ping utility
- ✅ Cancellation

**Missing Features:**
- ❌ OpenID Connect Discovery
- ❌ Icon metadata
- ❌ Incremental scope consent
- ❌ Enhanced enum schemas
- ❌ URL mode elicitation
- ❌ Tool calling in sampling
- ❌ OAuth Client ID Metadata Documents
- ❌ Tasks (experimental)
- ❌ Logging capability
- ❌ Completion/autocompletion
- ❌ Roots capability
- ❌ Pagination utility

### Target State (Draft)

All features from current state plus all missing features listed above.

## Breaking Changes

### 1. Protocol Version Update

**Impact:** Low
**File:** `src/schema.ts`

```typescript
// OLD
export const LATEST_PROTOCOL_VERSION = '2025-06-18'

// NEW
export const LATEST_PROTOCOL_VERSION = 'draft'
```

**Migration:** No breaking changes for consumers; version negotiation handled internally.

### 2. Enhanced Elicitation Schemas

**Impact:** Medium
**Files:** `src/schema.ts`, `src/handlers.ts`

**Changes:**
- `EnumSchema` now supports titled/untitled variants
- Multi-select enum support via array types
- Response actions remain same (accept, decline, cancel)

**Migration:** Existing form-mode elicitation remains compatible; new features are additive.

### 3. OAuth Client Registration Priority Change

**Impact:** High
**Files:** `src/auth/*`, `src/routes/well-known.ts`

**Changes:**
- **RECOMMENDED**: OAuth Client ID Metadata Documents (new)
- **OPTIONAL**: Dynamic Client Registration (was SHOULD, now MAY)

**Migration:**
- Existing dynamic registration continues to work
- Add support for Client ID Metadata Documents as preferred method
- Provide configuration options for both approaches

## Implementation Phases

### Phase 1: Schema & Type Updates

**Priority:** Critical
**Dependencies:** None

#### Tasks:

1. **Update Protocol Version**
   - File: `src/schema.ts:38`
   - Change `LATEST_PROTOCOL_VERSION` to `'draft'`
   - Update all spec reference comments

2. **Add Icon Metadata Types**
   - File: `src/schema.ts`
   - Add `IconResource` interface:
     ```typescript
     export interface IconResource {
       src: string      // URL to icon image
       mimeType?: string // e.g., "image/png"
       sizes?: string   // e.g., "16x16", "32x32"
     }
     ```
   - Update `Tool`, `Resource`, `Prompt`, `ResourceTemplate` interfaces:
     ```typescript
     export interface Tool {
       name: string
       description?: string
       inputSchema: object
       title?: string        // NEW
       outputSchema?: object // NEW
       icons?: IconResource[] // NEW
     }
     ```

3. **Add Enhanced Enum Schema Types**
   - File: `src/schema.ts`
   - Update `EnumSchema` to support titled variants:
     ```typescript
     // Untitled single-select
     type UntitledEnumSchema = {
       type: 'string' | 'number'
       enum: Array<string | number>
     }

     // Titled single-select
     type TitledEnumSchema = {
       type: 'string' | 'number'
       oneOf: Array<{
         const: string | number
         title: string
       }>
     }

     // Untitled multi-select
     type UntitledMultiSelectSchema = {
       type: 'array'
       items: {
         type: 'string' | 'number'
         enum: Array<string | number>
       }
       minItems?: number
       maxItems?: number
     }

     // Titled multi-select
     type TitledMultiSelectSchema = {
       type: 'array'
       items: {
         type: 'string' | 'number'
         oneOf: Array<{
           const: string | number
           title: string
         }>
       }
       minItems?: number
       maxItems?: number
     }
     ```

4. **Add URL Mode Elicitation Types**
   - File: `src/schema.ts`
   - Add new elicitation request types:
     ```typescript
     export interface FormElicitationRequest {
       mode: 'form'
       message: string
       requestedSchema: JSONSchema
     }

     export interface URLElicitationRequest {
       mode: 'url'
       elicitationId: string
       url: string
       message: string
     }

     export type ElicitationCreateRequest =
       | FormElicitationRequest
       | URLElicitationRequest
     ```

5. **Add Sampling Tool Support Types**
   - File: `src/schema.ts`
   - Add tool-calling types for sampling:
     ```typescript
     export interface SamplingTool {
       name: string
       description: string
       inputSchema: object
     }

     export type ToolChoice =
       | { mode: 'auto' }
       | { mode: 'required' }
       | { mode: 'none' }

     export interface CreateMessageRequest {
       messages: Message[]
       modelPreferences?: ModelPreferences
       systemPrompt?: string
       maxTokens: number
       tools?: SamplingTool[]      // NEW
       toolChoice?: ToolChoice      // NEW
     }

     export interface ToolUseContent {
       type: 'tool_use'
       id: string
       name: string
       input: object
     }

     export interface ToolResultContent {
       type: 'tool_result'
       toolUseId: string
       content?: string
       isError?: boolean
     }
     ```

6. **Add Tasks Types (Experimental)**
   - File: `src/schema.ts`
   - Add complete task type definitions:
     ```typescript
     export type TaskStatus =
       | 'working'
       | 'input_required'
       | 'completed'
       | 'failed'
       | 'cancelled'

     export interface TaskAugmentation {
       ttl?: number  // milliseconds
     }

     export interface CreateTaskResult {
       task: {
         taskId: string
         status: TaskStatus
         statusMessage?: string
         createdAt: string  // ISO 8601
         ttl: number
         pollInterval?: number
       }
       _meta?: {
         'io.modelcontextprotocol/related-task'?: {
           taskId: string
         }
         'io.modelcontextprotocol/model-immediate-response'?: string
       }
     }

     export interface TaskCapabilities {
       list?: {}
       cancel?: {}
       requests?: {
         tools?: {
           call?: {}
         }
         sampling?: {
           createMessage?: {}
         }
         elicitation?: {
           create?: {}
         }
       }
     }
     ```

7. **Add Logging Types**
   - File: `src/schema.ts`
   - Add logging capability types:
     ```typescript
     export type LogLevel =
       | 'debug'
       | 'info'
       | 'notice'
       | 'warning'
       | 'error'
       | 'critical'
       | 'alert'
       | 'emergency'

     export interface SetLogLevelRequest {
       level: LogLevel
     }

     export interface LogNotification {
       level: LogLevel
       logger?: string
       data: unknown
     }
     ```

8. **Add Completion Types**
   - File: `src/schema.ts`
   - Add completion/autocompletion types:
     ```typescript
     export interface CompletionReference {
       type: 'ref/prompt' | 'ref/resource'
       uri?: string  // for resource templates
       name?: string // for prompts
     }

     export interface CompleteRequest {
       ref: CompletionReference
       argument: {
         name: string
         value: string
       }
       arguments?: Record<string, string>
     }

     export interface CompleteResult {
       completion: {
         values: string[]
         total?: number
         hasMore?: boolean
       }
     }
     ```

9. **Add Roots Types**
   - File: `src/schema.ts`
   - Add roots capability types:
     ```typescript
     export interface Root {
       uri: string      // MUST be file:// URI
       name?: string
     }

     export interface RootsListResult {
       roots: Root[]
     }
     ```

10. **Update ServerCapabilities**
    - File: `src/schema.ts`
    - Add new capabilities:
      ```typescript
      export interface ServerCapabilities {
        tools?: {
          listChanged?: boolean
          taskHint?: 'never' | 'optional' | 'always'
        }
        resources?: {
          subscribe?: boolean
          listChanged?: boolean
        }
        prompts?: {
          listChanged?: boolean
        }
        logging?: {}           // NEW
        completions?: {}       // NEW
        tasks?: TaskCapabilities  // NEW (experimental)
        experimental?: Record<string, object>
      }
      ```

11. **Update ClientCapabilities**
    - File: `src/schema.ts`
    - Add new client capabilities:
      ```typescript
      export interface ClientCapabilities {
        roots?: {
          listChanged?: boolean
        }
        sampling?: {
          tools?: {}  // NEW
        }
        elicitation?: {}
        tasks?: TaskCapabilities  // NEW (experimental)
        experimental?: Record<string, object>
      }
      ```

### Phase 2: Authorization Enhancements

**Priority:** High
**Dependencies:** Phase 1

#### Tasks:

1. **Add OpenID Connect Discovery Support**
   - File: `src/auth/discovery.ts` (NEW)
   - Implement discovery endpoint resolution:
     ```typescript
     async function discoverAuthorizationServer(issuer: string): Promise<AuthServerMetadata> {
       // Try OAuth 2.0 AS Metadata endpoints first
       const oauthEndpoints = [
         `${issuer}/.well-known/oauth-authorization-server`,
         // For issuers with paths...
       ]

       // Then try OpenID Connect Discovery endpoints
       const oidcEndpoints = [
         `${issuer}/.well-known/openid-configuration`,
         // For issuers with paths...
       ]

       // Try all endpoints in order, return first successful response
     }
     ```

2. **Implement OAuth Client ID Metadata Documents**
   - File: `src/auth/client-metadata.ts` (NEW)
   - Create metadata document generator:
     ```typescript
     export interface ClientMetadata {
       client_id: string  // MUST be HTTPS URL with path
       client_name: string
       redirect_uris: string[]
       grant_types: string[]
       token_endpoint_auth_method: 'none' | 'private_key_jwt'
       jwks_uri?: string
       jwks?: object
     }

     export function generateClientMetadata(config: AuthConfig): ClientMetadata {
       // Generate metadata document
     }
     ```
   - Add route to serve client metadata:
     ```typescript
     // src/routes/well-known.ts
     app.get('/oauth/client-metadata.json', async (request, reply) => {
       return generateClientMetadata(opts.authConfig)
     })
     ```

3. **Add Incremental Scope Consent Support**
   - File: `src/auth/scope-challenge.ts` (NEW)
   - Implement WWW-Authenticate scope parameter:
     ```typescript
     export function createScopeChallenge(
       requiredScopes: string[],
       resourceMetadataUrl: string
     ): string {
       return `Bearer error="insufficient_scope", ` +
              `scope="${requiredScopes.join(' ')}", ` +
              `resource_metadata="${resourceMetadataUrl}"`
     }
     ```
   - Update prehandler to send 403 with scope challenge:
     ```typescript
     // src/auth/prehandler.ts
     if (hasInsufficientScopes(token, requiredScopes)) {
       reply.code(403)
       reply.header('WWW-Authenticate', createScopeChallenge(...))
       return reply.send({ error: 'insufficient_scope' })
     }
     ```

4. **Update Protected Resource Metadata**
   - File: `src/routes/well-known.ts`
   - Add optional scope parameter to metadata:
     ```typescript
     export interface ProtectedResourceMetadata {
       resource: string
       authorization_servers: string[]
       scopes_supported?: string[]  // NEW
       bearer_methods_supported?: string[]
     }
     ```
   - Update WWW-Authenticate header generation:
     ```typescript
     function createAuthChallenge(config: AuthConfig): string {
       const parts = [
         `Bearer realm="${config.realm || 'MCP Server'}"`,
         `resource_metadata="${config.resourceMetadataUrl}"`
       ]

       // Add scope if configured
       if (config.defaultScopes?.length) {
         parts.push(`scope="${config.defaultScopes.join(' ')}"`)
       }

       return parts.join(', ')
     }
     ```

5. **Update Authorization Configuration Types**
   - File: `src/types/auth-types.ts`
   - Add new configuration options:
     ```typescript
     export interface AuthorizationConfig {
       enabled: boolean
       issuer: string
       audience: string

       // Discovery options
       discoveryMethod?: 'oauth' | 'oidc' | 'auto'  // NEW, default: 'auto'

       // Client registration options
       clientRegistration?: {
         method: 'metadata-document' | 'dynamic' | 'manual'  // NEW
         metadataUrl?: string  // For metadata-document method
         clientId?: string     // For manual method
         clientSecret?: string // For manual method
       }

       // Scope management
       defaultScopes?: string[]     // NEW
       scopeChallengeEnabled?: boolean  // NEW, default: true

       // Existing options...
       jwksUri?: string
       tokenIntrospectionUri?: string
       // ...
     }
     ```

### Phase 3: New Server Features

**Priority:** Medium-High
**Dependencies:** Phase 1, Phase 2

#### Tasks:

1. **Implement Logging Capability**
   - File: `src/features/logging.ts` (NEW)
   - Create logging service:
     ```typescript
     export class LoggingService {
       private minLevel: LogLevel = 'info'
       private messageBroker: MessageBroker

       async setLevel(level: LogLevel): Promise<void> {
         this.minLevel = level
       }

       async log(
         level: LogLevel,
         data: unknown,
         logger?: string
       ): Promise<void> {
         if (this.shouldLog(level)) {
           await this.messageBroker.publish('mcp/broadcast/notification', {
             method: 'notifications/message',
             params: { level, data, logger }
           })
         }
       }

       private shouldLog(level: LogLevel): boolean {
         // Compare level against minLevel using RFC 5424 hierarchy
       }
     }
     ```
   - Add decorator methods:
     ```typescript
     // src/decorators/logging.ts
     declare module 'fastify' {
       interface FastifyInstance {
         mcpLog: {
           debug: (data: unknown, logger?: string) => Promise<void>
           info: (data: unknown, logger?: string) => Promise<void>
           warning: (data: unknown, logger?: string) => Promise<void>
           error: (data: unknown, logger?: string) => Promise<void>
           // ... all levels
         }
       }
     }
     ```
   - Add handlers:
     ```typescript
     // src/handlers.ts
     async function handleSetLogLevel(
       params: SetLogLevelRequest
     ): Promise<{}> {
       await loggingService.setLevel(params.level)
       return {}
     }
     ```

2. **Implement Completion/Autocompletion**
   - File: `src/features/completion.ts` (NEW)
   - Create completion service:
     ```typescript
     export type CompletionProvider = (
       ref: CompletionReference,
       argument: { name: string, value: string },
       context: Record<string, string>
     ) => Promise<string[]> | string[]

     export class CompletionService {
       private providers = new Map<string, CompletionProvider>()

       registerPromptCompletion(
         promptName: string,
         provider: CompletionProvider
       ): void

       registerResourceCompletion(
         uriPattern: string,
         provider: CompletionProvider
       ): void

       async complete(request: CompleteRequest): Promise<CompleteResult>
     }
     ```
   - Add decorator methods:
     ```typescript
     declare module 'fastify' {
       interface FastifyInstance {
         mcpRegisterPromptCompletion(
           promptName: string,
           provider: CompletionProvider
         ): void

         mcpRegisterResourceCompletion(
           uriPattern: string,
           provider: CompletionProvider
         ): void
       }
     }
     ```

3. **Implement URL Mode Elicitation**
   - File: `src/features/elicitation.ts` (NEW)
   - Extend elicitation handler:
     ```typescript
     async function handleElicitationCreate(
       params: ElicitationCreateRequest
     ): Promise<ElicitationResult> {
       if (params.mode === 'url') {
         // Store elicitation request with ID
         await elicitationStore.set(params.elicitationId, {
           url: params.url,
           message: params.message,
           status: 'pending'
         })

         // Send to client without content
         return { action: 'accept' }
       } else {
         // Existing form mode logic
       }
     }
     ```
   - Add completion notification:
     ```typescript
     // src/routes/mcp.ts or dedicated elicitation routes
     app.post('/elicitation/:id/complete', async (request, reply) => {
       const { id } = request.params
       const elicitation = await elicitationStore.get(id)

       // Verify user identity matches initiator
       if (!verifyElicitationUser(elicitation, request.authContext)) {
         return reply.code(403).send({ error: 'Unauthorized' })
       }

       // Send completion notification
       await messageBroker.publish(`mcp/elicitation/${id}/complete`, {
         method: 'notifications/elicitation/complete',
         params: { elicitationId: id }
       })

       return { success: true }
     })
     ```
   - Add URLElicitationRequiredError (-32042):
     ```typescript
     export class URLElicitationRequiredError extends Error {
       code = -32042
       data: {
         elicitations: Array<{
           elicitationId: string
           url: string
           message: string
         }>
       }
     }
     ```

4. **Add Icon Metadata Support**
   - File: `src/decorators/meta.ts`
   - Update tool/resource/prompt registration to accept icons:
     ```typescript
     mcpAddTool({
       name: 'calculator',
       description: 'Perform calculations',
       title: 'Calculator Tool',
       icons: [
         {
           src: 'https://example.com/icons/calculator.png',
           mimeType: 'image/png',
           sizes: '32x32'
         }
       ],
       inputSchema: { /* ... */ }
     }, handler)
     ```

### Phase 4: Client Feature Support

**Priority:** Medium
**Dependencies:** Phase 1

#### Tasks:

1. **Implement Sampling with Tool Calling**
   - File: `src/handlers.ts`
   - Add sampling request handler:
     ```typescript
     async function handleSamplingCreateMessage(
       params: CreateMessageRequest,
       context: HandlerContext
     ): Promise<CreateMessageResult> {
       // Validate client has declared sampling.tools capability
       if (params.tools && !hasToolsCapability(context)) {
         throw new Error('Client does not support tool use in sampling')
       }

       // Forward to client's sampling implementation
       // This is client-side functionality, so we're just validating
       // and forwarding the request structure
     }
     ```
   - Add tool result validation:
     ```typescript
     function validateToolResults(messages: Message[]): void {
       for (const message of messages) {
         if (message.role === 'user') {
           const hasToolResults = message.content.some(
             c => c.type === 'tool_result'
           )
           const hasOtherContent = message.content.some(
             c => c.type !== 'tool_result'
           )

           if (hasToolResults && hasOtherContent) {
             throw new Error(
               'User messages with tool_result MUST contain ONLY tool results'
             )
           }
         }
       }
     }
     ```

2. **Implement Roots Capability**
   - File: `src/features/roots.ts` (NEW)
   - Create roots service (this is primarily client-side):
     ```typescript
     export class RootsService {
       private roots = new Map<string, Root>()

       async list(): Promise<RootsListResult> {
         return {
           roots: Array.from(this.roots.values())
         }
       }

       async notifyChanged(): Promise<void> {
         await this.messageBroker.publish('mcp/broadcast/notification', {
           method: 'notifications/roots/list_changed',
           params: {}
         })
       }
     }
     ```
   - Add handlers:
     ```typescript
     async function handleRootsList(): Promise<RootsListResult> {
       return await rootsService.list()
     }
     ```

### Phase 5: Tasks Implementation [EXPERIMENTAL]

**Priority:** Low-Medium
**Dependencies:** Phase 1, Phase 3

#### Tasks:

1. **Create Task Store**
   - File: `src/stores/task-store.ts` (NEW)
   - Implement task storage with TTL:
     ```typescript
     export interface StoredTask {
       taskId: string
       status: TaskStatus
       statusMessage?: string
       createdAt: Date
       ttl: number
       pollInterval?: number
       result?: any
       authContext?: AuthorizationContext
     }

     export interface TaskStore {
       create(task: Omit<StoredTask, 'taskId'>): Promise<string>
       get(taskId: string): Promise<StoredTask | null>
       update(taskId: string, updates: Partial<StoredTask>): Promise<void>
       delete(taskId: string): Promise<void>
       list(authContext?: AuthorizationContext): Promise<StoredTask[]>
       cleanup(): Promise<number>  // Remove expired tasks
     }

     export class MemoryTaskStore implements TaskStore {
       // Implementation with Map and periodic cleanup
     }

     export class RedisTaskStore implements TaskStore {
       // Implementation with Redis and TTL
     }
     ```

2. **Implement Task Lifecycle Management**
   - File: `src/features/tasks.ts` (NEW)
   - Create task service:
     ```typescript
     export class TaskService {
       constructor(
         private taskStore: TaskStore,
         private messageBroker: MessageBroker
       ) {}

       async createTask(
         ttl: number,
         authContext?: AuthorizationContext
       ): Promise<CreateTaskResult> {
         const taskId = crypto.randomUUID()
         const createdAt = new Date().toISOString()
         const pollInterval = Math.min(ttl / 10, 5000)

         await this.taskStore.create({
           status: 'working',
           createdAt: new Date(),
           ttl,
           pollInterval,
           authContext
         })

         return {
           task: {
             taskId,
             status: 'working',
             createdAt,
             ttl,
             pollInterval
           }
         }
       }

       async getTask(
         taskId: string,
         authContext?: AuthorizationContext
       ): Promise<TaskStatusResult> {
         const task = await this.taskStore.get(taskId)
         if (!task) {
           throw new InvalidParamsError('Task not found')
         }

         // Verify authorization
         if (!this.verifyTaskAccess(task, authContext)) {
           throw new InvalidParamsError('Task not found')
         }

         return {
           taskId: task.taskId,
           status: task.status,
           statusMessage: task.statusMessage,
           createdAt: task.createdAt.toISOString(),
           ttl: task.ttl,
           pollInterval: task.pollInterval
         }
       }

       async getTaskResult(
         taskId: string,
         authContext?: AuthorizationContext
       ): Promise<any> {
         const task = await this.taskStore.get(taskId)
         if (!task) {
           throw new InvalidParamsError('Task not found')
         }

         // Verify authorization
         if (!this.verifyTaskAccess(task, authContext)) {
           throw new InvalidParamsError('Task not found')
         }

         // Block until terminal status if not terminal
         if (!this.isTerminal(task.status)) {
           await this.waitForTerminal(taskId)
         }

         return task.result
       }

       async cancelTask(
         taskId: string,
         authContext?: AuthorizationContext
       ): Promise<void> {
         const task = await this.taskStore.get(taskId)
         if (!task) {
           throw new InvalidParamsError('Task not found')
         }

         if (this.isTerminal(task.status)) {
           throw new InvalidParamsError('Cannot cancel terminal task')
         }

         await this.taskStore.update(taskId, {
           status: 'cancelled',
           statusMessage: 'Cancelled by user'
         })

         await this.notifyStatusChange(taskId)
       }

       async notifyStatusChange(taskId: string): Promise<void> {
         const task = await this.taskStore.get(taskId)
         if (!task) return

         // Optional notification
         await this.messageBroker.publish(
           `mcp/task/${taskId}/status`,
           {
             method: 'notifications/tasks/status',
             params: {
               taskId: task.taskId,
               status: task.status,
               statusMessage: task.statusMessage,
               createdAt: task.createdAt.toISOString(),
               ttl: task.ttl,
               pollInterval: task.pollInterval
             }
           }
         )
       }

       private isTerminal(status: TaskStatus): boolean {
         return ['completed', 'failed', 'cancelled'].includes(status)
       }

       private async waitForTerminal(
         taskId: string,
         timeout = 300000
       ): Promise<void> {
         // Poll or use pub/sub to wait for terminal status
       }
     }
     ```

3. **Add Task-Augmented Request Support**
   - File: `src/handlers.ts`
   - Update tool call handler:
     ```typescript
     async function handleToolsCall(
       params: CallToolParams & { task?: TaskAugmentation },
       context: HandlerContext
     ): Promise<CallToolResult | CreateTaskResult> {
       // Check if task augmentation is present
       if (params.task) {
         // Validate capability support
         if (!supportsTaskAugmentation('tools', 'call')) {
           throw new InvalidRequestError(
             'Task augmentation not supported for tools/call'
           )
         }

         // Create task
         const taskResult = await taskService.createTask(
           params.task.ttl || 60000,
           context.authContext
         )

         // Execute tool asynchronously
         executeToolAsync(
           params.name,
           params.arguments,
           taskResult.task.taskId,
           context
         )

         return taskResult
       }

       // Normal synchronous execution
       return await executeTool(params.name, params.arguments, context)
     }

     async function executeToolAsync(
       name: string,
       args: any,
       taskId: string,
       context: HandlerContext
     ): Promise<void> {
       try {
         // Update task to working
         await taskService.taskStore.update(taskId, {
           status: 'working'
         })

         // Execute tool
         const result = await executeTool(name, args, context)

         // Store result and mark completed
         await taskService.taskStore.update(taskId, {
           status: 'completed',
           result
         })

         await taskService.notifyStatusChange(taskId)
       } catch (error) {
         // Mark as failed
         await taskService.taskStore.update(taskId, {
           status: 'failed',
           statusMessage: error.message,
           result: {
             isError: true,
             content: [{ type: 'text', text: error.message }]
           }
         })

         await taskService.notifyStatusChange(taskId)
       }
     }
     ```

4. **Add Task Metadata to Messages**
   - File: `src/handlers.ts`
   - Implement _meta field population:
     ```typescript
     function addTaskMetadata(
       message: JSONRPCMessage,
       taskId: string
     ): JSONRPCMessage {
       return {
         ...message,
         params: {
           ...message.params,
           _meta: {
             ...message.params?._meta,
             'io.modelcontextprotocol/related-task': { taskId }
           }
         }
       }
     }
     ```

### Phase 6: Testing & Documentation

**Priority:** High
**Dependencies:** All previous phases

#### Tasks:

1. **Update Test Suites**
   - Add tests for OpenID Connect Discovery
   - Add tests for Client ID Metadata Documents
   - Add tests for incremental scope consent
   - Add tests for icon metadata
   - Add tests for enhanced enum schemas
   - Add tests for URL mode elicitation
   - Add tests for tool calling in sampling
   - Add tests for logging capability
   - Add tests for completion capability
   - Add tests for roots capability
   - Add comprehensive task lifecycle tests
   - Add security tests for task authorization

2. **Update Documentation**
   - Update README with new features
   - Create migration guide from 2025-06-18 to draft
   - Add examples for all new features
   - Document breaking changes
   - Update API reference
   - Add security best practices guide

3. **Update TypeScript Definitions**
   - Ensure all exported types are complete
   - Add JSDoc comments for new APIs
   - Generate updated type documentation

## Testing Strategy

### Unit Tests

- All new type definitions
- Schema validation functions
- Authorization discovery logic
- Task lifecycle state transitions
- Logging level comparisons
- Completion providers

### Integration Tests

- Full OAuth flow with OIDC Discovery
- Client ID Metadata Document registration
- Incremental scope consent flow
- Task-augmented tool calls with polling
- URL mode elicitation with completion
- Multi-turn tool calling in sampling
- Logging across distributed instances
- Completion for prompts and resources

### Security Tests

- Task authorization boundary enforcement
- URL elicitation user identity verification
- Token audience validation
- Scope challenge handling
- SSRF protection in Client ID Metadata fetching

### Performance Tests

- Task store cleanup under load
- Concurrent task creation/polling
- Large-scale logging message throughput
- Completion provider response times

## Migration Guide

### For Library Users

#### Breaking Changes

**None** - All changes are backward compatible.

#### New Features to Adopt

1. **Icon Metadata** (Optional)
   ```typescript
   app.mcpAddTool({
     name: 'search',
     description: 'Search the web',
     icons: [{
       src: 'https://example.com/search-icon.png',
       mimeType: 'image/png',
       sizes: '32x32'
     }],
     inputSchema: { /* ... */ }
   }, handler)
   ```

2. **OAuth Client ID Metadata Documents** (Recommended)
   ```typescript
   await app.register(mcpPlugin, {
     authorization: {
       enabled: true,
       issuer: 'https://auth.example.com',
       audience: 'https://mcp.example.com',
       clientRegistration: {
         method: 'metadata-document',
         metadataUrl: 'https://mcp.example.com/oauth/client-metadata.json'
       }
     }
   })
   ```

3. **Logging Capability**
   ```typescript
   await app.register(mcpPlugin, {
     capabilities: {
       logging: {}
     }
   })

   // Use logging
   await app.mcpLog.info({ event: 'tool_called', tool: 'search' })
   ```

4. **Tasks (Experimental)**
   ```typescript
   await app.register(mcpPlugin, {
     capabilities: {
       tasks: {
         list: {},
         cancel: {},
         requests: {
           tools: { call: {} }
         }
       }
     }
   })

   // Client can now send task-augmented requests
   ```

### For Library Maintainers

1. Update protocol version constant
2. Implement each phase sequentially
3. Maintain backward compatibility
4. Add feature flags for experimental features
5. Update all specification references in code comments

## Implementation Checklist

- [ ] Phase 1: Schema & Type Updates
  - [ ] Update protocol version
  - [ ] Add icon metadata types
  - [ ] Add enhanced enum schema types
  - [ ] Add URL mode elicitation types
  - [ ] Add sampling tool support types
  - [ ] Add tasks types
  - [ ] Add logging types
  - [ ] Add completion types
  - [ ] Add roots types
  - [ ] Update server/client capabilities

- [ ] Phase 2: Authorization Enhancements
  - [ ] OpenID Connect Discovery
  - [ ] OAuth Client ID Metadata Documents
  - [ ] Incremental scope consent
  - [ ] Updated Protected Resource Metadata
  - [ ] Configuration type updates

- [ ] Phase 3: New Server Features
  - [ ] Logging capability
  - [ ] Completion/autocompletion
  - [ ] URL mode elicitation
  - [ ] Icon metadata support

- [ ] Phase 4: Client Feature Support
  - [ ] Sampling with tool calling
  - [ ] Roots capability

- [ ] Phase 5: Tasks Implementation
  - [ ] Task store (memory & Redis)
  - [ ] Task lifecycle management
  - [ ] Task-augmented request support
  - [ ] Task metadata handling

- [ ] Phase 6: Testing & Documentation
  - [ ] Unit tests
  - [ ] Integration tests
  - [ ] Security tests
  - [ ] Performance tests
  - [ ] Documentation updates
  - [ ] Migration guide

## Risk Assessment

### High Risk
- **Tasks Implementation**: Complex state management, requires careful testing
- **OAuth Client ID Metadata**: Security-sensitive, SSRF risks

### Medium Risk
- **Tool Calling in Sampling**: Multi-turn loop complexity
- **URL Mode Elicitation**: User identity verification critical

### Low Risk
- **Icon Metadata**: Simple additive feature
- **Logging Capability**: Well-defined patterns
- **Completion**: Straightforward provider pattern

## Success Criteria

1. ✅ All tests pass (unit, integration, security, performance)
2. ✅ 100% backward compatibility maintained
3. ✅ All new spec features implemented
4. ✅ Documentation complete and accurate
5. ✅ Migration guide validated with real-world scenarios
6. ✅ Security audit passed for new authorization features
7. ✅ Performance benchmarks meet or exceed current version
8. ✅ Zero breaking changes for existing users
