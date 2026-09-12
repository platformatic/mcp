import type { Redis } from 'ioredis'
import MQEmitterRedis from 'mqemitter-redis'
import type { JSONRPCMessage } from '../schema.ts'
import type { MessageBroker } from './message-broker.ts'

const DEFAULT_CLOSE_TIMEOUT_MS = 2000

interface RedisConnLike {
  disconnect (): unknown
  quit? (...args: unknown[]): Promise<unknown>
}

function suppressUnhandledQuitRejection (conn?: RedisConnLike): void {
  if (typeof conn?.quit !== 'function') {
    return
  }
  const quit = conn.quit.bind(conn)
  conn.quit = (...args: unknown[]) => {
    const result = quit(...args)
    result?.catch?.(() => {})
    return result
  }
}

interface RedisMQEmitter extends ReturnType<typeof MQEmitterRedis> {
  removeAllListeners? (topic: string, done?: (err?: Error) => void): void
  subConn?: RedisConnLike
  pubConn?: RedisConnLike
  _close?: (cb: () => void) => void
}

export interface RedisMessageBrokerOptions {
  /** Bound on how long close() waits for a graceful shutdown, in ms (default 2000). */
  closeTimeoutMs?: number
  /** Called with closeTimeoutMs when close() falls back to a forced disconnect after it elapses. */
  onCloseTimeout?: (closeTimeoutMs: number) => void
}

export class RedisMessageBroker implements MessageBroker {
  private readonly emitter: RedisMQEmitter
  private readonly closeTimeoutMs: number
  private readonly onCloseTimeout?: (closeTimeoutMs: number) => void
  private closePromise: Promise<void> | null = null

  /**
   * @param redis Redis connection whose options are reused for the MQEmitter pub/sub connections.
   * @param options.closeTimeoutMs Bound on how long close() waits for a graceful shutdown, in ms (default 2000).
   * @param options.onCloseTimeout Called with closeTimeoutMs when close() falls back to a forced disconnect after it elapses.
   */
  constructor (redis: Redis, options: RedisMessageBrokerOptions = {}) {
    this.emitter = MQEmitterRedis({
      port: redis.options.port,
      host: redis.options.host,
      password: redis.options.password,
      db: redis.options.db || 0,
      family: redis.options.family || 4,
      enableReadyCheck: false
    })
    this.closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS
    this.onCloseTimeout = options.onCloseTimeout
    suppressUnhandledQuitRejection(this.emitter.subConn)
    suppressUnhandledQuitRejection(this.emitter.pubConn)
  }

  async publish (topic: string, message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      this.emitter.emit({ topic, message }, (err) => {
        if (err) {
          reject(err)
        } else {
          resolve()
        }
      })
    })
  }

  async subscribe (topic: string, handler: (message: JSONRPCMessage) => void): Promise<void> {
    return new Promise((resolve) => {
      this.emitter.on(topic, (packet, cb) => {
        handler(packet.message)
        cb()
      })
      resolve()
    })
  }

  async unsubscribe (topic: string): Promise<void> {
    return new Promise((resolve) => {
      this.emitter.removeAllListeners?.(topic)
      resolve()
    })
  }

  async close (): Promise<void> {
    if (!this.closePromise) {
      this.closePromise = this.closeWithTimeout()
    }
    return this.closePromise
  }

  private closeWithTimeout (): Promise<void> {
    return new Promise((resolve) => {
      let timedOut = false

      const timer = setTimeout(() => {
        timedOut = true
        this.forceClose()
        resolve()
      }, this.closeTimeoutMs)

      this.emitter.close(() => {
        if (timedOut) {
          return
        }
        clearTimeout(timer)
        resolve()
      })
    })
  }

  // Best-effort: none of these steps may throw or hang, since this runs
  // after the graceful close already failed to complete in time.
  private forceClose (): void {
    try {
      this.emitter.subConn?.disconnect()
    } catch {
      // connection may already be in a broken state
    }
    try {
      this.emitter.pubConn?.disconnect()
    } catch {
      // connection may already be in a broken state
    }
    try {
      this.emitter._close?.(() => {})
    } catch {
      // finalizer is best-effort
    }
    try {
      this.onCloseTimeout?.(this.closeTimeoutMs)
    } catch {
      // caller-supplied hook must not break shutdown
    }
  }
}
