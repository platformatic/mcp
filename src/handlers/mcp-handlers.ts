import type { FastifyInstance } from 'fastify'
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
  ListPromptsResult,
  CallToolRequest,
  CallToolResult,
  ReadResourceRequest,
  ReadResourceResult,
  GetPromptRequest,
  GetPromptResult
} from '../schema.ts'

import {
  JSONRPC_VERSION,
  LATEST_PROTOCOL_VERSION,
  METHOD_NOT_FOUND,
  INTERNAL_ERROR
} from '../schema.ts'

import type { MCPTool, MCPResource, MCPPrompt, MCPPluginOptions } from '../types.ts'

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

export async function handleRequest (
  request: JSONRPCRequest,
  sessionId: string | undefined,
  dependencies: {
    app: FastifyInstance
    opts: MCPPluginOptions
    capabilities: any
    serverInfo: any
    tools: Map<string, MCPTool>
    resources: Map<string, MCPResource>
    prompts: Map<string, MCPPrompt>
  }
): Promise<JSONRPCResponse | JSONRPCError> {
  const { app, opts, capabilities, serverInfo, tools, resources, prompts } = dependencies

  app.log.info({
    method: request.method,
    id: request.id,
    sessionId
  }, `JSON-RPC method invoked: ${request.method}`)

  try {
    switch (request.method) {
      case 'initialize': {
        const result: InitializeResult = {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities,
          serverInfo,
          instructions: opts.instructions
        }
        return createResponse(request.id, result)
      }

      case 'ping': {
        const result: EmptyResult = {}
        return createResponse(request.id, result)
      }

      case 'tools/list': {
        const result: ListToolsResult = {
          tools: Array.from(tools.values()).map(t => t.definition),
          nextCursor: undefined
        }
        return createResponse(request.id, result)
      }

      case 'resources/list': {
        const result: ListResourcesResult = {
          resources: Array.from(resources.values()).map(r => r.definition),
          nextCursor: undefined
        }
        return createResponse(request.id, result)
      }

      case 'prompts/list': {
        const result: ListPromptsResult = {
          prompts: Array.from(prompts.values()).map(p => p.definition),
          nextCursor: undefined
        }
        return createResponse(request.id, result)
      }

      case 'tools/call': {
        const params = request.params as CallToolRequest['params']
        const toolName = params?.name

        if (!toolName) {
          return createError(request.id, INTERNAL_ERROR, 'Tool name is required')
        }

        const tool = tools.get(toolName)
        if (!tool) {
          return createError(request.id, METHOD_NOT_FOUND, `Tool '${toolName}' not found`)
        }

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

        try {
          const result = await tool.handler(params.arguments || {}, { sessionId })
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

      case 'resources/read': {
        const params = request.params as ReadResourceRequest['params']
        const uri = params?.uri

        if (!uri) {
          return createError(request.id, INTERNAL_ERROR, 'Resource URI is required')
        }

        const resource = resources.get(uri)
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

        try {
          const result = await resource.handler(uri)
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

      case 'prompts/get': {
        const params = request.params as GetPromptRequest['params']
        const promptName = params?.name

        if (!promptName) {
          return createError(request.id, INTERNAL_ERROR, 'Prompt name is required')
        }

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

        try {
          const result = await prompt.handler(promptName, params.arguments)
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
  dependencies: {
    app: FastifyInstance
    opts: MCPPluginOptions
    capabilities: any
    serverInfo: any
    tools: Map<string, MCPTool>
    resources: Map<string, MCPResource>
    prompts: Map<string, MCPPrompt>
  }
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
