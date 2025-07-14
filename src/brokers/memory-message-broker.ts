import mqemitter, { type MQEmitter } from 'mqemitter'
import type { JSONRPCMessage } from '../schema.ts'
import type { MessageBroker } from './message-broker.ts'

export class MemoryMessageBroker implements MessageBroker {
  private emitter: MQEmitter
  private subscriptions = new Map<string, { handler: (message: JSONRPCMessage) => void, listener: (message: any, done: () => void) => void }>()

  constructor() {
    this.emitter = mqemitter()
  }

  async publish(topic: string, message: JSONRPCMessage): Promise<void> {
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

  async subscribe(topic: string, handler: (message: JSONRPCMessage) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const listener = (data: any, cb: () => void) => {
        try {
          handler(data.message)
          cb()
        } catch (error) {
          cb()
        }
      }

      // Store both handler and listener for unsubscribe
      this.subscriptions.set(topic, { handler, listener })

      this.emitter.on(topic, listener, (err?: any) => {
        if (err) {
          reject(err)
        } else {
          resolve()
        }
      })
    })
  }

  async unsubscribe(topic: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const subscription = this.subscriptions.get(topic)
      if (!subscription) {
        resolve()
        return
      }

      this.emitter.removeListener(topic, subscription.listener, (err?: any) => {
        if (err) {
          reject(err)
        } else {
          this.subscriptions.delete(topic)
          resolve()
        }
      })
    })
  }

  async close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.emitter.close((err?: any) => {
        if (err) {
          reject(err)
        } else {
          resolve()
        }
      })
    })
  }
}
