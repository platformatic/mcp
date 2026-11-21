/**
 * Which sessions hold a resource subscription on this instance, per URI.
 *
 * A session is recorded here when this instance ran the subscribe handler for
 * it, since that is where any watcher the handler started lives. When sessions
 * stop holding a URI without an explicit `resources/unsubscribe` (DELETE,
 * expiry), the unsubscribe handler must run, but only once no other session
 * on this instance still holds that URI.
 */
export class ResourceSubscriptionHolders {
  private readonly byUri = new Map<string, Set<string>>()
  private readonly bySession = new Map<string, Set<string>>()

  add (sessionId: string, uri: string): void {
    let sessions = this.byUri.get(uri)
    if (!sessions) {
      sessions = new Set()
      this.byUri.set(uri, sessions)
    }
    sessions.add(sessionId)

    let uris = this.bySession.get(sessionId)
    if (!uris) {
      uris = new Set()
      this.bySession.set(sessionId, uris)
    }
    uris.add(uri)
  }

  /**
   * Drop a session's hold on some URIs (all of them when `uris` is omitted).
   * Returns the URIs that no session holds any more, for which the unsubscribe
   * handler should run. A URI the session did not hold is ignored.
   */
  release (sessionId: string, uris?: Iterable<string>): string[] {
    const held = this.bySession.get(sessionId)
    if (!held) return []

    const released: string[] = []
    for (const uri of [...(uris ?? held)]) {
      if (!held.delete(uri)) continue
      const sessions = this.byUri.get(uri)
      sessions?.delete(sessionId)
      if (!sessions || sessions.size === 0) {
        this.byUri.delete(uri)
        released.push(uri)
      }
    }
    if (held.size === 0) {
      this.bySession.delete(sessionId)
    }
    return released
  }

  /** Snapshot of every session holding a URI here, with the URIs it holds */
  entries (): Array<[string, string[]]> {
    return [...this.bySession].map(([sessionId, uris]) => [sessionId, [...uris]])
  }
}
