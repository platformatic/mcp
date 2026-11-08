import { describe, test } from 'node:test'
import { strict as assert } from 'node:assert'
import Fastify from 'fastify'
import mcpPlugin from '../src/index.ts'
import type { JSONRPCResponse } from '../src/schema.ts'
import { INVALID_REQUEST } from '../src/schema.ts'

// Issue #251: POST /mcp answered 500 for bodies that are not JSON-RPC
// requests or notifications.

const invalidBodies: Array<{ name: string, contentType: string, payload: string }> = [
  { name: 'null', contentType: 'application/json', payload: 'null' },
  { name: 'a number', contentType: 'application/json', payload: '42' },
  { name: 'a string', contentType: 'application/json', payload: '"x"' },
  { name: 'a boolean', contentType: 'application/json', payload: 'true' },
  { name: 'a text/plain body', contentType: 'text/plain', payload: 'hello' },
  { name: 'an object that is not a JSON-RPC message', contentType: 'application/json', payload: '{"jsonrpc":"2.0","id":1}' },
  // Issue #344: JSON-RPC 2.0 requires "jsonrpc": "2.0" and a string method
  { name: 'a request with jsonrpc "1.0"', contentType: 'application/json', payload: '{"jsonrpc":"1.0","id":1,"method":"tools/list"}' },
  { name: 'a request without jsonrpc', contentType: 'application/json', payload: '{"id":1,"method":"tools/list"}' },
  { name: 'an initialize without jsonrpc', contentType: 'application/json', payload: '{"id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"c","version":"1"}}}' },
  { name: 'a request with a numeric jsonrpc', contentType: 'application/json', payload: '{"jsonrpc":2.0,"id":1,"method":"ping"}' },
  { name: 'a request with a numeric method', contentType: 'application/json', payload: '{"jsonrpc":"2.0","id":1,"method":5}' },
  { name: 'a request with a null method', contentType: 'application/json', payload: '{"jsonrpc":"2.0","id":1,"method":null}' },
  { name: 'a notification with a numeric method', contentType: 'application/json', payload: '{"jsonrpc":"2.0","method":5}' },
  { name: 'a notification without jsonrpc', contentType: 'application/json', payload: '{"method":"notifications/initialized"}' },
  { name: 'a client response without jsonrpc', contentType: 'application/json', payload: '{"id":1,"result":{}}' },
  { name: 'a client error response with jsonrpc "1.0"', contentType: 'application/json', payload: '{"jsonrpc":"1.0","id":1,"error":{"code":-1,"message":"x"}}' }
]

describe('Legacy POST /mcp bodies', () => {
  for (const enableSSE of [false, true]) {
    describe(`enableSSE: ${enableSSE}`, () => {
      for (const { name, contentType, payload } of invalidBodies) {
        test(`answers ${name} with 400 and -32600 Invalid Request`, async (t) => {
          const app = Fastify({ logger: false })
          t.after(() => app.close())
          await app.register(mcpPlugin, { enableSSE })

          const response = await app.inject({
            method: 'POST',
            url: '/mcp',
            headers: { 'content-type': contentType },
            payload
          })

          assert.strictEqual(response.statusCode, 400)
          assert.match(response.headers['content-type'] as string, /application\/json/)
          // A rejected body must not open a session
          assert.strictEqual(response.headers['mcp-session-id'], undefined)
          const body = response.json()
          assert.strictEqual(body.jsonrpc, '2.0')
          assert.strictEqual(body.id, null)
          assert.strictEqual(body.error.code, INVALID_REQUEST)
        })
      }

      for (const [kind, message] of [
        ['result', { jsonrpc: '2.0', id: 1, result: {} }],
        ['error', { jsonrpc: '2.0', id: 'req-7', error: { code: -1, message: 'Declined' } }]
      ] as const) {
        test(`answers a client-posted ${kind} response with 202 and no body, and hands it to onClientResponse`, async (t) => {
          const app = Fastify({ logger: false })
          t.after(() => app.close())
          const received: JSONRPCResponse[] = []
          await app.register(mcpPlugin, {
            enableSSE,
            onClientResponse: (response) => { received.push(response) }
          })

          const response = await app.inject({
            method: 'POST',
            url: '/mcp',
            payload: message
          })

          assert.strictEqual(response.statusCode, 202)
          assert.strictEqual(response.body, '')
          assert.deepStrictEqual(received, [message])
        })
      }
    })
  }

  test('a legacy client answering mcpElicit reaches the onClientResponse waiter', async (t) => {
    const app = Fastify({ logger: false })
    t.after(() => app.close())

    // What an application waiting on an elicitation would do: resolve a pending
    // promise when the matching id comes back.
    const waiters = new Map<string | number, (response: JSONRPCResponse) => void>()
    await app.register(mcpPlugin, {
      enableSSE: true,
      onClientResponse: (response) => { waiters.get(response.id!)?.(response) }
    })
    await app.ready()

    // A 2025-03-26 client: no MCP-Protocol-Version header on later requests
    const init = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: { elicitation: {} },
          clientInfo: { name: 'legacy-client', version: '1.0.0' }
        }
      }
    })
    const sessionId = init.headers['mcp-session-id'] as string
    assert.ok(sessionId)

    const answered = new Promise<JSONRPCResponse>((resolve) => waiters.set('elicit-legacy', resolve))
    const sent = await app.mcpElicit(sessionId, 'Your name?', {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name']
    }, 'elicit-legacy')
    assert.strictEqual(sent, true)

    const reply = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'mcp-session-id': sessionId },
      payload: { jsonrpc: '2.0', id: 'elicit-legacy', result: { action: 'accept', content: { name: 'Ada' } } }
    })
    assert.strictEqual(reply.statusCode, 202)
    assert.strictEqual(reply.body, '')

    const response = await answered
    assert.deepStrictEqual((response as { result?: unknown }).result, { action: 'accept', content: { name: 'Ada' } })
  })
})
