import { randomUUID } from 'crypto'
import type { FastifyError, FastifyInstance, FastifyRequest, FastifyReply, FastifyPluginAsync, FastifySchema, preHandlerHookHandler } from 'fastify'
import fp from 'fastify-plugin'
import type { JSONRPCMessage, JSONRPCNotification, JSONRPCRequest, JSONRPCResponse, JSONRPCError } from '../schema.ts'
import {
  JSONRPC_VERSION,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  PARSE_ERROR,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  HEADER_MISMATCH,
  MISSING_REQUIRED_CLIENT_CAPABILITY,
  UNSUPPORTED_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  MODERN_PROTOCOL_VERSIONS,
  DEFAULT_NEGOTIATED_PROTOCOL_VERSION
} from '../schema.ts'
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
import { DEFAULT_SESSION_TTL_MS } from '../stores/memory-session-store.ts'
import type { TaskStore, TaskWaiters, TaskLeases } from '../stores/task-store.ts'
import type { MessageBroker } from '../brokers/message-broker.ts'
import type { AuthorizationContext } from '../types/auth-types.ts'
import { processMessage, checkRequestId, createError, handlerContext, withMcpServerSpan } from '../handlers.ts'
import type { CachingConfig } from '../modern/handlers.ts'
import { coversInputCapabilities, dispatchModern } from '../modern/handlers.ts'
import {
  invalidModernMessage,
  isModernRequest,
  parseRequestContext,
  requestedProtocolVersion,
  requestIdOf
} from '../modern/request-meta.ts'
import type { RequestContext } from '../modern/request-meta.ts'
import { repeatedMirroredHeader, validateStandardHeaders } from '../modern/headers.ts'
import type { RequestStateSealer } from '../modern/request-state.ts'
import { DEFAULT_MAX_RESOURCE_SUBSCRIPTIONS, SubscriptionRegistry, invalidFilter, negotiateFilter } from '../modern/subscriptions.ts'
import type { SubscriptionDeadline } from '../modern/subscriptions.ts'
import { quotaKeyOf } from '../task-registry.ts'
import type { ClientCapabilities as ModernClientCapabilities, SubscriptionFilter } from '../schema-2026.ts'
import { isStdioRequest, stdioAuthContext, stdioRequestSignal } from '../stdio-trust.ts'
import { RequestStream, acceptsMediaType, requestNotifiers } from '../modern/request-stream.ts'
import type { TaskInputChannel } from '../modern/task-inputs.ts'
import type { JsonSchemaValidator } from '../validation/json-schema-validator.ts'

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
  taskInputs: TaskInputChannel
  sealer: RequestStateSealer
  caching: CachingConfig
  subscriptions: SubscriptionRegistry
  enableTasks: boolean
  authPreHandler?: preHandlerHookHandler
}

const PARSE_ERROR_CODES = new Set(['FST_ERR_CTP_INVALID_JSON_BODY', 'FST_ERR_CTP_EMPTY_JSON_BODY'])
const INVALID_BODY_CODES = new Set([
  'FST_ERR_CTP_BODY_TOO_LARGE',
  'FST_ERR_CTP_INVALID_MEDIA_TYPE',
  'FST_ERR_CTP_INVALID_CONTENT_LENGTH'
])

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

const mcpPubSubRoutesPlugin: FastifyPluginAsync<MCPPubSubRoutesOptions> = async (app, options) => {
  const {
    enableSSE, opts, capabilities, serverInfo, tools, resources, prompts, resourceHandlers,
    sessionStore, messageBroker, localStreams, taskStore, taskWaiters, jsonSchemaValidator,
    taskInputs, sealer, caching, subscriptions, enableTasks, authPreHandler, shutdownSignal, taskLeases
  } = options
  const mcpUrl = resolveRouteUrl(app.prefix, '/mcp')

  const allowedOrigins = opts.allowedOrigins

  if (allowedOrigins === undefined) {
    app.log.warn('MCP: no allowedOrigins configured, Origin validation is disabled. Set allowedOrigins to protect browser clients against DNS rebinding.')
  }

  /** Which protocol era this request belongs to. See `isModernRequest`. */
  function isModern (request: FastifyRequest): boolean {
    return isModernRequest(request.headers, request.body, MODERN_PROTOCOL_VERSIONS)
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
  //
  // POSTs are exempt from the rejection below: only the body tells us whether
  // the caller is modern, and a modern client must be answered with a JSON-RPC
  // `UnsupportedProtocolVersionError` rather than this legacy shape. The POST
  // handler makes that call once it has parsed the body.
  async function validateProtocolVersionHeader (request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const header = request.headers['mcp-protocol-version']
    if (header === undefined) {
      ;(request as any).mcpProtocolVersion = DEFAULT_NEGOTIATED_PROTOCOL_VERSION
      return
    }

    const version = Array.isArray(header) ? header[0] : header
    ;(request as any).mcpProtocolVersion = version

    if (request.method === 'POST') return

    if (!(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
      request.log.warn({ version }, 'Rejected MCP request with unsupported MCP-Protocol-Version header')
      return reply.code(400).type('application/json').send({
        error: `Bad Request: unsupported MCP-Protocol-Version '${version}'`,
        supported: SUPPORTED_PROTOCOL_VERSIONS
      })
    }
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
   * Reject an unsupported version header on a legacy POST.
   *
   * Runs as a preHandler because only the body distinguishes the eras: a modern
   * request must be answered with a JSON-RPC `UnsupportedProtocolVersionError`,
   * which `handleModernPost` does, whereas a legacy client expects this plain
   * 400 shape and has no way to act on the JSON-RPC one.
   */
  async function enforceProtocolVersionHeader (request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (isModern(request)) return

    const header = request.headers['mcp-protocol-version']
    if (header === undefined) return

    const version = Array.isArray(header) ? header[0] : header
    if ((SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(version)) return

    request.log.warn({ version }, 'Rejected MCP request with unsupported MCP-Protocol-Version header')
    return reply.code(400).type('application/json').send({
      error: `Bad Request: unsupported MCP-Protocol-Version '${version}'`,
      supported: SUPPORTED_PROTOCOL_VERSIONS
    })
  }

  /**
   * Reconcile the header against what the session actually negotiated.
   *
   * The session is authoritative: a client that agreed on 2025-03-26 must not be
   * able to opt into newer behaviour just by sending a newer header. Runs as a
   * preHandler because deciding whether this is an `initialize` needs the body.
   */
  async function reconcileProtocolVersion (request: FastifyRequest, reply: FastifyReply): Promise<void> {
    // Modern requests are stateless and carry their own version; there is no
    // session to reconcile against, and a stray `Mcp-Session-Id` is ignored.
    if (isModern(request)) return

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
   * users, so the subject alone does not identify the owner. Anyone else
   * presenting its ID gets the same 404 as for an unknown session: the
   * Streamable HTTP transport defines 404 as "this session does not exist for
   * you", and a 403 would confirm to an attacker that the ID is live. Runs
   * ahead of anything else that reads the session. Modern requests have no
   * session, and ignore a stray `Mcp-Session-Id`.
   */
  async function enforceSessionOwner (request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (isModern(request)) return
    const sessionId = getRequestSessionId(request)
    if (!sessionId) return

    const session = await sessionStore.get(sessionId)
    if (session?.ownerSub === undefined) return

    const owner = await sessionOwnerOf(request)
    if (session.ownerSub !== owner?.sub || session.ownerIss !== owner?.iss) {
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
    ? [authPreHandler, enforceProtocolVersionHeader, enforceSessionOwner, reconcileProtocolVersion]
    : [enforceProtocolVersionHeader, enforceSessionOwner, reconcileProtocolVersion]

  // Heartbeats refresh session activity, so they must come more often than the
  // idle TTL or a live stream's session could expire between two of them
  const heartbeatIntervalMs = Math.min(30_000, Math.max(1, Math.floor((opts.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS) / 2)))

  /**
   * The identity a validated token carries. The issuer is the normalized one
   * the validator vouched for (a trailing slash dropped, or the introspection
   * endpoint for an introspected token without `iss`), so the same user is the
   * same principal for sessions, tasks, quotas and sealed request state.
   */
  function buildAuthContext (request: FastifyRequest, payload: any): AuthorizationContext {
    return {
      userId: payload.sub,
      clientId: payload.client_id || payload.azp,
      scopes: typeof payload.scope === 'string' ? payload.scope.split(' ') : payload.scopes,
      audience: Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : undefined,
      tokenType: 'Bearer',
      expiresAt: payload.exp ? new Date(payload.exp * 1000) : undefined,
      issuedAt: payload.iat ? new Date(payload.iat * 1000) : undefined,
      authorizationServer: request.tokenIssuer ?? payload.iss
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
    const owner = await sessionOwnerOf(request)
    if (owner) {
      session.ownerSub = owner.sub
      session.ownerIss = owner.iss
    }
    const payload = request.tokenPayload
    if (!opts.resolveAuthorizationContext && payload && typeof payload.sub === 'string') {
      session.authorization = buildAuthContext(request, payload)
    }

    await sessionStore.create(session)

    // Without SSE there is no stream to deliver to, so skip the subscription
    if (!enableSSE) {
      return session
    }

    localStreams.set(sessionId, new Set())

    // Subscribe to messages for this session
    await messageBroker.subscribe(`mcp/session/${sessionId}/message`, async (message: JSONRPCMessage) => {
      // Brokers do not await this handler, so any rejection must be caught
      // here or it becomes an unhandled rejection that crashes the process
      try {
        const streams = localStreams.get(sessionId)
        if (streams && streams.size > 0) {
          app.log.debug({ sessionId, message }, 'Received message for session via broker, sending to streams')
          await sendSSEToStreams(sessionId, message, streams)
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
      } catch (error) {
        app.log.error({ err: error, sessionId }, 'Failed to deliver message to session')
      }
    })

    return session
  }

  function supportsSSE (request: FastifyRequest): boolean {
    const accept = request.headers.accept
    return accept ? accept.includes('text/event-stream') : false
  }

  /**
   * 2026-07-28 removed the GET stream and sessions, so neither GET nor DELETE
   * may allocate or terminate a legacy session for a modern caller.
   * Answers 405 as the transport spec requires and reports whether it did.
   */
  function rejectModernSessionMethod (request: FastifyRequest, reply: FastifyReply): boolean {
    if (!isModern(request)) return false
    reply.header('Allow', 'POST').type('application/json').code(405).send({
      error: `Method Not Allowed: ${request.method} is not part of the stateless protocol revision`
    })
    return true
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

  /**
   * The HTTP status a modern response carries.
   *
   * The revision pins specific statuses to specific JSON-RPC errors, and
   * clients rely on them: a dual-era client uses `400` plus a recognised
   * modern error body to tell a modern server from a legacy one, and `404`
   * with `-32601` to tell an unimplemented method from a legacy HTTP+SSE
   * server that does not host this endpoint at all.
   */
  /** Can this request not end in -32021 for input the client cannot give? */
  function cannotNeedMissingInput (message: JSONRPCRequest, clientCapabilities: ModernClientCapabilities): boolean {
    switch (message.method) {
      case 'tools/call': {
        const name = (message.params as { name?: unknown } | undefined)?.name
        const tool = typeof name === 'string' ? tools.get(name) : undefined
        return coversInputCapabilities(clientCapabilities, tool?.definition.inputCapabilities)
      }
      case 'prompts/get':
      case 'resources/read':
        return coversInputCapabilities(clientCapabilities)
      default:
        return true
    }
  }

  function statusForResponse (response: JSONRPCResponse | JSONRPCError): number {
    if (!('error' in response)) return 200

    switch (response.error.code) {
      case HEADER_MISMATCH:
      case UNSUPPORTED_PROTOCOL_VERSION:
      case MISSING_REQUIRED_CLIENT_CAPABILITY:
        return 400
      case METHOD_NOT_FOUND:
        return 404
      default:
        // Application-level failures — an unknown tool, a missing resource —
        // stay on 200 with a JSON-RPC error. Only the three errors above are
        // the ones a dual-era client reads a 400 body for, so widening this
        // would make an unknown tool look like a legacy server.
        return 200
    }
  }

  /**
   * Who a legacy session belongs to: the user the deployment's resolver
   * identifies when there is one, otherwise the verified token's subject at
   * its issuer. Undefined for anonymous callers, whose sessions are unbound.
   */
  async function sessionOwnerOf (request: FastifyRequest): Promise<{ sub: string, iss: string | undefined } | undefined> {
    if (opts.resolveAuthorizationContext) {
      const authContext = await authContextFrom(request)
      return typeof authContext?.userId === 'string'
        ? { sub: authContext.userId, iss: authContext.authorizationServer }
        : undefined
    }
    const payload = request.tokenPayload
    return payload && typeof payload.sub === 'string' ? { sub: payload.sub, iss: request.tokenIssuer } : undefined
  }

  /**
   * Resolved once per request, so the session owner check, telemetry,
   * authorization hooks, state sealing and task ownership all see the same
   * identity, and a resolver doing I/O runs only once.
   */
  const resolvedAuthContexts = new WeakMap<FastifyRequest, Promise<AuthorizationContext | undefined>>()

  /** Resolve the request identity from custom upstream auth or our validated token. */
  function authContextFrom (request: FastifyRequest): Promise<AuthorizationContext | undefined> {
    let resolved = resolvedAuthContexts.get(request)
    if (!resolved) {
      resolved = resolveAuthContext(request)
      resolvedAuthContexts.set(request, resolved)
    }
    return resolved
  }

  async function resolveAuthContext (request: FastifyRequest): Promise<AuthorizationContext | undefined> {
    // stdio skips HTTP authorization; its identity is the one the operator
    // gave the transport.
    const stdioIdentity = stdioAuthContext(request)
    if (stdioIdentity) return stdioIdentity
    // The resolver reads HTTP credentials, which a stdio request never has:
    // without a transport identity it is anonymous.
    if (isStdioRequest(request)) return undefined

    if (opts.resolveAuthorizationContext) {
      return await opts.resolveAuthorizationContext(request)
    }

    const payload = request.tokenPayload
    if (!payload) return undefined
    return buildAuthContext(request, payload)
  }

  /**
   * Ask the application about each resource a listen stream subscribes to,
   * through the same handlers as `resources/subscribe`. A URI whose handler
   * throws is dropped from the filter (all of them are when no handler is
   * registered), so the acknowledgement shows the
   * client what it was refused; the server must check access to resources,
   * and update notifications can reveal what changed and when. Returns what
   * to run when the stream ends: the unsubscribe handler for each URI that
   * was accepted.
   */
  /**
   * How many open listen streams on this instance hold each resource URI. The
   * subscribe handler runs for every stream, as it is also the access check,
   * but the unsubscribe handler only once the last of them ends, so a handler
   * that starts and stops a watcher keeps it while anyone still listens.
   */
  const listenUriHolders = new Map<string, number>()

  async function authorizeResourceSubscriptions (
    filter: SubscriptionFilter,
    request: FastifyRequest,
    reply: FastifyReply,
    authContext: AuthorizationContext | undefined,
    context: RequestContext
  ): Promise<(() => void) | undefined> {
    if (!filter.resourceSubscriptions) return undefined
    const { subscribeHandler } = resourceHandlers
    // Without a handler nothing can check access, and update notifications
    // reveal what changed and when: refuse them all, as `resources/subscribe`
    // does on the handshake revisions.
    if (!subscribeHandler) {
      request.log.info({ refused: filter.resourceSubscriptions.length }, 'Resource subscriptions refused: no subscribe handler is registered')
      delete filter.resourceSubscriptions
      return undefined
    }

    const handlerContextFor = () => handlerContext({
      request,
      reply,
      authContext,
      protocolVersion: context.protocolVersion,
      clientCapabilities: context.clientCapabilities
    }, undefined)
    const uris = filter.resourceSubscriptions
    const outcomes = await Promise.allSettled(uris.map(async uri => await subscribeHandler({ uri }, handlerContextFor())))
    const accepted = uris.filter((_uri, index) => outcomes[index].status === 'fulfilled')
    const refused = uris.length - accepted.length
    if (refused > 0) request.log.info({ refused }, 'Resource subscriptions refused by the subscribe handler')

    if (accepted.length > 0) {
      filter.resourceSubscriptions = accepted
    } else {
      delete filter.resourceSubscriptions
    }

    const { unsubscribeHandler } = resourceHandlers
    if (!unsubscribeHandler || accepted.length === 0) return undefined
    for (const uri of accepted) listenUriHolders.set(uri, (listenUriHolders.get(uri) ?? 0) + 1)
    return () => {
      for (const uri of accepted) {
        // Another stream on this instance still wants updates for it.
        const holders = (listenUriHolders.get(uri) ?? 1) - 1
        if (holders > 0) {
          listenUriHolders.set(uri, holders)
          continue
        }
        listenUriHolders.delete(uri)
        Promise.resolve()
          .then(async () => await unsubscribeHandler({ uri }, handlerContextFor()))
          .catch(error => app.log.warn({ err: error, uri }, 'Resource unsubscribe handler failed'))
      }
    }
  }

  /**
   * When a listen stream must end: when the token that opened it expires, or
   * after `sseMaxConnectionMs`, whichever comes first. Access is only checked
   * when the stream opens, as for the legacy GET stream.
   */
  function listenDeadline (authContext: AuthorizationContext | undefined): SubscriptionDeadline | undefined {
    const expiresAt = authContext?.expiresAt?.getTime()
    const maxAt = opts.sseMaxConnectionMs ? Date.now() + opts.sseMaxConnectionMs : undefined
    if (expiresAt !== undefined && Number.isFinite(expiresAt) && (maxAt === undefined || expiresAt <= maxAt)) {
      return { at: expiresAt, reason: 'The access token that opened this subscription expired' }
    }
    if (maxAt !== undefined) return { at: maxAt, reason: 'Subscription reached its maximum duration' }
    return undefined
  }

  /**
   * Serve a request that speaks 2026-07-28.
   *
   * Nothing here consults or creates a session: the request's `_meta` carries
   * everything needed to serve it, which is what lets an instance behind a
   * plain round-robin balancer handle any request.
   */
  async function handleModernPost (
    request: FastifyRequest,
    reply: FastifyReply,
    authContext: AuthorizationContext | undefined
  ): Promise<unknown> {
    const body = request.body as unknown

    // The transport carries exactly one JSON-RPC request or notification. A
    // batch must not be mistaken for a notification and silently dropped.
    const invalid = invalidModernMessage(body)
    if (invalid !== undefined) {
      reply.code(400).type('application/json')
      return createError(requestIdOf(body), INVALID_REQUEST, invalid)
    }

    // A notification has no id and gets no body back.
    if (!('id' in (body as object))) {
      request.log.debug({ method: (body as JSONRPCNotification).method }, 'Accepted modern notification')
      reply.code(202)
      return undefined
    }

    const message = body as JSONRPCRequest

    // The version decides which rules apply, so check it before anything this
    // revision requires: a client on a version we do not implement must learn
    // which ones we do, rather than fail a requirement it never signed up for.
    // A legacy version named in `_meta` gets the same answer, so the client
    // falls back to the handshake.
    const requestedVersion = requestedProtocolVersion(message.params)
    // A header naming another version is a mismatch, which the transport
    // answers with HeaderMismatch whichever of the two we implement.
    const headerVersion = request.headers['mcp-protocol-version']
    const sentVersion = Array.isArray(headerVersion) ? headerVersion[0] : headerVersion
    if (!isStdioRequest(request) && requestedVersion !== undefined && sentVersion !== undefined && sentVersion !== requestedVersion) {
      reply.code(400).type('application/json')
      return createError(
        message.id,
        HEADER_MISMATCH,
        `Header mismatch: MCP-Protocol-Version header value '${sentVersion}' does not match body value '${requestedVersion}'`
      )
    }
    if (requestedVersion !== undefined &&
        !(MODERN_PROTOCOL_VERSIONS as readonly string[]).includes(requestedVersion)) {
      reply.code(400).type('application/json')
      return createError(message.id, UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', {
        supported: [...SUPPORTED_PROTOCOL_VERSIONS],
        requested: requestedVersion
      })
    }

    const parsed = parseRequestContext(message.params)
    if (!parsed.ok) {
      reply.code(400).type('application/json')
      return createError(message.id, INVALID_PARAMS, parsed.message)
    }
    const context = parsed.context

    // stdio has no header layer, so there is nothing to reconcile there.
    const headerLayer = !isStdioRequest(request)
    if (headerLayer) {
      const repeated = repeatedMirroredHeader(request.raw.rawHeaders)
      if (repeated !== undefined) {
        reply.code(400).type('application/json')
        return createError(message.id, HEADER_MISMATCH, `Header mismatch: ${repeated} must be sent only once`)
      }

      // The mirrored header and the body must agree, or a gateway routing on
      // one and this server acting on the other could be made to disagree.
      if (sentVersion === undefined) {
        reply.code(400).type('application/json')
        return createError(message.id, HEADER_MISMATCH, 'Missing required MCP-Protocol-Version header')
      }
      if (sentVersion !== context.protocolVersion) {
        reply.code(400).type('application/json')
        return createError(
          message.id,
          HEADER_MISMATCH,
          `Header mismatch: MCP-Protocol-Version header value '${sentVersion}' does not match body value '${context.protocolVersion}'`
        )
      }

      const headerCheck = validateStandardHeaders(request.headers, message.method, message.params)
      if (!headerCheck.ok) {
        reply.code(400).type('application/json')
        return createError(message.id, HEADER_MISMATCH, headerCheck.message)
      }
    }

    // `subscriptions/listen` answers with a stream rather than a value, so it
    // never reaches the dispatcher.
    if (message.method === 'subscriptions/listen') {
      const requested = (message.params as { notifications?: unknown } | undefined)?.notifications
      const invalidListen = invalidFilter(requested)
      if (invalidListen !== undefined) {
        reply.code(400).type('application/json')
        return createError(message.id, INVALID_PARAMS, invalidListen)
      }

      const maxUris = opts.subscriptionMaxResourceUris ?? DEFAULT_MAX_RESOURCE_SUBSCRIPTIONS
      const uriCount = (requested as SubscriptionFilter).resourceSubscriptions?.length ?? 0
      if (uriCount > maxUris) {
        reply.code(400).type('application/json')
        return createError(message.id, INVALID_PARAMS, `Too many resourceSubscriptions: at most ${maxUris} per stream`)
      }

      // A stdio client may cancel a listen before it is even opened; opening it
      // then would leak a stream nobody will ever close.
      const listenCancel = stdioRequestSignal(request)
      if (listenCancel?.aborted) {
        reply.code(204)
        return undefined
      }

      const quotaKey = quotaKeyOf(authContext)
      const reserved = subscriptions.reserve(quotaKey)
      if (typeof reserved === 'string') {
        reply.code(429).type('application/json')
        return createError(message.id, INVALID_REQUEST, reserved)
      }

      let opened: boolean
      try {
        const filter = negotiateFilter(requested as SubscriptionFilter, capabilities)
        const onEnd = await authorizeResourceSubscriptions(filter, request, reply, authContext, context)
        // The filter can be large and is the client's to choose: log its shape.
        request.log.info({
          subscriptionId: message.id,
          types: Object.keys(filter).filter(key => key !== 'resourceSubscriptions'),
          resourceSubscriptions: filter.resourceSubscriptions?.length ?? 0
        }, 'Opening subscription stream')
        opened = subscriptions.open(reply, message.id, filter, quotaKey, listenCancel, onEnd, listenDeadline(authContext))
      } finally {
        reserved()
      }
      if (!opened && !reply.sent) {
        if (listenCancel?.aborted) {
          reply.code(204)
          return undefined
        }
        reply.code(503).type('application/json')
        return createError(message.id, INTERNAL_ERROR, 'Server is shutting down')
      }
      return reply
    }

    // On this revision closing the response stream is the client's way to
    // cancel, so a close while the request is still being handled aborts the
    // handler. A close after that is just the connection ending: in-process
    // injection (stdio, mcpClient) emits it before `writableFinished` is set,
    // so the response state alone cannot tell the two apart.
    const cancelled = new AbortController()
    // On stdio there is no stream to close: `notifications/cancelled` does it.
    const stdioCancel = stdioRequestSignal(request)
    let handled = false
    reply.raw.once('close', () => {
      if (!handled) cancelled.abort(new Error('client disconnected'))
    })
    // A client that went away while hooks ran (token validation, say) closed
    // the connection before the listener above existed.
    // (The request stream itself is destroyed once its body is read, so it
    // cannot tell; the socket and the response can.)
    if (reply.raw.destroyed || request.raw.socket?.destroyed === true) cancelled.abort(new Error('client disconnected'))

    // Progress and log notifications ride the response stream, so only open
    // one when the client asked for them and can read it.
    const wantsNotifications = context.progressToken !== undefined || context.logLevel !== undefined
    // A handler that asks for input the client cannot give is refused with
    // -32021, which must go out as a 400; once the stream opens the status is
    // 200. So it opens early only when that refusal cannot happen.
    const stream = wantsNotifications && acceptsMediaType(request.headers.accept, 'text/event-stream')
      ? new RequestStream(reply, { openEarly: cannotNeedMissingInput(message, context.clientCapabilities) })
      : undefined

    let response: JSONRPCResponse | JSONRPCError
    try {
      response = await dispatchModern(message, {
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
        taskStore,
        taskWaiters,
        jsonSchemaValidator,
        taskInputs,
        protocolVersion: context.protocolVersion,
        context,
        sealer,
        caching,
        supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
        enableTasks,
        headerLayer,
        // A shutdown aborts the handler too: `app.close()` waits for requests
        // in flight, and a long-running tool would otherwise hold it forever.
        signal: AbortSignal.any([cancelled.signal, ...(stdioCancel ? [stdioCancel] : []), ...(shutdownSignal ? [shutdownSignal] : [])]),
        notifiers: requestNotifiers(context, stream)
      })
    } finally {
      handled = true
    }

    // The stream opened because the tool declared the input it may need and
    // the client has all of it; asking for more is the tool's bug, and a 400
    // can no longer be sent.
    if (stream?.opened && 'error' in response && response.error.code === MISSING_REQUIRED_CLIENT_CAPABILITY) {
      request.log.error({ method: message.method, data: response.error.data }, 'Handler asked for input beyond its declared inputCapabilities after progress had streamed')
      response = createError(message.id, INTERNAL_ERROR, 'Internal server error')
    }

    // Serialize here, once: a result a handler built with a BigInt or a cycle
    // must still answer this id, and must not fail after a stream has opened.
    let serialized: string
    try {
      serialized = JSON.stringify(response)
    } catch (error) {
      request.log.error({ err: error, method: message.method }, 'MCP response could not be serialized')
      response = createError(message.id, INTERNAL_ERROR, 'Internal server error')
      serialized = JSON.stringify(response)
    }

    // Concluding the stream also closes it to late notifications, which would
    // otherwise take over a reply that is about to be sent as JSON.
    if (stream?.finish(response, serialized)) {
      // The stream carried the response. Returning it as well (Fastify sends
      // nothing for a hijacked reply) lets telemetry record its outcome.
      if (!reply.sent) reply.hijack()
      return response
    }

    // The response object is still returned so telemetry can read its outcome;
    // the serializer reuses the string instead of encoding it a second time.
    reply.type('application/json').code(statusForResponse(response)).serializer(() => serialized)
    return response
  }

  const postSchema = resolveMcpRouteSchema(undefined, {
    routeId: 'mcp.post',
    method: 'POST',
    url: mcpUrl
  }, opts.transformRouteSchema)
  /**
   * Answer body-parser failures in JSON-RPC, keeping their HTTP status. A
   * client reads a 400 without a JSON-RPC error as a server that does not
   * speak this revision. Anything else goes to the application's handler.
   */
  function bodyParserErrorHandler (thrown: unknown, request: FastifyRequest, reply: FastifyReply) {
    const error = toError(thrown)
    const code = PARSE_ERROR_CODES.has(error.code) || (error instanceof SyntaxError && error.statusCode === 400)
      ? PARSE_ERROR
      : INVALID_BODY_CODES.has(error.code) ? INVALID_REQUEST : undefined
    if (code === undefined) {
      // Call the encapsulating instance's handler (the user's setErrorHandler,
      // or Fastify's default) directly: rethrowing only delegates for Errors.
      return (app as FastifyInstance).errorHandler(error, request, reply)
    }
    request.log.info({ err: error }, 'Rejected MCP request body')
    return reply.code(error.statusCode ?? 400).type('application/json')
      .send(createError(null, code, code === PARSE_ERROR ? 'Parse error' : 'Invalid Request'))
  }

  const postRouteOptions = {
    onRequest: mcpOnRequest,
    preHandler: mcpPreHandler,
    errorHandler: bodyParserErrorHandler,
    ...(postSchema === undefined ? {} : { schema: postSchema })
  }

  app.post('/mcp', postRouteOptions, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      // Resolve once so telemetry, authorization hooks, state sealing and task
      // ownership all observe exactly the same identity for this request.
      const resolvedAuthContext = await authContextFrom(request)

      if (isModern(request)) {
        // A body that is not a JSON-RPC message has nothing to trace; the span
        // would only fail reading it, turning a 400 into a 500.
        if (invalidModernMessage(request.body) !== undefined) {
          return await handleModernPost(request, reply, resolvedAuthContext)
        }
        const message = request.body as JSONRPCRequest | JSONRPCNotification
        return await withMcpServerSpan(message, undefined, {
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
          authContext: resolvedAuthContext,
          tracer: opts.telemetry?.tracer,
          taskStore,
          taskWaiters,
          jsonSchemaValidator,
          taskInputs,
          // The body is authoritative on this path (stdio sends no header).
          protocolVersion: requestedProtocolVersion((message as { params?: unknown } | null)?.params)
        }, async () => await handleModernPost(request, reply, resolvedAuthContext))
      }

      // null, numbers, strings, a text/plain body, ... are not JSON-RPC
      // messages; answer before a session is created for them.
      if (!isJSONRPCMessageShape(request.body)) {
        reply.code(400).type('application/json')
        return createError(null, INVALID_REQUEST, 'Invalid Request: body is not a JSON-RPC message')
      }

      const message = request.body as JSONRPCMessage
      const idError = checkRequestId(message)
      if (idError) {
        reply.code(400).type('application/json')
        return idError
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

      // Build auth context from validated token payload or the custom resolver.
      let authContext = resolvedAuthContext
      if (!authContext && !opts.resolveAuthorizationContext && sessionId) {
        // Built-in OAuth may persist identity on a legacy SSE session.
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
        taskInputs,
        jsonSchemaValidator,
        sessionId,
        protocolVersion: (request as any).mcpProtocolVersion ?? DEFAULT_NEGOTIATED_PROTOCOL_VERSION,
        // Over HTTP a legacy disconnect is not a cancellation, but on stdio
        // `notifications/cancelled` is, whichever revision the client speaks.
        signal: stdioRequestSignal(request)
      })
      if (response) {
        return response
      } else {
        reply.code(202)
      }
    } catch (error) {
      app.log.error({ err: error }, 'Error processing MCP message')
      // A response already under way (a hijacked stream) cannot become a 500;
      // end it so the client is not left waiting.
      if (reply.sent || reply.raw.headersSent) {
        reply.raw.destroy()
        return
      }
      reply.type('application/json').code(500).send({
        jsonrpc: JSONRPC_VERSION,
        // Keep the request's id when it has one, so the client can correlate.
        id: requestIdOf(request.body),
        error: {
          code: INTERNAL_ERROR,
          message: 'Internal server error'
        }
      })
    }
  })

  // Without SSE there is no standing stream to open, so GET answers 405 as the
  // transport asks, naming what is allowed. Sessions can still be ended.
  if (!enableSSE) {
    app.get('/mcp', { onRequest: mcpOnRequest, preHandler: mcpPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
      if (rejectModernSessionMethod(request, reply)) return
      reply.header('Allow', 'POST, DELETE').type('application/json').code(405).send({
        error: `Method Not Allowed: ${request.method} requires SSE, which is not enabled`
      })
    })
  }

  if (enableSSE) {
    const getSchema = resolveMcpRouteSchema(undefined, {
      routeId: 'mcp.get',
      method: 'GET',
      url: mcpUrl
    }, opts.transformRouteSchema)
    const getRouteOptions = getSchema === undefined
      ? { onRequest: mcpOnRequest, preHandler: mcpPreHandler }
      : { onRequest: mcpOnRequest, preHandler: mcpPreHandler, schema: getSchema }

    app.get('/mcp', getRouteOptions, async (request: FastifyRequest, reply: FastifyReply) => {
      if (rejectModernSessionMethod(request, reply)) return

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
              messageBroker.unsubscribe(`mcp/session/${session.id}/message`).catch((error) => {
                app.log.error({ err: error, sessionId: session.id }, 'Failed to unsubscribe session from message broker')
              })
            }
          }
        })

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
            const streams = localStreams.get(session.id)
            if (streams) {
              streams.delete(reply)
            }
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
    const deleteSchema = resolveMcpRouteSchema(undefined, {
      routeId: 'mcp.delete',
      method: 'DELETE',
      url: mcpUrl
    }, opts.transformRouteSchema)
    const deleteRouteOptions = deleteSchema === undefined
      ? { onRequest: mcpOnRequest, preHandler: mcpPreHandler }
      : { onRequest: mcpOnRequest, preHandler: mcpPreHandler, schema: deleteSchema }

    app.delete('/mcp', deleteRouteOptions, async (request: FastifyRequest, reply: FastifyReply) => {
      if (rejectModernSessionMethod(request, reply)) return

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

  // Subscribe to broadcast notifications.
  //
  // The same broadcast feeds both eras: legacy SSE sessions get it on their
  // standing stream, and modern `subscriptions/listen` streams get whichever
  // notification types they opted in to. Registering unconditionally means
  // modern subscriptions work without `enableSSE`, which is a legacy concept.
  //
  // The broker does not await the handler, so anything it throws must be
  // caught here or it becomes an unhandled rejection.
  await messageBroker.subscribe('mcp/broadcast/notification', async (notification: JSONRPCMessage) => {
    try {
      await deliverBroadcast(notification)
    } catch (error) {
      app.log.error({ err: error }, 'Failed to deliver broadcast notification')
    }
  })

  async function deliverBroadcast (notification: JSONRPCMessage): Promise<void> {
    subscriptions.deliver(notification as JSONRPCNotification)

    if (!enableSSE) return
    const isResourceUpdate = 'method' in notification && notification.method === 'notifications/resources/updated'
    const resourceUri = isResourceUpdate ? (notification.params as { uri?: unknown } | undefined)?.uri : undefined

    for (const [sessionId, streams] of localStreams.entries()) {
      if (streams.size === 0) continue

      // resources/updated only goes to legacy sessions subscribed to that URI
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
  }
}

export default fp(mcpPubSubRoutesPlugin, {
  name: 'mcp-pubsub-routes'
})
