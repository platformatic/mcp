import { randomUUID } from 'crypto'
import type { FastifyRequest, FastifyReply, FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import type { JSONRPCMessage } from '../schema.ts'
import { JSONRPC_VERSION, INTERNAL_ERROR } from '../schema.ts'
import type { MCPPluginOptions, MCPTool, MCPResource, MCPPrompt } from '../types.ts'
import type { SessionStore, SessionMetadata } from '../stores/session-store.ts'
import type { MessageBroker } from '../brokers/message-broker.ts'
import { processMessage } from '../handlers.ts'

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
    await messageBroker.subscribe(`mcp/session/${sessionId}/message`, (message: JSONRPCMessage) => {
      const streams = localStreams.get(sessionId)
      if (streams && streams.size > 0) {
        sendSSEToStreams(sessionId, message, streams)
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
    const sseEvent = `id: ${eventId}\\ndata: ${JSON.stringify(message)}\\n\\n`
    session.lastEventId = eventId
    session.lastActivity = new Date()

    // Store message in history
    await sessionStore.addMessage(sessionId, eventId, message)

    // Send to all connected streams in this session
    const deadStreams = new Set<FastifyReply>()
    for (const stream of streams) {
      try {
        stream.raw.write(sseEvent)
      } catch (error) {
        app.log.error({ err: error }, 'Failed to write SSE event')
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
      await messageBroker.unsubscribe(`mcp/session/${sessionId}/message`)
    }
  }

  async function replayMessagesFromEventId (sessionId: string, lastEventId: string, stream: FastifyReply): Promise<void> {
    try {
      const messagesToReplay = await sessionStore.getMessagesFrom(sessionId, lastEventId)

      for (const entry of messagesToReplay) {
        const sseEvent = `id: ${entry.eventId}\\ndata: ${JSON.stringify(entry.message)}\\n\\n`
        try {
          stream.raw.write(sseEvent)
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

  app.post('/mcp', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const message = request.body as JSONRPCMessage
      const sessionId = request.headers['mcp-session-id'] as string
      const useSSE = enableSSE && supportsSSE(request) && !hasActiveSSESession(sessionId)

      if (useSSE) {
        reply.hijack()
        request.log.info({ sessionId }, 'Handling SSE request')

        // Set up SSE stream
        reply.raw.setHeader('content-type', 'text/event-stream')

        let session: SessionMetadata
        if (sessionId) {
          const existingSession = await sessionStore.get(sessionId)
          if (existingSession) {
            session = existingSession
          } else {
            session = await createSSESession()
            reply.raw.setHeader('Mcp-Session-Id', session.id)
          }
        } else {
          session = await createSSESession()
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

        // Add this connection to the local streams
        let streams = localStreams.get(session.id)
        if (!streams) {
          streams = new Set()
          localStreams.set(session.id, streams)
        }
        streams.add(reply)

        app.log.info({
          sessionId: session.id,
          totalStreams: streams.size,
          method: 'POST'
        }, 'Added new stream to session')

        // Handle connection close
        reply.raw.on('close', () => {
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
              messageBroker.unsubscribe(`mcp/session/${session.id}/message`)
            }
          }
        })

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
          const updatedSession = await sessionStore.get(session.id)
          if (updatedSession) {
            const eventId = (++updatedSession.eventId).toString()
            const sseEvent = `id: ${eventId}\\ndata: ${JSON.stringify(response)}\\n\\n`
            reply.raw.write(sseEvent)

            // Store message in history and update session
            await sessionStore.addMessage(session.id, eventId, response)
          }
        } else {
          reply.raw.write(': heartbeat\\n\\n')
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
      if (hasActiveSSESession(sessionId)) {
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

      let session: SessionMetadata
      if (sessionId) {
        const existingSession = await sessionStore.get(sessionId)
        if (existingSession) {
          session = existingSession
        } else {
          session = await createSSESession()
          raw.setHeader('Mcp-Session-Id', session.id)
        }
      } else {
        session = await createSSESession()
        raw.setHeader('Mcp-Session-Id', session.id)
      }

      raw.writeHead(200)

      let streams = localStreams.get(session.id)
      if (!streams) {
        streams = new Set()
        localStreams.set(session.id, streams)
      }
      streams.add(reply)

      app.log.info({
        sessionId: session.id,
        totalStreams: streams.size,
        method: 'GET'
      }, 'Added new stream to session')

      // Handle resumability with Last-Event-ID
      const lastEventId = request.headers['last-event-id'] as string
      if (lastEventId) {
        app.log.info(`Resuming SSE stream from event ID: ${lastEventId}`)
        await replayMessagesFromEventId(session.id, lastEventId, reply)
      }

      // Handle connection close
      reply.raw.on('close', () => {
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
            messageBroker.unsubscribe(`mcp/session/${session.id}/message`)
          }
        }
      })

      // Send initial heartbeat
      reply.raw.write(': heartbeat\\n\\n')

      // Keep connection alive with periodic heartbeats
      const heartbeatInterval = setInterval(() => {
        try {
          reply.raw.write(': heartbeat\\n\\n')
        } catch (error) {
          clearInterval(heartbeatInterval)
          const streams = localStreams.get(session.id)
          if (streams) {
            streams.delete(reply)
          }
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
      app.log.error({ err: error }, 'Error setting up SSE stream')
      reply.type('application/json').code(500).send({ error: 'Internal server error' })
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
