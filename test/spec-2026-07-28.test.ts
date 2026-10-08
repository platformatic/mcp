import { test, describe } from 'node:test'
import { PassThrough } from 'node:stream'
import type { TestContext } from 'node:test'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { Type } from '@sinclair/typebox'
import mcpPlugin from '../src/index.ts'
import { createStdioTransport } from '../src/stdio.ts'
import { MemoryTaskStore } from '../src/stores/memory-task-store.ts'
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
  INVALID_REQUEST,
  INTERNAL_ERROR
} from '../src/schema.ts'
import {
  META_PROTOCOL_VERSION,
  META_CLIENT_INFO,
  META_CLIENT_CAPABILITIES,
  META_SERVER_INFO,
  TASKS_EXTENSION
} from '../src/schema-2026.ts'
import { InputRequired, elicitForm, elicitUrl, requestSampling } from '../src/modern/input-required.ts'
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
      requestStateSecret: 'shared-test-secret'.padEnd(32, '-'),
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

describe('2026-07-28: input requests and results are validated', () => {
  function askingTool (app: FastifyInstance, inputRequests: Record<string, unknown>, seen: unknown[] = []) {
    app.mcpAddTool({ name: 'ask', inputSchema: Type.Object({}) }, async (_args: any, context: any) => {
      if (!context.requestState) throw new InputRequired({ inputRequests: inputRequests as any, state: { step: 1 } })
      seen.push(context.inputResponses)
      return { content: [{ type: 'text', text: 'done' }] }
    })
  }

  test('form elicitation is refused for a client that declared only URL mode', async (t: TestContext) => {
    const app = await buildServer(t, (app) => askingTool(app, {
      q: elicitForm('Name?', { type: 'object', properties: { name: { type: 'string' } } })
    }))

    const urlOnly = await call(app, 'tools/call', {
      params: { name: 'ask', arguments: {} },
      capabilities: { elicitation: { url: {} } }
    })
    t.assert.strictEqual(urlOnly.json().error.code, MISSING_REQUIRED_CLIENT_CAPABILITY)
    t.assert.deepStrictEqual(urlOnly.json().error.data.requiredCapabilities, { elicitation: { form: {} } })

    // An empty object is the backwards-compatible declaration of form mode.
    const legacyForm = await call(app, 'tools/call', {
      params: { name: 'ask', arguments: {} },
      capabilities: { elicitation: {} }
    })
    t.assert.strictEqual(legacyForm.json().result.resultType, 'input_required')
  })

  test('sampling with tools or context needs the matching sub-capability', async (t: TestContext) => {
    const app = await buildServer(t, (app) => askingTool(app, {
      s: requestSampling({
        messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }],
        maxTokens: 10,
        includeContext: 'thisServer',
        tools: [{ name: 't', inputSchema: { type: 'object' } }]
      } as any)
    }))

    const response = await call(app, 'tools/call', {
      params: { name: 'ask', arguments: {} },
      capabilities: { sampling: {} }
    })
    t.assert.strictEqual(response.json().error.code, MISSING_REQUIRED_CLIENT_CAPABILITY)
    t.assert.deepStrictEqual(response.json().error.data.requiredCapabilities, {
      sampling: { tools: {}, context: {} }
    })
  })

  test('input requests the protocol cannot carry are never forwarded', async (t: TestContext) => {
    for (const inputRequests of [
      { q: { method: 'tools/call', params: { name: 'x' } } },
      { q: elicitUrl('Sign in', 'not a url') }
    ]) {
      const app = await buildServer(t, (app) => askingTool(app, inputRequests))
      const response = await call(app, 'tools/call', {
        params: { name: 'ask', arguments: {} },
        capabilities: { elicitation: { form: {}, url: {} } }
      })
      t.assert.strictEqual(response.json().error.code, INTERNAL_ERROR)
      t.assert.strictEqual(response.json().error.data, undefined)
    }
  })

  test('only answers to keys the server asked for reach the handler', async (t: TestContext) => {
    const seen: unknown[] = []
    const app = await buildServer(t, (app) => askingTool(app, {
      q: elicitForm('Name?', { type: 'object', properties: { name: { type: 'string' } } })
    }, seen))
    const capabilities = { elicitation: { form: {} } }
    const params = { name: 'ask', arguments: {} }

    const first = (await call(app, 'tools/call', { params, capabilities })).json().result
    const retry = await call(app, 'tools/call', {
      id: 2,
      capabilities,
      params: {
        ...params,
        requestState: first.requestState,
        inputResponses: { q: { action: 'accept', content: { name: 'a' } }, unasked: { injected: true } }
      }
    })
    t.assert.strictEqual(retry.json().result.resultType, 'complete')
    t.assert.deepStrictEqual(seen, [{ q: { action: 'accept', content: { name: 'a' } } }])

    // Without sealed state there is nothing the server asked for.
    const app2 = await buildServer(t, (app) => app.mcpAddTool({ name: 'peek', inputSchema: Type.Object({}) },
      async (_args: any, context: any) => ({ content: [{ type: 'text', text: JSON.stringify(context.inputResponses ?? null) }] })))
    const stateless = await call(app2, 'tools/call', {
      params: { name: 'peek', arguments: {}, inputResponses: { forged: { action: 'accept' } } }
    })
    t.assert.strictEqual(stateless.json().result.content[0].text, '{}')
  })

  test('inputResponses that is not an object is invalid params', async (t: TestContext) => {
    const app = await buildServer(t, (app) => askingTool(app, {}))
    for (const inputResponses of ['a string', [1, 2], 42]) {
      const response = await call(app, 'tools/call', {
        params: { name: 'ask', arguments: {}, inputResponses }
      })
      t.assert.strictEqual(response.json().error.code, INVALID_PARAMS, JSON.stringify(inputResponses))
    }
  })

  test('state is bound to the OAuth client, not just the user', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())
    await app.register(mcpPlugin, {
      resolveAuthorizationContext: (request) => ({
        userId: 'same-user',
        clientId: request.headers['x-client'] as string
      })
    })
    askingTool(app, { q: elicitForm('Name?', { type: 'object', properties: {} }) })
    await app.ready()

    const capabilities = { elicitation: { form: {} } }
    const params = { name: 'ask', arguments: {} }
    const first = (await call(app, 'tools/call', { params, capabilities, headers: { 'x-client': 'client-a' } })).json().result
    const other = await call(app, 'tools/call', {
      id: 2,
      capabilities,
      headers: { 'x-client': 'client-b' },
      params: { ...params, requestState: first.requestState, inputResponses: { q: { action: 'accept', content: {} } } }
    })
    t.assert.strictEqual(other.json().error.code, INVALID_PARAMS)
    t.assert.match(other.json().error.message, /different principal/)
  })

  test('an unidentified caller needing input gets a correlated error, not a bare 500', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())
    await app.register(mcpPlugin, { resolveAuthorizationContext: () => undefined })
    askingTool(app, { q: elicitForm('Name?', { type: 'object', properties: {} }) })
    await app.ready()

    const response = await call(app, 'tools/call', {
      id: 'correlated',
      params: { name: 'ask', arguments: {} },
      capabilities: { elicitation: { form: {} } }
    })
    t.assert.strictEqual(response.json().id, 'correlated')
    t.assert.strictEqual(response.json().error.code, INVALID_REQUEST)
  })

  test('a handler cannot override the resultType envelope', async (t: TestContext) => {
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({ name: 'sneaky', inputSchema: Type.Object({}) }, async () => ({
        content: [{ type: 'text', text: 'x' }],
        resultType: 'input_required'
      }) as any)
    })
    const response = await call(app, 'tools/call', { params: { name: 'sneaky', arguments: {} } })
    t.assert.strictEqual(response.json().result.resultType, 'complete')
  })

  test('a failed resources/read is an error, never cacheable content', async (t: TestContext) => {
    const app = await buildServer(t, (app) => {
      app.mcpAddResource({ uriPattern: 'file:///broken' }, async () => {
        throw new Error('db down')
      })
    }, { caching: { resourcesRead: { ttlMs: 60000, cacheScope: 'public' } } })

    const response = await call(app, 'resources/read', { params: { uri: 'file:///broken' } })
    t.assert.strictEqual(response.json().error.code, INTERNAL_ERROR)
    t.assert.strictEqual(response.json().result, undefined)
  })

  test('tools/call arguments must be an object', async (t: TestContext) => {
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({ name: 'greet', inputSchema: Type.Object({}) }, async () => ({ content: [] }))
    })
    for (const args of ['str', ['x'], 5]) {
      const response = await call(app, 'tools/call', { params: { name: 'greet', arguments: args } })
      t.assert.strictEqual(response.json().error.code, INVALID_PARAMS, JSON.stringify(args))
    }
  })

  test('server/discover does not advertise what this path cannot serve', async (t: TestContext) => {
    const app = await buildServer(t, undefined, {
      capabilities: { tools: {}, completions: {}, logging: {} }
    })
    const capabilities = (await call(app, 'server/discover')).json().result.capabilities
    t.assert.strictEqual(capabilities.completions, undefined)
    // Logging is served on the request's own stream.
    t.assert.deepStrictEqual(capabilities.logging, {})
  })

  test('a legacy request never leaks InputRequired state in error data', async (t: TestContext) => {
    const app = await buildServer(t, (app) => askingTool(app, {
      q: elicitForm('Name?', { type: 'object', properties: {} })
    }))
    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: { jsonrpc: JSONRPC_VERSION, id: 1, method: 'tools/call', params: { name: 'ask', arguments: {} } }
    })
    const body = response.json()
    t.assert.strictEqual(body.error.code, INTERNAL_ERROR)
    t.assert.strictEqual(body.error.data, undefined)
    t.assert.doesNotMatch(response.body, /step/)
  })
})

describe('tool output and configuration are validated', () => {
  const outputSchema = {
    type: 'object',
    properties: { n: { type: 'number' } },
    required: ['n']
  }

  async function outputServer (t: TestContext, result: Record<string, unknown>, schema: unknown = outputSchema) {
    return await buildServer(t, (app) => {
      app.mcpAddTool({
        name: 'typed',
        inputSchema: { type: 'object' },
        outputSchema: schema
      } as any, async () => result as any)
    })
  }

  test('structuredContent that matches outputSchema is returned unchanged', async (t: TestContext) => {
    const app = await outputServer(t, { content: [], structuredContent: { n: 1, extra: [] } })
    const result = (await call(app, 'tools/call', { params: { name: 'typed', arguments: {} } })).json().result
    t.assert.strictEqual(result.isError, undefined)
    t.assert.deepStrictEqual(result.structuredContent, { n: 1, extra: [] })
  })

  test('structuredContent that violates outputSchema becomes a tool error', async (t: TestContext) => {
    for (const result of [
      { content: [], structuredContent: { n: 'not-a-number' } },
      { content: [{ type: 'text', text: 'forgot it' }] }
    ]) {
      const app = await outputServer(t, result)
      const response = (await call(app, 'tools/call', { params: { name: 'typed', arguments: {} } })).json().result
      t.assert.strictEqual(response.isError, true, JSON.stringify(result))
      t.assert.match(response.content[0].text, /does not match its output schema/)
      t.assert.strictEqual(response.structuredContent, undefined)
    }
  })

  test('TypeBox output schemas are enforced too, and error results are exempt', async (t: TestContext) => {
    const bad = await outputServer(t, { content: [], structuredContent: { n: 'x' } }, Type.Object({ n: Type.Number() }))
    t.assert.strictEqual((await call(bad, 'tools/call', { params: { name: 'typed', arguments: {} } })).json().result.isError, true)

    const failed = await outputServer(t, { content: [{ type: 'text', text: 'boom' }], isError: true })
    const result = (await call(failed, 'tools/call', { params: { name: 'typed', arguments: {} } })).json().result
    t.assert.strictEqual(result.content[0].text, 'boom')
  })

  test('structuredContent is validated as the JSON the client receives', async (t: TestContext) => {
    const when = new Date('2026-10-06T00:00:00Z')
    const app = await outputServer(t, { content: [], structuredContent: { when } }, {
      type: 'object',
      properties: { when: { type: 'string' } },
      required: ['when']
    })
    const result = (await call(app, 'tools/call', { params: { name: 'typed', arguments: {} } })).json().result
    t.assert.strictEqual(result.isError, undefined)
    t.assert.strictEqual(result.structuredContent.when, when.toISOString())
  })

  test('outputSchema is not enforced on revisions without structuredContent', async (t: TestContext) => {
    const app = await outputServer(t, { content: [{ type: 'text', text: 'plain' }] })
    for (const protocolVersion of ['2025-03-26', '2024-11-05']) {
      const init = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload: {
          jsonrpc: JSONRPC_VERSION,
          id: 1,
          method: 'initialize',
          params: { protocolVersion, capabilities: {}, clientInfo: { name: 'old', version: '1' } }
        }
      })
      t.assert.strictEqual(init.json().result.protocolVersion, protocolVersion)
      const response = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: protocolVersion === '2024-11-05' ? {} : { 'mcp-protocol-version': protocolVersion },
        payload: { jsonrpc: JSONRPC_VERSION, id: 2, method: 'tools/call', params: { name: 'typed', arguments: {} } }
      })
      const result = response.json().result
      t.assert.strictEqual(result.isError, undefined, protocolVersion)
      t.assert.strictEqual(result.content[0].text, 'plain', protocolVersion)
    }
  })

  test('an outputSchema in an unsupported dialect is refused at registration', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())
    await app.register(mcpPlugin)
    t.assert.throws(() => app.mcpAddTool({
      name: 'draft7',
      inputSchema: { type: 'object' },
      outputSchema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object' }
    } as any, async () => ({ content: [] })), /dialect .* is not supported/)
  })

  test('caching hints must be a non-negative integer ttl and a known scope', async (t: TestContext) => {
    for (const hint of [{ ttlMs: 1500.5, cacheScope: 'private' }, { ttlMs: NaN, cacheScope: 'private' },
      { ttlMs: -1, cacheScope: 'private' }, { ttlMs: 1000, cacheScope: 'shared' }]) {
      const app = Fastify()
      t.after(() => app.close())
      await t.assert.rejects(async () => {
        await app.register(mcpPlugin, { caching: { toolsList: hint as any } }).ready()
      }, /caching\.toolsList/)
    }
  })
})

describe('2026-07-28: MRTR retries are not cacheable', () => {
  test('a retry carrying requestState or inputResponses is marked uncacheable', async (t: TestContext) => {
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
    // cached — a `public` hint here would leak it through a shared proxy. A
    // complete result still MUST carry hints, so they say exactly that.
    t.assert.strictEqual(retry.ttlMs, 0)
    t.assert.strictEqual(retry.cacheScope, 'private')
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

describe('defaults, startup checks and smaller fixes', () => {
  test('default capabilities declare listChanged, so listen acknowledges list changes', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())
    await app.register(mcpPlugin)
    app.mcpSetResourceSubscribeHandler(async () => ({}))
    await app.ready()

    const capabilities = (await call(app, 'server/discover')).json().result.capabilities
    t.assert.strictEqual(capabilities.tools.listChanged, true)
    t.assert.strictEqual(capabilities.prompts.listChanged, true)
    t.assert.strictEqual(capabilities.resources.listChanged, true)
    t.assert.strictEqual(capabilities.resources.subscribe, true)
  })

  test('redis without requestStateSecret is refused at startup', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())
    await t.assert.rejects(async () => {
      await app.register(mcpPlugin, { redis: { host: '127.0.0.1', port: 1, lazyConnect: true } as any }).ready()
    }, /requestStateSecret is required/)
  })

  test('a public cache hint with per-caller results logs a warning', async (t: TestContext) => {
    const lines: string[] = []
    const app = Fastify({ logger: { level: 'warn', stream: { write: (line: string) => { lines.push(line) } } } })
    t.after(() => app.close())
    await app.register(mcpPlugin, {
      canAccessTool: () => true,
      caching: { toolsList: { ttlMs: 1000, cacheScope: 'public' } }
    })
    await app.ready()
    t.assert.ok(lines.some(line => line.includes('cacheScope') && line.includes('toolsList')))
  })

  test('a nullable x-mcp-header parameter keeps the tool available', async (t: TestContext) => {
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({
        name: 'regional',
        inputSchema: {
          type: 'object',
          properties: { region: { type: ['string', 'null'], 'x-mcp-header': 'Region' } }
        }
      } as any, async (args: any) => ({ content: [{ type: 'text', text: String(args.region) }] }))
    })
    const listed = (await call(app, 'tools/list')).json().result.tools
    t.assert.deepStrictEqual(listed.map((tool: any) => tool.name), ['regional'])

    const withValue = await call(app, 'tools/call', {
      params: { name: 'regional', arguments: { region: 'eu' } },
      headers: { 'mcp-param-region': 'eu' }
    })
    t.assert.strictEqual(withValue.json().result.content[0].text, 'eu')
    // A null value carries no header.
    const withNull = await call(app, 'tools/call', { id: 2, params: { name: 'regional', arguments: { region: null } } })
    t.assert.strictEqual(withNull.json().result.content[0].text, 'null')
  })

  test('a failed resources/read does not reveal the handler error', async (t: TestContext) => {
    const app = await buildServer(t, (app) => {
      app.mcpAddResource({ uriPattern: 'file:///secret' }, async () => {
        throw new Error('connection to db.internal:5432 refused')
      })
    })
    const response = await call(app, 'resources/read', { params: { uri: 'file:///secret' } })
    t.assert.strictEqual(response.json().error.message, 'Resource read failed')
  })

  test('tasks/update succeeds once stored, even when its publication fails', async (t: TestContext) => {
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({
        name: 'confirm',
        inputSchema: Type.Object({}),
        execution: { taskSupport: 'required' }
      } as any, async (_args: any, context: any) => {
        if (!context.inputResponses?.ok) {
          throw new InputRequired({ inputRequests: { ok: elicitForm('Ok?', { type: 'object', properties: {} }) } })
        }
        return { content: [{ type: 'text', text: 'confirmed' }] }
      })
    }, { enableTasks: true })
    const capabilities: ClientCapabilities = { extensions: { [TASKS_EXTENSION]: {} }, elicitation: { form: {} } }
    t.mock.method(MemoryMessageBroker.prototype, 'publish', async function (this: MemoryMessageBroker, topic: string, message: any) {
      if (topic === TASK_INPUT_TOPIC) throw new Error('broker down')
      return await (MemoryMessageBroker.prototype.publish as any).mock.original.call(this, topic, message)
    })

    const created = (await call(app, 'tools/call', { params: { name: 'confirm', arguments: {} }, capabilities })).json().result
    for (let attempt = 0; attempt < 50; attempt++) {
      const task = (await call(app, 'tasks/get', { params: { taskId: created.taskId }, capabilities })).json().result
      if (task.status === 'input_required') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const updated = await call(app, 'tasks/update', {
      params: { taskId: created.taskId, inputResponses: { ok: { action: 'accept', content: {} } } },
      capabilities
    })
    t.assert.strictEqual(updated.json().result.resultType, 'complete')

    let task: any
    for (let attempt = 0; attempt < 60; attempt++) {
      task = (await call(app, 'tasks/get', { params: { taskId: created.taskId }, capabilities })).json().result
      if (task.status === 'completed') break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    t.assert.strictEqual(task.status, 'completed')
  })
})

describe('2026-07-28: per-caller and global limits', () => {
  const tasksCapable: ClientCapabilities = { extensions: { [TASKS_EXTENSION]: {} } }

  test('one caller cannot take every task slot', async (t: TestContext) => {
    let release: () => void = () => {}
    const blocked = new Promise<void>(resolve => { release = resolve })
    const app = Fastify()
    t.after(() => app.close())
    await app.register(mcpPlugin, {
      enableTasks: true,
      taskMaxPerPrincipal: 1,
      taskShutdownTimeoutMs: 10,
      resolveAuthorizationContext: (request) => ({ userId: request.headers['x-user'] as string })
    })
    app.mcpAddTool({
      name: 'busy',
      inputSchema: Type.Object({}),
      execution: { taskSupport: 'required' }
    } as any, async () => {
      await blocked
      return { content: [] }
    })
    await app.ready()
    t.after(() => release())

    const as = (user: string, id: number) => call(app, 'tools/call', {
      id, params: { name: 'busy', arguments: {} }, capabilities: tasksCapable, headers: { 'x-user': user }
    })
    t.assert.strictEqual((await as('mallory', 1)).json().result.resultType, 'task')
    t.assert.strictEqual((await as('mallory', 2)).json().error.code, INVALID_REQUEST)
    t.assert.strictEqual((await as('alice', 3)).json().result.resultType, 'task')
  })

  test('listen streams are limited per caller, with HTTP 429', async (t: TestContext) => {
    const app = await buildServer(t, undefined, {
      capabilities: { tools: { listChanged: true } },
      subscriptionMaxStreamsPerPrincipal: 1,
      resolveAuthorizationContext: (request: any) => ({ userId: request.headers['x-user'], clientId: request.headers['x-client'] })
    })
    const open = (id: number, user: string, client: string) => app.inject({
      method: 'POST',
      url: '/mcp',
      payloadAsStream: true,
      headers: { ...modernHeaders('subscriptions/listen'), 'x-user': user, 'x-client': client },
      payload: modernBody('subscriptions/listen', { id, params: { notifications: { toolsListChanged: true } } })
    })
    const first = await open(1, 'mallory', 'app-1')
    t.assert.strictEqual(first.statusCode, 200)
    // Another OAuth client of the same user shares the same allowance.
    const second = await open(2, 'mallory', 'app-2')
    t.assert.strictEqual(second.statusCode, 429)
    const other = await open(3, 'alice', 'app-1')
    t.assert.strictEqual(other.statusCode, 200)
    for (const response of [first, second, other]) response.stream().destroy()
  })

  test('unidentified callers are bounded by the global stream limit only', async (t: TestContext) => {
    const app = await buildServer(t, undefined, {
      capabilities: { tools: { listChanged: true } },
      subscriptionMaxStreamsPerPrincipal: 1,
      subscriptionMaxStreams: 2
    })
    const open = (id: number) => app.inject({
      method: 'POST',
      url: '/mcp',
      payloadAsStream: true,
      headers: modernHeaders('subscriptions/listen'),
      payload: modernBody('subscriptions/listen', { id, params: { notifications: { toolsListChanged: true } } })
    })
    const responses = [await open(1), await open(2), await open(3)]
    t.assert.deepStrictEqual(responses.map(response => response.statusCode), [200, 200, 429])
    for (const response of responses) response.stream().destroy()
  })

  test('a listen stream may name only so many resource URIs', async (t: TestContext) => {
    const app = await buildServer(t, undefined, {
      capabilities: { resources: { subscribe: true } },
      subscriptionMaxResourceUris: 2
    })
    const response = await call(app, 'subscriptions/listen', {
      params: { notifications: { resourceSubscriptions: ['a:1', 'a:2', 'a:3'] } }
    })
    t.assert.strictEqual(response.statusCode, 400)
    t.assert.strictEqual(response.json().error.code, INVALID_PARAMS)
  })

  test('a full memory store keeps unread results and refuses new tasks', async (t: TestContext) => {
    const store = new MemoryTaskStore(2)
    const now = new Date().toISOString()
    const base = { createdAt: now, lastUpdatedAt: now, ttl: 60_000, method: 'tools/call' }
    await store.create({ ...base, taskId: 'done', status: 'completed' })
    await store.create({ ...base, taskId: 'running', status: 'working' })
    await t.assert.rejects(store.create({ ...base, taskId: 'new', status: 'working' }), /Task limit reached/)
    // Nobody else's task creation can delete a finished result before its ttl.
    t.assert.strictEqual((await store.get('done'))?.status, 'completed')

    // Expired tasks still make room.
    const old = new Date(Date.now() - 120_000).toISOString()
    const expiring = new MemoryTaskStore(1)
    await expiring.create({ ...base, createdAt: old, taskId: 'stale', status: 'completed' })
    await expiring.create({ ...base, taskId: 'fresh', status: 'working' })
    t.assert.ok(await expiring.get('fresh'))
  })

  test('legacy tasks count against the same limits', async (t: TestContext) => {
    let release: () => void = () => {}
    const blocked = new Promise<void>(resolve => { release = resolve })
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({
        name: 'slow',
        inputSchema: Type.Object({}),
        execution: { taskSupport: 'optional' }
      } as any, async () => {
        await blocked
        return { content: [] }
      })
    }, { enableTasks: true, enableSSE: true, taskMaxConcurrent: 1, taskShutdownTimeoutMs: 10 })
    t.after(() => release())

    const init = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'initialize',
        params: { protocolVersion: LATEST_LEGACY_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'l', version: '1' } }
      }
    })
    const legacyTask = (id: number) => app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'mcp-session-id': init.headers['mcp-session-id'] as string,
        'mcp-protocol-version': LATEST_LEGACY_PROTOCOL_VERSION
      },
      payload: { jsonrpc: JSONRPC_VERSION, id, method: 'tools/call', params: { name: 'slow', arguments: {}, task: { ttl: 60_000 } } }
    })
    t.assert.ok((await legacyTask(2)).json().result.task, 'the first legacy task is created')
    t.assert.match((await legacyTask(3)).json().error.message, /Task limit reached/)
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

  async function pollTask (app: FastifyInstance, taskId: string, capabilities: ClientCapabilities,
    until: (task: any) => boolean): Promise<any> {
    let task: any
    for (let attempt = 0; attempt < 100; attempt++) {
      task = (await call(app, 'tasks/get', { params: { taskId }, capabilities })).json().result
      if (until(task)) return task
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    return task
  }

  test('a handler re-asking under the same key gets a fresh wire key', async (t: TestContext) => {
    const seen: unknown[] = []
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({
        name: 'insist',
        inputSchema: Type.Object({}),
        execution: { taskSupport: 'required' }
      } as any, async (_args: any, context: any) => {
        const answer = context.inputResponses?.confirmation as { action?: string } | undefined
        seen.push(answer?.action)
        // Re-prompt under the same key until the user accepts.
        if (answer?.action !== 'accept') {
          throw new InputRequired({
            inputRequests: { confirmation: elicitForm('Confirm?', { type: 'object', properties: {} }) }
          })
        }
        return { content: [{ type: 'text', text: 'accepted' }] }
      })
    }, { enableTasks: true })
    const capabilities: ClientCapabilities = {
      extensions: { [TASKS_EXTENSION]: {} },
      elicitation: { form: {} }
    }

    const created = (await call(app, 'tools/call', {
      params: { name: 'insist', arguments: {} },
      capabilities
    })).json().result

    let task = await pollTask(app, created.taskId, capabilities, t => t.status === 'input_required')
    t.assert.deepStrictEqual(Object.keys(task.inputRequests), ['confirmation'])
    await call(app, 'tasks/update', {
      params: { taskId: created.taskId, inputResponses: { confirmation: { action: 'decline' } } },
      capabilities
    })

    // Same question again, under a key the client has never answered.
    task = await pollTask(app, created.taskId, capabilities,
      t => t.status === 'input_required' && !t.inputRequests.confirmation)
    const [retryKey] = Object.keys(task.inputRequests)
    t.assert.notStrictEqual(retryKey, 'confirmation')
    await call(app, 'tasks/update', {
      params: { taskId: created.taskId, inputResponses: { [retryKey]: { action: 'accept' } } },
      capabilities
    })

    task = await pollTask(app, created.taskId, capabilities, t => t.status === 'completed')
    t.assert.strictEqual(task.status, 'completed')
    t.assert.strictEqual(task.result.content[0].text, 'accepted')
    t.assert.deepStrictEqual(seen, [undefined, 'decline', 'accept'])
  })

  test('a task resumes only once every key of the round is answered', async (t: TestContext) => {
    const seen: string[][] = []
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({
        name: 'pair',
        inputSchema: Type.Object({}),
        execution: { taskSupport: 'required' }
      } as any, async (_args: any, context: any) => {
        const responses = context.inputResponses ?? {}
        seen.push(Object.keys(responses).sort())
        if (!responses.a || !responses.b) {
          throw new InputRequired({
            inputRequests: {
              a: elicitForm('A?', { type: 'object', properties: {} }),
              b: elicitForm('B?', { type: 'object', properties: {} })
            }
          })
        }
        return { content: [{ type: 'text', text: 'both' }] }
      })
    }, { enableTasks: true })
    const capabilities: ClientCapabilities = {
      extensions: { [TASKS_EXTENSION]: {} },
      elicitation: { form: {} }
    }

    const created = (await call(app, 'tools/call', {
      params: { name: 'pair', arguments: {} },
      capabilities
    })).json().result
    await pollTask(app, created.taskId, capabilities, t => t.status === 'input_required')

    await call(app, 'tasks/update', {
      params: { taskId: created.taskId, inputResponses: { a: { action: 'accept', content: {} } } },
      capabilities
    })
    // Still waiting for b, which is all it now asks for.
    let task = await pollTask(app, created.taskId, capabilities, t => t.status === 'input_required')
    t.assert.deepStrictEqual(Object.keys(task.inputRequests), ['b'])
    t.assert.deepStrictEqual(seen, [[]])

    await call(app, 'tasks/update', {
      params: { taskId: created.taskId, inputResponses: { b: { action: 'accept', content: {} } } },
      capabilities
    })
    task = await pollTask(app, created.taskId, capabilities, t => t.status === 'completed')
    t.assert.strictEqual(task.status, 'completed')
    t.assert.deepStrictEqual(seen, [[], ['a', 'b']])
    // The prompt of the last round does not linger on the finished task.
    t.assert.strictEqual(task.statusMessage, undefined)
    // The result carries the same envelope a synchronous call returns.
    t.assert.strictEqual(task.result.resultType, 'complete')
    t.assert.ok(task.result._meta['io.modelcontextprotocol/serverInfo'])
  })

  test('a fully answered task reports working, not input_required with nothing to ask', async (t: TestContext) => {
    let release: () => void = () => {}
    const blocked = new Promise<void>(resolve => { release = resolve })
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({
        name: 'slow-after-input',
        inputSchema: Type.Object({}),
        execution: { taskSupport: 'required' }
      } as any, async (_args: any, context: any) => {
        if (!context.inputResponses?.ok) {
          throw new InputRequired({ inputRequests: { ok: elicitForm('Ok?', { type: 'object', properties: {} }) } })
        }
        await blocked
        return { content: [] }
      })
    }, { enableTasks: true, taskShutdownTimeoutMs: 10 })
    t.after(() => release())
    const capabilities: ClientCapabilities = {
      extensions: { [TASKS_EXTENSION]: {} },
      elicitation: { form: {} }
    }

    const created = (await call(app, 'tools/call', {
      params: { name: 'slow-after-input', arguments: {} },
      capabilities
    })).json().result
    await pollTask(app, created.taskId, capabilities, t => t.status === 'input_required')
    await call(app, 'tasks/update', {
      params: { taskId: created.taskId, inputResponses: { ok: { action: 'accept', content: {} } } },
      capabilities
    })

    const task = (await call(app, 'tasks/get', { params: { taskId: created.taskId }, capabilities })).json().result
    t.assert.strictEqual(task.status, 'working')
    t.assert.strictEqual(task.inputRequests, undefined)
  })

  test('a state-only InputRequired resumes the task at once with its state', async (t: TestContext) => {
    const seen: unknown[] = []
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({
        name: 'stepper',
        inputSchema: Type.Object({}),
        execution: { taskSupport: 'required' }
      } as any, async (_args: any, context: any) => {
        seen.push(context.requestState)
        const step = (context.requestState as { step?: number } | undefined)?.step ?? 0
        if (step < 2) throw new InputRequired({ state: { step: step + 1 } })
        return { content: [{ type: 'text', text: `step ${step}` }] }
      })
    }, { enableTasks: true })

    const created = (await call(app, 'tools/call', {
      params: { name: 'stepper', arguments: {} },
      capabilities: tasksCapable
    })).json().result
    const task = await pollTask(app, created.taskId, tasksCapable, t => t.status === 'completed')
    t.assert.strictEqual(task.result.content[0].text, 'step 2')
    t.assert.deepStrictEqual(seen, [undefined, { step: 1 }, { step: 2 }])
  })

  test('legacy and modern tasks/* only see tasks of their own era', async (t: TestContext) => {
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({
        name: 'parked',
        inputSchema: Type.Object({}),
        execution: { taskSupport: 'required' }
      } as any, async () => {
        throw new InputRequired({ inputRequests: { ok: elicitForm('Ok?', { type: 'object', properties: {} }) } })
      })
    }, { enableTasks: true, enableSSE: true, taskShutdownTimeoutMs: 10 })
    const capabilities: ClientCapabilities = {
      extensions: { [TASKS_EXTENSION]: {} },
      elicitation: { form: {} }
    }
    const created = (await call(app, 'tools/call', {
      params: { name: 'parked', arguments: {} },
      capabilities
    })).json().result
    await pollTask(app, created.taskId, capabilities, t => t.status === 'input_required')

    const init = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'initialize',
        params: { protocolVersion: LATEST_LEGACY_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'l', version: '1' } }
      }
    })
    const legacy = (method: string) => app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'mcp-session-id': init.headers['mcp-session-id'] as string,
        'mcp-protocol-version': LATEST_LEGACY_PROTOCOL_VERSION
      },
      payload: { jsonrpc: JSONRPC_VERSION, id: 2, method, params: { taskId: created.taskId } }
    })
    for (const method of ['tasks/get', 'tasks/cancel']) {
      t.assert.strictEqual((await legacy(method)).json().error.code, INVALID_PARAMS, method)
    }
    // Still running and answerable on its own era.
    const task = (await call(app, 'tasks/get', { params: { taskId: created.taskId }, capabilities })).json().result
    t.assert.strictEqual(task.status, 'input_required')
  })

  test('another OAuth client of the same user cannot see or answer the task', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())
    await app.register(mcpPlugin, {
      enableTasks: true,
      taskShutdownTimeoutMs: 10,
      resolveAuthorizationContext: (request) => ({ userId: 'alice', clientId: request.headers['x-client'] as string })
    })
    app.mcpAddTool({
      name: 'approve',
      inputSchema: Type.Object({}),
      execution: { taskSupport: 'required' }
    } as any, async () => {
      throw new InputRequired({ inputRequests: { ok: elicitForm('Approve?', { type: 'object', properties: {} }) } })
    })
    await app.ready()
    const capabilities: ClientCapabilities = {
      extensions: { [TASKS_EXTENSION]: {} },
      elicitation: { form: {} }
    }
    const as = (client: string) => ({ capabilities, headers: { 'x-client': client } })

    const created = (await call(app, 'tools/call', {
      params: { name: 'approve', arguments: {} }, ...as('trusted-app')
    })).json().result
    for (let attempt = 0; attempt < 50; attempt++) {
      const task = (await call(app, 'tasks/get', { params: { taskId: created.taskId }, ...as('trusted-app') })).json().result
      if (task.status === 'input_required') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }

    const read = await call(app, 'tasks/get', { params: { taskId: created.taskId }, ...as('evil-app') })
    t.assert.strictEqual(read.json().error.code, INVALID_PARAMS)
    const answer = await call(app, 'tasks/update', {
      params: { taskId: created.taskId, inputResponses: { ok: { action: 'accept', content: {} } } },
      ...as('evil-app')
    })
    t.assert.strictEqual(answer.json().error.code, INVALID_PARAMS)
    const still = (await call(app, 'tasks/get', { params: { taskId: created.taskId }, ...as('trusted-app') })).json().result
    t.assert.strictEqual(still.status, 'input_required')
  })

  test('a task whose worker stops renewing its lease is reported failed', async (t: TestContext) => {
    let release: () => void = () => {}
    const blocked = new Promise<void>(resolve => { release = resolve })
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({
        name: 'orphan',
        inputSchema: Type.Object({}),
        execution: { taskSupport: 'required' }
      } as any, async () => {
        await blocked
        return { content: [] }
      })
    }, { enableTasks: true, taskLeaseMs: 60, taskShutdownTimeoutMs: 10 })
    t.after(() => release())

    const created = (await call(app, 'tools/call', {
      params: { name: 'orphan', arguments: {} },
      capabilities: tasksCapable
    })).json().result
    // The worker "dies": it stops renewing, as a crashed instance would.
    t.mock.method(MemoryTaskStore.prototype, 'renewLease', async () => 'working')

    const task = await pollTask(app, created.taskId, tasksCapable, t => t.status === 'failed')
    t.assert.strictEqual(task.status, 'failed')
    t.assert.match(task.error.message, /stopped before it finished/)
  })

  test('closing the server records running and parked tasks as failed, not timed out', async (t: TestContext) => {
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({
        name: 'long',
        inputSchema: Type.Object({}),
        execution: { taskSupport: 'required' }
      } as any, async (_args: any, context: any) => {
        await new Promise((_resolve, reject) => {
          context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true })
        })
        return { content: [] }
      })
      app.mcpAddTool({
        name: 'parked',
        inputSchema: Type.Object({}),
        execution: { taskSupport: 'required' }
      } as any, async () => {
        throw new InputRequired({ inputRequests: { ok: elicitForm('Ok?', { type: 'object', properties: {} }) } })
      })
    }, { enableTasks: true, taskShutdownTimeoutMs: 50 })
    const capabilities: ClientCapabilities = {
      extensions: { [TASKS_EXTENSION]: {} },
      elicitation: { form: {} }
    }

    const recorded = new Map<string, string | null | undefined>()
    const original = MemoryTaskStore.prototype.updateStatus
    t.mock.method(MemoryTaskStore.prototype, 'updateStatus', async function (this: MemoryTaskStore, taskId: string, status: any, options: any) {
      if (status === 'failed') recorded.set(taskId, options?.statusMessage)
      return await original.call(this, taskId, status, options)
    })

    const running = (await call(app, 'tools/call', { params: { name: 'long', arguments: {} }, capabilities })).json().result
    const parked = (await call(app, 'tools/call', { id: 2, params: { name: 'parked', arguments: {} }, capabilities })).json().result
    await pollTask(app, parked.taskId, capabilities, t => t.status === 'input_required')

    await app.close()
    t.assert.match(recorded.get(running.taskId) ?? '', /shut down/)
    t.assert.match(recorded.get(parked.taskId) ?? '', /shut down/)
  })

  test('a handler still running at its ttl is aborted and frees its slot', async (t: TestContext) => {
    let reason: unknown
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({
        name: 'hang',
        inputSchema: Type.Object({}),
        execution: { taskSupport: 'optional' }
      } as any, async (args: any, context: any) => {
        if (!args.hang) return { content: [] }
        await new Promise(resolve => context.signal.addEventListener('abort', resolve, { once: true }))
        reason = context.signal.reason
        return { content: [] }
      })
    }, { enableTasks: true, taskMaxConcurrent: 1, taskDefaultTtlMs: 100, taskShutdownTimeoutMs: 10 })

    const first = (await call(app, 'tools/call', {
      params: { name: 'hang', arguments: { hang: true } }, capabilities: tasksCapable
    })).json().result
    t.assert.strictEqual(first.resultType, 'task')
    await new Promise(resolve => setTimeout(resolve, 200))
    t.assert.match(String((reason as Error)?.message), /expired/)

    const next = (await call(app, 'tools/call', {
      id: 2, params: { name: 'hang', arguments: {} }, capabilities: tasksCapable
    })).json().result
    t.assert.strictEqual(next.resultType, 'task')
  })

  test('concurrent calls cannot exceed taskMaxConcurrent while the store is slow', async (t: TestContext) => {
    let release: () => void = () => {}
    const blocked = new Promise<void>(resolve => { release = resolve })
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({
        name: 'busy',
        inputSchema: Type.Object({}),
        execution: { taskSupport: 'required' }
      } as any, async () => {
        await blocked
        return { content: [] }
      })
    }, { enableTasks: true, taskMaxConcurrent: 2, taskShutdownTimeoutMs: 10 })
    t.after(() => release())
    const original = MemoryTaskStore.prototype.create
    t.mock.method(MemoryTaskStore.prototype, 'create', async function (this: MemoryTaskStore, task: any) {
      await new Promise(resolve => setTimeout(resolve, 5))
      return await original.call(this, task)
    })

    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => call(app, 'tools/call', {
      id: i + 1, params: { name: 'busy', arguments: {} }, capabilities: tasksCapable
    }).then(r => r.json().result?.resultType)))
    // Calls over the cap are refused at once, since this tool cannot run
    // synchronously; exactly the cap's worth become tasks.
    t.assert.strictEqual(results.filter(type => type === 'task').length, 2)
  })

  test('with identity resolution, an unidentified caller gets no unreachable task', async (t: TestContext) => {
    let ran = 0
    const app = Fastify()
    t.after(() => app.close())
    await app.register(mcpPlugin, { enableTasks: true, resolveAuthorizationContext: () => undefined })
    app.mcpAddTool({
      name: 'maybe-task',
      inputSchema: Type.Object({}),
      execution: { taskSupport: 'optional' }
    } as any, async () => { ran++; return { content: [{ type: 'text', text: 'sync' }] } })
    app.mcpAddTool({
      name: 'must-task',
      inputSchema: Type.Object({}),
      execution: { taskSupport: 'required' }
    } as any, async () => ({ content: [] }))
    await app.ready()

    const optional = (await call(app, 'tools/call', {
      params: { name: 'maybe-task', arguments: {} },
      capabilities: tasksCapable
    })).json()
    t.assert.strictEqual(optional.result.resultType, 'complete')
    t.assert.strictEqual(optional.result.content[0].text, 'sync')
    t.assert.strictEqual(ran, 1)

    const required = (await call(app, 'tools/call', {
      params: { name: 'must-task', arguments: {} },
      capabilities: tasksCapable
    })).json()
    t.assert.strictEqual(required.error.code, INVALID_REQUEST)
  })

  test('past taskMaxConcurrent, an optional task runs synchronously', async (t: TestContext) => {
    let release: () => void = () => {}
    const blocked = new Promise<void>(resolve => { release = resolve })
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({
        name: 'busy',
        inputSchema: Type.Object({}),
        execution: { taskSupport: 'optional' }
      } as any, async (args: any) => {
        if (args.block) await blocked
        return { content: [{ type: 'text', text: 'done' }] }
      })
    }, { enableTasks: true, taskMaxConcurrent: 1, taskShutdownTimeoutMs: 10 })
    t.after(() => release())

    const first = (await call(app, 'tools/call', {
      params: { name: 'busy', arguments: { block: true } },
      capabilities: tasksCapable
    })).json().result
    t.assert.strictEqual(first.resultType, 'task')

    const second = (await call(app, 'tools/call', {
      id: 2,
      params: { name: 'busy', arguments: {} },
      capabilities: tasksCapable
    })).json().result
    t.assert.strictEqual(second.resultType, 'complete')
  })

  test('tasks/cancel aborts the signal of the handler running the task', async (t: TestContext) => {
    let aborted: Promise<boolean> | undefined
    let started: () => void = () => {}
    const handlerStarted = new Promise<void>(resolve => { started = resolve })
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({
        name: 'long',
        inputSchema: Type.Object({}),
        execution: { taskSupport: 'required' }
      } as any, async (_args: any, context: any) => {
        started()
        aborted = new Promise<boolean>(resolve => {
          context.signal.addEventListener('abort', () => resolve(true), { once: true })
          setTimeout(() => resolve(false), 2000).unref()
        })
        await aborted
        return { content: [] }
      })
    }, { enableTasks: true })

    const created = (await call(app, 'tools/call', {
      params: { name: 'long', arguments: {} },
      capabilities: tasksCapable
    })).json().result
    // The request that created the task has completed; that must not abort it.
    await handlerStarted
    await new Promise(resolve => setTimeout(resolve, 20))

    await call(app, 'tasks/cancel', { params: { taskId: created.taskId }, capabilities: tasksCapable })
    t.assert.strictEqual(await aborted, true)
  })

  test('tools/list does not show execution.taskSupport to 2026-07-28 clients', async (t: TestContext) => {
    const app = await taskServer(t, async () => 'done')
    const tools = (await call(app, 'tools/list')).json().result.tools
    t.assert.strictEqual(tools[0].execution, undefined)
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

describe('2026-07-28: in-process requests', () => {
  test('a completed in-process request does not abort the handler signal', async (t: TestContext) => {
    let signal: AbortSignal | undefined
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({ name: 'quick', inputSchema: Type.Object({}) }, async (_args: any, context: any) => {
        signal = context.signal
        await new Promise(resolve => setTimeout(resolve, 20))
        return { content: [{ type: 'text', text: 'ok' }] }
      })
    })
    const response = await call(app, 'tools/call', { params: { name: 'quick', arguments: {} } })
    t.assert.strictEqual(response.json().result.content[0].text, 'ok')
    await new Promise(resolve => setTimeout(resolve, 50))
    t.assert.strictEqual(signal?.aborted, false)
  })
})

describe('2026-07-28: progress and log notifications', () => {
  function reportingTool (app: FastifyInstance) {
    app.mcpAddTool({ name: 'report', inputSchema: Type.Object({}) }, async (_args: any, context: any) => {
      context.log('debug', 'too chatty')
      context.sendProgress(1, 3, 'one')
      context.sendProgress(1, 3, 'not an increase')
      context.log('warning', { note: 'heads up' }, 'report')
      context.sendProgress(3, 3)
      return { content: [{ type: 'text', text: 'done' }] }
    })
  }

  function frames (body: string): any[] {
    return body.split('\n\n').map(frame => frame.replace(/^data: /, '').trim()).filter(Boolean).map(frame => JSON.parse(frame))
  }

  test('progress and logs stream before the final response', async (t: TestContext) => {
    const app = await buildServer(t, reportingTool)
    const body = modernBody('tools/call', { params: { name: 'report', arguments: {} } }) as any
    body.params._meta.progressToken = 'p1'
    body.params._meta['io.modelcontextprotocol/logLevel'] = 'info'

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: modernHeaders('tools/call', { params: { name: 'report' } }),
      payload: body
    })
    t.assert.strictEqual(response.headers['content-type'], 'text/event-stream')
    const messages = frames(response.body)
    t.assert.deepStrictEqual(messages.map(m => m.method ?? 'response'), [
      'notifications/progress', 'notifications/message', 'notifications/progress', 'response'
    ])
    t.assert.deepStrictEqual(messages[0].params, { progressToken: 'p1', progress: 1, total: 3, message: 'one' })
    t.assert.deepStrictEqual(messages[1].params, { level: 'warning', data: { note: 'heads up' }, logger: 'report' })
    t.assert.strictEqual(messages[3].result.content[0].text, 'done')
  })

  test('without a progressToken or logLevel the response stays plain JSON', async (t: TestContext) => {
    const app = await buildServer(t, reportingTool)
    const response = await call(app, 'tools/call', { params: { name: 'report', arguments: {} } })
    t.assert.match(String(response.headers['content-type']), /application\/json/)
    t.assert.strictEqual(response.json().result.content[0].text, 'done')
  })

  test('progress alone sends no log messages', async (t: TestContext) => {
    const app = await buildServer(t, reportingTool)
    const body = modernBody('tools/call', { params: { name: 'report', arguments: {} } }) as any
    body.params._meta.progressToken = 7
    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: modernHeaders('tools/call', { params: { name: 'report' } }),
      payload: body
    })
    const methods = frames(response.body).map(m => m.method).filter(Boolean)
    t.assert.deepStrictEqual(methods, ['notifications/progress', 'notifications/progress'])
  })
})

describe('2026-07-28 over stdio', () => {
  function stdio (t: TestContext, app: FastifyInstance) {
    const input = new PassThrough()
    const output = new PassThrough()
    const transport = createStdioTransport(app, { input, output, error: new PassThrough() })
    transport.start()
    t.after(() => transport.stop())
    const lines: any[] = []
    let buffered = ''
    output.on('data', (chunk: Buffer) => {
      buffered += chunk.toString()
      const parts = buffered.split('\n')
      buffered = parts.pop() ?? ''
      for (const line of parts) if (line.trim()) lines.push(JSON.parse(line))
    })
    const send = (body: unknown) => input.write(JSON.stringify(body) + '\n')
    const waitFor = async (match: (line: any) => boolean) => {
      for (let attempt = 0; attempt < 200; attempt++) {
        const found = lines.find(match)
        if (found) return found
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      return undefined
    }
    return { input, lines, send, waitFor }
  }

  test('subscriptions/listen streams its acknowledgement and notifications, until cancelled', async (t: TestContext) => {
    const app = await buildServer(t, undefined, { capabilities: { tools: { listChanged: true } } })
    const { lines, send, waitFor } = stdio(t, app)

    send(modernBody('subscriptions/listen', { id: 'L1', params: { notifications: { toolsListChanged: true } } }))
    const ack = await waitFor(line => line.method === 'notifications/subscriptions/acknowledged')
    t.assert.strictEqual(ack?.params._meta['io.modelcontextprotocol/subscriptionId'], 'L1')

    await app.mcpBroadcastNotification({ jsonrpc: JSONRPC_VERSION, method: 'notifications/tools/list_changed' })
    const changed = await waitFor(line => line.method === 'notifications/tools/list_changed')
    t.assert.strictEqual(changed?.params._meta['io.modelcontextprotocol/subscriptionId'], 'L1')

    send({ jsonrpc: JSONRPC_VERSION, method: 'notifications/cancelled', params: { requestId: 'L1' } })
    await new Promise(resolve => setTimeout(resolve, 50))
    const count = lines.length
    await app.mcpBroadcastNotification({ jsonrpc: JSONRPC_VERSION, method: 'notifications/tools/list_changed' })
    await new Promise(resolve => setTimeout(resolve, 50))
    t.assert.strictEqual(lines.length, count, 'nothing more is sent for a cancelled subscription')
    t.assert.ok(!lines.some(line => line.id === 'L1' && line.error), 'no bogus error for the listen request')
  })

  test('notifications/cancelled aborts the handler and suppresses its response', async (t: TestContext) => {
    let aborted = false
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({ name: 'slow', inputSchema: Type.Object({}) }, async (_args: any, context: any) => {
        await new Promise(resolve => {
          context.signal.addEventListener('abort', resolve, { once: true })
          setTimeout(resolve, 1000).unref()
        })
        aborted = context.signal.aborted
        return { content: [{ type: 'text', text: 'done' }] }
      })
    })
    const { lines, send } = stdio(t, app)

    send(modernBody('tools/call', { id: 7, params: { name: 'slow', arguments: {} } }))
    await new Promise(resolve => setTimeout(resolve, 50))
    send({ jsonrpc: JSONRPC_VERSION, method: 'notifications/cancelled', params: { requestId: 7 } })
    await new Promise(resolve => setTimeout(resolve, 100))

    t.assert.strictEqual(aborted, true)
    t.assert.ok(!lines.some(line => line.id === 7), 'no response for a cancelled request')
  })

  test('a modern batch is refused and an unparseable line gets a parse error', async (t: TestContext) => {
    const app = await buildServer(t)
    const { input, send, waitFor } = stdio(t, app)

    send([modernBody('server/discover', { id: 1 }), modernBody('tools/list', { id: 2 })])
    const batch = await waitFor(line => line.error?.code === INVALID_REQUEST)
    t.assert.strictEqual(batch?.id, null)

    input.write('{not json\n')
    const parse = await waitFor(line => line.error?.code === -32700)
    t.assert.strictEqual(parse?.id, null)
  })
})

describe('round 3: robustness of streams, stdio and tasks', () => {
  function stdioHarness (t: TestContext, app: FastifyInstance) {
    const input = new PassThrough()
    const output = new PassThrough()
    const transport = createStdioTransport(app, { input, output, error: new PassThrough() })
    transport.start()
    t.after(() => transport.stop())
    const lines: any[] = []
    let buffered = ''
    output.on('data', (chunk: Buffer) => {
      buffered += chunk.toString()
      const parts = buffered.split('\n')
      buffered = parts.pop() ?? ''
      for (const line of parts) if (line.trim()) lines.push(JSON.parse(line))
    })
    const waitFor = async (match: (line: any) => boolean) => {
      for (let attempt = 0; attempt < 200; attempt++) {
        const found = lines.find(match)
        if (found) return found
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      return undefined
    }
    return { input, lines, waitFor }
  }

  test('stdio answers non-object JSON lines with -32600 and keeps running', async (t: TestContext) => {
    const app = await buildServer(t)
    const { input, lines, waitFor } = stdioHarness(t, app)
    for (const line of ['null', '5', '"x"', 'true', '[]']) input.write(line + '\n')
    input.write('[null]\n')
    for (let attempt = 0; attempt < 100 && lines.length < 6; attempt++) await new Promise(resolve => setTimeout(resolve, 10))
    t.assert.strictEqual(lines.filter(line => line.error?.code === INVALID_REQUEST).length, 5)
    t.assert.ok(lines.some(line => Array.isArray(line) && line[0].error?.code === INVALID_REQUEST))

    input.write(JSON.stringify(modernBody('server/discover', { id: 'alive' })) + '\n')
    t.assert.ok(await waitFor(line => line.id === 'alive' && line.result))
  })

  test('stdio turns a non-JSON-RPC HTTP error into an error for the same id', async (t: TestContext) => {
    const app = Fastify({ bodyLimit: 512 })
    t.after(() => app.close())
    await app.register(mcpPlugin)
    await app.ready()
    const { input, waitFor } = stdioHarness(t, app)
    input.write(JSON.stringify(modernBody('tools/list', { id: 'big', params: { padding: 'x'.repeat(2000) } })) + '\n')
    const answer = await waitFor(line => line.id === 'big')
    t.assert.strictEqual(answer?.jsonrpc, JSONRPC_VERSION)
    t.assert.strictEqual(answer?.error.code, INVALID_REQUEST)
  })

  test('stdio is not subject to HTTP bearer authorization', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())
    await app.register(mcpPlugin, {
      authorization: {
        enabled: true,
        authorizationServers: ['https://auth.example.com'],
        resourceUri: 'https://mcp.example.com',
        tokenValidation: { jwksUri: 'https://auth.example.com/.well-known/jwks.json' }
      }
    } as any)
    await app.ready()
    const { input, waitFor } = stdioHarness(t, app)
    input.write(JSON.stringify(modernBody('server/discover', { id: 1 })) + '\n')
    const answer = await waitFor(line => line.id === 1)
    t.assert.strictEqual(answer?.result.resultType, 'complete')
  })

  test('a stdio listen cancelled before it opens does not leak a stream', async (t: TestContext) => {
    const app = await buildServer(t, undefined, {
      capabilities: { tools: { listChanged: true } },
      subscriptionMaxStreams: 1
    })
    const { input, waitFor } = stdioHarness(t, app)
    for (const id of ['a', 'b', 'c']) {
      input.write(JSON.stringify(modernBody('subscriptions/listen', { id, params: { notifications: { toolsListChanged: true } } })) + '\n' +
        JSON.stringify({ jsonrpc: JSONRPC_VERSION, method: 'notifications/cancelled', params: { requestId: id } }) + '\n')
    }
    await new Promise(resolve => setTimeout(resolve, 100))
    input.write(JSON.stringify(modernBody('subscriptions/listen', { id: 'open', params: { notifications: { toolsListChanged: true } } })) + '\n')
    const ack = await waitFor(line => line.method === 'notifications/subscriptions/acknowledged')
    t.assert.strictEqual(ack?.params._meta['io.modelcontextprotocol/subscriptionId'], 'open')
  })

  test('a notification sent just after the handler returns never hangs the response', async (t: TestContext) => {
    for (let depth = 0; depth <= 12; depth++) {
      const app = await buildServer(t, (app) => {
        app.mcpAddTool({ name: 'late', inputSchema: Type.Object({}) }, async (_args: any, context: any) => {
          ;(async () => {
            for (let i = 0; i < depth; i++) await null
            context.sendProgress(1)
          })()
          return { content: [{ type: 'text', text: 'ok' }] }
        })
      })
      const body = modernBody('tools/call', { params: { name: 'late', arguments: {} } }) as any
      body.params._meta.progressToken = 'p'
      const response = await Promise.race([
        app.inject({ method: 'POST', url: '/mcp', headers: modernHeaders('tools/call', { params: { name: 'late' } }), payload: body }),
        new Promise<'hang'>(resolve => setTimeout(() => resolve('hang'), 1000))
      ])
      t.assert.notStrictEqual(response, 'hang', `depth ${depth}`)
    }
  })

  test('a task cannot take over the response of the request that created it', async (t: TestContext) => {
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({
        name: 'reporting-task',
        inputSchema: Type.Object({}),
        execution: { taskSupport: 'required' }
      } as any, async (_args: any, context: any) => {
        context.sendProgress(1)
        return { content: [] }
      })
    }, { enableTasks: true })
    const body = modernBody('tools/call', {
      params: { name: 'reporting-task', arguments: {} },
      capabilities: { extensions: { [TASKS_EXTENSION]: {} } }
    }) as any
    body.params._meta.progressToken = 'p'
    const response = await app.inject({
      method: 'POST', url: '/mcp', headers: modernHeaders('tools/call', { params: { name: 'reporting-task' } }), payload: body
    })
    t.assert.match(String(response.headers['content-type']), /application\/json/)
    t.assert.strictEqual(response.json().result.resultType, 'task')
  })

  test('an error after progress keeps its HTTP status', async (t: TestContext) => {
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({ name: 'ask', inputSchema: Type.Object({}) }, async (_args: any, context: any) => {
        context.sendProgress(1)
        throw new InputRequired({ inputRequests: { q: elicitForm('Name?', { type: 'object', properties: {} }) } })
      })
    })
    const body = modernBody('tools/call', { params: { name: 'ask', arguments: {} } }) as any
    body.params._meta.progressToken = 'p'
    const response = await app.inject({
      method: 'POST', url: '/mcp', headers: modernHeaders('tools/call', { params: { name: 'ask' } }), payload: body
    })
    t.assert.strictEqual(response.statusCode, 400)
    t.assert.strictEqual(response.json().error.code, MISSING_REQUIRED_CLIENT_CAPABILITY)
  })

  test('a streamed response keeps reply headers and serializes any log data', async (t: TestContext) => {
    const app = await buildServer(t, (app) => {
      app.addHook('onRequest', async (_request, reply) => { reply.header('access-control-allow-origin', '*') })
      app.mcpAddTool({ name: 'chatty', inputSchema: Type.Object({}) }, async (_args: any, context: any) => {
        const circular: any = { a: 1 }
        circular.self = circular
        context.sendProgress(Infinity)
        context.log('info', { big: 10n, error: new Error('boom'), circular })
        context.sendProgress(1)
        return { content: [] }
      })
    })
    const body = modernBody('tools/call', { params: { name: 'chatty', arguments: {} } }) as any
    body.params._meta.progressToken = 'p'
    body.params._meta['io.modelcontextprotocol/logLevel'] = 'info'
    const response = await app.inject({
      method: 'POST', url: '/mcp', headers: modernHeaders('tools/call', { params: { name: 'chatty' } }), payload: body
    })
    t.assert.strictEqual(response.headers['access-control-allow-origin'], '*')
    const frames = response.body.split('\n\n').map(frame => frame.replace(/^data: /, '').trim()).filter(Boolean).map(frame => JSON.parse(frame))
    const log = frames.find(frame => frame.method === 'notifications/message')
    t.assert.deepStrictEqual(log.params.data, { big: '10', error: { name: 'Error', message: 'boom' }, circular: { a: 1, self: '[Circular]' } })
    const progress = frames.filter(frame => frame.method === 'notifications/progress').map(frame => frame.params.progress)
    t.assert.deepStrictEqual(progress, [1])
    t.assert.strictEqual(frames.at(-1).result.resultType, 'complete')
  })

  test('a hung handler past its ttl stops renewing its lease', async (t: TestContext) => {
    let renewals = 0
    const original = MemoryTaskStore.prototype.renewLease
    t.mock.method(MemoryTaskStore.prototype, 'renewLease', async function (this: MemoryTaskStore, taskId: string, leaseMs: number) {
      renewals++
      return await original.call(this, taskId, leaseMs)
    })
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({
        name: 'hang',
        inputSchema: Type.Object({}),
        execution: { taskSupport: 'required' }
      } as any, async () => await new Promise(() => {}))
    }, { enableTasks: true, taskDefaultTtlMs: 100, taskLeaseMs: 30, taskShutdownTimeoutMs: 10 })
    await call(app, 'tools/call', { params: { name: 'hang', arguments: {} }, capabilities: { extensions: { [TASKS_EXTENSION]: {} } } })
    await new Promise(resolve => setTimeout(resolve, 200))
    const afterTtl = renewals
    await new Promise(resolve => setTimeout(resolve, 150))
    t.assert.strictEqual(renewals, afterTtl, 'no renewals after the ttl')
  })

  test('a ttl beyond the timer range does not fail tasks at once', async (t: TestContext) => {
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({
        name: 'quick',
        inputSchema: Type.Object({}),
        execution: { taskSupport: 'required' }
      } as any, async () => {
        await new Promise(resolve => setTimeout(resolve, 50))
        return { content: [{ type: 'text', text: 'done' }] }
      })
    }, { enableTasks: true, taskDefaultTtlMs: 30 * 24 * 3600 * 1000, taskMaxTtlMs: 30 * 24 * 3600 * 1000 })
    const capabilities = { extensions: { [TASKS_EXTENSION]: {} } }
    const created = (await call(app, 'tools/call', { params: { name: 'quick', arguments: {} }, capabilities })).json().result
    let task: any
    for (let attempt = 0; attempt < 50; attempt++) {
      task = (await call(app, 'tasks/get', { params: { taskId: created.taskId }, capabilities })).json().result
      if (task.status !== 'working') break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    t.assert.strictEqual(task.status, 'completed')
  })

  test('a task whose worker never renews is still reaped', async (t: TestContext) => {
    t.mock.method(MemoryTaskStore.prototype, 'renewLease', async () => { throw new Error('store unreachable') })
    let release: () => void = () => {}
    const blocked = new Promise<void>(resolve => { release = resolve })
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({
        name: 'orphan',
        inputSchema: Type.Object({}),
        execution: { taskSupport: 'required' }
      } as any, async () => {
        await blocked
        return { content: [] }
      })
    }, { enableTasks: true, taskLeaseMs: 50, taskShutdownTimeoutMs: 10 })
    t.after(() => release())
    const capabilities = { extensions: { [TASKS_EXTENSION]: {} } }
    const created = (await call(app, 'tools/call', { params: { name: 'orphan', arguments: {} }, capabilities })).json().result
    await new Promise(resolve => setTimeout(resolve, 120))
    const task = (await call(app, 'tasks/get', { params: { taskId: created.taskId }, capabilities })).json().result
    t.assert.strictEqual(task.status, 'failed')
  })

  test('too deeply nested params needing input are invalid params, not an auth error', async (t: TestContext) => {
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({ name: 'ask', inputSchema: { type: 'object' } }, async () => {
        throw new InputRequired({ inputRequests: { q: elicitForm('Name?', { type: 'object', properties: {} }) } })
      })
    })
    let nested: any = {}
    const root = nested
    for (let i = 0; i < 100; i++) { nested.n = {}; nested = nested.n }
    const response = await call(app, 'tools/call', {
      params: { name: 'ask', arguments: {}, extra: root },
      capabilities: { elicitation: { form: {} } }
    })
    t.assert.strictEqual(response.json().error.code, INVALID_PARAMS)
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

  test('Mcp-Method is compared literally, never Base64-decoded', async (t: TestContext) => {
    let ran = false
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({ name: 'greet', inputSchema: Type.Object({}) }, async () => {
        ran = true
        return { content: [] }
      })
    })
    // A gateway routing on the literal header never sees 'tools/call'.
    const response = await call(app, 'tools/call', {
      params: { name: 'greet', arguments: {} },
      headers: { 'mcp-method': '=?base64?dG9vbHMvY2FsbA==?=' }
    })
    t.assert.strictEqual(response.statusCode, 400)
    t.assert.strictEqual(response.json().error.code, HEADER_MISMATCH)
    t.assert.strictEqual(ran, false)
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
