import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import type { 
  MCPTool, 
  MCPResource, 
  MCPPrompt
} from '../types.ts'
import { schemaToArguments, validateToolSchema, typeBoxToJSONSchema } from '../validation/index.ts'

interface MCPDecoratorsOptions {
  tools: Map<string, MCPTool>
  resources: Map<string, MCPResource>
  prompts: Map<string, MCPPrompt>
}

const mcpDecoratorsPlugin: FastifyPluginAsync<MCPDecoratorsOptions> = async (app, options) => {
  const { tools, resources, prompts } = options

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
    }

    // Create tool definition with proper schema conversion
    let toolDefinition = definition
    if (definition.inputSchema && typeof definition.inputSchema === 'object' && 'kind' in definition.inputSchema) {
      // TypeBox schema - convert to JSON Schema for the definition
      toolDefinition = {
        ...definition,
        inputSchema: typeBoxToJSONSchema(definition.inputSchema)
      }
    }

    tools.set(name, { 
      definition: {
        ...toolDefinition,
        // Store the original schema for validation (TypeBox or JSON Schema)
        inputSchema: definition.inputSchema || toolDefinition.inputSchema
      }, 
      handler 
    })
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
    const promptDefinition = definition.argumentSchema ? {
      ...definition,
      arguments: schemaToArguments(definition.argumentSchema)
    } : definition

    prompts.set(name, { 
      definition: {
        ...promptDefinition,
        // Store the original TypeBox schema for validation
        argumentSchema: definition.argumentSchema
      }, 
      handler 
    })
  })
}

export default fp(mcpDecoratorsPlugin, {
  name: 'mcp-decorators'
})
