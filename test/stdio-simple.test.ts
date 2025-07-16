import { test } from 'node:test'
import assert from 'node:assert'
import { setTimeout } from 'node:timers/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Helper function to wait for output with timeout
async function waitForOutput (stdoutRef: { value: string }, expectedLines: number, timeout: number = 3000): Promise<string[]> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const lines = stdoutRef.value.trim().split('\n').filter(line => line.length > 0)
    if (lines.length >= expectedLines) {
      return lines
    }
    await setTimeout(50) // Check every 50ms
  }
  throw new Error(`Timeout waiting for ${expectedLines} lines of output. Got: "${stdoutRef.value}"`)
}

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

  const stdoutRef = { value: '' }
  let stderr = ''

  child.stdout.on('data', (data) => {
    stdoutRef.value += data.toString()
  })

  child.stderr.on('data', (data) => {
    stderr += data.toString()
  })

  // Handle process exit
  child.on('exit', (code, _signal) => {
    if (code !== 0 && code !== null) {
      console.error(`Child process exited with code ${code}`)
      console.error('stderr:', stderr)
    }
  })

  // Wait for the server to start
  await setTimeout(300)

  try {
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

    // Wait for response with timeout
    const lines = await waitForOutput(stdoutRef, 1)

    if (lines.length === 0 || !lines[0]) {
      throw new Error(`No response received. stdout: "${stdoutRef.value}", stderr: "${stderr}"`)
    }

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
    const pingLines = await waitForOutput(stdoutRef, 2)

    const pingResponse = JSON.parse(pingLines[1])
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
    const toolsLines = await waitForOutput(stdoutRef, 3)

    const toolsResponse = JSON.parse(toolsLines[2])
    assert.strictEqual(toolsResponse.jsonrpc, '2.0')
    assert.strictEqual(toolsResponse.id, 3)
    assert(toolsResponse.result, 'Should have result')
    assert(Array.isArray(toolsResponse.result.tools), 'Should have tools array')
    assert(toolsResponse.result.tools.length > 0, 'Should have at least one tool')
    assert.strictEqual(toolsResponse.result.tools[0].name, 'echo')
  } catch (error) {
    console.error('Test failed with error:', error)
    console.error('stdout:', stdoutRef.value)
    console.error('stderr:', stderr)
    throw error
  } finally {
    // Clean up
    child.kill('SIGTERM')
  }
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

  const stdoutRef = { value: '' }
  let stderr = ''

  child.stdout.on('data', (data) => {
    stdoutRef.value += data.toString()
  })

  child.stderr.on('data', (data) => {
    stderr += data.toString()
  })

  await setTimeout(300)

  try {
    // Test invalid method
    const invalidRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'nonexistent_method'
    }

    child.stdin.write(JSON.stringify(invalidRequest) + '\n')

    const lines = await waitForOutput(stdoutRef, 1)

    const errorResponse = JSON.parse(lines[0])
    assert.strictEqual(errorResponse.jsonrpc, '2.0')
    assert.strictEqual(errorResponse.id, 1)
    assert(errorResponse.error, 'Should have error')
    assert.strictEqual(errorResponse.error.code, -32601) // Method not found
  } catch (error) {
    console.error('Error test failed:', error)
    console.error('stdout:', stdoutRef.value)
    console.error('stderr:', stderr)
    throw error
  } finally {
    child.kill('SIGTERM')
  }
})
