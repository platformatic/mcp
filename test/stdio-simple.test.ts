import { test } from 'node:test'
import assert from 'node:assert'
import { setTimeout } from 'node:timers/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

test('stdio transport - full integration test', async () => {
  // This test runs the actual example stdio server as a subprocess
  const examplePath = join(__dirname, '..', 'examples', 'stdio-server.ts')

  const child = spawn('node', [
    '--experimental-strip-types',
    '--no-warnings',
    examplePath
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, DEBUG: 'false' }
  })

  let stdout = ''
  child.stdout.on('data', (data) => {
    stdout += data.toString()
  })

  child.stderr.on('data', (data) => {
    // stderr logging - we don't use this in tests but capture it
    data.toString()
  })

  // Wait for the server to start
  await setTimeout(100)

  // Test 1: Initialize request
  const initRequest = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: {
        name: 'test-client',
        version: '1.0.0'
      }
    }
  }

  child.stdin.write(JSON.stringify(initRequest) + '\n')

  // Wait for response
  await setTimeout(200)

  // Parse first response
  const lines = stdout.trim().split('\n')
  assert(lines.length > 0, 'Should have at least one response')

  const initResponse = JSON.parse(lines[0])
  assert.strictEqual(initResponse.jsonrpc, '2.0')
  assert.strictEqual(initResponse.id, 1)
  assert(initResponse.result, 'Should have result')
  assert(initResponse.result.serverInfo, 'Should have serverInfo')
  assert.strictEqual(initResponse.result.serverInfo.name, 'fastify-mcp-stdio-example')

  // Test 2: Ping request
  const pingRequest = {
    jsonrpc: '2.0',
    id: 2,
    method: 'ping'
  }

  child.stdin.write(JSON.stringify(pingRequest) + '\n')
  await setTimeout(100)

  const allLines = stdout.trim().split('\n')
  assert(allLines.length >= 2, 'Should have at least two responses')

  const pingResponse = JSON.parse(allLines[1])
  assert.strictEqual(pingResponse.jsonrpc, '2.0')
  assert.strictEqual(pingResponse.id, 2)
  assert.deepStrictEqual(pingResponse.result, {})

  // Test 3: List tools
  const toolsRequest = {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/list'
  }

  child.stdin.write(JSON.stringify(toolsRequest) + '\n')
  await setTimeout(100)

  const finalLines = stdout.trim().split('\n')
  assert(finalLines.length >= 3, 'Should have at least three responses')

  const toolsResponse = JSON.parse(finalLines[2])
  assert.strictEqual(toolsResponse.jsonrpc, '2.0')
  assert.strictEqual(toolsResponse.id, 3)
  assert(toolsResponse.result, 'Should have result')
  assert(Array.isArray(toolsResponse.result.tools), 'Should have tools array')
  assert(toolsResponse.result.tools.length > 0, 'Should have at least one tool')
  assert.strictEqual(toolsResponse.result.tools[0].name, 'echo')

  // Test 4: Call the echo tool
  const callToolRequest = {
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'echo',
      arguments: {
        text: 'Hello, stdio!'
      }
    }
  }

  child.stdin.write(JSON.stringify(callToolRequest) + '\n')
  await setTimeout(100)

  const toolCallLines = stdout.trim().split('\n')
  assert(toolCallLines.length >= 4, 'Should have at least four responses')

  const callToolResponse = JSON.parse(toolCallLines[3])
  assert.strictEqual(callToolResponse.jsonrpc, '2.0')
  assert.strictEqual(callToolResponse.id, 4)
  assert(callToolResponse.result, 'Should have result')
  assert(Array.isArray(callToolResponse.result.content), 'Should have content array')
  assert.strictEqual(callToolResponse.result.content[0].text, 'Echo: Hello, stdio!')

  // Clean up
  child.kill('SIGTERM')
})

test('stdio transport - error handling', async () => {
  const examplePath = join(__dirname, '..', 'examples', 'stdio-server.ts')

  const child = spawn('node', [
    '--experimental-strip-types',
    '--no-warnings',
    examplePath
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, DEBUG: 'false' }
  })

  let stdout = ''

  child.stdout.on('data', (data) => {
    stdout += data.toString()
  })

  await setTimeout(100)

  // Test invalid method
  const invalidRequest = {
    jsonrpc: '2.0',
    id: 1,
    method: 'nonexistent_method'
  }

  child.stdin.write(JSON.stringify(invalidRequest) + '\n')
  await setTimeout(100)

  const lines = stdout.trim().split('\n')
  assert(lines.length > 0, 'Should have response')

  const errorResponse = JSON.parse(lines[0])
  assert.strictEqual(errorResponse.jsonrpc, '2.0')
  assert.strictEqual(errorResponse.id, 1)
  assert(errorResponse.error, 'Should have error')
  assert.strictEqual(errorResponse.error.code, -32601) // Method not found

  child.kill('SIGTERM')
})

test('stdio transport - batch requests', async () => {
  const examplePath = join(__dirname, '..', 'examples', 'stdio-server.ts')

  const child = spawn('node', [
    '--experimental-strip-types',
    '--no-warnings',
    examplePath
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, DEBUG: 'false' }
  })

  let stdout = ''

  child.stdout.on('data', (data) => {
    stdout += data.toString()
  })

  await setTimeout(100)

  // Test batch request
  const batchRequest = [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'ping'
    },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'ping'
    }
  ]

  child.stdin.write(JSON.stringify(batchRequest) + '\n')
  await setTimeout(100)

  const lines = stdout.trim().split('\n')
  assert(lines.length > 0, 'Should have response')

  const batchResponse = JSON.parse(lines[0])
  assert(Array.isArray(batchResponse), 'Should return array for batch')
  assert.strictEqual(batchResponse.length, 2)
  assert.strictEqual(batchResponse[0].id, 1)
  assert.strictEqual(batchResponse[1].id, 2)

  child.kill('SIGTERM')
})
