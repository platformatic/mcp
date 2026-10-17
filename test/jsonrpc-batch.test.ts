import { test, describe } from 'node:test'
import type { TestContext } from 'node:test'
import { PassThrough } from 'node:stream'
import { createInterface } from 'node:readline'
import Fastify from 'fastify'
import mcpPlugin from '../src/index.ts'
import { createStdioTransport } from '../src/stdio.ts'
import { JSONRPC_VERSION, INVALID_REQUEST } from '../src/schema.ts'
import { supportsBatching } from '../src/protocol-version.ts'

// JSON-RPC batching was introduced in 2025-03-26 and removed in 2025-06-18
// (see issue #319). Both transports must decide from the negotiated revision.

const ping = (id: number) => ({ jsonrpc: JSONRPC_VERSION, id, method: 'ping' })
const toolsList = (id: number) => ({ jsonrpc: JSONRPC_VERSION, id, method: 'tools/list' })
const initialized = { jsonrpc: JSONRPC_VERSION, method: 'notifications/initialized' }

function initialize (id: number, protocolVersion: string) {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    method: 'initialize',
    params: { protocolVersion, capabilities: {}, clientInfo: { name: 'c', version: '1' } }
  }
}

async function buildApp (t: TestContext, opts: Record<string, unknown> = {}) {
  const app = Fastify({ logger: false })
  t.after(() => app.close())
  await app.register(mcpPlugin, { capabilities: { tools: {} }, ...opts })
  await app.ready()
  return app
}

function post (app: any, payload: unknown, headers: Record<string, string> = {}) {
  return app.inject({ method: 'POST', url: '/mcp', headers, payload })
}

describe('supportsBatching', () => {
  test('is true only before 2025-06-18', (t: TestContext) => {
    t.assert.strictEqual(supportsBatching('2024-11-05'), true)
    t.assert.strictEqual(supportsBatching('2025-03-26'), true)
    t.assert.strictEqual(supportsBatching('2025-06-18'), false)
    t.assert.strictEqual(supportsBatching('2025-11-25'), false)
  })
})

describe('HTTP batching', () => {
  test('2025-03-26 header: a batch gets an array of responses', async (t: TestContext) => {
    const app = await buildApp(t)
    const response = await post(app, [ping(1), toolsList(2)], { 'mcp-protocol-version': '2025-03-26' })

    t.assert.strictEqual(response.statusCode, 200)
    const body = response.json()
    t.assert.ok(Array.isArray(body))
    t.assert.deepStrictEqual(body.map((r: any) => r.id).sort(), [1, 2])
    const byId = new Map(body.map((r: any) => [r.id, r]))
    t.assert.deepStrictEqual((byId.get(1) as any).result, {})
    t.assert.deepStrictEqual((byId.get(2) as any).result.tools, [])
  })

  test('absent header defaults to 2025-03-26 and accepts batches', async (t: TestContext) => {
    const app = await buildApp(t)
    const response = await post(app, [ping(1)])
    t.assert.strictEqual(response.statusCode, 200)
    t.assert.deepStrictEqual(response.json(), [{ jsonrpc: JSONRPC_VERSION, id: 1, result: {} }])
  })

  test('2024-11-05 header: batches are accepted', async (t: TestContext) => {
    const app = await buildApp(t)
    const response = await post(app, [ping(1)], { 'mcp-protocol-version': '2024-11-05' })
    t.assert.strictEqual(response.statusCode, 200)
    t.assert.deepStrictEqual(response.json(), [{ jsonrpc: JSONRPC_VERSION, id: 1, result: {} }])
  })

  for (const version of ['2025-06-18', '2025-11-25']) {
    test(`${version} header: a batch is refused with -32600`, async (t: TestContext) => {
      const app = await buildApp(t)
      const response = await post(app, [ping(1), toolsList(2)], { 'mcp-protocol-version': version })

      t.assert.strictEqual(response.statusCode, 200)
      const body = response.json()
      t.assert.ok(!Array.isArray(body))
      t.assert.strictEqual(body.id, null)
      t.assert.strictEqual(body.error.code, INVALID_REQUEST)
      t.assert.match(body.error.message, /not supported/)
    })
  }

  test('notifications produce no entry in the response array', async (t: TestContext) => {
    const app = await buildApp(t)
    const response = await post(app, [ping(1), initialized], { 'mcp-protocol-version': '2025-03-26' })
    t.assert.strictEqual(response.statusCode, 200)
    t.assert.deepStrictEqual(response.json(), [{ jsonrpc: JSONRPC_VERSION, id: 1, result: {} }])
  })

  test('a batch of only notifications is answered with 202 and no body', async (t: TestContext) => {
    const app = await buildApp(t)
    const response = await post(app, [initialized, initialized], { 'mcp-protocol-version': '2025-03-26' })
    t.assert.strictEqual(response.statusCode, 202)
    t.assert.strictEqual(response.body, '')
  })

  test('an empty batch is a single Invalid Request error', async (t: TestContext) => {
    const app = await buildApp(t)
    const response = await post(app, [], { 'mcp-protocol-version': '2025-03-26' })
    const body = response.json()
    t.assert.ok(!Array.isArray(body))
    t.assert.strictEqual(body.id, null)
    t.assert.strictEqual(body.error.code, INVALID_REQUEST)
  })

  test('invalid entries get their own Invalid Request error', async (t: TestContext) => {
    const app = await buildApp(t)
    const response = await post(app, [1, ping(2), { foo: 'bar' }], { 'mcp-protocol-version': '2025-03-26' })
    t.assert.strictEqual(response.statusCode, 200)
    const body = response.json()
    t.assert.strictEqual(body.length, 3)
    const errors = body.filter((r: any) => r.error)
    t.assert.strictEqual(errors.length, 2)
    for (const e of errors) {
      t.assert.strictEqual(e.id, null)
      t.assert.strictEqual(e.error.code, INVALID_REQUEST)
    }
    t.assert.ok(body.some((r: any) => r.id === 2 && r.result))
  })

  test('an unsafe numeric id inside a batch is refused for that entry only', async (t: TestContext) => {
    const app = await buildApp(t)
    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json', 'mcp-protocol-version': '2025-03-26' },
      payload: '[{"jsonrpc":"2.0","id":9007199254740993,"method":"ping"},{"jsonrpc":"2.0","id":2,"method":"ping"}]'
    })
    const body = response.json()
    t.assert.strictEqual(body.length, 2)
    t.assert.ok(body.some((r: any) => r.id === null && r.error?.code === INVALID_REQUEST))
    t.assert.ok(body.some((r: any) => r.id === 2 && r.result))
  })

  test('initialize must not be part of a batch', async (t: TestContext) => {
    const app = await buildApp(t)
    const response = await post(app, [initialize(1, '2025-03-26'), ping(2)])
    t.assert.strictEqual(response.statusCode, 200)
    // No session is opened for an initialize we refused
    t.assert.strictEqual(response.headers['mcp-session-id'], undefined)
    const body = response.json()
    const init = body.find((r: any) => r.id === 1)
    t.assert.strictEqual(init.error.code, INVALID_REQUEST)
    t.assert.match(init.error.message, /initialize/)
    t.assert.ok(body.some((r: any) => r.id === 2 && r.result))
  })

  test('a session negotiated at 2025-03-26 accepts batches without a header', async (t: TestContext) => {
    const app = await buildApp(t)
    const init = await post(app, initialize(1, '2025-03-26'))
    const sessionId = init.headers['mcp-session-id'] as string
    t.assert.ok(sessionId)

    const response = await post(app, [ping(2), toolsList(3)], { 'mcp-session-id': sessionId })
    t.assert.strictEqual(response.statusCode, 200)
    t.assert.strictEqual(response.json().length, 2)
  })

  test('a session negotiated at 2025-06-18 refuses batches even without a header', async (t: TestContext) => {
    const app = await buildApp(t)
    const init = await post(app, initialize(1, '2025-06-18'))
    const sessionId = init.headers['mcp-session-id'] as string
    t.assert.ok(sessionId)

    const response = await post(app, [ping(2), toolsList(3)], { 'mcp-session-id': sessionId })
    const body = response.json()
    t.assert.ok(!Array.isArray(body))
    t.assert.strictEqual(body.error.code, INVALID_REQUEST)
  })

  test('a batch carrying initialize cannot override a session negotiated at 2025-06-18', async (t: TestContext) => {
    const app = await buildApp(t)
    const init = await post(app, initialize(1, '2025-06-18'))
    const sessionId = init.headers['mcp-session-id'] as string

    // A 2025-03-26 header contradicts the session; wrapping an initialize in the
    // batch must not exempt it from that check.
    const response = await post(app, [initialize(2, '2025-03-26'), ping(3)], {
      'mcp-session-id': sessionId,
      'mcp-protocol-version': '2025-03-26'
    })
    t.assert.strictEqual(response.statusCode, 400)
  })
})

async function setupStdio (t: TestContext) {
  const app = Fastify({ logger: false })
  await app.register(mcpPlugin, { capabilities: { tools: {} } })
  await app.ready()

  const input = new PassThrough()
  const output = new PassThrough()
  const error = new PassThrough()
  const transport = createStdioTransport(app, { input, output, error })
  transport.start()
  t.after(() => transport.stop())

  const lines = createInterface({ input: output })[Symbol.asyncIterator]()
  async function sendRaw (line: string): Promise<any> {
    input.write(line + '\n')
    const { value } = await lines.next()
    return JSON.parse(value as string)
  }
  function send (message: unknown): Promise<any> {
    return sendRaw(JSON.stringify(message))
  }
  function write (message: unknown): void {
    input.write(JSON.stringify(message) + '\n')
  }
  return { send, sendRaw, write }
}

describe('stdio batching', () => {
  for (const version of ['2024-11-05', '2025-03-26']) {
    test(`accepts batches after negotiating ${version}`, async (t: TestContext) => {
      const { send } = await setupStdio(t)
      const init = await send(initialize(1, version))
      t.assert.strictEqual(init.result.protocolVersion, version)

      const body = await send([ping(2), initialized, toolsList(3)])
      t.assert.ok(Array.isArray(body))
      t.assert.deepStrictEqual(body.map((r: any) => r.id).sort(), [2, 3])
    })
  }

  for (const version of ['2025-06-18', '2025-11-25']) {
    test(`refuses batches after negotiating ${version}`, async (t: TestContext) => {
      const { send } = await setupStdio(t)
      const init = await send(initialize(1, version))
      t.assert.strictEqual(init.result.protocolVersion, version)

      const body = await send([ping(2), toolsList(3)])
      t.assert.ok(!Array.isArray(body))
      t.assert.strictEqual(body.id, null)
      t.assert.strictEqual(body.error.code, INVALID_REQUEST)

      // The stream is still usable for single messages
      const single = await send(ping(4))
      t.assert.deepStrictEqual(single, { jsonrpc: JSONRPC_VERSION, id: 4, result: {} })
    })
  }

  test('a batch of only notifications writes nothing', async (t: TestContext) => {
    const { send, write } = await setupStdio(t)
    await send(initialize(1, '2025-03-26'))
    write([initialized, initialized])
    // Had the notifications-only batch written a line, it would be read here
    // instead of the ping response.
    const next = await send(ping(2))
    t.assert.deepStrictEqual(next, { jsonrpc: JSONRPC_VERSION, id: 2, result: {} })
  })

  test('initialize inside a batch is refused and does not change the negotiated version', async (t: TestContext) => {
    const { send } = await setupStdio(t)
    await send(initialize(1, '2025-03-26'))

    const body = await send([initialize(2, '2025-11-25'), ping(3)])
    const init = body.find((r: any) => r.id === 2)
    t.assert.strictEqual(init.error.code, INVALID_REQUEST)

    // Still 2025-03-26: batches keep working
    const again = await send([ping(4)])
    t.assert.deepStrictEqual(again, [{ jsonrpc: JSONRPC_VERSION, id: 4, result: {} }])
  })

  test('an unsafe numeric id in a batch is not answered with a rounded id', async (t: TestContext) => {
    const { sendRaw } = await setupStdio(t)
    await sendRaw(JSON.stringify(initialize(1, '2025-03-26')))
    const body = await sendRaw('[{"jsonrpc":"2.0","id":1e400,"method":"ping"},{"jsonrpc":"2.0","id":2,"method":"ping"}]')
    t.assert.strictEqual(body.length, 2)
    t.assert.ok(body.some((r: any) => r.id === null && r.error?.code === INVALID_REQUEST))
    t.assert.ok(body.some((r: any) => r.id === 2 && r.result))
  })
})
