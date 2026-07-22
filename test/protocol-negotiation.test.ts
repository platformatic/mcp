import { test, describe } from 'node:test'
import type { TestContext } from 'node:test'
import Fastify from 'fastify'
import mcpPlugin from '../src/index.ts'
import type { JSONRPCRequest, InitializeResult } from '../src/schema.ts'
import {
  JSONRPC_VERSION,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  DEFAULT_NEGOTIATED_PROTOCOL_VERSION
} from '../src/schema.ts'
import { negotiateProtocolVersion } from '../src/handlers.ts'
import { isOriginAllowed } from '../src/security.ts'
import { createTestAuthConfig } from './auth-test-utils.ts'

function initializeRequest (protocolVersion?: string): JSONRPCRequest {
  const params: Record<string, unknown> = {
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' }
  }
  if (protocolVersion !== undefined) {
    params.protocolVersion = protocolVersion
  }
  return { jsonrpc: JSONRPC_VERSION, id: 1, method: 'initialize', params }
}

describe('protocol version negotiation', () => {
  test('negotiateProtocolVersion echoes any supported version', (t: TestContext) => {
    for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
      t.assert.strictEqual(negotiateProtocolVersion(version), version)
    }
  })

  test('negotiateProtocolVersion falls back to latest for unknown input', (t: TestContext) => {
    t.assert.strictEqual(negotiateProtocolVersion('1999-01-01'), LATEST_PROTOCOL_VERSION)
    t.assert.strictEqual(negotiateProtocolVersion(undefined), LATEST_PROTOCOL_VERSION)
    t.assert.strictEqual(negotiateProtocolVersion(42), LATEST_PROTOCOL_VERSION)
    t.assert.strictEqual(negotiateProtocolVersion(null), LATEST_PROTOCOL_VERSION)
  })

  test('initialize echoes a supported version requested by the client', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())
    await app.register(mcpPlugin)
    await app.ready()

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: initializeRequest('2025-03-26')
    })

    t.assert.strictEqual(response.statusCode, 200)
    const result = response.json().result as InitializeResult
    t.assert.strictEqual(result.protocolVersion, '2025-03-26')
  })

  test('initialize offers the latest version when the client asks for an unsupported one', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())
    await app.register(mcpPlugin)
    await app.ready()

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: initializeRequest('2099-12-31')
    })

    t.assert.strictEqual(response.statusCode, 200)
    const result = response.json().result as InitializeResult
    t.assert.strictEqual(result.protocolVersion, LATEST_PROTOCOL_VERSION)
  })

  test('initialize offers the latest version when the client sends none', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())
    await app.register(mcpPlugin)
    await app.ready()

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: initializeRequest()
    })

    t.assert.strictEqual(response.statusCode, 200)
    const result = response.json().result as InitializeResult
    t.assert.strictEqual(result.protocolVersion, LATEST_PROTOCOL_VERSION)
  })

  test('the negotiated version is persisted on the session', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())
    await app.register(mcpPlugin, { enableSSE: true })
    await app.ready()

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: initializeRequest('2025-03-26')
    })

    const sessionId = response.headers['mcp-session-id'] as string
    t.assert.ok(sessionId, 'expected a session to be created')

    // A follow-up request on the same session must still see the agreed version
    const ping = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-03-26' },
      payload: { jsonrpc: JSONRPC_VERSION, id: 2, method: 'ping', params: {} }
    })
    t.assert.strictEqual(ping.statusCode, 200)
  })
})

describe('MCP-Protocol-Version header validation', () => {
  test('accepts a supported version header', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())
    await app.register(mcpPlugin)
    await app.ready()

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'mcp-protocol-version': LATEST_PROTOCOL_VERSION },
      payload: { jsonrpc: JSONRPC_VERSION, id: 1, method: 'ping', params: {} }
    })

    t.assert.strictEqual(response.statusCode, 200)
  })

  test('rejects an unsupported version header with 400', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())
    await app.register(mcpPlugin)
    await app.ready()

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'mcp-protocol-version': '1999-01-01' },
      payload: { jsonrpc: JSONRPC_VERSION, id: 1, method: 'ping', params: {} }
    })

    t.assert.strictEqual(response.statusCode, 400)
    t.assert.deepStrictEqual(response.json().supported, [...SUPPORTED_PROTOCOL_VERSIONS])
  })

  test('a missing header is allowed and implies the pre-header revision', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())
    await app.register(mcpPlugin)

    let seen: string | undefined
    app.addHook('preHandler', async (request) => {
      seen = (request as any).mcpProtocolVersion
    })
    await app.ready()

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: { jsonrpc: JSONRPC_VERSION, id: 1, method: 'ping', params: {} }
    })

    t.assert.strictEqual(response.statusCode, 200)
    t.assert.strictEqual(seen, DEFAULT_NEGOTIATED_PROTOCOL_VERSION)
  })

  test('the header is not enforced on the well-known routes', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())
    await app.register(mcpPlugin, { authorization: createTestAuthConfig() })
    await app.ready()

    const response = await app.inject({
      method: 'GET',
      url: '/.well-known/oauth-protected-resource',
      headers: { 'mcp-protocol-version': '1999-01-01' }
    })

    t.assert.strictEqual(response.statusCode, 200)
  })
})

describe('Origin validation', () => {
  test('isOriginAllowed honours every configuration shape', (t: TestContext) => {
    // Unconfigured: validation off
    t.assert.strictEqual(isOriginAllowed('https://evil.example', undefined), true)
    // Wildcards
    t.assert.strictEqual(isOriginAllowed('https://evil.example', '*'), true)
    t.assert.strictEqual(isOriginAllowed('https://evil.example', true), true)
    // Allow-list
    t.assert.strictEqual(isOriginAllowed('https://app.example', ['https://app.example']), true)
    t.assert.strictEqual(isOriginAllowed('https://evil.example', ['https://app.example']), false)
    // No Origin header at all: not a browser, so not a rebinding risk
    t.assert.strictEqual(isOriginAllowed(undefined, ['https://app.example']), true)
  })

  test('rejects a disallowed Origin with 403', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())
    await app.register(mcpPlugin, { allowedOrigins: ['https://app.example'] })
    await app.ready()

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { origin: 'https://evil.example' },
      payload: { jsonrpc: JSONRPC_VERSION, id: 1, method: 'ping', params: {} }
    })

    t.assert.strictEqual(response.statusCode, 403)
  })

  test('accepts an allow-listed Origin', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())
    await app.register(mcpPlugin, { allowedOrigins: ['https://app.example'] })
    await app.ready()

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { origin: 'https://app.example' },
      payload: { jsonrpc: JSONRPC_VERSION, id: 1, method: 'ping', params: {} }
    })

    t.assert.strictEqual(response.statusCode, 200)
  })

  test('accepts any Origin when validation is not configured', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())
    await app.register(mcpPlugin)
    await app.ready()

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { origin: 'https://anything.example' },
      payload: { jsonrpc: JSONRPC_VERSION, id: 1, method: 'ping', params: {} }
    })

    t.assert.strictEqual(response.statusCode, 200)
  })

  test('Origin validation covers GET and DELETE too', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())
    await app.register(mcpPlugin, { enableSSE: true, allowedOrigins: ['https://app.example'] })
    await app.ready()

    const get = await app.inject({
      method: 'GET',
      url: '/mcp',
      headers: { origin: 'https://evil.example', accept: 'text/event-stream' }
    })
    t.assert.strictEqual(get.statusCode, 403)

    const del = await app.inject({
      method: 'DELETE',
      url: '/mcp',
      headers: { origin: 'https://evil.example' }
    })
    t.assert.strictEqual(del.statusCode, 403)
  })
})
