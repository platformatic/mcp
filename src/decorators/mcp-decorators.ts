import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import type { ToolHandler, ResourceHandler, PromptHandler, MCPTool, MCPResource, MCPPrompt } from '../types.ts'

interface MCPDecoratorsOptions {
  tools: Map<string, MCPTool>
  resources: Map<string, MCPResource>
  prompts: Map<string, MCPPrompt>
}

const mcpDecoratorsPlugin: FastifyPluginAsync<MCPDecoratorsOptions> = async (app, options) => {
  const { tools, resources, prompts } = options

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