import { describe } from 'node:test'
import assert from 'node:assert'
import { RedisMessageBroker } from '../src/brokers/redis-message-broker.ts'
import { createTestRedis, cleanupRedis, skipIfNoRedis } from './redis-test-utils.ts'
import type { JSONRPCMessage } from '../src/schema.ts'

describe('RedisMessageBroker', () => {
  skipIfNoRedis('should publish and receive messages', async () => {
    const redis = await createTestRedis()
    const broker = new RedisMessageBroker(redis)

    const testMessage: JSONRPCMessage = {
      jsonrpc: '2.0',
      method: 'test',
      id: 1
    }

    let receivedMessage: JSONRPCMessage | null = null
    const messagePromise = new Promise<void>((resolve) => {
      broker.subscribe('test-topic', (message) => {
        receivedMessage = message
        resolve()
      })
    })

    // Give subscription time to register
    await new Promise(resolve => setTimeout(resolve, 100))

    await broker.publish('test-topic', testMessage)
    await messagePromise

    assert.ok(receivedMessage)
    assert.deepStrictEqual(receivedMessage, testMessage)

    await broker.close()
    await cleanupRedis(redis)
  })

  skipIfNoRedis('should handle multiple subscribers to same topic', async () => {
    const redis1 = await createTestRedis()
    const redis2 = await createTestRedis()
    const broker1 = new RedisMessageBroker(redis1)
    const broker2 = new RedisMessageBroker(redis2)

    const testMessage: JSONRPCMessage = {
      jsonrpc: '2.0',
      method: 'test',
      id: 1
    }

    let receivedCount = 0
    const messagePromise = new Promise<void>((resolve) => {
      const handler = () => {
        receivedCount++
        if (receivedCount === 2) {
          resolve()
        }
      }

      broker1.subscribe('multi-topic', handler)
      broker2.subscribe('multi-topic', handler)
    })

    // Give subscriptions time to register
    await new Promise(resolve => setTimeout(resolve, 100))

    await broker1.publish('multi-topic', testMessage)
    await messagePromise

    assert.strictEqual(receivedCount, 2)

    await broker1.close()
    await broker2.close()
    await cleanupRedis(redis1)
    await cleanupRedis(redis2)
  })

  skipIfNoRedis('should handle session-specific topics', async () => {
    const redis = await createTestRedis()
    const broker = new RedisMessageBroker(redis)

    const sessionId = 'test-session-123'
    const testMessage: JSONRPCMessage = {
      jsonrpc: '2.0',
      method: 'session-message',
      id: 1
    }

    let receivedMessage: JSONRPCMessage | null = null
    const messagePromise = new Promise<void>((resolve) => {
      broker.subscribe(`mcp/session/${sessionId}/message`, (message) => {
        receivedMessage = message
        resolve()
      })
    })

    // Give subscription time to register
    await new Promise(resolve => setTimeout(resolve, 100))

    await broker.publish(`mcp/session/${sessionId}/message`, testMessage)
    await messagePromise

    assert.ok(receivedMessage)
    assert.deepStrictEqual(receivedMessage, testMessage)

    await broker.close()
    await cleanupRedis(redis)
  })

  skipIfNoRedis('should handle broadcast notifications', async () => {
    const redis = await createTestRedis()
    const broker = new RedisMessageBroker(redis)

    const notification: JSONRPCMessage = {
      jsonrpc: '2.0',
      method: 'notifications/message',
      params: { message: 'Broadcast notification' }
    }

    let receivedNotification: JSONRPCMessage | null = null
    const notificationPromise = new Promise<void>((resolve) => {
      broker.subscribe('mcp/broadcast/notification', (message) => {
        receivedNotification = message
        resolve()
      })
    })

    // Give subscription time to register
    await new Promise(resolve => setTimeout(resolve, 100))

    await broker.publish('mcp/broadcast/notification', notification)
    await notificationPromise

    assert.ok(receivedNotification)
    assert.deepStrictEqual(receivedNotification, notification)

    await broker.close()
    await cleanupRedis(redis)
  })

  skipIfNoRedis('should handle unsubscribe', async () => {
    const redis = await createTestRedis()
    const broker = new RedisMessageBroker(redis)

    const testMessage: JSONRPCMessage = {
      jsonrpc: '2.0',
      method: 'test',
      id: 1
    }

    let messageReceived = false
    await broker.subscribe('unsub-topic', () => {
      messageReceived = true
    })

    // Give subscription time to register
    await new Promise(resolve => setTimeout(resolve, 100))

    await broker.unsubscribe('unsub-topic')

    // Give unsubscribe time to take effect
    await new Promise(resolve => setTimeout(resolve, 100))

    await broker.publish('unsub-topic', testMessage)

    // Wait a bit to see if message is received (it shouldn't be)
    await new Promise(resolve => setTimeout(resolve, 200))

    assert.strictEqual(messageReceived, false)

    await broker.close()
    await cleanupRedis(redis)
  })

  skipIfNoRedis('should handle multiple topics on same broker', async () => {
    const redis = await createTestRedis()
    const broker = new RedisMessageBroker(redis)

    const message1: JSONRPCMessage = {
      jsonrpc: '2.0',
      method: 'test1',
      id: 1
    }

    const message2: JSONRPCMessage = {
      jsonrpc: '2.0',
      method: 'test2',
      id: 2
    }

    const receivedMessages: JSONRPCMessage[] = []
    const messagePromise = new Promise<void>((resolve) => {
      let count = 0
      const handler = (message: JSONRPCMessage) => {
        receivedMessages.push(message)
        count++
        if (count === 2) {
          resolve()
        }
      }

      broker.subscribe('topic1', handler)
      broker.subscribe('topic2', handler)
    })

    // Give subscriptions time to register
    await new Promise(resolve => setTimeout(resolve, 100))

    await broker.publish('topic1', message1)
    await broker.publish('topic2', message2)
    await messagePromise

    assert.strictEqual(receivedMessages.length, 2)
    assert.ok(receivedMessages.some(msg => 'method' in msg && msg.method === 'test1'))
    assert.ok(receivedMessages.some(msg => 'method' in msg && msg.method === 'test2'))

    await broker.close()
    await cleanupRedis(redis)
  })

  skipIfNoRedis('should handle complex JSON-RPC messages', async () => {
    const redis = await createTestRedis()
    const broker = new RedisMessageBroker(redis)

    const complexMessage: JSONRPCMessage = {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'complex-tool',
        arguments: {
          nested: {
            array: [1, 2, 3],
            object: { key: 'value' }
          }
        }
      },
      id: 'complex-id-123'
    }

    let receivedMessage: JSONRPCMessage | null = null
    const messagePromise = new Promise<void>((resolve) => {
      broker.subscribe('complex-topic', (message) => {
        receivedMessage = message
        resolve()
      })
    })

    // Give subscription time to register
    await new Promise(resolve => setTimeout(resolve, 100))

    await broker.publish('complex-topic', complexMessage)
    await messagePromise

    assert.ok(receivedMessage)
    assert.deepStrictEqual(receivedMessage, complexMessage)

    await broker.close()
    await cleanupRedis(redis)
  })

  skipIfNoRedis('should handle broker close gracefully', async () => {
    const redis = await createTestRedis()
    const broker = new RedisMessageBroker(redis)

    const testMessage: JSONRPCMessage = {
      jsonrpc: '2.0',
      method: 'test',
      id: 1
    }

    await broker.subscribe('close-topic', () => {})

    // Give subscription time to register
    await new Promise(resolve => setTimeout(resolve, 100))

    await broker.publish('close-topic', testMessage)

    // Close should not throw
    await broker.close()

    await cleanupRedis(redis)
  })
})
