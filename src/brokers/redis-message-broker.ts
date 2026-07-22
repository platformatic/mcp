import type { Redis } from 'ioredis'
import MQEmitterRedis from 'mqemitter-redis'
import type { JSONRPCMessage } from '../schema.ts'
import type { MessageBroker } from './message-broker.ts'

export class RedisMessageBroker implements MessageBroker {
  private emitter: any

  constructor (redis: Redis) {
    const subConn = redis.duplicate({
      enableReadyCheck: false
    })
    const pubConn = redis.duplicate({
      enableReadyCheck: false
    })

    this.emitter = MQEmitterRedis({
      subConn,
      pubConn
    } as any)
  }

  async publish (topic: string, message: JSONRPCMessage): Promise<void> {
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

  async subscribe (topic: string, handler: (message: JSONRPCMessage) => void): Promise<void> {
    return new Promise((resolve) => {
      this.emitter.on(topic, (msg: any, cb: any) => {
        handler(msg.message)
        cb()
      })
      resolve()
    })
  }

  async unsubscribe (topic: string): Promise<void> {
    return new Promise((resolve) => {
      this.emitter.removeAllListeners(topic)
      resolve()
    })
  }

  async close (): Promise<void> {
    return new Promise((resolve) => {
      this.emitter.close(() => {
        resolve()
      })
    })
  }
}
