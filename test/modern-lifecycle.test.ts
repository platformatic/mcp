import { test, describe } from 'node:test'
import type { TestContext } from 'node:test'
import Fastify from 'fastify'
import { setTimeout as delay } from 'node:timers/promises'
import mcpPlugin from '../src/index.ts'
import { JSONRPC_VERSION, LATEST_PROTOCOL_VERSION } from '../src/schema.ts'
import {
  META_PROTOCOL_VERSION,
  META_CLIENT_CAPABILITIES,
  META_SUBSCRIPTION_ID
} from '../src/schema-2026.ts'

/**
 * These exercise a real socket rather than `app.inject()`.
 *
 * `inject` never opens one, so it cannot see whether an open SSE response
 * blocks `app.close()` — which is exactly the failure mode this file exists to
 * catch.
 */

function listenBody (id: number, notifications: Record<string, unknown>) {
  return JSON.stringify({
    jsonrpc: JSONRPC_VERSION,
    id,
    method: 'subscriptions/listen',
    params: {
      notifications,
      _meta: {
        [META_PROTOCOL_VERSION]: LATEST_PROTOCOL_VERSION,
        [META_CLIENT_CAPABILITIES]: {}
      }
    }
  })
}

async function openListenStream (url: string, id: number, notifications: Record<string, unknown>) {
  const response = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
      'mcp-method': 'subscriptions/listen'
    },
    body: listenBody(id, notifications)
  })

  return response
}

/** Read SSE frames off a live response until `stop` says we have enough. */
async function readFrames (
  response: Response,
  stop: (frames: any[]) => boolean,
  timeoutMs = 3000,
  cancel = true
): Promise<any[]> {
  const frames: any[] = []
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const deadline = Date.now() + timeoutMs
  let buffered = ''

  while (Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      delay(deadline - Date.now(), { done: true, value: undefined } as any)
    ])
    if (!chunk || chunk.done) break

    buffered += decoder.decode(chunk.value as Uint8Array, { stream: true })
    const parts = buffered.split('\n\n')
    buffered = parts.pop() ?? ''

    for (const part of parts) {
      const line = part.replace(/^data: /, '').trim()
      if (line) frames.push(JSON.parse(line))
    }
    if (stop(frames)) break
  }

  if (cancel) {
    reader.cancel().catch(() => {})
  } else {
    reader.releaseLock()
  }
  return frames
}

describe('2026-07-28: subscription stream lifecycle over a real socket', () => {
  test('closing the app ends open listen streams instead of hanging on them', async (t: TestContext) => {
    const app = Fastify()
    await app.register(mcpPlugin, {
      serverInfo: { name: 'test-server', version: '1.0.0' },
      capabilities: { tools: {} }
    })
    await app.listen({ port: 0, host: '127.0.0.1' })
    const url = `http://127.0.0.1:${(app.server.address() as any).port}`

    const response = await openListenStream(url, 1, { toolsListChanged: true })
    t.assert.strictEqual(response.status, 200)

    // Wait for the acknowledgement so the stream is definitely registered.
    const ack = await readFrames(response, (frames) => frames.length >= 1, 3000, false)
    t.assert.strictEqual(ack[0].method, 'notifications/subscriptions/acknowledged')

    // An open SSE response is an in-flight request. If the streams were only
    // torn down in `onClose`, Fastify would still be waiting on this one and
    // the close would never resolve.
    const closed = await Promise.race([
      app.close().then(() => 'closed' as const),
      delay(5000, 'timeout' as const)
    ])

    t.assert.strictEqual(closed, 'closed', 'app.close() must not block on an open subscription stream')
  })

  test('a graceful shutdown sends the empty listen response before closing', async (t: TestContext) => {
    const app = Fastify()
    await app.register(mcpPlugin, {
      serverInfo: { name: 'test-server', version: '1.0.0' },
      capabilities: { tools: {} }
    })
    await app.listen({ port: 0, host: '127.0.0.1' })
    const url = `http://127.0.0.1:${(app.server.address() as any).port}`

    const response = await openListenStream(url, 42, { toolsListChanged: true })

    // Collect frames while the server shuts down underneath us.
    const collecting = readFrames(response, (frames) => frames.some(f => 'result' in f))
    await delay(100)
    await app.close()

    const frames = await collecting
    const closure = frames.find(f => 'result' in f)

    t.assert.ok(closure, 'expected the graceful-closure response')
    t.assert.strictEqual(closure.id, 42)
    t.assert.strictEqual(closure.result.resultType, 'complete')
    t.assert.strictEqual(closure.result._meta[META_SUBSCRIPTION_ID], 42)
  })

  test('a broadcast reaches a real client, then the stream closes cleanly', async (t: TestContext) => {
    const app = Fastify()
    await app.register(mcpPlugin, {
      serverInfo: { name: 'test-server', version: '1.0.0' },
      capabilities: { tools: {} }
    })
    await app.listen({ port: 0, host: '127.0.0.1' })
    t.after(() => app.close())
    const url = `http://127.0.0.1:${(app.server.address() as any).port}`

    const response = await openListenStream(url, 'sub' as any, { toolsListChanged: true })

    const collecting = readFrames(
      response,
      (frames) => frames.some(f => f.method === 'notifications/tools/list_changed')
    )
    await delay(100)
    await app.mcpBroadcastNotification({
      jsonrpc: JSONRPC_VERSION,
      method: 'notifications/tools/list_changed'
    })

    const frames = await collecting
    const notification = frames.find(f => f.method === 'notifications/tools/list_changed')
    t.assert.ok(notification, 'expected the broadcast on the stream')
    t.assert.strictEqual(notification.params._meta[META_SUBSCRIPTION_ID], 'sub')
  })
})
