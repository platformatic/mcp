import { test, describe } from 'node:test'
import type { TestContext } from 'node:test'
import Fastify from 'fastify'
import mcpPlugin from '../src/index.ts'
import { JSONRPC_VERSION, LATEST_PROTOCOL_VERSION } from '../src/schema.ts'

const initializeRequest = {
  jsonrpc: JSONRPC_VERSION,
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' }
  }
}

const whoamiCall = {
  jsonrpc: JSONRPC_VERSION,
  id: 2,
  method: 'tools/call',
  params: { name: 'whoami', arguments: {} }
}

async function buildApp (t: TestContext) {
  const app = Fastify({ logger: false })
  t.after(() => app.close())

  await app.register(mcpPlugin, {
    serverInfo: { name: 'test-server', version: '1.0.0' },
    enableSSE: false
  })

  app.mcpAddTool({
    name: 'whoami',
    description: 'Returns the session id the tool ran under'
  }, async (_params, { sessionId }) => {
    return { content: [{ type: 'text', text: sessionId ?? 'none' }] }
  })

  await app.ready()
  return app
}

describe('Streamable HTTP sessions without SSE', () => {
  test('initialize returns an Mcp-Session-Id', async (t: TestContext) => {
    const app = await buildApp(t)

    const response = await app.inject({ method: 'POST', url: '/mcp', payload: initializeRequest })

    t.assert.strictEqual(response.statusCode, 200)
    t.assert.ok(response.headers['mcp-session-id'])
  })

  test('follow-up requests run in the session returned by initialize', async (t: TestContext) => {
    const app = await buildApp(t)

    const initResponse = await app.inject({ method: 'POST', url: '/mcp', payload: initializeRequest })
    const sessionId = initResponse.headers['mcp-session-id'] as string
    t.assert.ok(sessionId)

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'mcp-session-id': sessionId,
        'mcp-protocol-version': LATEST_PROTOCOL_VERSION
      },
      payload: whoamiCall
    })

    t.assert.strictEqual(response.statusCode, 200)
    // The existing session is reused, so no new id is handed out
    t.assert.strictEqual(response.headers['mcp-session-id'], undefined)
    t.assert.strictEqual(response.json().result.content[0].text, sessionId)
  })

  test('the protocol version negotiated on the session is enforced', async (t: TestContext) => {
    const app = await buildApp(t)

    const initResponse = await app.inject({ method: 'POST', url: '/mcp', payload: initializeRequest })
    const sessionId = initResponse.headers['mcp-session-id'] as string

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'mcp-session-id': sessionId,
        'mcp-protocol-version': '2025-03-26'
      },
      payload: { jsonrpc: JSONRPC_VERSION, id: 2, method: 'ping' }
    })

    t.assert.strictEqual(response.statusCode, 400)
  })

  test('requests without a session id stay stateless', async (t: TestContext) => {
    const app = await buildApp(t)

    const response = await app.inject({ method: 'POST', url: '/mcp', payload: whoamiCall })

    t.assert.strictEqual(response.statusCode, 200)
    t.assert.strictEqual(response.headers['mcp-session-id'], undefined)
    t.assert.strictEqual(response.json().result.content[0].text, 'none')
  })

  test('DELETE terminates the session', async (t: TestContext) => {
    const app = await buildApp(t)

    const initResponse = await app.inject({ method: 'POST', url: '/mcp', payload: initializeRequest })
    const sessionId = initResponse.headers['mcp-session-id'] as string
    t.assert.ok(sessionId)

    const deleteResponse = await app.inject({
      method: 'DELETE',
      url: '/mcp',
      headers: { 'mcp-session-id': sessionId }
    })
    t.assert.strictEqual(deleteResponse.statusCode, 204)

    const secondDelete = await app.inject({
      method: 'DELETE',
      url: '/mcp',
      headers: { 'mcp-session-id': sessionId }
    })
    t.assert.strictEqual(secondDelete.statusCode, 404)
  })

  test('initialize on a terminated session id opens a new session', async (t: TestContext) => {
    const app = await buildApp(t)

    const initResponse = await app.inject({ method: 'POST', url: '/mcp', payload: initializeRequest })
    const sessionId = initResponse.headers['mcp-session-id'] as string

    await app.inject({
      method: 'DELETE',
      url: '/mcp',
      headers: { 'mcp-session-id': sessionId }
    })

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'mcp-session-id': sessionId },
      payload: initializeRequest
    })
    const newSessionId = response.headers['mcp-session-id']
    t.assert.ok(newSessionId)
    t.assert.notStrictEqual(newSessionId, sessionId)
  })

  test('GET answers 405 with an Allow header', async (t: TestContext) => {
    const app = await buildApp(t)

    const response = await app.inject({
      method: 'GET',
      url: '/mcp',
      headers: { accept: 'text/event-stream' }
    })

    t.assert.strictEqual(response.statusCode, 405)
    t.assert.strictEqual(response.headers.allow, 'POST, DELETE')
  })
})
