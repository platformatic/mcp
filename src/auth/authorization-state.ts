import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import type { PKCEChallenge } from './oauth-client.ts'

/** What /oauth/authorize remembers until its callback arrives. */
export interface AuthSession {
  state: string
  pkce: PKCEChallenge
  resourceUri?: string
  callbackUrl?: string // The redirect_uri used in authorization request (required for OIDC token exchange)
}

export const AUTHORIZATION_STATE_TTL_MS = 10 * 60 * 1000

const KEY_INFO = 'platformatic-mcp oauth authorization state'
const IV_BYTES = 12
const TAG_BYTES = 16

/**
 * Seals a pending authorization into the browser cookie that carries it to
 * the callback, so nothing is stored on the server: there is no store for
 * anonymous callers to fill, and any instance holding the secret can finish
 * the flow. AES-256-GCM keeps the PKCE verifier unreadable and the cookie
 * unforgeable; the state is the associated data, so a cookie only opens for
 * the state it was sealed for.
 */
export class AuthorizationStateSealer {
  /** The first seals; any of them opens, so a secret can be rotated. */
  readonly #keys: Buffer[]

  constructor (secret?: string | Buffer | ReadonlyArray<string | Buffer>) {
    const secrets = secret === undefined
      ? [randomBytes(32)]
      : (Array.isArray(secret) ? secret : [secret as string | Buffer])
    this.#keys = secrets.map(entry => Buffer.from(hkdfSync('sha256', entry, Buffer.alloc(0), KEY_INFO, 32)))
  }

  seal (session: AuthSession, ttlMs: number): string {
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv('aes-256-gcm', this.#keys[0], iv)
    cipher.setAAD(Buffer.from(session.state, 'utf8'))
    const body = JSON.stringify({ session, expiresAt: Date.now() + ttlMs })
    const sealed = Buffer.concat([cipher.update(body, 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString('base64url')
  }

  /** The session sealed for `state`, or undefined when forged, foreign or expired. */
  open (value: string, state: string): AuthSession | undefined {
    const raw = Buffer.from(value, 'base64url')
    if (raw.length <= IV_BYTES + TAG_BYTES) return undefined
    const iv = raw.subarray(0, IV_BYTES)
    const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
    const sealed = raw.subarray(IV_BYTES + TAG_BYTES)
    for (const key of this.#keys) {
      let body: string
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, iv)
        decipher.setAAD(Buffer.from(state, 'utf8'))
        decipher.setAuthTag(tag)
        body = Buffer.concat([decipher.update(sealed), decipher.final()]).toString('utf8')
      } catch {
        continue
      }
      const { session, expiresAt } = JSON.parse(body) as { session: AuthSession, expiresAt: number }
      if (expiresAt <= Date.now() || session.state !== state) return undefined
      return session
    }
    return undefined
  }
}
