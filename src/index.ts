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
    mcpBroadcastNotification: (notification: JSONRPCNotification) => void
    mcpSendToSession: (sessionId: string, message: JSONRPCMessage) => boolean
  }
}

type ToolHandler = (params: any, context?: { sessionId?: string }) => Promise<CallToolResult> | CallToolResult
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
  messageHistory: Array<{ eventId: string, message: JSONRPCMessage }>
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

  async function handleRequest (request: JSONRPCRequest, sessionId?: string): Promise<JSONRPCResponse | JSONRPCError> {
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

  async function processMessage (message: JSONRPCMessage, sessionId?: string): Promise<JSONRPCResponse | JSONRPCError | null> {
    if ('id' in message && 'method' in message) {
      return await handleRequest(message as JSONRPCRequest, sessionId)
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
      lastEventId: undefined,
      messageHistory: []
    }
    app.mcpSessions.set(sessionId, session)
    return session
  }

  function supportsSSE (request: FastifyRequest): boolean {
    const accept = request.headers.accept
    return accept ? accept.includes('text/event-stream') : false
  }

  function replayMessagesFromEventId (session: SSESession, lastEventId: string, stream: FastifyReply): void {
    // Find the index of the last received event
    const lastIndex = session.messageHistory.findIndex(entry => entry.eventId === lastEventId)

    if (lastIndex !== -1) {
      // Replay messages after the last received event
      const messagesToReplay = session.messageHistory.slice(lastIndex + 1)

      for (const entry of messagesToReplay) {
        const sseEvent = `id: ${entry.eventId}\ndata: ${JSON.stringify(entry.message)}\n\n`
        try {
          stream.raw.write(sseEvent)
        } catch (error) {
          app.log.error('Failed to replay SSE event:', error)
          break
        }
      }

      if (messagesToReplay.length > 0) {
        app.log.info(`Replayed ${messagesToReplay.length} messages from event ID: ${lastEventId}`)
      }
    } else {
      app.log.warn(`Event ID ${lastEventId} not found in message history`)
    }
  }

  function sendSSEMessage (session: SSESession, message: JSONRPCMessage): void {
    const eventId = (++session.eventId).toString()
    const sseEvent = `id: ${eventId}\ndata: ${JSON.stringify(message)}\n\n`
    session.lastEventId = eventId

    // Store message in history for resumability
    session.messageHistory.push({ eventId, message })
    // Keep only last 100 messages to prevent memory leaks
    if (session.messageHistory.length > 100) {
      session.messageHistory.shift()
    }

    // Send to all connected streams in this session
    const deadStreams = new Set<FastifyReply>()
    for (const stream of session.streams) {
      try {
        stream.raw.write(sseEvent)
      } catch (error) {
        app.log.error('Failed to write SSE event:', error)
        deadStreams.add(stream)
      }
    }

    // Clean up dead streams
    for (const deadStream of deadStreams) {
      session.streams.delete(deadStream)
    }

    // Clean up session if no streams left
    if (session.streams.size === 0) {
      app.log.info({
        sessionId: session.id
      }, 'Session has no active streams, cleaning up')
      app.mcpSessions.delete(session.id)
    }
  }

  app.post('/mcp', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const message = request.body as JSONRPCMessage
      const sessionId = request.headers['mcp-session-id'] as string
      const useSSE = enableSSE && supportsSSE(request)

      if (useSSE) {
        reply.hijack()
        request.log.info({ sessionId }, 'Handling SSE request')

        // Set up SSE stream
        reply.raw.setHeader('content-type', 'text/event-stream')

        let session: SSESession
        if (sessionId && app.mcpSessions.has(sessionId)) {
          session = app.mcpSessions.get(sessionId)!
        } else {
          session = createSSESession()
          reply.raw.setHeader('Mcp-Session-Id', session.id)
        }

        // Set up persistent SSE connection
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Access-Control-Allow-Origin': '*',
          'Mcp-Session-Id': session.id
        })

        // Add this connection to the session's streams
        session.streams.add(reply)

        // Handle connection close
        reply.raw.on('close', () => {
          app.log.info({
            sessionId: session.id,
            remainingStreams: session.streams.size - 1
          }, 'POST SSE connection closed')

          session.streams.delete(reply)
          if (session.streams.size === 0) {
            app.log.info({
              sessionId: session.id
            }, 'Last POST SSE stream closed, cleaning up session')
            app.mcpSessions.delete(session.id)
          }
        })

        // Process message and send via SSE
        const response = await processMessage(message, sessionId)
        if (response) {
          // Send the SSE event but keep the stream open
          const eventId = (++session.eventId).toString()
          const sseEvent = `id: ${eventId}\ndata: ${JSON.stringify(response)}\n\n`
          reply.raw.write(sseEvent)

          // Store message in history for resumability
          session.messageHistory.push({ eventId, message: response })
          // Keep only last 100 messages to prevent memory leaks
          if (session.messageHistory.length > 100) {
            session.messageHistory.shift()
          }
        } else {
          reply.raw.write(': heartbeat\n\n')
        }
      } else {
        // Regular JSON response
        reply.type('application/json')
        const response = await processMessage(message, sessionId)
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
      const sessionId = (request.headers['mcp-session-id'] as string) ||
                       (request.query as any)['mcp-session-id']

      request.log.info({ sessionId }, 'Handling SSE request')

      // We are opting out of Fastify proper
      reply.hijack()

      const raw = reply.raw

      // Set up SSE stream
      raw.setHeader('Content-type', 'text/event-stream')
      raw.setHeader('Cache-Control', 'no-cache')

      let session: SSESession
      if (sessionId && app.mcpSessions.has(sessionId)) {
        session = app.mcpSessions.get(sessionId)!
      } else {
        session = createSSESession()
        raw.setHeader('Mcp-Session-Id', session.id)
      }

      raw.writeHead(200)

      session.streams.add(reply)

      // Handle resumability with Last-Event-ID
      const lastEventId = request.headers['last-event-id'] as string
      if (lastEventId && session.messageHistory.length > 0) {
        app.log.info(`Resuming SSE stream from event ID: ${lastEventId}`)
        replayMessagesFromEventId(session, lastEventId, reply)
      }

      // Handle connection close
      reply.raw.on('close', () => {
        app.log.info({
          sessionId: session.id,
          remainingStreams: session.streams.size - 1
        }, 'SSE connection closed')

        session.streams.delete(reply)
        if (session.streams.size === 0) {
          app.log.info({
            sessionId: session.id
          }, 'Last SSE stream closed, cleaning up session')
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
      heartbeatInterval.unref()

      reply.raw.on('close', () => {
        app.log.info({
          sessionId: session.id
        }, 'SSE heartbeat connection closed')
        clearInterval(heartbeatInterval)
      })
    } catch (error) {
      app.log.error('Error setting up SSE stream:', error)
      reply.type('application/json').code(500).send({ error: 'Internal server error' })
    }
  })

  app.decorate('mcpSessions', new Map<string, SSESession>())

  app.decorate('mcpBroadcastNotification', (notification: JSONRPCNotification) => {
    if (!enableSSE) {
      app.log.warn('Cannot broadcast notification: SSE is disabled')
      return
    }

    for (const session of app.mcpSessions.values()) {
      if (session.streams.size > 0) {
        sendSSEMessage(session, notification)
      }
    }
  })

  app.decorate('mcpSendToSession', (sessionId: string, message: JSONRPCMessage): boolean => {
    if (!enableSSE) {
      app.log.warn('Cannot send to session: SSE is disabled')
      return false
    }

    const session = app.mcpSessions.get(sessionId)
    if (!session || session.streams.size === 0) {
      return false
    }

    sendSSEMessage(session, message)
    return true
  })

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
