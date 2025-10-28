import { randomUUID } from 'crypto'
import type { FastifyRequest, FastifyReply, FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import type { JSONRPCMessage } from '../schema.ts'
import { JSONRPC_VERSION, INTERNAL_ERROR } from '../schema.ts'
import type { MCPPluginOptions, MCPTool, MCPResource, MCPPrompt } from '../types.ts'
import type { SessionStore, SessionMetadata } from '../stores/session-store.ts'
import type { MessageBroker } from '../brokers/message-broker.ts'
import type { AuthorizationContext } from '../types/auth-types.ts'
import { processMessage, createResponse, createError, type StreamingToolResponse } from '../handlers.ts'

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

// Helper function to check if response is streaming
function isStreamingResponse (response: any): response is StreamingToolResponse {
  return response && response.isStreaming === true && response.iterator && response.requestId !== undefined
}

const mcpPubSubRoutesPlugin: FastifyPluginAsync<MCPPubSubRoutesOptions> = async (app, options) => {
  const { enableSSE, opts, capabilities, serverInfo, tools, resources, prompts, sessionStore, messageBroker, localStreams } = options

  async function createSSESession (): Promise<SessionMetadata> {
    const sessionId = randomUUID()
    const session: SessionMetadata = {
      id: sessionId,
      createdAt: new Date(),
      lastActivity: new Date(),
      streams: new Map()
    }

    await sessionStore.create(session)
    localStreams.set(sessionId, new Set())

    // Subscribe to messages for this session
    await messageBroker.subscribe(`mcp/session/${sessionId}/message`, async (message: JSONRPCMessage) => {
      const streams = localStreams.get(sessionId)
      if (streams && streams.size > 0) {
        app.log.debug({ sessionId, message }, 'Received message for session via broker, sending to streams')
        await sendSSEToStreams(sessionId, message, streams)
      } else {
        app.log.debug({ sessionId }, 'Received message for session via broker, storing in history without active streams')
        // For backward compatibility, store in session-level history if no streams are active
        // This maintains existing behavior for legacy usage
        await sessionStore.addSessionMessage(sessionId, '0', message)
      }
    })

    return session
  }

  function supportsSSE (request: FastifyRequest): boolean {
    const accept = request.headers.accept
    return accept ? accept.includes('text/event-stream') : false
  }

  async function sendSSEToStreams (sessionId: string, message: JSONRPCMessage, streams: Set<FastifyReply>): Promise<void> {
    // Check if this is a broadcast notification or elicitation (these should use session-level storage)
    const isBroadcast = 'method' in message && (
      message.method === 'notifications/message' ||
      message.method.startsWith('notifications/') ||
      message.method === 'elicitation/create'
    )

    if (isBroadcast) {
      // Use broadcast method for broadcast notifications and elicitation requests
      await sendSSEToStreamsBroadcast(sessionId, message, streams)
      return
    }

    // According to MCP spec line 145: server MUST send each message to only one stream
    // For now, we'll select the first available stream (round-robin could be implemented later)
    const streamArray = Array.from(streams)
    if (streamArray.length === 0) return

    // Select the first stream for this message (simple strategy)
    const selectedStream = streamArray[0]
    const streamId = (selectedStream as any).mcpStreamId

    if (!streamId) {
      app.log.warn('Stream missing mcpStreamId, falling back to broadcast')
      // Fallback to broadcast behavior if streamId is missing
      await sendSSEToStreamsBroadcast(sessionId, message, streams)
      return
    }

    try {
      // Get current stream metadata to determine next event ID
      const streamMetadata = await sessionStore.getStream(sessionId, streamId)
      if (!streamMetadata) {
        app.log.warn(`Stream metadata not found for stream: ${streamId}`)
        return
      }

      // Generate next event ID for this specific stream
      const eventId = (streamMetadata.eventId + 1).toString()
      const sseEvent = `id: ${eventId}\ndata: ${JSON.stringify(message)}\n\n`

      // Send to the selected stream
      selectedStream.raw.write(sseEvent)

      // Store message in per-stream history
      await sessionStore.addMessage(sessionId, streamId, eventId, message)
      await sessionStore.updateStreamActivity(sessionId, streamId)

      app.log.debug({
        sessionId,
        streamId,
        eventId,
        messageType: 'method' in message ? message.method : 'response'
      }, 'Sent message to specific stream')
    } catch (error) {
      app.log.error({ err: error, sessionId, streamId }, 'Failed to send SSE event to stream')

      // Remove dead stream
      streams.delete(selectedStream)

      // Clean up session if no streams left
      if (streams.size === 0) {
        app.log.info({ sessionId }, 'Session has no active streams, cleaning up')
        localStreams.delete(sessionId)
        await messageBroker.unsubscribe(`mcp/session/${sessionId}/message`)
      }
    }
  }

  async function sendSSEToStreamsBroadcast (sessionId: string, message: JSONRPCMessage, streams: Set<FastifyReply>): Promise<void> {
    // Broadcast method for notifications and elicitation - stores in session-level history
    const deadStreams = new Set<FastifyReply>()

    // Use timestamp-based event ID for broadcast compatibility
    const eventId = Date.now().toString()
    const sseEvent = `id: ${eventId}\ndata: ${JSON.stringify(message)}\n\n`

    for (const stream of streams) {
      try {
        stream.raw.write(sseEvent)
      } catch (error) {
        app.log.error({ err: error }, 'Failed to write legacy SSE event')
        deadStreams.add(stream)
      }
    }

    // Store message in session-level history (broadcast messages are session-wide)
    try {
      await sessionStore.addSessionMessage(sessionId, eventId, message)
    } catch (error) {
      app.log.error({ err: error }, 'Failed to store broadcast session message')
    }

    // Clean up dead streams
    for (const deadStream of deadStreams) {
      streams.delete(deadStream)
    }

    // Clean up session if no streams left
    if (streams.size === 0) {
      app.log.info({ sessionId }, 'Session has no active streams, cleaning up')
      localStreams.delete(sessionId)
      await messageBroker.unsubscribe(`mcp/session/${sessionId}/message`)
    }
  }

  async function handleStreamingResponse (
    streamingResponse: StreamingToolResponse,
    sessionId: string | undefined,
    reply: FastifyReply
  ): Promise<void> {
    // Hijack the response for streaming
    reply.hijack()
    const raw = reply.raw

    // Set SSE headers
    raw.setHeader('Content-Type', 'text/event-stream')
    raw.setHeader('Cache-Control', 'no-cache')
    raw.writeHead(200)

    let eventId = 1

    try {
      // Manually iterate through async iterator to capture both yielded values and return value
      const iterator = streamingResponse.iterator
      let result = await iterator.next()

      while (!result.done) {
        // Handle yielded values
        const response = createResponse(streamingResponse.requestId, result.value)
        const sseEvent = `id: ${eventId}\ndata: ${JSON.stringify(response)}\n\n`

        try {
          raw.write(sseEvent)
        } catch (error) {
          app.log.error({ err: error }, 'Failed to write SSE chunk')
          break
        }

        // Update session if available - use legacy method for backward compatibility
        if (enableSSE && sessionId) {
          await sessionStore.addSessionMessage(sessionId, eventId.toString(), response)
        }

        eventId++
        result = await iterator.next()
      }

      // Handle final return value if present
      if (result.value !== undefined) {
        const response = createResponse(streamingResponse.requestId, result.value)
        const sseEvent = `id: ${eventId}\ndata: ${JSON.stringify(response)}\n\n`

        try {
          raw.write(sseEvent)
        } catch (error) {
          app.log.error({ err: error }, 'Failed to write final SSE event')
        }

        // Update session with final value if available - use legacy method for backward compatibility
        if (enableSSE && sessionId) {
          await sessionStore.addSessionMessage(sessionId, eventId.toString(), response)
        }
      }
    } catch (error: any) {
      // Send error event
      const errorResponse = createError(
        streamingResponse.requestId,
        INTERNAL_ERROR,
        `Streaming error: ${error.message || error}`
      )
      const errorEvent = `id: ${eventId}\ndata: ${JSON.stringify(errorResponse)}\n\n`

      try {
        raw.write(errorEvent)
      } catch (writeError) {
        app.log.error({ err: writeError }, 'Failed to write error event')
      }

      // Update session with error if available - use legacy method for backward compatibility
      if (enableSSE && sessionId) {
        await sessionStore.addSessionMessage(sessionId, eventId.toString(), errorResponse)
      }
    } finally {
      // Close the stream
      try {
        raw.end()
      } catch (error) {
        app.log.error({ err: error }, 'Failed to close SSE stream')
      }
    }
  }

  async function replayStreamMessagesFromEventId (sessionId: string, streamId: string, lastEventId: string, stream: FastifyReply): Promise<void> {
    try {
      const messagesToReplay = await sessionStore.getMessagesFrom(sessionId, streamId, lastEventId)

      for (const entry of messagesToReplay) {
        const sseEvent = `id: ${entry.eventId}\ndata: ${JSON.stringify(entry.message)}\n\n`
        try {
          stream.raw.write(sseEvent)
        } catch (error) {
          app.log.error({ err: error }, 'Failed to replay per-stream SSE event')
          break
        }
      }

      if (messagesToReplay.length > 0) {
        app.log.info(`Replayed ${messagesToReplay.length} messages from event ID: ${lastEventId} for stream: ${streamId}`)
      }
    } catch (error) {
      app.log.warn({ err: error, lastEventId, streamId }, 'Failed to replay per-stream messages from event ID')
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
        // Check if this is a streaming response
        if (isStreamingResponse(response)) {
          // Handle streaming response
          await handleStreamingResponse(response, sessionId, reply)
          return // Response already sent via streaming
        }

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

      // Note: According to MCP spec line 143, clients MAY remain connected to multiple SSE streams simultaneously
      // So we allow multiple streams per session

      request.log.info({ sessionId }, 'Handling SSE request')

      // We are opting out of Fastify proper
      reply.hijack()

      const raw = reply.raw

      // Headers will be set later with stream ID

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

      // Generate unique stream ID for this SSE connection
      const streamId = randomUUID()

      // Create stream metadata for per-stream event ID tracking
      const streamMetadata = await sessionStore.createStream(session.id, streamId)
      if (!streamMetadata) {
        raw.writeHead(500)
        raw.end('Failed to create stream')
        return
      }

      // Set headers before writing head
      raw.setHeader('Content-type', 'text/event-stream')
      raw.setHeader('Cache-Control', 'no-cache')
      raw.setHeader('Mcp-Stream-Id', streamId)
      raw.writeHead(200)

      let streams = localStreams.get(session.id)
      if (!streams) {
        streams = new Set()
        localStreams.set(session.id, streams)
      }
      streams.add(reply)

      // Associate the reply with the stream ID for per-stream management
      ;(reply as any).mcpStreamId = streamId

      app.log.info({
        sessionId: session.id,
        streamId,
        totalStreams: streams.size,
        method: 'GET'
      }, 'Added new stream to session')

      // Handle resumability with Last-Event-ID - now per-stream
      const lastEventId = request.headers['last-event-id'] as string
      if (lastEventId) {
        app.log.info(`Resuming SSE stream from event ID: ${lastEventId} for stream: ${streamId}`)
        await replayStreamMessagesFromEventId(session.id, streamId, lastEventId, reply)
      }

      // Handle connection close
      reply.raw.on('close', () => {
        const streams = localStreams.get(session.id)
        if (streams) {
          streams.delete(reply)
          app.log.info({
            sessionId: session.id,
            streamId,
            remainingStreams: streams.size
          }, 'SSE connection closed')

          // Clean up stream metadata
          sessionStore.deleteStream(session.id, streamId)

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
          sessionId: session.id,
          streamId
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
