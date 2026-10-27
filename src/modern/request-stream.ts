/**
 * Request-scoped notifications for the 2026-07-28 revision.
 *
 * `notifications/progress` and `notifications/message` travel on the response
 * stream of the request they relate to. Once that stream is open the HTTP
 * status is committed to 200, yet some errors must be sent with a 4xx status.
 * So notifications are held back until the outcome is known, or until the
 * handler has been running long enough that holding them would defeat their
 * purpose — and only once no such error can follow. A request that never
 * reports anything gets a plain JSON response.
 */

import type { FastifyReply } from 'fastify'
import type { JSONRPCMessage, LoggingLevel } from '../schema.ts'
import { JSONRPC_VERSION } from '../schema.ts'
import { LOG_LEVELS } from './request-meta.ts'
import type { RequestContext } from './request-meta.ts'

/** How long a handler may run before held notifications start streaming. */
const STREAM_OPEN_DELAY_MS = 200
/** Notifications are dropped rather than buffered without bound for a client that stops reading. */
const MAX_BUFFERED_BYTES = 1024 * 1024

export interface RequestNotifiers {
  sendProgress: (progress: number, total?: number, message?: string) => void
  log: (level: LoggingLevel, data: unknown, logger?: string) => void
}

/** For handlers whose request has already been answered, such as tasks. */
export const NO_NOTIFIERS: RequestNotifiers = { sendProgress: () => {}, log: () => {} }

export class RequestStream {
  #reply: FastifyReply
  #openEarly: boolean
  #opened = false
  #finished = false
  #held: string[] = []
  #heldBytes = 0
  #timer?: NodeJS.Timeout
  /** The stream reported back-pressure and has not drained since. */
  #blocked = false

  /**
   * `openEarly` says whether the stream may open before the outcome is known.
   * It must be false while the request could still end in an error that
   * needs a 4xx status: notifications are then held until the end.
   */
  constructor (reply: FastifyReply, options: { openEarly?: boolean } = {}) {
    this.#reply = reply
    this.#openEarly = options.openEarly ?? true
  }

  /** Whether the response is committed to a 200 stream. */
  get opened (): boolean {
    return this.#opened
  }

  /** Send a notification before the response. Nothing is sent after it. */
  notify (message: JSONRPCMessage): void {
    if (this.#finished) return
    const frame = `data: ${JSON.stringify(message)}\n\n`
    if (this.#opened) {
      this.#write(frame)
      return
    }
    // Held notifications are bounded like a slow reader's: past the limit
    // they are dropped, which progress and log messages tolerate.
    const bytes = Buffer.byteLength(frame)
    if (this.#heldBytes + bytes > MAX_BUFFERED_BYTES) return
    this.#held.push(frame)
    this.#heldBytes += bytes
    if (!this.#openEarly) return
    this.#timer ??= setTimeout(() => {
      if (!this.#finished) this.#open()
    }, STREAM_OPEN_DELAY_MS).unref()
  }

  /**
   * Conclude the request. Returns true when the response went out on the
   * stream; false when the caller should send it as plain JSON, which happens
   * when nothing was reported or the response needs a status other than 200
   * (`needsOwnStatus`) and has not already been committed to a 200 stream.
   * An error that goes out with 200 anyway still carries the notifications
   * held before it, such as a log message explaining the failure.
   */
  finish (response: JSONRPCMessage, serialized: string = JSON.stringify(response), needsOwnStatus = 'error' in (response as object)): boolean {
    this.#finished = true
    if (this.#timer) clearTimeout(this.#timer)

    if (!this.#opened) {
      if (this.#held.length === 0 || needsOwnStatus) {
        this.#held = []
        this.#heldBytes = 0
        return false
      }
      this.#open()
    }

    const raw = this.#reply.raw
    if (!raw.destroyed && !raw.writableEnded) raw.end(`data: ${serialized}\n\n`)
    return true
  }

  #open (): void {
    const raw = this.#reply.raw
    if (raw.destroyed || raw.writableEnded) return
    this.#opened = true
    // Headers set on the reply (CORS and the like) would otherwise be lost
    // once the reply is taken over.
    const headers = this.#reply.getHeaders()
    this.#reply.hijack()
    for (const [name, value] of Object.entries(headers)) {
      if (value !== undefined) raw.setHeader(name, value as string | number | readonly string[])
    }
    raw.setHeader('Content-Type', 'text/event-stream')
    raw.setHeader('Cache-Control', 'no-cache')
    raw.setHeader('X-Accel-Buffering', 'no')
    raw.writeHead(200)
    for (const frame of this.#held) this.#write(frame)
    this.#held = []
    this.#heldBytes = 0
  }

  /**
   * Write a notification, dropping it while the reader is not keeping up:
   * progress and log messages tolerate gaps, unbounded buffering does not.
   * Back-pressure is read from `write()` itself, since `writableLength` stays
   * at zero on an injected (stdio) response that is buffering all the same.
   */
  #write (frame: string): void {
    const raw = this.#reply.raw
    if (raw.destroyed || raw.writableEnded) return
    if (this.#blocked || raw.writableLength > MAX_BUFFERED_BYTES) return
    if (!raw.write(frame)) {
      this.#blocked = true
      raw.once('drain', () => { this.#blocked = false })
    }
  }
}

/**
 * Does an `Accept` header list `mediaType` as acceptable? Only an explicit
 * listing counts, as the transport requires the client to name it; one
 * listed with `q=0` is explicitly not acceptable.
 */
export function acceptsMediaType (accept: string | undefined, mediaType: string): boolean {
  if (!accept) return false
  return accept.split(',').some(range => {
    const [type, ...parameters] = range.split(';').map(part => part.trim().toLowerCase())
    if (type !== mediaType) return false
    const q = parameters.find(parameter => parameter.startsWith('q='))
    return q === undefined || Number(q.slice(2)) > 0
  })
}

/** Make log data serializable: errors, bigints and cycles would otherwise throw or vanish. */
function toJsonSafe (data: unknown): unknown {
  // The objects on the path to the value being serialized: only one of them
  // seen again is a cycle; an object shared between siblings is not.
  const ancestors: object[] = []
  try {
    return JSON.parse(JSON.stringify(data, function (this: object, _key, value: unknown) {
      while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop()
      if (typeof value === 'bigint') return value.toString()
      if (value instanceof Error) value = { name: value.name, message: value.message }
      if (typeof value === 'object' && value !== null) {
        if (ancestors.includes(value)) return '[Circular]'
        ancestors.push(value)
      }
      return value
    }) ?? 'null')
  } catch {
    return String(data)
  }
}

/**
 * The handler-facing notifiers for one request. Both are no-ops unless the
 * client asked for them: a `progressToken`, or a `logLevel` (the server must
 * not emit log messages for a request that did not set one), and a stream to
 * carry them. Progress must increase, and once the response is sent nothing
 * more may be reported.
 */
export function requestNotifiers (context: RequestContext, stream: RequestStream | undefined): RequestNotifiers {
  let lastProgress = -Infinity
  const minimum = context.logLevel === undefined ? -1 : LOG_LEVELS.indexOf(context.logLevel)

  return {
    sendProgress (progress, total, message) {
      if (!stream || context.progressToken === undefined) return
      if (!Number.isFinite(progress) || !(progress > lastProgress)) return
      if (total !== undefined && !Number.isFinite(total)) total = undefined
      lastProgress = progress
      stream.notify({
        jsonrpc: JSONRPC_VERSION,
        method: 'notifications/progress',
        params: {
          progressToken: context.progressToken,
          progress,
          ...(total !== undefined ? { total } : {}),
          ...(message !== undefined ? { message: String(message) } : {})
        }
      } as JSONRPCMessage)
    },
    log (level, data, logger) {
      if (!stream || minimum === -1) return
      if (LOG_LEVELS.indexOf(level) < minimum) return
      stream.notify({
        jsonrpc: JSONRPC_VERSION,
        method: 'notifications/message',
        params: { level, data: toJsonSafe(data), ...(logger !== undefined ? { logger: String(logger) } : {}) }
      } as JSONRPCMessage)
    }
  }
}
