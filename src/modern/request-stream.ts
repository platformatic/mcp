/**
 * Request-scoped notifications for the 2026-07-28 revision.
 *
 * `notifications/progress` and `notifications/message` travel on the response
 * stream of the request they relate to. The response becomes an SSE stream
 * only once the handler actually sends one, so a request that never reports
 * anything still gets a plain JSON response.
 */

import type { FastifyReply } from 'fastify'
import type { JSONRPCMessage, LoggingLevel } from '../schema.ts'
import { JSONRPC_VERSION } from '../schema.ts'
import { LOG_LEVELS } from './request-meta.ts'
import type { RequestContext } from './request-meta.ts'

export interface RequestNotifiers {
  sendProgress: (progress: number, total?: number, message?: string) => void
  log: (level: LoggingLevel, data: unknown, logger?: string) => void
}

export class RequestStream {
  #reply: FastifyReply
  #opened = false
  #finished = false

  constructor (reply: FastifyReply) {
    this.#reply = reply
  }

  get opened (): boolean {
    return this.#opened
  }

  /** Send a notification before the response, opening the stream if needed. */
  notify (message: JSONRPCMessage): void {
    if (this.#finished) return
    const raw = this.#reply.raw
    if (raw.destroyed || raw.writableEnded) return
    if (!this.#opened) {
      this.#opened = true
      this.#reply.hijack()
      raw.setHeader('Content-Type', 'text/event-stream')
      raw.setHeader('Cache-Control', 'no-cache')
      raw.setHeader('X-Accel-Buffering', 'no')
      raw.writeHead(200)
    }
    raw.write(`data: ${JSON.stringify(message)}\n\n`)
  }

  /** End an opened stream with the final response. */
  finish (response: JSONRPCMessage): void {
    this.#finished = true
    const raw = this.#reply.raw
    if (raw.destroyed || raw.writableEnded) return
    raw.end(`data: ${JSON.stringify(response)}\n\n`)
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
      if (typeof progress !== 'number' || !(progress > lastProgress)) return
      lastProgress = progress
      stream.notify({
        jsonrpc: JSONRPC_VERSION,
        method: 'notifications/progress',
        params: {
          progressToken: context.progressToken,
          progress,
          ...(total !== undefined ? { total } : {}),
          ...(message !== undefined ? { message } : {})
        }
      } as JSONRPCMessage)
    },
    log (level, data, logger) {
      if (!stream || minimum === -1) return
      if (LOG_LEVELS.indexOf(level) < minimum) return
      stream.notify({
        jsonrpc: JSONRPC_VERSION,
        method: 'notifications/message',
        params: { level, data, ...(logger !== undefined ? { logger } : {}) }
      } as JSONRPCMessage)
    }
  }
}
