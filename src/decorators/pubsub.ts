import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import type {
  JSONRPCMessage,
  JSONRPCNotification,
  JSONRPCRequest,
  ElicitRequestFormParams,
  RequestId
} from '../schema.ts'
import { validateElicitationRequest, validateElicitationUrl } from '../security.ts'
import { JSONRPC_VERSION } from '../schema.ts'
import { randomUUID } from 'node:crypto'
import type { SessionStore } from '../stores/session-store.ts'
import type { MessageBroker } from '../brokers/message-broker.ts'

interface MCPPubSubDecoratorsOptions {
  enableSSE: boolean
  sessionStore: SessionStore
  messageBroker: MessageBroker
  localStreams: Map<string, Set<any>>
}

const mcpPubSubDecoratorsPlugin: FastifyPluginAsync<MCPPubSubDecoratorsOptions> = async (app, options) => {
  const { enableSSE, messageBroker, sessionStore } = options

  app.decorate('mcpBroadcastNotification', async (notification: JSONRPCNotification) => {
    if (!enableSSE) {
      app.log.warn('Cannot broadcast notification: SSE is disabled')
      return
    }

    try {
      await messageBroker.publish('mcp/broadcast/notification', notification)
    } catch (error) {
      app.log.error({ err: error }, 'Failed to broadcast notification')
    }
  })

  app.decorate('mcpSendToSession', async (sessionId: string, message: JSONRPCMessage): Promise<boolean> => {
    if (!enableSSE) {
      app.log.warn('Cannot send to session: SSE is disabled')
      return false
    }

    // Check if session exists in store
    const session = await sessionStore.get(sessionId)
    if (!session) {
      return false
    }

    // Always publish to messageBroker to support cross-instance messaging in Redis deployments
    // This ensures the message reaches the correct instance where the SSE connection exists
    try {
      await messageBroker.publish(`mcp/session/${sessionId}/message`, message)
      return true
    } catch (error) {
      app.log.error({ err: error }, 'Failed to send message to session')
      return false
    }
  })

  app.decorate('mcpElicit', async (
    sessionId: string,
    message: string,
    requestedSchema: ElicitRequestFormParams['requestedSchema'],
    requestId?: RequestId
  ): Promise<boolean> => {
    if (!enableSSE) {
      app.log.warn('Cannot send elicitation request: SSE is disabled')
      return false
    }

    // Validate elicitation request for security
    try {
      validateElicitationRequest(message, requestedSchema)
    } catch (validationError) {
      app.log.warn({
        sessionId,
        error: validationError instanceof Error ? validationError.message : 'Unknown validation error'
      }, 'Elicitation request validation failed')
      return false
    }

    // Generate a request ID if not provided
    const id = requestId ?? `elicit-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`

    const elicitRequest: JSONRPCRequest = {
      jsonrpc: JSONRPC_VERSION,
      id,
      method: 'elicitation/create',
      params: {
        message,
        requestedSchema
      }
    }

    return await app.mcpSendToSession(sessionId, elicitRequest)
  })

  // URL mode elicitation (2025-11-25): sends the user out of band for anything
  // sensitive — credentials, payments, third-party OAuth — so it never passes
  // through the MCP client.
  app.decorate('mcpElicitUrl', async (
    sessionId: string,
    message: string,
    url: string,
    elicitationId?: string,
    requestId?: RequestId
  ): Promise<string | null> => {
    if (!enableSSE) {
      app.log.warn('Cannot send elicitation request: SSE is disabled')
      return null
    }

    try {
      validateElicitationUrl(message, url)
    } catch (validationError) {
      app.log.warn({
        sessionId,
        error: validationError instanceof Error ? validationError.message : 'Unknown validation error'
      }, 'URL elicitation request validation failed')
      return null
    }

    const id = elicitationId ?? randomUUID()

    const elicitRequest: JSONRPCRequest = {
      jsonrpc: JSONRPC_VERSION,
      id: requestId ?? `elicit-${id}`,
      method: 'elicitation/create',
      params: {
        mode: 'url',
        message,
        url,
        elicitationId: id
      }
    }

    const sent = await app.mcpSendToSession(sessionId, elicitRequest)
    return sent ? id : null
  })

  // Tell the client an out-of-band interaction finished, so it can retry the
  // request that triggered it. Must go only to the session that started it.
  app.decorate('mcpNotifyElicitationComplete', async (
    sessionId: string,
    elicitationId: string
  ): Promise<boolean> => {
    const notification: JSONRPCNotification = {
      jsonrpc: JSONRPC_VERSION,
      method: 'notifications/elicitation/complete',
      params: { elicitationId }
    }

    return await app.mcpSendToSession(sessionId, notification)
  })
}

export default fp(mcpPubSubDecoratorsPlugin, {
  name: 'mcp-pubsub-decorators'
})
