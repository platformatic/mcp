import { stdin, stdout, stderr } from 'process'
import { createInterface } from 'readline'
import type { FastifyInstance } from 'fastify'
import { STDIO_REQUEST_HEADER, STDIO_TRUST_HEADER, STDIO_TRUST_TOKEN, registerStdioRequest } from './stdio-trust.ts'
import { bodyClaimsModern } from './modern/request-meta.ts'
import type {
  JSONRPCMessage,
  JSONRPCResponse,
  JSONRPCError,
  JSONRPCRequest,
  JSONRPCNotification
} from './schema.ts'

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
  private isShuttingDown = false
  /** Requests still being served, by JSON-RPC id, so a client can cancel them. */
  private inFlight = new Map<string, AbortController>()

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

    // Handle process signals for graceful shutdown
    process.on('SIGINT', () => {
      this.log('Received SIGINT, shutting down...')
      this.stop().catch(error => {
        this.logError('Error during shutdown:', error)
      })
    })

    process.on('SIGTERM', () => {
      this.log('Received SIGTERM, shutting down...')
      this.stop().catch(error => {
        this.logError('Error during shutdown:', error)
      })
    })

    this.log('MCP stdio transport started successfully')
  }

  /**
   * Stop the stdio transport
   */
  async stop (): Promise<void> {
    if (this.isShuttingDown) {
      return
    }

    this.isShuttingDown = true
    this.log('Stopping stdio transport...')

    if (this.readline) {
      this.readline.close()
    }

    // Close the Fastify app gracefully
    try {
      await this.app.close()
      this.log('Fastify app closed successfully')
    } catch (error) {
      this.logError('Error closing Fastify app:', error)
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

    // On stdio there is no response stream to close: the client cancels with
    // a notification, after which nothing more may be sent for that request.
    if ((message as { method?: string }).method === 'notifications/cancelled') {
      const requestId = (message as { params?: { requestId?: unknown } }).params?.requestId
      if (typeof requestId === 'string' || typeof requestId === 'number') {
        this.inFlight.get(requestKey(requestId))?.abort(new Error('cancelled by the client'))
      }
    }

    const response = await this.processMessage(message)
    if (response) {
      this.sendMessage(response)
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
  private async processMessage (message: JSONRPCMessage): Promise<JSONRPCResponse | JSONRPCError | null> {
    const id = 'id' in message ? (message as { id: string | number }).id : undefined
    const key = id === undefined ? undefined : requestKey(id)
    const cancel = new AbortController()
    if (key !== undefined) this.inFlight.set(key, cancel)
    const registration = registerStdioRequest(cancel.signal)

    try {
      // Use Fastify's inject method to simulate an HTTP request to the /mcp endpoint
      const response = await this.app.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'x-platformatic-mcp-transport': 'stdio',
          [STDIO_TRUST_HEADER]: STDIO_TRUST_TOKEN,
          [STDIO_REQUEST_HEADER]: registration.token
        },
        payload: message,
        payloadAsStream: true
      })

      const stream = response.stream()
      if (String(response.headers['content-type'] ?? '').startsWith('text/event-stream')) {
        // Cancelled before the stream even arrived: the listener below would
        // never fire on an already-aborted signal, so close it now.
        if (cancel.signal.aborted) {
          stream.destroy()
          return null
        }
        cancel.signal.addEventListener('abort', () => stream.destroy(), { once: true })
        await this.forwardEvents(stream, cancel.signal)
        return null
      }

      let body = ''
      for await (const chunk of stream) body += chunk
      if (cancel.signal.aborted || id === undefined) return null
      if (response.statusCode === 202 || body === '') return null

      // Only JSON-RPC goes to stdout. A plain HTTP error from Fastify or a
      // plugin (a body over the size limit, say) still answers this id.
      let parsed: unknown
      try {
        parsed = JSON.parse(body)
      } catch {
        parsed = undefined
      }
      if (isJsonRpcResponse(parsed)) return parsed
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
      if (cancel.signal.aborted || id === undefined) return null
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
          if (data) this.sendMessage(JSON.parse(data))
        }
      }
    } catch (error) {
      if (!cancelled.aborted) this.logError('Error forwarding streamed response:', error)
    }
  }

  /**
   * Send a JSON-RPC message to stdout
   */
  private sendMessage (message: JSONRPCMessage | JSONRPCBatchResponse): void {
    try {
      const serialized = JSON.stringify(message)
      this.log('Sending message:', message)

      // Write to stdout with newline delimiter
      if (this.transportOpts.output) {
        this.transportOpts.output.write(serialized + '\n')
      }
    } catch (error) {
      this.logError('Error sending message:', error)
    }
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
      await transport.stop()
      resolve()
    }

    // Handle graceful shutdown signals
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)

    // Handle stdin close (when parent process closes our stdin)
    process.stdin.on('close', shutdown)
    process.stdin.on('end', shutdown)
  })
}
