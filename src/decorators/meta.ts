import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import type {
  MCPTool,
  MCPResource,
  MCPPrompt,
  MCPPluginOptions,
  McpCallToolContext,
  ResourceHandlers,
  ResourceSubscribeHandler,
  ResourceUnsubscribeHandler
} from '../types.ts'
import { callRegisteredTool } from '../handlers.ts'
import { schemaToArguments, validateToolSchema, isTypeBoxSchema } from '../validation/index.ts'
import type { JsonSchemaValidator } from '../validation/json-schema-validator.ts'

interface MCPDecoratorsOptions {
  tools: Map<string, MCPTool>
  resources: Map<string, MCPResource>
  prompts: Map<string, MCPPrompt>
  resourceHandlers: ResourceHandlers
  opts: MCPPluginOptions
  jsonSchemaValidator?: JsonSchemaValidator
}

const mcpDecoratorsPlugin: FastifyPluginAsync<MCPDecoratorsOptions> = async (app, options) => {
  const { tools, resources, prompts, resourceHandlers, opts, jsonSchemaValidator } = options

  // Enhanced tool decorator with TypeBox schema support
  app.decorate('mcpAddTool', (
    definition: any,
    handler?: any
  ) => {
    const name = definition.name
    if (!name) {
      throw new Error('Tool definition must have a name')
    }

    // Validate schema if provided
    if (definition.inputSchema) {
      const schemaErrors = validateToolSchema(definition.inputSchema)
      if (schemaErrors.length > 0) {
        throw new Error(`Invalid tool schema for '${name}': ${schemaErrors.join(', ')}`)
      }

      // When AJV validation is on, an uncompilable plain JSON Schema must fail
      // registration rather than register a tool whose inputs can't be checked
      if (jsonSchemaValidator && !isTypeBoxSchema(definition.inputSchema)) {
        try {
          jsonSchemaValidator.compileAndCache(definition.inputSchema)
        } catch (error) {
          throw new Error(`Invalid tool schema for '${name}': ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }

    // TypeBox schemas are already JSON Schema compatible
    const toolDefinition = definition

    tools.set(name, {
      definition: {
        ...toolDefinition,
        // Store the original schema for validation (TypeBox or JSON Schema)
        inputSchema: definition.inputSchema || toolDefinition.inputSchema
      },
      handler
    })
  })

  app.decorate('mcpCallTool', (name: string, args: Record<string, unknown>, context: McpCallToolContext) => {
    return callRegisteredTool(name, args, {
      app,
      opts,
      tools,
      jsonSchemaValidator,
      request: context.request,
      reply: context.reply,
      authContext: context.authContext
    })
  })

  app.decorate('mcpHasTool', (name: string): boolean => {
    return tools.has(name)
  })

  app.decorate('mcpListToolNames', (): readonly string[] => {
    return [...tools.keys()]
  })

  // Enhanced resource decorator with URI schema support
  app.decorate('mcpAddResource', (
    definition: any,
    handler?: any
  ) => {
    const uriPattern = definition.uriPattern || definition.uri
    if (!uriPattern) {
      throw new Error('Resource definition must have a uri or uriPattern')
    }

    // Convert uriPattern to uri for the definition
    const resourceDefinition = {
      ...definition,
      uri: uriPattern
    }

    resources.set(uriPattern, { definition: resourceDefinition, handler })
  })

  // Enhanced prompt decorator with argument schema support
  app.decorate('mcpAddPrompt', (
    definition: any,
    handler?: any
  ) => {
    const name = definition.name
    if (!name) {
      throw new Error('Prompt definition must have a name')
    }

    // Generate arguments array from schema if provided
    const promptDefinition = definition.argumentSchema
      ? {
          ...definition,
          arguments: schemaToArguments(definition.argumentSchema)
        }
      : definition

    prompts.set(name, {
      definition: {
        ...promptDefinition,
        // Store the original TypeBox schema for validation
        argumentSchema: definition.argumentSchema
      },
      handler
    })
  })

  // Resource subscription handler setters
  app.decorate('mcpSetResourceSubscribeHandler', (handler: ResourceSubscribeHandler) => {
    resourceHandlers.subscribeHandler = handler
  })

  app.decorate('mcpSetResourceUnsubscribeHandler', (handler: ResourceUnsubscribeHandler) => {
    resourceHandlers.unsubscribeHandler = handler
  })
}

export default fp(mcpDecoratorsPlugin, {
  name: 'mcp-decorators'
})
