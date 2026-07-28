import type { Redis } from 'ioredis'

// Mirrors RedisMessageBroker's own bounded close: races a graceful quit()
// against a timer, falling back to a forced disconnect so a Redis outage
// can't block onClose. Never rejects, and the timer stays refed since it's
// the only thing driving resolution once quit() hangs. Also force-disconnects
// on a rejected quit() (e.g. the connection dropped mid-command), since
// ioredis can otherwise be left reconnecting with an active socket/timer.
export async function quitWithTimeout (client: Redis, timeoutMs: number, onTimeout: () => void): Promise<void> {
  await new Promise<void>((resolve) => {
    let timedOut = false

    // Both fallback paths are best-effort: a throwing onTimeout() or
    // disconnect() must neither crash the process (this runs in a timer
    // callback) nor leave this promise pending, so each step is isolated
    // and resolution is guaranteed by the finally.
    const forceDisconnect = (notifyTimeout: boolean): void => {
      try {
        if (notifyTimeout) {
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
        resolve()
      }
    }

    const timer = setTimeout(() => {
      timedOut = true
      forceDisconnect(true)
    }, timeoutMs)

    client.quit().then(() => {
      if (timedOut) return
      clearTimeout(timer)
      resolve()
    }).catch(() => {
      if (timedOut) return
      clearTimeout(timer)
      forceDisconnect(false)
    })
  })
}
