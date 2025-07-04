import { test } from 'node:test'
import Fastify from 'fastify'
import mcpPlugin from '../src/index.ts'

test('Last-Event-ID Support', async (t) => {
  const app = Fastify()
  t.after(() => app.close())

  await app.register(mcpPlugin, {
    serverInfo: { name: 'test', version: '1.0.0' },
    enableSSE: true
  })
  await app.ready()

  await t.test('should add message history to SSE sessions', async () => {
    // Create a session by sending a POST request with SSE
    const initResponse = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream'
      },
      payload: {
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' }
        },
        id: 1
      }
    })

    // Verify session was created with proper headers
    if (initResponse.statusCode !== 200) {
      throw new Error(`Expected 200, got ${initResponse.statusCode}`)
    }

    if (initResponse.headers['content-type'] !== 'text/event-stream') {
      throw new Error('Expected text/event-stream content type')
    }

    const sessionId = initResponse.headers['mcp-session-id'] as string
    if (!sessionId) {
      throw new Error('Expected session ID in response headers')
    }

    // Verify the session exists in the sessions map
    const session = app.mcpSessions.get(sessionId)
    if (!session) {
      throw new Error('Session should exist in sessions map')
    }

    // Verify session has messageHistory array
    if (!Array.isArray(session.messageHistory)) {
      throw new Error('Session should have messageHistory array')
    }
  })

  test.skip('should handle GET request with Last-Event-ID', async () => {
    // Skipped because GET SSE streams are long-lived and don't work well with inject()
    // The Last-Event-ID functionality is tested through unit tests of the replay function
  })
})
