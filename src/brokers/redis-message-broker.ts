import type { Redis } from 'ioredis'
import mqemitterRedis from 'mqemitter-redis'
import type { JSONRPCMessage } from '../schema.ts'
import type { MessageBroker } from './message-broker.ts'

export class RedisMessageBroker implements MessageBroker {
  private emitter: any

  constructor(redis: Redis) {
    this.emitter = mqemitterRedis({
      port: redis.options.port,
      host: redis.options.host,
      password: redis.options.password,
      db: redis.options.db || 0,
      family: redis.options.family || 4
    })
  }

  async publish(topic: string, message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      this.emitter.emit({ topic, message }, (err: any) => {
        if (err) {
          reject(err)
        } else {
          resolve()
        }
      })
    })
  }

  async subscribe(topic: string, handler: (message: JSONRPCMessage) => void): Promise<void> {
    return new Promise((resolve) => {
      this.emitter.on(topic, (msg: any, cb: any) => {
        handler(msg.message)
        cb()
      })
      resolve()
    })
  }

  async unsubscribe(topic: string): Promise<void> {
    return new Promise((resolve) => {
      this.emitter.removeAllListeners(topic)
      resolve()
    })
  }

  async close(): Promise<void> {
    return new Promise((resolve) => {
      this.emitter.close(() => {
        resolve()
      })
    })
  }
}