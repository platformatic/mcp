import { expectType } from 'tsd'
import type { FastifyInstance } from 'fastify'
import type {
  JSONRPCErrorResponse,
  JSONRPCResultResponse
} from '@platformatic/mcp'
import {
  assertMcpError,
  type McpTestResponse
} from '@platformatic/mcp/testing'
import mcpTesting from '@platformatic/mcp/testing'

declare const app: FastifyInstance

app.register(mcpTesting)
const client = app.mcpTestClient()

expectType<string | undefined>(client.sessionId)
expectType<Promise<McpTestResponse>>(client.initialize())
expectType<Promise<McpTestResponse>>(client.listTools())
expectType<Promise<McpTestResponse>>(
  client.callTool('echo', { message: 'hello' })
)

let maybeResult: unknown
app.assertMcpResult(maybeResult)
expectType<JSONRPCResultResponse>(maybeResult)

let maybeError: unknown
assertMcpError(maybeError)
expectType<JSONRPCErrorResponse>(maybeError)
