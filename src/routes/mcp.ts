import { randomUUID } from 'crypto'
import type { FastifyRequest, FastifyReply, FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import type { JSONRPCMessage } from '../schema.ts'
import { JSONRPC_VERSION, INTERNAL_ERROR, SUPPORTED_PROTOCOL_VERSIONS, DEFAULT_NEGOTIATED_PROTOCOL_VERSION } from '../schema.ts'
import { isOriginAllowed } from '../security.ts'
import type { MCPPluginOptions, MCPTool, MCPResource, MCPPrompt, ResourceHandlers } from '../types.ts'
import type { SessionStore, SessionMetadata } from '../stores/session-store.ts'
import type { TaskStore, TaskWaiters } from '../stores/task-store.ts'
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
  resourceHandlers: ResourceHandlers
  sessionStore: SessionStore
  messageBroker: MessageBroker
  localStreams: Map<string, Set<any>>
  taskStore?: TaskStore
  taskWaiters?: TaskWaiters
}

const mcpPubSubRoutesPlugin: FastifyPluginAsync<MCPPubSubRoutesOptions> = async (app, options) => {
  const { enableSSE, opts, capabilities, serverInfo, tools, resources, prompts, resourceHandlers, sessionStore, messageBroker, localStreams, taskStore, taskWaiters } = options

  const allowedOrigins = opts.allowedOrigins

  if (allowedOrigins === undefined) {
    app.log.warn('MCP: no allowedOrigins configured, Origin validation is disabled. Set allowedOrigins to protect browser clients against DNS rebinding.')
  }

  // Guard against DNS rebinding: reject browser origins we do not trust.
  // The 2025-11-25 revision requires 403 here, not 400.
  async function validateOrigin (request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const origin = request.headers.origin as string | undefined
    if (!isOriginAllowed(origin, allowedOrigins)) {
      request.log.warn({ origin }, 'Rejected MCP request with disallowed Origin')
      return reply.code(403).type('application/json').send({
        error: 'Forbidden: Origin not allowed'
      })
    }
  }

  // Clients must echo the negotiated protocol version on every request after
  // `initialize`. An absent header means 2025-03-26, which predates the header.
  async function validateProtocolVersionHeader (request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const header = request.headers['mcp-protocol-version']
    if (header === undefined) {
      ;(request as any).mcpProtocolVersion = DEFAULT_NEGOTIATED_PROTOCOL_VERSION
      return
    }

    const version = Array.isArray(header) ? header[0] : header
    if (!(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
      request.log.warn({ version }, 'Rejected MCP request with unsupported MCP-Protocol-Version header')
      return reply.code(400).type('application/json').send({
        error: `Bad Request: unsupported MCP-Protocol-Version '${version}'`,
        supported: SUPPORTED_PROTOCOL_VERSIONS
      })
    }

    ;(request as any).mcpProtocolVersion = version
  }

  /**
   * `initialize` is the negotiation itself, so it is exempt from having to match
   * a version agreed earlier — a client is allowed to re-negotiate on a session.
   */
  function isInitializeRequest (body: unknown): boolean {
    if (Array.isArray(body)) {
      return body.some(entry => (entry as { method?: string })?.method === 'initialize')
    }
    return (body as { method?: string } | undefined)?.method === 'initialize'
  }

  /**
   * Reconcile the header against what the session actually negotiated.
   *
   * The session is authoritative: a client that agreed on 2025-03-26 must not be
   * able to opt into newer behaviour just by sending a newer header. Runs as a
   * preHandler because deciding whether this is an `initialize` needs the body.
   */
  async function reconcileProtocolVersion (request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const sessionId = request.headers['mcp-session-id'] as string | undefined
    if (!sessionId) return

    const session = await sessionStore.get(sessionId)
    const negotiated = session?.protocolVersion
    if (!negotiated) return

    if (isInitializeRequest(request.body)) return

    const header = request.headers['mcp-protocol-version']
    if (header !== undefined) {
      const sent = Array.isArray(header) ? header[0] : header
      if (sent !== negotiated) {
        request.log.warn({ sent, negotiated, sessionId }, 'MCP-Protocol-Version does not match the version negotiated for this session')
        return reply.code(400).type('application/json').send({
          error: `Bad Request: MCP-Protocol-Version '${sent}' does not match the version negotiated for this session`,
          negotiated
        })
      }
    }

    // We know what was agreed, so prefer it over the header-derived default
    ;(request as any).mcpProtocolVersion = negotiated
  }

  // Scoped to the /mcp routes only: this plugin is not encapsulated, so an
  // app-level hook would also cover the OAuth and well-known routes.
  const mcpOnRequest = [validateOrigin, validateProtocolVersionHeader]
  const mcpPreHandler = [reconcileProtocolVersion]

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

  app.post('/mcp', { onRequest: mcpOnRequest, preHandler: mcpPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
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
        resourceHandlers,
        request,
        reply,
        authContext,
        sessionStore,
        taskStore,
        taskWaiters,
        sessionId,
        protocolVersion: (request as any).mcpProtocolVersion ?? DEFAULT_NEGOTIATED_PROTOCOL_VERSION
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
  app.get('/mcp', { onRequest: mcpOnRequest, preHandler: mcpPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
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

      // SEP-1699: servers may end an SSE stream whenever they like, turning the
      // stream into a polling channel. The client reconnects with Last-Event-ID
      // on GET and we replay whatever it missed, so closing here loses nothing.
      let maxDurationTimer: NodeJS.Timeout | undefined
      if (opts.sseMaxConnectionMs) {
        maxDurationTimer = setTimeout(() => {
          app.log.info({
            sessionId: session.id,
            afterMs: opts.sseMaxConnectionMs
          }, 'Closing SSE stream to let the client poll; it may resume with Last-Event-ID')
          try {
            reply.raw.end()
          } catch {
            // already gone
          }
        }, opts.sseMaxConnectionMs)
        maxDurationTimer.unref()

        reply.raw.on('close', () => clearTimeout(maxDurationTimer))
      }

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

  // DELETE endpoint for explicit session termination (MCP spec)
  if (enableSSE) {
    app.delete('/mcp', { onRequest: mcpOnRequest, preHandler: mcpPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
      const sessionId = request.headers['mcp-session-id'] as string
      if (!sessionId) {
        reply.code(400).send({ error: 'Missing Mcp-Session-Id header' })
        return
      }

      const session = await sessionStore.get(sessionId)
      if (!session) {
        reply.code(404).send({ error: 'Session not found' })
        return
      }

      // Force-close any active SSE streams for this session
      const streams = localStreams.get(sessionId)
      if (streams) {
        for (const stream of streams) {
          try {
            stream.raw.end()
          } catch {
            // stream may already be closed
          }
        }
        localStreams.delete(sessionId)
      }

      // Unsubscribe from message broker
      await messageBroker.unsubscribe(`mcp/session/${sessionId}/message`)

      // Delete session from store
      await sessionStore.delete(sessionId)

      app.log.info({ sessionId }, 'Session terminated via DELETE')
      reply.code(204).send()
    })
  }

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
