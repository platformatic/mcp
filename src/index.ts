import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import type {
  ServerCapabilities,
  Implementation
} from './schema.ts'
import type { MCPPluginOptions, MCPTool, MCPResource, MCPPrompt } from './types.ts'
import mcpRoutesPlugin from './routes/mcp-routes.ts'
import mcpDecoratorsPlugin from './decorators/mcp-decorators.ts'

export default fp(async function (app: FastifyInstance, opts: MCPPluginOptions) {
  const serverInfo: Implementation = opts.serverInfo ?? {
    name: 'fastify-mcp-server',
    version: '1.0.0'
  }

  const capabilities: ServerCapabilities = opts.capabilities ?? {
    tools: {},
    resources: {},
    prompts: {}
  }

  const enableSSE = opts.enableSSE ?? false
  const tools = new Map<string, MCPTool>()
  const resources = new Map<string, MCPResource>()
  const prompts = new Map<string, MCPPrompt>()

  // Register decorators first
  await app.register(mcpDecoratorsPlugin, {
    enableSSE,
    tools,
    resources,
    prompts
  })

  // Register routes
  await app.register(mcpRoutesPlugin, {
    enableSSE,
    opts,
    capabilities,
    serverInfo,
    tools,
    resources,
    prompts
  })
}, {
  name: 'fastify-mcp'
})
