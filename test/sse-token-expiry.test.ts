import { test, describe } from 'node:test'
import type { TestContext } from 'node:test'
import { once } from 'node:events'
import Fastify from 'fastify'
import mcpPlugin from '../src/index.ts'
import {
  createTestAuthConfig,
  createTestJWT,
  setupMockAgent,
  generateMockJWKSResponse
} from './auth-test-utils.ts'

// The stream's close timer is unref'd, so a ref'd timer has to keep the event
// loop alive while the test waits for it to fire
async function waitForEnd (stream: NodeJS.ReadableStream, ms = 5000): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      once(stream, 'end'),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`stream did not end within ${ms}ms`)), ms)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

function countRefedTimeouts (): number {
  return process.getActiveResourcesInfo().filter(r => r === 'Timeout').length
}

describe('SSE streams close when the opening token expires', () => {
  test('a stream opened with a short-lived JWT is closed shortly after exp', async (t: TestContext) => {
    const restoreMock = setupMockAgent({
      'https://auth.example.com/.well-known/jwks.json': generateMockJWKSResponse()
    })
    t.after(restoreMock)

    const app = Fastify({ logger: false })
    t.after(() => app.close())
    await app.register(mcpPlugin, {
      enableSSE: true,
      // The token expires well before this, so exp wins
      sseMaxConnectionMs: 60_000,
      authorization: createTestAuthConfig()
    })
    await app.ready()

    const exp = Math.floor(Date.now() / 1000) + 2
    const token = createTestJWT({ exp })

    const response = await app.inject({
      method: 'GET',
      url: '/mcp',
      payloadAsStream: true,
      headers: {
        accept: 'text/event-stream',
        authorization: `Bearer ${token}`
      }
    })
    t.assert.strictEqual(response.statusCode, 200)

    const stream = response.stream()
    stream.resume()
    await waitForEnd(stream)

    const closedAt = Date.now()
    t.assert.ok(closedAt >= exp * 1000 - 50, `closed ${exp * 1000 - closedAt}ms before exp`)
    t.assert.ok(closedAt < exp * 1000 + 1000, `closed ${closedAt - exp * 1000}ms after exp`)
  })

  test('the expiry timer does not keep the process alive', async (t: TestContext) => {
    const restoreMock = setupMockAgent({
      'https://auth.example.com/.well-known/jwks.json': generateMockJWKSResponse()
    })
    t.after(restoreMock)

    const app = Fastify({ logger: false })
    t.after(() => app.close())
    await app.register(mcpPlugin, {
      enableSSE: true,
      authorization: createTestAuthConfig()
    })
    await app.ready()

    const token = createTestJWT({ exp: Math.floor(Date.now() / 1000) + 3600 })
    // Warm up so the JWKS fetch does not leave timers behind during the measurement
    const warmup = await app.inject({
      method: 'GET',
      url: '/mcp',
      payloadAsStream: true,
      headers: { accept: 'text/event-stream', authorization: `Bearer ${token}` }
    })
    warmup.stream().destroy()

    const before = countRefedTimeouts()
    const response = await app.inject({
      method: 'GET',
      url: '/mcp',
      payloadAsStream: true,
      headers: { accept: 'text/event-stream', authorization: `Bearer ${token}` }
    })
    t.assert.strictEqual(response.statusCode, 200)
    t.assert.strictEqual(countRefedTimeouts(), before)
    response.stream().destroy()
  })

  test('without authorization, sseMaxConnectionMs alone still applies', async (t: TestContext) => {
    const app = Fastify({ logger: false })
    t.after(() => app.close())
    await app.register(mcpPlugin, { enableSSE: true, sseMaxConnectionMs: 50 })
    await app.ready()

    const response = await app.inject({
      method: 'GET',
      url: '/mcp',
      payloadAsStream: true,
      headers: { accept: 'text/event-stream' }
    })
    t.assert.strictEqual(response.statusCode, 200)

    const stream = response.stream()
    stream.resume()
    await waitForEnd(stream)
  })
})
