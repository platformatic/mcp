import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import { LoggingService } from '../features/logging.ts'
import type { MessageBroker } from '../brokers/message-broker.ts'
import type { LogLevel } from '../schema.ts'

interface MCPLoggingDecoratorsOptions {
  enableLogging: boolean
  messageBroker: MessageBroker
}

const mcpLoggingDecoratorsPlugin: FastifyPluginAsync<MCPLoggingDecoratorsOptions> = async (app, options) => {
  const { enableLogging, messageBroker } = options

  if (!enableLogging) {
    // If logging is disabled, provide no-op decorators
    app.decorate('mcpLog', {
      debug: async () => {},
      info: async () => {},
      notice: async () => {},
      warning: async () => {},
      error: async () => {},
      critical: async () => {},
      alert: async () => {},
      emergency: async () => {}
    })

    app.decorate('mcpSetLogLevel', async () => {})
    app.decorate('mcpGetLogLevel', () => 'info' as LogLevel)

    return
  }

  const loggingService = new LoggingService(messageBroker)

  // Decorate Fastify instance with logging methods
  app.decorate('mcpLog', {
    debug: async (data: unknown, logger?: string) => {
      await loggingService.debug(data, logger)
    },
    info: async (data: unknown, logger?: string) => {
      await loggingService.info(data, logger)
    },
    notice: async (data: unknown, logger?: string) => {
      await loggingService.notice(data, logger)
    },
    warning: async (data: unknown, logger?: string) => {
      await loggingService.warning(data, logger)
    },
    error: async (data: unknown, logger?: string) => {
      await loggingService.error(data, logger)
    },
    critical: async (data: unknown, logger?: string) => {
      await loggingService.critical(data, logger)
    },
    alert: async (data: unknown, logger?: string) => {
      await loggingService.alert(data, logger)
    },
    emergency: async (data: unknown, logger?: string) => {
      await loggingService.emergency(data, logger)
    }
  })

  app.decorate('mcpSetLogLevel', async (level: LogLevel) => {
    await loggingService.setLevel(level)
  })

  app.decorate('mcpGetLogLevel', () => {
    return loggingService.getLevel()
  })

  // Store logging service for use in handlers
  app.decorate('loggingService', loggingService)
}

// Type declarations for Fastify
declare module 'fastify' {
  interface FastifyInstance {
    mcpLog: {
      debug: (data: unknown, logger?: string) => Promise<void>
      info: (data: unknown, logger?: string) => Promise<void>
      notice: (data: unknown, logger?: string) => Promise<void>
      warning: (data: unknown, logger?: string) => Promise<void>
      error: (data: unknown, logger?: string) => Promise<void>
      critical: (data: unknown, logger?: string) => Promise<void>
      alert: (data: unknown, logger?: string) => Promise<void>
      emergency: (data: unknown, logger?: string) => Promise<void>
    }
    mcpSetLogLevel: (level: LogLevel) => Promise<void>
    mcpGetLogLevel: () => LogLevel
    loggingService?: LoggingService
  }
}

export default fp(mcpLoggingDecoratorsPlugin, {
  name: 'mcp-logging-decorators'
})
