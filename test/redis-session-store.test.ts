import { describe } from 'node:test'
import assert from 'node:assert'
import { RedisSessionStore } from '../src/stores/redis-session-store.ts'
import { testWithRedis } from './redis-test-utils.ts'
import type { SessionMetadata } from '../src/stores/session-store.ts'
import type { JSONRPCMessage } from '../src/schema.ts'

describe('RedisSessionStore', () => {
  testWithRedis('should create and retrieve session metadata', async (redis) => {
    const store = new RedisSessionStore({ redis, maxMessages: 100 })

    const metadata: SessionMetadata = {
      id: 'test-session-1',
      createdAt: new Date('2023-01-01T00:00:00.000Z'),
      lastActivity: new Date('2023-01-01T00:01:00.000Z'),
      streams: new Map()
    }

    await store.create(metadata)
    const retrieved = await store.get('test-session-1')

    assert.ok(retrieved)
    assert.strictEqual(retrieved.id, metadata.id)
    assert.deepStrictEqual(retrieved.createdAt, metadata.createdAt)
    assert.deepStrictEqual(retrieved.lastActivity, metadata.lastActivity)
    assert.ok(retrieved.streams instanceof Map)
    assert.strictEqual(retrieved.streams.size, 0)
  })

  testWithRedis('should return null for non-existent session', async (redis) => {
    const store = new RedisSessionStore({ redis, maxMessages: 100 })

    const result = await store.get('non-existent-session')
    assert.strictEqual(result, null)
  })

  testWithRedis('should delete session and its history', async (redis) => {
    const store = new RedisSessionStore({ redis, maxMessages: 100 })

    const metadata: SessionMetadata = {
      id: 'test-session-2',
      createdAt: new Date(),
      lastActivity: new Date(),
      streams: new Map()
    }

    await store.create(metadata)

    // Add some message history
    const message: JSONRPCMessage = {
      jsonrpc: '2.0',
      method: 'test',
      id: 1
    }
    await store.addSessionMessage('test-session-2', '1', message)

    // Verify session exists
    const before = await store.get('test-session-2')
    assert.ok(before)

    // Delete session
    await store.delete('test-session-2')

    // Verify session is deleted
    const after = await store.get('test-session-2')
    assert.strictEqual(after, null)

    // Verify history is deleted
    const history = await store.getSessionMessagesFrom('test-session-2', '0')
    assert.strictEqual(history.length, 0)
  })

  testWithRedis('should add messages to history and update session metadata', async (redis) => {
    const store = new RedisSessionStore({ redis, maxMessages: 100 })

    const metadata: SessionMetadata = {
      id: 'test-session-3',
      
      createdAt: new Date(),
      lastActivity: new Date(),
      streams: new Map()
    }

    await store.create(metadata)

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

    await store.addMessage('test-session-3', '1', message1)
    await store.addMessage('test-session-3', '2', message2)

    // Check updated session metadata
    const updatedSession = await store.get('test-session-3')
    assert.ok(updatedSession)
    assert.strictEqual(updatedSession.lastEventId, '2')

    // Check message history
    const history = await store.getMessagesFrom('test-session-3', '0')
    assert.strictEqual(history.length, 2)
    assert.strictEqual(history[0].eventId, '1')
    assert.deepStrictEqual(history[0].message, message1)
    assert.strictEqual(history[1].eventId, '2')
    assert.deepStrictEqual(history[1].message, message2)
  })

  testWithRedis('should replay messages from specific event ID', async (redis) => {
    const store = new RedisSessionStore({ redis, maxMessages: 100 })

    const metadata: SessionMetadata = {
      id: 'test-session-4',
      
      createdAt: new Date(),
      lastActivity: new Date(),
      streams: new Map()
    }

    await store.create(metadata)

    const messages: JSONRPCMessage[] = [
      { jsonrpc: '2.0', method: 'test1', id: 1 },
      { jsonrpc: '2.0', method: 'test2', id: 2 },
      { jsonrpc: '2.0', method: 'test3', id: 3 }
    ]

    for (let i = 0; i < messages.length; i++) {
      await store.addMessage('test-session-4', (i + 1).toString(), messages[i])
    }

    // Get messages from event ID 1 (should return events 2 and 3)
    const history = await store.getMessagesFrom('test-session-4', '1')
    assert.strictEqual(history.length, 2)
    assert.strictEqual(history[0].eventId, '2')
    assert.deepStrictEqual(history[0].message, messages[1])
    assert.strictEqual(history[1].eventId, '3')
    assert.deepStrictEqual(history[1].message, messages[2])
  })

  testWithRedis('should trim message history to max messages', async (redis) => {
    const store = new RedisSessionStore({ redis, maxMessages: 3 })

    const metadata: SessionMetadata = {
      id: 'test-session-5',
      
      createdAt: new Date(),
      lastActivity: new Date(),
      streams: new Map()
    }

    await store.create(metadata)

    // Add 5 messages (should keep only last 3)
    for (let i = 1; i <= 5; i++) {
      const message: JSONRPCMessage = {
        jsonrpc: '2.0',
        method: `test${i}`,
        id: i
      }
      await store.addMessage('test-session-5', i.toString(), message)
    }

    // Should have exactly 3 messages (exact trimming)
    const history = await store.getMessagesFrom('test-session-5', '0')
    assert.strictEqual(history.length, 3)
    assert.strictEqual(history[0].eventId, '3')
    assert.strictEqual(history[1].eventId, '4')
    assert.strictEqual(history[2].eventId, '5')
  })

  testWithRedis('should handle cleanup of orphaned message histories', async (redis) => {
    const store = new RedisSessionStore({ redis, maxMessages: 100 })

    const metadata: SessionMetadata = {
      id: 'test-session-6',
      
      createdAt: new Date(),
      lastActivity: new Date(),
      streams: new Map()
    }

    await store.create(metadata)

    // Add a message to create history
    const message: JSONRPCMessage = {
      jsonrpc: '2.0',
      method: 'test',
      id: 1
    }
    await store.addMessage('test-session-6', '1', message)

    // Delete only the session (not the history) to simulate orphaned history
    await redis.del('session:test-session-6')

    // Run cleanup
    await store.cleanup()

    // Verify history was cleaned up
    const exists = await redis.exists('session:test-session-6:history')
    assert.strictEqual(exists, 0)
  })

  testWithRedis('should handle session expiration', async (redis) => {
    const store = new RedisSessionStore({ redis, maxMessages: 100 })

    const metadata: SessionMetadata = {
      id: 'test-session-7',
      
      createdAt: new Date(),
      lastActivity: new Date(),
      streams: new Map()
    }

    await store.create(metadata)

    // Check TTL is set (should be around 3600 seconds)
    const ttl = await redis.ttl('session:test-session-7')
    assert.ok(ttl > 3500 && ttl <= 3600)

    // Adding a message should reset TTL
    const message: JSONRPCMessage = {
      jsonrpc: '2.0',
      method: 'test',
      id: 1
    }
    await store.addMessage('test-session-7', '1', message)

    const newTtl = await redis.ttl('session:test-session-7')
    assert.ok(newTtl > 3500 && newTtl <= 3600)
  })

  testWithRedis('should return empty array for non-existent message history', async (redis) => {
    const store = new RedisSessionStore({ redis, maxMessages: 100 })

    const history = await store.getMessagesFrom('non-existent-session', '0')
    assert.strictEqual(history.length, 0)
  })
})
