import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import { CompletionService, type CompletionProvider } from '../features/completion.ts'

interface MCPCompletionDecoratorsOptions {
  enableCompletion: boolean
}

const mcpCompletionDecoratorsPlugin: FastifyPluginAsync<MCPCompletionDecoratorsOptions> = async (app, options) => {
  const { enableCompletion } = options

  if (!enableCompletion) {
    // If completion is disabled, provide no-op decorators
    app.decorate('mcpRegisterPromptCompletion', () => {})
    app.decorate('mcpRegisterResourceCompletion', () => {})
    app.decorate('completionService', undefined)
    return
  }

  const completionService = new CompletionService()

  // Decorate Fastify instance with completion registration methods
  app.decorate('mcpRegisterPromptCompletion', (
    promptName: string,
    provider: CompletionProvider
  ) => {
    completionService.registerPromptCompletion(promptName, provider)
  })

  app.decorate('mcpRegisterResourceCompletion', (
    uriPattern: string,
    provider: CompletionProvider
  ) => {
    completionService.registerResourceCompletion(uriPattern, provider)
  })

  // Store completion service for use in handlers
  app.decorate('completionService', completionService)
}

// Type declarations for Fastify
declare module 'fastify' {
  interface FastifyInstance {
    mcpRegisterPromptCompletion: (
      promptName: string,
      provider: CompletionProvider
    ) => void
    mcpRegisterResourceCompletion: (
      uriPattern: string,
      provider: CompletionProvider
    ) => void
    completionService?: CompletionService
  }
}

export default fp(mcpCompletionDecoratorsPlugin, {
  name: 'mcp-completion-decorators'
})
