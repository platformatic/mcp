import { randomUUID } from 'crypto'
import type { FastifyRequest, FastifyReply, FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import type { JSONRPCMessage } from '../schema.ts'
import { JSONRPC_VERSION, INTERNAL_ERROR } from '../schema.ts'
import type { MCPPluginOptions, MCPTool, MCPResource, MCPPrompt } from '../types.ts'
import type { SessionStore, SessionMetadata } from '../stores/session-store.ts'
import type { MessageBroker } from '../brokers/message-broker.ts'
import { processMessage } from '../handlers.ts'

declare module 'fastify' {
  interface FastifyRequest {
    mcpSession?: SessionMetadata
  }
}

interface MCPPubSubRoutesOptions {
  enableSSE: boolean
  opts: MCPPluginOptions
  capabilities: any
  serverInfo: any
  tools: Map<string, MCPTool>
  resources: Map<string, MCPResource>
  prompts: Map<string, MCPPrompt>
  sessionStore: SessionStore
  messageBroker: MessageBroker
  localStreams: Map<string, Set<any>>
}

const mcpPubSubRoutesPlugin: FastifyPluginAsync<MCPPubSubRoutesOptions> = async (app, options) => {
  const { enableSSE, opts, capabilities, serverInfo, tools, resources, prompts, sessionStore, messageBroker, localStreams } = options

  async function createSSESession (): Promise<SessionMetadata> {
    const sessionId = randomUUID()
    const session: SessionMetadata = {
      id: sessionId,
      eventId: 0,
      lastEventId: undefined,
      createdAt: new Date(),
      lastActivity: new Date()
    }

    await sessionStore.create(session)
    localStreams.set(sessionId, new Set())

    // Subscribe to messages for this session
    await messageBroker.subscribe(`mcp/session/${sessionId}/message`, async (message: JSONRPCMessage) => {
      const streams = localStreams.get(sessionId)
      if (streams && streams.size > 0) {
        app.log.debug({ sessionId, message }, 'Received message for session via broker, sending to streams')
        sendSSEToStreams(sessionId, message, streams)
      } else {
        app.log.debug({ sessionId }, 'Received message for session via broker, storing in history without active streams')
        // Store message in history even without active streams for session persistence
        const session = await sessionStore.get(sessionId)
        if (session) {
          const eventId = (++session.eventId).toString()
          session.lastEventId = eventId
          session.lastActivity = new Date()
          await sessionStore.addMessage(sessionId, eventId, message)
        }
      }
    })

    return session
  }

  function supportsSSE (request: FastifyRequest): boolean {
    const accept = request.headers.accept
    return accept ? accept.includes('text/event-stream') : false
  }

  function hasActiveSSESession (sessionId?: string): boolean {
    if (!sessionId) return false
    const streams = localStreams.get(sessionId)
    return streams ? streams.size > 0 : false
  }

  async function sendSSEToStreams (sessionId: string, message: JSONRPCMessage, streams: Set<FastifyReply>): Promise<void> {
    const session = await sessionStore.get(sessionId)
    if (!session) return

    const eventId = (++session.eventId).toString()
    session.lastEventId = eventId
    session.lastActivity = new Date()

    // Store message in history
    await sessionStore.addMessage(sessionId, eventId, message)

    // Send to all connected streams in this session using @fastify/sse
    const deadStreams = new Set<FastifyReply>()
    for (const stream of streams) {
      try {
        if (stream.sse && stream.sse.isConnected) {
          stream.sse.send({
            id: eventId,
            data: JSON.stringify(message)
          })
        } else {
          deadStreams.add(stream)
        }
      } catch (error) {
        app.log.error({ err: error }, 'Failed to send SSE event')
        deadStreams.add(stream)
      }
    }

    // Clean up dead streams
    for (const deadStream of deadStreams) {
      streams.delete(deadStream)
    }

    // Clean up session if no streams left
    if (streams.size === 0) {
      app.log.info({
        sessionId
      }, 'Session has no active streams, cleaning up')
      localStreams.delete(sessionId)
      // Properly await unsubscribe to ensure cleanup completes
      try {
        await messageBroker.unsubscribe(`mcp/session/${sessionId}/message`)
      } catch (error) {
        app.log.warn({ err: error, sessionId }, 'Failed to unsubscribe from message broker')
      }
    }
  }

  async function replayMessagesFromEventId (sessionId: string, lastEventId: string, stream: FastifyReply): Promise<void> {
    try {
      const messagesToReplay = await sessionStore.getMessagesFrom(sessionId, lastEventId)

      for (const entry of messagesToReplay) {
        try {
          if (stream.sse && stream.sse.isConnected) {
            stream.sse.send({
              id: entry.eventId,
              data: JSON.stringify(entry.message)
            })
          } else {
            app.log.error('SSE stream not connected for replay')
            break
          }
        } catch (error) {
          app.log.error({ err: error }, 'Failed to replay SSE event')
          break
        }
      }

      if (messagesToReplay.length > 0) {
        app.log.info(`Replayed ${messagesToReplay.length} messages from event ID: ${lastEventId}`)
      }
    } catch (error) {
      app.log.warn({ err: error, lastEventId }, 'Failed to replay messages from event ID')
    }
  }

  // POST endpoint for JSON-RPC messages with optional SSE streaming
  app.post('/mcp', {
    sse: enableSSE,
    preHandler: async (request: FastifyRequest, _reply: FastifyReply) => {
      if (enableSSE && supportsSSE(request)) {
        // Create or get session and set header before SSE takes over
        const sessionId = request.headers['mcp-session-id'] as string
        let session: SessionMetadata

        if (sessionId) {
          const existingSession = await sessionStore.get(sessionId)
          if (existingSession) {
            session = existingSession
          } else {
            session = await createSSESession()
          }
        } else {
          session = await createSSESession()
        }

        // Set session ID header using @fastify/sse v0.2.0 header handling
        _reply.header('Mcp-Session-Id', session.id)

        // Store session for use in main handler
        request.mcpSession = session
      }
    }
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const message = request.body as JSONRPCMessage
      let sessionId = request.headers['mcp-session-id'] as string
      const useSSE = enableSSE && supportsSSE(request) && !hasActiveSSESession(sessionId)

      if (useSSE && reply.sse) {
        // Handle POST SSE: process message AND set up SSE stream
        request.log.info({ sessionId, method: request.method }, 'Handling POST SSE request')

        // Get session that was created in preHandler
        const session = request.mcpSession!
        if (!session) {
          throw new Error('Session should have been created in preHandler')
        }
        sessionId = session.id

        // Header already set in preHandler

        // Add this connection to local streams
        let streams = localStreams.get(session.id)
        if (!streams) {
          streams = new Set()
          localStreams.set(session.id, streams)
        }
        streams.add(reply)

        app.log.info({
          sessionId: session.id,
          totalStreams: streams.size,
          method: request.method
        }, 'Added new stream to session')

        // Handle connection close
        reply.sse.onClose(async () => {
          const streams = localStreams.get(session.id)
          if (streams) {
            streams.delete(reply)
            app.log.info({
              sessionId: session.id,
              remainingStreams: streams.size
            }, 'POST SSE connection closed')

            if (streams.size === 0) {
              app.log.info({
                sessionId: session.id
              }, 'Last POST SSE stream closed, cleaning up session')
              localStreams.delete(session.id)
              try {
                await messageBroker.unsubscribe(`mcp/session/${session.id}/message`)
              } catch (error) {
                app.log.warn({ err: error, sessionId: session.id }, 'Failed to unsubscribe in POST SSE close handler')
              }
            }
          }
        })

        // Process message and send via SSE
        const response = await processMessage(message, session.id, {
          app,
          opts,
          capabilities,
          serverInfo,
          tools,
          resources,
          prompts,
          request,
          reply,
          authContext: session.authorization
        })

        if (response) {
          const updatedSession = await sessionStore.get(session.id)
          if (updatedSession) {
            const eventId = (++updatedSession.eventId).toString()

            reply.sse.send({
              id: eventId,
              data: JSON.stringify(response)
            })
            // Store message in history (this also updates session metadata)
            await sessionStore.addMessage(session.id, eventId, response)
          }
        } else {
          // Send heartbeat if no response
          reply.sse.send({ data: 'heartbeat' })
        }
      } else {
        // Regular JSON response - handle sessions and auth context
        if (enableSSE) {
          let session: SessionMetadata | undefined
          if (sessionId) {
            const existingSession = await sessionStore.get(sessionId)
            if (existingSession) {
              session = existingSession
            } else {
              session = await createSSESession()
              reply.header('Mcp-Session-Id', session.id)
            }
          } else {
            session = await createSSESession()
            reply.header('Mcp-Session-Id', session.id)
          }
          sessionId = session.id
        }

        // Get session for auth context
        let authContext
        if (sessionId) {
          const session = await sessionStore.get(sessionId)
          authContext = session?.authorization
        }

        const response = await processMessage(message, sessionId, {
          app,
          opts,
          capabilities,
          serverInfo,
          tools,
          resources,
          prompts,
          request,
          reply,
          authContext
        })
        if (response) {
          return response
        } else {
          reply.code(202)
        }
      }
    } catch (error) {
      app.log.error({ err: error }, 'Error processing MCP message')
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

  // GET endpoint for SSE connections
  app.get('/mcp', {
    sse: enableSSE,
    preHandler: async (request: FastifyRequest, _reply: FastifyReply) => {
      if (enableSSE && supportsSSE(request)) {
        // Create or get session and set header before SSE takes over
        const sessionId = (request.headers['mcp-session-id'] as string) ||
                         ((request.query as any)?.['mcp-session-id'])
        let session: SessionMetadata

        if (sessionId) {
          const existingSession = await sessionStore.get(sessionId)
          if (existingSession) {
            session = existingSession
          } else {
            session = await createSSESession()
          }
        } else {
          session = await createSSESession()
        }

        // Set session ID header using @fastify/sse v0.2.0 header handling
        _reply.header('Mcp-Session-Id', session.id)

        // Store session for use in main handler
        request.mcpSession = session
      }
    }
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      if (!enableSSE) {
        reply.type('application/json').code(405).send({ error: 'Method Not Allowed: SSE not enabled' })
        return
      }

      if (!supportsSSE(request)) {
        reply.type('application/json').code(405).send({ error: 'Method Not Allowed: SSE not supported' })
        return
      }

      // Check if reply.sse is available
      if (!reply.sse) {
        throw new Error('SSE functionality not available on reply object')
      }

      const sessionId = (request.headers['mcp-session-id'] as string) ||
                       ((request.query as any)?.['mcp-session-id'])

      // Check if there's already an active SSE session
      if (hasActiveSSESession(sessionId)) {
        reply.type('application/json').code(409).send({
          error: 'Conflict: SSE session already active for this session ID'
        })
        return
      }

      request.log.info({ sessionId, method: request.method }, 'Handling SSE request')

      // Get session that was created in preHandler
      const session = request.mcpSession!
      if (!session) {
        throw new Error('Session should have been created in preHandler')
      }

      // Header already set in preHandler

      // Send initial connection event
      reply.sse.send({ data: 'connected', id: '0' })

      // Add this connection to local streams
      let streams = localStreams.get(session.id)
      if (!streams) {
        streams = new Set()
        localStreams.set(session.id, streams)
      }
      streams.add(reply)

      app.log.info({
        sessionId: session.id,
        totalStreams: streams.size,
        method: request.method
      }, 'Added new stream to session')

      // Handle Last-Event-ID for reconnections
      const lastEventId = request.headers['last-event-id'] as string
      if (lastEventId) {
        app.log.info(`Resuming SSE stream from event ID: ${lastEventId}`)
        await replayMessagesFromEventId(session.id, lastEventId, reply)
      }

      // Handle connection close
      reply.sse.onClose(async () => {
        const streams = localStreams.get(session.id)
        if (streams) {
          streams.delete(reply)
          app.log.info({
            sessionId: session.id,
            remainingStreams: streams.size
          }, 'SSE connection closed')

          if (streams.size === 0) {
            app.log.info({
              sessionId: session.id
            }, 'Last SSE stream closed, cleaning up session')
            localStreams.delete(session.id)
            try {
              await messageBroker.unsubscribe(`mcp/session/${session.id}/message`)
            } catch (error) {
              app.log.warn({ err: error, sessionId: session.id }, 'Failed to unsubscribe in GET SSE close handler')
            }
          }
        }
      })

      // Send initial heartbeat for GET requests
      reply.sse.send({ data: 'heartbeat', id: session.lastEventId || '0' })
    } catch (error) {
      app.log.error({ err: error }, 'Error in SSE GET endpoint')
      reply.type('application/json').code(500).send({
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error'
      })
    }
  })

  // Subscribe to broadcast notifications
  if (enableSSE) {
    messageBroker.subscribe('mcp/broadcast/notification', (notification: JSONRPCMessage) => {
      // Send to all local streams
      for (const [sessionId, streams] of localStreams.entries()) {
        if (streams.size > 0) {
          sendSSEToStreams(sessionId, notification, streams)
        }
      }
    })
  }
}

export default fp(mcpPubSubRoutesPlugin, {
  name: 'mcp-pubsub-routes'
})
