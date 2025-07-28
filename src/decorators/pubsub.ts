import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import type {
  JSONRPCMessage,
  JSONRPCNotification,
  JSONRPCRequest,
  ElicitRequest,
  RequestId
} from '../schema.ts'
import { JSONRPC_VERSION } from '../schema.ts'
import type { SessionStore } from '../stores/session-store.ts'
import type { MessageBroker } from '../brokers/message-broker.ts'

interface MCPPubSubDecoratorsOptions {
  enableSSE: boolean
  sessionStore: SessionStore
  messageBroker: MessageBroker
  localStreams: Map<string, Set<any>>
}

const mcpPubSubDecoratorsPlugin: FastifyPluginAsync<MCPPubSubDecoratorsOptions> = async (app, options) => {
  const { enableSSE, messageBroker, sessionStore, localStreams } = options

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

    // Check if there are active streams for this session
    const streams = localStreams.get(sessionId)
    if (!streams || streams.size === 0) {
      return false
    }

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
    requestedSchema: ElicitRequest['params']['requestedSchema'],
    requestId?: RequestId
  ): Promise<boolean> => {
    if (!enableSSE) {
      app.log.warn('Cannot send elicitation request: SSE is disabled')
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
}

export default fp(mcpPubSubDecoratorsPlugin, {
  name: 'mcp-pubsub-decorators'
})
