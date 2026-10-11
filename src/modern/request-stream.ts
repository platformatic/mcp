/**
 * Request-scoped notifications for the 2026-07-28 revision.
 *
 * `notifications/progress` and `notifications/message` travel on the response
 * stream of the request they relate to. Once that stream is open the HTTP
 * status is committed to 200, yet some errors must be sent with a 4xx status.
 * So notifications are held back until the outcome is known, or until the
 * handler has been running long enough that holding them would defeat their
 * purpose. A request that never reports anything gets a plain JSON response.
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
  #opened = false
  #finished = false
  #held: string[] = []
  #timer?: NodeJS.Timeout

  constructor (reply: FastifyReply) {
    this.#reply = reply
  }

  /** Send a notification before the response. Nothing is sent after it. */
  notify (message: JSONRPCMessage): void {
    if (this.#finished) return
    const frame = `data: ${JSON.stringify(message)}\n\n`
    if (this.#opened) {
      this.#write(frame)
      return
    }
    this.#held.push(frame)
    this.#timer ??= setTimeout(() => {
      if (!this.#finished) this.#open()
    }, STREAM_OPEN_DELAY_MS).unref()
  }

  /**
   * Conclude the request. Returns true when the response went out on the
   * stream; false when the caller should send it as plain JSON, which happens
   * when nothing was reported or the response is an error that has not
   * already been committed to a 200 stream.
   */
  finish (response: JSONRPCMessage): boolean {
    this.#finished = true
    if (this.#timer) clearTimeout(this.#timer)

    if (!this.#opened) {
      const isError = 'error' in (response as object)
      if (this.#held.length === 0 || isError) {
        this.#held = []
        return false
      }
      this.#open()
    }

    const raw = this.#reply.raw
    if (!raw.destroyed && !raw.writableEnded) raw.end(`data: ${JSON.stringify(response)}\n\n`)
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
  }

  #write (frame: string): void {
    const raw = this.#reply.raw
    if (raw.destroyed || raw.writableEnded) return
    if (raw.writableLength > MAX_BUFFERED_BYTES) return
    raw.write(frame)
  }
}

/** Make log data serializable: errors, bigints and cycles would otherwise throw or vanish. */
function toJsonSafe (data: unknown): unknown {
  const seen = new WeakSet<object>()
  try {
    return JSON.parse(JSON.stringify(data, (_key, value: unknown) => {
      if (typeof value === 'bigint') return value.toString()
      if (value instanceof Error) return { name: value.name, message: value.message }
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return '[Circular]'
        seen.add(value)
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
