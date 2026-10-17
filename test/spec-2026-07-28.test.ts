import { test, describe } from 'node:test'
import { PassThrough } from 'node:stream'
import type { TestContext } from 'node:test'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { Type } from '@sinclair/typebox'
import mcpPlugin, { isStdioRequest } from '../src/index.ts'
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

  test('a tool with an unreachable x-mcp-header annotation is refused at registration', async (t: TestContext) => {
    // The annotation makes the definition invalid, and 2026-07-28 clients
    // would never see the tool: registration says so instead of hiding it.
    await t.assert.rejects(buildServer(t, (app) => {
      app.mcpAddTool({
        name: 'invalid-header-tool',
        inputSchema: {
          type: 'object',
          allOf: [{ type: 'string', 'x-mcp-header': 'Tenant' }]
        }
      }, async () => ({ content: [{ type: 'text', text: 'must not run' }] }))
    }), /Invalid tool schema for 'invalid-header-tool': x-mcp-header at 'allOf.0' is not statically reachable/)
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
    // Never -32002, which the handshake revisions use and this one forbids;
    // the URI travels in `data`, as resources.md shows
    t.assert.strictEqual(response.json().error.code, INVALID_PARAMS)
    t.assert.deepStrictEqual(response.json().error.data, { uri: 'file:///missing' })
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
    const app = await buildServer(t, (app) => {
      app.mcpSetResourceSubscribeHandler(async () => ({}))
    }, { capabilities: emitting })

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

  test('redis without requestStateSecret warns at startup', async (t: TestContext) => {
    const lines: string[] = []
    const app = Fastify({ logger: { level: 'warn', stream: { write: (line: string) => { lines.push(line) } } } })
    t.after(() => app.close())
    // A legacy-only deployment upgrading keeps starting; only 2026-07-28
    // multi round-trip retries need the shared secret.
    await app.register(mcpPlugin, { redis: { host: '127.0.0.1', port: 1, lazyConnect: true } as any })
    t.assert.ok(lines.some(line => /redis is configured without requestStateSecret/.test(line)), lines.join('\n'))
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

  test('a full memory store evicts finished tasks first and refuses only when all are running', async (t: TestContext) => {
    const store = new MemoryTaskStore(2)
    const now = new Date().toISOString()
    const base = { createdAt: now, lastUpdatedAt: now, ttl: 60_000, method: 'tools/call' }
    await store.create({ ...base, taskId: 'done', status: 'completed' })
    await store.create({ ...base, taskId: 'running', status: 'working' })
    // The finished task makes room; the running one is never dropped.
    await store.create({ ...base, taskId: 'new', status: 'working' })
    t.assert.strictEqual(await store.get('done'), null)
    t.assert.strictEqual((await store.get('running'))?.status, 'working')
    await t.assert.rejects(store.create({ ...base, taskId: 'newer', status: 'working' }), /Task limit reached/)

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
    until: (task: any) => boolean, attempts = 100): Promise<any> {
    let task: any
    for (let attempt = 0; attempt < attempts; attempt++) {
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
      params: { taskId: created.taskId, inputResponses: { [retryKey]: { action: 'accept', content: {} } } },
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

  test('a state-only InputRequired resumes the task with its state', async (t: TestContext) => {
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
    // Each state-only round waits the poll interval (1s) before running again.
    const task = await pollTask(app, created.taskId, tasksCapable, t => t.status === 'completed', 400)
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
    t.assert.match(task.error.message, /Task owner lost/)
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

  test('past taskMaxConcurrent, an optional task is refused rather than run synchronously', async (t: TestContext) => {
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
    })).json()
    t.assert.strictEqual(second.error?.code, INVALID_REQUEST, JSON.stringify(second))
    t.assert.match(second.error.message, /Cannot create a task: Task limit reached/)
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

    // Timers longer than the outbox poll interval are the task's ttl timer
    // and each input round's wait.
    const timeouts: number[] = []
    const original = globalThis.setTimeout
    t.mock.method(globalThis, 'setTimeout', (callback: () => void, ms?: number) => {
      if (typeof ms === 'number' && ms > 1000 && ms <= ttl) timeouts.push(ms)
      return original(callback, ms)
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

    // The ttl timer, then one wait per round.
    t.assert.strictEqual(timeouts.length, 3)
    t.assert.ok(timeouts[1] <= ttl)
    t.assert.ok(timeouts[2] <= ttl - elapsed, `second round waited ${timeouts[2]}ms, past the task expiry`)
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

describe('round 3: validation, defaults and smaller fixes', () => {
  function asking (inputRequests: Record<string, unknown>) {
    return (app: FastifyInstance) => app.mcpAddTool({ name: 'ask', inputSchema: Type.Object({}) }, async (_args: any, context: any) => {
      if (!context.requestState) throw new InputRequired({ inputRequests: inputRequests as any, state: { s: 1 } })
      return { content: [{ type: 'text', text: JSON.stringify(context.inputResponses) }] }
    })
  }
  const elicitationCapable = { elicitation: { form: {}, url: {} } }

  test('a tool registered without inputSchema is listed with an object schema', async (t: TestContext) => {
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({ name: 'bare' } as any, async () => ({ content: [] }))
    })
    const tool = (await call(app, 'tools/list')).json().result.tools[0]
    t.assert.strictEqual(tool.inputSchema.type, 'object')
  })

  test('URL elicitation follows the legacy URL rules', async (t: TestContext) => {
    for (const url of ['https://user:secret@example.com/', 'javascript:alert(1)', 'file:///etc/passwd']) {
      const app = await buildServer(t, asking({ q: elicitUrl('Sign in', url) }))
      const response = await call(app, 'tools/call', { params: { name: 'ask', arguments: {} }, capabilities: elicitationCapable })
      t.assert.strictEqual(response.json().error?.code, INTERNAL_ERROR, url)
    }
  })

  test('form elicitation needs a message and a flat object schema', async (t: TestContext) => {
    for (const request of [
      { method: 'elicitation/create', params: { mode: 'form', requestedSchema: { type: 'object', properties: {} } } },
      { method: 'elicitation/create', params: { message: 'Hi', mode: 'carrier-pigeon' } },
      elicitForm('Nested?', { type: 'object', properties: { inner: { type: 'object', properties: {} } } } as any)
    ]) {
      const app = await buildServer(t, asking({ q: request }))
      const response = await call(app, 'tools/call', { params: { name: 'ask', arguments: {} }, capabilities: elicitationCapable })
      t.assert.strictEqual(response.json().error?.code, INTERNAL_ERROR, JSON.stringify(request))
    }
  })

  test('answers must be result objects with a valid action', async (t: TestContext) => {
    const app = await buildServer(t, asking({ q: elicitForm('Name?', { type: 'object', properties: { n: { type: 'string' } } }) }))
    const params = { name: 'ask', arguments: {} }
    const first = (await call(app, 'tools/call', { params, capabilities: elicitationCapable })).json().result
    for (const answer of ['garbage', { action: 'pwned' }]) {
      const retry = await call(app, 'tools/call', {
        id: 2,
        capabilities: elicitationCapable,
        params: { ...params, requestState: first.requestState, inputResponses: { q: answer } }
      })
      t.assert.strictEqual(retry.json().error?.code, INVALID_PARAMS, JSON.stringify(answer))
    }
  })

  test('an unknown method is -32601 even with malformed MRTR fields', async (t: TestContext) => {
    const app = await buildServer(t)
    const response = await call(app, 'foo/bar', { params: { inputResponses: 5, requestState: 'xyz' } })
    t.assert.strictEqual(response.statusCode, 404)
    t.assert.strictEqual(response.json().error.code, METHOD_NOT_FOUND)
  })

  test('a resource with empty contents is reported as not found', async (t: TestContext) => {
    const app = await buildServer(t, (app) => {
      app.mcpAddResource({ uriPattern: 'file:///nothing' }, async () => ({ contents: [] }))
    })
    const response = await call(app, 'resources/read', { params: { uri: 'file:///nothing' } })
    t.assert.strictEqual(response.json().error.code, INVALID_PARAMS)
  })

  test('a 500 keeps the request id', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())
    await app.register(mcpPlugin, {
      resolveAuthorizationContext: () => { throw new Error('resolver down') }
    })
    await app.ready()
    const response = await call(app, 'tools/list', { id: 42 })
    t.assert.strictEqual(response.statusCode, 500)
    t.assert.strictEqual(response.json().id, 42)
  })

  test('stdio tokens never reach handlers', async (t: TestContext) => {
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({ name: 'headers', inputSchema: Type.Object({}) }, async (_args: any, context: any) => ({
        content: [{ type: 'text', text: JSON.stringify(context.request.headers) }]
      }))
    })
    const input = new PassThrough()
    const output = new PassThrough()
    const transport = createStdioTransport(app, { input, output, error: new PassThrough() })
    transport.start()
    t.after(() => transport.stop())
    const answered = new Promise<string>(resolve => output.once('data', (chunk: Buffer) => resolve(chunk.toString())))
    input.write(JSON.stringify(modernBody('tools/call', { id: 1, params: { name: 'headers', arguments: {} } })) + '\n')
    const headers = JSON.parse(JSON.parse(await answered).result.content[0].text)
    t.assert.strictEqual(headers['x-platformatic-mcp-stdio-trust'], undefined)
    t.assert.strictEqual(headers['x-platformatic-mcp-stdio-request'], undefined)
  })

  test('a resource URI longer than the limit is refused', async (t: TestContext) => {
    const app = await buildServer(t, undefined, { capabilities: { resources: { subscribe: true } } })
    const response = await call(app, 'subscriptions/listen', {
      params: { notifications: { resourceSubscriptions: ['file:///' + 'x'.repeat(3000)] } }
    })
    t.assert.strictEqual(response.json().error.code, INVALID_PARAMS)
  })

  test('adding a tool after ready announces it to listen streams', async (t: TestContext) => {
    // The plugin's default capabilities, which declare listChanged.
    const app = await buildServer(t, undefined, { capabilities: undefined })
    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payloadAsStream: true,
      headers: modernHeaders('subscriptions/listen'),
      payload: modernBody('subscriptions/listen', { id: 'L', params: { notifications: { toolsListChanged: true } } })
    })
    const stream = response.stream()
    const frames: any[] = []
    stream.on('data', (chunk: Buffer) => {
      for (const frame of chunk.toString().split('\n\n')) {
        const data = frame.replace(/^data: /, '').trim()
        if (data.startsWith('{')) frames.push(JSON.parse(data))
      }
    })
    await new Promise(resolve => setTimeout(resolve, 30))
    app.mcpAddTool({ name: 'late-tool', inputSchema: Type.Object({}) }, async () => ({ content: [] }))
    await new Promise(resolve => setTimeout(resolve, 30))
    stream.destroy()
    t.assert.ok(frames.some(frame => frame.method === 'notifications/tools/list_changed'))
  })

  test('legacy clients without SSE are not promised list-change notifications', async (t: TestContext) => {
    const app = await buildServer(t, undefined, { capabilities: undefined })
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
    t.assert.strictEqual(init.json().result.capabilities.tools.listChanged, undefined)

    const withSse = await buildServer(t, undefined, { capabilities: undefined, enableSSE: true })
    const sseInit = await withSse.inject({
      method: 'POST',
      url: '/mcp',
      payload: {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'initialize',
        params: { protocolVersion: LATEST_LEGACY_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'l', version: '1' } }
      }
    })
    t.assert.strictEqual(sseInit.json().result.capabilities.tools.listChanged, true)
  })

  test('a requestStateSecret without serverInfo logs a warning', async (t: TestContext) => {
    const lines: string[] = []
    const app = Fastify({ logger: { level: 'warn', stream: { write: (line: string) => { lines.push(line) } } } })
    t.after(() => app.close())
    await app.register(mcpPlugin, { requestStateSecret: 'x'.repeat(32) })
    await app.ready()
    t.assert.ok(lines.some(line => line.includes('serverInfo')))
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

/** Poll until `check` passes, for up to a second. */
async function until (check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !check(); attempt++) await new Promise(resolve => setTimeout(resolve, 10))
}

function stdioHarness (t: TestContext, app: FastifyInstance, options: Record<string, unknown> = {}) {
  const input = new PassThrough()
  const output = new PassThrough()
  const transport = createStdioTransport(app, { input, output, error: new PassThrough(), ...options })
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

describe('round 4: transport, input validation and stdio', () => {
  /** Send a raw HTTP request, so headers can repeat and the socket can drop. */
  async function listen (app: FastifyInstance): Promise<number> {
    await app.listen({ port: 0, host: '127.0.0.1' })
    return (app.server.address() as { port: number }).port
  }

  async function rawPost (port: number, headers: Record<string, string | string[]>, body: unknown) {
    const { request } = await import('node:http')
    return await new Promise<{ status: number, body: any }>((resolve, reject) => {
      const req = request({ port, host: '127.0.0.1', method: 'POST', path: '/mcp', headers }, (res) => {
        let data = ''
        res.on('data', chunk => { data += chunk })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : undefined }))
      })
      req.on('error', reject)
      req.end(JSON.stringify(body))
    })
  }

  test('a mirrored header sent twice is rejected, not joined', async (t: TestContext) => {
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({
        name: 'tenant-tool',
        inputSchema: { type: 'object', properties: { tenant: { type: 'string', 'x-mcp-header': 'Tenant' } } }
      }, async () => ({ content: [{ type: 'text', text: 'ran' }] }))
    })
    const port = await listen(app)
    const params = { name: 'tenant-tool', arguments: { tenant: 'acme, evil' } }
    const response = await rawPost(port, {
      ...modernHeaders('tools/call', { params }),
      'mcp-param-tenant': ['acme', 'evil']
    }, modernBody('tools/call', { params }))
    t.assert.strictEqual(response.status, 400)
    t.assert.strictEqual(response.body.error.code, HEADER_MISMATCH)
  })

  test('Mcp-Param headers only mirror primitive values', async (t: TestContext) => {
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({
        name: 'region-tool',
        inputSchema: { type: 'object', properties: { region: { type: 'string', 'x-mcp-header': 'Region' } } }
      }, async () => ({ content: [{ type: 'text', text: 'ran' }] }))
    })
    for (const [region, header] of [[['us-west1'], 'us-west1'], [{ a: 1 }, '[object Object]']] as const) {
      const params = { name: 'region-tool', arguments: { region } }
      const response = await call(app, 'tools/call', { params, headers: { 'mcp-param-region': header } })
      t.assert.strictEqual(response.statusCode, 400)
      t.assert.strictEqual(response.json().error.code, HEADER_MISMATCH)
    }
  })

  test('an omitted argument named like an Object.prototype member needs no header', async (t: TestContext) => {
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({
        name: 'ctor-tool',
        inputSchema: { type: 'object', properties: { constructor: { type: 'string', 'x-mcp-header': 'Ctor' } } }
      }, async () => ({ content: [{ type: 'text', text: 'ran' }] }))
    })
    const response = await call(app, 'tools/call', { params: { name: 'ctor-tool', arguments: {} } })
    t.assert.strictEqual(response.statusCode, 200)
    t.assert.strictEqual(response.json().result.content[0].text, 'ran')
  })

  test('a result that cannot be serialized is answered with -32603, with or without a stream', async (t: TestContext) => {
    const app = await buildServer(t, (app) => {
      // Asks for no input, so its progress may stream before the result.
      app.mcpAddTool({ name: 'bigint', inputSchema: Type.Object({}), inputCapabilities: {} }, async (_args: any, context: any) => {
        context.sendProgress(1)
        await new Promise(resolve => setTimeout(resolve, 300))
        return { content: [{ type: 'text', text: 'x' }], structuredContent: { n: 10n } } as any
      })
    })

    // Progress was asked for and the handler ran long enough to open the stream.
    const params = { name: 'bigint', arguments: {} }
    const body = modernBody('tools/call', { id: 's', params })
    ;(body.params._meta as Record<string, unknown>).progressToken = 'p'
    const streamed = await app.inject({ method: 'POST', url: '/mcp', headers: modernHeaders('tools/call', { params }), payload: body })
    t.assert.strictEqual(streamed.headers['content-type'], 'text/event-stream')
    const frames = streamed.body.split('\n\n').filter(Boolean).map(frame => JSON.parse(frame.slice('data: '.length)))
    const last = frames.at(-1)
    t.assert.strictEqual(last.id, 's')
    t.assert.strictEqual(last.error.code, INTERNAL_ERROR)

    const plain = await call(app, 'tools/call', { id: 'p', params: { name: 'bigint', arguments: {} } })
    t.assert.strictEqual(plain.json().id, 'p')
    t.assert.strictEqual(plain.json().error.code, INTERNAL_ERROR)
  })

  test('a client that disconnects while hooks run cancels the request', async (t: TestContext) => {
    let sawAbort: boolean | undefined
    const app = Fastify()
    t.after(() => app.close())
    // A slow hook stands in for token validation (a JWKS fetch, say).
    app.addHook('preHandler', async () => { await new Promise(resolve => setTimeout(resolve, 300)) })
    await app.register(mcpPlugin, { serverInfo: { name: 'test-server', version: '1.0.0' } })
    app.mcpAddTool({ name: 'watch', inputSchema: Type.Object({}) }, async (_args: any, context: any) => {
      sawAbort = context.signal.aborted
      return { content: [{ type: 'text', text: 'ran' }] }
    })
    const port = await listen(app)

    const { request } = await import('node:http')
    const params = { name: 'watch', arguments: {} }
    const req = request({ port, host: '127.0.0.1', method: 'POST', path: '/mcp', headers: modernHeaders('tools/call', { params }) })
    req.on('error', () => {})
    req.end(JSON.stringify(modernBody('tools/call', { params })))
    await new Promise(resolve => setTimeout(resolve, 100))
    req.destroy()
    await until(() => sawAbort !== undefined)
    t.assert.strictEqual(sawAbort, true)
  })

  test('with telemetry, a malformed modern body is still a 400 -32600', async (t: TestContext) => {
    const tracer = { startActiveSpan: (_name: string, ...args: any[]) => args.at(-1)({ setAttribute () {}, setStatus () {}, end () {} }) }
    const app = await buildServer(t, undefined, { telemetry: { tracer } })
    for (const payload of ['null', '5', '"x"']) {
      const response = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { 'content-type': 'application/json', 'mcp-protocol-version': LATEST_PROTOCOL_VERSION },
        payload
      })
      t.assert.strictEqual(response.statusCode, 400)
      t.assert.strictEqual(response.json().error.code, INVALID_REQUEST)
    }
  })

  test('without SSE, GET answers 405 naming the methods the caller may use', async (t: TestContext) => {
    const app = await buildServer(t)
    // A legacy client can still end its session with DELETE.
    const response = await app.inject({ method: 'GET', url: '/mcp' })
    t.assert.strictEqual(response.statusCode, 405)
    t.assert.strictEqual(response.headers.allow, 'POST, DELETE')

    // A modern client has no session, so only POST applies.
    const modern = await app.inject({ method: 'GET', url: '/mcp', headers: { 'mcp-protocol-version': '2026-07-28' } })
    t.assert.strictEqual(modern.statusCode, 405)
    t.assert.strictEqual(modern.headers.allow, 'POST')
  })

  test('body-parser errors are JSON-RPC errors with their HTTP status', async (t: TestContext) => {
    const app = Fastify({ bodyLimit: 256 })
    t.after(() => app.close())
    await app.register(mcpPlugin)
    await app.ready()

    const malformed = await app.inject({
      method: 'POST', url: '/mcp', headers: { 'content-type': 'application/json' }, payload: '{"jsonrpc":'
    })
    t.assert.strictEqual(malformed.statusCode, 400)
    t.assert.deepStrictEqual(malformed.json(), {
      jsonrpc: JSONRPC_VERSION, id: null, error: { code: -32700, message: 'Parse error' }
    })

    const tooLarge = await app.inject({
      method: 'POST', url: '/mcp', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ x: 'y'.repeat(1000) })
    })
    t.assert.strictEqual(tooLarge.statusCode, 413)
    t.assert.strictEqual(tooLarge.json().error.code, INVALID_REQUEST)

    const wrongType = await app.inject({
      method: 'POST', url: '/mcp', headers: { 'content-type': 'text/xml' }, payload: '<x/>'
    })
    t.assert.strictEqual(wrongType.statusCode, 415)
    t.assert.strictEqual(wrongType.json().error.code, INVALID_REQUEST)
  })

  function askingTool (app: FastifyInstance, inputRequests: Record<string, unknown>, seen: unknown[] = [], state: unknown = { step: 1 }) {
    app.mcpAddTool({ name: 'ask', inputSchema: Type.Object({}) }, async (_args: any, context: any) => {
      if (!context.requestState) throw new InputRequired({ inputRequests: inputRequests as any, state })
      seen.push(context.inputResponses)
      return { content: [{ type: 'text', text: 'done' }] }
    })
  }

  test('a multi-select enum elicitation is forwarded', async (t: TestContext) => {
    const app = await buildServer(t, (app) => askingTool(app, {
      colours: elicitForm('Pick colours', {
        type: 'object',
        properties: {
          listed: { type: 'array', items: { type: 'string', enum: ['Red', 'Green'] } },
          titled: { type: 'array', items: { anyOf: [{ const: 'r', title: 'Red' }, { const: 'g', title: 'Green' }] } }
        }
      } as any)
    }))
    const response = await call(app, 'tools/call', {
      params: { name: 'ask', arguments: {} },
      capabilities: { elicitation: { form: {} } }
    })
    t.assert.strictEqual(response.json().result.resultType, 'input_required')
  })

  test('answers must be results of the method they answer', async (t: TestContext) => {
    const seen: unknown[] = []
    const app = await buildServer(t, (app) => askingTool(app, {
      q: elicitForm('Name?', { type: 'object', properties: { name: { type: 'string' } } })
    }, seen))
    const capabilities = { elicitation: { form: {} } }
    const params = { name: 'ask', arguments: {} }
    const first = (await call(app, 'tools/call', { params, capabilities })).json().result

    for (const answer of [
      { role: 'assistant', content: { type: 'text', text: 'hi' }, model: 'm' },
      { action: 'accept', content: 'nope' },
      { action: 'accept', content: { name: { deep: true } } }
    ]) {
      const retry = await call(app, 'tools/call', {
        id: 2,
        capabilities,
        params: { ...params, requestState: first.requestState, inputResponses: { q: answer } }
      })
      t.assert.strictEqual(retry.json().error?.code, INVALID_PARAMS, JSON.stringify(answer))
    }
    t.assert.deepStrictEqual(seen, [])

    const valid = await call(app, 'tools/call', {
      id: 3,
      capabilities,
      params: { ...params, requestState: first.requestState, inputResponses: { q: { action: 'accept', content: { name: 'a' } } } }
    })
    t.assert.strictEqual(valid.json().result.content[0].text, 'done')
  })

  test('state the server cannot seal is an internal error, not an authentication one', async (t: TestContext) => {
    const app = await buildServer(t, (app) => askingTool(app, {
      q: elicitForm('Name?', { type: 'object', properties: { name: { type: 'string' } } })
    }, [], { n: 10n }))
    const response = await call(app, 'tools/call', {
      params: { name: 'ask', arguments: {} },
      capabilities: { elicitation: { form: {} } }
    })
    t.assert.strictEqual(response.json().error.code, INTERNAL_ERROR)
    t.assert.strictEqual(response.json().error.message, 'Internal server error')
  })

  test('elicitationId is not sent to 2026-07-28 clients', async (t: TestContext) => {
    const app = await buildServer(t, (app) => askingTool(app, {
      go: { method: 'elicitation/create', params: { mode: 'url', message: 'Verify', url: 'https://example.com/v', elicitationId: 'e1' } }
    }))
    const response = await call(app, 'tools/call', {
      params: { name: 'ask', arguments: {} },
      capabilities: { elicitation: { url: {} } }
    })
    const request = response.json().result.inputRequests.go
    t.assert.strictEqual(request.params.url, 'https://example.com/v')
    t.assert.strictEqual('elicitationId' in request.params, false)
  })

  test('handlers see the protocol version and client capabilities of the request', async (t: TestContext) => {
    let seen: any
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({ name: 'who', inputSchema: Type.Object({}) }, async (_args: any, context: any) => {
        seen = { protocolVersion: context.protocolVersion, clientCapabilities: context.clientCapabilities }
        return { content: [{ type: 'text', text: 'ok' }] }
      })
    })
    await call(app, 'tools/call', { params: { name: 'who', arguments: {} }, capabilities: { elicitation: { url: {} } } })
    t.assert.deepStrictEqual(seen, { protocolVersion: LATEST_PROTOCOL_VERSION, clientCapabilities: { elicitation: { url: {} } } })
  })

  test('prompts/get failures are JSON-RPC errors that do not leak handler messages', async (t: TestContext) => {
    const app = await buildServer(t, (app) => {
      app.mcpAddPrompt({
        name: 'leaky',
        arguments: [{ name: 'topic', required: true }]
      }, async () => { throw new Error('connect ECONNREFUSED password=hunter2') })
      app.mcpAddPrompt({
        name: 'typed',
        argumentSchema: Type.Object({ topic: Type.String() })
      }, async () => ({ messages: [] }))
    })

    const missing = await call(app, 'prompts/get', { params: { name: 'leaky', arguments: {} } })
    t.assert.strictEqual(missing.json().error.code, INVALID_PARAMS)
    t.assert.match(missing.json().error.message, /topic/)

    const invalid = await call(app, 'prompts/get', { params: { name: 'typed', arguments: {} } })
    t.assert.strictEqual(invalid.json().error.code, INVALID_PARAMS)

    const failed = await call(app, 'prompts/get', { params: { name: 'leaky', arguments: { topic: 'x' } } })
    t.assert.strictEqual(failed.json().error.code, INTERNAL_ERROR)
    t.assert.doesNotMatch(failed.payload, /hunter2/)
  })

  test('tasks/update rejects a malformed answer and stores nothing', async (t: TestContext) => {
    let received: unknown
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({
        name: 'confirm',
        inputSchema: Type.Object({}),
        execution: { taskSupport: 'required' }
      } as any, async (_args: any, context: any) => {
        if (!context.inputResponses?.ok) {
          throw new InputRequired({ inputRequests: { ok: elicitForm('Confirm?', { type: 'object', properties: {} }) } })
        }
        received = context.inputResponses.ok
        return { content: [{ type: 'text', text: 'done' }] }
      })
    }, { enableTasks: true })
    const capabilities: ClientCapabilities = { extensions: { [TASKS_EXTENSION]: {} }, elicitation: { form: {} } }
    const created = (await call(app, 'tools/call', { params: { name: 'confirm', arguments: {} }, capabilities })).json().result

    let task: any
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 25))
      task = (await call(app, 'tasks/get', { params: { taskId: created.taskId }, capabilities })).json().result
      if (task.status === 'input_required') break
    }
    t.assert.strictEqual(task.status, 'input_required')

    const bogus = await call(app, 'tasks/update', {
      params: { taskId: created.taskId, inputResponses: { ok: { action: 'bogus' } } },
      capabilities
    })
    t.assert.strictEqual(bogus.json().error.code, INVALID_PARAMS)
    await new Promise(resolve => setTimeout(resolve, 50))
    t.assert.strictEqual(received, undefined)

    await call(app, 'tasks/update', {
      params: { taskId: created.taskId, inputResponses: { ok: { action: 'accept', content: {} } } },
      capabilities
    })
    await until(() => received !== undefined)
    t.assert.deepStrictEqual(received, { action: 'accept', content: {} })
  })

  test('listen asks the subscribe handler about each URI and unsubscribes when it ends', async (t: TestContext) => {
    const subscribed: string[] = []
    const unsubscribed: string[] = []
    const app = await buildServer(t, (app) => {
      app.mcpSetResourceSubscribeHandler(async ({ uri }) => {
        if (uri.startsWith('tenant://bob/')) throw new Error('Forbidden')
        subscribed.push(uri)
        return {}
      })
      app.mcpSetResourceUnsubscribeHandler(async ({ uri }) => {
        unsubscribed.push(uri)
        return {}
      })
    }, { capabilities: { resources: { subscribe: true } } })

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payloadAsStream: true,
      headers: modernHeaders('subscriptions/listen'),
      payload: modernBody('subscriptions/listen', {
        params: { notifications: { resourceSubscriptions: ['tenant://alice/inbox', 'tenant://bob/inbox'] } }
      })
    })
    const stream = response.stream()
    let received = ''
    stream.on('data', (chunk: Buffer) => { received += chunk.toString() })
    await until(() => received.includes('acknowledged'))
    const ack = JSON.parse(received.split('\n\n')[0].slice('data: '.length))
    t.assert.deepStrictEqual(ack.params.notifications, { resourceSubscriptions: ['tenant://alice/inbox'] })
    t.assert.deepStrictEqual(subscribed, ['tenant://alice/inbox'])

    await app.mcpBroadcastNotification({ jsonrpc: JSONRPC_VERSION, method: 'notifications/resources/updated', params: { uri: 'tenant://bob/inbox' } })
    await app.mcpBroadcastNotification({ jsonrpc: JSONRPC_VERSION, method: 'notifications/resources/updated', params: { uri: 'tenant://alice/inbox' } })
    await until(() => received.includes('alice/inbox"}'))
    t.assert.doesNotMatch(received, /"uri":"tenant:\/\/bob/)

    // However the stream ends (here, the server shutting down), the accepted
    // URIs are unsubscribed.
    stream.destroy()
    await app.close()
    await until(() => unsubscribed.length > 0)
    t.assert.deepStrictEqual(unsubscribed, ['tenant://alice/inbox'])
  })

  test('stdio cancellation aborts legacy handlers too', async (t: TestContext) => {
    let aborted: boolean | undefined
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({ name: 'wait', inputSchema: Type.Object({}) }, async (_args: any, context: any) => {
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, 2000)
          context.signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
        })
        aborted = context.signal.aborted
        return { content: [{ type: 'text', text: 'done' }] }
      })
    })
    const { input } = stdioHarness(t, app)
    input.write(JSON.stringify({ jsonrpc: JSONRPC_VERSION, id: 'w', method: 'tools/call', params: { name: 'wait', arguments: {} } }) + '\n')
    await new Promise(resolve => setTimeout(resolve, 50))
    input.write(JSON.stringify({ jsonrpc: JSONRPC_VERSION, method: 'notifications/cancelled', params: { requestId: 'w' } }) + '\n')
    await until(() => aborted !== undefined)
    t.assert.strictEqual(aborted, true)
  })

  test('a stdio token seen by an earlier hook cannot be replayed over HTTP', async (t: TestContext) => {
    // Everything the transport marks its requests with, as a logger or an
    // earlier hook would see it.
    const seen: Record<string, string>[] = []
    const app = Fastify()
    t.after(() => app.close())
    app.addHook('onRequest', async (request) => {
      const marks = Object.fromEntries(Object.entries(request.headers)
        .filter(([name, value]) => name.startsWith('x-platformatic-mcp-stdio') && typeof value === 'string')) as Record<string, string>
      if (Object.keys(marks).length > 0) seen.push(marks)
    })
    await app.register(mcpPlugin, { serverInfo: { name: 'test-server', version: '1.0.0' } })
    await app.ready()

    const { input, waitFor } = stdioHarness(t, app)
    input.write(JSON.stringify(modernBody('server/discover', { id: 'd' })) + '\n')
    t.assert.ok((await waitFor(line => line.id === 'd'))?.result)
    t.assert.strictEqual(seen.length, 1)

    // Without the header layer's checks this would succeed; with them, a
    // request missing the mirrored headers is refused.
    const replay = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json', ...seen[0] },
      payload: modernBody('server/discover')
    })
    t.assert.strictEqual(replay.statusCode, 400)
    t.assert.strictEqual(replay.json().error.code, HEADER_MISMATCH)
  })

  test('stdio acts as the identity it was given, so multi round-trip requests work with authorization on', async (t: TestContext) => {
    let who: unknown
    const app = Fastify()
    t.after(() => app.close())
    await app.register(mcpPlugin, {
      serverInfo: { name: 'test-server', version: '1.0.0' },
      authorization: {
        enabled: true,
        authorizationServers: ['https://auth.example.com'],
        resourceUri: 'https://mcp.example.com',
        tokenValidation: { jwksUri: 'https://auth.example.com/.well-known/jwks.json' }
      }
    })
    app.mcpAddTool({ name: 'ask', inputSchema: Type.Object({}) }, async (_args: any, context: any) => {
      who = context.authContext?.userId
      if (!context.requestState) {
        throw new InputRequired({ inputRequests: { q: elicitForm('Name?', { type: 'object', properties: {} }) } })
      }
      return { content: [{ type: 'text', text: 'done' }] }
    })
    await app.ready()

    const { input, waitFor } = stdioHarness(t, app, { authContext: { userId: 'local-user' } })
    input.write(JSON.stringify(modernBody('tools/call', {
      id: 'a',
      params: { name: 'ask', arguments: {} },
      capabilities: { elicitation: { form: {} } }
    })) + '\n')
    const answer = await waitFor(line => line.id === 'a')
    t.assert.strictEqual(answer?.result?.resultType, 'input_required')
    t.assert.strictEqual(who, 'local-user')
  })
})

describe('round 5: arguments, subscriptions, input rounds and stdio', () => {
  /** A tool whose `tenant` argument is mirrored into `Mcp-Param-Tenant`. */
  function tenantTool (app: FastifyInstance, seen: unknown[], schema: Record<string, unknown> = { type: 'string', 'x-mcp-header': 'Tenant' }) {
    app.mcpAddTool({
      name: 'tenant-tool',
      inputSchema: { type: 'object', properties: { tenant: schema } }
    }, async (args: any) => {
      seen.push(args.tenant)
      return { content: [{ type: 'text', text: 'ran' }] }
    })
  }

  test('arguments with control characters are refused, never rewritten past the header check', async (t: TestContext) => {
    const seen: unknown[] = []
    const app = await buildServer(t, (app) => tenantTool(app, seen))

    // Two keys that would collapse into one once the control character went.
    const collide = { name: 'tenant-tool', arguments: { tenant: 'allowed', 'ten\u0001ant': 'victim' } }
    const collided = await call(app, 'tools/call', { params: collide, headers: { 'mcp-param-tenant': 'allowed' } })
    t.assert.strictEqual(collided.json().result?.isError, true, collided.body)

    // A value the header only matches once a NUL is stripped.
    const nul = { name: 'tenant-tool', arguments: { tenant: 'acme\u0000' } }
    const stripped = await call(app, 'tools/call', { params: nul, headers: { 'mcp-param-tenant': encodeHeaderValue('acme\u0000') } })
    t.assert.strictEqual(stripped.json().result?.isError, true, stripped.body)

    t.assert.deepStrictEqual(seen, [])
  })

  test('JSON Schema validation never coerces arguments, whatever the AJV options', async (t: TestContext) => {
    const seen: unknown[] = []
    const app = await buildServer(t, (app) => tenantTool(app, seen, { type: 'integer', 'x-mcp-header': 'Tenant' }), {
      validateJsonSchemaInputs: { coerceTypes: true, useDefaults: true, removeAdditional: true }
    })
    const params = { name: 'tenant-tool', arguments: { tenant: '0x2A' } }
    const response = await call(app, 'tools/call', { params, headers: { 'mcp-param-tenant': '0x2A' } })
    t.assert.strictEqual(response.json().result?.isError, true, response.body)
    t.assert.deepStrictEqual(seen, [])
  })

  async function openListen (app: FastifyInstance, notifications: Record<string, unknown>, id: string | number = 1) {
    return await app.inject({
      method: 'POST',
      url: '/mcp',
      payloadAsStream: true,
      headers: modernHeaders('subscriptions/listen'),
      payload: modernBody('subscriptions/listen', { id, params: { notifications } })
    })
  }

  test('without a subscribe handler, listen accepts no resource URIs', async (t: TestContext) => {
    const app = await buildServer(t, undefined, { capabilities: { resources: { subscribe: true } } })
    const response = await openListen(app, { resourceSubscriptions: ['tenant://alice/payroll'] })
    const stream = response.stream()
    let received = ''
    stream.on('data', (chunk: Buffer) => { received += chunk.toString() })
    await until(() => received.includes('acknowledged'))
    const ack = JSON.parse(received.split('\n\n')[0].slice('data: '.length))
    t.assert.deepStrictEqual(ack.params.notifications, {})

    await app.mcpBroadcastNotification({ jsonrpc: JSONRPC_VERSION, method: 'notifications/resources/updated', params: { uri: 'tenant://alice/payroll' } })
    await new Promise(resolve => setTimeout(resolve, 50))
    t.assert.doesNotMatch(received, /payroll/)
    stream.destroy()
  })

  test('listen limits hold while subscribe handlers run', async (t: TestContext) => {
    const app = await buildServer(t, (app) => {
      app.mcpSetResourceSubscribeHandler(async () => {
        await new Promise(resolve => setTimeout(resolve, 50))
        return {}
      })
    }, {
      capabilities: { resources: { subscribe: true } },
      resolveAuthorizationContext: async () => ({ userId: 'same-user' }),
      subscriptionMaxStreamsPerPrincipal: 1
    })

    const responses = await Promise.all([1, 2, 3].map(id => openListen(app, { resourceSubscriptions: ['a:1'] }, id)))
    t.assert.deepStrictEqual(responses.map(response => response.statusCode).sort(), [200, 429, 429])
    for (const response of responses) response.stream().destroy()
  })

  test('a stdio listen cancelled while its subscribe handler runs is torn down', async (t: TestContext) => {
    const unsubscribed: string[] = []
    const app = await buildServer(t, (app) => {
      app.mcpSetResourceSubscribeHandler(async () => {
        await new Promise(resolve => setTimeout(resolve, 100))
        return {}
      })
      app.mcpSetResourceUnsubscribeHandler(async ({ uri }) => {
        unsubscribed.push(uri)
        return {}
      })
    }, { capabilities: { resources: { subscribe: true } }, subscriptionMaxStreams: 1 })
    const { input, waitFor } = stdioHarness(t, app)

    input.write(JSON.stringify(modernBody('subscriptions/listen', { id: 'a', params: { notifications: { resourceSubscriptions: ['a:1'] } } })) + '\n')
    await new Promise(resolve => setTimeout(resolve, 30))
    input.write(JSON.stringify({ jsonrpc: JSONRPC_VERSION, method: 'notifications/cancelled', params: { requestId: 'a' } }) + '\n')
    await until(() => unsubscribed.length > 0)
    t.assert.deepStrictEqual(unsubscribed, ['a:1'])

    // Its slot is free again.
    input.write(JSON.stringify(modernBody('subscriptions/listen', { id: 'b', params: { notifications: {} } })) + '\n')
    const ack = await waitFor(line => line.method === 'notifications/subscriptions/acknowledged')
    t.assert.strictEqual(ack?.params._meta['io.modelcontextprotocol/subscriptionId'], 'b')
  })

  test('a null client capability is a -32602, not a crash', async (t: TestContext) => {
    const app = await buildServer(t, (app) => askingTool(app))
    for (const capabilities of [{ elicitation: null }, { sampling: 5 }, { elicitation: { url: null } }]) {
      const response = await call(app, 'tools/call', { params: { name: 'ask', arguments: {} }, capabilities: capabilities as any })
      t.assert.strictEqual(response.statusCode, 400, JSON.stringify(capabilities))
      t.assert.strictEqual(response.json().error.code, INVALID_PARAMS)
    }
  })

  function askingTool (app: FastifyInstance, states: unknown[] = []) {
    app.mcpAddTool({ name: 'ask', inputSchema: Type.Object({}) }, async (_args: any, context: any) => {
      states.push(context.requestState)
      if (!context.inputResponses?.q) {
        throw new InputRequired({ inputRequests: { q: elicitForm('Name?', { type: 'object', properties: {} }) } })
      }
      return { content: [{ type: 'text', text: 'done' }] }
    })
  }

  test('a retry may send empty arguments where the first call sent none, and sees no state it never saved', async (t: TestContext) => {
    const states: unknown[] = []
    const app = await buildServer(t, (app) => askingTool(app, states))
    const capabilities = { elicitation: { form: {} } }
    const first = (await call(app, 'tools/call', { params: { name: 'ask' }, capabilities })).json().result
    t.assert.strictEqual(first.resultType, 'input_required')

    const retry = await call(app, 'tools/call', {
      id: 2,
      capabilities,
      params: { name: 'ask', arguments: {}, requestState: first.requestState, inputResponses: { q: { action: 'accept', content: {} } } }
    })
    t.assert.strictEqual(retry.json().result?.content?.[0]?.text, 'done', retry.body)
    t.assert.deepStrictEqual(states, [undefined, undefined])
  })

  test('mcpCallTool and onToolCallComplete report a tool asking for input as an outcome', async (t: TestContext) => {
    const events: any[] = []
    const app = await buildServer(t, (app) => {
      askingTool(app)
      app.post('/run', async (request, reply) => await app.mcpCallTool('ask', {}, { request, reply }))
    }, {
      onToolCallComplete: (event: any) => { events.push(event) }
    })
    const outcome = (await app.inject({ method: 'POST', url: '/run', payload: {} })).json()
    t.assert.strictEqual(outcome.ok, false)
    t.assert.strictEqual(outcome.reason, 'input-required')
    t.assert.strictEqual(outcome.inputRequests.q.method, 'elicitation/create')

    const response = await call(app, 'tools/call', { params: { name: 'ask', arguments: {} }, capabilities: { elicitation: { form: {} } } })
    t.assert.strictEqual(response.json().result.resultType, 'input_required')
    t.assert.deepStrictEqual(events.map(event => [event.source, event.outcome.reason]), [['in-process', 'input-required'], ['json-rpc', 'input-required']])
  })

  test('requestStateTtlMs must be a positive integer', async (t: TestContext) => {
    for (const requestStateTtlMs of [Number.NaN, -1, 0, '300000']) {
      const app = Fastify()
      t.after(() => app.close())
      app.register(mcpPlugin, { requestStateTtlMs } as any)
      await t.assert.rejects(async () => { await app.ready() }, /requestStateTtlMs/)
    }
  })

  test('telemetry records the outcome of a response sent on the stream', async (t: TestContext) => {
    const attributes: Record<string, unknown> = {}
    const span = { setAttribute (key: string, value: unknown) { attributes[key] = value }, setStatus () {}, end () {}, recordException () {} }
    const tracer = { startActiveSpan: (_name: string, ...args: any[]) => args.at(-1)(span) }
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({ name: 'slow-fail', inputSchema: Type.Object({}) }, async (_args: any, context: any) => {
        context.sendProgress(1)
        await new Promise(resolve => setTimeout(resolve, 300))
        throw new Error('boom')
      })
    }, { telemetry: { tracer } })
    const params = { name: 'slow-fail', arguments: {} }
    const body = modernBody('tools/call', { params })
    ;(body.params._meta as Record<string, unknown>).progressToken = 'p'
    const response = await app.inject({ method: 'POST', url: '/mcp', headers: modernHeaders('tools/call', { params }), payload: body })
    t.assert.strictEqual(response.headers['content-type'], 'text/event-stream')
    t.assert.strictEqual(attributes['error.type'], 'tool_error')
  })

  test('a task still being created when the server closes never starts', async (t: TestContext) => {
    let started = false
    const original = MemoryTaskStore.prototype.create
    t.mock.method(MemoryTaskStore.prototype, 'create', async function (this: MemoryTaskStore, ...args: Parameters<MemoryTaskStore['create']>) {
      await new Promise(resolve => setTimeout(resolve, 200))
      return await original.apply(this, args)
    })
    const app = Fastify()
    await app.register(mcpPlugin, { serverInfo: { name: 'test-server', version: '1.0.0' }, enableTasks: true, taskShutdownTimeoutMs: 50 })
    app.mcpAddTool({ name: 'work', inputSchema: Type.Object({}), execution: { taskSupport: 'required' } } as any, async () => {
      started = true
      return { content: [{ type: 'text', text: 'done' }] }
    })
    await app.ready()

    const pending = call(app, 'tools/call', {
      params: { name: 'work', arguments: {} },
      capabilities: { extensions: { [TASKS_EXTENSION]: {} } }
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    await app.close()
    await pending.catch(() => {})
    await new Promise(resolve => setTimeout(resolve, 100))
    t.assert.strictEqual(started, false)
  })

  test('a task ttl beyond the timer range does not cut input rounds short', async (t: TestContext) => {
    const thirtyDays = 30 * 24 * 60 * 60 * 1000
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({ name: 'confirm', inputSchema: Type.Object({}), execution: { taskSupport: 'required' } } as any, async (_args: any, context: any) => {
        if (!context.inputResponses?.ok) {
          throw new InputRequired({ inputRequests: { ok: elicitForm('Confirm?', { type: 'object', properties: {} }) } })
        }
        return { content: [{ type: 'text', text: 'done' }] }
      })
    }, { enableTasks: true, taskDefaultTtlMs: thirtyDays, taskMaxTtlMs: thirtyDays })
    const capabilities: ClientCapabilities = { extensions: { [TASKS_EXTENSION]: {} }, elicitation: { form: {} } }
    const created = (await call(app, 'tools/call', { params: { name: 'confirm', arguments: {} }, capabilities })).json().result

    const status = async () => (await call(app, 'tasks/get', { params: { taskId: created.taskId }, capabilities })).json().result.status
    let current = await status()
    for (let attempt = 0; attempt < 20 && current === 'working'; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10))
      current = await status()
    }
    await new Promise(resolve => setTimeout(resolve, 100))
    t.assert.strictEqual(await status(), 'input_required')
    await call(app, 'tasks/cancel', { params: { taskId: created.taskId }, capabilities })
  })

  test('tasks/update ignores responses for keys nobody asked about', async (t: TestContext) => {
    let received: unknown
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({ name: 'confirm', inputSchema: Type.Object({}), execution: { taskSupport: 'required' } } as any, async (_args: any, context: any) => {
        if (!context.inputResponses?.ok) {
          throw new InputRequired({ inputRequests: { ok: elicitForm('Confirm?', { type: 'object', properties: {} }) } })
        }
        received = context.inputResponses.ok
        return { content: [{ type: 'text', text: 'done' }] }
      })
    }, { enableTasks: true })
    const capabilities: ClientCapabilities = { extensions: { [TASKS_EXTENSION]: {} }, elicitation: { form: {} } }
    const created = (await call(app, 'tools/call', { params: { name: 'confirm', arguments: {} }, capabilities })).json().result
    let task: any
    for (let attempt = 0; attempt < 20 && task?.status !== 'input_required'; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 25))
      task = (await call(app, 'tasks/get', { params: { taskId: created.taskId }, capabilities })).json().result
    }

    const update = await call(app, 'tasks/update', {
      params: { taskId: created.taskId, inputResponses: { ok: { action: 'accept', content: {} }, junk: 'x' } },
      capabilities
    })
    t.assert.strictEqual(update.json().error, undefined, update.body)
    await until(() => received !== undefined)
    t.assert.deepStrictEqual(received, { action: 'accept', content: {} })
  })

  test('the client mirrors only arguments that are its own properties', async (t: TestContext) => {
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({
        name: 'ctor-tool',
        inputSchema: { type: 'object', properties: { constructor: { type: 'string', 'x-mcp-header': 'Ctor' } } }
      }, async () => ({ content: [{ type: 'text', text: 'ran' }] }))
    })
    const client = app.mcpClient({ protocolVersion: LATEST_PROTOCOL_VERSION })
    // Listing tells the client which arguments the headers mirror.
    await client.listTools()
    const response = await client.callTool('ctor-tool', {})
    t.assert.strictEqual((response as any).body?.result?.content?.[0]?.text, 'ran', JSON.stringify(response))
  })

  test('stdio requests skip resolveAuthorizationContext, and hooks can tell them apart', async (t: TestContext) => {
    const marked: boolean[] = []
    const app = Fastify()
    t.after(() => app.close())
    await app.register(mcpPlugin, {
      serverInfo: { name: 'test-server', version: '1.0.0' },
      // The README pattern: it reads what an authentication hook set.
      resolveAuthorizationContext: async (request: any) => ({ userId: request.user.id })
    })
    app.addHook('preHandler', async (request) => { marked.push(isStdioRequest(request)) })
    await app.ready()

    const { input, waitFor } = stdioHarness(t, app)
    input.write(JSON.stringify(modernBody('server/discover', { id: 'd' })) + '\n')
    const answer = await waitFor(line => line.id === 'd')
    t.assert.ok(answer?.result, JSON.stringify(answer))
    t.assert.deepStrictEqual(marked, [true])
  })
})

describe('round 6: input rounds, hooks, client retries and stdio', () => {
  const formCapabilities: ClientCapabilities = { elicitation: { form: {} } }
  const taskCapabilities: ClientCapabilities = { extensions: { [TASKS_EXTENSION]: {} }, elicitation: { form: {} } }
  const accept = (value: string) => ({ action: 'accept', content: { value } })

  /** Asks for `a`, then once that is answered for `b`, then joins both. */
  function twoStepTool (app: FastifyInstance, taskSupport?: 'optional' | 'required') {
    app.mcpAddTool({
      name: 'two',
      inputSchema: Type.Object({}),
      ...(taskSupport ? { execution: { taskSupport } } : {})
    } as any, async (_args: any, context: any) => {
      const answers = context.inputResponses ?? {}
      if (!answers.a) throw new InputRequired({ inputRequests: { a: elicitForm('A?', { type: 'object', properties: {} }) }, state: 1 })
      if (!answers.b) throw new InputRequired({ inputRequests: { b: elicitForm('B?', { type: 'object', properties: {} }) }, state: 2 })
      return { content: [{ type: 'text', text: `${answers.a.content.value}+${answers.b.content.value}` }] }
    })
  }

  async function awaitStatus (app: FastifyInstance, taskId: string, status: string) {
    let task: any
    for (let attempt = 0; attempt < 100 && task?.status !== status; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10))
      task = (await call(app, 'tasks/get', { params: { taskId }, capabilities: taskCapabilities })).json().result
    }
    return task
  }

  test('a sync retry sees the answers of every earlier round', async (t: TestContext) => {
    const app = await buildServer(t, (app) => twoStepTool(app))
    const first = (await call(app, 'tools/call', { params: { name: 'two', arguments: {} }, capabilities: formCapabilities })).json().result
    t.assert.deepStrictEqual(Object.keys(first.inputRequests), ['a'])

    const second = (await call(app, 'tools/call', {
      id: 2,
      capabilities: formCapabilities,
      params: { name: 'two', arguments: {}, requestState: first.requestState, inputResponses: { a: accept('x') } }
    })).json().result
    t.assert.deepStrictEqual(Object.keys(second.inputRequests), ['b'])

    // Only the latest round's answer is sent, as the spec's client would.
    const third = await call(app, 'tools/call', {
      id: 3,
      capabilities: formCapabilities,
      params: { name: 'two', arguments: {}, requestState: second.requestState, inputResponses: { b: accept('y') } }
    })
    t.assert.strictEqual(third.json().result?.content?.[0]?.text, 'x+y', third.body)
  })

  test('a key asked again takes its new answer', async (t: TestContext) => {
    const seen: unknown[] = []
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({ name: 'again', inputSchema: Type.Object({}) }, async (_args: any, context: any) => {
        const answer = context.inputResponses?.a
        seen.push(answer?.content?.value)
        if (answer?.content?.value !== 'good') {
          throw new InputRequired({ inputRequests: { a: elicitForm('A?', { type: 'object', properties: {} }) } })
        }
        return { content: [{ type: 'text', text: 'ok' }] }
      })
    })
    const first = (await call(app, 'tools/call', { params: { name: 'again', arguments: {} }, capabilities: formCapabilities })).json().result
    const second = (await call(app, 'tools/call', {
      id: 2,
      capabilities: formCapabilities,
      params: { name: 'again', arguments: {}, requestState: first.requestState, inputResponses: { a: accept('bad') } }
    })).json().result
    t.assert.strictEqual(second.resultType, 'input_required')
    // The retry answers nothing: the rejected answer must not come back.
    const third = (await call(app, 'tools/call', {
      id: 3,
      capabilities: formCapabilities,
      params: { name: 'again', arguments: {}, requestState: second.requestState, inputResponses: {} }
    })).json().result
    t.assert.strictEqual(third.resultType, 'input_required')
    t.assert.deepStrictEqual(seen, [undefined, 'bad', undefined])
  })

  test('a sync retry that becomes a task keeps the answers it brought', async (t: TestContext) => {
    const app = await buildServer(t, (app) => twoStepTool(app, 'optional'), { enableTasks: true })
    // Without the extension the call runs synchronously and asks for `a`.
    const first = (await call(app, 'tools/call', { params: { name: 'two', arguments: {} }, capabilities: formCapabilities })).json().result
    t.assert.strictEqual(first.resultType, 'input_required')

    const created = (await call(app, 'tools/call', {
      id: 2,
      capabilities: taskCapabilities,
      params: { name: 'two', arguments: {}, requestState: first.requestState, inputResponses: { a: accept('x') } }
    })).json().result
    t.assert.strictEqual(created.resultType, 'task')

    const waiting = await awaitStatus(app, created.taskId, 'input_required')
    t.assert.deepStrictEqual(Object.keys(waiting.inputRequests), ['b'])
    await call(app, 'tasks/update', { params: { taskId: created.taskId, inputResponses: { b: accept('y') } }, capabilities: taskCapabilities })
    const done = await awaitStatus(app, created.taskId, 'completed')
    t.assert.strictEqual(done?.result?.content?.[0]?.text, 'x+y', JSON.stringify(done))
  })

  test('task input requests drop the fields 2026-07-28 removed', async (t: TestContext) => {
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({ name: 'go', inputSchema: Type.Object({}), execution: { taskSupport: 'required' } } as any, async () => {
        const request = elicitUrl('Go', 'https://example.com/x')
        throw new InputRequired({ inputRequests: { u: { ...request, params: { ...request.params, elicitationId: 'legacy-id' } } as any } })
      })
    }, { enableTasks: true })
    const capabilities: ClientCapabilities = { extensions: { [TASKS_EXTENSION]: {} }, elicitation: { url: {} } }
    const created = (await call(app, 'tools/call', { params: { name: 'go', arguments: {} }, capabilities })).json().result
    let task: any
    for (let attempt = 0; attempt < 100 && task?.status !== 'input_required'; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10))
      task = (await call(app, 'tasks/get', { params: { taskId: created.taskId }, capabilities })).json().result
    }
    t.assert.strictEqual(task.inputRequests.u.params.url, 'https://example.com/x')
    t.assert.strictEqual('elicitationId' in task.inputRequests.u.params, false)
    await call(app, 'tasks/cancel', { params: { taskId: created.taskId }, capabilities })
  })

  test('onToolCallComplete fires once for a task that asked for input, timed from its start', async (t: TestContext) => {
    const events: any[] = []
    const app = await buildServer(t, (app) => twoStepTool(app, 'required'), {
      enableTasks: true,
      onToolCallComplete: (event: any) => { events.push(event) }
    })
    const created = (await call(app, 'tools/call', { params: { name: 'two', arguments: {} }, capabilities: taskCapabilities })).json().result
    await awaitStatus(app, created.taskId, 'input_required')
    await new Promise(resolve => setTimeout(resolve, 50))
    await call(app, 'tasks/update', { params: { taskId: created.taskId, inputResponses: { a: accept('x') } }, capabilities: taskCapabilities })
    await awaitStatus(app, created.taskId, 'input_required')
    await call(app, 'tasks/update', { params: { taskId: created.taskId, inputResponses: { b: accept('y') } }, capabilities: taskCapabilities })
    await awaitStatus(app, created.taskId, 'completed')
    await until(() => events.length > 0)

    t.assert.deepStrictEqual(events.map(event => [event.source, event.outcome.ok]), [['task', true]])
    t.assert.ok(events[0].durationMs >= 50, `durationMs ${events[0].durationMs}`)
  })

  test('onToolCallComplete reports a task cancelled while waiting as task-ended', async (t: TestContext) => {
    const events: any[] = []
    const app = await buildServer(t, (app) => twoStepTool(app, 'required'), {
      enableTasks: true,
      onToolCallComplete: (event: any) => { events.push(event) }
    })
    const created = (await call(app, 'tools/call', { params: { name: 'two', arguments: {} }, capabilities: taskCapabilities })).json().result
    await awaitStatus(app, created.taskId, 'input_required')
    t.assert.strictEqual(events.length, 0)
    await call(app, 'tasks/cancel', { params: { taskId: created.taskId }, capabilities: taskCapabilities })
    await until(() => events.length > 0)
    t.assert.deepStrictEqual(events.map(event => [event.source, event.outcome.reason, event.outcome.status]), [['task', 'task-ended', 'cancelled']])
  })

  test('a header value that only looks like the Base64 sentinel is a mismatch', async (t: TestContext) => {
    const seen: unknown[] = []
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({
        name: 'tenant-tool',
        inputSchema: { type: 'object', properties: { tenant: { type: 'string', 'x-mcp-header': 'Tenant' } } }
      }, async (args: any) => {
        seen.push(args.tenant)
        return { content: [{ type: 'text', text: 'ran' }] }
      })
    })
    const response = await call(app, 'tools/call', {
      params: { name: 'tenant-tool', arguments: { tenant: '' } },
      headers: { 'mcp-param-tenant': '=?base64?=' }
    })
    t.assert.strictEqual(response.statusCode, 400)
    t.assert.strictEqual(response.json().error.code, HEADER_MISMATCH)
    t.assert.deepStrictEqual(seen, [])
  })

  test('the client refreshes tools/list and retries once after a header mismatch', async (t: TestContext) => {
    const methods: string[] = []
    const app = await buildServer(t, (app) => {
      app.addHook('preHandler', async (request) => { methods.push((request.body as any)?.method) })
      app.mcpAddTool({
        name: 'geo',
        inputSchema: { type: 'object', properties: { region: { type: 'string', 'x-mcp-header': 'Region' } } }
      }, async (args: any) => ({ content: [{ type: 'text', text: `in ${args.region}` }] }))
    })
    const client = app.mcpClient({ protocolVersion: LATEST_PROTOCOL_VERSION })
    // No listTools() first: the client cannot know the header yet.
    const response = await client.callTool('geo', { region: 'eu' })
    t.assert.strictEqual((response as any).body?.result?.content?.[0]?.text, 'in eu', JSON.stringify(response.body))
    t.assert.deepStrictEqual(methods, ['tools/call', 'tools/list', 'tools/call'])

    // A mismatch the refresh cannot fix is returned, not retried.
    methods.length = 0
    const forced = await client.callTool('geo', { region: 'eu' }, { headers: { 'mcp-param-region': 'us' } })
    t.assert.strictEqual((forced as any).body?.error?.code, HEADER_MISMATCH)
    t.assert.deepStrictEqual(methods, ['tools/call', 'tools/list'])
  })

  test('stdio initialize does not advertise notifications it cannot deliver', async (t: TestContext) => {
    const app = await buildServer(t, undefined, {
      enableSSE: true,
      capabilities: { tools: { listChanged: true }, resources: { subscribe: true, listChanged: true } }
    })
    const { input, waitFor } = stdioHarness(t, app)
    input.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 'init',
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'c', version: '1' } }
    }) + '\n')
    const answer = await waitFor(line => line.id === 'init')
    t.assert.deepStrictEqual(answer?.result?.capabilities, { tools: {}, resources: {} }, JSON.stringify(answer))
  })
})

describe('round 7: answer budget, task rounds, answer checks and streaming', () => {
  const formCapabilities: ClientCapabilities = { elicitation: { form: {} } }
  const taskCapabilities: ClientCapabilities = { extensions: { [TASKS_EXTENSION]: {} }, elicitation: { form: {} } }
  const everyInput: ClientCapabilities = {
    elicitation: { form: {}, url: {} },
    sampling: { tools: {}, context: {} },
    roots: {}
  }
  const nameSchema = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } as const

  async function awaitStatus (app: FastifyInstance, taskId: string, status: string, capabilities = taskCapabilities) {
    let task: any
    for (let attempt = 0; attempt < 300 && task?.status !== status; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10))
      task = (await call(app, 'tasks/get', { params: { taskId }, capabilities })).json().result
    }
    return task
  }

  function progressCall (app: FastifyInstance, name: string, capabilities: ClientCapabilities, accept?: string) {
    const body = modernBody('tools/call', { params: { name, arguments: {} }, capabilities }) as any
    body.params._meta.progressToken = 'p'
    return app.inject({
      method: 'POST',
      url: '/mcp',
      headers: modernHeaders('tools/call', { params: { name }, ...(accept ? { headers: { accept } } : {}) }),
      payload: body
    })
  }

  test('carried answers past requestStateMaxAnswerBytes fail the request rather than vanish', async (t: TestContext) => {
    const seen: string[][] = []
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({ name: 'steps', inputSchema: Type.Object({}) }, async (_args: any, context: any) => {
        seen.push(Object.keys(context.inputResponses ?? {}))
        const step = (context.requestState as number | undefined) ?? 0
        if (step === 3) return { content: [{ type: 'text', text: 'done' }] }
        throw new InputRequired({ inputRequests: { [`k${step}`]: elicitForm('?', { type: 'object', properties: {} }) }, state: step + 1 })
      })
    }, { requestStateMaxAnswerBytes: 400 })

    let previous = (await call(app, 'tools/call', { params: { name: 'steps', arguments: {} }, capabilities: formCapabilities })).json().result
    const retry = async (step: number) => (await call(app, 'tools/call', {
      id: step + 2,
      capabilities: formCapabilities,
      params: {
        name: 'steps',
        arguments: {},
        requestState: previous.requestState,
        inputResponses: { [`k${step}`]: { action: 'accept', content: { v: 'x'.repeat(250) } } }
      }
    })).json()

    // One ~280 byte answer fits in 400.
    previous = (await retry(0)).result
    t.assert.strictEqual(previous.resultType, 'input_required')
    // Two do not: the handler would have to be told one is gone, so the
    // request fails instead. The answers' size is the client's doing, so it
    // is invalid params, not a server fault.
    const failed = await retry(1)
    t.assert.strictEqual(failed.error?.code, INVALID_PARAMS, JSON.stringify(failed))
    t.assert.match(failed.error.message, /requestStateMaxAnswerBytes/)
    t.assert.deepStrictEqual(seen, [[], ['k0'], ['k0', 'k1']])
  })

  test('requestStateMaxAnswerBytes: 0 carries no answers', async (t: TestContext) => {
    const seen: string[][] = []
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({ name: 'steps', inputSchema: Type.Object({}) }, async (_args: any, context: any) => {
        seen.push(Object.keys(context.inputResponses ?? {}))
        const step = (context.requestState as number | undefined) ?? 0
        if (step === 2) return { content: [{ type: 'text', text: 'done' }] }
        throw new InputRequired({ inputRequests: { [`k${step}`]: elicitForm('?', { type: 'object', properties: {} }) }, state: step + 1 })
      })
    }, { requestStateMaxAnswerBytes: 0 })
    let previous = (await call(app, 'tools/call', { params: { name: 'steps', arguments: {} }, capabilities: formCapabilities })).json().result
    for (let step = 0; step < 2; step++) {
      previous = (await call(app, 'tools/call', {
        id: step + 2,
        capabilities: formCapabilities,
        params: { name: 'steps', arguments: {}, requestState: previous.requestState, inputResponses: { [`k${step}`]: { action: 'accept', content: {} } } }
      })).json().result
    }
    t.assert.deepStrictEqual(seen, [[], ['k0'], ['k1']])
  })

  test('requestStateMaxAnswerBytes and taskMaxInputRounds are validated', async (t: TestContext) => {
    for (const options of [{ requestStateMaxAnswerBytes: -1 }, { requestStateMaxAnswerBytes: Number.NaN }, { taskMaxInputRounds: 1.5 }]) {
      const app = Fastify()
      t.after(() => app.close())
      await t.assert.rejects(async () => {
        await app.register(mcpPlugin, options as any)
        await app.ready()
      }, /must be a non-negative integer/)
    }
  })

  test('a task fails once taskMaxInputRounds is exhausted', async (t: TestContext) => {
    let calls = 0
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({ name: 'nag', inputSchema: Type.Object({}), execution: { taskSupport: 'required' } } as any, async () => {
        calls++
        throw new InputRequired({ inputRequests: { [`q${calls}`]: elicitForm('?', { type: 'object', properties: {} }) } })
      })
    }, { enableTasks: true, taskMaxInputRounds: 2 })
    const created = (await call(app, 'tools/call', { params: { name: 'nag', arguments: {} }, capabilities: taskCapabilities })).json().result
    for (let round = 1; round <= 2; round++) {
      const waiting = await awaitStatus(app, created.taskId, 'input_required')
      const key = Object.keys(waiting.inputRequests)[0]
      await call(app, 'tasks/update', { params: { taskId: created.taskId, inputResponses: { [key]: { action: 'accept', content: {} } } }, capabilities: taskCapabilities })
      await until(() => calls > round)
    }
    const failed = await awaitStatus(app, created.taskId, 'failed')
    t.assert.match(failed.statusMessage, /after 2 rounds/)
    t.assert.strictEqual(calls, 3)
  })

  test('a task round that only carries state waits the poll interval', async (t: TestContext) => {
    const times: number[] = []
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({ name: 'wait', inputSchema: Type.Object({}), execution: { taskSupport: 'required' } } as any, async (_args: any, context: any) => {
        times.push(Date.now())
        if (context.requestState === undefined) throw new InputRequired({ state: 'again' })
        return { content: [{ type: 'text', text: 'ok' }] }
      })
    }, { enableTasks: true })
    const created = (await call(app, 'tools/call', { params: { name: 'wait', arguments: {} }, capabilities: taskCapabilities })).json().result
    const done = await awaitStatus(app, created.taskId, 'completed')
    t.assert.strictEqual(done?.result?.content?.[0]?.text, 'ok')
    t.assert.ok(times[1] - times[0] >= 900, `re-ran after ${times[1] - times[0]}ms`)
  })

  test('accepted elicitation content must match the requested schema', async (t: TestContext) => {
    const seen: unknown[] = []
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({ name: 'ask', inputSchema: Type.Object({}) }, async (_args: any, context: any) => {
        const answer = context.inputResponses?.who
        if (!answer) throw new InputRequired({ inputRequests: { who: elicitForm('Who?', nameSchema as any) } })
        seen.push(answer)
        return { content: [{ type: 'text', text: 'ok' }] }
      })
    })
    const first = (await call(app, 'tools/call', { params: { name: 'ask', arguments: {} }, capabilities: formCapabilities })).json().result
    const retry = (inputResponses: Record<string, unknown>) => call(app, 'tools/call', {
      id: 2,
      capabilities: formCapabilities,
      params: { name: 'ask', arguments: {}, requestState: first.requestState, inputResponses }
    })

    for (const bad of [{ action: 'accept', content: { name: 42 } }, { action: 'accept', content: {} }, { action: 'accept' }]) {
      const response = (await retry({ who: bad })).json()
      t.assert.strictEqual(response.error?.code, INVALID_PARAMS, JSON.stringify(bad))
      t.assert.match(response.error.message, /inputResponses\.who\.content/)
    }
    t.assert.deepStrictEqual(seen, [])

    // A decline is not checked: its content means nothing.
    t.assert.strictEqual((await retry({ who: { action: 'decline', content: { name: 42 } } })).json().result?.resultType, 'complete')
    t.assert.strictEqual((await retry({ who: { action: 'accept', content: { name: 'Ada' } } })).json().result?.resultType, 'complete')
    t.assert.strictEqual(seen.length, 2)
  })

  test('an accepted URL-mode elicitation carries no content', async (t: TestContext) => {
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({ name: 'link', inputSchema: Type.Object({}) }, async (_args: any, context: any) => {
        if (!context.inputResponses?.u) throw new InputRequired({ inputRequests: { u: elicitUrl('Sign in', 'https://example.com/auth') } })
        return { content: [{ type: 'text', text: 'ok' }] }
      })
    })
    const capabilities: ClientCapabilities = { elicitation: { url: {} } }
    const first = (await call(app, 'tools/call', { params: { name: 'link', arguments: {} }, capabilities })).json().result
    const retry = (answer: unknown) => call(app, 'tools/call', {
      id: 2, capabilities, params: { name: 'link', arguments: {}, requestState: first.requestState, inputResponses: { u: answer } }
    })
    t.assert.strictEqual((await retry({ action: 'accept', content: { token: 'x' } })).json().error?.code, INVALID_PARAMS)
    t.assert.strictEqual((await retry({ action: 'accept' })).json().result?.resultType, 'complete')
  })

  test('tasks/update checks accepted content against the requested schema', async (t: TestContext) => {
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({ name: 'ask', inputSchema: Type.Object({}), execution: { taskSupport: 'required' } } as any, async (_args: any, context: any) => {
        const answer = context.inputResponses?.who
        if (!answer) throw new InputRequired({ inputRequests: { who: elicitForm('Who?', nameSchema as any) } })
        return { content: [{ type: 'text', text: answer.content.name }] }
      })
    }, { enableTasks: true })
    const created = (await call(app, 'tools/call', { params: { name: 'ask', arguments: {} }, capabilities: taskCapabilities })).json().result
    await awaitStatus(app, created.taskId, 'input_required')
    const bad = (await call(app, 'tasks/update', {
      params: { taskId: created.taskId, inputResponses: { who: { action: 'accept', content: { name: 1 } } } },
      capabilities: taskCapabilities
    })).json()
    t.assert.strictEqual(bad.error?.code, INVALID_PARAMS)
    await call(app, 'tasks/update', {
      params: { taskId: created.taskId, inputResponses: { who: { action: 'accept', content: { name: 'Ada' } } } },
      capabilities: taskCapabilities
    })
    const done = await awaitStatus(app, created.taskId, 'completed')
    t.assert.strictEqual(done?.result?.content?.[0]?.text, 'Ada')
  })

  test('tasks/update ignores keys it was not asked, including malformed ones', async (t: TestContext) => {
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({ name: 'ask', inputSchema: Type.Object({}), execution: { taskSupport: 'required' } } as any, async (_args: any, context: any) => {
        const answer = context.inputResponses?.q
        if (!answer) throw new InputRequired({ inputRequests: { q: elicitForm('?', { type: 'object', properties: {} }) } })
        return { content: [{ type: 'text', text: Object.keys(context.inputResponses).join(',') }] }
      })
    }, { enableTasks: true })
    const created = (await call(app, 'tools/call', { params: { name: 'ask', arguments: {} }, capabilities: taskCapabilities })).json().result
    await awaitStatus(app, created.taskId, 'input_required')
    const update = await call(app, 'tasks/update', {
      params: { taskId: created.taskId, inputResponses: { '\ud800': { action: 'accept' }, later: { anything: true }, q: { action: 'accept', content: {} } } },
      capabilities: taskCapabilities
    })
    t.assert.strictEqual(update.json().error, undefined, update.body)
    const done = await awaitStatus(app, created.taskId, 'completed')
    t.assert.strictEqual(done?.result?.content?.[0]?.text, 'q')
  })

  test('the task store accepts no new input for a round that has moved on', async (t: TestContext) => {
    const store = new MemoryTaskStore()
    const now = new Date().toISOString()
    await store.create({
      taskId: 't',
      status: 'input_required',
      createdAt: now,
      lastUpdatedAt: now,
      ttl: 60_000,
      inputRequests: { next: { method: 'elicitation/create', params: {} } as any },
      inputRequestRound: 2
    } as any)
    const stale = await store.updateInputResponses('t', { next: { action: 'accept', content: {} } }, 'r1', 1)
    t.assert.deepStrictEqual(stale?.responses, {})
    const current = await store.updateInputResponses('t', { next: { action: 'accept', content: {} } }, 'r2', 2)
    t.assert.deepStrictEqual(Object.keys(current?.responses ?? {}), ['next'])
  })

  test('onToolCallComplete reports a task cancelled after its handler returned as task-ended', async (t: TestContext) => {
    const events: any[] = []
    let release!: () => void
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({ name: 'slow', inputSchema: Type.Object({}), execution: { taskSupport: 'required' } } as any, async () => {
        await new Promise<void>(resolve => { release = resolve })
        return { content: [{ type: 'text', text: 'ignored the signal' }] }
      })
    }, { enableTasks: true, onToolCallComplete: (event: any) => { events.push(event) } })
    const created = (await call(app, 'tools/call', { params: { name: 'slow', arguments: {} }, capabilities: taskCapabilities })).json().result
    await until(() => release !== undefined)
    await call(app, 'tasks/cancel', { params: { taskId: created.taskId }, capabilities: taskCapabilities })
    release()
    await until(() => events.length > 0)
    t.assert.deepStrictEqual(events.map(event => [event.outcome.reason, event.outcome.status]), [['task-ended', 'cancelled']])
  })

  test('onToolCallComplete reports a task out of input rounds as task-ended', async (t: TestContext) => {
    const events: any[] = []
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({ name: 'nag', inputSchema: Type.Object({}), execution: { taskSupport: 'required' } } as any, async () => {
        throw new InputRequired({ inputRequests: { again: elicitForm('Again?', { type: 'object', properties: {} }) } })
      })
    }, { enableTasks: true, taskMaxInputRounds: 0, onToolCallComplete: (event: any) => { events.push(event) } })
    await call(app, 'tools/call', { params: { name: 'nag', arguments: {} }, capabilities: taskCapabilities })
    await until(() => events.length > 0)
    t.assert.deepStrictEqual(events.map(event => [event.outcome.reason, event.outcome.status]), [['task-ended', 'failed']])
  })

  test('an outputSchema that cannot compile is refused at registration', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())
    await app.register(mcpPlugin)
    for (const outputSchema of [{ type: 'strin' }, { $ref: 'https://example.com/schema.json' }]) {
      t.assert.throws(() => app.mcpAddTool({ name: 'broken', inputSchema: Type.Object({}), outputSchema } as any, async () => ({ content: [] })),
        /Invalid output schema for 'broken'/)
    }
  })

  test('a broadcast that cannot be delivered does not become an unhandled rejection', async (t: TestContext) => {
    const rejections: unknown[] = []
    const onRejection = (reason: unknown) => { rejections.push(reason) }
    process.on('unhandledRejection', onRejection)
    t.after(() => process.off('unhandledRejection', onRejection))

    const app = await buildServer(t, undefined, { capabilities: { tools: { listChanged: true } } })
    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payloadAsStream: true,
      headers: modernHeaders('subscriptions/listen'),
      payload: modernBody('subscriptions/listen', { params: { notifications: { toolsListChanged: true } } })
    })
    const stream = response.stream()
    t.after(() => stream.destroy())
    await new Promise(resolve => stream.once('data', resolve))

    await app.mcpBroadcastNotification({ jsonrpc: JSONRPC_VERSION, method: 'notifications/tools/list_changed', params: { big: 1n } as any })
    await new Promise(resolve => setTimeout(resolve, 50))
    t.assert.deepStrictEqual(rejections, [])
  })

  test('stdio listen streams wait for stdout to drain', async (t: TestContext) => {
    const app = await buildServer(t, undefined, { capabilities: { tools: { listChanged: true } } })
    const input = new PassThrough()
    const output = new PassThrough({ highWaterMark: 16 * 1024 })
    const transport = createStdioTransport(app, { input, output, error: new PassThrough() })
    transport.start()
    t.after(() => transport.stop())

    input.write(JSON.stringify(modernBody('subscriptions/listen', { id: 'l', params: { notifications: { toolsListChanged: true } } })) + '\n')
    await until(() => output.readableLength > 0)
    const pad = 'x'.repeat(10_000)
    for (let i = 0; i < 400; i++) {
      await app.mcpBroadcastNotification({ jsonrpc: JSONRPC_VERSION, method: 'notifications/tools/list_changed', params: { pad } as any })
      await new Promise(resolve => setImmediate(resolve))
    }
    // 4 MB were broadcast to a reader that never reads; without backpressure
    // all of it would sit in stdout's buffer.
    t.assert.ok(output.writableLength < 2 * 1024 * 1024, `stdout buffered ${output.writableLength} bytes`)
  })

  test('progress waits for the outcome when the client may lack an input capability', async (t: TestContext) => {
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({ name: 'ask-late', inputSchema: Type.Object({}) }, async (_args: any, context: any) => {
        context.sendProgress(1)
        await new Promise(resolve => setTimeout(resolve, 300))
        throw new InputRequired({ inputRequests: { q: elicitForm('Name?', { type: 'object', properties: {} }) } })
      })
    })
    const refused = await progressCall(app, 'ask-late', {})
    t.assert.strictEqual(refused.statusCode, 400)
    t.assert.strictEqual(refused.json().error.code, MISSING_REQUIRED_CLIENT_CAPABILITY)

    // A client that declared every input capability can never be refused, so
    // its progress streams.
    const streamed = await progressCall(app, 'ask-late', everyInput)
    t.assert.strictEqual(streamed.statusCode, 200)
    t.assert.match(String(streamed.headers['content-type']), /text\/event-stream/)
  })

  test('a tool declaring inputCapabilities streams for clients that have them', async (t: TestContext) => {
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({
        name: 'form-only',
        inputSchema: Type.Object({}),
        inputCapabilities: { elicitation: { form: {} } }
      }, async (_args: any, context: any) => {
        context.sendProgress(1)
        await new Promise(resolve => setTimeout(resolve, 300))
        if (context.inputResponses?.q) return { content: [{ type: 'text', text: 'ok' }] }
        throw new InputRequired({ inputRequests: { q: elicitForm('Name?', { type: 'object', properties: {} }) } })
      })
      app.mcpAddTool({
        name: 'liar',
        inputSchema: Type.Object({}),
        inputCapabilities: { elicitation: { form: {} } }
      }, async (_args: any, context: any) => {
        context.sendProgress(1)
        await new Promise(resolve => setTimeout(resolve, 300))
        throw new InputRequired({ inputRequests: { u: elicitUrl('Go', 'https://example.com/x') } })
      })
    })
    const listed = (await call(app, 'tools/list')).json().result.tools
    t.assert.ok(listed.every((tool: any) => !('inputCapabilities' in tool)))

    const streamed = await progressCall(app, 'form-only', formCapabilities)
    t.assert.strictEqual(streamed.statusCode, 200)
    t.assert.match(String(streamed.headers['content-type']), /text\/event-stream/)
    t.assert.match(streamed.body, /"resultType":"input_required"/)

    // Asking beyond the declaration after streaming is the tool's bug.
    const lied = await progressCall(app, 'liar', formCapabilities)
    t.assert.strictEqual(lied.statusCode, 200)
    t.assert.match(lied.body, new RegExp(`"code":${INTERNAL_ERROR}`))
  })

  test('an explicitly refused text/event-stream gets JSON', async (t: TestContext) => {
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({ name: 'report', inputSchema: Type.Object({}) }, async (_args: any, context: any) => {
        context.sendProgress(1)
        await new Promise(resolve => setTimeout(resolve, 300))
        return { content: [{ type: 'text', text: 'ok' }] }
      })
    })
    const response = await progressCall(app, 'report', everyInput, 'application/json, text/event-stream;q=0')
    t.assert.match(String(response.headers['content-type']), /application\/json/)
    t.assert.strictEqual(response.json().result.content[0].text, 'ok')
  })

  test('server/discover is uncacheable on a request carrying inputResponses', async (t: TestContext) => {
    const app = await buildServer(t, undefined, { caching: { discover: { ttlMs: 60_000, cacheScope: 'public' } } })
    const plain = (await call(app, 'server/discover')).json().result
    t.assert.strictEqual(plain.ttlMs, 60_000)
    const retry = (await call(app, 'server/discover', { params: { inputResponses: {} } })).json().result
    t.assert.strictEqual(retry.ttlMs, 0)
    t.assert.strictEqual(retry.cacheScope, 'private')
  })
})

describe('round 8: header BOM, answer schemas, listen deadlines and task limits', () => {
  const formCapabilities: ClientCapabilities = { elicitation: { form: {} } }
  const taskCapabilities: ClientCapabilities = { extensions: { [TASKS_EXTENSION]: {} }, elicitation: { form: {} } }

  async function awaitTask (app: FastifyInstance, taskId: string, done: (task: any) => boolean, attempts = 300) {
    let task: any
    for (let attempt = 0; attempt < attempts && !(task && done(task)); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10))
      task = (await call(app, 'tasks/get', { params: { taskId }, capabilities: taskCapabilities })).json().result
    }
    return task
  }

  test('a byte-order mark in a Base64 header value is a mismatch, not ignored', async (t: TestContext) => {
    const ran: string[] = []
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({ name: 'delete_all', inputSchema: Type.Object({}) }, async () => {
        ran.push('delete_all')
        return { content: [] }
      })
    })
    const withBom = `=?base64?${Buffer.from('﻿delete_all', 'utf8').toString('base64')}?=`
    const response = await call(app, 'tools/call', { params: { name: 'delete_all', arguments: {} }, headers: { 'mcp-name': withBom } })
    t.assert.strictEqual(response.statusCode, 400)
    t.assert.strictEqual(response.json().error.code, HEADER_MISMATCH)
    t.assert.deepStrictEqual(ran, [])
  })

  function amountTool (app: FastifyInstance, requestedSchema: Record<string, unknown>, seen: unknown[]) {
    app.mcpAddTool({ name: 'pay', inputSchema: Type.Object({}) }, async (_args: any, context: any) => {
      const answer = context.inputResponses?.amount
      if (!answer) throw new InputRequired({ inputRequests: { amount: elicitForm('How much?', requestedSchema as any) } })
      seen.push(answer.content)
      return { content: [{ type: 'text', text: 'paid' }] }
    })
  }

  async function answerAmount (app: FastifyInstance, content: Record<string, unknown>) {
    const first = (await call(app, 'tools/call', { params: { name: 'pay', arguments: {} }, capabilities: formCapabilities })).json()
    if (first.error) return first
    return (await call(app, 'tools/call', {
      id: 2,
      capabilities: formCapabilities,
      params: { name: 'pay', arguments: {}, requestState: first.result.requestState, inputResponses: { amount: { action: 'accept', content } } }
    })).json()
  }

  test('a draft-07 requestedSchema still holds answers to it', async (t: TestContext) => {
    const seen: unknown[] = []
    const app = await buildServer(t, (app) => amountTool(app, {
      $schema: 'http://json-schema.org/draft-07/schema#',
      $id: 'urn:x',
      type: 'object',
      properties: { amount: { type: 'integer', maximum: 10, description: 'At most ten', default: 1 } },
      required: ['amount']
    }, seen))

    const refused = await answerAmount(app, { amount: 1e9 })
    t.assert.strictEqual(refused.error?.code, INVALID_PARAMS, JSON.stringify(refused))
    t.assert.match(refused.error.message, /must be <= 10/)
    t.assert.deepStrictEqual(seen, [])

    const accepted = await answerAmount(app, { amount: 5 })
    t.assert.strictEqual(accepted.result?.content?.[0]?.text, 'paid')
    t.assert.deepStrictEqual(seen, [{ amount: 5 }])
  })

  test('a requestedSchema that cannot be compiled fails when the handler asks', async (t: TestContext) => {
    const seen: unknown[] = []
    const app = await buildServer(t, (app) => amountTool(app, {
      type: 'object',
      // Not a valid pattern under the `u` flag JSON Schema regexes use
      properties: { amount: { type: 'string', pattern: '^[\\w-.]+$' } }
    }, seen))
    const response = (await call(app, 'tools/call', { params: { name: 'pay', arguments: {} }, capabilities: formCapabilities })).json()
    t.assert.strictEqual(response.error?.code, INTERNAL_ERROR, JSON.stringify(response))
  })

  test('an input request keyed __proto__ is refused rather than silently dropped', async (t: TestContext) => {
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({ name: 'proto', inputSchema: Type.Object({}) }, async () => {
        const inputRequests = Object.defineProperty({}, '__proto__', {
          value: elicitForm('?', { type: 'object', properties: {} }),
          enumerable: true
        })
        throw new InputRequired({ inputRequests })
      })
    })
    const response = (await call(app, 'tools/call', { params: { name: 'proto', arguments: {} }, capabilities: formCapabilities })).json()
    t.assert.strictEqual(response.error?.code, INTERNAL_ERROR, JSON.stringify(response))
  })

  test('inputCapabilities members must be objects', async (t: TestContext) => {
    const app = await buildServer(t)
    t.assert.throws(() => app.mcpAddTool({ name: 'bad', inputSchema: Type.Object({}), inputCapabilities: { elicitation: null } } as any, async () => ({ content: [] })),
      /Invalid inputCapabilities for 'bad': 'elicitation' must be an object/)
    t.assert.throws(() => app.mcpAddTool({ name: 'bad2', inputSchema: Type.Object({}), inputCapabilities: { sampling: { tools: 1 } } } as any, async () => ({ content: [] })),
      /'sampling.tools' must be an object/)
  })

  test('a numeric id that is not a safe integer is refused, not echoed changed', async (t: TestContext) => {
    const app = await buildServer(t)
    const body = JSON.stringify(modernBody('tools/list')).replace('"id":1', '"id":9007199254740993')
    const response = await app.inject({ method: 'POST', url: '/mcp', headers: modernHeaders('tools/list'), payload: body })
    t.assert.strictEqual(response.statusCode, 400)
    t.assert.strictEqual(response.json().error.code, INVALID_REQUEST)
    t.assert.strictEqual(response.json().id, null)
  })

  test('rounds that only carry state do not count toward taskMaxInputRounds', async (t: TestContext) => {
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({ name: 'poller', inputSchema: Type.Object({}), execution: { taskSupport: 'required' } } as any, async (_args: any, context: any) => {
        const step = (context.requestState as number | undefined) ?? 0
        if (step < 2) throw new InputRequired({ state: step + 1 })
        return { content: [{ type: 'text', text: `polled ${step}` }] }
      })
    }, { enableTasks: true, taskMaxInputRounds: 1 })
    const created = (await call(app, 'tools/call', { params: { name: 'poller', arguments: {} }, capabilities: taskCapabilities })).json().result
    // Each state-only round waits the poll interval (1s).
    const task = await awaitTask(app, created.taskId, task => task.status !== 'working', 400)
    t.assert.strictEqual(task.status, 'completed', JSON.stringify(task))
    t.assert.strictEqual(task.result.content[0].text, 'polled 2')
  })

  test('over the per-caller cap, required and optional tasks are both refused', async (t: TestContext) => {
    let release: () => void = () => {}
    const blocked = new Promise<void>(resolve => { release = resolve })
    t.after(() => release())
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({ name: 'slow', inputSchema: Type.Object({}), execution: { taskSupport: 'required' } } as any, async () => {
        await blocked
        return { content: [] }
      })
      app.mcpAddTool({ name: 'quick', inputSchema: Type.Object({}), execution: { taskSupport: 'optional' } } as any, async () => ({ content: [{ type: 'text', text: 'now' }] }))
    }, { enableTasks: true, taskMaxRetainedPerPrincipal: 1, taskShutdownTimeoutMs: 10 })

    const first = (await call(app, 'tools/call', { params: { name: 'slow', arguments: {} }, capabilities: taskCapabilities })).json()
    t.assert.strictEqual(first.result.resultType, 'task')
    // The only slot holds a running task, so nothing can be evicted.
    const refused = (await call(app, 'tools/call', { id: 2, params: { name: 'slow', arguments: {} }, capabilities: taskCapabilities })).json()
    t.assert.strictEqual(refused.error?.code, INVALID_REQUEST, JSON.stringify(refused))
    const optional = (await call(app, 'tools/call', { id: 3, params: { name: 'quick', arguments: {} }, capabilities: taskCapabilities })).json()
    t.assert.strictEqual(optional.error?.code, INVALID_REQUEST, JSON.stringify(optional))
    t.assert.match(optional.error.message, /Task limit reached/)
    // Without the extension the same tool simply runs.
    const sync = (await call(app, 'tools/call', { id: 4, params: { name: 'quick', arguments: {} } })).json()
    t.assert.strictEqual(sync.result.content[0].text, 'now')
  })

  async function readListen (response: Awaited<ReturnType<FastifyInstance['inject']>>) {
    const stream = response.stream()
    let received = ''
    let ended = false
    stream.on('data', (chunk: Buffer) => { received += chunk.toString() })
    stream.on('end', () => { ended = true })
    return {
      stream,
      frames: () => received.split('\n\n').filter(Boolean).map(frame => JSON.parse(frame.slice('data: '.length))),
      ended: () => ended
    }
  }

  test('a listen stream ends gracefully when the token that opened it expires', async (t: TestContext) => {
    const app = await buildServer(t, undefined, {
      capabilities: { tools: { listChanged: true } },
      resolveAuthorizationContext: async () => ({ userId: 'u', expiresAt: new Date(Date.now() + 150) })
    })
    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payloadAsStream: true,
      headers: modernHeaders('subscriptions/listen'),
      payload: modernBody('subscriptions/listen', { id: 'l', params: { notifications: { toolsListChanged: true } } })
    })
    const listen = await readListen(response)
    t.after(() => listen.stream.destroy())
    await until(() => listen.ended())
    const frames = listen.frames()
    t.assert.strictEqual(frames[0].method, 'notifications/subscriptions/acknowledged')
    t.assert.strictEqual(frames.at(-2).method, 'notifications/cancelled')
    t.assert.match(frames.at(-2).params.reason, /expired/)
    // The graceful completion: the client missed nothing and may listen again.
    t.assert.strictEqual(frames.at(-1).id, 'l')
    t.assert.strictEqual(frames.at(-1).result.resultType, 'complete')
  })

  test('a listen stream ends after sseMaxConnectionMs', async (t: TestContext) => {
    const app = await buildServer(t, undefined, { capabilities: { tools: { listChanged: true } }, sseMaxConnectionMs: 100 })
    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payloadAsStream: true,
      headers: modernHeaders('subscriptions/listen'),
      payload: modernBody('subscriptions/listen', { id: 'l', params: { notifications: { toolsListChanged: true } } })
    })
    const listen = await readListen(response)
    t.after(() => listen.stream.destroy())
    await until(() => listen.ended())
    t.assert.ok(listen.ended())
    t.assert.match(listen.frames().at(-2).params.reason, /maximum duration/)
  })

  test('closing stdin cancels requests still running over stdio', async (t: TestContext) => {
    let aborted: unknown
    let finished!: () => void
    const done = new Promise<void>(resolve => { finished = resolve })
    const app = Fastify()
    await app.register(mcpPlugin, { capabilities: { tools: {} } })
    app.mcpAddTool({ name: 'long', inputSchema: Type.Object({}) }, async (_args: any, context: any) => {
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 5_000)
        context.signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
      })
      aborted = context.signal.aborted
      finished()
      return { content: [] }
    })
    await app.ready()
    const input = new PassThrough()
    const transport = createStdioTransport(app, { input, output: new PassThrough(), error: new PassThrough() })
    transport.start()
    t.after(() => transport.stop())

    input.write(JSON.stringify(modernBody('tools/call', { id: 'x', params: { name: 'long', arguments: {} } })) + '\n')
    await new Promise(resolve => setTimeout(resolve, 50))
    const started = Date.now()
    input.end()
    await done
    t.assert.strictEqual(aborted, true)
    t.assert.ok(Date.now() - started < 2_000)
  })

  test('extensions are advertised by server/discover only', async (t: TestContext) => {
    const app = await buildServer(t, undefined, { capabilities: { tools: {}, extensions: { 'io.example/ui': {} } } })
    const discover = (await call(app, 'server/discover')).json().result
    t.assert.deepStrictEqual(discover.capabilities.extensions, { 'io.example/ui': {} })

    const init = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'initialize',
        params: { protocolVersion: LATEST_LEGACY_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'c', version: '1' } }
      }
    })
    t.assert.strictEqual('extensions' in init.json().result.capabilities, false)
  })
})

describe('round 9: request digests, header types, limits, sessions and shutdown', () => {
  const formCapabilities: ClientCapabilities = { elicitation: { form: {} } }
  const taskCapabilities: ClientCapabilities = { extensions: { [TASKS_EXTENSION]: {} }, elicitation: { form: {} } }
  const confirm = elicitForm('Sure?', { type: 'object', properties: { ok: { type: 'boolean' } } })

  test('a handler that normalizes its arguments in place still matches its own retry', async (t: TestContext) => {
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({ name: 'greet', inputSchema: Type.Object({ who: Type.String(), limit: Type.Optional(Type.Number()) }) }, async (args: any, context: any) => {
        args.who = args.who.trim()
        args.limit ??= 10
        if (!context.inputResponses?.ok) throw new InputRequired({ inputRequests: { ok: confirm } })
        return { content: [{ type: 'text', text: `hi ${args.who}` }] }
      })
    })
    const params = { name: 'greet', arguments: { who: ' bob ' } }
    const first = (await call(app, 'tools/call', { params, capabilities: formCapabilities })).json().result
    t.assert.strictEqual(first.resultType, 'input_required')
    const retry = (await call(app, 'tools/call', {
      id: 2,
      capabilities: formCapabilities,
      params: { ...params, requestState: first.requestState, inputResponses: { ok: { action: 'accept', content: { ok: true } } } }
    })).json()
    t.assert.strictEqual(retry.result?.content[0].text, 'hi bob', JSON.stringify(retry))
  })

  test('carry chooses which earlier answers the next retry keeps', async (t: TestContext) => {
    const seen: string[][] = []
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({ name: 'draft', inputSchema: Type.Object({}) }, async (_args: any, context: any) => {
        seen.push(Object.keys(context.inputResponses ?? {}).sort())
        const answers = context.inputResponses ?? {}
        if (answers.ok) return { content: [{ type: 'text', text: `published ${context.requestState}` }] }
        if (answers.draft) {
          // The draft is summarised into state and need not travel again.
          throw new InputRequired({ inputRequests: { ok: confirm }, state: answers.draft.content.text.length, carry: [] })
        }
        throw new InputRequired({ inputRequests: { draft: elicitForm('Draft', { type: 'object', properties: { text: { type: 'string' } } }) } })
      })
    }, { requestStateMaxAnswerBytes: 1000 })
    const retry = async (id: number, previous: any, inputResponses: Record<string, unknown>) => (await call(app, 'tools/call', {
      id,
      capabilities: formCapabilities,
      params: { name: 'draft', arguments: {}, requestState: previous.requestState, inputResponses }
    })).json()

    const first = (await call(app, 'tools/call', { params: { name: 'draft', arguments: {} }, capabilities: formCapabilities })).json().result
    // Far past the budget, which carrying it would exceed.
    const second = await retry(2, first, { draft: { action: 'accept', content: { text: 'x'.repeat(5000) } } })
    t.assert.strictEqual(second.result?.resultType, 'input_required', JSON.stringify(second))
    const third = await retry(3, second.result, { ok: { action: 'accept', content: { ok: true } } })
    t.assert.strictEqual(third.result?.content[0].text, 'published 5000', JSON.stringify(third))
    t.assert.deepStrictEqual(seen, [[], ['draft'], ['ok']])
  })

  test('carry must list input keys', (t: TestContext) => {
    t.assert.throws(() => new InputRequired({ state: 1, carry: 'draft' as any }), /carry/)
    t.assert.throws(() => new InputRequired({ state: 1, carry: [1] as any }), /carry/)
  })

  test('an x-mcp-header on a union of string literals is accepted', async (t: TestContext) => {
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({
        name: 'deploy',
        inputSchema: Type.Object({ region: Type.Union([Type.Literal('us'), Type.Literal('eu')], { 'x-mcp-header': 'Region' }) })
      }, async (args: any) => ({ content: [{ type: 'text', text: args.region }] }))
    })
    const listed = (await call(app, 'tools/list')).json().result.tools
    t.assert.deepStrictEqual(listed.map((tool: any) => tool.name), ['deploy'])
    const params = { name: 'deploy', arguments: { region: 'us' } }
    const ok = (await call(app, 'tools/call', { params, headers: { 'mcp-param-region': 'us' } })).json()
    t.assert.strictEqual(ok.result?.content[0].text, 'us', JSON.stringify(ok))
    const mismatch = await call(app, 'tools/call', { id: 2, params, headers: { 'mcp-param-region': 'eu' } })
    t.assert.strictEqual(mismatch.json().error.code, HEADER_MISMATCH)
  })

  test('an x-mcp-header on an object parameter is refused at registration', async (t: TestContext) => {
    await t.assert.rejects(buildServer(t, (app) => {
      app.mcpAddTool({
        name: 'bad',
        inputSchema: { type: 'object', properties: { filter: { type: 'object', 'x-mcp-header': 'Filter' } } }
      }, async () => ({ content: [] }))
    }), /Invalid tool schema for 'bad': x-mcp-header 'Filter' may only annotate/)
  })

  test('a header version that differs from the body version is a HeaderMismatch', async (t: TestContext) => {
    const app = await buildServer(t)
    const response = await call(app, 'tools/list', { protocolVersion: LATEST_LEGACY_PROTOCOL_VERSION, headers: { 'mcp-protocol-version': LATEST_PROTOCOL_VERSION } })
    t.assert.strictEqual(response.statusCode, 400)
    t.assert.strictEqual(response.json().error.code, HEADER_MISMATCH)
    // Agreeing on a version we do not implement is still -32022.
    const agreed = await call(app, 'tools/list', { protocolVersion: '2099-01-01' })
    t.assert.strictEqual(agreed.json().error.code, UNSUPPORTED_PROTOCOL_VERSION)
  })

  test('an initialize sent with the newest version header takes the legacy handshake', async (t: TestContext) => {
    const app = await buildServer(t)
    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'mcp-protocol-version': LATEST_PROTOCOL_VERSION },
      payload: {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'initialize',
        params: { protocolVersion: LATEST_LEGACY_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'c', version: '1' } }
      }
    })
    t.assert.strictEqual(response.statusCode, 200, response.body)
    t.assert.strictEqual(response.json().result.protocolVersion, LATEST_LEGACY_PROTOCOL_VERSION)
  })

  test('a fractional progress token is refused', async (t: TestContext) => {
    const app = await buildServer(t)
    const body = modernBody('tools/list')
    ;(body.params._meta as Record<string, unknown>).progressToken = 1.5
    const response = await app.inject({ method: 'POST', url: '/mcp', headers: modernHeaders('tools/list'), payload: body })
    t.assert.strictEqual(response.json().error.code, INVALID_PARAMS)
    t.assert.match(response.json().error.message, /progressToken/)
  })

  test('subscription and connection limits are validated at registration', async (t: TestContext) => {
    for (const [name, value] of [
      ['subscriptionMaxStreams', Number.NaN],
      ['subscriptionMaxStreamsPerPrincipal', 0],
      ['subscriptionMaxResourceUris', 1.5],
      ['sseMaxConnectionMs', -1]
    ] as const) {
      const app = Fastify()
      t.after(() => app.close())
      await t.assert.rejects(async () => { await app.register(mcpPlugin, { [name]: value }).ready() }, new RegExp(name))
    }
  })

  test('the retention cap counts a user once, whichever OAuth client they use', async (t: TestContext) => {
    let release: () => void = () => {}
    const blocked = new Promise<void>(resolve => { release = resolve })
    t.after(() => release())
    const app = await buildServer(t, (app) => {
      app.mcpAddTool({ name: 'slow', inputSchema: Type.Object({}), execution: { taskSupport: 'required' } } as any, async () => {
        await blocked
        return { content: [] }
      })
    }, {
      enableTasks: true,
      taskMaxRetainedPerPrincipal: 2,
      taskShutdownTimeoutMs: 10,
      resolveAuthorizationContext: async (request: any) => ({ userId: 'alice', clientId: request.headers['x-client'], authorizationServer: 'https://as' })
    })
    const codes: Array<string | number> = []
    for (const client of ['one', 'two', 'three']) {
      const body = (await call(app, 'tools/call', { params: { name: 'slow', arguments: {} }, capabilities: taskCapabilities, headers: { 'x-client': client } })).json()
      codes.push(body.result?.resultType ?? body.error.code)
    }
    t.assert.deepStrictEqual(codes, ['task', 'task', INVALID_REQUEST])
  })

  test('a 2026-07-28 request is aborted when the server shuts down', async (t: TestContext) => {
    let aborted: unknown
    let started!: () => void
    const running = new Promise<void>(resolve => { started = resolve })
    // Without forcing, the server would also wait for fetch's kept-alive socket.
    const app = Fastify({ forceCloseConnections: true })
    await app.register(mcpPlugin, { capabilities: { tools: {} } })
    app.mcpAddTool({ name: 'forever', inputSchema: Type.Object({}) }, async (_args: any, context: any) => {
      started()
      await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true }))
      aborted = context.signal.reason
      return { content: [] }
    })
    await app.listen({ port: 0, host: '127.0.0.1' })
    const { port } = app.server.address() as { port: number }
    const response = fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: modernHeaders('tools/call', { params: { name: 'forever' } }),
      body: JSON.stringify(modernBody('tools/call', { params: { name: 'forever', arguments: {} } }))
    }).then(res => res.json(), () => undefined)
    await running
    const closing = Date.now()
    await app.close()
    t.assert.ok(Date.now() - closing < 2_000)
    t.assert.match(String((aborted as Error)?.message), /shutting down/)
    await response
  })

  test('the unsubscribe handler runs when the last listen stream holding a URI ends', async (t: TestContext) => {
    const events: string[] = []
    const app = Fastify({ forceCloseConnections: true })
    t.after(() => app.close())
    await app.register(mcpPlugin, { capabilities: { resources: { subscribe: true } } })
    app.mcpSetResourceSubscribeHandler(async ({ uri }) => { events.push(`sub ${uri}`); return {} })
    app.mcpSetResourceUnsubscribeHandler(async ({ uri }) => { events.push(`unsub ${uri}`); return {} })
    await app.listen({ port: 0, host: '127.0.0.1' })
    const { port } = app.server.address() as { port: number }
    // A real connection: closing it is how a 2026-07-28 client ends a stream.
    const open = async (id: string) => {
      const controller = new AbortController()
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        signal: controller.signal,
        headers: modernHeaders('subscriptions/listen'),
        body: JSON.stringify(modernBody('subscriptions/listen', { id, params: { notifications: { resourceSubscriptions: ['file:///a'] } } }))
      })
      const reader = response.body!.getReader()
      await reader.read()
      return controller
    }
    const first = await open('a')
    const second = await open('b')
    first.abort()
    await new Promise(resolve => setTimeout(resolve, 100))
    t.assert.deepStrictEqual(events, ['sub file:///a', 'sub file:///a'])
    second.abort()
    await until(() => events.length === 3)
    t.assert.deepStrictEqual(events, ['sub file:///a', 'sub file:///a', 'unsub file:///a'])
  })
})
