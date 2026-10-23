import { createPublicKey } from 'node:crypto'

const DEFAULT_TTL_MS = 10 * 60 * 1000
/**
 * The key id comes from a token whose signature is not checked yet, so a key
 * the set does not hold must not cost a fetch each time it is named: the set
 * is fetched again for one at most this often.
 */
const DEFAULT_MIN_REFRESH_MS = 10_000
const FETCH_TIMEOUT_MS = 5_000

interface Jwk {
  kid?: unknown
  alg?: unknown
  [member: string]: unknown
}

export interface JwksCacheOptions {
  /** How long a fetched key set is used before it is fetched again. */
  ttlMs?: number
  /** The least time between two fetches made for keys the set lacked. */
  minRefreshMs?: number
}

/**
 * The signing keys an authorization server publishes, fetched as a whole set.
 * Knowing the whole set is what tells a key that does not exist (refused
 * without a fetch until `minRefreshMs` has passed) from one just rotated in
 * (fetched the next time a refresh is allowed, whoever asks for it).
 */
export class JwksCache {
  private readonly url: string
  private readonly ttlMs: number
  private readonly minRefreshMs: number
  private keys: Jwk[] = []
  private readonly pems = new Map<Jwk, string>()
  private fetchedAt = -Infinity
  private refreshing: Promise<void> | undefined

  constructor (url: string, options: JwksCacheOptions = {}) {
    this.url = url
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.minRefreshMs = options.minRefreshMs ?? DEFAULT_MIN_REFRESH_MS
  }

  /** The PEM public key for `kid` and `alg`, or an error when the set has none. */
  async getPublicKey (kid: string | undefined, alg: string | undefined): Promise<string> {
    if (Date.now() - this.fetchedAt >= this.ttlMs) {
      await this.refreshKeepingOld()
    }
    let jwk = this.find(kid, alg)
    // A key the set lacks may be on its way: a fetch already under way (a
    // cold start, a rotation) is waited for, and a new one is made when the
    // last was long enough ago, or when no fetch has succeeded yet. A key the
    // set holds never waits on a fetch, however slow the server is.
    if (!jwk && this.refreshing) {
      await this.refreshKeepingOld()
      jwk = this.find(kid, alg)
    }
    if (!jwk && (this.keys.length === 0 || Date.now() - this.fetchedAt >= this.minRefreshMs)) {
      await this.refreshKeepingOld()
      jwk = this.find(kid, alg)
    }
    if (!jwk) throw new Error('No matching signing key')
    let pem = this.pems.get(jwk)
    if (pem === undefined) {
      pem = createPublicKey({ key: jwk as any, format: 'jwk' }).export({ type: 'spki', format: 'pem' }).toString()
      this.pems.set(jwk, pem)
    }
    return pem
  }

  private find (kid: string | undefined, alg: string | undefined): Jwk | undefined {
    return this.keys.find(key => key.kid === kid && (alg === undefined || key.alg === undefined || key.alg === alg))
  }

  /** Fetch the set, sharing one fetch between concurrent callers; a failed fetch keeps the last good set. */
  private async refreshKeepingOld (): Promise<void> {
    this.refreshing ??= this.fetchKeys().finally(() => { this.refreshing = undefined })
    try {
      await this.refreshing
    } catch (error) {
      if (this.keys.length === 0) throw error
    }
  }

  private async fetchKeys (): Promise<void> {
    // Counted from the attempt, so a failing server is not asked again at once.
    this.fetchedAt = Date.now()
    const response = await fetch(this.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!response.ok) throw new Error(`JWKS request failed with status ${response.status}`)
    const body = await response.json() as { keys?: unknown }
    if (!Array.isArray(body?.keys) || body.keys.length === 0) throw new Error('JWKS response has no keys')
    this.keys = body.keys.filter((key): key is Jwk => typeof key === 'object' && key !== null && !Array.isArray(key))
    this.pems.clear()
  }
}
