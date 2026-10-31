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
    // Unconfigured: only loopback and the server's own host are trusted
    t.assert.strictEqual(isOriginAllowed('https://evil.example', undefined, 'api.example.com'), false)
    t.assert.strictEqual(isOriginAllowed('https://evil.example', undefined), false)
    t.assert.strictEqual(isOriginAllowed('null', undefined, 'api.example.com'), false)
    t.assert.strictEqual(isOriginAllowed('not a url', undefined, 'api.example.com'), false)
    t.assert.strictEqual(isOriginAllowed('file:///etc/passwd', undefined, 'api.example.com'), false)
    t.assert.strictEqual(isOriginAllowed(undefined, undefined, 'api.example.com'), true)
    // Wildcards
    t.assert.strictEqual(isOriginAllowed('https://evil.example', '*'), true)
    t.assert.strictEqual(isOriginAllowed('https://evil.example', true), true)
    // Allow-list
    t.assert.strictEqual(isOriginAllowed('https://app.example', ['https://app.example']), true)
    t.assert.strictEqual(isOriginAllowed('https://evil.example', ['https://app.example']), false)
    // No Origin header at all: not a browser, so not a rebinding risk
    t.assert.strictEqual(isOriginAllowed(undefined, ['https://app.example']), true)
  })

  test('isOriginAllowed trusts loopback origins by default', (t: TestContext) => {
    for (const origin of [
      'http://localhost',
      'http://localhost:3000',
      'https://localhost:8443',
      'http://127.0.0.1',
      'http://127.0.0.1:5173',
      'https://127.1.2.3:9000',
      'http://[::1]',
      'http://[::1]:3000',
      'http://LOCALHOST:3000'
    ]) {
      t.assert.strictEqual(isOriginAllowed(origin, undefined, 'api.example.com'), true, origin)
    }

    for (const origin of [
      'http://localhost.evil.example',
      'http://127.0.0.1.evil.example',
      'http://128.0.0.1',
      'http://[::2]',
      'http://0.0.0.0'
    ]) {
      t.assert.strictEqual(isOriginAllowed(origin, undefined, 'api.example.com'), false, origin)
    }
  })

  test('isOriginAllowed trusts the server\'s own host by default', (t: TestContext) => {
    // Scheme-agnostic: a TLS-terminating proxy leaves the server seeing plain HTTP
    t.assert.strictEqual(isOriginAllowed('https://api.example.com', undefined, 'api.example.com'), true)
    t.assert.strictEqual(isOriginAllowed('http://api.example.com', undefined, 'api.example.com'), true)
    t.assert.strictEqual(isOriginAllowed('https://API.example.com', undefined, 'api.example.com'), true)
    t.assert.strictEqual(isOriginAllowed('https://api.example.com:8443', undefined, 'api.example.com:8443'), true)
    // An explicit default port in Host matches the origin's implied one
    t.assert.strictEqual(isOriginAllowed('https://api.example.com', undefined, 'api.example.com:443'), true)
    // Port mismatch and sibling hosts are rejected
    t.assert.strictEqual(isOriginAllowed('https://api.example.com:9000', undefined, 'api.example.com'), false)
    t.assert.strictEqual(isOriginAllowed('https://evil.api.example.com', undefined, 'api.example.com'), false)
    t.assert.strictEqual(isOriginAllowed('https://api.example.com', undefined, 'other.example.com'), false)
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

  test('rejects a foreign Origin with 403 when allowedOrigins is not configured', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())
    await app.register(mcpPlugin)
    await app.ready()

    for (const origin of ['https://evil.example', 'null']) {
      const response = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { origin, host: 'mcp.example.com' },
        payload: { jsonrpc: JSONRPC_VERSION, id: 1, method: 'ping', params: {} }
      })

      t.assert.strictEqual(response.statusCode, 403, origin)
      t.assert.deepStrictEqual(response.json(), { error: 'Forbidden: Origin not allowed' })
    }
  })

  test('accepts loopback, same-host and absent Origins when allowedOrigins is not configured', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())
    await app.register(mcpPlugin)
    await app.ready()

    for (const origin of ['http://localhost:5173', 'http://127.0.0.1:8080', 'http://[::1]:3000', 'https://mcp.example.com', undefined]) {
      const headers: Record<string, string> = { host: 'mcp.example.com' }
      if (origin !== undefined) headers.origin = origin
      const response = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers,
        payload: { jsonrpc: JSONRPC_VERSION, id: 1, method: 'ping', params: {} }
      })

      t.assert.strictEqual(response.statusCode, 200, String(origin))
    }
  })

  test('accepts any Origin when allowedOrigins opts out with true or \'*\'', async (t: TestContext) => {
    for (const allowedOrigins of [true, '*'] as const) {
      const app = Fastify()
      t.after(() => app.close())
      await app.register(mcpPlugin, { allowedOrigins })
      await app.ready()

      for (const origin of ['https://anything.example', 'null']) {
        const response = await app.inject({
          method: 'POST',
          url: '/mcp',
          headers: { origin },
          payload: { jsonrpc: JSONRPC_VERSION, id: 1, method: 'ping', params: {} }
        })

        t.assert.strictEqual(response.statusCode, 200, `${String(allowedOrigins)} ${origin}`)
      }
    }
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

  test('default Origin validation covers GET and DELETE too', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())
    await app.register(mcpPlugin, { enableSSE: true })
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
