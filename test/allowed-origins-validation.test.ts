import { test, describe } from 'node:test'
import type { TestContext } from 'node:test'
import Fastify from 'fastify'
import mcpPlugin from '../src/index.ts'
import { JSONRPC_VERSION } from '../src/schema.ts'
import { isOriginAllowed } from '../src/security.ts'

describe('allowedOrigins validation (#255)', () => {
  test('registration throws when allowedOrigins is a single string', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())
    // A plain string would turn the allow-list check into a substring match
    await t.assert.rejects(
      async () => { await app.register(mcpPlugin, { allowedOrigins: 'https://acme.com' as any }) },
      /allowedOrigins must be/
    )
  })

  test('registration throws when allowedOrigins contains a non-string', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())
    await t.assert.rejects(
      async () => { await app.register(mcpPlugin, { allowedOrigins: ['https://acme.com', 42] as any }) },
      /allowedOrigins must be/
    )
  })

  test('registration throws for other invalid shapes', async (t: TestContext) => {
    for (const value of [false, null, 0, {}, 'acme.com']) {
      const app = Fastify()
      await t.assert.rejects(
        async () => { await app.register(mcpPlugin, { allowedOrigins: value as any }) },
        /allowedOrigins must be/
      )
      await app.close()
    }
  })

  test('registration accepts every valid shape', async (t: TestContext) => {
    for (const value of [undefined, true, '*', [], ['https://acme.com']]) {
      const app = Fastify()
      await app.register(mcpPlugin, { allowedOrigins: value as any })
      await app.ready()
      await app.close()
    }
    t.assert.ok(true)
  })

  test('isOriginAllowed never falls back to a substring match', (t: TestContext) => {
    const allowed = 'https://acme.com' as any
    for (const origin of ['https://acme.co', 'https://acme.c', 'h', '']) {
      t.assert.strictEqual(isOriginAllowed(origin, allowed), false)
    }
  })

  test('repro from the issue: prefixes of an allowed origin are rejected with 403', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())
    await app.register(mcpPlugin, { allowedOrigins: ['https://acme.com'] })
    await app.ready()

    for (const origin of ['https://evil.com', 'https://acme.co', 'https://acme.c', 'h', '']) {
      const response = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { origin },
        payload: { jsonrpc: JSONRPC_VERSION, id: 1, method: 'ping', params: {} }
      })
      t.assert.strictEqual(response.statusCode, 403, `origin ${JSON.stringify(origin)}`)
    }
  })
})
