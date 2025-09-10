import { randomUUID } from 'crypto'
import type { FastifyRequest, FastifyReply, FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import type { JSONRPCMessage } from '../schema.ts'
import { JSONRPC_VERSION, INTERNAL_ERROR } from '../schema.ts'
import type { MCPPluginOptions, MCPTool, MCPResource, MCPPrompt } from '../types.ts'
import type { SessionStore, SessionMetadata } from '../stores/session-store.ts'
import type { MessageBroker } from '../brokers/message-broker.ts'
import type { AuthorizationContext } from '../types/auth-types.ts'
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
    const sseEvent = `id: ${eventId}\ndata: ${JSON.stringify(message)}\n\n`
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
        const sseEvent = `id: ${entry.eventId}\ndata: ${JSON.stringify(entry.message)}\n\n`
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
      let sessionId = request.headers['mcp-session-id'] as string

      if (enableSSE) {
        let session: SessionMetadata
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

      // Build auth context from validated token payload
      let authContext: AuthorizationContext | undefined
      if ((request as any).tokenPayload) {
        const payload = (request as any).tokenPayload
        authContext = {
          userId: payload.sub,
          clientId: payload.client_id || payload.azp,
          scopes: typeof payload.scope === 'string'
            ? payload.scope.split(' ')
            : payload.scopes,
          audience: Array.isArray(payload.aud)
            ? payload.aud
            : payload.aud ? [payload.aud] : undefined,
          tokenType: 'Bearer',
          expiresAt: payload.exp ? new Date(payload.exp * 1000) : undefined,
          issuedAt: payload.iat ? new Date(payload.iat * 1000) : undefined,
          authorizationServer: payload.iss
        }
      } else if (sessionId) {
        // Fallback to session-stored auth context
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
      reply.raw.write(': heartbeat\n\n')

      // Keep connection alive with periodic heartbeats
      const heartbeatInterval = setInterval(() => {
        try {
          reply.raw.write(': heartbeat\n\n')
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
