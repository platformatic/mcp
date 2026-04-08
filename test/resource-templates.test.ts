import { test, describe } from 'node:test'
import type { TestContext } from 'node:test'
import Fastify from 'fastify'
import mcpPlugin from '../src/index.ts'
import type {
  JSONRPCRequest,
  JSONRPCResponse,
  ListResourcesResult,
  ListResourceTemplatesResult,
  ReadResourceResult
} from '../src/schema.ts'
import { JSONRPC_VERSION } from '../src/schema.ts'

describe('Resource Templates', () => {
  test('resources/list excludes template URIs', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())

    await app.register(mcpPlugin)
    await app.ready()

    app.mcpAddResource({ name: 'concrete', uri: 'moltnet://status', description: 'Status' })
    app.mcpAddResource({ name: 'template', uri: 'moltnet://diary/{id}', description: 'Diary entry' })

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'resources/list'
      } satisfies JSONRPCRequest
    })

    t.assert.strictEqual(response.statusCode, 200)
    const body = response.json() as JSONRPCResponse
    const result = body.result as ListResourcesResult
    t.assert.strictEqual(result.resources.length, 1)
    t.assert.strictEqual(result.resources[0].name, 'concrete')
    t.assert.strictEqual(result.resources[0].uri, 'moltnet://status')
  })

  test('resources/templates/list returns only template resources with correct shape', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())

    await app.register(mcpPlugin)
    await app.ready()

    app.mcpAddResource({ name: 'concrete', uri: 'moltnet://status', description: 'Status' })
    app.mcpAddResource({ name: 'diary', uri: 'moltnet://diary/{id}', description: 'Diary entry', mimeType: 'application/json' })
    app.mcpAddResource({ name: 'agent', uri: 'moltnet://agent/{fingerprint}', description: 'Agent info' })

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'resources/templates/list'
      } satisfies JSONRPCRequest
    })

    t.assert.strictEqual(response.statusCode, 200)
    const body = response.json() as JSONRPCResponse
    const result = body.result as ListResourceTemplatesResult
    t.assert.strictEqual(result.resourceTemplates.length, 2)

    const diary = result.resourceTemplates.find(r => r.name === 'diary')
    t.assert.ok(diary)
    t.assert.strictEqual(diary.uriTemplate, 'moltnet://diary/{id}')
    t.assert.strictEqual(diary.description, 'Diary entry')
    t.assert.strictEqual(diary.mimeType, 'application/json')
    // Should not have the 'uri' field
    t.assert.strictEqual('uri' in diary, false)

    const agent = result.resourceTemplates.find(r => r.name === 'agent')
    t.assert.ok(agent)
    t.assert.strictEqual(agent.uriTemplate, 'moltnet://agent/{fingerprint}')
  })

  test('resources/templates/list returns empty array when no templates exist', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())

    await app.register(mcpPlugin)
    await app.ready()

    app.mcpAddResource({ name: 'concrete', uri: 'moltnet://status', description: 'Status' })

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'resources/templates/list'
      } satisfies JSONRPCRequest
    })

    t.assert.strictEqual(response.statusCode, 200)
    const body = response.json() as JSONRPCResponse
    const result = body.result as ListResourceTemplatesResult
    t.assert.strictEqual(result.resourceTemplates.length, 0)
  })

  test('resources/read still works for template resources', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())

    await app.register(mcpPlugin)
    await app.ready()

    app.mcpAddResource(
      { name: 'diary', uri: 'moltnet://diary/{id}', description: 'Diary entry' },
      async (uri) => ({
        contents: [{ uri, text: `Diary content for ${uri}`, mimeType: 'text/plain' }]
      })
    )

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: {
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: 'resources/read',
        params: { uri: 'moltnet://diary/{id}' }
      } satisfies JSONRPCRequest
    })

    t.assert.strictEqual(response.statusCode, 200)
    const body = response.json() as JSONRPCResponse
    const result = body.result as ReadResourceResult
    t.assert.strictEqual(result.contents.length, 1)
    t.assert.ok('text' in result.contents[0] && result.contents[0].text.includes('moltnet://diary/{id}'))
  })

  test('mixed concrete and template resources are split correctly', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())

    await app.register(mcpPlugin)
    await app.ready()

    app.mcpAddResource({ name: 'status', uri: 'moltnet://status', description: 'Status' })
    app.mcpAddResource({ name: 'config', uri: 'moltnet://config', description: 'Config' })
    app.mcpAddResource({ name: 'diary', uri: 'moltnet://diary/{id}', description: 'Diary' })
    app.mcpAddResource({ name: 'agent', uri: 'moltnet://agent/{fingerprint}', description: 'Agent' })

    const [listRes, templatesRes] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/mcp',
        payload: { jsonrpc: JSONRPC_VERSION, id: 1, method: 'resources/list' } satisfies JSONRPCRequest
      }),
      app.inject({
        method: 'POST',
        url: '/mcp',
        payload: { jsonrpc: JSONRPC_VERSION, id: 2, method: 'resources/templates/list' } satisfies JSONRPCRequest
      })
    ])

    const list = (listRes.json() as JSONRPCResponse).result as ListResourcesResult
    const templates = (templatesRes.json() as JSONRPCResponse).result as ListResourceTemplatesResult

    t.assert.strictEqual(list.resources.length, 2)
    t.assert.strictEqual(templates.resourceTemplates.length, 2)

    const listNames = list.resources.map(r => r.name).sort()
    t.assert.deepStrictEqual(listNames, ['config', 'status'])

    const templateNames = templates.resourceTemplates.map(r => r.name).sort()
    t.assert.deepStrictEqual(templateNames, ['agent', 'diary'])
  })
})
