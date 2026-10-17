import { test, describe } from 'node:test'
import type { TestContext } from 'node:test'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { Type } from '@sinclair/typebox'
import mcpPlugin from '../src/index.ts'
import type {
  JSONRPCRequest,
  JSONRPCResultResponse,
  ListResourcesResult,
  ListResourceTemplatesResult,
  ReadResourceResult
} from '../src/schema.ts'
import { JSONRPC_VERSION, LATEST_PROTOCOL_VERSION } from '../src/schema.ts'

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
    const body = response.json() as JSONRPCResultResponse
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
    const body = response.json() as JSONRPCResultResponse
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
    const body = response.json() as JSONRPCResultResponse
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
    const body = response.json() as JSONRPCResultResponse
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

    const list = (listRes.json() as JSONRPCResultResponse).result as ListResourcesResult
    const templates = (templatesRes.json() as JSONRPCResultResponse).result as ListResourceTemplatesResult

    t.assert.strictEqual(list.resources.length, 2)
    t.assert.strictEqual(templates.resourceTemplates.length, 2)

    const listNames = list.resources.map(r => r.name).sort()
    t.assert.deepStrictEqual(listNames, ['config', 'status'])

    const templateNames = templates.resourceTemplates.map(r => r.name).sort()
    t.assert.deepStrictEqual(templateNames, ['agent', 'diary'])
  })

  describe('resources/read against a template', () => {
    async function read (app: ReturnType<typeof Fastify>, uri: string) {
      const response = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload: {
          jsonrpc: JSONRPC_VERSION,
          id: 1,
          method: 'resources/read',
          params: { uri }
        } satisfies JSONRPCRequest
      })
      return response.json()
    }

    test('matches a concrete URI and passes the extracted params', async (t: TestContext) => {
      const app = Fastify()
      t.after(() => app.close())
      await app.register(mcpPlugin)
      await app.ready()

      const seen: Array<{ uri: string, params: unknown }> = []
      app.mcpAddResource(
        { name: 'request', uriPattern: 'guardrails://{tenant}/request/{id}', description: 'Request' },
        async (uri, context) => {
          seen.push({ uri, params: context.uriParams })
          return { contents: [{ uri, text: `request ${context.uriParams?.id}`, mimeType: 'text/plain' }] }
        }
      )

      const body = await read(app, 'guardrails://support/request/req-123')
      const result = body.result as ReadResourceResult

      t.assert.ok('text' in result.contents[0])
      t.assert.strictEqual(result.contents[0].text, 'request req-123')
      t.assert.strictEqual(result.contents[0].uri, 'guardrails://support/request/req-123')
      t.assert.deepStrictEqual(seen, [{
        uri: 'guardrails://support/request/req-123',
        params: { tenant: 'support', id: 'req-123' }
      }])
    })

    test('percent-decodes extracted params', async (t: TestContext) => {
      const app = Fastify()
      t.after(() => app.close())
      await app.register(mcpPlugin)
      await app.ready()

      let params: unknown
      app.mcpAddResource({ name: 'file', uriPattern: 'files://{name}' }, async (uri, context) => {
        params = context.uriParams
        return { contents: [{ uri, text: 'ok' }] }
      })

      await read(app, 'files://hello%20world')
      t.assert.deepStrictEqual(params, { name: 'hello world' })
    })

    test('placeholders do not span slashes or match empty segments', async (t: TestContext) => {
      const app = Fastify()
      t.after(() => app.close())
      await app.register(mcpPlugin)
      await app.ready()

      app.mcpAddResource({ name: 'diary', uriPattern: 'moltnet://diary/{id}' }, async (uri) => ({
        contents: [{ uri, text: 'ok' }]
      }))

      for (const uri of ['moltnet://diary/1/2', 'moltnet://diary/', 'moltnet://diary', 'xmoltnet://diary/1', 'moltnet://diary/1x/']) {
        const body = await read(app, uri)
        t.assert.strictEqual(body.error?.code, -32002, uri)
      }
    })

    test('literal parts are matched literally, not as regex', async (t: TestContext) => {
      const app = Fastify()
      t.after(() => app.close())
      await app.register(mcpPlugin)
      await app.ready()

      app.mcpAddResource({ name: 'v', uriPattern: 'app://v1.0/{id}' }, async (uri) => ({
        contents: [{ uri, text: 'ok' }]
      }))

      t.assert.strictEqual((await read(app, 'app://v1x0/42')).error?.code, -32002)
      t.assert.ok((await read(app, 'app://v1.0/42')).result)
    })

    test('an exact concrete resource wins over a matching template', async (t: TestContext) => {
      const app = Fastify()
      t.after(() => app.close())
      await app.register(mcpPlugin)
      await app.ready()

      app.mcpAddResource({ name: 'any', uriPattern: 'moltnet://diary/{id}' }, async (uri) => ({
        contents: [{ uri, text: 'template' }]
      }))
      app.mcpAddResource({ name: 'latest', uri: 'moltnet://diary/latest' }, async (uri) => ({
        contents: [{ uri, text: 'concrete' }]
      }))

      const result = (await read(app, 'moltnet://diary/latest')).result as ReadResourceResult
      t.assert.ok('text' in result.contents[0])
      t.assert.strictEqual(result.contents[0].text, 'concrete')
    })

    async function setup (t: TestContext) {
      const app = Fastify()
      t.after(() => app.close())
      await app.register(mcpPlugin)
      await app.ready()
      return app
    }

    function addEcho (app: FastifyInstance, name: string, uriPattern: string) {
      app.mcpAddResource({ name, uriPattern }, async (uri, context) => ({
        contents: [{ uri, text: JSON.stringify({ name, params: context.uriParams }) }]
      }))
    }

    async function readEcho (app: ReturnType<typeof Fastify>, uri: string) {
      const body = await read(app, uri)
      if (body.error) return body.error
      const content = (body.result as ReadResourceResult).contents[0]
      return 'text' in content ? JSON.parse(content.text) : undefined
    }

    test('{+var} reserved expansion matches values containing slashes', async (t: TestContext) => {
      const app = await setup(t)
      addEcho(app, 'file', 'files://{+path}')

      t.assert.deepStrictEqual(await readEcho(app, 'files://a/b/c.txt'), { name: 'file', params: { path: 'a/b/c.txt' } })
      t.assert.deepStrictEqual(await readEcho(app, 'files://a%20b/c'), { name: 'file', params: { path: 'a b/c' } })
      t.assert.strictEqual((await readEcho(app, 'files://')).code, -32002)
    })

    test('{/var} path segment expansion is optional and does not span slashes', async (t: TestContext) => {
      const app = await setup(t)
      addEcho(app, 'items', 'x://items{/id,rev}')

      t.assert.deepStrictEqual(await readEcho(app, 'x://items/42'), { name: 'items', params: { id: '42' } })
      t.assert.deepStrictEqual(await readEcho(app, 'x://items/42/7'), { name: 'items', params: { id: '42', rev: '7' } })
      t.assert.deepStrictEqual(await readEcho(app, 'x://items'), { name: 'items', params: {} })
      t.assert.strictEqual((await readEcho(app, 'x://items/1/2/3')).code, -32002)
      t.assert.strictEqual((await readEcho(app, 'x://items/')).code, -32002)
    })

    test('{?a,b} and {&c} query expansions match in any order and are optional', async (t: TestContext) => {
      const app = await setup(t)
      addEcho(app, 'search', 'search://docs{?q,limit}{&page}')

      t.assert.deepStrictEqual(
        await readEcho(app, 'search://docs?page=2&limit=5&q=hello%20world'),
        { name: 'search', params: { q: 'hello world', limit: '5', page: '2' } }
      )
      t.assert.deepStrictEqual(await readEcho(app, 'search://docs?q='), { name: 'search', params: { q: '' } })
      t.assert.deepStrictEqual(await readEcho(app, 'search://docs'), { name: 'search', params: {} })

      // Not an expansion of the template: unknown or repeated parameters
      t.assert.strictEqual((await readEcho(app, 'search://docs?other=1')).code, -32002)
      t.assert.strictEqual((await readEcho(app, 'search://docs?q=a&q=b')).code, -32002)
      t.assert.strictEqual((await readEcho(app, 'search://docsx?q=a')).code, -32002)
    })

    test('query expansions combine with path expressions', async (t: TestContext) => {
      const app = await setup(t)
      addEcho(app, 'file', 'files://{+path}{?rev}')
      addEcho(app, 'user', 'users://{id}{?fields}')

      t.assert.deepStrictEqual(await readEcho(app, 'files://a/b?rev=3'), { name: 'file', params: { path: 'a/b', rev: '3' } })
      t.assert.deepStrictEqual(await readEcho(app, 'files://a/b'), { name: 'file', params: { path: 'a/b' } })
      t.assert.deepStrictEqual(await readEcho(app, 'users://7?fields=name'), { name: 'user', params: { id: '7', fields: 'name' } })
      t.assert.strictEqual((await readEcho(app, 'users://7/8?fields=name')).code, -32002)
    })

    test('unsupported templates are rejected at registration', async (t: TestContext) => {
      const app = await setup(t)

      for (const uriPattern of [
        'x://doc{#section}',
        'x://file{.ext}',
        'x://map{;x,y}',
        'x://{a,b}',
        'x://{+a,b}',
        'x://{list*}',
        'x://{name:3}',
        'x://{?q}/more',
        'x://s?v=1{&q}',
        'x://s{&q}',
        'x://{a-b}',
        'x://{}x{=a}'
      ]) {
        t.assert.throws(
          () => app.mcpAddResource({ name: 'bad', uriPattern }),
          (err: Error) => err.message.includes(`'${uriPattern}'`),
          uriPattern
        )
      }

      const response = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload: { jsonrpc: JSONRPC_VERSION, id: 1, method: 'resources/templates/list' } satisfies JSONRPCRequest
      })
      const result = (response.json() as JSONRPCResultResponse).result as ListResourceTemplatesResult
      t.assert.deepStrictEqual(result.resourceTemplates, [])
    })

    test('prefers the template with the most literal characters', async (t: TestContext) => {
      const app = await setup(t)
      addEcho(app, 'generic', 'x://{a}/{b}')
      addEcho(app, 'files', 'x://files/{name}')

      t.assert.deepStrictEqual(await readEcho(app, 'x://files/a'), { name: 'files', params: { name: 'a' } })
      t.assert.deepStrictEqual(await readEcho(app, 'x://other/a'), { name: 'generic', params: { a: 'other', b: 'a' } })
    })

    test('equally specific templates are tried in registration order', async (t: TestContext) => {
      const app = await setup(t)
      addEcho(app, 'first', 'x://{a}/b')
      addEcho(app, 'second', 'x://a/{b}')

      t.assert.deepStrictEqual(await readEcho(app, 'x://a/b'), { name: 'first', params: { a: 'a' } })
    })
  })

  test('listings expose only spec Resource and ResourceTemplate fields', async (t: TestContext) => {
    const app = Fastify()
    t.after(() => app.close())

    await app.register(mcpPlugin)
    await app.ready()

    const shared = {
      title: 'Title',
      description: 'Description',
      mimeType: 'text/plain',
      icons: [{ src: 'https://example.com/icon.png' }],
      annotations: { audience: ['user' as const], priority: 0.5 },
      _meta: { custom: true }
    }
    app.mcpAddResource({
      ...shared,
      name: 'status',
      uriPattern: 'file:///status',
      uriSchema: Type.String({ pattern: '^file:///status' }),
      size: 42
    })
    app.mcpAddResource({
      ...shared,
      name: 'doc',
      uriPattern: 'file:///docs/{id}',
      uriSchema: Type.String({ pattern: '^file:///docs/' })
    })

    const list = async (method: string) => {
      const response = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { 'mcp-protocol-version': LATEST_PROTOCOL_VERSION },
        payload: { jsonrpc: JSONRPC_VERSION, id: 1, method } satisfies JSONRPCRequest
      })
      return (response.json() as JSONRPCResultResponse).result
    }

    // uriPattern and uriSchema are registration inputs, not part of the spec
    // shapes, and would leak the server's validation patterns
    const resources = (await list('resources/list')) as ListResourcesResult
    t.assert.deepStrictEqual(resources.resources, [{
      ...shared,
      uri: 'file:///status',
      name: 'status',
      size: 42
    }])

    const templates = (await list('resources/templates/list')) as ListResourceTemplatesResult
    t.assert.deepStrictEqual(templates.resourceTemplates, [{
      ...shared,
      uriTemplate: 'file:///docs/{id}',
      name: 'doc'
    }])
  })
})
