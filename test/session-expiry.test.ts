import { test, describe } from 'node:test'
import type { TestContext } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import mcpPlugin from '../src/index.ts'
import { MemorySessionStore } from '../src/stores/memory-session-store.ts'
import type { SessionMetadata } from '../src/stores/session-store.ts'
import { JSONRPC_VERSION, LATEST_PROTOCOL_VERSION } from '../src/schema.ts'

function newSession (id: string): SessionMetadata {
  return { id, eventId: 0, createdAt: new Date(), lastActivity: new Date() }
}

const initializeRequest = {
  jsonrpc: JSONRPC_VERSION,
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' }
  }
}

const whoamiCall = {
  jsonrpc: JSONRPC_VERSION,
  id: 2,
  method: 'tools/call',
  params: { name: 'whoami', arguments: {} }
}

/**
 * Builds the app and returns the MemorySessionStore the plugin created, captured
 * by spying on its cleanup() (called by the periodic sweep).
 */
async function buildApp (t: TestContext, opts: { enableSSE: boolean, sessionTtlMs: number }) {
  const cleanup = t.mock.method(MemorySessionStore.prototype, 'cleanup')

  const app = Fastify({ logger: false })
  t.after(() => app.close())

  await app.register(mcpPlugin, {
    serverInfo: { name: 'test-server', version: '1.0.0' },
    ...opts
  })

  app.mcpAddTool({
    name: 'whoami',
    description: 'Returns the session id the tool ran under'
  }, async (_params, { sessionId }) => {
    return { content: [{ type: 'text', text: sessionId ?? 'none' }] }
  })

  await app.ready()

  async function store (): Promise<MemorySessionStore> {
    for (let i = 0; i < 100 && cleanup.mock.callCount() === 0; i++) {
      await sleep(10)
    }
    return cleanup.mock.calls[0].this as MemorySessionStore
  }

  async function whoami (sessionId: string): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'mcp-session-id': sessionId },
      payload: whoamiCall
    })
    return response.json().result.content[0].text
  }

  return { app, store, whoami }
}

describe('MemorySessionStore idle expiry', () => {
  test('a session idle past its TTL reads as gone and is removed', async (t: TestContext) => {
    t.mock.timers.enable({ apis: ['Date'] })
    const store = new MemorySessionStore(100, { sessionTtlMs: 1000 })
    await store.create(newSession('s1'))

    t.mock.timers.tick(999)
    t.assert.ok(await store.get('s1'), 'still alive just before the TTL')

    t.mock.timers.tick(2)
    t.assert.strictEqual(await store.get('s1'), null)
    t.assert.strictEqual(store.size, 0, 'the read removes the expired session')
  })

  test('cleanup() removes every abandoned session and its token mapping', async (t: TestContext) => {
    t.mock.timers.enable({ apis: ['Date'] })
    const store = new MemorySessionStore(100, { sessionTtlMs: 1000 })
    for (let i = 0; i < 50; i++) {
      await store.create(newSession(`s${i}`))
    }
    await store.updateAuthorization('s0', { userId: 'u', tokenHash: 'h' } as any)
    t.assert.strictEqual(store.size, 50)

    t.mock.timers.tick(1001)
    await store.cleanup()

    t.assert.strictEqual(store.size, 0)
    t.assert.strictEqual(await store.getSessionByTokenHash('h'), null)
  })

  test('activity keeps a session alive past the TTL', async (t: TestContext) => {
    t.mock.timers.enable({ apis: ['Date'] })
    const store = new MemorySessionStore(100, { sessionTtlMs: 1000 })
    await store.create(newSession('touched'))
    await store.create(newSession('messaged'))
    await store.create(newSession('idle'))

    for (let i = 0; i < 5; i++) {
      t.mock.timers.tick(600)
      await store.touch('touched')
      await store.addMessage('messaged', { jsonrpc: '2.0', method: 'notifications/test' })
    }
    await store.cleanup()

    t.assert.ok(await store.get('touched'))
    t.assert.ok(await store.get('messaged'))
    t.assert.strictEqual(await store.get('idle'), null)
  })

  test('an expired session is not revived by later writes', async (t: TestContext) => {
    t.mock.timers.enable({ apis: ['Date'] })
    const store = new MemorySessionStore(100, { sessionTtlMs: 1000 })
    await store.create(newSession('s1'))

    t.mock.timers.tick(1001)
    await store.touch('s1')
    await store.addMessage('s1', { jsonrpc: '2.0', method: 'notifications/test' })

    t.assert.strictEqual(await store.get('s1'), null)
    t.assert.deepStrictEqual(await store.getMessagesFrom('s1', '0'), [])
  })
})

describe('plugin session expiry (memory backend)', () => {
  test('rejects a non-positive sessionTtlMs', async (t: TestContext) => {
    const app = Fastify({ logger: false })
    t.after(() => app.close())
    await t.assert.rejects(async () => {
      await app.register(mcpPlugin, { sessionTtlMs: 0 })
      await app.ready()
    }, /sessionTtlMs/)
  })

  test('abandoned sessions expire and the store does not grow', async (t: TestContext) => {
    const { app, store } = await buildApp(t, { enableSSE: false, sessionTtlMs: 100 })
    const sessionStore = await store()

    const ids: string[] = []
    for (let i = 0; i < 20; i++) {
      const response = await app.inject({ method: 'POST', url: '/mcp', payload: initializeRequest })
      ids.push(response.headers['mcp-session-id'] as string)
    }
    t.assert.strictEqual(sessionStore.size, 20)

    // Clients went away without DELETE; the periodic sweep frees them
    await sleep(350)
    t.assert.strictEqual(sessionStore.size, 0)

    const response = await app.inject({ method: 'DELETE', url: '/mcp', headers: { 'mcp-session-id': ids[0] } })
    t.assert.strictEqual(response.statusCode, 404)
  })

  test('a session that keeps sending requests stays alive', async (t: TestContext) => {
    const { app, store, whoami } = await buildApp(t, { enableSSE: false, sessionTtlMs: 200 })
    const sessionStore = await store()

    const initResponse = await app.inject({ method: 'POST', url: '/mcp', payload: initializeRequest })
    const sessionId = initResponse.headers['mcp-session-id'] as string

    // Well past the TTL in total, but never idle for longer than it
    for (let i = 0; i < 8; i++) {
      await sleep(70)
      t.assert.strictEqual(await whoami(sessionId), sessionId)
    }
    t.assert.ok(await sessionStore.get(sessionId), 'requests must keep the session alive')

    // Once the client goes quiet the session expires
    await sleep(450)
    t.assert.strictEqual(sessionStore.size, 0)
    const response = await app.inject({ method: 'DELETE', url: '/mcp', headers: { 'mcp-session-id': sessionId } })
    t.assert.strictEqual(response.statusCode, 404)
  })

  test('an open SSE stream keeps its session alive through heartbeats', async (t: TestContext) => {
    const { app, store, whoami } = await buildApp(t, { enableSSE: true, sessionTtlMs: 200 })
    const sessionStore = await store()

    const initResponse = await app.inject({ method: 'POST', url: '/mcp', payload: initializeRequest })
    const sessionId = initResponse.headers['mcp-session-id'] as string

    const sse = await app.inject({
      method: 'GET',
      url: '/mcp',
      headers: { accept: 'text/event-stream', 'mcp-session-id': sessionId },
      payloadAsStream: true
    })
    t.assert.strictEqual(sse.statusCode, 200)

    // No requests, no messages: only the stream's heartbeats count as activity
    await sleep(600)

    t.assert.ok(await sessionStore.get(sessionId), 'heartbeats must keep the session alive')
    // With SSE an unknown session id would get a brand new session instead
    t.assert.strictEqual(await whoami(sessionId), sessionId)

    sse.stream().destroy()
  })

  test('the cleanup timer does not keep the process alive', async (t: TestContext) => {
    const indexUrl = new URL('../src/index.ts', import.meta.url).href
    const script = `
      import Fastify from 'fastify'
      import mcpPlugin from ${JSON.stringify(indexUrl)}
      const app = Fastify()
      await app.register(mcpPlugin, { sessionTtlMs: 60_000 })
      await app.ready()
      // Intentionally never closed: the process must still exit on its own
    `
    const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      stdio: ['ignore', 'ignore', 'pipe']
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })

    const killer = setTimeout(() => child.kill('SIGKILL'), 10_000)
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
      child.on('exit', (code, signal) => resolve([code, signal]))
    })
    clearTimeout(killer)

    t.assert.strictEqual(signal, null, 'the process had to be killed: something kept it alive')
    t.assert.strictEqual(code, 0, stderr)
  })
})
