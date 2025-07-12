import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type { JSONRPCMessage } from '../schema.ts'
import { JSONRPC_VERSION, INTERNAL_ERROR } from '../schema.ts'
import type { SSESession, MCPPluginOptions, MCPTool, MCPResource, MCPPrompt } from '../types.ts'
import { processMessage } from '../handlers/mcp-handlers.ts'
import {
  createSSESession,
  supportsSSE,
  hasActiveSSESession,
  replayMessagesFromEventId
} from '../session/sse-session.ts'

export function registerMCPRoutes (
  app: FastifyInstance,
  dependencies: {
    enableSSE: boolean
    opts: MCPPluginOptions
    capabilities: any
    serverInfo: any
    tools: Map<string, MCPTool>
    resources: Map<string, MCPResource>
    prompts: Map<string, MCPPrompt>
  }
): void {
  const { enableSSE, opts, capabilities, serverInfo, tools, resources, prompts } = dependencies

  app.post('/mcp', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const message = request.body as JSONRPCMessage
      const sessionId = request.headers['mcp-session-id'] as string
      const useSSE = enableSSE && supportsSSE(request) && !hasActiveSSESession(sessionId, app.mcpSessions)

      if (useSSE) {
        reply.hijack()
        request.log.info({ sessionId }, 'Handling SSE request')

        // Set up SSE stream
        reply.raw.setHeader('content-type', 'text/event-stream')

        let session: SSESession
        if (sessionId && app.mcpSessions.has(sessionId)) {
          session = app.mcpSessions.get(sessionId)!
        } else {
          session = createSSESession(app.mcpSessions)
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
        app.log.info({
          sessionId: session.id,
          totalStreams: session.streams.size,
          method: 'POST'
        }, 'Added new stream to session')

        // Handle connection close
        const cleanup = () => {
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
        }

        reply.raw.on('close', cleanup)
        reply.raw.on('error', cleanup)

        // Process message and send via SSE
        const response = await processMessage(message, sessionId, {
          app,
          opts,
          capabilities,
          serverInfo,
          tools,
          resources,
          prompts
        })
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
        const response = await processMessage(message, sessionId, {
          app,
          opts,
          capabilities,
          serverInfo,
          tools,
          resources,
          prompts
        })
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

      // Check if there's already an active SSE session
      if (hasActiveSSESession(sessionId, app.mcpSessions)) {
        reply.type('application/json').code(409).send({
          error: 'Conflict: SSE session already active for this session ID'
        })
        return
      }

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
        session = createSSESession(app.mcpSessions)
        raw.setHeader('Mcp-Session-Id', session.id)
      }

      raw.writeHead(200)

      session.streams.add(reply)
      app.log.info({
        sessionId: session.id,
        totalStreams: session.streams.size,
        method: 'GET'
      }, 'Added new stream to session')

      // Handle resumability with Last-Event-ID
      const lastEventId = request.headers['last-event-id'] as string
      if (lastEventId && session.messageHistory.length > 0) {
        app.log.info(`Resuming SSE stream from event ID: ${lastEventId}`)
        replayMessagesFromEventId(session, lastEventId, reply, app)
      }

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

      // Handle connection close
      const cleanup = () => {
        app.log.info({
          sessionId: session.id,
          remainingStreams: session.streams.size - 1
        }, 'SSE connection closed')

        clearInterval(heartbeatInterval)
        session.streams.delete(reply)
        if (session.streams.size === 0) {
          app.log.info({
            sessionId: session.id
          }, 'Last SSE stream closed, cleaning up session')
          app.mcpSessions.delete(session.id)
        }
      }

      reply.raw.on('close', cleanup)
      reply.raw.on('error', cleanup)
    } catch (error) {
      app.log.error('Error setting up SSE stream:', error)
      reply.type('application/json').code(500).send({ error: 'Internal server error' })
    }
  })
}
