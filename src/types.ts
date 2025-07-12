import type { FastifyReply } from 'fastify'
import type {
  JSONRPCMessage,
  JSONRPCNotification,
  CallToolResult,
  ReadResourceResult,
  GetPromptResult,
  ServerCapabilities,
  Implementation
} from './schema.ts'

declare module 'fastify' {
  interface FastifyInstance {
    mcpAddTool: (definition: any, handler?: ToolHandler) => void
    mcpAddResource: (definition: any, handler?: ResourceHandler) => void
    mcpAddPrompt: (definition: any, handler?: PromptHandler) => void
    mcpSessions: Map<string, SSESession>
    mcpBroadcastNotification: (notification: JSONRPCNotification) => void
    mcpSendToSession: (sessionId: string, message: JSONRPCMessage) => boolean
  }
}

export type ToolHandler = (params: any, context?: { sessionId?: string }) => Promise<CallToolResult> | CallToolResult
export type ResourceHandler = (uri: string) => Promise<ReadResourceResult> | ReadResourceResult
export type PromptHandler = (name: string, args?: any) => Promise<GetPromptResult> | GetPromptResult

export interface MCPTool {
  definition: any
  handler?: ToolHandler
}

export interface MCPResource {
  definition: any
  handler?: ResourceHandler
}

export interface MCPPrompt {
  definition: any
  handler?: PromptHandler
}

export interface MCPPluginOptions {
  serverInfo?: Implementation
  capabilities?: ServerCapabilities
  instructions?: string
  enableSSE?: boolean
}

export interface SSESession {
  id: string
  eventId: number
  streams: Set<FastifyReply>
  lastEventId?: string
  messageHistory: Array<{ eventId: string, message: JSONRPCMessage }>
}