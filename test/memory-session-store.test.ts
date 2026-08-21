import { test, describe } from 'node:test'
import type { TestContext } from 'node:test'
import { MemorySessionStore } from '../src/stores/memory-session-store.ts'
import type { SessionMetadata } from '../src/stores/session-store.ts'

function newSession (id: string): SessionMetadata {
  return { id, eventId: 0, createdAt: new Date(), lastActivity: new Date() }
}

/**
 * Reproduce what routes/mcp.ts sendSSEToStreams does for each event: read the
 * session (a copy), bump the counter on the copy, then persist via addMessage.
 * Before the fix the counter was never stored, so every event got id "1".
 */
async function emit (store: MemorySessionStore, sessionId: string, i: number): Promise<string> {
  const session = await store.get(sessionId)
  const eventId = (++session!.eventId).toString()
  await store.addMessage(sessionId, eventId, { jsonrpc: '2.0', method: 'notifications/test', params: { i } })
  return eventId
}

describe('MemorySessionStore event id counter', () => {
  test('the numeric counter advances so SSE event ids are distinct and ascending', async (t: TestContext) => {
    const store = new MemorySessionStore(100)
    await store.create(newSession('s1'))

    const ids = [await emit(store, 's1', 1), await emit(store, 's1', 2), await emit(store, 's1', 3)]

    t.assert.deepStrictEqual(ids, ['1', '2', '3'], 'each event must get a fresh ascending id, not repeat "1"')
    t.assert.strictEqual((await store.get('s1'))!.eventId, 3, 'the stored counter must reflect the last emitted event')
  })

  test('getMessagesFrom replays exactly the events after the given id', async (t: TestContext) => {
    const store = new MemorySessionStore(100)
    await store.create(newSession('s1'))

    await emit(store, 's1', 1)
    await emit(store, 's1', 2)
    await emit(store, 's1', 3)

    // Resuming after event "1" must replay 2 and 3 — impossible when every id is "1"
    const replayed = await store.getMessagesFrom('s1', '1')
    t.assert.deepStrictEqual(replayed.map(r => r.eventId), ['2', '3'])

    const fromTwo = await store.getMessagesFrom('s1', '2')
    t.assert.deepStrictEqual(fromTwo.map(r => r.eventId), ['3'])
  })

  test('a fresh session starts the counter at zero, first event is "1"', async (t: TestContext) => {
    const store = new MemorySessionStore(100)
    await store.create(newSession('s1'))

    t.assert.strictEqual((await store.get('s1'))!.eventId, 0)
    t.assert.strictEqual(await emit(store, 's1', 1), '1')
  })
})
