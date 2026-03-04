import { test, describe } from 'node:test'
import { strict as assert } from 'node:assert'
import Fastify from 'fastify'
import { request, Agent, setGlobalDispatcher } from 'undici'
import mcpPlugin from '../src/index.ts'

setGlobalDispatcher(new Agent({
  keepAliveTimeout: 10,
  keepAliveMaxTimeout: 10
}))

describe('Async Iterator Streaming Tests', () => {
  test('should return immediate JSON response for non-async-iterator tool results', async (t) => {
    const app = Fastify({ logger: false })

    t.after(async () => {
      await app.close()
    })

    await app.register(mcpPlugin, {
      serverInfo: { name: 'test-server', version: '1.0.0' },
      enableSSE: true
    })

    // Regular tool that returns immediate result
    app.mcpAddTool({
      name: 'immediate_tool',
      description: 'Tool that returns immediate result',
      inputSchema: {
        type: 'object',
        properties: {
          value: { type: 'string' }
        },
        required: ['value']
      }
    }, async (params) => {
      return {
        content: [{ type: 'text', text: `Immediate result: ${params.value}` }]
      }
    })

    await app.ready()

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json'
      },
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'immediate_tool',
          arguments: { value: 'test' }
        }
      }
    })

    assert.strictEqual(response.statusCode, 200)
    assert.strictEqual(response.headers['content-type'], 'application/json; charset=utf-8')

    const result = JSON.parse(response.payload)
    assert.strictEqual(result.jsonrpc, '2.0')
    assert.strictEqual(result.id, 1)
    assert.deepStrictEqual(result.result.content, [{ type: 'text', text: 'Immediate result: test' }])
  })

  test('should return text/event-stream for async iterator tool results', async (t) => {
    const app = Fastify({ logger: false })

    t.after(async () => {
      await app.close()
    })

    await app.register(mcpPlugin, {
      serverInfo: { name: 'test-server', version: '1.0.0' },
      enableSSE: true
    })

    // Async generator tool that returns streaming results
    app.mcpAddTool({
      name: 'streaming_tool',
      description: 'Tool that returns async iterator results',
      inputSchema: {
        type: 'object',
        properties: {
          count: { type: 'number' }
        },
        required: ['count']
      }
    }, async function * (params) {
      for (let i = 1; i <= params.count; i++) {
        yield {
          content: [{ type: 'text', text: `Chunk ${i}` }]
        }
        // Small delay to simulate async work
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      return {
        content: [{ type: 'text', text: 'Final result' }]
      }
    })

    await app.ready()
    const baseUrl = await app.listen({ port: 0 })

    const response = await request(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'streaming_tool',
          arguments: { count: 3 }
        }
      })
    })

    assert.strictEqual(response.statusCode, 200)
    assert.strictEqual(response.headers['content-type'], 'text/event-stream')

    // Parse SSE events from the response
    const responseText = await response.body.text()
    const events = parseSSEEvents(responseText)

    // Should have 4 events: 3 chunks + 1 final result
    assert.strictEqual(events.length, 4)

    // Check the content of each event
    assert.deepStrictEqual(JSON.parse(events[0].data), {
      jsonrpc: '2.0',
      id: 2,
      result: { content: [{ type: 'text', text: 'Chunk 1' }] }
    })

    assert.deepStrictEqual(JSON.parse(events[1].data), {
      jsonrpc: '2.0',
      id: 2,
      result: { content: [{ type: 'text', text: 'Chunk 2' }] }
    })

    assert.deepStrictEqual(JSON.parse(events[2].data), {
      jsonrpc: '2.0',
      id: 2,
      result: { content: [{ type: 'text', text: 'Chunk 3' }] }
    })

    assert.deepStrictEqual(JSON.parse(events[3].data), {
      jsonrpc: '2.0',
      id: 2,
      result: { content: [{ type: 'text', text: 'Final result' }] }
    })
  })

  test('should handle errors during streaming gracefully', async (t) => {
    const app = Fastify({ logger: false })

    t.after(async () => {
      await app.close()
    })

    await app.register(mcpPlugin, {
      serverInfo: { name: 'test-server', version: '1.0.0' },
      enableSSE: true
    })

    // Async generator tool that throws an error
    app.mcpAddTool({
      name: 'error_tool',
      description: 'Tool that errors during streaming',
      inputSchema: {
        type: 'object',
        properties: {
          errorAt: { type: 'number' }
        },
        required: ['errorAt']
      }
    }, async function * (params) {
      for (let i = 1; i <= 5; i++) {
        if (i === params.errorAt) {
          throw new Error(`Error at chunk ${i}`)
        }
        yield {
          content: [{ type: 'text', text: `Chunk ${i}` }]
        }
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      return {
        content: [{ type: 'text', text: 'Should not reach here' }]
      }
    })

    await app.ready()
    const baseUrl = await app.listen({ port: 0 })

    const response = await request(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'error_tool',
          arguments: { errorAt: 3 }
        }
      })
    })

    assert.strictEqual(response.statusCode, 200)
    assert.strictEqual(response.headers['content-type'], 'text/event-stream')

    const responseText = await response.body.text()
    const events = parseSSEEvents(responseText)

    // Should have 3 events: 2 successful chunks + 1 error event
    assert.strictEqual(events.length, 3)

    // Check successful chunks
    assert.deepStrictEqual(JSON.parse(events[0].data), {
      jsonrpc: '2.0',
      id: 3,
      result: { content: [{ type: 'text', text: 'Chunk 1' }] }
    })

    assert.deepStrictEqual(JSON.parse(events[1].data), {
      jsonrpc: '2.0',
      id: 3,
      result: { content: [{ type: 'text', text: 'Chunk 2' }] }
    })

    // Check error event
    const errorEvent = JSON.parse(events[2].data)
    assert.strictEqual(errorEvent.jsonrpc, '2.0')
    assert.strictEqual(errorEvent.id, 3)
    assert.ok(errorEvent.error)
    assert.ok(errorEvent.error.message.includes('Error at chunk 3'))
  })

  test('should use per-session event ID system for streaming', async (t) => {
    const app = Fastify({ logger: false })

    t.after(async () => {
      await app.close()
    })

    await app.register(mcpPlugin, {
      serverInfo: { name: 'test-server', version: '1.0.0' },
      enableSSE: true
    })

    // Tool that returns a few chunks
    app.mcpAddTool({
      name: 'event_id_tool',
      description: 'Tool for testing event IDs',
      inputSchema: {
        type: 'object',
        properties: {
          chunks: { type: 'number' }
        },
        required: ['chunks']
      }
    }, async function * (params) {
      for (let i = 1; i <= params.chunks; i++) {
        yield {
          content: [{ type: 'text', text: `Event ${i}` }]
        }
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      return {
        content: [{ type: 'text', text: 'Final event' }]
      }
    })

    await app.ready()
    const baseUrl = await app.listen({ port: 0 })

    const response = await request(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'event_id_tool',
          arguments: { chunks: 3 }
        }
      })
    })

    assert.strictEqual(response.statusCode, 200)
    assert.strictEqual(response.headers['content-type'], 'text/event-stream')

    const responseText = await response.body.text()
    const events = parseSSEEvents(responseText)
    assert.strictEqual(events.length, 4) // 3 yielded + 1 final return

    // Check that event IDs increment properly
    assert.strictEqual(events[0].id, '1')
    assert.strictEqual(events[1].id, '2')
    assert.strictEqual(events[2].id, '3')
    assert.strictEqual(events[3].id, '4')
  })

  test('should handle async iterator that returns no values', async (t) => {
    const app = Fastify({ logger: false })

    t.after(async () => {
      await app.close()
    })

    await app.register(mcpPlugin, {
      serverInfo: { name: 'test-server', version: '1.0.0' },
      enableSSE: true
    })

    // Empty async generator
    app.mcpAddTool({
      name: 'empty_tool',
      description: 'Tool that returns empty iterator',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    }, async function * () {
      // Empty generator - no yields
      return {
        content: [{ type: 'text', text: 'Empty result' }]
      }
    })

    await app.ready()
    const baseUrl = await app.listen({ port: 0 })

    const response = await request(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'empty_tool',
          arguments: {}
        }
      })
    })

    assert.strictEqual(response.statusCode, 200)
    assert.strictEqual(response.headers['content-type'], 'text/event-stream')

    const responseText = await response.body.text()
    const events = parseSSEEvents(responseText)

    // Should have 1 event with the final return value
    assert.strictEqual(events.length, 1)
    assert.deepStrictEqual(JSON.parse(events[0].data), {
      jsonrpc: '2.0',
      id: 5,
      result: { content: [{ type: 'text', text: 'Empty result' }] }
    })
  })
})

// Helper function to parse Server-Sent Events from raw response
function parseSSEEvents (payload: string | undefined): Array<{ id?: string; data: string; event?: string }> {
  if (!payload) return []

  const events: Array<{ id?: string; data: string; event?: string }> = []
  const lines = payload.split('\n')
  let currentEvent: { id?: string; data: string; event?: string } = { data: '' }

  for (const line of lines) {
    if (line.startsWith('id: ')) {
      currentEvent.id = line.slice(4)
    } else if (line.startsWith('event: ')) {
      currentEvent.event = line.slice(7)
    } else if (line.startsWith('data: ')) {
      currentEvent.data = line.slice(6)
    } else if (line === '') {
      // Empty line indicates end of event
      if (currentEvent.data) {
        events.push({ ...currentEvent })
      }
      currentEvent = { data: '' }
    }
  }

  return events
}
