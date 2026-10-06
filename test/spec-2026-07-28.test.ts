import { test, describe } from 'node:test'
import { PassThrough } from 'node:stream'
import type { TestContext } from 'node:test'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { Type } from '@sinclair/typebox'
import mcpPlugin from '../src/index.ts'
import { createStdioTransport } from '../src/stdio.ts'
import {
  JSONRPC_VERSION,
  LATEST_PROTOCOL_VERSION,
  LATEST_LEGACY_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  METHOD_NOT_FOUND,
  INVALID_PARAMS,
  HEADER_MISMATCH,
  MISSING_REQUIRED_CLIENT_CAPABILITY,
  UNSUPPORTED_PROTOCOL_VERSION,
  INVALID_REQUEST
} from '../src/schema.ts'
import {
  META_PROTOCOL_VERSION,
  META_CLIENT_INFO,
  META_CLIENT_CAPABILITIES,
  META_SERVER_INFO,
  TASKS_EXTENSION
} from '../src/schema-2026.ts'
import { InputRequired, elicitForm, elicitUrl } from '../src/modern/input-required.ts'
import { encodeHeaderValue } from '../src/modern/headers.ts'
import { TASK_INPUT_TOPIC } from '../src/modern/task-inputs.ts'
import { MemoryMessageBroker } from '../src/brokers/memory-message-broker.ts'
import type { ClientCapabilities } from '../src/schema-2026.ts'

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

interface CallOptions {
  id?: string | number
  params?: Record<string, unknown>
  capabilities?: ClientCapabilities
  protocolVersion?: string
  /** Override or drop headers, to exercise the validation rules. */
  headers?: Record<string, string | undefined>
}

function modernBody (method: string, options: CallOptions = {}) {
  return {
    jsonrpc: JSONRPC_VERSION,
    id: options.id ?? 1,
    method,
    params: {
      ...(options.params ?? {}),
      _meta: {
        [META_PROTOCOL_VERSION]: options.protocolVersion ?? LATEST_PROTOCOL_VERSION,
        [META_CLIENT_INFO]: { name: 'test-client', version: '1.0.0' },
        [META_CLIENT_CAPABILITIES]: options.capabilities ?? {}
      }
    }
  }
}

/** Build the headers a conforming 2026-07-28 client would send. */
function modernHeaders (method: string, options: CallOptions = {}): Record<string, string> {
  const params = options.params ?? {}
  const name = method === 'resources/read' ? params.uri : params.name

  const headers: Record<string, string | undefined> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': options.protocolVersion ?? LATEST_PROTOCOL_VERSION,
    'mcp-method': method,
    ...(typeof name === 'string' ? { 'mcp-name': encodeHeaderValue(name) } : {}),
    ...(options.headers ?? {})
  }

  return Object.fromEntries(
    Object.entries(headers).filter(([, v]) => v !== undefined)
  ) as Record<string, string>
}

async function call (app: FastifyInstance, method: string, options: CallOptions = {}) {
  return await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: modernHeaders(method, options),
    payload: modernBody(method, options)
  })
}

async function buildServer (
  t: TestContext,
  configure?: (app: FastifyInstance) => void | Promise<void>,
  pluginOptions: Record<string, unknown> = {}
): Promise<FastifyInstance> {
  const app = Fastify()
  t.after(() => app.close())
  await app.register(mcpPlugin, {
    serverInfo: { name: 'test-server', version: '9.9.9' },
    capabilities: { tools: {}, resources: {}, prompts: {} },
    instructions: 'Be helpful.',
    ...pluginOptions
  })
  await configure?.(app)
  await app.ready()
  return app
}

/* ------------------------------------------------------------------ */

describe('2026-07-28: versioning and discovery', () => {
  test('2026-07-28 is the latest revision and is supported', (t: TestContext) => {
    t.assert.strictEqual(LATEST_PROTOCOL_VERSION, '2026-07-28')
    t.assert.ok((SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes('2026-07-28'))
    // Dual-era: the handshake revisions are still served.
    t.assert.ok((SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes('2025-11-25'))
  })

  test('server/discover reports versions, capabilities and identity', async (t: TestContext) => {
    const app = await buildServer(t)

    const response = await call(app, 'server/discover')
    t.assert.strictEqual(response.statusCode, 200)

    const result = response.json().result
    t.assert.strictEqual(result.resultType, 'complete')
    t.assert.deepStrictEqual(result.supportedVersions, [...SUPPORTED_PROTOCOL_VERSIONS])
    t.assert.deepStrictEqual(result.capabilities.tools, {})
    t.assert.strictEqual(result.instructions, 'Be helpful.')
    t.assert.deepStrictEqual(result._meta[META_SERVER_INFO], { name: 'test-server', version: '9.9.9' })
  })

  test('server/discover carries caching hints', async (t: TestContext) => {
    const app = await buildServer(t, undefined, {
      caching: { discover: { ttlMs: 3600000, cacheScope: 'public' } }
    })

    const result = (await call(app, 'server/discover')).json().result
    t.assert.strictEqual(result.ttlMs, 3600000)
    t.assert.strictEqual(result.cacheScope, 'public')
  })

  test('caching defaults to immediately stale and never shared', async (t: TestContext) => {
    const app = await buildServer(t)

    const result = (await call(app, 'tools/list')).json().result
    t.assert.strictEqual(result.ttlMs, 0)
    t.assert.strictEqual(result.cacheScope, 'private')
  })

  test('a legacy revision named in _meta is refused on the modern path', async (t: TestContext) => {
    const app = await buildServer(t)

    // 2024-11-05 has no notion of resultType or caching hints, so serving it a
    // modern envelope would be worse than refusing.
    const response = await call(app, 'tools/list', { protocolVersion: '2024-11-05' })

    t.assert.strictEqual(response.statusCode, 400)
    const error = response.json().error
    t.assert.strictEqual(error.code, UNSUPPORTED_PROTOCOL_VERSION)
    // The client is still told everything we speak, so it can drop back.
    t.assert.deepStrictEqual(error.data.supported, [...SUPPORTED_PROTOCOL_VERSIONS])
  })

  test('an unsupported version is rejected with 400 and the supported list', async (t: TestContext) => {
    const app = await buildServer(t)

    const response = await call(app, 'server/discover', { protocolVersion: '1999-01-01' })

    t.assert.strictEqual(response.statusCode, 400)
    const error = response.json().error
    t.assert.strictEqual(error.code, UNSUPPORTED_PROTOCOL_VERSION)
    t.assert.strictEqual(error.data.requested, '1999-01-01')
    t.assert.deepStrictEqual(error.data.supported, [...SUPPORTED_PROTOCOL_VERSIONS])
  })
})

describe('2026-07-28: per-request metadata', () => {
  test('a modern version header with no _meta is invalid params, not a legacy request', async (t: TestContext) => {
    const app = await buildServer(t)

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
        'mcp-method': 'tools/list'
      },
      payload: { jsonrpc: JSONRPC_VERSION, id: 1, method: 'tools/list', params: {} }
    })

    t.assert.strictEqual(response.statusCode, 400)
    t.assert.strictEqual(response.json().error.code, INVALID_PARAMS)
  })

  test('modern headers cannot be used to smuggle a body past header validation', async (t: TestContext) => {
    const called: string[] = []
    const app = await buildServer(t, (app) => {
      for (const name of ['safe_tool', 'dangerous_tool']) {
        app.mcpAddTool({ name, inputSchema: Type.Object({}) }, async () => {
          called.push(name)
          return { content: [{ type: 'text', text: name }] }
        })
      }
    })

    // A gateway routing on Mcp-Name sees `safe_tool`. Dropping `_meta` used to
    // divert this to the legacy path, where no header validation happens, and
    // `dangerous_tool` ran anyway.
    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
        'mcp-method': 'tools/call',
        'mcp-name': 'safe_tool'
      },
      payload: {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'tools/call',
        params: { name: 'dangerous_tool', arguments: {} }
      }
    })

    t.assert.strictEqual(response.statusCode, 400)
    t.assert.deepStrictEqual(called, [])
  })

  test('a legacy request without a modern header still takes the legacy path', async (t: TestContext) => {
    const app = await buildServer(t)

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: { jsonrpc: JSONRPC_VERSION, id: 1, method: 'tools/list', params: {} }
    })

    t.assert.strictEqual(response.statusCode, 200)
    t.assert.strictEqual(response.json().result.resultType, undefined)
  })

  test('_meta without clientCapabilities is rejected', async (t: TestContext) => {
    const app = await buildServer(t)

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
        'mcp-method': 'tools/list'
      },
      payload: {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'tools/list',
        params: { _meta: { [META_PROTOCOL_VERSION]: LATEST_PROTOCOL_VERSION } }
      }
    })

    t.assert.strictEqual(response.statusCode, 400)
    t.assert.strictEqual(response.json().error.code, INVALID_PARAMS)
  })

  test('every result identifies the server', async (t: TestContext) => {
    const app = await buildServer(t)

    const result = (await call(app, 'tools/list')).json().result
    t.assert.deepStrictEqual(result._meta[META_SERVER_INFO], { name: 'test-server', version: '9.9.9' })
  })
})

describe('2026-07-28: header validation', () => {
  test('a missing MCP-Protocol-Version header is a header mismatch', async (t: TestContext) => {
    const app = await buildServer(t)

    const response = await call(app, 'tools/list', {
      headers: { 'mcp-protocol-version': undefined }
    })

    t.assert.strictEqual(response.statusCode, 400)
    t.assert.strictEqual(response.json().error.code, HEADER_MISMATCH)
  })

  test('a version header disagreeing with the body is a header mismatch', async (t: TestContext) => {
    const app = await buildServer(t)

    const response = await call(app, 'tools/list', {
      headers: { 'mcp-protocol-version': '2025-11-25' }
    })

    t.assert.strictEqual(response.statusCode, 400)
    const error = response.json().error
    t.assert.strictEqual(error.code, HEADER_MISMATCH)
    t.assert.match(error.message, /MCP-Protocol-Version/)
  })

  test('a missing Mcp-Method header is a header mismatch', async (t: TestContext) => {
    const app = await buildServer(t)

    const response = await call(app, 'tools/list', { headers: { 'mcp-method': undefined } })

    t.assert.strictEqual(response.statusCode, 400)
    t.assert.strictEqual(response.json().error.code, HEADER_MISMATCH)
  })

  test('an Mcp-Method header disagreeing with the body is a header mismatch', async (t: TestContext) => {
    const app = await buildServer(t)

    const response = await call(app, 'tools/list', { headers: { 'mcp-method': 'tools/call' } })

    t.assert.strictEqual(response.statusCode, 400)
    t.assert.match(response.json().error.message, /Mcp-Method/)
  })

  test('Mcp-Name must match the tool being called', async (t: TestContext) => {
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({ name: 'greet', inputSchema: Type.Object({}) }, async () => ({
        content: [{ type: 'text', text: 'hi' }]
      }))
    })

    const response = await call(app, 'tools/call', {
      params: { name: 'greet', arguments: {} },
      headers: { 'mcp-name': 'other' }
    })

    t.assert.strictEqual(response.statusCode, 400)
    t.assert.match(response.json().error.message, /Mcp-Name/)
  })

  test('Mcp-Name is required even when the body omits the name', async (t: TestContext) => {
    const app = await buildServer(t)

    // A body with no `name` is malformed, but that does not excuse the missing
    // header — a gateway routing on Mcp-Name must always have one to route on.
    const response = await call(app, 'tools/call', { params: { arguments: {} } })

    t.assert.strictEqual(response.statusCode, 400)
    t.assert.strictEqual(response.json().error.code, HEADER_MISMATCH)
  })

  test('a Base64-encoded Mcp-Name is decoded before comparison', async (t: TestContext) => {
    const uri = 'file:///tmp/héllo.txt'
    const app = await buildServer(t, (app) => {
      app.mcpAddResource({ uriPattern: uri }, async () => ({
        contents: [{ uri, text: 'ok', mimeType: 'text/plain' }]
      }))
    })

    // The helper encodes automatically; assert it really did use the sentinel.
    const headers = modernHeaders('resources/read', { params: { uri } })
    t.assert.ok(headers['mcp-name'].startsWith('=?base64?'))

    const response = await call(app, 'resources/read', { params: { uri } })
    t.assert.strictEqual(response.statusCode, 200)
    t.assert.strictEqual(response.json().result.contents[0].text, 'ok')
  })

  test('malformed UTF-8 in an encoded parameter header is rejected', async (t: TestContext) => {
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({
        name: 'utf8-tool',
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'string', 'x-mcp-header': 'Value' } }
        }
      }, async () => ({ content: [{ type: 'text', text: 'ran' }] }))
    })

    const response = await call(app, 'tools/call', {
      params: { name: 'utf8-tool', arguments: { value: '\uFFFD' } },
      headers: { 'mcp-param-value': '=?base64?/w==?=' }
    })
    t.assert.strictEqual(response.statusCode, 400)
    t.assert.strictEqual(response.json().error.code, HEADER_MISMATCH)
  })

  test('unsafe integer parameter headers are rejected without rounding collisions', async (t: TestContext) => {
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({
        name: 'tenant-tool',
        inputSchema: {
          type: 'object',
          properties: {
            tenant: { type: 'integer', 'x-mcp-header': 'Tenant' }
          }
        }
      }, async () => ({ content: [{ type: 'text', text: 'ran' }] }))
    })

    const response = await call(app, 'tools/call', {
      params: { name: 'tenant-tool', arguments: { tenant: Number('9007199254740993') } },
      headers: { 'mcp-param-tenant': '9007199254740993' }
    })

    t.assert.strictEqual(response.statusCode, 400)
    t.assert.strictEqual(response.json().error.code, HEADER_MISMATCH)
  })

  test('modern tools/list excludes definitions with unreachable x-mcp-header annotations', async (t: TestContext) => {
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({
        name: 'invalid-header-tool',
        inputSchema: {
          type: 'object',
          allOf: [{ type: 'string', 'x-mcp-header': 'Tenant' }]
        }
      }, async () => ({ content: [{ type: 'text', text: 'must not run' }] }))
    })

    const listed = await call(app, 'tools/list')
    t.assert.deepStrictEqual(listed.json().result.tools, [])

    // The broken annotation is the server's bug, not a client header mismatch:
    // the hidden tool is reported exactly like any other unknown tool.
    const called = await call(app, 'tools/call', {
      params: { name: 'invalid-header-tool', arguments: {} }
    })
    t.assert.strictEqual(called.json().error.code, INVALID_PARAMS)
    t.assert.match(called.json().error.message, /Unknown tool/)
  })

  test('a tool parameter marked x-mcp-header must be mirrored and must match', async (t: TestContext) => {
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({
        name: 'query',
        inputSchema: {
          type: 'object',
          properties: {
            region: { type: 'string', 'x-mcp-header': 'Region' },
            sql: { type: 'string' }
          }
        }
      }, async () => ({ content: [{ type: 'text', text: 'ran' }] }))
    })

    const params = { name: 'query', arguments: { region: 'us-west1', sql: 'SELECT 1' } }

    const missing = await call(app, 'tools/call', { params })
    t.assert.strictEqual(missing.statusCode, 400)
    t.assert.strictEqual(missing.json().error.code, HEADER_MISMATCH)

    const mismatched = await call(app, 'tools/call', {
      params,
      headers: { 'mcp-param-region': 'eu-west1' }
    })
    t.assert.strictEqual(mismatched.json().error.code, HEADER_MISMATCH)

    const good = await call(app, 'tools/call', {
      params,
      headers: { 'mcp-param-region': 'us-west1' }
    })
    t.assert.strictEqual(good.json().result.content[0].text, 'ran')
  })
})

describe('2026-07-28: removed methods', () => {
  for (const method of ['initialize', 'ping', 'logging/setLevel', 'resources/subscribe', 'tasks/result', 'tasks/list']) {
    test(`${method} is gone`, async (t: TestContext) => {
      const app = await buildServer(t)

      const response = await call(app, method, { params: { uri: 'file:///x' } })
      t.assert.strictEqual(response.statusCode, 404)
      t.assert.strictEqual(response.json().error.code, METHOD_NOT_FOUND)
    })
  }
})

describe('2026-07-28: server features', () => {
  test('tools/list returns a complete, cacheable result', async (t: TestContext) => {
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({ name: 'greet', description: 'Greets', inputSchema: Type.Object({}) })
    }, { caching: { toolsList: { ttlMs: 300000, cacheScope: 'public' } } })

    const result = (await call(app, 'tools/list')).json().result
    t.assert.strictEqual(result.resultType, 'complete')
    t.assert.strictEqual(result.ttlMs, 300000)
    t.assert.strictEqual(result.cacheScope, 'public')
    t.assert.strictEqual(result.tools[0].name, 'greet')
  })

  test('tools/call runs the tool', async (t: TestContext) => {
    const app = await buildServer(t, (app) => {
      app.mcpAddTool(
        { name: 'add', inputSchema: Type.Object({ a: Type.Number(), b: Type.Number() }) },
        async (args: any) => ({ content: [{ type: 'text', text: String(args.a + args.b) }] })
      )
    })

    const response = await call(app, 'tools/call', { params: { name: 'add', arguments: { a: 2, b: 3 } } })
    const result = response.json().result
    t.assert.strictEqual(result.resultType, 'complete')
    t.assert.strictEqual(result.content[0].text, '5')
  })

  test('an unknown tool is invalid params, not method not found', async (t: TestContext) => {
    const app = await buildServer(t)

    const response = await call(app, 'tools/call', { params: { name: 'nope', arguments: {} } })
    t.assert.strictEqual(response.statusCode, 200)
    t.assert.strictEqual(response.json().error.code, INVALID_PARAMS)
  })

  test('an unknown resource is invalid params', async (t: TestContext) => {
    const app = await buildServer(t)

    const response = await call(app, 'resources/read', { params: { uri: 'file:///missing' } })
    t.assert.strictEqual(response.json().error.code, INVALID_PARAMS)
  })
})

describe('2026-07-28: multi round-trip requests', () => {
  /** A tool that needs a name before it can greet. */
  function registerElicitingTool (app: FastifyInstance, seen: string[]) {
    app.mcpAddTool({ name: 'greet', inputSchema: Type.Object({}) }, async (_args: any, context: any) => {
      const answer = context.inputResponses?.who as { content?: { name?: string } } | undefined
      if (!answer) {
        throw new InputRequired({
          inputRequests: {
            who: elicitForm('Who are you?', {
              type: 'object',
              properties: { name: { type: 'string' } },
              required: ['name']
            })
          },
          state: { asked: true }
        })
      }

      seen.push(JSON.stringify(context.requestState))
      return { content: [{ type: 'text', text: `hello ${answer.content?.name}` }] }
    })
  }

  const elicitationCapable: ClientCapabilities = { elicitation: { form: {} } }

  test('a handler needing input returns input_required with sealed state', async (t: TestContext) => {
    const app = await buildServer(t, (app) => registerElicitingTool(app, []))

    const response = await call(app, 'tools/call', {
      params: { name: 'greet', arguments: {} },
      capabilities: elicitationCapable
    })

    t.assert.strictEqual(response.statusCode, 200)
    const result = response.json().result
    t.assert.strictEqual(result.resultType, 'input_required')
    t.assert.strictEqual(result.inputRequests.who.method, 'elicitation/create')
    t.assert.strictEqual(typeof result.requestState, 'string')
  })

  test('retrying with inputResponses and the state completes the call', async (t: TestContext) => {
    const seen: string[] = []
    const app = await buildServer(t, (app) => registerElicitingTool(app, seen))

    const params = { name: 'greet', arguments: {} }
    const first = (await call(app, 'tools/call', { params, capabilities: elicitationCapable })).json().result

    const retry = await call(app, 'tools/call', {
      id: 2,
      capabilities: elicitationCapable,
      params: {
        ...params,
        requestState: first.requestState,
        inputResponses: { who: { action: 'accept', content: { name: 'octocat' } } }
      }
    })

    t.assert.strictEqual(retry.json().result.content[0].text, 'hello octocat')
    // The handler got its own state back, unsealed.
    t.assert.deepStrictEqual(JSON.parse(seen[0]), { asked: true })
  })

  test('a tampered requestState is refused', async (t: TestContext) => {
    const app = await buildServer(t, (app) => registerElicitingTool(app, []))

    const params = { name: 'greet', arguments: {} }
    const first = (await call(app, 'tools/call', { params, capabilities: elicitationCapable })).json().result

    const forged = first.requestState.slice(0, -4) + 'AAAA'
    const retry = await call(app, 'tools/call', {
      id: 2,
      capabilities: elicitationCapable,
      params: { ...params, requestState: forged, inputResponses: {} }
    })

    const error = retry.json().error
    t.assert.strictEqual(error.code, INVALID_PARAMS)
    t.assert.match(error.message, /integrity/)
  })

  test('custom upstream authentication binds state to its resolved principal', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())
    app.addHook('preHandler', async (request) => {
      ;(request as any).upstreamUserId = request.headers['x-auth-user']
    })
    let resolutions = 0
    await app.register(mcpPlugin, {
      requestStateSecret: 'shared-test-secret',
      resolveAuthorizationContext: (request) => {
        resolutions++
        const userId = (request as any).upstreamUserId
        return typeof userId === 'string' ? { userId, tokenType: 'upstream' } : undefined
      }
    })
    registerElicitingTool(app, [])
    await app.ready()

    const params = { name: 'greet', arguments: {} }
    const first = (await call(app, 'tools/call', {
      params,
      capabilities: elicitationCapable,
      headers: { 'x-auth-user': 'user-a' }
    })).json().result

    const rejected = await call(app, 'tools/call', {
      id: 2,
      capabilities: elicitationCapable,
      headers: { 'x-auth-user': 'user-b' },
      params: {
        ...params,
        requestState: first.requestState,
        inputResponses: { who: { action: 'accept', content: { name: 'octocat' } } }
      }
    })

    t.assert.strictEqual(rejected.json().error.code, INVALID_PARAMS)
    t.assert.match(rejected.json().error.message, /different principal/)
    t.assert.strictEqual(resolutions, 2, 'the resolver runs exactly once per request')
  })

  test('state minted for one call cannot be replayed onto another', async (t: TestContext) => {
    const app = await buildServer(t, (app) => {
      registerElicitingTool(app, [])
      app.mcpAddTool({ name: 'other', inputSchema: Type.Object({}) }, async () => ({
        content: [{ type: 'text', text: 'other' }]
      }))
    })

    const first = (await call(app, 'tools/call', {
      params: { name: 'greet', arguments: {} },
      capabilities: elicitationCapable
    })).json().result

    const replay = await call(app, 'tools/call', {
      id: 2,
      capabilities: elicitationCapable,
      params: { name: 'other', arguments: {}, requestState: first.requestState }
    })

    t.assert.strictEqual(replay.json().error.code, INVALID_PARAMS)
    t.assert.match(replay.json().error.message, /different request/)
  })

  test('URL mode is refused for a client that only declared form elicitation', async (t: TestContext) => {
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({ name: 'verify', inputSchema: Type.Object({}) }, async () => {
        throw new InputRequired({
          inputRequests: { go: elicitUrl('Verify here', 'https://example.com/verify') }
        })
      })
    })

    const response = await call(app, 'tools/call', {
      params: { name: 'verify', arguments: {} },
      capabilities: { elicitation: { form: {} } }
    })

    t.assert.strictEqual(response.statusCode, 400)
    const error = response.json().error
    t.assert.strictEqual(error.code, MISSING_REQUIRED_CLIENT_CAPABILITY)
    t.assert.deepStrictEqual(error.data.requiredCapabilities, { elicitation: { url: {} } })
  })

  test('URL mode is allowed once the client declares it', async (t: TestContext) => {
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({ name: 'verify', inputSchema: Type.Object({}) }, async () => {
        throw new InputRequired({
          inputRequests: { go: elicitUrl('Verify here', 'https://example.com/verify') }
        })
      })
    })

    const result = (await call(app, 'tools/call', {
      params: { name: 'verify', arguments: {} },
      capabilities: { elicitation: { form: {}, url: {} } }
    })).json().result

    t.assert.strictEqual(result.resultType, 'input_required')
    t.assert.strictEqual(result.inputRequests.go.params.mode, 'url')
  })

  test('the server never asks for a capability the client did not declare', async (t: TestContext) => {
    const app = await buildServer(t, (app) => registerElicitingTool(app, []))

    // No elicitation capability this time.
    const response = await call(app, 'tools/call', { params: { name: 'greet', arguments: {} } })

    t.assert.strictEqual(response.statusCode, 400)
    const error = response.json().error
    t.assert.strictEqual(error.code, MISSING_REQUIRED_CLIENT_CAPABILITY)
    t.assert.deepStrictEqual(error.data.requiredCapabilities, { elicitation: {} })
  })
})

describe('2026-07-28: MRTR retries are not cacheable', () => {
  test('a retry carrying requestState or inputResponses gets no caching hints', async (t: TestContext) => {
    const uri = 'file:///doc'
    const app = await buildServer(t, (app) => {
      app.mcpAddResource({ uriPattern: uri }, async (_uri: string, context: any) => {
        if (!context.requestState) {
          throw new InputRequired({ state: { seen: true } })
        }
        return { contents: [{ uri, text: 'secret', mimeType: 'text/plain' }] }
      })
    }, { caching: { resourcesRead: { ttlMs: 600000, cacheScope: 'public' } } })

    const first = (await call(app, 'resources/read', { params: { uri } })).json().result
    t.assert.strictEqual(first.resultType, 'input_required')
    // Interim results are not cacheable either.
    t.assert.strictEqual(first.ttlMs, undefined)

    const retry = (await call(app, 'resources/read', {
      id: 2,
      params: { uri, requestState: first.requestState }
    })).json().result

    t.assert.strictEqual(retry.resultType, 'complete')
    t.assert.strictEqual(retry.contents[0].text, 'secret')
    // The result depends on inputs outside the cache key, so it MUST NOT be
    // cached — a `public` hint here would leak it through a shared proxy.
    t.assert.strictEqual(retry.ttlMs, undefined)
    t.assert.strictEqual(retry.cacheScope, undefined)
  })

  test('the same read without MRTR fields still carries its hints', async (t: TestContext) => {
    const uri = 'file:///plain'
    const app = await buildServer(t, (app) => {
      app.mcpAddResource({ uriPattern: uri }, async () => ({
        contents: [{ uri, text: 'ok', mimeType: 'text/plain' }]
      }))
    }, { caching: { resourcesRead: { ttlMs: 600000, cacheScope: 'public' } } })

    const result = (await call(app, 'resources/read', { params: { uri } })).json().result
    t.assert.strictEqual(result.ttlMs, 600000)
    t.assert.strictEqual(result.cacheScope, 'public')
  })
})

describe('2026-07-28: subscriptions', () => {
  // Each notification type is only supported when the capability says the
  // server emits it.
  const emitting = {
    tools: { listChanged: true },
    resources: { listChanged: true, subscribe: true },
    prompts: { listChanged: true }
  }

  test('listen acknowledges with the filter the server agreed to', async (t: TestContext) => {
    const app = await buildServer(t, undefined, { capabilities: emitting })

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payloadAsStream: true,
      headers: modernHeaders('subscriptions/listen'),
      payload: modernBody('subscriptions/listen', {
        id: 7,
        params: { notifications: { toolsListChanged: true, resourceSubscriptions: ['file:///a'] } }
      })
    })

    t.assert.strictEqual(response.statusCode, 200)
    t.assert.strictEqual(response.headers['content-type'], 'text/event-stream')
    t.assert.strictEqual(response.headers['x-accel-buffering'], 'no')

    const stream = response.stream()
    const first = await new Promise<string>((resolve) => {
      stream.once('data', (chunk: Buffer) => resolve(chunk.toString()))
    })
    stream.destroy()

    const message = JSON.parse(first.replace(/^data: /, '').trim())
    t.assert.strictEqual(message.method, 'notifications/subscriptions/acknowledged')
    t.assert.strictEqual(message.params._meta['io.modelcontextprotocol/subscriptionId'], 7)
    t.assert.deepStrictEqual(message.params.notifications, {
      toolsListChanged: true,
      resourceSubscriptions: ['file:///a']
    })
  })

  test('a notification type the server cannot honour is dropped from the acknowledgement', async (t: TestContext) => {
    const app = await buildServer(t, undefined, { capabilities: { tools: { listChanged: true }, resources: {} } })

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payloadAsStream: true,
      headers: modernHeaders('subscriptions/listen'),
      payload: modernBody('subscriptions/listen', {
        id: 1,
        params: {
          notifications: { toolsListChanged: true, promptsListChanged: true, resourceSubscriptions: ['file:///a'] }
        }
      })
    })

    const stream = response.stream()
    const first = await new Promise<string>((resolve) => {
      stream.once('data', (chunk: Buffer) => resolve(chunk.toString()))
    })
    stream.destroy()

    const message = JSON.parse(first.replace(/^data: /, '').trim())
    // No prompts capability, and resources without `subscribe`, so neither
    // opt-in is acknowledged.
    t.assert.deepStrictEqual(message.params.notifications, { toolsListChanged: true })
  })

  test('a broadcast reaches a subscribed stream, tagged with its subscription id', async (t: TestContext) => {
    const app = await buildServer(t, undefined, { capabilities: emitting })

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payloadAsStream: true,
      headers: modernHeaders('subscriptions/listen'),
      payload: modernBody('subscriptions/listen', {
        id: 'sub-1',
        params: { notifications: { toolsListChanged: true } }
      })
    })

    const stream = response.stream()
    const messages: any[] = []
    stream.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n\n')) {
        const trimmed = line.replace(/^data: /, '').trim()
        if (trimmed) messages.push(JSON.parse(trimmed))
      }
    })

    // Wait for the acknowledgement before broadcasting.
    await new Promise((resolve) => setTimeout(resolve, 50))
    await app.mcpBroadcastNotification({
      jsonrpc: JSONRPC_VERSION,
      method: 'notifications/tools/list_changed'
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    stream.destroy()

    const notification = messages.find(m => m.method === 'notifications/tools/list_changed')
    t.assert.ok(notification, 'expected the broadcast to arrive on the stream')
    t.assert.strictEqual(notification.params._meta['io.modelcontextprotocol/subscriptionId'], 'sub-1')
  })

  test('a notification the stream did not opt into is not delivered', async (t: TestContext) => {
    const app = await buildServer(t, undefined, { capabilities: emitting })

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payloadAsStream: true,
      headers: modernHeaders('subscriptions/listen'),
      payload: modernBody('subscriptions/listen', {
        id: 1,
        params: { notifications: { toolsListChanged: true } }
      })
    })

    const stream = response.stream()
    const messages: any[] = []
    stream.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n\n')) {
        const trimmed = line.replace(/^data: /, '').trim()
        if (trimmed) messages.push(JSON.parse(trimmed))
      }
    })

    await new Promise((resolve) => setTimeout(resolve, 50))
    await app.mcpBroadcastNotification({
      jsonrpc: JSONRPC_VERSION,
      method: 'notifications/prompts/list_changed'
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    stream.destroy()

    t.assert.strictEqual(messages.filter(m => m.method === 'notifications/prompts/list_changed').length, 0)
  })
})

describe('2026-07-28: tasks extension', () => {
  const tasksCapable: ClientCapabilities = { extensions: { [TASKS_EXTENSION]: {} } }

  async function taskServer (t: TestContext, resolve: () => Promise<string>) {
    return await buildServer(t, (app) => {
      app.mcpAddTool({
        name: 'slow',
        inputSchema: Type.Object({}),
        execution: { taskSupport: 'required' }
      } as any, async () => ({ content: [{ type: 'text', text: await resolve() }] }))
    }, { enableTasks: true })
  }

  test('the extension is advertised on server/discover', async (t: TestContext) => {
    const app = await taskServer(t, async () => 'done')

    const result = (await call(app, 'server/discover')).json().result
    t.assert.deepStrictEqual(result.capabilities.extensions[TASKS_EXTENSION], {})
    // The 2025-11-25 core capability has no meaning here.
    t.assert.strictEqual(result.capabilities.tasks, undefined)
  })

  test('a task-augmented call returns a task handle', async (t: TestContext) => {
    const app = await taskServer(t, async () => 'done')

    const result = (await call(app, 'tools/call', {
      params: { name: 'slow', arguments: {} },
      capabilities: tasksCapable
    })).json().result

    t.assert.strictEqual(result.resultType, 'task')
    t.assert.strictEqual(result.status, 'working')
    t.assert.strictEqual(typeof result.taskId, 'string')
    t.assert.strictEqual(typeof result.ttlMs, 'number')
    t.assert.strictEqual(typeof result.pollIntervalMs, 'number')
  })

  test('tasks/get polls to completion and inlines the result', async (t: TestContext) => {
    const app = await taskServer(t, async () => 'done')

    const created = (await call(app, 'tools/call', {
      params: { name: 'slow', arguments: {} },
      capabilities: tasksCapable
    })).json().result

    let task: any
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25))
      task = (await call(app, 'tasks/get', {
        params: { taskId: created.taskId },
        capabilities: tasksCapable
      })).json().result
      if (task.status !== 'working') break
    }

    t.assert.strictEqual(task.resultType, 'complete')
    t.assert.strictEqual(task.status, 'completed')
    t.assert.strictEqual(task.result.content[0].text, 'done')
  })

  test('a client that did not declare the extension cannot use tasks/*', async (t: TestContext) => {
    const app = await taskServer(t, async () => 'done')

    const response = await call(app, 'tasks/get', { params: { taskId: 'whatever' } })
    t.assert.strictEqual(response.json().error.code, MISSING_REQUIRED_CLIENT_CAPABILITY)
  })

  test('a tool requiring tasks refuses a client without the extension', async (t: TestContext) => {
    const app = await taskServer(t, async () => 'done')

    const response = await call(app, 'tools/call', { params: { name: 'slow', arguments: {} } })
    const error = response.json().error
    t.assert.strictEqual(error.code, MISSING_REQUIRED_CLIENT_CAPABILITY)
    t.assert.deepStrictEqual(error.data.requiredCapabilities, { extensions: { [TASKS_EXTENSION]: {} } })
  })

  test('custom upstream authentication isolates task ownership', async (t: TestContext) => {
    let release: (value: string) => void = () => {}
    const pending = new Promise<string>((resolve) => { release = resolve })
    const app = Fastify()
    t.after(async () => {
      release('done')
      await app.close()
    })
    app.addHook('preHandler', async (request) => {
      ;(request as any).upstreamUserId = request.headers['x-auth-user']
    })
    await app.register(mcpPlugin, {
      enableTasks: true,
      resolveAuthorizationContext: (request) => {
        const userId = (request as any).upstreamUserId
        return typeof userId === 'string' ? { userId } : undefined
      }
    })
    app.mcpAddTool({
      name: 'private-task',
      inputSchema: Type.Object({}),
      execution: { taskSupport: 'required' }
    } as any, async () => ({ content: [{ type: 'text', text: await pending }] }))
    await app.ready()

    const created = (await call(app, 'tools/call', {
      params: { name: 'private-task', arguments: {} },
      capabilities: tasksCapable,
      headers: { 'x-auth-user': 'user-a' }
    })).json().result

    const rejectedGet = await call(app, 'tasks/get', {
      params: { taskId: created.taskId },
      capabilities: tasksCapable,
      headers: { 'x-auth-user': 'user-b' }
    })
    t.assert.strictEqual(rejectedGet.json().error.code, INVALID_PARAMS)

    const rejectedCancel = await call(app, 'tasks/cancel', {
      params: { taskId: created.taskId },
      capabilities: tasksCapable,
      headers: { 'x-auth-user': 'user-b' }
    })
    t.assert.strictEqual(rejectedCancel.json().error.code, INVALID_PARAMS)

    const ownerGet = await call(app, 'tasks/get', {
      params: { taskId: created.taskId },
      capabilities: tasksCapable,
      headers: { 'x-auth-user': 'user-a' }
    })
    t.assert.strictEqual(ownerGet.json().result.taskId, created.taskId)
  })

  test('tasks/cancel acknowledges and settles the task', async (t: TestContext) => {
    let release: (value: string) => void = () => {}
    const pending = new Promise<string>((resolve) => { release = resolve })
    const app = await taskServer(t, () => pending)

    const created = (await call(app, 'tools/call', {
      params: { name: 'slow', arguments: {} },
      capabilities: tasksCapable
    })).json().result

    const cancelled = await call(app, 'tasks/cancel', {
      params: { taskId: created.taskId },
      capabilities: tasksCapable
    })
    t.assert.strictEqual(cancelled.json().result.resultType, 'complete')

    const task = (await call(app, 'tasks/get', {
      params: { taskId: created.taskId },
      capabilities: tasksCapable
    })).json().result
    t.assert.strictEqual(task.status, 'cancelled')

    release('done')
  })

  test('a task needing input parks in input_required and resumes via tasks/update', async (t: TestContext) => {
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({
        name: 'confirm',
        inputSchema: Type.Object({}),
        execution: { taskSupport: 'required' }
      } as any, async (_args: any, context: any) => {
        const answer = context.inputResponses?.ok as { content?: { name?: string } } | undefined
        if (!answer) {
          throw new InputRequired({
            inputRequests: {
              ok: elicitForm('Confirm?', {
                type: 'object',
                properties: { name: { type: 'string' } },
                required: ['name']
              })
            }
          })
        }
        return { content: [{ type: 'text', text: `confirmed by ${answer.content?.name}` }] }
      })
    }, { enableTasks: true })

    const capabilities: ClientCapabilities = {
      extensions: { [TASKS_EXTENSION]: {} },
      elicitation: { form: {} }
    }

    const created = (await call(app, 'tools/call', {
      params: { name: 'confirm', arguments: {} },
      capabilities
    })).json().result
    t.assert.strictEqual(created.resultType, 'task')

    // Poll until the task reports what it needs.
    let task: any
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25))
      task = (await call(app, 'tasks/get', {
        params: { taskId: created.taskId },
        capabilities
      })).json().result
      if (task.status === 'input_required') break
    }
    t.assert.strictEqual(task.status, 'input_required')
    t.assert.strictEqual(task.inputRequests.ok.method, 'elicitation/create')

    const updated = await call(app, 'tasks/update', {
      params: {
        taskId: created.taskId,
        inputResponses: { ok: { action: 'accept', content: { name: 'octocat' } } }
      },
      capabilities
    })
    t.assert.strictEqual(updated.json().result.resultType, 'complete')

    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25))
      task = (await call(app, 'tasks/get', {
        params: { taskId: created.taskId },
        capabilities
      })).json().result
      if (task.status === 'completed') break
    }

    t.assert.strictEqual(task.status, 'completed')
    t.assert.strictEqual(task.result.content[0].text, 'confirmed by octocat')
    // The outstanding request is cleared once it has been answered.
    t.assert.strictEqual(task.inputRequests, undefined)
  })

  test('cancelling an input-blocked task reaches its owner', async (t: TestContext) => {
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({
        name: 'blocked',
        inputSchema: Type.Object({}),
        execution: { taskSupport: 'required' }
      } as any, async () => {
        throw new InputRequired({
          inputRequests: {
            confirmation: elicitForm('Confirm?', { type: 'object', properties: {} })
          }
        })
      })
    }, { enableTasks: true })
    const capabilities: ClientCapabilities = {
      extensions: { [TASKS_EXTENSION]: {} },
      elicitation: { form: {} }
    }

    const created = (await call(app, 'tools/call', {
      params: { name: 'blocked', arguments: {} },
      capabilities
    })).json().result

    let task: any
    for (let attempt = 0; attempt < 40; attempt++) {
      task = (await call(app, 'tasks/get', {
        params: { taskId: created.taskId },
        capabilities
      })).json().result
      if (task.status === 'input_required') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }

    const cancelled = await call(app, 'tasks/cancel', {
      params: { taskId: created.taskId },
      capabilities
    })
    t.assert.strictEqual(cancelled.json().result.resultType, 'complete')
    task = (await call(app, 'tasks/get', {
      params: { taskId: created.taskId },
      capabilities
    })).json().result
    t.assert.strictEqual(task.status, 'cancelled')
  })

  test('a task fails rather than ambiguously reusing an input key', async (t: TestContext) => {
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({
        name: 'repeat-key',
        inputSchema: Type.Object({}),
        execution: { taskSupport: 'required' }
      } as any, async () => {
        throw new InputRequired({
          inputRequests: {
            confirmation: elicitForm('Confirm?', {
              type: 'object',
              properties: { value: { type: 'string' } }
            })
          }
        })
      })
    }, { enableTasks: true })
    const capabilities: ClientCapabilities = {
      extensions: { [TASKS_EXTENSION]: {} },
      elicitation: { form: {} }
    }

    const created = (await call(app, 'tools/call', {
      params: { name: 'repeat-key', arguments: {} },
      capabilities
    })).json().result

    let task: any
    for (let attempt = 0; attempt < 40; attempt++) {
      task = (await call(app, 'tasks/get', {
        params: { taskId: created.taskId },
        capabilities
      })).json().result
      if (task.status === 'input_required') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }

    await call(app, 'tasks/update', {
      params: {
        taskId: created.taskId,
        inputResponses: { confirmation: { action: 'accept', content: { value: 'yes' } } }
      },
      capabilities
    })

    for (let attempt = 0; attempt < 40; attempt++) {
      task = (await call(app, 'tasks/get', {
        params: { taskId: created.taskId },
        capabilities
      })).json().result
      if (task.status === 'failed') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    t.assert.strictEqual(task.status, 'failed')
    t.assert.match(task.error.message, /keys must be unique/)
  })

  test('a task fails instead of asking for a capability the client did not declare', async (t: TestContext) => {
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({
        name: 'needs-elicitation',
        inputSchema: Type.Object({}),
        execution: { taskSupport: 'required' }
      } as any, async () => {
        throw new InputRequired({
          inputRequests: {
            ok: elicitForm('Confirm?', { type: 'object', properties: {} })
          }
        })
      })
    }, { enableTasks: true })

    // Tasks, but no elicitation.
    const created = (await call(app, 'tools/call', {
      params: { name: 'needs-elicitation', arguments: {} },
      capabilities: tasksCapable
    })).json().result
    t.assert.strictEqual(created.resultType, 'task')

    const seen: string[] = []
    let task: any
    for (let attempt = 0; attempt < 40; attempt++) {
      task = (await call(app, 'tasks/get', {
        params: { taskId: created.taskId },
        capabilities: tasksCapable
      })).json().result
      seen.push(task.status)
      if (task.status === 'failed') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }

    t.assert.strictEqual(task.status, 'failed')
    t.assert.ok(!seen.includes('input_required'), 'the task must never park an unanswerable request')
    t.assert.strictEqual(task.inputRequests, undefined)
    t.assert.match(task.error.message, /client capability that was not declared/)
  })

  test('input rounds share the task ttl instead of each getting a fresh one', async (t: TestContext) => {
    const ttl = 2000
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({
        name: 'two-rounds',
        inputSchema: Type.Object({}),
        execution: { taskSupport: 'required' }
      } as any, async (_args: any, context: any) => {
        const key = context.inputResponses?.first ? 'second' : 'first'
        if (context.inputResponses?.second) return { content: [{ type: 'text', text: 'done' }] }
        throw new InputRequired({
          inputRequests: { [key]: elicitForm('Again?', { type: 'object', properties: {} }) }
        })
      })
    }, { enableTasks: true, taskDefaultTtlMs: ttl })
    const capabilities: ClientCapabilities = {
      extensions: { [TASKS_EXTENSION]: {} },
      elicitation: { form: {} }
    }

    // Only the task input wait arms an AbortSignal.timeout.
    const timeouts: number[] = []
    const original = AbortSignal.timeout.bind(AbortSignal)
    t.mock.method(AbortSignal, 'timeout', (ms: number) => {
      timeouts.push(ms)
      return original(ms)
    })

    const created = (await call(app, 'tools/call', {
      params: { name: 'two-rounds', arguments: {} },
      capabilities
    })).json().result

    async function waitForRequest (key: string) {
      for (let attempt = 0; attempt < 40; attempt++) {
        const task = (await call(app, 'tasks/get', {
          params: { taskId: created.taskId },
          capabilities
        })).json().result
        if (task.status === 'input_required' && task.inputRequests?.[key]) return
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      t.assert.fail(`task never asked for ${key}`)
    }

    await waitForRequest('first')
    const elapsed = 300
    await new Promise(resolve => setTimeout(resolve, elapsed))
    await call(app, 'tasks/update', {
      params: { taskId: created.taskId, inputResponses: { first: { action: 'accept', content: {} } } },
      capabilities
    })
    await waitForRequest('second')

    t.assert.strictEqual(timeouts.length, 2)
    t.assert.ok(timeouts[0] <= ttl)
    t.assert.ok(timeouts[1] <= ttl - elapsed, `second round waited ${timeouts[1]}ms, past the task expiry`)
  })

  test('a resumed task gets back the state it saved before asking for input', async (t: TestContext) => {
    const seen: unknown[] = []
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({
        name: 'stateful',
        inputSchema: Type.Object({}),
        execution: { taskSupport: 'required' }
      } as any, async (_args: any, context: any) => {
        seen.push(context.requestState)
        if (!context.inputResponses?.ok) {
          throw new InputRequired({
            inputRequests: { ok: elicitForm('Confirm?', { type: 'object', properties: {} }) },
            state: { step: 2, cart: [] }
          })
        }
        return { content: [{ type: 'text', text: 'done' }] }
      })
    }, { enableTasks: true })
    const capabilities: ClientCapabilities = {
      extensions: { [TASKS_EXTENSION]: {} },
      elicitation: { form: {} }
    }

    const created = (await call(app, 'tools/call', {
      params: { name: 'stateful', arguments: {} },
      capabilities
    })).json().result

    let task: any
    for (let attempt = 0; attempt < 40; attempt++) {
      task = (await call(app, 'tasks/get', { params: { taskId: created.taskId }, capabilities })).json().result
      if (task.status === 'input_required') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    await call(app, 'tasks/update', {
      params: { taskId: created.taskId, inputResponses: { ok: { action: 'accept', content: {} } } },
      capabilities
    })
    for (let attempt = 0; attempt < 40; attempt++) {
      task = (await call(app, 'tasks/get', { params: { taskId: created.taskId }, capabilities })).json().result
      if (task.status === 'completed') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }

    t.assert.strictEqual(task.status, 'completed')
    t.assert.deepStrictEqual(seen, [undefined, { step: 2, cart: [] }])
  })

  test('task input survives a broker publication that never reaches the worker', async (t: TestContext) => {
    // The broker accepts the first publication but drops it, as it would if
    // the owning instance's subscriber were reconnecting.
    const originalPublish = MemoryMessageBroker.prototype.publish
    let dropped = 0
    t.mock.method(MemoryMessageBroker.prototype, 'publish', async function (this: MemoryMessageBroker, topic: string, message: any) {
      if (topic === TASK_INPUT_TOPIC && dropped === 0) {
        dropped++
        return
      }
      return await originalPublish.call(this, topic, message)
    })

    const app = await buildServer(t, (app) => {
      app.mcpAddTool({
        name: 'confirm',
        inputSchema: Type.Object({}),
        execution: { taskSupport: 'required' }
      } as any, async (_args: any, context: any) => {
        if (!context.inputResponses?.ok) {
          throw new InputRequired({
            inputRequests: { ok: elicitForm('Confirm?', { type: 'object', properties: {} }) }
          })
        }
        return { content: [{ type: 'text', text: 'confirmed' }] }
      })
    }, { enableTasks: true })
    const capabilities: ClientCapabilities = {
      extensions: { [TASKS_EXTENSION]: {} },
      elicitation: { form: {} }
    }

    const created = (await call(app, 'tools/call', {
      params: { name: 'confirm', arguments: {} },
      capabilities
    })).json().result

    let task: any
    for (let attempt = 0; attempt < 40; attempt++) {
      task = (await call(app, 'tasks/get', { params: { taskId: created.taskId }, capabilities })).json().result
      if (task.status === 'input_required') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }

    const updated = await call(app, 'tasks/update', {
      params: { taskId: created.taskId, inputResponses: { ok: { action: 'accept', content: {} } } },
      capabilities
    })
    t.assert.strictEqual(updated.json().result.resultType, 'complete')
    t.assert.strictEqual(dropped, 1)

    // No client retry: the worker finds the answer in the task store.
    for (let attempt = 0; attempt < 60; attempt++) {
      task = (await call(app, 'tasks/get', { params: { taskId: created.taskId }, capabilities })).json().result
      if (task.status === 'completed') break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    t.assert.strictEqual(task.status, 'completed')
    t.assert.strictEqual(task.result.content[0].text, 'confirmed')
  })

  test('tasks/* are absent when tasks are not enabled', async (t: TestContext) => {
    const app = await buildServer(t)

    const response = await call(app, 'tasks/get', {
      params: { taskId: 'x' },
      capabilities: tasksCapable
    })
    t.assert.strictEqual(response.json().error.code, METHOD_NOT_FOUND)
  })
})

describe('2026-07-28: message and transport validation', () => {
  test('a modern batch body is rejected, not accepted as a notification', async (t: TestContext) => {
    const app = await buildServer(t)
    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: modernHeaders('tools/list'),
      payload: [modernBody('tools/list')]
    })
    t.assert.strictEqual(response.statusCode, 400)
    t.assert.strictEqual(response.json().error.code, INVALID_REQUEST)
    t.assert.match(response.json().error.message, /Batch/)
  })

  test('malformed JSON-RPC messages are invalid requests', async (t: TestContext) => {
    const app = await buildServer(t)
    const cases: Array<[string, unknown]> = [
      ['null id', { ...modernBody('tools/list'), id: null }],
      ['object id', { ...modernBody('tools/list'), id: { a: 1 } }],
      ['fractional id', { ...modernBody('tools/list'), id: 1.5 }],
      ['missing jsonrpc', { ...modernBody('tools/list'), jsonrpc: undefined }],
      ['missing method', { ...modernBody('tools/list'), method: undefined }],
      ['response-shaped body', { jsonrpc: JSONRPC_VERSION, result: {} }],
      ['null body', null]
    ]
    for (const [label, payload] of cases) {
      const response = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: modernHeaders('tools/list'),
        payload: JSON.stringify(payload)
      })
      t.assert.strictEqual(response.statusCode, 400, label)
      t.assert.strictEqual(response.json().error.code, INVALID_REQUEST, label)
    }
  })

  test('an unknown version is reported before the 2026 required fields', async (t: TestContext) => {
    const app = await buildServer(t)
    const body = modernBody('tools/list', { protocolVersion: '2099-01-01' }) as any
    delete body.params._meta[META_CLIENT_CAPABILITIES]

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: modernHeaders('tools/list', { protocolVersion: '2099-01-01' }),
      payload: body
    })
    t.assert.strictEqual(response.statusCode, 400)
    t.assert.strictEqual(response.json().error.code, UNSUPPORTED_PROTOCOL_VERSION)
    t.assert.deepStrictEqual(response.json().error.data.supported, SUPPORTED_PROTOCOL_VERSIONS)
  })

  test('subscriptions/listen refuses a legacy version like every other method', async (t: TestContext) => {
    const app = await buildServer(t)
    const response = await call(app, 'subscriptions/listen', {
      protocolVersion: LATEST_LEGACY_PROTOCOL_VERSION,
      params: { notifications: { toolsListChanged: true } }
    })
    t.assert.strictEqual(response.statusCode, 400)
    t.assert.strictEqual(response.json().error.code, UNSUPPORTED_PROTOCOL_VERSION)
  })

  test('a malformed listen filter is invalid params', async (t: TestContext) => {
    const app = await buildServer(t)
    const response = await call(app, 'subscriptions/listen', {
      params: { notifications: { resourceSubscriptions: 'file:///a' } }
    })
    t.assert.strictEqual(response.statusCode, 400)
    t.assert.strictEqual(response.json().error.code, INVALID_PARAMS)
  })

  test('raw non-ASCII bytes in mirrored headers are rejected', async (t: TestContext) => {
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({
        name: 'café',
        inputSchema: Type.Object({ s: Type.String({ 'x-mcp-header': 'S' } as any) })
      }, async () => ({ content: [{ type: 'text', text: 'must not run' }] }))
      app.mcpAddTool({
        name: 'echo',
        inputSchema: Type.Object({ s: Type.String({ 'x-mcp-header': 'S' } as any) })
      }, async () => ({ content: [{ type: 'text', text: 'must not run' }] }))
    })

    // Node hands bytes 0x80-0xFF through as latin1, so 'caf\xe9' would
    // otherwise compare equal to 'café'.
    const name = await call(app, 'tools/call', {
      params: { name: 'café', arguments: { s: 'x' } },
      headers: { 'mcp-name': 'caf\xe9', 'mcp-param-s': 'x' }
    })
    t.assert.strictEqual(name.statusCode, 400)
    t.assert.strictEqual(name.json().error.code, HEADER_MISMATCH)
    t.assert.match(name.json().error.message, /invalid characters/)

    const param = await call(app, 'tools/call', {
      params: { name: 'echo', arguments: { s: 'naïve' } },
      headers: { 'mcp-param-s': 'na\xefve' }
    })
    t.assert.strictEqual(param.statusCode, 400)
    t.assert.match(param.json().error.message, /invalid characters/)
  })

  test('integer header values must be plain decimal', async (t: TestContext) => {
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({
        name: 'count',
        inputSchema: Type.Object({ n: Type.Integer({ 'x-mcp-header': 'N' } as any) })
      }, async () => ({ content: [{ type: 'text', text: 'ran' }] }))
    })
    const send = (n: number, header: string) => call(app, 'tools/call', {
      params: { name: 'count', arguments: { n } },
      headers: { 'mcp-param-n': header }
    })

    for (const header of ['0x2A', '4.2e1', ' 42', '+42']) {
      t.assert.strictEqual((await send(42, header)).json().error?.code, HEADER_MISMATCH, header)
    }
    t.assert.strictEqual((await send(0, '')).json().error?.code, HEADER_MISMATCH)
    t.assert.strictEqual((await send(42, '42')).json().result.content[0].text, 'ran')
    t.assert.strictEqual((await send(42, '42.0')).json().result.content[0].text, 'ran')
  })

  test('a forged stdio marker does not skip header validation over HTTP', async (t: TestContext) => {
    const app = await buildServer(t)
    const response = await call(app, 'tools/list', {
      headers: { 'mcp-protocol-version': undefined, 'x-platformatic-mcp-stdio-trust': 'guess' }
    })
    t.assert.strictEqual(response.statusCode, 400)
    t.assert.strictEqual(response.json().error.code, HEADER_MISMATCH)
  })

  test('2026-07-28 works over stdio, which has no header layer', async (t: TestContext) => {
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({ name: 'greet', inputSchema: Type.Object({}) }, async () => ({
        content: [{ type: 'text', text: 'hi' }]
      }))
    })
    const input = new PassThrough()
    const output = new PassThrough()
    const transport = createStdioTransport(app, { input, output, error: new PassThrough() })
    transport.start()
    t.after(() => transport.stop())

    const lines: any[] = []
    output.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) if (line.trim()) lines.push(JSON.parse(line))
    })
    async function send (body: unknown) {
      const before = lines.length
      input.write(JSON.stringify(body) + '\n')
      for (let attempt = 0; attempt < 100 && lines.length === before; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      return lines[before]
    }

    const discovered = await send(modernBody('server/discover', { id: 1 }))
    t.assert.strictEqual(discovered.result.resultType, 'complete')
    t.assert.ok(discovered.result.supportedVersions.includes(LATEST_PROTOCOL_VERSION))

    const called = await send(modernBody('tools/call', { id: 2, params: { name: 'greet', arguments: {} } }))
    t.assert.strictEqual(called.result.content[0].text, 'hi')
  })
})

describe('dual-era: both protocols on one endpoint', () => {
  test('a legacy client still completes the handshake', async (t: TestContext) => {
    const app = await buildServer(t)

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: LATEST_LEGACY_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'legacy', version: '1.0.0' }
        }
      }
    })

    t.assert.strictEqual(response.statusCode, 200)
    t.assert.strictEqual(response.json().result.protocolVersion, LATEST_LEGACY_PROTOCOL_VERSION)
  })

  test('legacy and modern requests interleave on the same server', async (t: TestContext) => {
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({ name: 'greet', inputSchema: Type.Object({}) }, async () => ({
        content: [{ type: 'text', text: 'hi' }]
      }))
    })

    const legacy = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: { jsonrpc: JSONRPC_VERSION, id: 1, method: 'tools/list', params: {} }
    })
    const modern = await call(app, 'tools/list', { id: 2 })

    // Same tool, two envelopes.
    t.assert.strictEqual(legacy.json().result.tools[0].name, 'greet')
    t.assert.strictEqual(legacy.json().result.resultType, undefined)
    t.assert.strictEqual(modern.json().result.tools[0].name, 'greet')
    t.assert.strictEqual(modern.json().result.resultType, 'complete')
  })

  test('a modern GET cannot open a legacy SSE session', async (t: TestContext) => {
    const app = await buildServer(t, undefined, { enableSSE: true })

    const response = await app.inject({
      method: 'GET',
      url: '/mcp',
      headers: {
        accept: 'text/event-stream',
        'mcp-protocol-version': LATEST_PROTOCOL_VERSION
      }
    })

    t.assert.strictEqual(response.statusCode, 405)
    t.assert.strictEqual(response.headers.allow, 'POST')
    t.assert.strictEqual(response.headers['mcp-session-id'], undefined)
  })

  test('a modern DELETE cannot terminate a legacy session', async (t: TestContext) => {
    const app = await buildServer(t, undefined, { enableSSE: true })

    const initialized = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: LATEST_LEGACY_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'legacy', version: '1.0.0' }
        }
      }
    })
    const sessionId = initialized.headers['mcp-session-id'] as string
    t.assert.ok(sessionId)

    const modernDelete = await app.inject({
      method: 'DELETE',
      url: '/mcp',
      headers: {
        'mcp-session-id': sessionId,
        'mcp-protocol-version': LATEST_PROTOCOL_VERSION
      }
    })
    t.assert.strictEqual(modernDelete.statusCode, 405)
    t.assert.strictEqual(modernDelete.headers.allow, 'POST')

    // The legacy session is untouched and can still be terminated by its owner.
    const legacyDelete = await app.inject({
      method: 'DELETE',
      url: '/mcp',
      headers: { 'mcp-session-id': sessionId }
    })
    t.assert.strictEqual(legacyDelete.statusCode, 204)
  })

  test('a modern request ignores a stray Mcp-Session-Id', async (t: TestContext) => {
    const app = await buildServer(t, undefined, { enableSSE: true })

    const response = await call(app, 'tools/list', {
      headers: { 'mcp-session-id': 'some-old-session' }
    })

    t.assert.strictEqual(response.statusCode, 200)
    t.assert.strictEqual(response.headers['mcp-session-id'], undefined)
    t.assert.strictEqual(response.json().result.resultType, 'complete')
  })
})
