import { expectType } from 'tsd'
import type { FastifyInstance } from 'fastify'
import mcpPlugin, {
  type JSONRPCResponse,
  type McpClientResponse
} from '../dist/index.js'

declare const app: FastifyInstance

app.register(mcpPlugin)
const client = app.mcpClient()
app.mcpClient({
  protocolVersion: '2026-07-28',
  clientInfo: { name: 'test-client', version: '1.0.0' },
  clientCapabilities: { sampling: {} }
})

expectType<string | undefined>(client.sessionId)
expectType<Promise<McpClientResponse<JSONRPCResponse>>>(client.initialize())
expectType<Promise<McpClientResponse<JSONRPCResponse>>>(client.discover())
expectType<Promise<McpClientResponse<JSONRPCResponse>>>(client.listTools())
expectType<Promise<McpClientResponse<JSONRPCResponse>>>(
  client.callTool('echo', { message: 'hello' })
)
expectType<Promise<McpClientResponse<JSONRPCResponse>>>(
  client.callTool('echo', { message: 'hello' }, {
    requestState: 'opaque-state',
    inputResponses: {
      confirmation: { action: 'accept', content: { confirmed: true } }
    }
  })
)

// @ts-expect-error no assertion helper is exposed on the Fastify instance
app.assertMcpResult(client.sessionId)
