import { describe, it } from 'node:test'
import assert from 'node:assert'
import { createServer } from 'node:net'
import type { AddressInfo, Socket } from 'node:net'
import { Writable } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'
import Fastify from 'fastify'
import { Redis } from 'ioredis'
import mcpPlugin from '../src/index.ts'
import { RedisMessageBroker } from '../src/brokers/redis-message-broker.ts'

const INFO_REPLY = 'redis_version:7.0.0\r\nloading:0\r\n'

// Minimal fake Redis that answers INFO (ready check) and +OK to anything else.
// `restart()` drops every connection and stops listening, as a Redis restart would.
function startFakeRedisServer (): Promise<{ port: number, restart: () => Promise<void> }> {
  return new Promise((resolve) => {
    const sockets = new Set<Socket>()
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      socket.on('data', (chunk) => {
        if (/INFO/i.test(chunk.toString('utf8'))) {
          socket.write(`$${Buffer.byteLength(INFO_REPLY)}\r\n${INFO_REPLY}\r\n`)
        } else {
          socket.write('+OK\r\n')
        }
      })
      socket.on('error', () => {})
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({
        port,
        restart: () => new Promise<void>((resolve) => {
          server.close(() => resolve())
          for (const socket of sockets) {
            socket.destroy()
          }
        })
      })
    })
  })
}

describe('Redis connection errors', () => {
  it('RedisMessageBroker does not crash when a pub/sub connection errors', async () => {
    const redis = new Redis({ lazyConnect: true })
    const errors: Error[] = []
    const broker = new RedisMessageBroker(redis, { onError: (err) => errors.push(err) })

    const emitter = (broker as unknown as { emitter: { subConn: Redis, pubConn: Redis } }).emitter
    const err = new Error('connect ECONNREFUSED 127.0.0.1:6379')

    assert.doesNotThrow(() => emitter.subConn.emit('error', err))
    assert.doesNotThrow(() => emitter.pubConn.emit('error', err))
    assert.deepStrictEqual(errors, [err, err])

    await broker.close()
    redis.disconnect()
  })

  it('RedisMessageBroker without onError does not crash when a pub/sub connection errors', async () => {
    const redis = new Redis({ lazyConnect: true })
    const broker = new RedisMessageBroker(redis)

    const emitter = (broker as unknown as { emitter: { subConn: Redis } }).emitter
    assert.doesNotThrow(() => emitter.subConn.emit('error', new Error('boom')))

    await broker.close()
    redis.disconnect()
  })

  it('the plugin logs Redis errors and survives a Redis restart', async () => {
    const { port, restart } = await startFakeRedisServer()

    const logs: Array<{ level: number, msg: string, err?: { message: string } }> = []
    const stream = new Writable({
      write (chunk, _enc, cb) {
        logs.push(JSON.parse(chunk.toString()))
        cb()
      }
    })

    const app = Fastify({ logger: { level: 'error', stream } })
    await app.register(mcpPlugin, {
      redis: { host: '127.0.0.1', port }
    })
    await app.ready()

    let uncaught: Error | undefined
    const onUncaught = (err: Error) => { uncaught = err }
    process.prependListener('uncaughtException', onUncaught)
    try {
      await restart()
      // Wait for ioredis to notice the drop and fail at least one reconnect attempt.
      const deadline = Date.now() + 2000
      while (Date.now() < deadline && !logs.some((l) => /ECONNREFUSED/.test(l.err?.message ?? ''))) {
        await sleep(20)
      }
    } finally {
      process.removeListener('uncaughtException', onUncaught)
    }

    assert.strictEqual(uncaught, undefined)
    const errorLogs = logs.filter((l) => /ECONNREFUSED/.test(l.err?.message ?? ''))
    assert.ok(errorLogs.length > 0, 'expected Redis connection errors to be logged')
    assert.ok(errorLogs.every((l) => l.level === 50))

    await app.close()
  })
})
