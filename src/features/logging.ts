import type { LogLevel, JSONRPCNotification } from '../schema.ts'
import type { MessageBroker } from '../brokers/message-broker.ts'

/**
 * RFC 5424 Syslog severity levels in order of increasing severity.
 * Used for log level comparison.
 */
const LOG_LEVEL_HIERARCHY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  notice: 2,
  warning: 3,
  error: 4,
  critical: 5,
  alert: 6,
  emergency: 7
}

/**
 * Logging service for MCP servers.
 *
 * Implements the MCP logging capability, allowing servers to send
 * structured log messages to connected clients. Supports dynamic
 * log level configuration and uses the message broker for distribution.
 */
export class LoggingService {
  private minLevel: LogLevel = 'info'
  private readonly messageBroker: MessageBroker

  constructor (messageBroker: MessageBroker) {
    this.messageBroker = messageBroker
  }

  /**
   * Sets the minimum log level. Messages below this level will be filtered.
   *
   * @param level - The minimum log level to emit
   */
  async setLevel (level: LogLevel): Promise<void> {
    this.minLevel = level
  }

  /**
   * Gets the current minimum log level.
   *
   * @returns The current minimum log level
   */
  getLevel (): LogLevel {
    return this.minLevel
  }

  /**
   * Logs a message at the specified level.
   *
   * @param level - Log severity level
   * @param data - Structured log data
   * @param logger - Optional logger name/category
   */
  async log (
    level: LogLevel,
    data: unknown,
    logger?: string
  ): Promise<void> {
    if (!this.shouldLog(level)) {
      return
    }

    const notification: JSONRPCNotification = {
      jsonrpc: '2.0',
      method: 'notifications/message',
      params: {
        level,
        logger,
        data
      }
    }

    await this.messageBroker.publish('mcp/broadcast/notification', notification)
  }

  /**
   * Convenience methods for each log level.
   */

  async debug (data: unknown, logger?: string): Promise<void> {
    await this.log('debug', data, logger)
  }

  async info (data: unknown, logger?: string): Promise<void> {
    await this.log('info', data, logger)
  }

  async notice (data: unknown, logger?: string): Promise<void> {
    await this.log('notice', data, logger)
  }

  async warning (data: unknown, logger?: string): Promise<void> {
    await this.log('warning', data, logger)
  }

  async error (data: unknown, logger?: string): Promise<void> {
    await this.log('error', data, logger)
  }

  async critical (data: unknown, logger?: string): Promise<void> {
    await this.log('critical', data, logger)
  }

  async alert (data: unknown, logger?: string): Promise<void> {
    await this.log('alert', data, logger)
  }

  async emergency (data: unknown, logger?: string): Promise<void> {
    await this.log('emergency', data, logger)
  }

  /**
   * Determines if a message at the given level should be logged
   * based on the current minimum level setting.
   *
   * Uses RFC 5424 severity hierarchy:
   * debug < info < notice < warning < error < critical < alert < emergency
   *
   * @param level - The log level to check
   * @returns True if the message should be logged
   */
  private shouldLog (level: LogLevel): boolean {
    const messageSeverity = LOG_LEVEL_HIERARCHY[level]
    const minSeverity = LOG_LEVEL_HIERARCHY[this.minLevel]

    return messageSeverity >= minSeverity
  }
}
