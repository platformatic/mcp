import { test, describe } from 'node:test'
import type { TestContext } from 'node:test'
import Fastify from 'fastify'
import mcpPlugin from '../src/index.ts'
import type { MCPPluginOptions } from '../src/types.ts'

async function assertRegistrationRejects (t: TestContext, opts: Partial<MCPPluginOptions>, pattern: RegExp): Promise<void> {
  const app = Fastify()
  try {
    await t.assert.rejects(
      async () => { await app.register(mcpPlugin, { enableTasks: true, ...opts } as MCPPluginOptions) },
      (err: Error) => {
        t.assert.ok(err instanceof TypeError, `expected a TypeError, got ${err}`)
        t.assert.match(err.message, pattern)
        return true
      }
    )
  } finally {
    await app.close()
  }
}

async function assertRegistrationAccepts (t: TestContext, opts: Partial<MCPPluginOptions>): Promise<void> {
  const app = Fastify()
  try {
    await app.register(mcpPlugin, { enableTasks: true, ...opts } as MCPPluginOptions)
    await app.ready()
  } finally {
    await app.close()
  }
  t.assert.ok(true)
}

// Values that would otherwise surface only at runtime: a lease that lapses at
// once, a ttl that is NaN or negative, or a string read from an env variable
const invalidValues: unknown[] = [0, -5, NaN, Infinity, -Infinity, 1.5, '30000', null, Number.MAX_SAFE_INTEGER + 1]

describe('task options validation (#302)', () => {
  for (const option of ['taskLeaseMs', 'taskDefaultTtlMs', 'taskMaxTtlMs'] as const) {
    test(`registration throws a TypeError naming ${option} for invalid values`, async (t: TestContext) => {
      for (const value of invalidValues) {
        await assertRegistrationRejects(t, { [option]: value as any }, new RegExp(`^${option} must be a positive integer`))
      }
    })

    test(`registration throws for an invalid ${option} even when tasks are disabled`, async (t: TestContext) => {
      await assertRegistrationRejects(t, { enableTasks: false, [option]: 0 }, new RegExp(`^${option} must be`))
    })

    test(`registration accepts a positive integer or undefined ${option}`, async (t: TestContext) => {
      await assertRegistrationAccepts(t, { [option]: undefined })
      await assertRegistrationAccepts(t, { [option]: 1000 })
    })
  }

  test('registration throws for an invalid taskMaxRetainedPerPrincipal', async (t: TestContext) => {
    for (const value of [0, -1, NaN, 1.5, '20', null]) {
      await assertRegistrationRejects(t, { taskMaxRetainedPerPrincipal: value as any }, /^taskMaxRetainedPerPrincipal must be a positive integer/)
    }
    await assertRegistrationAccepts(t, { taskMaxRetainedPerPrincipal: undefined })
    await assertRegistrationAccepts(t, { taskMaxRetainedPerPrincipal: 20 })
  })

  test('registration throws when taskDefaultTtlMs exceeds taskMaxTtlMs', async (t: TestContext) => {
    await assertRegistrationRejects(t, { taskDefaultTtlMs: 120_000, taskMaxTtlMs: 60_000 }, /taskDefaultTtlMs \(120000\) must not exceed taskMaxTtlMs \(60000\)/)
  })

  test('registration throws when taskDefaultTtlMs exceeds the default taskMaxTtlMs', async (t: TestContext) => {
    await assertRegistrationRejects(t, { taskDefaultTtlMs: 2 * 3600_000 }, /taskDefaultTtlMs \(7200000\) must not exceed taskMaxTtlMs \(3600000\)/)
  })

  test('registration accepts taskDefaultTtlMs equal to taskMaxTtlMs', async (t: TestContext) => {
    await assertRegistrationAccepts(t, { taskDefaultTtlMs: 60_000, taskMaxTtlMs: 60_000 })
    await assertRegistrationAccepts(t, { taskDefaultTtlMs: 15 * 60_000, taskMaxTtlMs: 60 * 60_000 })
  })

  test('registration accepts a taskMaxTtlMs below the default taskDefaultTtlMs', async (t: TestContext) => {
    // An unset taskDefaultTtlMs is capped by the ceiling, as before
    await assertRegistrationAccepts(t, { taskMaxTtlMs: 30_000 })
  })

  test('registration fails before connecting to Redis', async (t: TestContext) => {
    // An unreachable port: had the plugin connected first, registration would hang or leak
    await assertRegistrationRejects(t, { redis: { host: '127.0.0.1', port: 1, lazyConnect: true }, taskLeaseMs: 0 } as any, /^taskLeaseMs must be/)
  })
})
