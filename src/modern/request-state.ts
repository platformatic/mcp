/**
 * `requestState` sealing for multi round-trip requests.
 *
 * Under MRTR the server keeps no state between the interim result and the
 * client's retry — the state travels through the client instead. That makes it
 * attacker-controlled input, so the spec requires integrity protection and
 * replay bounds whenever the state influences authorization or business logic.
 *
 * We seal with HMAC-SHA256 over the payload and bind three things into it:
 * the authenticated principal, an expiry, and a digest of the originating
 * request. State presented by a different principal, after it lapses, or on a
 * different request is refused.
 */

import { createHmac, randomBytes, timingSafeEqual, createHash } from 'node:crypto'

export interface RequestStateClaims {
  /** Authenticated subject the state was issued to, if any. */
  principal?: string
  /** Method the state was issued for, e.g. `tools/call`. */
  method: string
  /** Digest of the salient request parameters. */
  requestDigest: string
  /** Epoch milliseconds after which the state is refused. */
  expiresAt: number
  /** Whatever the server needs to resume, opaque to us. */
  payload: unknown
  /**
   * The `inputRequests` keys the server asked for. Only those are handed to
   * the handler on the retry; anything else the client sends is ignored.
   */
  inputKeys?: string[]
}

export type VerifyResult =
  | { ok: true, claims: RequestStateClaims }
  | { ok: false, reason: string }

const DEFAULT_TTL_MS = 5 * 60 * 1000

/** HMAC-SHA256 keys shorter than its output weaken it. */
export const MIN_SECRET_BYTES = 32

/**
 * Prefixed to everything signed, so a signature over request state can never
 * be confused with one the same secret makes over anything else.
 */
const SIGNATURE_DOMAIN = '@platformatic/mcp:requestState:v1\0'

/**
 * Digest the parameters that identify a request, so state minted for one call
 * cannot be replayed onto another. `inputResponses` and `requestState` are
 * excluded because they legitimately differ between the original and the retry.
 */
export function digestRequest (method: string, params: unknown): string {
  const record = { ...(params as Record<string, unknown> | undefined) }
  delete record._meta
  delete record.inputResponses
  delete record.requestState

  return createHash('sha256')
    .update(method)
    .update('\0')
    .update(stableStringify(record))
    .digest('base64url')
}

/** Deterministic JSON so key order cannot change the digest. */
function stableStringify (value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
  return `{${entries.join(',')}}`
}

/**
 * Seals and opens `requestState` blobs.
 *
 * A caller that does not supply a secret gets a process-random one, which is
 * correct for a single instance but means state minted by one replica will not
 * verify on another. Deployments that load-balance MRTR retries across
 * instances must configure a shared secret.
 */
export class RequestStateSealer {
  #secret: Buffer
  #ttlMs: number

  #requirePrincipal: boolean

  constructor (options: { secret?: string | Buffer, ttlMs?: number, requirePrincipal?: boolean } = {}) {
    if (options.secret === undefined) {
      this.#secret = randomBytes(MIN_SECRET_BYTES)
    } else {
      // A configured but empty secret (say, an unset environment variable
      // expanded to '') must not silently fall back to a per-process key:
      // retries would then fail on every other instance.
      const secret = Buffer.isBuffer(options.secret) ? options.secret : Buffer.from(options.secret, 'utf8')
      if (secret.length < MIN_SECRET_BYTES) {
        throw new Error(`requestStateSecret must be at least ${MIN_SECRET_BYTES} bytes`)
      }
      this.#secret = secret
    }
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.#requirePrincipal = options.requirePrincipal ?? false
  }

  /** Mint a sealed state string to hand back in an `InputRequiredResult`. */
  seal (input: {
    principal?: string
    method: string
    params: unknown
    payload?: unknown
    inputKeys?: string[]
    ttlMs?: number
  }): string {
    if (this.#requirePrincipal && input.principal === undefined) {
      // Binding to "nobody" would let any other unidentified caller replay the
      // state. When the deployment can identify callers, refusing is the only
      // safe answer; this mirrors how tasks refuse a subject-less token.
      throw new Error('Cannot seal request state without an authenticated principal')
    }

    const claims: RequestStateClaims = {
      principal: input.principal,
      method: input.method,
      requestDigest: digestRequest(input.method, input.params),
      expiresAt: Date.now() + (input.ttlMs ?? this.#ttlMs),
      payload: input.payload ?? null,
      ...(input.inputKeys ? { inputKeys: input.inputKeys } : {})
    }

    const body = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')
    return `${body}.${this.#sign(body)}`
  }

  /**
   * Open a state string presented on a retry, refusing anything that fails
   * integrity, has lapsed, belongs to another principal, or was minted for a
   * different request.
   */
  open (state: string, expected: {
    principal?: string
    method: string
    params: unknown
    now?: number
  }): VerifyResult {
    const separator = state.lastIndexOf('.')
    if (separator <= 0) {
      return { ok: false, reason: 'malformed request state' }
    }

    const body = state.slice(0, separator)
    const signature = state.slice(separator + 1)

    if (!this.#verify(body, signature)) {
      return { ok: false, reason: 'request state failed integrity check' }
    }

    let claims: RequestStateClaims
    try {
      claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    } catch {
      return { ok: false, reason: 'malformed request state' }
    }

    const now = expected.now ?? Date.now()
    if (typeof claims.expiresAt !== 'number' || now > claims.expiresAt) {
      return { ok: false, reason: 'request state has expired' }
    }

    if (this.#requirePrincipal && expected.principal === undefined) {
      return { ok: false, reason: 'request state requires an authenticated principal' }
    }

    if (claims.principal !== expected.principal) {
      return { ok: false, reason: 'request state was issued to a different principal' }
    }

    if (claims.method !== expected.method) {
      return { ok: false, reason: 'request state was issued for a different method' }
    }

    const digest = digestRequest(expected.method, expected.params)
    if (claims.requestDigest !== digest) {
      return { ok: false, reason: 'request state was issued for a different request' }
    }

    return { ok: true, claims }
  }

  #sign (body: string): string {
    return createHmac('sha256', this.#secret).update(SIGNATURE_DOMAIN).update(body).digest('base64url')
  }

  #verify (body: string, signature: string): boolean {
    const expected = Buffer.from(this.#sign(body), 'utf8')
    const actual = Buffer.from(signature, 'utf8')
    if (expected.length !== actual.length) return false
    return timingSafeEqual(expected, actual)
  }
}
