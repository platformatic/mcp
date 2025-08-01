import type { FastifyReply } from 'fastify'
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
  ElicitRequest,
  RequestId
} from './schema.ts'
import type { Static, TSchema, TObject, TString } from '@sinclair/typebox'
import type { AuthorizationConfig } from './types/auth-types.ts'

// Generic handler types with TypeBox schema support
export type ToolHandler<TSchema extends TObject = TObject> = (
  params: Static<TSchema>,
  context?: { sessionId?: string }
) => Promise<CallToolResult> | CallToolResult

export type ResourceHandler<TUriSchema extends TSchema = TString> = (
  uri: Static<TUriSchema>
) => Promise<ReadResourceResult> | ReadResourceResult

export type PromptHandler<TArgsSchema extends TObject = TObject> = (
  name: string,
  args: Static<TArgsSchema>
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
      requestedSchema: ElicitRequest['params']['requestedSchema'],
      requestId?: RequestId
    ) => Promise<boolean>
  }
}

// Unsafe handler types for backward compatibility
export type UnsafeToolHandler = (params: any, context?: { sessionId?: string }) => Promise<CallToolResult> | CallToolResult
export type UnsafeResourceHandler = (uri: string) => Promise<ReadResourceResult> | ReadResourceResult
export type UnsafePromptHandler = (name: string, args?: any) => Promise<GetPromptResult> | GetPromptResult

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

export interface MCPPluginOptions {
  serverInfo?: Implementation
  capabilities?: ServerCapabilities
  instructions?: string
  enableSSE?: boolean
  sessionStore?: 'memory' | 'redis'
  messageBroker?: 'memory' | 'redis'
  redis?: {
    host: string
    port: number
    password?: string
    db?: number
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
