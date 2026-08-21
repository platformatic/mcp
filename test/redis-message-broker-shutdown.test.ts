import { describe, it, mock } from 'node:test'
import assert from 'node:assert'
import { RedisMessageBroker, type RedisMessageBrokerOptions } from '../src/brokers/redis-message-broker.ts'

function createBroker (emitter: object, options: RedisMessageBrokerOptions = {}): RedisMessageBroker {
  return Object.assign(Object.create(RedisMessageBroker.prototype), {
    emitter,
    closeTimeoutMs: options.closeTimeoutMs ?? 2000,
    onCloseTimeout: options.onCloseTimeout,
    closePromise: null
  }) as RedisMessageBroker
}

describe('RedisMessageBroker shutdown', () => {
  it('resolves as soon as the emitter close callback fires', async () => {
    const close = mock.fn((cb: () => void) => cb())
    const broker = createBroker({ close })

    await broker.close()

    assert.strictEqual(close.mock.callCount(), 1)
  })

  it('falls back to a forced disconnect and finalizer when close hangs', async () => {
    const disconnectSub = mock.fn()
    const disconnectPub = mock.fn()
    const finalize = mock.fn((cb: () => void) => cb())
    const onCloseTimeout = mock.fn()
    const close = mock.fn(() => {}) // never invokes its callback

    const broker = createBroker({
      close,
      subConn: { disconnect: disconnectSub },
      pubConn: { disconnect: disconnectPub },
      _close: finalize
    }, { closeTimeoutMs: 20, onCloseTimeout })

    await broker.close()

    assert.strictEqual(disconnectSub.mock.callCount(), 1)
    assert.strictEqual(disconnectPub.mock.callCount(), 1)
    assert.strictEqual(finalize.mock.callCount(), 1)
    assert.strictEqual(onCloseTimeout.mock.callCount(), 1)
  })

  it('ignores a graceful close callback that fires after the timeout already resolved', async () => {
    let lateCb: (() => void) | undefined
    const close = mock.fn((cb: () => void) => { lateCb = cb })
    const finalize = mock.fn((cb: () => void) => cb())

    const broker = createBroker({ close, _close: finalize }, { closeTimeoutMs: 20 })

    await broker.close()
    assert.strictEqual(finalize.mock.callCount(), 1)

    // Should not throw, double-resolve, or re-run forced cleanup.
    assert.doesNotThrow(() => lateCb?.())
    assert.strictEqual(finalize.mock.callCount(), 1)
  })

  it('tolerates forced-cleanup steps throwing and still resolves', async () => {
    const disconnectSub = mock.fn(() => { throw new Error('sub connection already broken') })
    const disconnectPub = mock.fn()
    const finalize = mock.fn((cb: () => void) => cb())
    const onCloseTimeout = mock.fn(() => { throw new Error('logging hook failed') })
    const close = mock.fn(() => {}) // never invokes its callback

    const broker = createBroker({
      close,
      subConn: { disconnect: disconnectSub },
      pubConn: { disconnect: disconnectPub },
      _close: finalize
    }, { closeTimeoutMs: 20, onCloseTimeout })

    await assert.doesNotReject(broker.close())

    assert.strictEqual(disconnectSub.mock.callCount(), 1)
    assert.strictEqual(disconnectPub.mock.callCount(), 1)
    assert.strictEqual(finalize.mock.callCount(), 1)
  })

  it('resolves on timeout even without subConn/pubConn/_close available', async () => {
    const close = mock.fn(() => {}) // never invokes its callback

    const broker = createBroker({ close }, { closeTimeoutMs: 20 })

    await assert.doesNotReject(broker.close())
  })

  it('shares a single close across concurrent and repeated calls', async () => {
    let resolveClose: (() => void) | undefined
    const close = mock.fn((cb: () => void) => { resolveClose = cb })
    const broker = createBroker({ close })

    const first = broker.close()
    const second = broker.close()
    resolveClose?.()
    await Promise.all([first, second])

    // A call after the broker has already settled must not re-invoke close().
    await broker.close()

    assert.strictEqual(close.mock.callCount(), 1)
  })
})
