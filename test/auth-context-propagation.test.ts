import { describe, it, beforeEach, afterEach } from 'node:test'
import * as assert from 'node:assert'
import Fastify from 'fastify'
import { Type, type Static } from '@sinclair/typebox'
import mcpPlugin from '../src/index.ts'
import type { HandlerContext } from '../src/types.ts'
import { createTestJWT, setupMockAgent, generateMockJWKSResponse } from './auth-test-utils.ts'

describe('Auth Context Propagation', () => {
  let app: ReturnType<typeof Fastify>
  let restoreMock: () => void

  beforeEach(async () => {
    app = Fastify({ logger: false })

    // Setup mock HTTP agent for JWKS fetching
    restoreMock = setupMockAgent({
      'https://auth.example.com/.well-known/jwks.json': generateMockJWKSResponse()
    })

    // Register MCP plugin with OAuth authorization
    await app.register(mcpPlugin, {
      serverInfo: { name: 'test-server', version: '1.0.0' },
      capabilities: { tools: {}, resources: {}, prompts: {} },
      enableSSE: false,
      authorization: {
        enabled: true,
        authorizationServers: ['https://auth.example.com'],
        resourceUri: 'http://localhost:3000',
        tokenValidation: {
          jwksUri: 'https://auth.example.com/.well-known/jwks.json',
          validateAudience: true
        }
      }
    })

    // Add a test tool that uses authContext
    const TestAuthContextSchema = Type.Object({})
    app.mcpAddTool({
      name: 'test_auth_context',
      description: 'Test tool that checks authContext',
      inputSchema: TestAuthContextSchema
    }, async (_params: Static<typeof TestAuthContextSchema>, context: HandlerContext) => {
      const authContext = context?.authContext

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            hasAuthContext: !!authContext,
            userId: authContext?.userId,
            clientId: authContext?.clientId,
            scopes: authContext?.scopes,
            audience: authContext?.audience,
            tokenType: authContext?.tokenType,
            authorizationServer: authContext?.authorizationServer,
            expiresAt: authContext?.expiresAt?.toISOString(),
            issuedAt: authContext?.issuedAt?.toISOString()
          }, null, 2)
        }]
      }
    })

    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    restoreMock()
  })

  it('should propagate authContext from valid JWT token to tools', async () => {
    const now = Math.floor(Date.now() / 1000)
    const tokenPayload = {
      sub: 'user123',
      client_id: 'client456',
      scope: 'read write',
      aud: ['http://localhost:3000'],
      iss: 'https://auth.example.com',
      exp: now + 3600,
      iat: now
    }

    const token = createTestJWT(tokenPayload)

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'test_auth_context',
          arguments: {}
        }
      }
    })

    assert.strictEqual(response.statusCode, 200)
    const result = response.json()

    assert.strictEqual(result.jsonrpc, '2.0')
    assert.strictEqual(result.id, 1)
    assert.ok(result.result)
    assert.ok(result.result.content)
    assert.strictEqual(result.result.content.length, 1)

    const authData = JSON.parse(result.result.content[0].text)

    assert.strictEqual(authData.hasAuthContext, true)
    assert.strictEqual(authData.userId, 'user123')
    assert.strictEqual(authData.clientId, 'client456')
    assert.deepStrictEqual(authData.scopes, ['read', 'write'])
    assert.deepStrictEqual(authData.audience, ['http://localhost:3000'])
    assert.strictEqual(authData.tokenType, 'Bearer')
    assert.strictEqual(authData.authorizationServer, 'https://auth.example.com')
    assert.ok(authData.expiresAt)
    assert.ok(authData.issuedAt)
  })

  it('should handle JWT with azp claim instead of client_id', async () => {
    const now = Math.floor(Date.now() / 1000)
    const tokenPayload = {
      sub: 'user789',
      azp: 'azp-client',  // Auth0 uses azp instead of client_id
      scope: 'admin',
      aud: 'http://localhost:3000',
      iss: 'https://auth.example.com',
      exp: now + 3600,
      iat: now
    }

    const token = createTestJWT(tokenPayload)

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'test_auth_context',
          arguments: {}
        }
      }
    })

    assert.strictEqual(response.statusCode, 200)
    const result = response.json()
    const authData = JSON.parse(result.result.content[0].text)

    assert.strictEqual(authData.hasAuthContext, true)
    assert.strictEqual(authData.userId, 'user789')
    assert.strictEqual(authData.clientId, 'azp-client')
    assert.deepStrictEqual(authData.scopes, ['admin'])
  })

  it('should handle JWT with scopes array instead of scope string', async () => {
    const now = Math.floor(Date.now() / 1000)
    const tokenPayload = {
      sub: 'user999',
      client_id: 'client999',
      scopes: ['read', 'write', 'delete'],  // Array format
      aud: ['http://localhost:3000'],
      iss: 'https://auth.example.com',
      exp: now + 3600,
      iat: now
    }

    const token = createTestJWT(tokenPayload)

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'test_auth_context',
          arguments: {}
        }
      }
    })

    assert.strictEqual(response.statusCode, 200)
    const result = response.json()
    const authData = JSON.parse(result.result.content[0].text)

    assert.strictEqual(authData.hasAuthContext, true)
    assert.deepStrictEqual(authData.scopes, ['read', 'write', 'delete'])
  })

  it('should handle requests without authorization token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json'
      },
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'test_auth_context',
          arguments: {}
        }
      }
    })

    // Should get 401 due to missing authorization
    assert.strictEqual(response.statusCode, 401)
    const result = response.json()
    assert.strictEqual(result.error, 'authorization_required')
  })

  it('should handle JWT with minimal claims', async () => {
    const now = Math.floor(Date.now() / 1000)
    const tokenPayload = {
      sub: 'minimal-user',
      iss: 'https://auth.example.com',
      aud: 'http://localhost:3000',
      exp: now + 3600,
      iat: now
    }

    const token = createTestJWT(tokenPayload)

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'test_auth_context',
          arguments: {}
        }
      }
    })

    assert.strictEqual(response.statusCode, 200)
    const result = response.json()
    const authData = JSON.parse(result.result.content[0].text)

    assert.strictEqual(authData.hasAuthContext, true)
    assert.strictEqual(authData.userId, 'minimal-user')
    assert.strictEqual(authData.clientId, undefined) // No client_id or azp
    assert.strictEqual(authData.scopes, undefined) // No scopes
    assert.deepStrictEqual(authData.audience, ['http://localhost:3000'])
    assert.strictEqual(authData.authorizationServer, 'https://auth.example.com')
  })
})
