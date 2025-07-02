import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import fp from 'fastify-plugin'
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
  GetPromptResult,
  ServerCapabilities,
  Implementation
} from './schema.ts'

import {
  JSONRPC_VERSION,
  LATEST_PROTOCOL_VERSION,
  METHOD_NOT_FOUND,
  INTERNAL_ERROR
} from './schema.ts'

interface MCPPluginOptions {
  serverInfo?: Implementation
  capabilities?: ServerCapabilities
  instructions?: string
}

export default fp(async function (app: FastifyInstance, opts: MCPPluginOptions) {
  const serverInfo: Implementation = opts.serverInfo ?? {
    name: 'fastify-mcp-server',
    version: '1.0.0'
  }
  
  const capabilities: ServerCapabilities = opts.capabilities ?? {
    tools: {},
    resources: {},
    prompts: {}
  }

  const tools: any[] = []
  const resources: any[] = []
  const prompts: any[] = []

  function createResponse(id: string | number, result: any): JSONRPCResponse {
    return {
      jsonrpc: JSONRPC_VERSION,
      id,
      result
    }
  }

  function createError(id: string | number, code: number, message: string, data?: any): JSONRPCError {
    return {
      jsonrpc: JSONRPC_VERSION,
      id,
      error: { code, message, data }
    }
  }

  async function handleRequest(request: JSONRPCRequest): Promise<JSONRPCResponse | JSONRPCError> {
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
            tools,
            nextCursor: undefined
          }
          return createResponse(request.id, result)
        }

        case 'resources/list': {
          const result: ListResourcesResult = {
            resources,
            nextCursor: undefined
          }
          return createResponse(request.id, result)
        }

        case 'prompts/list': {
          const result: ListPromptsResult = {
            prompts,
            nextCursor: undefined
          }
          return createResponse(request.id, result)
        }

        case 'tools/call': {
          const params = request.params as CallToolRequest['params']
          const result: CallToolResult = {
            content: [{
              type: 'text',
              text: `Tool ${params?.name || 'unknown'} called but not implemented`
            }],
            isError: true
          }
          return createResponse(request.id, result)
        }

        case 'resources/read': {
          const params = request.params as ReadResourceRequest['params']
          const result: ReadResourceResult = {
            contents: [{
              uri: params?.uri || '',
              text: 'Resource not found',
              mimeType: 'text/plain'
            }]
          }
          return createResponse(request.id, result)
        }

        case 'prompts/get': {
          const params = request.params as GetPromptRequest['params']
          const result: GetPromptResult = {
            messages: [{
              role: 'user',
              content: {
                type: 'text',
                text: `Prompt ${params?.name || 'unknown'} not found`
              }
            }]
          }
          return createResponse(request.id, result)
        }

        default:
          return createError(request.id, METHOD_NOT_FOUND, `Method ${request.method} not found`)
      }
    } catch (error) {
      return createError(request.id, INTERNAL_ERROR, 'Internal server error', error)
    }
  }

  function handleNotification(notification: JSONRPCNotification): void {
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

  async function processMessage(message: JSONRPCMessage): Promise<JSONRPCResponse | JSONRPCError | null> {
    if ('id' in message && 'method' in message) {
      return await handleRequest(message as JSONRPCRequest)
    } else if ('method' in message) {
      handleNotification(message as JSONRPCNotification)
      return null
    } else {
      throw new Error('Invalid JSON-RPC message')
    }
  }

  app.post('/mcp', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const message = request.body as JSONRPCMessage
      const response = await processMessage(message)
      
      if (response) {
        reply.send(response)
      } else {
        reply.code(204).send()
      }
    } catch (error) {
      app.log.error('Error processing MCP message:', error)
      reply.code(500).send({
        jsonrpc: JSONRPC_VERSION,
        id: null,
        error: {
          code: INTERNAL_ERROR,
          message: 'Internal server error'
        }
      })
    }
  })

  app.decorate('mcpAddTool', (tool: any) => {
    tools.push(tool)
  })

  app.decorate('mcpAddResource', (resource: any) => {
    resources.push(resource)
  })

  app.decorate('mcpAddPrompt', (prompt: any) => {
    prompts.push(prompt)
  })

}, {
  name: 'fastify-mcp'  
})
