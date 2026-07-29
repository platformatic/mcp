import { describe, it, mock } from 'node:test'
import assert from 'node:assert'
import type { Redis } from 'ioredis'
import { quitWithTimeout } from '../src/redis-quit-with-timeout.ts'

function fakeClient (quit: () => Promise<unknown>): { client: Redis, disconnect: ReturnType<typeof mock.fn> } {
  const disconnect = mock.fn()
  const client = { quit, disconnect } as unknown as Redis
  return { client, disconnect }
}

describe('quitWithTimeout', () => {
  it('resolves without disconnecting when quit() succeeds', async () => {
    const { client, disconnect } = fakeClient(() => Promise.resolve('OK'))
    const onTimeout = mock.fn()

    await quitWithTimeout(client, 50, onTimeout)

    assert.strictEqual(disconnect.mock.callCount(), 0)
    assert.strictEqual(onTimeout.mock.callCount(), 0)
  })

  it('force-disconnects when quit() rejects before the timeout', async () => {
    const { client, disconnect } = fakeClient(() => Promise.reject(new Error('Connection is closed.')))
    const onTimeout = mock.fn()

    await quitWithTimeout(client, 200, onTimeout)

    assert.strictEqual(disconnect.mock.callCount(), 1)
    assert.strictEqual(onTimeout.mock.callCount(), 0)
  })

  it('falls back to a forced disconnect and onTimeout when quit() never settles', async () => {
    const { client, disconnect } = fakeClient(() => new Promise(() => {}))
    const onTimeout = mock.fn()

    await quitWithTimeout(client, 20, onTimeout)

    assert.strictEqual(disconnect.mock.callCount(), 1)
    assert.strictEqual(onTimeout.mock.callCount(), 1)
  })

  it('resolves on timeout even when onTimeout and disconnect both throw', async () => {
    const disconnect = mock.fn(() => { throw new Error('connection already broken') })
    const client = { quit: () => new Promise(() => {}), disconnect } as unknown as Redis
    const onTimeout = mock.fn(() => { throw new Error('logging hook failed') })

    await assert.doesNotReject(quitWithTimeout(client, 20, onTimeout))

    assert.strictEqual(onTimeout.mock.callCount(), 1)
    assert.strictEqual(disconnect.mock.callCount(), 1)
  })

  it('resolves when quit() rejects and the forced disconnect throws', async () => {
    const disconnect = mock.fn(() => { throw new Error('connection already broken') })
    const client = { quit: () => Promise.reject(new Error('Connection is closed.')), disconnect } as unknown as Redis
    const onTimeout = mock.fn()

    await assert.doesNotReject(quitWithTimeout(client, 200, onTimeout))

    assert.strictEqual(disconnect.mock.callCount(), 1)
    assert.strictEqual(onTimeout.mock.callCount(), 0)
  })

  it('ignores a late quit() rejection that arrives after the timeout already resolved', async () => {
    let rejectQuit: ((err: Error) => void) | undefined
    const { client, disconnect } = fakeClient(() => new Promise((_resolve, reject) => { rejectQuit = reject }))
    const onTimeout = mock.fn()

    await quitWithTimeout(client, 20, onTimeout)
    assert.strictEqual(disconnect.mock.callCount(), 1)

    assert.doesNotThrow(() => rejectQuit?.(new Error('Connection is closed.')))
    assert.strictEqual(disconnect.mock.callCount(), 1)
  })
})
