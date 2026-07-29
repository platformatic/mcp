import type { Redis } from 'ioredis'

// Mirrors RedisMessageBroker's own bounded close: races a graceful quit()
// against a timer, falling back to a forced disconnect so a Redis outage
// can't block onClose. Never rejects: quit()'s rejection is mapped to an
// outcome before the race (a rejected loser would otherwise reject the race
// later), and it also force-disconnects on that path (e.g. the connection
// dropped mid-command), since ioredis can otherwise be left reconnecting
// with an active socket/timer. The timer is cleared in finally so a fast
// quit() doesn't keep the event loop alive for the full timeout.
export async function quitWithTimeout (client: Redis, timeoutMs: number, onTimeout: () => void): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
  })

  try {
    const outcome = await Promise.race([
      client.quit().then(() => 'ok' as const, () => 'error' as const),
      timeout
    ])
    if (outcome === 'ok') {
      return
    }
    if (outcome === 'timeout') {
      try {
        onTimeout()
      } catch {
        // caller-supplied hook must not break shutdown
      }
    }
    try {
      client.disconnect()
    } catch {
      // connection may already be in a broken state
    }
  } finally {
    clearTimeout(timer)
  }
}
