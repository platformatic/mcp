import { describe, test } from 'node:test'
import type { TestContext } from 'node:test'
import Fastify from 'fastify'
import type { Redis } from 'ioredis'
import { Type } from '@sinclair/typebox'
import mcpPlugin from '../src/index.ts'
import { MemoryTaskStore } from '../src/stores/memory-task-store.ts'
import { JSONRPC_VERSION, LATEST_PROTOCOL_VERSION, INVALID_PARAMS } from '../src/schema.ts'
import type { CreateTaskResult, ListTasksResult, CallToolResult } from '../src/schema.ts'
import { createTestAuthConfig, createTestJWT, setupMockAgent, generateMockJWKSResponse } from './auth-test-utils.ts'
import { testWithRedis } from './redis-test-utils.ts'

const IDP_A = 'https://auth.example.com'
const IDP_B = 'https://other.example.com'

async function buildApp (t: TestContext, options: { redis?: Redis, auth?: boolean } = {}) {
  const restoreMock = setupMockAgent({
    'https://auth.example.com/.well-known/jwks.json': generateMockJWKSResponse()
  })

  const app = Fastify({ logger: false })
  t.after(async () => {
    await app.close()
    restoreMock()
  })

  const { redis } = options
  await app.register(mcpPlugin, {
    enableTasks: true,
    ...(options.auth === false ? {} : { authorization: createTestAuthConfig({ authorizationServers: [IDP_A, IDP_B] }) }),
    ...(redis ? { redis: { host: redis.options.host!, port: redis.options.port!, db: redis.options.db! } } : {})
  })
  app.mcpAddTool({
    name: 'slow',
    description: 'Finishes after a short delay',
    inputSchema: Type.Object({}),
    execution: { taskSupport: 'optional' }
  } as any, async (): Promise<CallToolResult> => {
    await new Promise(resolve => setTimeout(resolve, 200))
    return { content: [{ type: 'text', text: 'done' }] }
  })
  await app.ready()

  const call = async (token: string | undefined, method: string, params: unknown) => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        'mcp-protocol-version': LATEST_PROTOCOL_VERSION
      },
      payload: { jsonrpc: JSONRPC_VERSION, id: 1, method, params }
    })
    return res.json()
  }

  const createTask = async (token: string | undefined): Promise<string> => {
    const body = await call(token, 'tools/call', { name: 'slow', arguments: {}, task: {} })
    return (body.result as CreateTaskResult).task.taskId
  }

  return { app, call, createTask }
}

async function assertIssuerIsolation (t: TestContext, redis?: Redis) {
  const { call, createTask } = await buildApp(t, { redis })

  // Same `sub`, different issuers: two unrelated users
  const alice = createTestJWT({ sub: '12345', iss: IDP_A })
  const mallory = createTestJWT({ sub: '12345', iss: IDP_B })

  const taskId = await createTask(alice)

  const list = (await call(mallory, 'tasks/list', {})).result as ListTasksResult
  t.assert.deepStrictEqual(list.tasks, [])

  for (const method of ['tasks/get', 'tasks/result', 'tasks/cancel']) {
    const body = await call(mallory, method, { taskId })
    t.assert.strictEqual(body.error?.code, INVALID_PARAMS, `${method} must refuse another issuer's task`)
    t.assert.match(body.error.message, /Task not found/)
  }

  // The owner, with the same issuer and subject, still reaches it; a trailing
  // slash on the issuer is the same issuer after normalization.
  const owner = createTestJWT({ sub: '12345', iss: `${IDP_A}/` })
  const ownList = (await call(owner, 'tasks/list', {})).result as ListTasksResult
  t.assert.deepStrictEqual(ownList.tasks.map(x => x.taskId), [taskId])
  t.assert.strictEqual('authIssuer' in ownList.tasks[0], false)
  t.assert.strictEqual('authSubject' in ownList.tasks[0], false)

  const got = await call(alice, 'tasks/get', { taskId })
  t.assert.strictEqual(got.result.taskId, taskId)
  t.assert.strictEqual(got.result.status, 'working', 'mallory\'s cancel must not have taken effect')

  const result = await call(alice, 'tasks/result', { taskId })
  t.assert.strictEqual(result.result.content[0].text, 'done')

  const otherTask = await createTask(alice)
  const cancelled = await call(owner, 'tasks/cancel', { taskId: otherTask })
  t.assert.strictEqual(cancelled.result.status, 'cancelled')
}

describe('Task ownership is bound to issuer and subject', () => {
  test('memory: a same-sub token from another issuer cannot reach the task', async (t: TestContext) => {
    await assertIssuerIsolation(t)
  })

  testWithRedis('redis: a same-sub token from another issuer cannot reach the task', async (redis: Redis, t: TestContext) => {
    await assertIssuerIsolation(t, redis)
  })

  test('memory: a task recorded without an issuer is unreachable with auth on', async (t: TestContext) => {
    const { call, createTask } = await buildApp(t)
    const alice = createTestJWT({ sub: 'alice', iss: IDP_A })
    const taskId = await createTask(alice)

    // Simulate a record written before issuers were stored
    const originalGet = MemoryTaskStore.prototype.get
    t.mock.method(MemoryTaskStore.prototype, 'get', async function (this: MemoryTaskStore, id: string) {
      const task = await originalGet.call(this, id)
      if (task) delete task.authIssuer
      return task
    })

    for (const method of ['tasks/get', 'tasks/result', 'tasks/cancel']) {
      const body = await call(alice, method, { taskId })
      t.assert.strictEqual(body.error?.code, INVALID_PARAMS, `${method} must refuse a legacy task`)
    }
  })

  testWithRedis('redis: a task recorded without an issuer is unreachable with auth on', async (redis: Redis, t: TestContext) => {
    const { call, createTask } = await buildApp(t, { redis })
    const alice = createTestJWT({ sub: 'alice', iss: IDP_A })
    const taskId = await createTask(alice)

    // Rewrite the stored record as a pre-upgrade instance would have written it
    const key = `mcp:task:${taskId}`
    const stored = JSON.parse((await redis.get(key))!)
    t.assert.strictEqual(stored.authIssuer, IDP_A)
    delete stored.authIssuer
    await redis.set(key, JSON.stringify(stored), 'KEEPTTL')
    // ...and indexed under the old subject-only key
    await redis.zadd('mcp:tasks:owner:alice', Date.now(), taskId)

    for (const method of ['tasks/get', 'tasks/result', 'tasks/cancel']) {
      const body = await call(alice, method, { taskId })
      t.assert.strictEqual(body.error?.code, INVALID_PARAMS, `${method} must refuse a legacy task`)
    }
    const list = (await call(alice, 'tasks/list', {})).result as ListTasksResult
    t.assert.deepStrictEqual(list.tasks, [])
  })

  test('without authorization tasks stay reachable by id', async (t: TestContext) => {
    const { call, createTask } = await buildApp(t, { auth: false })
    const taskId = await createTask(undefined)

    const got = await call(undefined, 'tasks/get', { taskId })
    t.assert.strictEqual(got.result.taskId, taskId)
    const cancelled = await call(undefined, 'tasks/cancel', { taskId })
    t.assert.strictEqual(cancelled.result.status, 'cancelled')
  })
})
