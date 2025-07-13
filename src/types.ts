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
    mcpBroadcastNotification: (notification: JSONRPCNotification) => Promise<void>
    mcpSendToSession: (sessionId: string, message: JSONRPCMessage) => Promise<boolean>
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
  sessionStore?: 'memory' | 'redis'
  messageBroker?: 'memory' | 'redis'
  redis?: {
    host: string
    port: number
    password?: string
    db?: number
  }
}

export interface SSESession {
  id: string
  eventId: number
  streams: Set<FastifyReply>
  lastEventId?: string
  messageHistory: Array<{ eventId: string, message: JSONRPCMessage }>
}
