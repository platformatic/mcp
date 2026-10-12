import { expectType, expectAssignable, expectNotAssignable } from 'tsd'
import { Type } from '@sinclair/typebox'
import Fastify from 'fastify'
import mcpPlugin from '../dist/index.js'
import type { MCPPluginOptions, MCPClientResponseContext, JSONRPCResponse } from '../dist/index.js'

// Elicitation is a client capability: the server cannot declare it (issue #68)
expectNotAssignable<MCPPluginOptions>({ capabilities: { elicitation: {} } })

expectAssignable<MCPPluginOptions>({
  onClientResponse: (response, context) => {
    expectType<JSONRPCResponse>(response)
    expectType<MCPClientResponseContext>(context)
    expectType<string | undefined>(context.sessionId)
  }
})
expectNotAssignable<MCPPluginOptions>({ onClientResponse: true })

// The "Basic Elicitation" README example, verbatim
async function readmeBasicElicitation () {
  const app = Fastify()

  // Register plugin with elicitation support
  await app.register(mcpPlugin, {
    enableSSE: true, // Required for elicitation
    // Receives the client's answer (an ElicitResult) to each elicitation request
    onClientResponse: async (response, { sessionId }) => {
      if ('result' in response) {
        app.log.info({ sessionId, id: response.id, result: response.result }, 'Elicitation answered')
      }
    }
  })

  // In your tool handler, request information from the client
  app.mcpAddTool({
    name: 'collect-user-info',
    description: 'Collect user information',
    inputSchema: Type.Object({})
  }, async (_params, { sessionId }) => {
    if (!sessionId) {
      return {
        content: [{ type: 'text', text: 'No session available' }],
        isError: true
      }
    }

    // Request user details with schema validation
    const success = await app.mcpElicit(sessionId, 'Please enter your details', {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Your full name',
          minLength: 1,
          maxLength: 100
        },
        email: {
          type: 'string',
          description: 'Your email address',
          format: 'email'
        },
        age: {
          type: 'integer',
          description: 'Your age',
          minimum: 0,
          maximum: 150
        },
        preferences: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['newsletter', 'updates', 'marketing']
          },
          description: 'Communication preferences'
        }
      },
      required: ['name', 'email']
    })

    if (success) {
      return {
        content: [{ type: 'text', text: 'Information request sent to client' }]
      }
    } else {
      return {
        content: [{ type: 'text', text: 'Failed to send elicitation request' }],
        isError: true
      }
    }
  })
}
expectType<() => Promise<void>>(readmeBasicElicitation)
