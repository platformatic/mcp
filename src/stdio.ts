import { stdin, stdout, stderr } from 'process'
import { StringDecoder } from 'string_decoder'
import type { FastifyInstance } from 'fastify'
import type {
  JSONRPCMessage,
  JSONRPCResponse,
  JSONRPCError,
  JSONRPCRequest,
  JSONRPCNotification
} from './schema.ts'
import { checkRequestId } from './handlers.ts'
import { STDIO_TRANSPORT_HEADER, STDIO_TOKEN_HEADER, STDIO_TOKEN } from './stdio-marker.ts'

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

/**
 * Stdio transport for MCP over stdin/stdout
 */
export class StdioTransport {
  private app: FastifyInstance
  private input: NodeJS.ReadableStream | null = null
  private decoder = new StringDecoder('utf8')
  private pending = ''
  private ended = false
  // Processing of the final unterminated line, awaited before app.close()
  private flushing: Promise<void> | null = null
  private transportOpts: StdioTransportOptions
  // There is no session over stdio, so the transport itself has to remember
  // what `initialize` agreed on and echo it like an HTTP client would.
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

    // Messages are delimited by \n only. readline would also split on a bare
    // \r, which JSON allows as whitespace inside a message.
    const input = this.transportOpts.input!
    this.input = input
    input.on('data', this.onData)
    input.on('end', this.onEnd)
    input.on('close', this.onClose)
    input.on('error', this.onError)

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
    // (stdin end, signals) all wait for app.close() to finish
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

    if (this.input) {
      this.input.removeListener('data', this.onData)
      this.input.removeListener('end', this.onEnd)
      this.input.removeListener('close', this.onClose)
      this.input.removeListener('error', this.onError)
      this.input.pause()
      this.input = null
    }

    // Answer a final unterminated line before closing the app
    if (this.flushing) {
      await this.flushing
    }

    // Close the Fastify app gracefully
    try {
      await this.app.close()
      this.log('Fastify app closed successfully')
    } catch (error) {
      this.logError('Error closing Fastify app:', error)
    }
  }

  private onData = (chunk: Buffer | string): void => {
    this.pending += typeof chunk === 'string' ? chunk : this.decoder.write(chunk)

    let start = 0
    let newline: number
    while ((newline = this.pending.indexOf('\n', start)) !== -1) {
      this.handleLine(this.pending.slice(start, newline))
      start = newline + 1
    }
    this.pending = this.pending.slice(start)
  }

  private onEnd = (): void => {
    this.ended = true
    const rest = this.pending + this.decoder.end()
    this.pending = ''
    if (rest) {
      this.flushing = this.handleLine(rest)
    }
    this.log('Stdio transport closed')
    this.stop().catch(error => {
      this.logError('Error during shutdown:', error)
    })
  }

  private onClose = (): void => {
    // 'end' already handled shutdown; a close without 'end' means the
    // stream was destroyed, so a partial line is dropped
    if (this.ended) return
    this.log('Stdio transport closed')
    this.stop().catch(error => {
      this.logError('Error during shutdown:', error)
    })
  }

  private onError = (error: Error): void => {
    this.logError('Input error:', error)
    this.stop().catch(shutdownError => {
      this.logError('Error during shutdown:', shutdownError)
    })
  }

  private handleLine (line: string): Promise<void> {
    if (line.endsWith('\r')) {
      line = line.slice(0, -1)
    }
    return this.handleIncomingMessage(line.trim())
  }

  /**
   * Handle incoming JSON-RPC message from stdin
   */
  private async handleIncomingMessage (line: string): Promise<void> {
    if (!line) return

    try {
      const message: JSONRPCMessage = JSON.parse(line)
      this.log('Received message:', message)

      // Handle batch requests
      if (Array.isArray(message)) {
        await this.handleBatchMessage(message as JSONRPCBatchRequest)
        return
      }

      // Handle single message
      const response = await this.processMessage(message)
      if (response) {
        this.sendMessage(response)
      }
    } catch (error) {
      this.logError('Error processing message:', error)

      // Try to send error response if we can extract an ID
      try {
        const parsed = JSON.parse(line)
        if (parsed.id) {
          const errorResponse: JSONRPCError = {
            jsonrpc: '2.0',
            id: parsed.id,
            error: {
              code: -32700, // Parse error
              message: 'Parse error',
              data: error instanceof Error ? error.message : String(error)
            }
          }
          this.sendMessage(errorResponse)
        }
      } catch {
        // If we can't even parse to get an ID, just log and continue
        this.logError('Could not send error response due to parse failure')
      }
    }
  }

  /**
   * Handle batch JSON-RPC messages
   */
  private async handleBatchMessage (batch: JSONRPCBatchRequest): Promise<void> {
    const responses: JSONRPCBatchResponse = []

    for (const message of batch) {
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
   * Process a single JSON-RPC message using Fastify's inject method
   */
  private async processMessage (message: JSONRPCMessage): Promise<JSONRPCResponse | JSONRPCError | null> {
    const isInitialize = (message as { method?: string }).method === 'initialize'

    // Check before inject re-serializes the message: an id such as 1e400
    // parses to Infinity, which JSON.stringify would turn into null
    const idError = checkRequestId(message)
    if (idError) return idError

    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'application/json', // Explicitly request JSON, not SSE
        [STDIO_TRANSPORT_HEADER]: 'stdio',
        [STDIO_TOKEN_HEADER]: STDIO_TOKEN
      }
      // `initialize` is the negotiation itself, so it never carries a version
      if (!isInitialize && this.protocolVersion) {
        headers['mcp-protocol-version'] = this.protocolVersion
      }

      // Use Fastify's inject method to simulate an HTTP request to the /mcp endpoint
      const response = await this.app.inject({
        method: 'POST',
        url: '/mcp',
        headers,
        payload: message
      })

      // Parse the response
      if (response.statusCode === 200) {
        const body = JSON.parse(response.body)
        const negotiated = body?.result?.protocolVersion
        if (isInitialize && typeof negotiated === 'string') {
          this.protocolVersion = negotiated
        }
        return body
      } else if (response.statusCode === 202) {
        // No content - this is for notifications that don't expect a response
        return null
      } else {
        // Error response
        const errorBody = JSON.parse(response.body)
        return errorBody
      }
    } catch (error) {
      this.logError('Error processing message via inject:', error)

      // Return a generic error response
      const errorResponse: JSONRPCError = {
        jsonrpc: '2.0',
        id: ('id' in message) ? message.id : 0,
        error: {
          code: -32603, // Internal error
          message: 'Internal server error',
          data: error instanceof Error ? error.message : String(error)
        }
      }
      return errorResponse
    }
  }

  /**
   * Send a JSON-RPC message to stdout
   */
  private sendMessage (message: JSONRPCResponse | JSONRPCError | JSONRPCBatchResponse): void {
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
