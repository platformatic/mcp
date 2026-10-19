import { randomUUID } from 'crypto'
import type { FastifyRequest, FastifyReply, FastifyPluginAsync, FastifySchema, FastifyError, FastifyInstance, preHandlerHookHandler } from 'fastify'
import fp from 'fastify-plugin'
import type { JSONRPCMessage } from '../schema.ts'
import { JSONRPC_VERSION, INTERNAL_ERROR, PARSE_ERROR, INVALID_REQUEST, SUPPORTED_PROTOCOL_VERSIONS, DEFAULT_NEGOTIATED_PROTOCOL_VERSION } from '../schema.ts'
import { isOriginAllowed } from '../security.ts'
import type {
  MCPPluginOptions,
  MCPTool,
  MCPResource,
  MCPPrompt,
  ResourceHandlers,
  MCPRouteSchemaContext,
  MCPRouteSchemaTransformer
} from '../types.ts'
import type { SessionStore, SessionMetadata } from '../stores/session-store.ts'
import { DEFAULT_SESSION_TTL_MS, MemorySessionStore } from '../stores/memory-session-store.ts'
import type { TaskStore, TaskWaiters, TaskLeases } from '../stores/task-store.ts'
import type { MessageBroker } from '../brokers/message-broker.ts'
import type { AuthorizationContext } from '../types/auth-types.ts'
import type { JsonSchemaValidator } from '../validation/json-schema-validator.ts'
import { processMessage, checkRequestId } from '../handlers.ts'
import { isStdioRequest } from '../stdio-marker.ts'
import { appendToHistory, publishSessionTerminated, SessionTopicSubscriptions } from '../session-topic.ts'
import type { SessionTopicPayload } from '../session-topic.ts'

const MAX_TIMER_DELAY_MS = 2 ** 31 - 1

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
  shutdownSignal?: AbortSignal
  taskLeases?: TaskLeases
  jsonSchemaValidator?: JsonSchemaValidator
  authPreHandler?: preHandlerHookHandler
  /** Filled in by this plugin; the parent calls `close` before closing the broker */
  sessionLifecycle: SessionLifecycle
}

export interface SessionLifecycle {
  close?: () => Promise<void>
}

/**
 * Per GET stream. While a Last-Event-ID replay is running, live events are
 * queued so they cannot overtake the replay; events already replayed are not
 * written a second time when they also arrive live.
 */
interface StreamState {
  replaying: boolean
  queued: Array<{ eventId: string, frame: string }>
  replayed: Set<string>
}

function resolveRouteUrl (prefix: string | undefined, url: string): string {
  if (!prefix || prefix === '/') {
    return url
  }

  const normalizedPrefix = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
  return `${normalizedPrefix}${url}`
}

function isThenable (value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  )
}

function resolveMcpRouteSchema (
  defaultSchema: FastifySchema | undefined,
  context: MCPRouteSchemaContext,
  transform?: MCPRouteSchemaTransformer
): FastifySchema | undefined {
  if (!transform) {
    return defaultSchema
  }

  const schema = defaultSchema ?? {}
  const transformed = transform(schema, context)

  if (typeof transformed !== 'object' || transformed === null || Array.isArray(transformed) || isThenable(transformed)) {
    throw new TypeError(`transformRouteSchema must return a synchronous Fastify schema object for ${context.routeId}`)
  }

  return transformed
}

// Body-parser failures happen before the handler runs, so without this they
// would surface as Fastify's default error body instead of a JSON-RPC error.
const BODY_PARSER_ERRORS: Record<string, { code: number, message: string }> = {
  FST_ERR_CTP_INVALID_JSON_BODY: { code: PARSE_ERROR, message: 'Parse error' },
  FST_ERR_CTP_EMPTY_JSON_BODY: { code: PARSE_ERROR, message: 'Parse error' },
  FST_ERR_CTP_BODY_TOO_LARGE: { code: INVALID_REQUEST, message: 'Invalid Request' },
  FST_ERR_CTP_INVALID_MEDIA_TYPE: { code: INVALID_REQUEST, message: 'Invalid Request' }
}

// A hook or parser can throw/reject with a non-Error value (a string, a plain
// object). Fastify would send such a value as the response body, so give the
// parent handler a generic Error instead and keep the original as `cause`.
function toError (value: unknown): FastifyError {
  if (value instanceof Error) {
    return value as FastifyError
  }
  const error = new Error('Internal Server Error', { cause: value }) as FastifyError
  error.statusCode = 500
  return error
}

function buildMcpPostErrorHandler (app: FastifyInstance) {
  return function mcpPostErrorHandler (thrown: unknown, request: FastifyRequest, reply: FastifyReply) {
    const error = toError(thrown)
    const mapped = error.code ? BODY_PARSER_ERRORS[error.code] : undefined
    if (!mapped) {
      // Call the encapsulating instance's handler (the user's setErrorHandler,
      // or Fastify's default) directly: rethrowing only delegates for Errors.
      return app.errorHandler(error, request, reply)
    }

    request.log.info({ err: error }, 'Rejected MCP request body')
    return reply.code(error.statusCode ?? 400).type('application/json').send({
      jsonrpc: JSONRPC_VERSION,
      id: null,
      error: mapped
    })
  }
}

const mcpPubSubRoutesPlugin: FastifyPluginAsync<MCPPubSubRoutesOptions> = async (app, options) => {
  const { enableSSE, opts, capabilities, serverInfo, tools, resources, prompts, resourceHandlers, sessionStore, messageBroker, localStreams, taskStore, taskWaiters, shutdownSignal, taskLeases, jsonSchemaValidator, authPreHandler, sessionLifecycle } = options
  const mcpUrl = resolveRouteUrl(app.prefix, '/mcp')

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

  function getRequestSessionId (request: FastifyRequest): string | undefined {
    return (request.headers['mcp-session-id'] as string | undefined) ||
      (request.method === 'GET' ? (request.query as any)?.['mcp-session-id'] : undefined)
  }

  /**
   * A session created under an access token belongs to that token's issuer and
   * subject: two authorization servers may assign the same `sub` to different
   * users, so the subject alone does not identify the owner. Anyone else presenting its ID gets the same 404 as for an unknown session:
   * the Streamable HTTP transport defines 404 as "this session does not exist
   * for you", and a 403 would confirm to an attacker that the ID is live.
   * Runs ahead of anything else that reads the session.
   */
  async function enforceSessionOwner (request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const sessionId = getRequestSessionId(request)
    if (!sessionId) return

    const session = await sessionStore.get(sessionId)
    if (session?.ownerSub === undefined) return

    if (session.ownerSub !== request.tokenPayload?.sub || session.ownerIss !== request.tokenIssuer) {
      request.log.warn({ sessionId }, 'Rejected MCP request for a session owned by a different user')
      return reply.code(404).type('application/json').send({ error: 'Session not found' })
    }
  }

  // Scoped to the /mcp routes only: this plugin is not encapsulated, so an
  // app-level hook would also cover the OAuth and well-known routes.
  const mcpOnRequest = [validateOrigin, validateProtocolVersionHeader]
  // When authorization is scoped to the MCP routes, the auth check runs first,
  // as it would if it were registered as a global preHandler hook, so the
  // session owner check sees the verified token.
  const mcpPreHandler: preHandlerHookHandler[] = authPreHandler
    ? [authPreHandler, enforceSessionOwner, reconcileProtocolVersion]
    : [enforceSessionOwner, reconcileProtocolVersion]

  // Heartbeats refresh session activity, so they must come more often than the
  // idle TTL or a live stream's session could expire between two of them
  const heartbeatIntervalMs = Math.min(30_000, Math.max(1, Math.floor((opts.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS) / 2)))

  function buildAuthContext (payload: any): AuthorizationContext {
    return {
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
  }

  /**
   * Whether a POST body can be handed to `processMessage`: a request, a
   * notification, a response to a server-initiated request, or a batch (which
   * `processMessage` refuses itself).
   */
  function isJSONRPCMessageShape (body: unknown): boolean {
    if (Array.isArray(body)) return true
    if (typeof body !== 'object' || body === null) return false
    return 'method' in body || 'result' in body || 'error' in body
  }

  async function createSession (request: FastifyRequest): Promise<SessionMetadata> {
    const sessionId = randomUUID()
    const session: SessionMetadata = {
      id: sessionId,
      eventId: 0,
      lastEventId: undefined,
      createdAt: new Date(),
      lastActivity: new Date()
    }

    // Bind the session to whoever created it, so its ID alone is not enough to
    // act as that user.
    const payload = request.tokenPayload
    if (payload && typeof payload.sub === 'string') {
      session.ownerSub = payload.sub
      session.ownerIss = request.tokenIssuer
      session.authorization = buildAuthContext(payload)
    }

    await sessionStore.create(session)

    // No broker subscription here: an instance subscribes to the session's
    // topic only while it holds one of its streams (see attachStream), and
    // messages sent meanwhile are kept in history by the sender
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

  const streamStates = new WeakMap<FastifyReply, StreamState>()

  // This instance is subscribed to a session's topic exactly while it holds one
  // of the session's streams; the subscription is what lets a stream on any
  // instance receive what is sent to the session from any other.
  const sessionTopics = new SessionTopicSubscriptions(
    messageBroker,
    (sessionId) => (localStreams.get(sessionId)?.size ?? 0) > 0,
    (sessionId, payload) => {
      // Brokers do not await this handler, so any rejection must be caught
      // here or it becomes an unhandled rejection that crashes the process
      onSessionTopicMessage(sessionId, payload).catch((error) => {
        app.log.error({ err: error, sessionId }, 'Failed to deliver message to session')
      })
    }
  )

  async function onSessionTopicMessage (sessionId: string, payload: SessionTopicPayload): Promise<void> {
    if (payload.kind === 'terminated') {
      endLocalStreams(sessionId)
      return
    }

    const streams = localStreams.get(sessionId)
    if (!streams || streams.size === 0) return

    if (payload.kind === 'event') {
      app.log.debug({ sessionId, eventId: payload.eventId }, 'Received message for session via broker, sending to streams')
      writeEventToStreams(sessionId, payload.eventId, payload.message, streams)
    } else {
      // Published to the topic directly instead of through mcpSendToSession,
      // so it still needs to be recorded
      await sendSSEToStreams(sessionId, payload.message, streams)
    }
  }

  async function attachStream (sessionId: string, reply: FastifyReply): Promise<void> {
    let streams = localStreams.get(sessionId)
    if (!streams) {
      streams = new Set()
      localStreams.set(sessionId, streams)
    }
    streams.add(reply)
    await sessionTopics.sync(sessionId)
  }

  function detachStream (sessionId: string, reply: FastifyReply): void {
    const streams = localStreams.get(sessionId)
    if (!streams || !streams.delete(reply)) return
    if (streams.size === 0) {
      localStreams.delete(sessionId)
    }
    sessionTopics.sync(sessionId).catch((error) => {
      app.log.error({ err: error, sessionId }, 'Failed to unsubscribe session from message broker')
    })
  }

  /** End this instance's streams for a session that was terminated or is gone */
  function endLocalStreams (sessionId: string): void {
    const streams = localStreams.get(sessionId)
    if (!streams) return
    for (const stream of [...streams]) {
      try {
        stream.raw.end()
      } catch {
        // stream may already be closed
      }
      detachStream(sessionId, stream)
    }
  }

  function writeEvent (sessionId: string, stream: FastifyReply, eventId: string, frame: string): void {
    const state = streamStates.get(stream)
    if (state?.replayed.has(eventId)) return
    if (state?.replaying) {
      state.queued.push({ eventId, frame })
      return
    }
    try {
      stream.raw.write(frame)
    } catch (error) {
      app.log.error({ err: error }, 'Failed to write SSE event')
      detachStream(sessionId, stream)
    }
  }

  function writeEventToStreams (sessionId: string, eventId: string, message: JSONRPCMessage, streams: Set<FastifyReply>): void {
    const frame = `id: ${eventId}\ndata: ${JSON.stringify(message)}\n\n`
    for (const stream of [...streams]) {
      writeEvent(sessionId, stream, eventId, frame)
    }
  }

  async function sendSSEToStreams (sessionId: string, message: JSONRPCMessage, streams: Set<FastifyReply>): Promise<void> {
    const eventId = await appendToHistory(sessionStore, sessionId, message)
    if (eventId === null) return
    writeEventToStreams(sessionId, eventId, message, streams)
  }

  async function replayMessagesFromEventId (sessionId: string, lastEventId: string, stream: FastifyReply): Promise<void> {
    const state = streamStates.get(stream)
    try {
      const messagesToReplay = await sessionStore.getMessagesFrom(sessionId, lastEventId)

      for (const entry of messagesToReplay) {
        const sseEvent = `id: ${entry.eventId}\ndata: ${JSON.stringify(entry.message)}\n\n`
        state?.replayed.add(entry.eventId)
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
    } finally {
      // Deliver what arrived live during the replay, minus what it already sent
      if (state) {
        state.replaying = false
        for (const { eventId, frame } of state.queued.splice(0)) {
          writeEvent(sessionId, stream, eventId, frame)
        }
      }
    }
  }

  {
    const schema = resolveMcpRouteSchema(undefined, {
      routeId: 'mcp.post',
      method: 'POST',
      url: mcpUrl
    }, opts.transformRouteSchema)
    const mcpPostErrorHandler = buildMcpPostErrorHandler(app)
    const routeOptions = schema === undefined
      ? { onRequest: mcpOnRequest, preHandler: mcpPreHandler, errorHandler: mcpPostErrorHandler }
      : { onRequest: mcpOnRequest, preHandler: mcpPreHandler, errorHandler: mcpPostErrorHandler, schema }

    app.post('/mcp', routeOptions, async (request: FastifyRequest, reply: FastifyReply) => {
      // null, numbers, strings, a text/plain body, ... are not JSON-RPC
      // messages; answer before a session is created for them.
      if (!isJSONRPCMessageShape(request.body)) {
        return reply.type('application/json').code(400).send({
          jsonrpc: JSONRPC_VERSION,
          id: null,
          error: {
            code: INVALID_REQUEST,
            message: 'Invalid Request: body is not a JSON-RPC message'
          }
        })
      }

      try {
        const message = request.body as JSONRPCMessage
        const idError = checkRequestId(message)
        if (idError) {
          return reply.code(400).type('application/json').send(idError)
        }

        let sessionId = request.headers['mcp-session-id'] as string | undefined
        const existingSession = sessionId ? await sessionStore.get(sessionId) : null

        // Sessions belong to Streamable HTTP, not to SSE. Without SSE we only open
        // one on initialize: other requests keep working statelessly as before,
        // and stateless clients do not each leave a session behind. Stdio
        // requests never carry a session id or open a GET stream, so a session
        // created for them would never be freed.
        if (!existingSession && !isStdioRequest(request) && (enableSSE || isInitializeRequest(message))) {
          const session = await createSession(request)
          reply.header('Mcp-Session-Id', session.id)
          sessionId = session.id
        }

        // Each request on a session counts as activity, so sessions that are in
        // use are not expired by the store's idle TTL
        if (existingSession) {
          await sessionStore.touch?.(existingSession.id)
        }

        // Build auth context from validated token payload
        let authContext: AuthorizationContext | undefined
        if (request.tokenPayload) {
          authContext = buildAuthContext(request.tokenPayload)
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
          tracer: opts.telemetry?.tracer,
          sessionStore,
          taskStore,
          taskWaiters,
          shutdownSignal,
          taskLeases,
          jsonSchemaValidator,
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
  }

  // GET endpoint for server-initiated communication via SSE
  if (!enableSSE) {
    app.get('/mcp', { onRequest: mcpOnRequest, preHandler: mcpPreHandler }, async (_request: FastifyRequest, reply: FastifyReply) => {
      reply.header('Allow', 'POST, DELETE').type('application/json').code(405).send({ error: 'Method Not Allowed: SSE not enabled' })
    })
  }

  if (enableSSE) {
    const schema = resolveMcpRouteSchema(undefined, {
      routeId: 'mcp.get',
      method: 'GET',
      url: mcpUrl
    }, opts.transformRouteSchema)
    const routeOptions = schema === undefined
      ? { onRequest: mcpOnRequest, preHandler: mcpPreHandler }
      : { onRequest: mcpOnRequest, preHandler: mcpPreHandler, schema }

    app.get('/mcp', routeOptions, async (request: FastifyRequest, reply: FastifyReply) => {
      if (!supportsSSE(request)) {
        reply.header('Allow', 'GET, POST, DELETE').type('application/json').code(405).send({ error: 'Method Not Allowed: SSE not supported' })
        return
      }

      try {
        const sessionId = getRequestSessionId(request)

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
            await sessionStore.touch?.(session.id)
          } else {
            session = await createSession(request)
            raw.setHeader('Mcp-Session-Id', session.id)
          }
        } else {
          session = await createSession(request)
          raw.setHeader('Mcp-Session-Id', session.id)
        }

        const lastEventId = request.headers['last-event-id'] as string | undefined
        streamStates.set(reply, { replaying: Boolean(lastEventId), queued: [], replayed: new Set() })

        // Registered before anything else is awaited, so a client that goes
        // away during setup is still detached
        reply.raw.on('close', () => {
          detachStream(session.id, reply)
          app.log.info({ sessionId: session.id }, 'SSE connection closed')
        })

        // Subscribe before reading history for the replay, so nothing sent in
        // between can be missed; anything seen by both is written once
        await attachStream(session.id, reply)

        raw.writeHead(200)

        app.log.info({
          sessionId: session.id,
          totalStreams: localStreams.get(session.id)?.size ?? 0,
          method: 'GET'
        }, 'Added new stream to session')

        // Handle resumability with Last-Event-ID
        if (lastEventId) {
          app.log.info(`Resuming SSE stream from event ID: ${lastEventId}`)
          await replayMessagesFromEventId(session.id, lastEventId, reply)
        }

        // SEP-1699: servers may end an SSE stream whenever they like, turning the
        // stream into a polling channel. The client reconnects with Last-Event-ID
        // on GET and we replay whatever it missed, so closing here loses nothing.
        // Access is only checked when the stream opens, so never let it outlive the
        // token that opened it: close at exp and the client reconnects with a fresh one.
        const tokenExp = request.tokenPayload?.exp
        const msUntilTokenExp = typeof tokenExp === 'number' ? Math.max(0, tokenExp * 1000 - Date.now()) : undefined
        let closeAfterMs = opts.sseMaxConnectionMs || undefined
        let closeReason = 'Closing SSE stream to let the client poll; it may resume with Last-Event-ID'
        if (msUntilTokenExp !== undefined && (closeAfterMs === undefined || msUntilTokenExp < closeAfterMs)) {
          closeAfterMs = msUntilTokenExp
          closeReason = 'Closing SSE stream because the token that opened it expired; it may reconnect with a fresh token'
        }

        if (closeAfterMs !== undefined) {
          const deadline = Date.now() + closeAfterMs
          let maxDurationTimer: NodeJS.Timeout | undefined
          const closeStream = () => {
            app.log.info({
              sessionId: session.id,
              afterMs: closeAfterMs
            }, closeReason)
            try {
              reply.raw.end()
            } catch {
            // already gone
            }
          }
          // setTimeout fires immediately on delays past 2^31-1 ms (~24.8 days), so
          // wait in capped steps until the deadline is reached
          const scheduleClose = () => {
            const remaining = Math.max(0, deadline - Date.now())
            maxDurationTimer = setTimeout(() => {
              if (Date.now() >= deadline) {
                closeStream()
              } else {
                scheduleClose()
              }
            }, Math.min(remaining, MAX_TIMER_DELAY_MS))
            maxDurationTimer.unref()
          }
          scheduleClose()

          reply.raw.on('close', () => clearTimeout(maxDurationTimer))
        }

        // Send initial heartbeat
        reply.raw.write(': heartbeat\n\n')

        // Keep connection alive with periodic heartbeats. Each heartbeat also
        // counts as session activity, so an open stream keeps its session from
        // expiring even when no messages flow over it.
        const heartbeatInterval = setInterval(() => {
          try {
            reply.raw.write(': heartbeat\n\n')
            sessionStore.touch?.(session.id)?.catch((err: unknown) => {
              app.log.warn({ err, sessionId: session.id }, 'Failed to refresh session activity on heartbeat')
            })
          } catch (error) {
            clearInterval(heartbeatInterval)
            detachStream(session.id, reply)
          }
        }, heartbeatIntervalMs)
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
  }

  // DELETE endpoint for explicit session termination (MCP spec)
  {
    const schema = resolveMcpRouteSchema(undefined, {
      routeId: 'mcp.delete',
      method: 'DELETE',
      url: mcpUrl
    }, opts.transformRouteSchema)
    const routeOptions = schema === undefined
      ? { onRequest: mcpOnRequest, preHandler: mcpPreHandler }
      : { onRequest: mcpOnRequest, preHandler: mcpPreHandler, schema }

    app.delete('/mcp', routeOptions, async (request: FastifyRequest, reply: FastifyReply) => {
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

      // Delete first, so a stream reconnecting elsewhere no longer finds it
      await sessionStore.delete(sessionId)

      // End this instance's streams, and tell the others to end theirs
      endLocalStreams(sessionId)
      if (enableSSE) {
        try {
          await publishSessionTerminated(messageBroker, sessionId)
        } catch (error) {
          app.log.error({ err: error, sessionId }, 'Failed to notify other instances of session termination')
        }
      }

      app.log.info({ sessionId }, 'Session terminated via DELETE')
      reply.code(204).send()
    })
  }

  // Subscribe to broadcast notifications
  if (enableSSE) {
    messageBroker.subscribe('mcp/broadcast/notification', async (notification: JSONRPCMessage) => {
      const isResourceUpdate = 'method' in notification && notification.method === 'notifications/resources/updated'
      const resourceUri = isResourceUpdate ? (notification.params as { uri?: unknown } | undefined)?.uri : undefined

      // Send to all local streams
      for (const [sessionId, streams] of localStreams.entries()) {
        if (streams.size === 0) continue

        // resources/updated only goes to sessions subscribed to that URI
        if (isResourceUpdate) {
          try {
            const session = await sessionStore.get(sessionId)
            if (typeof resourceUri !== 'string' || !session?.resourceSubscriptions?.includes(resourceUri)) {
              continue
            }
          } catch (error) {
            app.log.error({ err: error, sessionId }, 'Failed to check resource subscriptions')
            continue
          }
        }

        sendSSEToStreams(sessionId, notification, streams).catch((error) => {
          app.log.error({ err: error, sessionId }, 'Failed to deliver broadcast notification to session')
        })
      }
    })
  }

  // Sessions also end without a DELETE reaching this instance: they expire, are
  // deleted through another instance, or (Redis) their key is evicted. Sweep
  // periodically, whatever the store, so what this instance holds for such a
  // session is released. The memory store has no TTL mechanism of its own, so
  // the sweep is also what frees its expired sessions.
  const sweepIntervalMs = Math.min(opts.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS, 60_000)
  let sweeping = false
  async function sweepSessions (): Promise<void> {
    if (sessionStore instanceof MemorySessionStore) {
      await sessionStore.cleanup()
    }
    for (const sessionId of [...localStreams.keys()]) {
      if (!(await sessionStore.get(sessionId))) {
        app.log.info({ sessionId }, 'Session is gone, closing its SSE streams')
        endLocalStreams(sessionId)
      }
    }
  }
  const sweepTimer = setInterval(() => {
    if (sweeping) return
    sweeping = true
    sweepSessions().catch((err: unknown) => {
      app.log.error({ err }, 'Failed to clean up expired sessions')
    }).finally(() => {
      sweeping = false
    })
  }, sweepIntervalMs)
  // Never keep the process alive just to sweep sessions
  sweepTimer.unref()

  sessionLifecycle.close = async () => {
    clearInterval(sweepTimer)
    for (const [sessionId, streams] of localStreams) {
      for (const stream of streams) {
        try {
          if (stream.raw && !stream.raw.destroyed) {
            stream.raw.destroy()
          }
        } catch (error) {
          app.log.debug({ error, sessionId }, 'Error destroying SSE stream')
        }
      }
    }
    localStreams.clear()
    await sessionTopics.close()
  }
}

export default fp(mcpPubSubRoutesPlugin, {
  name: 'mcp-pubsub-routes'
})
