import fp from 'fastify-plugin'
import type { FastifyInstance } from 'fastify'
import {
  createMcpTestClient,
  type McpTestClient,
  type McpTestClientOptions
} from './client.ts'
import { assertMcpResult } from './assertions.ts'
import type { JSONRPCResultResponse } from '../schema.ts'

declare module 'fastify' {
  interface FastifyInstance {
    mcpTestClient (options?: McpTestClientOptions): McpTestClient
    assertMcpResult (body: unknown): asserts body is JSONRPCResultResponse
  }
}

const mcpTesting = fp(async function mcpTesting (app: FastifyInstance) {
  app.decorate('mcpTestClient', (options?: McpTestClientOptions) => {
    return createMcpTestClient(app, options)
  })
  app.decorate('assertMcpResult', assertMcpResult)
}, {
  name: 'mcp-testing'
})

export default mcpTesting
