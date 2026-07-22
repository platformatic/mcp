import { test, describe } from 'node:test'
import type { TestContext } from 'node:test'
import Fastify from 'fastify'
import { Type } from '@sinclair/typebox'
import mcpPlugin from '../src/index.ts'
import { JSONRPC_VERSION, LATEST_PROTOCOL_VERSION, URL_ELICITATION_REQUIRED } from '../src/schema.ts'
import { validateElicitationUrl } from '../src/security.ts'
import { findMissingScopes, extractTokenScopes } from '../src/auth/prehandler.ts'
import { buildDiscoveryUrls, buildClientIdMetadataDocument } from '../src/auth/oauth-client.ts'

async function call (app: any, method: string, params: unknown, id = 1) {
  const response = await app.inject({
    method: 'POST',
    url: '/mcp',
    payload: { jsonrpc: JSONRPC_VERSION, id, method, params }
  })
  return response.json()
}

describe('protocol revision', () => {
  test('the server speaks 2025-11-25', (t: TestContext) => {
    t.assert.strictEqual(LATEST_PROTOCOL_VERSION, '2025-11-25')
  })

  test('URL_ELICITATION_REQUIRED is the code the spec assigns', (t: TestContext) => {
    t.assert.strictEqual(URL_ELICITATION_REQUIRED, -32042)
  })
})

describe('icons (SEP-973)', () => {
  test('icons survive the round trip for tools, resources and prompts', async (t: TestContext) => {
    const app = Fastify({ logger: false })
    t.after(() => app.close())
    await app.register(mcpPlugin)

    const icons = [{ src: 'https://example.com/icon.png', mimeType: 'image/png', sizes: ['48x48'] }]

    app.mcpAddTool({
      name: 'iconic',
      description: 'Has an icon',
      inputSchema: Type.Object({}),
      icons
    } as any)
    app.mcpAddResource({ uriPattern: 'file://x', name: 'res', icons } as any)
    app.mcpAddPrompt({ name: 'promptly', description: 'p', icons } as any)

    await app.ready()

    const tools = await call(app, 'tools/list', {})
    t.assert.deepStrictEqual(tools.result.tools[0].icons, icons)

    const resources = await call(app, 'resources/list', {})
    t.assert.deepStrictEqual(resources.result.resources[0].icons, icons)

    const prompts = await call(app, 'prompts/list', {})
    t.assert.deepStrictEqual(prompts.result.prompts[0].icons, icons)
  })
})

describe('JSON Schema 2020-12 dialect (SEP-1613)', () => {
  test('published tool schemas declare the dialect', async (t: TestContext) => {
    const app = Fastify({ logger: false })
    t.after(() => app.close())
    await app.register(mcpPlugin)
    app.mcpAddTool({
      name: 'x',
      description: 'x',
      inputSchema: Type.Object({ a: Type.String() })
    } as any)
    await app.ready()

    const body = await call(app, 'tools/list', {})
    t.assert.strictEqual(
      body.result.tools[0].inputSchema.$schema,
      'https://json-schema.org/draft/2020-12/schema'
    )
  })

  test('an author-supplied $schema is left alone', async (t: TestContext) => {
    const app = Fastify({ logger: false })
    t.after(() => app.close())
    await app.register(mcpPlugin)
    app.mcpAddTool({
      name: 'x',
      description: 'x',
      inputSchema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: {} }
    } as any)
    await app.ready()

    const body = await call(app, 'tools/list', {})
    t.assert.strictEqual(body.result.tools[0].inputSchema.$schema, 'http://json-schema.org/draft-07/schema#')
  })
})

describe('tool input validation is a tool error, not a protocol error (SEP-1303)', () => {
  test('schema violations come back as isError results', async (t: TestContext) => {
    const app = Fastify({ logger: false })
    t.after(() => app.close())
    await app.register(mcpPlugin)
    app.mcpAddTool(
      { name: 'strict', description: 'x', inputSchema: Type.Object({ a: Type.Number() }) } as any,
      async () => ({ content: [{ type: 'text', text: 'ok' }] })
    )
    await app.ready()

    const body = await call(app, 'tools/call', { name: 'strict', arguments: { a: 'not a number' } })
    t.assert.strictEqual(body.error, undefined)
    t.assert.strictEqual(body.result.isError, true)
  })

  test('sanitization failures come back as isError results too', async (t: TestContext) => {
    const app = Fastify({ logger: false })
    t.after(() => app.close())
    await app.register(mcpPlugin)
    app.mcpAddTool(
      { name: 'loose', description: 'x' } as any,
      async () => ({ content: [{ type: 'text', text: 'ok' }] })
    )
    await app.ready()

    // Exceeds the sanitizer's string length ceiling
    const body = await call(app, 'tools/call', { name: 'loose', arguments: { a: 'x'.repeat(20000) } })
    t.assert.strictEqual(body.error, undefined)
    t.assert.strictEqual(body.result.isError, true)
  })
})

describe('URL mode elicitation (SEP-1036)', () => {
  test('validateElicitationUrl accepts a plain https URL', (t: TestContext) => {
    t.assert.doesNotThrow(() => validateElicitationUrl('Please sign in', 'https://mcp.example.com/connect'))
  })

  test('validateElicitationUrl rejects malformed and unsafe URLs', (t: TestContext) => {
    t.assert.throws(() => validateElicitationUrl('m', 'not a url'), /not a valid URL/)
    t.assert.throws(() => validateElicitationUrl('m', 'javascript:alert(1)'), /must use http or https/)
    // Credentials in the URL would let a malicious client impersonate the user
    t.assert.throws(() => validateElicitationUrl('m', 'https://user:pw@example.com/'), /must not embed credentials/)
  })

  test('mcpElicitUrl sends a url-mode request and returns its elicitation id', async (t: TestContext) => {
    const app = Fastify({ logger: false })
    t.after(() => app.close())
    await app.register(mcpPlugin, { enableSSE: true })
    await app.ready()

    const init = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: { jsonrpc: JSONRPC_VERSION, id: 1, method: 'initialize', params: {} }
    })
    const sessionId = init.headers['mcp-session-id'] as string

    const elicitationId = await app.mcpElicitUrl(sessionId, 'Authorize access', 'https://mcp.example.com/connect')
    t.assert.ok(elicitationId, 'expected an elicitation id')

    const notified = await app.mcpNotifyElicitationComplete(sessionId, elicitationId!)
    t.assert.strictEqual(notified, true)
  })

  test('mcpElicitUrl refuses an unsafe URL', async (t: TestContext) => {
    const app = Fastify({ logger: false })
    t.after(() => app.close())
    await app.register(mcpPlugin, { enableSSE: true })
    await app.ready()

    const init = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: { jsonrpc: JSONRPC_VERSION, id: 1, method: 'initialize', params: {} }
    })
    const sessionId = init.headers['mcp-session-id'] as string

    t.assert.strictEqual(await app.mcpElicitUrl(sessionId, 'x', 'javascript:alert(1)'), null)
  })
})

describe('incremental scope consent (SEP-835)', () => {
  test('extractTokenScopes handles both token shapes', (t: TestContext) => {
    t.assert.deepStrictEqual(extractTokenScopes({ scope: 'read write' }), ['read', 'write'])
    t.assert.deepStrictEqual(extractTokenScopes({ scopes: ['read'] }), ['read'])
    t.assert.deepStrictEqual(extractTokenScopes({}), [])
    t.assert.deepStrictEqual(extractTokenScopes(null), [])
  })

  test('findMissingScopes reports only what is absent', (t: TestContext) => {
    t.assert.deepStrictEqual(findMissingScopes(['read', 'write'], { scope: 'read' }), ['write'])
    t.assert.deepStrictEqual(findMissingScopes(['read'], { scope: 'read write' }), [])
    // Nothing required means nothing missing, whatever the token says
    t.assert.deepStrictEqual(findMissingScopes(undefined, {}), [])
    t.assert.deepStrictEqual(findMissingScopes([], {}), [])
  })
})

describe('authorization server discovery (SEP-797)', () => {
  test('a root issuer yields the RFC 8414 and OIDC locations', (t: TestContext) => {
    t.assert.deepStrictEqual(buildDiscoveryUrls('https://auth.example.com'), [
      'https://auth.example.com/.well-known/oauth-authorization-server',
      'https://auth.example.com/.well-known/openid-configuration'
    ])
  })

  test('a path-bearing issuer yields insertion and appending forms', (t: TestContext) => {
    t.assert.deepStrictEqual(buildDiscoveryUrls('https://auth.example.com/tenant1'), [
      'https://auth.example.com/.well-known/oauth-authorization-server/tenant1',
      'https://auth.example.com/.well-known/openid-configuration/tenant1',
      'https://auth.example.com/tenant1/.well-known/openid-configuration'
    ])
  })

  test('a trailing slash does not change the result', (t: TestContext) => {
    t.assert.deepStrictEqual(
      buildDiscoveryUrls('https://auth.example.com/'),
      buildDiscoveryUrls('https://auth.example.com')
    )
  })
})

describe('SSE polling support (SEP-1699)', () => {
  test('the server closes the stream after sseMaxConnectionMs', async (t: TestContext) => {
    const app = Fastify({ logger: false })
    t.after(() => app.close())
    await app.register(mcpPlugin, { enableSSE: true, sseMaxConnectionMs: 50 })
    await app.listen({ port: 0 })

    const address = app.server.address() as { port: number }
    const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
      headers: { accept: 'text/event-stream' }
    })

    t.assert.strictEqual(response.status, 200)
    t.assert.strictEqual(response.headers.get('content-type'), 'text/event-stream')

    // Draining to completion proves the server ended the stream on its own
    await response.text()
  })

  test('a stream stays open when no maximum is configured', async (t: TestContext) => {
    const app = Fastify({ logger: false })
    t.after(() => app.close())
    await app.register(mcpPlugin, { enableSSE: true })
    await app.ready()

    const response = await app.inject({
      method: 'GET',
      url: '/mcp',
      payloadAsStream: true,
      headers: { accept: 'text/event-stream' }
    })

    t.assert.strictEqual(response.statusCode, 200)
    t.assert.strictEqual(response.headers['content-type'], 'text/event-stream')
    response.stream().destroy()
  })
})

describe('client ID metadata document (SEP-991)', () => {
  test('the document identifies itself by its own URL', (t: TestContext) => {
    const url = 'https://mcp.example.com/.well-known/oauth-client'
    const doc = buildClientIdMetadataDocument(
      { authorizationServer: 'https://auth.example.com', resourceUri: 'https://mcp.example.com', scopes: ['read'] },
      url
    )

    t.assert.strictEqual(doc.client_id, url)
    t.assert.deepStrictEqual(doc.redirect_uris, ['https://mcp.example.com/oauth/callback'])
    t.assert.strictEqual(doc.scope, 'read')
  })

  test('the document is served and adopted as the client_id', async (t: TestContext) => {
    const app = Fastify({ logger: false })
    t.after(() => app.close())

    const { default: oauthClientPlugin } = await import('../src/auth/oauth-client.ts')
    await app.register(oauthClientPlugin, {
      authorizationServer: 'https://auth.example.invalid',
      resourceUri: 'https://mcp.example.com',
      clientIdMetadataDocument: true
    })
    await app.ready()

    const response = await app.inject({ method: 'GET', url: '/.well-known/oauth-client' })
    t.assert.strictEqual(response.statusCode, 200)
    t.assert.strictEqual(
      response.json().client_id,
      'https://mcp.example.com/.well-known/oauth-client'
    )
  })
})
