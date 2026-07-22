import { test, describe } from 'node:test'
import type { TestContext } from 'node:test'
import Fastify from 'fastify'
import { request, Agent, setGlobalDispatcher } from 'undici'
import mcpPlugin from '../src/index.ts'
import { JSONRPC_VERSION, LATEST_PROTOCOL_VERSION } from '../src/schema.ts'

setGlobalDispatcher(new Agent({
  keepAliveTimeout: 10,
  keepAliveMaxTimeout: 10
}))

describe('Session DELETE', () => {
  test('returns 204 on successful session deletion', async (t: TestContext) => {
    const app = Fastify({ logger: false })
    t.after(() => app.close())

    await app.register(mcpPlugin, {
      serverInfo: { name: 'test-server', version: '1.0.0' },
      enableSSE: true
    })

    await app.listen({ port: 0 })
    const address = app.server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const baseUrl = `http://localhost:${port}`

    // Create a session via POST initialize
    const initResponse = await request(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' }
        }
      })
    })

    const sessionId = initResponse.headers['mcp-session-id'] as string
    t.assert.ok(sessionId)

    // DELETE the session
    const deleteResponse = await request(`${baseUrl}/mcp`, {
      method: 'DELETE',
      headers: { 'mcp-session-id': sessionId }
    })

    t.assert.strictEqual(deleteResponse.statusCode, 204)
  })

  test('returns 400 when mcp-session-id header is missing', async (t: TestContext) => {
    const app = Fastify({ logger: false })
    t.after(() => app.close())

    await app.register(mcpPlugin, {
      serverInfo: { name: 'test-server', version: '1.0.0' },
      enableSSE: true
    })

    await app.listen({ port: 0 })
    const address = app.server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const baseUrl = `http://localhost:${port}`

    const deleteResponse = await request(`${baseUrl}/mcp`, {
      method: 'DELETE'
    })

    t.assert.strictEqual(deleteResponse.statusCode, 400)
    const body = await deleteResponse.body.json() as { error: string }
    t.assert.ok(body.error.includes('Mcp-Session-Id'))
  })

  test('returns 404 when session does not exist', async (t: TestContext) => {
    const app = Fastify({ logger: false })
    t.after(() => app.close())

    await app.register(mcpPlugin, {
      serverInfo: { name: 'test-server', version: '1.0.0' },
      enableSSE: true
    })

    await app.listen({ port: 0 })
    const address = app.server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const baseUrl = `http://localhost:${port}`

    const deleteResponse = await request(`${baseUrl}/mcp`, {
      method: 'DELETE',
      headers: { 'mcp-session-id': 'nonexistent-session-id' }
    })

    t.assert.strictEqual(deleteResponse.statusCode, 404)
  })

  test('SSE stream is closed after DELETE', async (t: TestContext) => {
    const app = Fastify({ logger: false })
    t.after(() => app.close())

    await app.register(mcpPlugin, {
      serverInfo: { name: 'test-server', version: '1.0.0' },
      enableSSE: true
    })

    await app.listen({ port: 0 })
    const address = app.server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const baseUrl = `http://localhost:${port}`

    // Create a session via POST initialize
    const initResponse = await request(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' }
        }
      })
    })

    const sessionId = initResponse.headers['mcp-session-id'] as string
    t.assert.ok(sessionId)

    // Open SSE stream
    const sseResponse = await request(`${baseUrl}/mcp`, {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        'mcp-session-id': sessionId
      }
    })

    t.assert.strictEqual(sseResponse.statusCode, 200)

    // Consume the stream — it will resolve when the server closes it
    const streamConsumed = (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of sseResponse.body) {
        chunks.push(chunk as Buffer)
      }
      return Buffer.concat(chunks).toString()
    })()

    // DELETE the session
    const deleteResponse = await request(`${baseUrl}/mcp`, {
      method: 'DELETE',
      headers: { 'mcp-session-id': sessionId }
    })

    t.assert.strictEqual(deleteResponse.statusCode, 204)

    // Stream should complete (server closed it) within a reasonable time
    const result = await Promise.race([
      streamConsumed.then(() => 'closed'),
      new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 5000))
    ])

    t.assert.strictEqual(result, 'closed')
  })

  test('session is removed from store after DELETE', async (t: TestContext) => {
    const app = Fastify({ logger: false })
    t.after(() => app.close())

    await app.register(mcpPlugin, {
      serverInfo: { name: 'test-server', version: '1.0.0' },
      enableSSE: true
    })

    await app.listen({ port: 0 })
    const address = app.server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const baseUrl = `http://localhost:${port}`

    // Create a session via POST initialize
    const initResponse = await request(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' }
        }
      })
    })

    const sessionId = initResponse.headers['mcp-session-id'] as string
    t.assert.ok(sessionId)

    // DELETE the session
    await request(`${baseUrl}/mcp`, {
      method: 'DELETE',
      headers: { 'mcp-session-id': sessionId }
    })

    // Try to DELETE again — should be 404
    const secondDelete = await request(`${baseUrl}/mcp`, {
      method: 'DELETE',
      headers: { 'mcp-session-id': sessionId }
    })

    t.assert.strictEqual(secondDelete.statusCode, 404)
  })

  test('DELETE route is not registered when SSE is disabled', async (t: TestContext) => {
    const app = Fastify({ logger: false })
    t.after(() => app.close())

    await app.register(mcpPlugin, {
      serverInfo: { name: 'test-server', version: '1.0.0' },
      enableSSE: false
    })
    await app.ready()

    const response = await app.inject({
      method: 'DELETE',
      url: '/mcp',
      headers: { 'mcp-session-id': 'some-session' }
    })

    // Fastify returns 404 for unregistered routes
    t.assert.strictEqual(response.statusCode, 404)
  })
})
