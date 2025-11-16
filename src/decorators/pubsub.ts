import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import type {
  JSONRPCMessage,
  JSONRPCNotification,
  JSONRPCRequest,
  FormElicitationParams,
  URLElicitationParams,
  RequestId
} from '../schema.ts'
import { validateElicitationRequest } from '../security.ts'
import { JSONRPC_VERSION } from '../schema.ts'
import type { SessionStore } from '../stores/session-store.ts'
import type { MessageBroker } from '../brokers/message-broker.ts'
import type { ElicitationStore } from '../stores/elicitation-store.ts'

interface MCPPubSubDecoratorsOptions {
  enableSSE: boolean
  sessionStore: SessionStore
  messageBroker: MessageBroker
  localStreams: Map<string, Set<any>>
  elicitationStore: ElicitationStore
}

const mcpPubSubDecoratorsPlugin: FastifyPluginAsync<MCPPubSubDecoratorsOptions> = async (app, options) => {
  const { enableSSE, messageBroker, sessionStore, elicitationStore } = options

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
    requestedSchema: FormElicitationParams['requestedSchema'],
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
        mode: 'form',
        message,
        requestedSchema
      }
    }

    return await app.mcpSendToSession(sessionId, elicitRequest)
  })

  app.decorate('mcpElicitURL', async (
    sessionId: string,
    elicitationId: string,
    url: string,
    message: string,
    userId?: string,
    requestId?: RequestId
  ): Promise<boolean> => {
    if (!enableSSE) {
      app.log.warn('Cannot send URL elicitation request: SSE is disabled')
      return false
    }

    // Store the elicitation request
    try {
      await elicitationStore.create({
        elicitationId,
        url,
        message,
        userId,
        sessionId
      })
    } catch (error) {
      app.log.error({ err: error, elicitationId }, 'Failed to store elicitation request')
      return false
    }

    // Generate a request ID if not provided
    const id = requestId ?? `elicit-url-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`

    const elicitRequest: JSONRPCRequest = {
      jsonrpc: JSONRPC_VERSION,
      id,
      method: 'elicitation/create',
      params: {
        mode: 'url',
        elicitationId,
        url,
        message
      } as URLElicitationParams
    }

    return await app.mcpSendToSession(sessionId, elicitRequest)
  })

  app.decorate('mcpCompleteElicitation', async (
    elicitationId: string
  ): Promise<boolean> => {
    if (!enableSSE) {
      app.log.warn('Cannot send elicitation completion: SSE is disabled')
      return false
    }

    // Mark elicitation as completed
    try {
      const elicitation = await elicitationStore.get(elicitationId)
      if (!elicitation) {
        app.log.warn({ elicitationId }, 'Elicitation not found for completion')
        return false
      }

      await elicitationStore.complete(elicitationId)

      // Send completion notification to the session
      if (elicitation.sessionId) {
        const notification: JSONRPCNotification = {
          jsonrpc: JSONRPC_VERSION,
          method: 'notifications/elicitation/complete',
          params: {
            elicitationId
          }
        }

        return await app.mcpSendToSession(elicitation.sessionId, notification)
      }

      return true
    } catch (error) {
      app.log.error({ err: error, elicitationId }, 'Failed to complete elicitation')
      return false
    }
  })

  // Store elicitation store for use in routes
  app.decorate('elicitationStore', elicitationStore)
}

// Type declarations for Fastify
declare module 'fastify' {
  interface FastifyInstance {
    elicitationStore?: ElicitationStore
    mcpElicitURL: (
      sessionId: string,
      elicitationId: string,
      url: string,
      message: string,
      userId?: string,
      requestId?: RequestId
    ) => Promise<boolean>
    mcpCompleteElicitation: (elicitationId: string) => Promise<boolean>
  }
}

export default fp(mcpPubSubDecoratorsPlugin, {
  name: 'mcp-pubsub-decorators'
})
