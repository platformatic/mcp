import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { randomUUID } from 'crypto'
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

declare module 'fastify' {
  interface FastifyInstance {
    mcpAddTool: (definition: any, handler?: ToolHandler) => void
    mcpAddResource: (definition: any, handler?: ResourceHandler) => void
    mcpAddPrompt: (definition: any, handler?: PromptHandler) => void
    mcpSessions: Map<string, SSESession>
  }
}

type ToolHandler = (params: any) => Promise<CallToolResult> | CallToolResult
type ResourceHandler = (uri: string) => Promise<ReadResourceResult> | ReadResourceResult
type PromptHandler = (name: string, args?: any) => Promise<GetPromptResult> | GetPromptResult

interface MCPTool {
  definition: any
  handler?: ToolHandler
}

interface MCPResource {
  definition: any
  handler?: ResourceHandler
}

interface MCPPrompt {
  definition: any
  handler?: PromptHandler
}

interface MCPPluginOptions {
  serverInfo?: Implementation
  capabilities?: ServerCapabilities
  instructions?: string
  enableSSE?: boolean
}

interface SSESession {
  id: string
  eventId: number
  streams: Set<FastifyReply>
  lastEventId?: string
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

  const enableSSE = opts.enableSSE ?? false
  const tools = new Map<string, MCPTool>()
  const resources = new Map<string, MCPResource>()
  const prompts = new Map<string, MCPPrompt>()

  function createResponse (id: string | number, result: any): JSONRPCResponse {
    return {
      jsonrpc: JSONRPC_VERSION,
      id,
      result
    }
  }

  function createError (id: string | number, code: number, message: string, data?: any): JSONRPCError {
    return {
      jsonrpc: JSONRPC_VERSION,
      id,
      error: { code, message, data }
    }
  }

  async function handleRequest (request: JSONRPCRequest): Promise<JSONRPCResponse | JSONRPCError> {
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
            const result = await tool.handler(params.arguments || {})
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

  function handleNotification (notification: JSONRPCNotification): void {
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

  async function processMessage (message: JSONRPCMessage): Promise<JSONRPCResponse | JSONRPCError | null> {
    if ('id' in message && 'method' in message) {
      return await handleRequest(message as JSONRPCRequest)
    } else if ('method' in message) {
      handleNotification(message as JSONRPCNotification)
      return null
    } else {
      throw new Error('Invalid JSON-RPC message')
    }
  }

  function createSSESession (): SSESession {
    const sessionId = randomUUID()
    const session: SSESession = {
      id: sessionId,
      eventId: 0,
      streams: new Set(),
      lastEventId: undefined
    }
    app.mcpSessions.set(sessionId, session)
    return session
  }

  function supportsSSE (request: FastifyRequest): boolean {
    const accept = request.headers.accept
    return accept ? accept.includes('text/event-stream') : false
  }

  app.post('/mcp', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const message = request.body as JSONRPCMessage
      const sessionId = request.headers['mcp-session-id'] as string
      const useSSE = enableSSE && supportsSSE(request)

      if (useSSE) {
        // Set up SSE stream
        reply.type('text/event-stream')
        reply.header('Cache-Control', 'no-cache')
        reply.header('Connection', 'keep-alive')
        reply.header('Access-Control-Allow-Origin', '*')
        reply.header('Access-Control-Allow-Headers', 'Cache-Control')

        let session: SSESession
        if (sessionId && app.mcpSessions.has(sessionId)) {
          session = app.mcpSessions.get(sessionId)!
        } else {
          session = createSSESession()
          reply.header('Mcp-Session-Id', session.id)
        }

        // Process message and send via SSE
        const response = await processMessage(message)
        if (response) {
          // Send the SSE event and end the stream
          const eventId = (++session.eventId).toString()
          const sseEvent = `id: ${eventId}\ndata: ${JSON.stringify(response)}\n\n`
          reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'Access-Control-Allow-Origin': '*',
            'Mcp-Session-Id': session.id
          })
          reply.raw.write(sseEvent)
          reply.raw.end()
        } else {
          reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'Access-Control-Allow-Origin': '*',
            'Mcp-Session-Id': session.id
          })
          reply.raw.write(': heartbeat\n\n')
          reply.raw.end()
        }
      } else {
        // Regular JSON response
        reply.type('application/json')
        const response = await processMessage(message)
        if (response) {
          reply.send(response)
        } else {
          reply.code(204).send()
        }
      }
    } catch (error) {
      app.log.error('Error processing MCP message:', error)
      reply.type('application/json').code(500).send({
        jsonrpc: JSONRPC_VERSION,
        id: null,
        error: {
          code: INTERNAL_ERROR,
          message: 'Internal server error'
        }
      })
    }
  })

  // GET endpoint for server-initiated communication via SSE
  app.get('/mcp', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!enableSSE) {
      reply.type('application/json').code(405).send({ error: 'Method Not Allowed: SSE not enabled' })
      return
    }

    if (!supportsSSE(request)) {
      reply.type('application/json').code(405).send({ error: 'Method Not Allowed: SSE not supported' })
      return
    }

    try {
      const sessionId = request.headers['mcp-session-id'] as string

      // Set up SSE stream
      reply.type('text/event-stream')
      reply.header('Cache-Control', 'no-cache')
      reply.header('Connection', 'keep-alive')
      reply.header('Access-Control-Allow-Origin', '*')
      reply.header('Access-Control-Allow-Headers', 'Cache-Control')

      let session: SSESession
      if (sessionId && app.mcpSessions.has(sessionId)) {
        session = app.mcpSessions.get(sessionId)!
      } else {
        session = createSSESession()
        reply.header('Mcp-Session-Id', session.id)
      }

      // Handle resumability with Last-Event-ID
      const lastEventId = request.headers['last-event-id'] as string
      if (lastEventId && session.lastEventId) {
        app.log.info(`Resuming SSE stream from event ID: ${lastEventId}`)
      }

      session.streams.add(reply)

      // Handle connection close
      reply.raw.on('close', () => {
        session.streams.delete(reply)
        if (session.streams.size === 0) {
          app.mcpSessions.delete(session.id)
        }
      })

      // Send initial heartbeat
      reply.raw.write(': heartbeat\n\n')

      // Keep connection alive with periodic heartbeats
      const heartbeatInterval = setInterval(() => {
        try {
          reply.raw.write(': heartbeat\n\n')
        } catch (error) {
          clearInterval(heartbeatInterval)
          session.streams.delete(reply)
        }
      }, 30000) // 30 second heartbeat

      reply.raw.on('close', () => {
        clearInterval(heartbeatInterval)
      })
    } catch (error) {
      app.log.error('Error setting up SSE stream:', error)
      reply.type('application/json').code(500).send({ error: 'Internal server error' })
    }
  })

  app.decorate('mcpSessions', new Map<string, SSESession>())

  app.decorate('mcpAddTool', (definition: any, handler?: ToolHandler) => {
    const name = definition.name
    if (!name) {
      throw new Error('Tool definition must have a name')
    }
    tools.set(name, { definition, handler })
  })

  app.decorate('mcpAddResource', (definition: any, handler?: ResourceHandler) => {
    const uri = definition.uri
    if (!uri) {
      throw new Error('Resource definition must have a uri')
    }
    resources.set(uri, { definition, handler })
  })

  app.decorate('mcpAddPrompt', (definition: any, handler?: PromptHandler) => {
    const name = definition.name
    if (!name) {
      throw new Error('Prompt definition must have a name')
    }
    prompts.set(name, { definition, handler })
  })
}, {
  name: 'fastify-mcp'
})
