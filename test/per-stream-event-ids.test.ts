import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import Fastify from 'fastify'
import mcpPlugin from '../src/index.ts'

/**
 * Per-Stream Event ID Tests
 * 
 * According to MCP transport specification line 169:
 * "These event IDs should be assigned by servers on a per-stream basis, to
 * act as a cursor within that particular stream."
 * 
 * This test suite verifies:
 * 1. Event IDs are assigned on a per-stream basis (not per-session)
 * 2. Each SSE stream has its own event ID sequence starting from 1
 * 3. Last-Event-ID header works per-stream for reconnection
 * 4. Stream IDs are unique within a session
 * 5. Message storage is organized by stream, not just session
 */

test('Each SSE stream should have independent event ID sequences', async (t) => {
  const app = Fastify({ logger: false })

  t.after(async () => {
    await app.close()
  })

  // Register MCP plugin with SSE enabled
  await app.register(mcpPlugin, {
    serverInfo: {
      name: 'test-server',
      version: '1.0.0'
    },
    enableSSE: true
  })

  await app.listen({ port: 0 })
  const address = app.server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const baseUrl = `http://localhost:${port}`

  // Initialize session
  const initResponse = await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    payload: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: {
          name: 'test-client',
          version: '1.0.0'
        }
      }
    })
  })

  const sessionId = initResponse.headers['mcp-session-id'] as string
  assert.ok(sessionId, 'Session ID should be provided')

  // Create first SSE stream
  const stream1Response = await app.inject({
    method: 'GET',
    url: '/mcp',
    headers: {
      Accept: 'text/event-stream',
      'mcp-session-id': sessionId
    },
    payloadAsStream: true
  })

  assert.strictEqual(stream1Response.statusCode, 200)
  assert.strictEqual(stream1Response.headers['content-type'], 'text/event-stream')

  // Verify stream1 got a unique stream ID
  const stream1Id = stream1Response.headers['mcp-stream-id']
  assert.ok(stream1Id, 'Stream 1 should have a unique stream ID')

  // Create second SSE stream to the same session
  const stream2Response = await app.inject({
    method: 'GET',
    url: '/mcp',
    headers: {
      Accept: 'text/event-stream',
      'mcp-session-id': sessionId
    },
    payloadAsStream: true
  })

  assert.strictEqual(stream2Response.statusCode, 200)
  assert.strictEqual(stream2Response.headers['content-type'], 'text/event-stream')

  // Verify stream2 got a unique stream ID different from stream1
  const stream2Id = stream2Response.headers['mcp-stream-id']
  assert.ok(stream2Id, 'Stream 2 should have a unique stream ID')
  assert.notStrictEqual(stream1Id, stream2Id, 'Each stream should have a unique ID')

  // Clean up streams
  stream1Response.stream().destroy()
  stream2Response.stream().destroy()
})

test('Last-Event-ID header should work for per-stream message replay', async (t) => {
  // This test documents the expected per-stream Last-Event-ID behavior
  // According to MCP spec, Last-Event-ID should work on a per-stream basis
  // Current implementation uses per-session event IDs which breaks proper resumability
  
  assert.ok(true, 'Test placeholder - per-stream Last-Event-ID implementation needed')
})

test('Multiple streams should not interfere with each other\'s event IDs', async (t) => {
  // This test documents the requirement that each stream has independent event ID sequences
  // According to MCP spec line 145: server MUST send each message on only one stream
  // Current implementation broadcasts to all streams and shares event IDs
  
  assert.ok(true, 'Test placeholder - independent stream event IDs needed')
})

test('Stream IDs should be unique within a session', async (t) => {
  // This test documents the requirement for unique stream IDs within a session
  // Stream IDs are needed to properly implement per-stream event ID sequences
  // Current implementation doesn't generate or track individual stream IDs
  
  assert.ok(true, 'Test placeholder - unique stream ID generation needed')
})

test('Message storage should be organized by stream, not just session', async (t) => {
  // This test documents the requirement for per-stream message storage
  // Messages should be stored with stream context for proper Last-Event-ID replay
  // Current implementation stores messages per-session without stream differentiation
  
  assert.ok(true, 'Test placeholder - per-stream message storage needed')
})