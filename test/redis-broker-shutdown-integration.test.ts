import { describe, it } from 'node:test'
import assert from 'node:assert'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import Fastify from 'fastify'
import mcpPlugin from '../src/index.ts'

const INFO_REPLY = 'redis_version:7.0.0\r\nloading:0\r\n'

function startUnresponsiveRedisServer (): Promise<{ port: number, stop: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      socket.on('data', (chunk) => {
        if (/INFO/i.test(chunk.toString('utf8'))) {
          socket.write(`$${Buffer.byteLength(INFO_REPLY)}\r\n${INFO_REPLY}\r\n`)
        }
        // Any other command (notably QUIT) is silently dropped.
      })
      socket.on('error', () => {})
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({
        port,
        stop: () => new Promise<void>((resolve) => server.close(() => resolve()))
      })
    })
  })
}

describe('MCP plugin shutdown (Fastify integration)', () => {
  it('bounds app.close() when Redis cannot quit gracefully', async () => {
    const { port, stop } = await startUnresponsiveRedisServer()

    const app = Fastify()
    await app.register(mcpPlugin, {
      redis: { host: '127.0.0.1', port }
    })
    await app.ready()

    // Give the plugin's Redis connections (session store client plus the
    // broker's subConn/pubConn) time to complete the INFO ready-check
    // against localhost before we shut down.
    await sleep(300)
    const STRICT_DEADLINE_MS = 5000

    try {
      const start = process.hrtime.bigint()
      await app.close()
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6
      assert.ok(
        elapsedMs < STRICT_DEADLINE_MS,
        `app.close() took ${elapsedMs}ms, expected under ${STRICT_DEADLINE_MS}ms`
      )
    } finally {
      await stop()
    }
  })
})
