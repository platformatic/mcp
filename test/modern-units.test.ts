import { test, describe } from 'node:test'
import type { TestContext } from 'node:test'
import { EventEmitter } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import {
  encodeHeaderValue,
  decodeHeaderValue,
  expectedNameFor,
  collectHeaderParams,
  validateStandardHeaders,
  validateToolParamHeaders
} from '../src/modern/headers.ts'
import { RequestStateSealer, digestRequest } from '../src/modern/request-state.ts'
import { SubscriptionRegistry, negotiateFilter, matchesFilter } from '../src/modern/subscriptions.ts'
import { TaskInputChannel } from '../src/modern/task-inputs.ts'
import { parseRequestContext, bodyClaimsModern, isModernRequest } from '../src/modern/request-meta.ts'
import { isModernRevision } from '../src/protocol-version.ts'
import {
  META_PROTOCOL_VERSION,
  META_CLIENT_CAPABILITIES,
  META_CLIENT_INFO
} from '../src/schema-2026.ts'
import { JSONRPC_VERSION } from '../src/schema.ts'

describe('header value encoding', () => {
  test('plain ASCII values ride literally', (t: TestContext) => {
    t.assert.strictEqual(encodeHeaderValue('us-west1'), 'us-west1')
    t.assert.strictEqual(decodeHeaderValue('us-west1'), 'us-west1')
  })

  test('non-ASCII, padded and control values use the Base64 sentinel', (t: TestContext) => {
    for (const value of ['Hello, 世界', ' padded ', 'line1\nline2']) {
      const encoded = encodeHeaderValue(value)
      t.assert.ok(encoded.startsWith('=?base64?'), `${value} should be encoded`)
      t.assert.ok(encoded.endsWith('?='))
      t.assert.strictEqual(decodeHeaderValue(encoded), value)
    }
  })

  test('a literal that looks like the sentinel is encoded to stay unambiguous', (t: TestContext) => {
    const literal = '=?base64?literal?='
    const encoded = encodeHeaderValue(literal)
    t.assert.notStrictEqual(encoded, literal)
    t.assert.strictEqual(decodeHeaderValue(encoded), literal)
  })

  test('invalid Base64 inside the sentinel is rejected rather than guessed at', (t: TestContext) => {
    t.assert.strictEqual(decodeHeaderValue('=?base64?not!valid!?='), null)
  })

  test('malformed UTF-8 inside the sentinel is rejected', (t: TestContext) => {
    t.assert.strictEqual(decodeHeaderValue('=?base64?/w==?='), null)
  })
})

describe('standard header validation', () => {
  test('Mcp-Name mirrors name for tools and prompts, uri for resources', (t: TestContext) => {
    t.assert.strictEqual(expectedNameFor('tools/call', { name: 'x' }), 'x')
    t.assert.strictEqual(expectedNameFor('prompts/get', { name: 'p' }), 'p')
    t.assert.strictEqual(expectedNameFor('resources/read', { uri: 'file:///a' }), 'file:///a')
    t.assert.strictEqual(expectedNameFor('tools/list', {}), undefined)
  })

  test('a method with no name source does not require the header', (t: TestContext) => {
    const check = validateStandardHeaders({ 'mcp-method': 'tools/list' }, 'tools/list', {})
    t.assert.strictEqual(check.ok, true)
  })

  test('header names are matched case-insensitively but values are not', (t: TestContext) => {
    // Node lower-cases incoming header names, so the map is already normalised;
    // the value comparison must stay exact.
    const check = validateStandardHeaders(
      { 'mcp-method': 'Tools/Call', 'mcp-name': 'x' },
      'tools/call',
      { name: 'x' }
    )
    t.assert.strictEqual(check.ok, false)
  })
})

describe('x-mcp-header annotations', () => {
  test('nested properties reachable through `properties` are collected', (t: TestContext) => {
    const result = collectHeaderParams({
      type: 'object',
      properties: {
        outer: {
          type: 'object',
          properties: {
            region: { type: 'string', 'x-mcp-header': 'Region' }
          }
        }
      }
    })

    t.assert.strictEqual(result.ok, true)
    t.assert.deepStrictEqual(result.ok && [...result.params.entries()], [['region', ['outer', 'region']]])
  })

  test('a duplicate annotation is rejected', (t: TestContext) => {
    const result = collectHeaderParams({
      type: 'object',
      properties: {
        a: { type: 'string', 'x-mcp-header': 'Region' },
        b: { type: 'string', 'x-mcp-header': 'region' }
      }
    })
    t.assert.strictEqual(result.ok, false)
  })

  test('number-typed parameters may not be annotated', (t: TestContext) => {
    const result = collectHeaderParams({
      type: 'object',
      properties: { amount: { type: 'number', 'x-mcp-header': 'Amount' } }
    })
    t.assert.strictEqual(result.ok, false)
  })

  for (const [keyword, value] of [
    ['items', { type: 'string', 'x-mcp-header': 'Item' }],
    ['allOf', [{ type: 'string', 'x-mcp-header': 'All' }]],
    ['oneOf', [{ type: 'string', 'x-mcp-header': 'One' }]],
    ['anyOf', [{ type: 'string', 'x-mcp-header': 'Any' }]],
    ['not', { type: 'string', 'x-mcp-header': 'Not' }],
    ['if', { type: 'string', 'x-mcp-header': 'If' }],
    ['then', { type: 'string', 'x-mcp-header': 'Then' }],
    ['else', { type: 'string', 'x-mcp-header': 'Else' }]
  ] as const) {
    test(`an annotation under ${keyword} invalidates the schema`, (t: TestContext) => {
      const result = collectHeaderParams({ type: 'object', [keyword]: value })
      t.assert.strictEqual(result.ok, false)
    })
  }

  test('instance data containing an x-mcp-header key is not treated as a schema annotation', (t: TestContext) => {
    const result = collectHeaderParams({
      type: 'object',
      examples: [{ 'x-mcp-header': 'ordinary instance data' }],
      properties: { value: { type: 'string', 'x-mcp-header': 'Value' } }
    })
    t.assert.strictEqual(result.ok, true)
  })

  test('an annotation in a referenced definition is invalid', (t: TestContext) => {
    const result = collectHeaderParams({
      type: 'object',
      $ref: '#/$defs/value',
      $defs: {
        value: {
          type: 'object',
          properties: { tenant: { type: 'string', 'x-mcp-header': 'Tenant' } }
        }
      }
    })
    t.assert.strictEqual(result.ok, false)
  })

  test('cyclic schemas are rejected without overflowing the stack', (t: TestContext) => {
    const schema: Record<string, unknown> = { type: 'object' }
    schema.properties = { self: schema }
    const result = collectHeaderParams(schema)
    t.assert.strictEqual(result.ok, false)
  })

  test('integers compare by canonical safe-integer representation', (t: TestContext) => {
    const schema = {
      type: 'object',
      properties: { count: { type: 'integer', 'x-mcp-header': 'Count' } }
    }

    t.assert.strictEqual(
      validateToolParamHeaders({ 'mcp-param-count': '42' }, schema, { count: 42 }).ok,
      true
    )
    t.assert.strictEqual(
      validateToolParamHeaders({ 'mcp-param-count': '43' }, schema, { count: 42 }).ok,
      false
    )
    t.assert.strictEqual(
      validateToolParamHeaders({ 'mcp-param-count': String(Number.MAX_SAFE_INTEGER) }, schema, { count: Number.MAX_SAFE_INTEGER }).ok,
      true
    )
    t.assert.strictEqual(
      validateToolParamHeaders({ 'mcp-param-count': String(Number.MIN_SAFE_INTEGER) }, schema, { count: Number.MIN_SAFE_INTEGER }).ok,
      true
    )
    t.assert.strictEqual(
      validateToolParamHeaders({ 'mcp-param-count': '9007199254740993' }, schema, { count: Number('9007199254740993') }).ok,
      false
    )
    t.assert.strictEqual(
      validateToolParamHeaders({ 'mcp-param-count': '-9007199254740992' }, schema, { count: -9007199254740992 }).ok,
      false
    )
  })

  test('an absent parameter must carry no header, and vice versa', (t: TestContext) => {
    const schema = {
      type: 'object',
      properties: { region: { type: 'string', 'x-mcp-header': 'Region' } }
    }

    t.assert.strictEqual(validateToolParamHeaders({}, schema, {}).ok, true)
    t.assert.strictEqual(validateToolParamHeaders({}, schema, { region: 'x' }).ok, false)
    t.assert.strictEqual(validateToolParamHeaders({ 'mcp-param-region': 'x' }, schema, {}).ok, false)
    t.assert.strictEqual(validateToolParamHeaders({}, schema, { region: null }).ok, true)
  })
})

describe('request state sealing', () => {
  const base = { method: 'tools/call', params: { name: 'greet', arguments: { a: 1 } } }

  test('a sealed state round-trips its payload', (t: TestContext) => {
    const sealer = new RequestStateSealer({ secret: 'shared' })
    const state = sealer.seal({ ...base, payload: { step: 2 } })

    const opened = sealer.open(state, base)
    t.assert.strictEqual(opened.ok, true)
    t.assert.deepStrictEqual(opened.ok && opened.claims.payload, { step: 2 })
  })

  test('a different secret cannot open it', (t: TestContext) => {
    const state = new RequestStateSealer({ secret: 'one' }).seal(base)
    const opened = new RequestStateSealer({ secret: 'two' }).open(state, base)

    t.assert.strictEqual(opened.ok, false)
    t.assert.match(opened.ok === false ? opened.reason : '', /integrity/)
  })

  test('an expired state is refused', (t: TestContext) => {
    const sealer = new RequestStateSealer({ secret: 's', ttlMs: 1000 })
    const state = sealer.seal(base)

    const opened = sealer.open(state, { ...base, now: Date.now() + 5000 })
    t.assert.strictEqual(opened.ok, false)
    t.assert.match(opened.ok === false ? opened.reason : '', /expired/)
  })

  test('state is bound to the principal it was issued to', (t: TestContext) => {
    const sealer = new RequestStateSealer({ secret: 's' })
    const state = sealer.seal({ ...base, principal: 'alice' })

    t.assert.strictEqual(sealer.open(state, { ...base, principal: 'bob' }).ok, false)
    t.assert.strictEqual(sealer.open(state, { ...base, principal: 'alice' }).ok, true)
  })

  test('state is bound to the request that produced it', (t: TestContext) => {
    const sealer = new RequestStateSealer({ secret: 's' })
    const state = sealer.seal(base)

    const other = { method: 'tools/call', params: { name: 'greet', arguments: { a: 2 } } }
    t.assert.strictEqual(sealer.open(state, other).ok, false)
  })

  test('the digest ignores key order but not values', (t: TestContext) => {
    t.assert.strictEqual(
      digestRequest('tools/call', { a: 1, b: 2 }),
      digestRequest('tools/call', { b: 2, a: 1 })
    )
    t.assert.notStrictEqual(
      digestRequest('tools/call', { a: 1 }),
      digestRequest('tools/call', { a: 2 })
    )
  })

  test('the digest ignores the fields that legitimately differ on a retry', (t: TestContext) => {
    const first = { name: 'greet', _meta: { x: 1 } }
    const retry = { name: 'greet', _meta: { x: 2 }, inputResponses: { a: {} }, requestState: 'blob' }
    t.assert.strictEqual(digestRequest('tools/call', first), digestRequest('tools/call', retry))
  })
})

describe('subscription filters', () => {
  const capabilities = { tools: {}, resources: {}, prompts: {} }

  test('the acknowledged filter drops what the server cannot honour', (t: TestContext) => {
    const agreed = negotiateFilter(
      { toolsListChanged: true, promptsListChanged: true },
      { tools: {} }
    )
    t.assert.deepStrictEqual(agreed, { toolsListChanged: true })
  })

  test('duplicate resource subscriptions are collapsed', (t: TestContext) => {
    const agreed = negotiateFilter(
      { resourceSubscriptions: ['file:///a', 'file:///a', 'file:///b'] },
      capabilities
    )
    t.assert.deepStrictEqual(agreed.resourceSubscriptions, ['file:///a', 'file:///b'])
  })

  test('resource updates only match subscribed URIs', (t: TestContext) => {
    const filter = { resourceSubscriptions: ['file:///a'] }
    const updated = (uri: string) => ({
      jsonrpc: JSONRPC_VERSION,
      method: 'notifications/resources/updated',
      params: { uri }
    }) as any

    t.assert.strictEqual(matchesFilter(updated('file:///a'), filter), true)
    t.assert.strictEqual(matchesFilter(updated('file:///b'), filter), false)
  })

  test('request-scoped notifications never ride the listen stream', (t: TestContext) => {
    const progress = { jsonrpc: JSONRPC_VERSION, method: 'notifications/progress', params: {} } as any
    const message = { jsonrpc: JSONRPC_VERSION, method: 'notifications/message', params: {} } as any

    const everything = {
      toolsListChanged: true,
      promptsListChanged: true,
      resourcesListChanged: true,
      resourceSubscriptions: ['file:///a']
    }
    t.assert.strictEqual(matchesFilter(progress, everything), false)
    t.assert.strictEqual(matchesFilter(message, everything), false)
  })
})

describe('task input channel lifecycle', () => {
  test('cancellation rejects a parked waiter immediately', async (t: TestContext) => {
    const channel = new TaskInputChannel()
    const waiting = channel.wait('task-1')
    t.assert.strictEqual(channel.waiterCount, 1)

    channel.abort('task-1', 'task cancelled')
    await t.assert.rejects(waiting, /task cancelled/)
    t.assert.strictEqual(channel.waiterCount, 0)
    channel.close()
  })

  test('a retried broker delivery is deduplicated after resolving its waiter', async (t: TestContext) => {
    const channel = new TaskInputChannel()
    const waiting = channel.wait('task-1')
    channel.deliver('task-1', { confirmation: 'yes' }, 'delivery-1')
    t.assert.deepStrictEqual(await waiting, { confirmation: 'yes' })

    // An ambiguous publish error may make the durable outbox retry a message
    // that was already delivered. It must not be held for the next input round.
    channel.deliver('task-1', { confirmation: 'yes' }, 'delivery-1')
    t.assert.strictEqual(channel.pendingSize, 0)
    channel.close()
  })

  test('pending answers expire autonomously and remain capacity bounded', async (t: TestContext) => {
    const channel = new TaskInputChannel(20, 2)
    channel.deliver('task-1', { a: 1 })
    channel.deliver('task-2', { b: 2 })
    channel.deliver('task-3', { c: 3 })

    t.assert.strictEqual(channel.pendingSize, 2)
    await delay(60)
    t.assert.strictEqual(channel.pendingSize, 0)
    channel.close()
  })
})

describe('subscription backpressure', () => {
  class FakeResponse extends EventEmitter {
    writes: string[] = []
    ended = false
    writable = false

    setHeader (): void {}
    writeHead (): void {}

    write (frame: string): boolean {
      this.writes.push(frame)
      return this.writable
    }

    end (): void {
      this.ended = true
      this.emit('close')
    }
  }

  const logger = {
    debug: () => {},
    warn: () => {}
  } as any

  function replyFor (raw: FakeResponse): any {
    return { raw, hijack: () => {} }
  }

  const changed = {
    jsonrpc: JSONRPC_VERSION,
    method: 'notifications/tools/list_changed'
  } as any

  test('queued frames flush only after drain', (t: TestContext) => {
    const raw = new FakeResponse()
    const registry = new SubscriptionRegistry(logger, 10_000)
    registry.open(replyFor(raw), 1, { toolsListChanged: true })

    // The acknowledgement filled the writable buffer. The notification must be
    // queued rather than written again until the stream emits drain.
    registry.deliver(changed)
    t.assert.strictEqual(raw.writes.length, 1)

    raw.writable = true
    raw.emit('drain')
    t.assert.strictEqual(raw.writes.length, 2)
    registry.closeAll()
  })

  test('a slow subscription is closed when its bounded queue is exceeded', (t: TestContext) => {
    const raw = new FakeResponse()
    const registry = new SubscriptionRegistry(logger, 1)
    registry.open(replyFor(raw), 1, { toolsListChanged: true })

    registry.deliver(changed)
    t.assert.strictEqual(raw.ended, true)
    t.assert.strictEqual(registry.size, 0)
    t.assert.strictEqual(raw.writes.length, 1)
  })
})

describe('request metadata parsing', () => {
  function meta (overrides: Record<string, unknown> = {}) {
    return {
      _meta: {
        [META_PROTOCOL_VERSION]: '2026-07-28',
        [META_CLIENT_CAPABILITIES]: {},
        ...overrides
      }
    }
  }

  test('a well-formed request parses', (t: TestContext) => {
    const parsed = parseRequestContext(meta({ [META_CLIENT_INFO]: { name: 'c', version: '1' } }))
    t.assert.strictEqual(parsed.ok, true)
    t.assert.strictEqual(parsed.ok && parsed.context.protocolVersion, '2026-07-28')
    t.assert.strictEqual(parsed.ok && parsed.context.clientInfo?.name, 'c')
  })

  test('capabilities are required even when empty', (t: TestContext) => {
    const parsed = parseRequestContext({ _meta: { [META_PROTOCOL_VERSION]: '2026-07-28' } })
    t.assert.strictEqual(parsed.ok, false)
  })

  test('an unknown log level is rejected rather than ignored', (t: TestContext) => {
    const parsed = parseRequestContext(meta({ 'io.modelcontextprotocol/logLevel': 'chatty' }))
    t.assert.strictEqual(parsed.ok, false)
  })

  test('bodyClaimsModern keys off the protocol version, not the method', (t: TestContext) => {
    t.assert.strictEqual(bodyClaimsModern({ method: 'tools/list', params: meta() }), true)
    t.assert.strictEqual(bodyClaimsModern({ method: 'tools/list', params: {} }), false)
    t.assert.strictEqual(bodyClaimsModern({ method: 'initialize' }), false)
    t.assert.strictEqual(bodyClaimsModern(undefined), false)
  })

  test('a modern version header alone commits the request to the modern path', (t: TestContext) => {
    const modern = ['2026-07-28']
    const legacyBody = { method: 'tools/call', params: { name: 'x' } }

    // This is the bypass: modern headers a gateway may route on, with a body
    // that omits `_meta` to dodge header/body validation.
    t.assert.strictEqual(
      isModernRequest({ 'mcp-protocol-version': '2026-07-28' }, legacyBody, modern),
      true
    )
    t.assert.strictEqual(
      isModernRequest({ 'mcp-protocol-version': '2025-11-25' }, legacyBody, modern),
      false
    )
    t.assert.strictEqual(isModernRequest({}, legacyBody, modern), false)
    // An array-valued header must not slip past either.
    t.assert.strictEqual(
      isModernRequest({ 'mcp-protocol-version': ['2026-07-28'] }, legacyBody, modern),
      true
    )
  })
})

describe('revision era', () => {
  test('2026-07-28 and later are modern; earlier revisions are not', (t: TestContext) => {
    t.assert.strictEqual(isModernRevision('2026-07-28'), true)
    t.assert.strictEqual(isModernRevision('2027-01-01'), true)
    t.assert.strictEqual(isModernRevision('2025-11-25'), false)
    t.assert.strictEqual(isModernRevision(undefined), false)
  })
})
