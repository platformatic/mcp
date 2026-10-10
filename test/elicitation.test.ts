import { describe, test } from 'node:test'
import { strict as assert } from 'node:assert'
import Fastify from 'fastify'
import { Type } from '@sinclair/typebox'
import mcpPlugin from '../src/index.ts'
import type { JSONRPCResponse } from '../src/schema.ts'

async function initialize (app: any, capabilities: unknown, protocolVersion = '2025-11-25'): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/mcp',
    payload: {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion,
        capabilities,
        clientInfo: { name: 'test-client', version: '1.0.0' }
      }
    }
  })
  const sessionId = response.headers['mcp-session-id']
  assert.ok(sessionId, 'Session ID should be provided')
  return sessionId as string
}

describe('Elicitation Support', () => {
  test('should provide mcpElicit decorator when SSE is enabled', async (t) => {
    const app = Fastify({ logger: false })

    t.after(async () => {
      await app.close()
    })

    await app.register(mcpPlugin, {
      serverInfo: {
        name: 'test-server',
        version: '1.0.0'
      },
      enableSSE: true
    })

    // Verify the decorator exists
    assert.ok(typeof app.mcpElicit === 'function')
  })

  test('should warn and return false when SSE is disabled', async (t) => {
    const app = Fastify({ logger: false })

    t.after(async () => {
      await app.close()
    })

    await app.register(mcpPlugin, {
      serverInfo: {
        name: 'test-server',
        version: '1.0.0'
      },
      enableSSE: false
    })

    const result = await app.mcpElicit('test-session', 'Test message', {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'User name' }
      },
      required: ['name']
    })

    assert.strictEqual(result, false)
  })

  test('should send elicitation request to valid session', async (t) => {
    const app = Fastify({ logger: false })

    t.after(async () => {
      await app.close()
    })

    await app.register(mcpPlugin, {
      serverInfo: {
        name: 'test-server',
        version: '1.0.0'
      },
      enableSSE: true
    })

    await app.listen({ port: 0 })
    const address = app.server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const baseUrl = `http://localhost:${port}`

    // Create an SSE session first
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: { elicitation: {} },
          clientInfo: {
            name: 'test-client',
            version: '1.0.0'
          }
        }
      })
    })

    const sessionId = response.headers.get('mcp-session-id')
    assert.ok(sessionId, 'Session ID should be provided')

    // Now test elicitation
    const elicitResult = await app.mcpElicit(sessionId, 'Please enter your name', {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Your full name' },
        age: { type: 'number', description: 'Your age' }
      },
      required: ['name']
    })

    assert.strictEqual(elicitResult, true)

    // Clean up
    response.body?.cancel()
  })

  test('should return false for non-existent session', async (t) => {
    const app = Fastify({ logger: false })

    t.after(async () => {
      await app.close()
    })

    await app.register(mcpPlugin, {
      serverInfo: {
        name: 'test-server',
        version: '1.0.0'
      },
      enableSSE: true
    })

    const result = await app.mcpElicit('non-existent-session', 'Test message', {
      type: 'object',
      properties: {
        response: { type: 'string', description: 'User response' }
      }
    })

    assert.strictEqual(result, false)
  })

  test('should generate request ID when not provided', async (t) => {
    const app = Fastify({ logger: false })

    t.after(async () => {
      await app.close()
    })

    await app.register(mcpPlugin, {
      serverInfo: {
        name: 'test-server',
        version: '1.0.0'
      },
      enableSSE: true
    })

    await app.listen({ port: 0 })
    const address = app.server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const baseUrl = `http://localhost:${port}`

    // Create a session
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: { elicitation: {} },
          clientInfo: {
            name: 'test-client',
            version: '1.0.0'
          }
        }
      })
    })

    const sessionId = response.headers.get('mcp-session-id')
    assert.ok(sessionId)

    // Test without providing request ID
    const result1 = await app.mcpElicit(sessionId, 'Test 1', {
      type: 'object',
      properties: {
        answer: { type: 'string' }
      }
    })

    // Test with providing request ID
    const result2 = await app.mcpElicit(sessionId, 'Test 2', {
      type: 'object',
      properties: {
        answer: { type: 'string' }
      }
    }, 'custom-request-id')

    assert.strictEqual(result1, true)
    assert.strictEqual(result2, true)

    // Clean up
    response.body?.cancel()
  })

  test('should handle complex elicitation schemas', async (t) => {
    const app = Fastify({ logger: false })

    t.after(async () => {
      await app.close()
    })

    await app.register(mcpPlugin, {
      serverInfo: {
        name: 'test-server',
        version: '1.0.0'
      },
      enableSSE: true
    })

    await app.listen({ port: 0 })
    const address = app.server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const baseUrl = `http://localhost:${port}`

    // Create a session
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: { elicitation: {} },
          clientInfo: {
            name: 'test-client',
            version: '1.0.0'
          }
        }
      })
    })

    const sessionId = response.headers.get('mcp-session-id')
    assert.ok(sessionId)

    // Test complex schema
    const result = await app.mcpElicit(sessionId, 'Please fill out your profile', {
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
        active: {
          type: 'boolean',
          description: 'Are you currently active?',
          default: true
        },
        category: {
          type: 'string',
          description: 'Your category',
          enum: ['student', 'professional', 'retired']
        }
      },
      required: ['name', 'email']
    })

    assert.strictEqual(result, true)

    // Clean up
    response.body?.cancel()
  })

  test('README flow: server needs no elicitation capability, client response reaches onClientResponse', async (t) => {
    const app = Fastify({ logger: false })
    t.after(() => app.close())

    const received: Array<{ response: JSONRPCResponse, sessionId?: string }> = []

    // Exactly what the README registers: no server-side elicitation capability
    await app.register(mcpPlugin, {
      enableSSE: true,
      onClientResponse: (response, { sessionId }) => {
        received.push({ response, sessionId })
      }
    })

    app.mcpAddTool({
      name: 'collect-user-info',
      description: 'Collect user information',
      inputSchema: Type.Object({})
    }, async (_params, { sessionId }) => {
      const success = await app.mcpElicit(sessionId!, 'Please enter your details', {
        type: 'object',
        properties: { name: { type: 'string', description: 'Your full name' } },
        required: ['name']
      }, 'elicit-1')
      return { content: [{ type: 'text', text: success ? 'sent' : 'failed' }] }
    })

    await app.ready()

    // The client declares elicitation during initialize
    const sessionId = await initialize(app, { elicitation: {} })

    const sse = await app.inject({
      method: 'GET',
      url: '/mcp',
      payloadAsStream: true,
      headers: { accept: 'text/event-stream', 'mcp-session-id': sessionId }
    })
    t.after(() => sse.stream().destroy())
    assert.strictEqual(sse.statusCode, 200)

    const elicitation = new Promise<any>((resolve) => {
      let buffer = ''
      sse.stream().on('data', (chunk: Buffer) => {
        buffer += chunk.toString()
        for (const line of buffer.split('\n')) {
          if (!line.startsWith('data: ')) continue
          const message = JSON.parse(line.slice(6))
          if (message.method === 'elicitation/create') resolve(message)
        }
      })
    })

    const call = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'mcp-session-id': sessionId },
      payload: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'collect-user-info', arguments: {} } }
    })
    assert.strictEqual(call.json().result.content[0].text, 'sent')

    const request = await elicitation
    assert.strictEqual(request.id, 'elicit-1')
    assert.strictEqual(request.params.message, 'Please enter your details')

    // The client answers with a JSON-RPC response, which must be accepted
    const reply = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'mcp-session-id': sessionId },
      payload: { jsonrpc: '2.0', id: request.id, result: { action: 'accept', content: { name: 'Ada' } } }
    })
    assert.strictEqual(reply.statusCode, 202)
    assert.strictEqual(reply.body, '')

    assert.deepStrictEqual(received, [{
      response: { jsonrpc: '2.0', id: 'elicit-1', result: { action: 'accept', content: { name: 'Ada' } } },
      sessionId
    }])
  })

  test('client JSON-RPC responses are accepted without an onClientResponse hook', async (t) => {
    const app = Fastify({ logger: false })
    t.after(() => app.close())
    await app.register(mcpPlugin, { enableSSE: true })
    await app.ready()

    const sessionId = await initialize(app, { elicitation: {} })
    const reply = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'mcp-session-id': sessionId },
      payload: { jsonrpc: '2.0', id: 'elicit-1', error: { code: -32600, message: 'nope' } }
    })
    assert.strictEqual(reply.statusCode, 202)
  })

  test('does not send elicitation to a client that did not declare the capability', async (t) => {
    const app = Fastify({ logger: false })
    t.after(() => app.close())
    await app.register(mcpPlugin, { enableSSE: true })
    await app.ready()

    const sessionId = await initialize(app, {})
    const schema = { type: 'object' as const, properties: { name: { type: 'string' as const } } }

    assert.strictEqual(await app.mcpElicit(sessionId, 'Name?', schema), false)
    assert.strictEqual(await app.mcpElicitUrl(sessionId, 'Authorize', 'https://mcp.example.com/connect'), null)
  })

  test('only sends the elicitation modes the client declared', async (t) => {
    const app = Fastify({ logger: false })
    t.after(() => app.close())
    await app.register(mcpPlugin, { enableSSE: true })
    await app.ready()

    const schema = { type: 'object' as const, properties: { name: { type: 'string' as const } } }
    const url = 'https://mcp.example.com/connect'

    // An empty elicitation capability means form mode only
    const formOnly = await initialize(app, { elicitation: {} })
    assert.strictEqual(await app.mcpElicit(formOnly, 'Name?', schema), true)
    assert.strictEqual(await app.mcpElicitUrl(formOnly, 'Authorize', url), null)

    const urlOnly = await initialize(app, { elicitation: { url: {} } })
    assert.strictEqual(await app.mcpElicit(urlOnly, 'Name?', schema), false)
    assert.ok(await app.mcpElicitUrl(urlOnly, 'Authorize', url))

    const both = await initialize(app, { elicitation: { form: {}, url: {} } })
    assert.strictEqual(await app.mcpElicit(both, 'Name?', schema), true)
    assert.ok(await app.mcpElicitUrl(both, 'Authorize', url))
  })
})
