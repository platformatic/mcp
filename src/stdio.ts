import { stdin, stdout, stderr } from 'process'
import { createInterface } from 'readline'
import type { FastifyInstance } from 'fastify'
import type {
  JSONRPCMessage,
  JSONRPCResponse,
  JSONRPCError,
  JSONRPCBatchRequest,
  JSONRPCBatchResponse
} from './schema.ts'

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
  private readline: any
  private transportOpts: StdioTransportOptions
  private isShuttingDown = false

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
      this.handleIncomingMessage(line.trim())
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
    try {
      // Use Fastify's inject method to simulate an HTTP request to the /mcp endpoint
      const response = await this.app.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json' // Explicitly request JSON, not SSE
        },
        payload: message
      })

      // Parse the response
      if (response.statusCode === 200) {
        return JSON.parse(response.body)
      } else if (response.statusCode === 204) {
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
