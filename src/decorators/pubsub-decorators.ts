import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import type { JSONRPCMessage, JSONRPCNotification } from '../schema.ts'
import type { MCPTool, MCPResource, MCPPrompt } from '../types.ts'
import type { SessionStore } from '../stores/session-store.ts'
import type { MessageBroker } from '../brokers/message-broker.ts'
import mcpDecoratorsPlugin from './decorators.ts'

interface MCPPubSubDecoratorsOptions {
  enableSSE: boolean
  tools: Map<string, MCPTool>
  resources: Map<string, MCPResource>
  prompts: Map<string, MCPPrompt>
  sessionStore: SessionStore
  messageBroker: MessageBroker
  localStreams: Map<string, Set<any>>
}

const mcpPubSubDecoratorsPlugin: FastifyPluginAsync<MCPPubSubDecoratorsOptions> = async (app, options) => {
  const { enableSSE, tools, resources, prompts, messageBroker, sessionStore, localStreams } = options

  // Register the base MCP decorators
  await app.register(mcpDecoratorsPlugin, { tools, resources, prompts })

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
}

export default fp(mcpPubSubDecoratorsPlugin, {
  name: 'mcp-pubsub-decorators'
})
