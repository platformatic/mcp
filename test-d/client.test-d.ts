import { expectType } from 'tsd'
import type { FastifyInstance } from 'fastify'
import mcpPlugin, {
  type JSONRPCResponse,
  type McpClientResponse
} from '../dist/index.js'

declare const app: FastifyInstance

app.register(mcpPlugin)
const client = app.mcpClient()

expectType<string | undefined>(client.sessionId)
expectType<Promise<McpClientResponse<JSONRPCResponse>>>(client.initialize())
expectType<Promise<McpClientResponse<JSONRPCResponse>>>(client.listTools())
expectType<Promise<McpClientResponse<JSONRPCResponse>>>(
  client.callTool('echo', { message: 'hello' })
)

// @ts-expect-error no assertion helper is exposed on the Fastify instance
app.assertMcpResult(client.sessionId)
