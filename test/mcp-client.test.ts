import { describe, test } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'
import { Type } from '@sinclair/typebox'
import mcpPlugin, { createMcpClient } from '../src/index.ts'
import {
  JSONRPC_VERSION,
  LATEST_PROTOCOL_VERSION,
  METHOD_NOT_FOUND
} from '../src/schema.ts'

interface CapturedRequest {
  headers: Record<string, string | string[] | undefined>
  payload: unknown
}

interface TestApp {
  app: FastifyInstance
  capturedRequests: CapturedRequest[]
  getObservedEchoArgs: () => unknown
}

function normalizeHeaders (
  headers: Record<string, unknown>
): Record<string, string | string[] | undefined> {
  const normalized: Record<string, string | string[] | undefined> = {}

  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      normalized[key] = undefined
      continue
    }
    if (typeof value === 'string') {
      normalized[key] = value
      continue
    }
    if (Array.isArray(value)) {
      normalized[key] = value.map(entry => String(entry))
      continue
    }
    normalized[key] = String(value)
  }

  return normalized
}

async function createTestApp (t: TestContext): Promise<TestApp> {
  const app = Fastify()
  t.after(() => app.close())

  const capturedRequests: CapturedRequest[] = []
  let observedEchoArgs: unknown

  app.addHook('preHandler', async (request) => {
    if (request.method === 'POST' && request.url.startsWith('/mcp')) {
      capturedRequests.push({
        headers: normalizeHeaders(request.headers as Record<string, unknown>),
        payload: request.body
      })
    }
  })

  await app.register(mcpPlugin, {
    enableSSE: true
  })

  app.mcpAddTool({
    name: 'echo',
    description: 'Echo a message',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string' }
      },
      required: ['message'],
      additionalProperties: false
    }
  }, async (params) => {
    observedEchoArgs = params
    const message = String((params as { message: string }).message)
    return {
      content: [{ type: 'text', text: message }]
    }
  })

  app.mcpAddTool({
    name: 'validated',
    description: 'Validate count',
    inputSchema: Type.Object({
      count: Type.Number()
    })
  }, async ({ count }) => {
    return {
      content: [{ type: 'text', text: String(count) }]
    }
  })

  await app.ready()

  return {
    app,
    capturedRequests,
    getObservedEchoArgs: () => observedEchoArgs
  }
}

async function createInitializeErrorApp (t: TestContext): Promise<TestApp> {
  const app = Fastify()
  t.after(() => app.close())

  const capturedRequests: CapturedRequest[] = []
  let observedEchoArgs: unknown

  app.addHook('preHandler', async (request) => {
    if (request.method === 'POST' && request.url.startsWith('/mcp')) {
      capturedRequests.push({
        headers: normalizeHeaders(request.headers as Record<string, unknown>),
        payload: request.body
      })
    }
  })

  app.post('/mcp', async (request, reply) => {
    const message = request.body as Record<string, unknown>
    const method = message.method

    if (method === 'initialize') {
      reply
        .code(200)
        .header('mcp-session-id', 'failed-init-session')
        .send({
          jsonrpc: JSONRPC_VERSION,
          id: message.id,
          error: {
            code: -32000,
            message: 'initialize failed'
          }
        })
      return
    }

    if (method === 'tools/call') {
      const params = (message.params ?? {}) as Record<string, unknown>
      observedEchoArgs = params.arguments
      reply.code(200).send({
        jsonrpc: JSONRPC_VERSION,
        id: message.id,
        result: {
          content: [{ type: 'text', text: String((params.arguments as Record<string, unknown>)?.message ?? '') }]
        }
      })
      return
    }

    if (method === 'tools/list') {
      reply.code(200).send({
        jsonrpc: JSONRPC_VERSION,
        id: message.id,
        result: { tools: [] }
      })
      return
    }

    reply.code(200).send({
      jsonrpc: JSONRPC_VERSION,
      id: message.id,
      error: {
        code: METHOD_NOT_FOUND,
        message: 'Method not found'
      }
    })
  })

  await app.ready()

  return {
    app,
    capturedRequests,
    getObservedEchoArgs: () => observedEchoArgs
  }
}

async function createInitializedRejectingApp (
  t: TestContext,
  mode: 'status-401-json' | 'status-500-text' | 'status-202-non-empty'
): Promise<TestApp> {
  const app = Fastify()
  t.after(() => app.close())

  const capturedRequests: CapturedRequest[] = []
  let observedEchoArgs: unknown

  app.addHook('preHandler', async (request) => {
    if (request.method === 'POST' && request.url.startsWith('/mcp')) {
      capturedRequests.push({
        headers: normalizeHeaders(request.headers as Record<string, unknown>),
        payload: request.body
      })
    }
  })

  app.post('/mcp', async (request, reply) => {
    const message = request.body as Record<string, unknown>
    const method = message.method

    if (method === 'initialize') {
      reply
        .code(200)
        .header('mcp-session-id', 'candidate-session')
        .header('mcp-protocol-version', '2025-11-25')
        .send({
          jsonrpc: JSONRPC_VERSION,
          id: message.id,
          result: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            serverInfo: {
              name: 'test-server',
              version: '1.0.0'
            }
          }
        })
      return
    }

    if (method === 'notifications/initialized') {
      if (mode === 'status-401-json') {
        reply.code(401).type('application/json').send({ error: 'unauthorized' })
        return
      }
      if (mode === 'status-500-text') {
        reply.code(500).type('text/plain').send('x'.repeat(10_000))
        return
      }
      reply.code(202).type('text/plain').send('not-empty')
      return
    }

    if (method === 'tools/call') {
      const params = (message.params ?? {}) as Record<string, unknown>
      observedEchoArgs = params.arguments
      reply.code(200).send({
        jsonrpc: JSONRPC_VERSION,
        id: message.id,
        result: {
          content: [{ type: 'text', text: String((params.arguments as Record<string, unknown>)?.message ?? '') }]
        }
      })
      return
    }

    if (method === 'tools/list') {
      reply.code(200).send({
        jsonrpc: JSONRPC_VERSION,
        id: message.id,
        result: { tools: [] }
      })
      return
    }

    reply.code(200).send({
      jsonrpc: JSONRPC_VERSION,
      id: message.id,
      error: {
        code: METHOD_NOT_FOUND,
        message: 'Method not found'
      }
    })
  })

  await app.ready()

  return {
    app,
    capturedRequests,
    getObservedEchoArgs: () => observedEchoArgs
  }
}

async function createInitializedAcceptedApp (
  t: TestContext,
  statusCode: 202 | 204
): Promise<TestApp> {
  const app = Fastify()
  t.after(() => app.close())

  const capturedRequests: CapturedRequest[] = []
  let observedEchoArgs: unknown

  app.addHook('preHandler', async (request) => {
    if (request.method === 'POST' && request.url.startsWith('/mcp')) {
      capturedRequests.push({
        headers: normalizeHeaders(request.headers as Record<string, unknown>),
        payload: request.body
      })
    }
  })

  app.post('/mcp', async (request, reply) => {
    const message = request.body as Record<string, unknown>
    const method = message.method

    if (method === 'initialize') {
      reply
        .code(200)
        .header('mcp-session-id', 'accepted-session')
        .header('mcp-protocol-version', '2025-11-25')
        .send({
          jsonrpc: JSONRPC_VERSION,
          id: message.id,
          result: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            serverInfo: {
              name: 'test-server',
              version: '1.0.0'
            }
          }
        })
      return
    }

    if (method === 'notifications/initialized') {
      reply.code(statusCode).type('text/plain').send('')
      return
    }

    if (method === 'tools/call') {
      const params = (message.params ?? {}) as Record<string, unknown>
      observedEchoArgs = params.arguments
      reply.code(200).send({
        jsonrpc: JSONRPC_VERSION,
        id: message.id,
        result: {
          content: [{ type: 'text', text: String((params.arguments as Record<string, unknown>)?.message ?? '') }]
        }
      })
      return
    }

    if (method === 'tools/list') {
      reply.code(200).send({
        jsonrpc: JSONRPC_VERSION,
        id: message.id,
        result: { tools: [] }
      })
      return
    }

    reply.code(200).send({
      jsonrpc: JSONRPC_VERSION,
      id: message.id,
      error: {
        code: METHOD_NOT_FOUND,
        message: 'Method not found'
      }
    })
  })

  await app.ready()

  return {
    app,
    capturedRequests,
    getObservedEchoArgs: () => observedEchoArgs
  }
}

function getPayload (capturedRequest: CapturedRequest): Record<string, unknown> {
  assert.ok(capturedRequest.payload && typeof capturedRequest.payload === 'object' && !Array.isArray(capturedRequest.payload))
  return capturedRequest.payload as Record<string, unknown>
}

describe('MCP client', () => {
  test('registering the main plugin decorates the Fastify instance with mcpClient', async (t) => {
    const app: FastifyInstance = Fastify()
    t.after(() => app.close())

    await app.register(mcpPlugin)
    await app.ready()

    const client = app.mcpClient({ startingRequestId: 42 })
    const response = await client.initialize()
    assert.equal(response.statusCode, 200)
    assert.ok('result' in response.body)
  })

  test('initialize builds a valid MCP initialize request', async (t) => {
    const { app, capturedRequests } = await createTestApp(t)
    const client = createMcpClient(app)

    await client.initialize()

    assert.equal(capturedRequests.length, 2)
    const request = getPayload(capturedRequests[0])
    assert.equal(request.jsonrpc, JSONRPC_VERSION)
    assert.equal(request.method, 'initialize')
    assert.equal(request.id, 1)
    assert.deepEqual(request.params, {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: '@platformatic/mcp-client',
        version: '1.0.0'
      }
    })

    assert.equal(capturedRequests[0].headers['content-type'], 'application/json')
    assert.equal(capturedRequests[0].headers.accept, 'application/json, text/event-stream')
    assert.equal(capturedRequests[0].headers['mcp-protocol-version'], LATEST_PROTOCOL_VERSION)

    const initializedNotification = getPayload(capturedRequests[1])
    assert.equal(initializedNotification.jsonrpc, JSONRPC_VERSION)
    assert.equal(initializedNotification.method, 'notifications/initialized')
    assert.equal(initializedNotification.id, undefined)
    assert.equal(capturedRequests[1].headers.accept, 'application/json, text/event-stream')
  })

  test('initialize captures returned session id', async (t) => {
    const { app } = await createTestApp(t)
    const client = createMcpClient(app)

    const response = await client.initialize()
    assert.equal(response.statusCode, 200)
    assert.equal(typeof client.sessionId, 'string')
    assert.equal(client.sessionId, response.headers['mcp-session-id'])
  })

  test('failed initialize response does not store session id or reuse it later', async (t) => {
    const { app, capturedRequests } = await createInitializeErrorApp(t)
    const client = createMcpClient(app)

    const response = await client.initialize()
    assert.ok('error' in response.body)
    assert.equal(client.sessionId, undefined)

    await client.callTool('echo', { message: 'hello' })

    assert.equal(capturedRequests.length, 2)
    assert.equal(capturedRequests[0].headers['mcp-session-id'], undefined)
    assert.equal(capturedRequests[1].headers['mcp-session-id'], undefined)
  })

  test('subsequent requests send captured session id automatically', async (t) => {
    const { app, capturedRequests } = await createTestApp(t)
    const client = createMcpClient(app)

    await client.initialize()
    const expectedSessionId = client.sessionId
    await client.listTools()

    assert.equal(capturedRequests.length, 3)
    assert.equal(capturedRequests[2].headers['mcp-session-id'], expectedSessionId)
  })

  test('sends notifications/initialized before first tool request', async (t) => {
    const { app, capturedRequests } = await createTestApp(t)
    const client = createMcpClient(app)

    await client.initialize()
    await client.listTools()

    assert.equal(capturedRequests.length, 3)
    assert.equal(getPayload(capturedRequests[0]).method, 'initialize')
    assert.equal(getPayload(capturedRequests[1]).method, 'notifications/initialized')
    assert.equal(getPayload(capturedRequests[2]).method, 'tools/list')
  })

  test('initialize forwards application headers to both lifecycle requests', async (t) => {
    const { app, capturedRequests } = await createTestApp(t)
    const client = createMcpClient(app)

    await client.initialize({
      headers: {
        authorization: 'Bearer test-token',
        'x-company-id': 'company-1'
      }
    })

    assert.equal(capturedRequests.length, 2)
    assert.equal(capturedRequests[0].headers.authorization, 'Bearer test-token')
    assert.equal(capturedRequests[0].headers['x-company-id'], 'company-1')
    assert.equal(capturedRequests[1].headers.authorization, 'Bearer test-token')
    assert.equal(capturedRequests[1].headers['x-company-id'], 'company-1')
  })

  test('initialize ignores stale managed MCP headers and uses negotiated values', async (t) => {
    const { app, capturedRequests } = await createTestApp(t)
    const client = createMcpClient(app)

    const initResponse = await client.initialize({
      headers: {
        authorization: 'Bearer test-token',
        'mcp-session-id': 'stale-session',
        'mcp-protocol-version': '2025-03-26'
      }
    })

    assert.ok('result' in initResponse.body)
    const negotiatedProtocolVersion = initResponse.body.result.protocolVersion
    assert.equal(typeof negotiatedProtocolVersion, 'string')

    assert.equal(capturedRequests.length, 2)
    assert.equal(capturedRequests[0].headers.authorization, 'Bearer test-token')
    assert.equal(capturedRequests[0].headers['mcp-session-id'], 'stale-session')
    assert.equal(capturedRequests[0].headers['mcp-protocol-version'], '2025-03-26')
    assert.equal(capturedRequests[1].headers.authorization, 'Bearer test-token')
    assert.equal(capturedRequests[1].headers['mcp-session-id'], initResponse.headers['mcp-session-id'])
    assert.equal(capturedRequests[1].headers['mcp-protocol-version'], negotiatedProtocolVersion)
  })

  test('initialize rejects when notifications/initialized is rejected and does not commit state', async (t) => {
    const { app } = await createInitializedRejectingApp(t, 'status-401-json')
    const client = createMcpClient(app)

    await assert.rejects(
      () => client.initialize(),
      /notifications\/initialized notification failed/
    )

    assert.equal(client.sessionId, undefined)
  })

  test('initialize keeps state unset when notifications/initialized returns plain-text server error', async (t) => {
    const { app } = await createInitializedRejectingApp(t, 'status-500-text')
    const client = createMcpClient(app)

    await assert.rejects(
      () => client.initialize(),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /notifications\/initialized notification failed/)
        assert.match(error.message, /status 500/)
        assert.match(error.message, /truncated/)
        return true
      }
    )

    assert.equal(client.sessionId, undefined)
  })

  test('initialize rejects non-empty 202 response for notifications/initialized', async (t) => {
    const { app } = await createInitializedRejectingApp(t, 'status-202-non-empty')
    const client = createMcpClient(app)

    await assert.rejects(
      () => client.initialize(),
      /notifications\/initialized notification failed/
    )

    assert.equal(client.sessionId, undefined)
  })

  test('initialize accepts empty 202 response for notifications/initialized', async (t) => {
    const { app } = await createInitializedAcceptedApp(t, 202)
    const client = createMcpClient(app)

    await client.initialize()

    assert.equal(client.sessionId, 'accepted-session')
  })

  test('initialize accepts empty 204 response for notifications/initialized', async (t) => {
    const { app } = await createInitializedAcceptedApp(t, 204)
    const client = createMcpClient(app)

    await client.initialize()

    assert.equal(client.sessionId, 'accepted-session')
  })

  test('listTools returns registered tools', async (t) => {
    const { app } = await createTestApp(t)
    const client = createMcpClient(app)

    await client.initialize()
    const response = await client.listTools()

    assert.equal(response.statusCode, 200)
    assert.ok('result' in response.body)
    const toolsResult = response.body.result as { tools: Array<{ name: string }> }
    const names = toolsResult.tools.map(tool => tool.name).sort()
    assert.deepEqual(names, ['echo', 'validated'])
  })

  test('listTools supports cursor parameter', async (t) => {
    const { app, capturedRequests } = await createTestApp(t)
    const client = createMcpClient(app)

    await client.initialize()
    await client.listTools({ cursor: 'cursor-1' })

    const listRequest = getPayload(capturedRequests[2])
    assert.deepEqual(listRequest.params, { cursor: 'cursor-1' })
  })

  test('callTool invokes a registered tool', async (t) => {
    const { app } = await createTestApp(t)
    const client = createMcpClient(app)

    await client.initialize()
    const response = await client.callTool('echo', { message: 'hello' })

    assert.equal(response.statusCode, 200)
    assert.ok('result' in response.body)
    assert.deepEqual(response.body.result, {
      content: [{ type: 'text', text: 'hello' }]
    })
  })

  test('callTool passes arguments unchanged to the server', async (t) => {
    const { app, getObservedEchoArgs } = await createTestApp(t)
    const client = createMcpClient(app)

    await client.initialize()
    await client.callTool('echo', { message: 'hello' })

    assert.deepEqual(getObservedEchoArgs(), { message: 'hello' })
  })

  test('invalid arguments exercise server validation path', async (t) => {
    const { app } = await createTestApp(t)
    const client = createMcpClient(app)

    await client.initialize()
    const response = await client.callTool('validated', { count: 'nope' as unknown as number })

    assert.equal(response.statusCode, 200)
    assert.ok('result' in response.body)
    const result = response.body.result as { isError?: boolean }
    assert.equal(result.isError, true)
  })

  test('unknown tools return MCP JSON-RPC error', async (t) => {
    const { app } = await createTestApp(t)
    const client = createMcpClient(app)

    await client.initialize()
    const response = await client.callTool('does-not-exist', {})

    assert.ok('error' in response.body)
    assert.equal(response.body.error.code, METHOD_NOT_FOUND)
  })

  test('request ids increment sequentially when not explicitly set', async (t) => {
    const { app } = await createTestApp(t)
    const client = createMcpClient(app)

    const initResponse = await client.initialize()
    const listResponse = await client.listTools()
    const callResponse = await client.callTool('echo', { message: 'hello' })

    assert.ok('result' in initResponse.body)
    assert.ok('result' in listResponse.body)
    assert.ok('result' in callResponse.body)
    assert.equal(initResponse.body.id, 1)
    assert.equal(listResponse.body.id, 2)
    assert.equal(callResponse.body.id, 3)
  })

  test('explicit request ids are preserved and do not consume generated ids', async (t) => {
    const { app } = await createTestApp(t)
    const client = createMcpClient(app)

    const initResponse = await client.initialize({ id: 'init-id' })
    const listResponse = await client.listTools()

    assert.ok('result' in initResponse.body)
    assert.ok('result' in listResponse.body)
    assert.equal(initResponse.body.id, 'init-id')
    assert.equal(listResponse.body.id, 1)
  })

  test('two clients keep independent request ids and sessions', async (t) => {
    const { app } = await createTestApp(t)
    const a = createMcpClient(app)
    const b = createMcpClient(app)

    const initA = await a.initialize()
    const initB = await b.initialize()
    const listA = await a.listTools()
    const listB = await b.listTools()

    assert.ok('result' in initA.body)
    assert.ok('result' in initB.body)
    assert.ok('result' in listA.body)
    assert.ok('result' in listB.body)

    assert.equal(initA.body.id, 1)
    assert.equal(initB.body.id, 1)
    assert.equal(listA.body.id, 2)
    assert.equal(listB.body.id, 2)

    assert.equal(typeof a.sessionId, 'string')
    assert.equal(typeof b.sessionId, 'string')
    assert.notEqual(a.sessionId, b.sessionId)
  })

  test('client-level headers are sent', async (t) => {
    const { app, capturedRequests } = await createTestApp(t)
    const client = createMcpClient(app, {
      headers: {
        'x-test-client': 'from-client'
      }
    })

    await client.initialize()

    assert.equal(capturedRequests[0].headers['x-test-client'], 'from-client')
  })

  test('per-request headers override client and generated headers', async (t) => {
    const { app, capturedRequests } = await createTestApp(t)
    const client = createMcpClient(app, {
      headers: {
        'x-test-header': 'client-value',
        'mcp-protocol-version': LATEST_PROTOCOL_VERSION
      }
    })

    await client.initialize()
    await client.listTools({
      headers: {
        'x-test-header': 'request-value',
        'mcp-session-id': 'override-session',
        'mcp-protocol-version': '2025-03-26'
      }
    })

    const requestHeaders = capturedRequests[2].headers
    assert.equal(requestHeaders['x-test-header'], 'request-value')
    assert.equal(requestHeaders['mcp-session-id'], 'override-session')
    assert.equal(requestHeaders['mcp-protocol-version'], '2025-03-26')
  })

  test('protocolVersion null omits protocol version header', async (t) => {
    const { app, capturedRequests } = await createTestApp(t)
    const client = createMcpClient(app, {
      protocolVersion: null
    })

    await client.initialize()

    assert.equal(capturedRequests[0].headers['mcp-protocol-version'], undefined)
    const initRequest = getPayload(capturedRequests[0])
    assert.deepEqual(initRequest.params, {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: '@platformatic/mcp-client',
        version: '1.0.0'
      }
    })
  })

  test('per-request protocol version overrides client default', async (t) => {
    const { app, capturedRequests } = await createTestApp(t)
    const client = createMcpClient(app, {
      protocolVersion: LATEST_PROTOCOL_VERSION
    })

    await client.initialize()
    await assert.rejects(
      () => client.listTools({ protocolVersion: '2025-03-26' }),
      /jsonrpc/
    )

    assert.equal(capturedRequests[2].headers['mcp-protocol-version'], '2025-03-26')
  })

  test('result/error narrowing works using the response union', async (t) => {
    const { app } = await createTestApp(t)
    const client = createMcpClient(app)

    await client.initialize()

    const resultResponse = await client.callTool('echo', { message: 'hello' })
    assert.ok('result' in resultResponse.body)
    assert.deepEqual(resultResponse.body.result, {
      content: [{ type: 'text', text: 'hello' }]
    })

    const errorResponse = await client.callTool('missing', {})
    assert.ok('error' in errorResponse.body)
    assert.equal(typeof errorResponse.body.error.code, 'number')
  })

  test('client returns validated error responses', async (t) => {
    const { app } = await createTestApp(t)
    const client = createMcpClient(app)

    await client.initialize()
    const response = await client.callTool('missing', {})

    assert.ok('error' in response.body)
    assert.equal(typeof response.body.error.code, 'number')
    assert.equal(typeof response.body.error.message, 'string')
  })

  test('invalid JSON responses throw descriptive bounded errors', async (t) => {
    const app = Fastify()
    t.after(() => app.close())

    app.post('/invalid-json', async (_request, reply) => {
      reply.code(502).type('text/plain').send('x'.repeat(10_000))
    })

    await app.ready()

    const client = createMcpClient(app, {
      endpoint: '/invalid-json'
    })

    await assert.rejects(
      () => client.listTools(),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /status 502/)
        assert.match(error.message, /truncated/)
        assert.ok(error.message.length < 1_800)
        return true
      }
    )
  })

  test('malformed JSON-RPC responses are rejected', async (t) => {
    const app = Fastify()
    t.after(() => app.close())

    app.post('/malformed-json-rpc', async () => {
      return {
        jsonrpc: JSONRPC_VERSION,
        error: { code: 'oops', message: 1 }
      }
    })

    await app.ready()

    const client = createMcpClient(app, {
      endpoint: '/malformed-json-rpc'
    })

    await assert.rejects(
      () => client.listTools(),
      /error\.code/
    )
  })
})
