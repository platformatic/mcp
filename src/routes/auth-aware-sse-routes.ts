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

interface AuthAwareSSERoutesOptions {
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

const authAwareSSERoutesPlugin: FastifyPluginAsync<AuthAwareSSERoutesOptions> = async (app, options) => {
  const { enableSSE, opts, capabilities, serverInfo, tools, resources, prompts, sessionStore, messageBroker, localStreams } = options

  async function createAuthorizedSSESession (authContext?: AuthorizationContext): Promise<SessionMetadata> {
    const sessionId = randomUUID()
    const session: SessionMetadata = {
      id: sessionId,
      eventId: 0,
      lastEventId: undefined,
      createdAt: new Date(),
      lastActivity: new Date(),
      authorization: authContext
    }

    await sessionStore.create(session)
    localStreams.set(sessionId, new Set())

    // Subscribe to messages for this session
    await messageBroker.subscribe(`mcp/session/${sessionId}/message`, (message) => {
      const streams = localStreams.get(sessionId)
      if (streams && streams.size > 0) {
        sendSSEToStreams(sessionId, message, streams)
      }
    })

    // Subscribe to user-specific messages if we have user context
    if (authContext?.userId) {
      await messageBroker.subscribe(`mcp/user/${authContext.userId}/message`, (message) => {
        const streams = localStreams.get(sessionId)
        if (streams && streams.size > 0) {
          sendSSEToStreams(sessionId, message, streams)
        }
      })
    }

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

  function isAuthorizedForSession (authContext: AuthorizationContext | undefined, session: SessionMetadata): boolean {
    // If no authorization required, allow access
    if (!session.authorization) {
      return true
    }

    // If no auth context provided but session requires auth, deny
    if (!authContext) {
      return false
    }

    // Check if the same user/token
    return authContext.userId === session.authorization.userId &&
           authContext.tokenHash === session.authorization.tokenHash
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
        sessionId,
        userId: session.authorization?.userId
      }, 'Authorized session has no active streams, cleaning up')
      localStreams.delete(sessionId)
      await messageBroker.unsubscribe(`mcp/session/${sessionId}/message`)

      // Unsubscribe from user-specific messages if applicable
      if (session.authorization?.userId) {
        await messageBroker.unsubscribe(`mcp/user/${session.authorization.userId}/message`)
      }
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

  // Authorization-aware POST endpoint
  app.post('/mcp', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const message = request.body as JSONRPCMessage
      const sessionId = request.headers['mcp-session-id'] as string
      const useSSE = enableSSE && supportsSSE(request) && !hasActiveSSESession(sessionId)

      // @ts-ignore - Custom property added by auth prehandler
      const authContext = request.authContext as AuthorizationContext | undefined

      if (useSSE) {
        reply.hijack()
        request.log.info({
          sessionId,
          userId: authContext?.userId
        }, 'Handling authorized SSE request')

        // Set up SSE stream
        reply.raw.setHeader('content-type', 'text/event-stream')

        let session: SessionMetadata
        if (sessionId) {
          const existingSession = await sessionStore.get(sessionId)
          if (existingSession && isAuthorizedForSession(authContext, existingSession)) {
            session = existingSession
            // Update session with current auth context if needed
            if (authContext && (!existingSession.authorization || existingSession.authorization.tokenHash !== authContext.tokenHash)) {
              await sessionStore.updateAuthorization(sessionId, authContext)
              session.authorization = authContext
            }
          } else if (existingSession && !isAuthorizedForSession(authContext, existingSession)) {
            reply.raw.writeHead(403, { 'Content-Type': 'application/json' })
            reply.raw.end(JSON.stringify({
              error: 'forbidden',
              error_description: 'Not authorized to access this session'
            }))
            return
          } else {
            session = await createAuthorizedSSESession(authContext)
            reply.raw.setHeader('Mcp-Session-Id', session.id)
          }
        } else {
          session = await createAuthorizedSSESession(authContext)
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
          userId: authContext?.userId,
          totalStreams: streams.size,
          method: 'POST'
        }, 'Added new authorized stream to session')

        // Handle connection close
        reply.raw.on('close', () => {
          const streams = localStreams.get(session.id)
          if (streams) {
            streams.delete(reply)
            app.log.info({
              sessionId: session.id,
              userId: authContext?.userId,
              remainingStreams: streams.size
            }, 'Authorized POST SSE connection closed')

            if (streams.size === 0) {
              app.log.info({
                sessionId: session.id,
                userId: authContext?.userId
              }, 'Last authorized POST SSE stream closed, cleaning up session')
              localStreams.delete(session.id)
              messageBroker.unsubscribe(`mcp/session/${session.id}/message`)

              if (session.authorization?.userId) {
                messageBroker.unsubscribe(`mcp/user/${session.authorization.userId}/message`)
              }
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
        // Regular JSON response - still enforce authorization for session access
        if (sessionId) {
          const existingSession = await sessionStore.get(sessionId)
          if (existingSession && !isAuthorizedForSession(authContext, existingSession)) {
            return reply.code(403).send({
              error: 'forbidden',
              error_description: 'Not authorized to access this session'
            })
          }
        }

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
      app.log.error({ err: error }, 'Error processing authorized MCP message')
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

  // Authorization-aware GET endpoint for server-initiated communication via SSE
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

      // @ts-ignore - Custom property added by auth prehandler
      const authContext = request.authContext as AuthorizationContext | undefined

      // Check if there's already an active SSE session
      if (hasActiveSSESession(sessionId)) {
        reply.type('application/json').code(409).send({
          error: 'Conflict: SSE session already active for this session ID'
        })
        return
      }

      request.log.info({
        sessionId,
        userId: authContext?.userId
      }, 'Handling authorized GET SSE request')

      // We are opting out of Fastify proper
      reply.hijack()

      const raw = reply.raw

      // Set up SSE stream
      raw.setHeader('Content-type', 'text/event-stream')
      raw.setHeader('Cache-Control', 'no-cache')

      let session: SessionMetadata
      if (sessionId) {
        const existingSession = await sessionStore.get(sessionId)
        if (existingSession && isAuthorizedForSession(authContext, existingSession)) {
          session = existingSession
          // Update session with current auth context if needed
          if (authContext && (!existingSession.authorization || existingSession.authorization.tokenHash !== authContext.tokenHash)) {
            await sessionStore.updateAuthorization(sessionId, authContext)
            session.authorization = authContext
          }
        } else if (existingSession && !isAuthorizedForSession(authContext, existingSession)) {
          raw.writeHead(403, { 'Content-Type': 'application/json' })
          raw.end(JSON.stringify({
            error: 'forbidden',
            error_description: 'Not authorized to access this session'
          }))
          return
        } else {
          session = await createAuthorizedSSESession(authContext)
          raw.setHeader('Mcp-Session-Id', session.id)
        }
      } else {
        session = await createAuthorizedSSESession(authContext)
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
        userId: authContext?.userId,
        totalStreams: streams.size,
        method: 'GET'
      }, 'Added new authorized GET stream to session')

      // Handle resumability with Last-Event-ID
      const lastEventId = request.headers['last-event-id'] as string
      if (lastEventId) {
        app.log.info(`Resuming authorized SSE stream from event ID: ${lastEventId}`)
        await replayMessagesFromEventId(session.id, lastEventId, reply)
      }

      // Handle connection close
      reply.raw.on('close', () => {
        const streams = localStreams.get(session.id)
        if (streams) {
          streams.delete(reply)
          app.log.info({
            sessionId: session.id,
            userId: authContext?.userId,
            remainingStreams: streams.size
          }, 'Authorized GET SSE connection closed')

          if (streams.size === 0) {
            app.log.info({
              sessionId: session.id,
              userId: authContext?.userId
            }, 'Last authorized GET SSE stream closed, cleaning up session')
            localStreams.delete(session.id)
            messageBroker.unsubscribe(`mcp/session/${session.id}/message`)

            if (session.authorization?.userId) {
              messageBroker.unsubscribe(`mcp/user/${session.authorization.userId}/message`)
            }
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
          sessionId: session.id,
          userId: authContext?.userId
        }, 'Authorized SSE heartbeat connection closed')
        clearInterval(heartbeatInterval)
      })
    } catch (error) {
      app.log.error({ err: error }, 'Error setting up authorized SSE stream')
      reply.type('application/json').code(500).send({ error: 'Internal server error' })
    }
  })

  // Subscribe to broadcast notifications (authorization-aware)
  if (enableSSE) {
    messageBroker.subscribe('mcp/broadcast/notification', (notification) => {
      // Send to all local streams
      for (const [sessionId, streams] of localStreams.entries()) {
        if (streams.size > 0) {
          sendSSEToStreams(sessionId, notification, streams)
        }
      }
    })
  }
}

export default fp(authAwareSSERoutesPlugin, {
  name: 'auth-aware-sse-routes'
})
