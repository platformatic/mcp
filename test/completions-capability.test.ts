import { test, describe } from 'node:test'
import type { TestContext } from 'node:test'
import { Writable } from 'node:stream'
import Fastify from 'fastify'
import mcpPlugin from '../src/index.ts'
import type { JSONRPCResultResponse, JSONRPCErrorResponse, InitializeResult } from '../src/schema.ts'
import { JSONRPC_VERSION, LATEST_PROTOCOL_VERSION, METHOD_NOT_FOUND } from '../src/schema.ts'

function buildApp (t: TestContext, capabilities: Record<string, object>) {
  const logs: Array<{ level: number, msg: string }> = []
  const stream = new Writable({
    write (chunk, _enc, cb) {
      logs.push(JSON.parse(chunk.toString()))
      cb()
    }
  })
  const app = Fastify({ logger: { level: 'warn', stream } })
  t.after(() => app.close())
  app.register(mcpPlugin, { capabilities })
  return { app, logs }
}

async function initialize (app: ReturnType<typeof Fastify>): Promise<InitializeResult> {
  const response = await app.inject({
    method: 'POST',
    url: '/mcp',
    payload: {
      jsonrpc: JSONRPC_VERSION,
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' }
      }
    }
  })
  return (response.json() as JSONRPCResultResponse).result as InitializeResult
}

describe('completions capability', () => {
  test('is not advertised because completion/complete is not implemented', async (t: TestContext) => {
    const { app, logs } = buildApp(t, { prompts: {}, completions: {} })
    await app.ready()

    const result = await initialize(app)
    t.assert.deepStrictEqual(result.capabilities, { prompts: {} })

    // Advertising it would promise a method that answers -32601
    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: {
        jsonrpc: JSONRPC_VERSION,
        id: 2,
        method: 'completion/complete',
        params: { ref: { type: 'ref/prompt', name: 'p' }, argument: { name: 'a', value: '' } }
      }
    })
    t.assert.strictEqual((response.json() as JSONRPCErrorResponse).error.code, METHOD_NOT_FOUND)

    const warnings = logs.filter(l => l.level === 40 && /completions/.test(l.msg))
    t.assert.strictEqual(warnings.length, 1)
  })

  test('does not warn when completions is not configured', async (t: TestContext) => {
    const { app, logs } = buildApp(t, { tools: {} })
    await app.ready()

    const result = await initialize(app)
    t.assert.deepStrictEqual(result.capabilities, { tools: {} })
    t.assert.strictEqual(logs.filter(l => l.level === 40 && /completions/.test(l.msg)).length, 0)
  })
})
