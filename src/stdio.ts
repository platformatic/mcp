import { stdin, stdout, stderr } from 'process'
import { createInterface } from 'readline'
import type { FastifyInstance } from 'fastify'
import { STDIO_REQUEST_HEADER, registerStdioRequest } from './stdio-trust.ts'
import type { AuthorizationContext } from './types/auth-types.ts'
import { MAX_REQUEST_ID_LENGTH, bodyClaimsModern } from './modern/request-meta.ts'
import type {
  JSONRPCMessage,
  JSONRPCResponse,
  JSONRPCError,
  JSONRPCRequest,
  JSONRPCNotification
} from './schema.ts'
import { checkRequestId } from './handlers.ts'

// Local batch types for JSON-RPC 2.0 compatibility
type JSONRPCBatchRequest = (JSONRPCRequest | JSONRPCNotification)[]
type JSONRPCBatchResponse = (JSONRPCResponse | JSONRPCError)[]

/**
 * Options for the stdio transport
 */
export interface StdioTransportOptions {
  /**
   * Whether to log debug information to stderr
   */
  debug?: boolean
  /**
   * Custom input stream (defaults to process.stdin)
   */
  input?: NodeJS.ReadableStream
  /**
   * Custom output stream (defaults to process.stdout)
   */
  output?: NodeJS.WritableStream
  /**
   * Custom error stream (defaults to process.stderr)
   */
  error?: NodeJS.WritableStream
  /**
   * Who the stdio client is. stdio carries no bearer token: the client is
   * whoever started the process, and the spec has it take credentials from
   * the environment. Requests over stdio skip HTTP authorization; with this
   * set they act as this identity, so per-caller features (multi round-trip
   * requests and tasks when authorization is enabled, task ownership, quotas)
   * work. Without it they are anonymous.
   */
  authContext?: AuthorizationContext
}

function isJsonRpcObject (value: unknown): value is JSONRPCMessage {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isJsonRpcResponse (value: unknown): value is JSONRPCResponse | JSONRPCError {
  if (!isJsonRpcObject(value)) return false
  const record = value as unknown as Record<string, unknown>
  return record.jsonrpc === '2.0' && 'id' in record && ('result' in record || 'error' in record)
}

function invalidRequest (): JSONRPCError {
  return { jsonrpc: '2.0', id: null as unknown as string, error: { code: -32600, message: 'Invalid Request' } }
}

/** How long stop() waits for listen streams to write their teardown frames. */
const LISTEN_FLUSH_MS = 1000

/**
 * How long stop() lets requests already read finish before cancelling them.
 * Closing stdin is how a client asks for a graceful shutdown, often right
 * after writing its last request, which still deserves its answer.
 */
const REQUEST_DRAIN_MS = 1000

/**
 * After the drain, how long requests aborted by the shutdown get to be
 * answered before the app closes.
 */
const ABORT_GRACE_MS = 500

/** Why a request was aborted when the client cancelled it: it gets no response. */
class CancelledByClient extends Error {}

/** A request id as a map key: `1` and `"1"` are different requests. */
function requestKey (id: string | number): string {
  return `${typeof id}:${id}`
}

/**
 * Stdio transport for MCP over stdin/stdout
 */
export class StdioTransport {
  private app: FastifyInstance
  private readline: any
  private transportOpts: StdioTransportOptions
  /** Requests still being served, by JSON-RPC id, so a client can cancel them. */
  private inFlight = new Map<string, AbortController>()
  /** Open `subscriptions/listen` streams, settled once each has been forwarded to the end. */
  private listens = new Map<AbortController, Promise<void>>()
  /** Every message being processed other than listen streams, which never end on their own. */
  private processing = new Set<Promise<unknown>>()
  // There is no session over stdio, so the transport itself has to remember
  // what a legacy `initialize` agreed on and echo it like an HTTP client would.
  private protocolVersion: string | undefined
  private closePromise: Promise<void> | null = null
  private onSigint: (() => void) | null = null
  private onSigterm: (() => void) | null = null

  constructor (
    app: FastifyInstance,
    transportOpts: StdioTransportOptions = {}
  ) {
    this.app = app
    this.transportOpts = {
      debug: false,
      input: stdin,
      output: stdout,
      error: stderr,
      ...transportOpts
    }
  }

  /**
   * Start the stdio transport
   */
  start (): void {
    this.log('Starting MCP stdio transport...')

    // Create readline interface for line-by-line processing
    this.readline = createInterface({
      input: this.transportOpts.input!,
      output: this.transportOpts.output!,
      crlfDelay: Infinity
    })

    // Handle each line as a JSON-RPC message
    this.readline.on('line', (line: string) => {
      // One bad line must never take the server down with an unhandled rejection.
      this.handleIncomingMessage(line.trim()).catch((error) => {
        this.logError('Error handling message:', error)
      })
    })

    // Handle close/error events
    this.readline.on('close', () => {
      this.log('Stdio transport closed')
      // Trigger graceful shutdown when readline closes
      this.stop().catch(error => {
        this.logError('Error during shutdown:', error)
      })
    })

    this.readline.on('error', (error: Error) => {
      this.logError('Readline error:', error)
      // Trigger graceful shutdown on readline error
      this.stop().catch(shutdownError => {
        this.logError('Error during shutdown:', shutdownError)
      })
    })

    // Handle process signals for graceful shutdown. Keep references so stop()
    // can remove them; otherwise every transport leaks two listeners.
    this.onSigint = () => {
      this.log('Received SIGINT, shutting down...')
      this.stop().catch(error => {
        this.logError('Error during shutdown:', error)
      })
    }
    this.onSigterm = () => {
      this.log('Received SIGTERM, shutting down...')
      this.stop().catch(error => {
        this.logError('Error during shutdown:', error)
      })
    }
    process.on('SIGINT', this.onSigint)
    process.on('SIGTERM', this.onSigterm)

    this.log('MCP stdio transport started successfully')
  }

  /**
   * Stop the stdio transport
   */
  stop (): Promise<void> {
    this.removeSignalListeners()

    // Return the same promise to every caller so that concurrent stop() calls
    // (readline close, stdin end, signals) all wait for app.close() to finish
    if (!this.closePromise) {
      this.closePromise = this.doStop()
    }
    return this.closePromise
  }

  private removeSignalListeners (): void {
    if (this.onSigint) {
      process.removeListener('SIGINT', this.onSigint)
      this.onSigint = null
    }
    if (this.onSigterm) {
      process.removeListener('SIGTERM', this.onSigterm)
      this.onSigterm = null
    }
  }

  private async doStop (): Promise<void> {
    this.log('Stopping stdio transport...')

    if (this.readline) {
      this.readline.close()
    }

    // Let what was already read finish and be answered, for a while.
    await this.settleProcessing(REQUEST_DRAIN_MS)

    // Cancel what is still running, so handlers stop rather than outlive the
    // resources app.close() tears down. Listen streams are left open: closing
    // the app ends each one gracefully (notifications/cancelled, then the
    // empty result), and the spec requires the client to be told.
    for (const cancel of this.inFlight.values()) {
      if (!this.listens.has(cancel)) cancel.abort(new Error('stdio transport closed'))
    }
    // A handler that honours its signal still answers, so give it a moment.
    await this.settleProcessing(ABORT_GRACE_MS)

    // Close the Fastify app gracefully
    try {
      await this.app.close()
      this.log('Fastify app closed successfully')
    } catch (error) {
      this.logError('Error closing Fastify app:', error)
    }

    // Let the teardown frames reach stdout, but never wait on a client that
    // stopped reading: whatever is still open after that is dropped.
    if (this.listens.size > 0) {
      let timer: NodeJS.Timeout | undefined
      await Promise.race([
        Promise.allSettled(this.listens.values()),
        new Promise<void>(resolve => { timer = setTimeout(resolve, LISTEN_FLUSH_MS) })
      ])
      clearTimeout(timer)
      for (const cancel of this.listens.keys()) cancel.abort(new Error('stdio transport closed'))
    }
  }

  /** Wait until every non-listen message has been answered, or `timeoutMs` passes. */
  private async settleProcessing (timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (this.processing.size > 0 && Date.now() < deadline) {
      let timer: NodeJS.Timeout | undefined
      await Promise.race([
        Promise.allSettled(this.processing),
        new Promise<void>(resolve => { timer = setTimeout(resolve, deadline - Date.now()) })
      ])
      clearTimeout(timer)
    }
  }

  /**
   * Handle incoming JSON-RPC message from stdin
   */
  private async handleIncomingMessage (line: string): Promise<void> {
    if (!line) return

    let message: JSONRPCMessage
    try {
      message = JSON.parse(line)
    } catch (error) {
      // JSON-RPC answers unparseable input with a parse error and a null id.
      this.logError('Could not parse message:', error)
      this.sendMessage({
        jsonrpc: '2.0',
        id: null as unknown as string,
        error: { code: -32700, message: 'Parse error' }
      })
      return
    }
    this.log('Received message:', message)

    // Valid JSON is not necessarily a JSON-RPC message: anything but an object
    // (or, for the legacy revisions, a non-empty array) is an invalid request.
    const parsed: unknown = message
    if (!isJsonRpcObject(parsed) && !(Array.isArray(parsed) && parsed.length > 0)) {
      this.sendMessage(invalidRequest())
      return
    }

    if (Array.isArray(message)) {
      // 2026-07-28 carries exactly one message per line; only the legacy
      // revisions that predate the batch removal may still send arrays.
      if ((message as unknown[]).some(entry => bodyClaimsModern(entry))) {
        this.sendMessage({
          jsonrpc: '2.0',
          id: null as unknown as string,
          error: { code: -32600, message: 'Batch requests are not supported' }
        })
        return
      }
      await this.handleBatchMessage(message as JSONRPCBatchRequest)
      return
    }

    this.applyCancellation(message)
    const response = await this.processMessage(message)
    if (response) {
      this.sendMessage(response)
    }
  }

  /**
   * On stdio there is no response stream to close: the client cancels with a
   * notification, after which nothing more may be sent for that request.
   */
  private applyCancellation (message: JSONRPCMessage): void {
    if ((message as { method?: string }).method !== 'notifications/cancelled') return
    const requestId = (message as { params?: { requestId?: unknown } }).params?.requestId
    if (typeof requestId === 'string' || typeof requestId === 'number') {
      this.inFlight.get(requestKey(requestId))?.abort(new CancelledByClient('cancelled by the client'))
    }
  }

  /**
   * Handle batch JSON-RPC messages
   */
  private async handleBatchMessage (batch: JSONRPCBatchRequest): Promise<void> {
    const responses: JSONRPCBatchResponse = []

    for (const message of batch) {
      if (!isJsonRpcObject(message)) {
        responses.push(invalidRequest())
        continue
      }
      this.applyCancellation(message)
      const response = await this.processMessage(message)
      if (response) {
        responses.push(response)
      }
    }

    // Only send response if we have any responses
    if (responses.length > 0) {
      this.sendMessage(responses)
    }
  }

  /**
   * Process a single JSON-RPC message using Fastify's inject method.
   *
   * A streamed response (`subscriptions/listen`) is forwarded frame by frame
   * as it arrives, rather than after it ends, which a subscription never does
   * on its own.
   */
  private processMessage (message: JSONRPCMessage): Promise<JSONRPCResponse | JSONRPCError | null> {
    const processed = this.runMessage(message)
    if ((message as { method?: string }).method !== 'subscriptions/listen') {
      const settled = processed.then(() => {}, () => {})
      this.processing.add(settled)
      settled.finally(() => this.processing.delete(settled))
    }
    return processed
  }

  private async runMessage (message: JSONRPCMessage): Promise<JSONRPCResponse | JSONRPCError | null> {
    // Check before inject re-serializes the message: an id such as 1e400
    // parses to Infinity, which JSON.stringify would turn into null, and an
    // unsafe integer would come back as a different id.
    const idError = checkRequestId(message)
    if (idError) return idError

    const id = 'id' in message ? (message as { id: string | number }).id : undefined
    const key = id === undefined ? undefined : requestKey(id)
    // A cancellation names the request by id, so two in flight under one id
    // would leave the first beyond the client's reach.
    if (key !== undefined && this.inFlight.has(key)) {
      return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request: a request with this id is still in progress' } }
    }
    const cancel = new AbortController()
    if (key !== undefined) this.inFlight.set(key, cancel)
    const registration = registerStdioRequest(cancel.signal, this.transportOpts.authContext)
    const isInitialize = (message as { method?: string }).method === 'initialize'
    const isListen = (message as { method?: string }).method === 'subscriptions/listen'

    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'x-platformatic-mcp-transport': 'stdio',
        [STDIO_REQUEST_HEADER]: registration.token
      }
      // `initialize` is the negotiation itself, so it never carries a version,
      // and a 2026-07-28 message carries its own in `_meta`.
      if (!isInitialize && this.protocolVersion && !bodyClaimsModern(message)) {
        headers['mcp-protocol-version'] = this.protocolVersion
      }

      // Use Fastify's inject method to simulate an HTTP request to the /mcp endpoint
      const response = await this.app.inject({
        method: 'POST',
        url: '/mcp',
        headers,
        payload: message,
        payloadAsStream: true
      })

      const stream = response.stream()
      if (String(response.headers['content-type'] ?? '').startsWith('text/event-stream')) {
        // Cancelled before the stream even arrived: the listener below would
        // never fire on an already-aborted signal, so close it now.
        if (cancel.signal.reason instanceof CancelledByClient || (isListen && cancel.signal.aborted)) {
          stream.destroy()
          return null
        }
        // A listen stops on any abort. Any other stream stops only when the
        // client cancelled it: one stopped by a shutdown still ends with its
        // response, like a request answered with plain JSON.
        const stopped = isListen ? cancel : new AbortController()
        if (!isListen) {
          cancel.signal.addEventListener('abort', () => {
            if (cancel.signal.reason instanceof CancelledByClient) stopped.abort(cancel.signal.reason)
          }, { once: true })
        }
        stopped.signal.addEventListener('abort', () => stream.destroy(), { once: true })
        const forwarded = this.forwardEvents(stream, stopped.signal)
        if (isListen) this.listens.set(cancel, forwarded)
        await forwarded
        return null
      }

      let body = ''
      for await (const chunk of stream) body += chunk
      // Stopped by a shutdown rather than the client, the request is still answered.
      if (cancel.signal.reason instanceof CancelledByClient) return null
      if (response.statusCode === 202 || body === '') return null

      // Only JSON-RPC goes to stdout. A plain HTTP error from Fastify or a
      // plugin (a body over the size limit, say) still answers this id.
      let parsed: unknown
      try {
        parsed = JSON.parse(body)
      } catch {
        parsed = undefined
      }
      if (id === undefined) {
        // A notification gets no answer, but a message that is not a valid
        // request at all (no id, a non-string method, the wrong jsonrpc) is
        // answered with an Invalid Request error that has a null id.
        return isJsonRpcResponse(parsed) && parsed.id === null && 'error' in parsed ? parsed : null
      }
      if (isJsonRpcResponse(parsed)) {
        const negotiated = (parsed as { result?: { protocolVersion?: unknown } }).result?.protocolVersion
        if (isInitialize && typeof negotiated === 'string') this.protocolVersion = negotiated
        // A body-parser error cannot know the id (HTTP never parsed the
        // body), but this transport did: answer the request it belongs to.
        // Only an id the request could carry: an invalid one (a boolean, an
        // object) is exactly why the error has none.
        const validId = (typeof id === 'string' && id.length <= MAX_REQUEST_ID_LENGTH) || Number.isSafeInteger(id)
        return parsed.id === null && validId ? { ...parsed, id } as JSONRPCError : parsed
      }
      this.logError(`Non-JSON-RPC response (status ${response.statusCode}):`, body)
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: response.statusCode === 413 ? -32600 : -32603,
          message: response.statusCode === 413 ? 'Request too large' : 'Internal server error'
        }
      }
    } catch (error) {
      if (cancel.signal.reason instanceof CancelledByClient || id === undefined) return null
      this.logError('Error processing message via inject:', error)

      // Return a generic error response
      const errorResponse: JSONRPCError = {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603, // Internal error
          message: 'Internal server error'
        }
      }
      return errorResponse
    } finally {
      registration.release()
      this.listens.delete(cancel)
      if (key !== undefined && this.inFlight.get(key) === cancel) this.inFlight.delete(key)
    }
  }

  /**
   * Write each `data:` frame of an SSE response to stdout as its own line, as
   * it arrives. Stops writing as soon as the request is cancelled.
   */
  private async forwardEvents (stream: AsyncIterable<Buffer | string>, cancelled: AbortSignal): Promise<void> {
    let buffered = ''
    try {
      for await (const chunk of stream) {
        buffered += chunk.toString()
        let boundary = buffered.indexOf('\n\n')
        while (boundary !== -1) {
          const frame = buffered.slice(0, boundary)
          buffered = buffered.slice(boundary + 2)
          boundary = buffered.indexOf('\n\n')
          if (cancelled.aborted) continue
          const data = frame.split('\n')
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trimStart())
            .join('\n')
          // Wait for stdout to drain before reading on: the stream's own
          // buffer limit then applies to a client that stops reading,
          // instead of stdout buffering without bound.
          if (data && !this.sendMessage(JSON.parse(data))) await this.drained(cancelled)
        }
      }
    } catch (error) {
      if (!cancelled.aborted) this.logError('Error forwarding streamed response:', error)
    }
  }

  /** Resolve once stdout can take more, it closes, or `signal` aborts. */
  private drained (signal: AbortSignal): Promise<void> {
    const output = this.transportOpts.output
    if (!output || signal.aborted) return Promise.resolve()
    return new Promise(resolve => {
      const done = () => {
        output.removeListener('drain', done)
        output.removeListener('close', done)
        output.removeListener('error', done)
        signal.removeEventListener('abort', done)
        resolve()
      }
      output.once('drain', done)
      output.once('close', done)
      output.once('error', done)
      signal.addEventListener('abort', done, { once: true })
    })
  }

  /**
   * Send a JSON-RPC message to stdout. Returns false when stdout's buffer is
   * full and the caller should wait for it to drain.
   */
  private sendMessage (message: JSONRPCMessage | JSONRPCBatchResponse): boolean {
    try {
      const serialized = JSON.stringify(message)
      this.log('Sending message:', message)

      // Write to stdout with newline delimiter
      if (this.transportOpts.output) {
        return this.transportOpts.output.write(serialized + '\n')
      }
    } catch (error) {
      this.logError('Error sending message:', error)
    }
    return true
  }

  /**
   * Log debug information to stderr
   */
  private log (message: string, ...args: any[]): void {
    if (this.transportOpts.debug && this.transportOpts.error) {
      const timestamp = new Date().toISOString()
      this.transportOpts.error.write(`[${timestamp}] ${message}`)
      if (args.length > 0) {
        this.transportOpts.error.write(' ' + args.map(arg =>
          typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
        ).join(' '))
      }
      this.transportOpts.error.write('\n')
    }
  }

  /**
   * Log error information to stderr
   */
  private logError (message: string, error?: any): void {
    if (this.transportOpts.error) {
      const timestamp = new Date().toISOString()
      this.transportOpts.error.write(`[${timestamp}] ERROR: ${message}`)
      if (error) {
        this.transportOpts.error.write(' ' + (error instanceof Error ? error.message : String(error)))
      }
      this.transportOpts.error.write('\n')
    }
  }
}

/**
 * Create and start a stdio transport for a Fastify MCP server
 */
export function createStdioTransport (
  app: FastifyInstance,
  transportOpts: StdioTransportOptions = {}
): StdioTransport {
  const transport = new StdioTransport(app, transportOpts)
  return transport
}

/**
 * Utility function to run a Fastify MCP server in stdio mode
 */
export async function runStdioServer (
  app: FastifyInstance,
  transportOpts: StdioTransportOptions = {}
): Promise<void> {
  const transport = createStdioTransport(app, transportOpts)

  transport.start()

  // Return a promise that resolves when the process should shut down
  return new Promise((resolve) => {
    const shutdown = async () => {
      process.removeListener('SIGINT', shutdown)
      process.removeListener('SIGTERM', shutdown)
      await transport.stop()
      resolve()
    }

    // Handle graceful shutdown signals
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)

    // Handle input close (when parent process closes our stdin)
    const input = transportOpts.input ?? process.stdin
    input.on('close', shutdown)
    input.on('end', shutdown)
  })
}
