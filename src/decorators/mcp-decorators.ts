import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import type { JSONRPCMessage, JSONRPCNotification } from '../schema.ts'
import type { SSESession, ToolHandler, ResourceHandler, PromptHandler, MCPTool, MCPResource, MCPPrompt } from '../types.ts'
import { sendSSEMessage } from '../session/sse-session.ts'

interface MCPDecoratorsOptions {
  enableSSE: boolean
  tools: Map<string, MCPTool>
  resources: Map<string, MCPResource>
  prompts: Map<string, MCPPrompt>
}

const mcpDecoratorsPlugin: FastifyPluginAsync<MCPDecoratorsOptions> = async (app, options) => {
  const { enableSSE, tools, resources, prompts } = options

  app.decorate('mcpSessions', new Map<string, SSESession>())

  app.decorate('mcpBroadcastNotification', (notification: JSONRPCNotification) => {
    if (!enableSSE) {
      app.log.warn('Cannot broadcast notification: SSE is disabled')
      return
    }

    for (const session of app.mcpSessions.values()) {
      if (session.streams.size > 0) {
        sendSSEMessage(session, notification, app.mcpSessions, app)
      }
    }
  })

  app.decorate('mcpSendToSession', (sessionId: string, message: JSONRPCMessage): boolean => {
    if (!enableSSE) {
      app.log.warn('Cannot send to session: SSE is disabled')
      return false
    }

    const session = app.mcpSessions.get(sessionId)
    if (!session || session.streams.size === 0) {
      return false
    }

    sendSSEMessage(session, message, app.mcpSessions, app)
    return true
  })

  app.decorate('mcpAddTool', (definition: any, handler?: ToolHandler) => {
    const name = definition.name
    if (!name) {
      throw new Error('Tool definition must have a name')
    }
    tools.set(name, { definition, handler })
  })

  app.decorate('mcpAddResource', (definition: any, handler?: ResourceHandler) => {
    const uri = definition.uri
    if (!uri) {
      throw new Error('Resource definition must have a uri')
    }
    resources.set(uri, { definition, handler })
  })

  app.decorate('mcpAddPrompt', (definition: any, handler?: PromptHandler) => {
    const name = definition.name
    if (!name) {
      throw new Error('Prompt definition must have a name')
    }
    prompts.set(name, { definition, handler })
  })
}

export default fp(mcpDecoratorsPlugin, {
  name: 'mcp-decorators'
})
