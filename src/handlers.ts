import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type {
  JSONRPCMessage,
  JSONRPCRequest,
  JSONRPCResponse,
  JSONRPCError,
  JSONRPCNotification,
  InitializeResult,
  EmptyResult,
  ListToolsResult,
  ListResourcesResult,
  ListPromptsResult,
  CallToolResult,
  ReadResourceResult,
  GetPromptResult,
  LogLevel,
  CompleteRequest,
  TaskStatusResult,
  ListTasksResult
} from './schema.ts'

import {
  JSONRPC_VERSION,
  LATEST_PROTOCOL_VERSION,
  METHOD_NOT_FOUND,
  INTERNAL_ERROR,
  INVALID_PARAMS
} from './schema.ts'

import type { MCPTool, MCPResource, MCPPrompt, MCPPluginOptions } from './types.ts'
import type { AuthorizationContext } from './types/auth-types.ts'
import { validate, CallToolRequestSchema, ReadResourceRequestSchema, GetPromptRequestSchema, isTypeBoxSchema } from './validation/index.ts'
import { sanitizeToolParams, assessToolSecurity, SECURITY_WARNINGS } from './security.ts'

type HandlerDependencies = {
  app: FastifyInstance
  opts: MCPPluginOptions
  capabilities: any
  serverInfo: any
  tools: Map<string, MCPTool>
  resources: Map<string, MCPResource>
  prompts: Map<string, MCPPrompt>
  request: FastifyRequest
  reply: FastifyReply
  authContext?: AuthorizationContext
}

export function createResponse (id: string | number, result: any): JSONRPCResponse {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    result
  }
}

export function createError (id: string | number, code: number, message: string, data?: any): JSONRPCError {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    error: { code, message, data }
  }
}

function handleInitialize (request: JSONRPCRequest, dependencies: HandlerDependencies): JSONRPCResponse {
  const { opts, capabilities, serverInfo } = dependencies
  const result: InitializeResult = {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities,
    serverInfo,
    instructions: opts.instructions
  }
  return createResponse(request.id, result)
}

function handlePing (request: JSONRPCRequest): JSONRPCResponse {
  const result: EmptyResult = {}
  return createResponse(request.id, result)
}

async function handleSetLogLevel (request: JSONRPCRequest, dependencies: HandlerDependencies): Promise<JSONRPCResponse | JSONRPCError> {
  const { app } = dependencies

  // Validate params
  if (!request.params || typeof request.params !== 'object') {
    return createError(request.id, INVALID_PARAMS, 'Invalid params: expected object with level field')
  }

  const { level } = request.params as { level?: unknown }

  if (typeof level !== 'string') {
    return createError(request.id, INVALID_PARAMS, 'Invalid params: level must be a string')
  }

  const validLevels: LogLevel[] = ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency']
  if (!validLevels.includes(level as LogLevel)) {
    return createError(request.id, INVALID_PARAMS, `Invalid log level: ${level}. Must be one of: ${validLevels.join(', ')}`)
  }

  // Call the decorator method
  await app.mcpSetLogLevel(level as LogLevel)

  const result: EmptyResult = {}
  return createResponse(request.id, result)
}

async function handleComplete (request: JSONRPCRequest, dependencies: HandlerDependencies): Promise<JSONRPCResponse | JSONRPCError> {
  const { app } = dependencies

  // Check if completion service is available
  if (!app.completionService) {
    return createError(request.id, METHOD_NOT_FOUND, 'Completion capability not enabled')
  }

  // Validate params
  if (!request.params || typeof request.params !== 'object') {
    return createError(request.id, INVALID_PARAMS, 'Invalid params: expected completion request parameters')
  }

  const params = request.params as CompleteRequest['params']

  // Validate required fields
  if (!params.ref || !params.argument) {
    return createError(request.id, INVALID_PARAMS, 'Invalid params: missing ref or argument')
  }

  if (!params.ref.type || (params.ref.type !== 'ref/prompt' && params.ref.type !== 'ref/resource')) {
    return createError(request.id, INVALID_PARAMS, 'Invalid params: ref.type must be "ref/prompt" or "ref/resource"')
  }

  if (!params.argument.name || typeof params.argument.value !== 'string') {
    return createError(request.id, INVALID_PARAMS, 'Invalid params: argument must have name and value')
  }

  try {
    const result = await app.completionService.complete(params)
    return createResponse(request.id, result)
  } catch (error) {
    return createError(request.id, INTERNAL_ERROR, 'Completion failed', error)
  }
}

function handleToolsList (request: JSONRPCRequest, dependencies: HandlerDependencies): JSONRPCResponse {
  const { tools } = dependencies
  const result: ListToolsResult = {
    tools: Array.from(tools.values()).map(t => {
      const tool = t.definition
      // TypeBox schemas are already JSON Schema compatible
      if (isTypeBoxSchema(tool.inputSchema)) {
        return {
          ...tool,
          inputSchema: tool.inputSchema
        }
      }
      return tool
    }),
    nextCursor: undefined
  }
  return createResponse(request.id, result)
}

function handleResourcesList (request: JSONRPCRequest, dependencies: HandlerDependencies): JSONRPCResponse {
  const { resources } = dependencies
  const result: ListResourcesResult = {
    resources: Array.from(resources.values()).map(r => r.definition),
    nextCursor: undefined
  }
  return createResponse(request.id, result)
}

function handlePromptsList (request: JSONRPCRequest, dependencies: HandlerDependencies): JSONRPCResponse {
  const { prompts } = dependencies
  const result: ListPromptsResult = {
    prompts: Array.from(prompts.values()).map(p => p.definition),
    nextCursor: undefined
  }
  return createResponse(request.id, result)
}

async function handleToolsCall (
  request: JSONRPCRequest,
  sessionId: string | undefined,
  dependencies: HandlerDependencies
): Promise<JSONRPCResponse | JSONRPCError> {
  const { tools } = dependencies

  // Validate the request parameters structure
  const paramsValidation = validate(CallToolRequestSchema, request.params)
  if (!paramsValidation.success) {
    return createError(request.id, INVALID_PARAMS, 'Invalid tool call parameters', {
      validation: paramsValidation.error
    })
  }

  const params = paramsValidation.data
  const toolName = params.name

  const tool = tools.get(toolName)
  if (!tool) {
    return createError(request.id, METHOD_NOT_FOUND, `Tool '${toolName}' not found`)
  }

  if (!tool.handler) {
    const result: CallToolResult = {
      content: [{
        type: 'text',
        text: `Tool '${toolName}' has no handler implementation`
      }],
      isError: true
    }
    return createResponse(request.id, result)
  }

  // Assess security risks from tool annotations
  const securityAssessment = assessToolSecurity(tool.definition.annotations)

  // Log security warnings for high-risk tools
  if (securityAssessment.riskLevel === 'high') {
    dependencies.app.log.warn({
      tool: toolName,
      sessionId,
      warnings: securityAssessment.warnings
    }, 'High-risk tool execution attempted')
  }

  // Validate and sanitize tool arguments against the tool's input schema
  let toolArguments = params.arguments || {}

  try {
    // Sanitize arguments to prevent injection attacks
    toolArguments = sanitizeToolParams(toolArguments)
  } catch (sanitizeError) {
    dependencies.app.log.warn({
      tool: toolName,
      sessionId,
      error: sanitizeError instanceof Error ? sanitizeError.message : 'Unknown sanitization error'
    }, 'Tool arguments sanitization failed')

    return createError(request.id, INVALID_PARAMS, `${SECURITY_WARNINGS.UNVALIDATED_INPUT}: ${sanitizeError instanceof Error ? sanitizeError.message : 'Sanitization failed'}`)
  }
  if ('inputSchema' in tool.definition) {
    // Check if it's a TypeBox schema
    const schema = tool.definition.inputSchema
    if (isTypeBoxSchema(schema)) {
      // TypeBox schema - use our validation
      const argumentsValidation = validate(schema, toolArguments)
      if (!argumentsValidation.success) {
        const result: CallToolResult = {
          content: [{
            type: 'text',
            text: `Invalid tool arguments: ${argumentsValidation.error.message}`
          }],
          isError: true
        }
        return createResponse(request.id, result)
      }

      // Use validated arguments
      try {
        const result = await tool.handler(argumentsValidation.data, { sessionId, request: dependencies.request, reply: dependencies.reply, authContext: dependencies.authContext })
        return createResponse(request.id, result)
      } catch (error: any) {
        const result: CallToolResult = {
          content: [{
            type: 'text',
            text: `Tool execution failed: ${error.message || error}`
          }],
          isError: true
        }
        return createResponse(request.id, result)
      }
    } else {
      // Regular JSON Schema - basic validation or pass through
      try {
        const result = await tool.handler(toolArguments, { sessionId, request: dependencies.request, reply: dependencies.reply, authContext: dependencies.authContext })
        return createResponse(request.id, result)
      } catch (error: any) {
        const result: CallToolResult = {
          content: [{
            type: 'text',
            text: `Tool execution failed: ${error.message || error}`
          }],
          isError: true
        }
        return createResponse(request.id, result)
      }
    }
  } else {
    // Unsafe tool without schema - pass arguments as-is
    try {
      const result = await tool.handler(toolArguments, {
        sessionId,
        request: dependencies.request,
        reply: dependencies.reply,
        authContext: dependencies.authContext
      })
      return createResponse(request.id, result)
    } catch (error: any) {
      const result: CallToolResult = {
        content: [{
          type: 'text',
          text: `Tool execution failed: ${error.message || error}`
        }],
        isError: true
      }
      return createResponse(request.id, result)
    }
  }
}

async function handleResourcesRead (
  request: JSONRPCRequest,
  sessionId: string | undefined,
  dependencies: HandlerDependencies
): Promise<JSONRPCResponse | JSONRPCError> {
  const { resources } = dependencies

  // Validate the request parameters structure
  const paramsValidation = validate(ReadResourceRequestSchema, request.params)
  if (!paramsValidation.success) {
    return createError(request.id, INVALID_PARAMS, 'Invalid resource read parameters', {
      validation: paramsValidation.error
    })
  }

  const params = paramsValidation.data
  const uri = params.uri

  const resource = resources.get(uri)
  if (!resource) {
    return createError(request.id, METHOD_NOT_FOUND, `Resource '${uri}' not found`)
  }

  if (!resource.handler) {
    const result: ReadResourceResult = {
      contents: [{
        uri,
        text: 'Resource has no handler implementation',
        mimeType: 'text/plain'
      }]
    }
    return createResponse(request.id, result)
  }

  // Validate URI against resource's URI schema if present
  if ('uriSchema' in resource.definition && resource.definition.uriSchema) {
    const schema = resource.definition.uriSchema
    if (isTypeBoxSchema(schema)) {
      // TypeBox schema - use our validation
      const uriValidation = validate(schema, uri)
      if (!uriValidation.success) {
        const result: ReadResourceResult = {
          contents: [{
            uri,
            text: `Invalid resource URI: ${uriValidation.error.message}`,
            mimeType: 'text/plain'
          }]
        }
        return createResponse(request.id, result)
      }
    }
  }

  try {
    const result = await resource.handler(uri, {
      sessionId,
      request: dependencies.request,
      reply: dependencies.reply,
      authContext: dependencies.authContext
    })
    return createResponse(request.id, result)
  } catch (error: any) {
    const result: ReadResourceResult = {
      contents: [{
        uri,
        text: `Resource read failed: ${error.message || error}`,
        mimeType: 'text/plain'
      }]
    }
    return createResponse(request.id, result)
  }
}

async function handlePromptsGet (
  request: JSONRPCRequest,
  sessionId: string | undefined,
  dependencies: HandlerDependencies
): Promise<JSONRPCResponse | JSONRPCError> {
  const { prompts } = dependencies

  // Validate the request parameters structure
  const paramsValidation = validate(GetPromptRequestSchema, request.params)
  if (!paramsValidation.success) {
    return createError(request.id, INVALID_PARAMS, 'Invalid prompt get parameters', {
      validation: paramsValidation.error
    })
  }

  const params = paramsValidation.data
  const promptName = params.name

  const prompt = prompts.get(promptName)
  if (!prompt) {
    return createError(request.id, METHOD_NOT_FOUND, `Prompt '${promptName}' not found`)
  }

  if (!prompt.handler) {
    const result: GetPromptResult = {
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Prompt '${promptName}' has no handler implementation`
        }
      }]
    }
    return createResponse(request.id, result)
  }

  // Validate prompt arguments against the prompt's argument schema
  const promptArguments = params.arguments || {}
  if ('argumentSchema' in prompt.definition && prompt.definition.argumentSchema) {
    // Check if it's a TypeBox schema
    const schema = prompt.definition.argumentSchema
    if (isTypeBoxSchema(schema)) {
      // TypeBox schema - use our validation
      const argumentsValidation = validate(schema, promptArguments)
      if (!argumentsValidation.success) {
        const result: GetPromptResult = {
          messages: [{
            role: 'user',
            content: {
              type: 'text',
              text: `Invalid prompt arguments: ${argumentsValidation.error.message}`
            }
          }]
        }
        return createResponse(request.id, result)
      }

      // Use validated arguments
      try {
        const result = await prompt.handler(promptName, argumentsValidation.data, {
          sessionId,
          request: dependencies.request,
          reply: dependencies.reply,
          authContext: dependencies.authContext
        })
        return createResponse(request.id, result)
      } catch (error: any) {
        const result: GetPromptResult = {
          messages: [{
            role: 'user',
            content: {
              type: 'text',
              text: `Prompt execution failed: ${error.message || error}`
            }
          }]
        }
        return createResponse(request.id, result)
      }
    } else {
      // Regular JSON Schema - basic validation or pass through
      try {
        const result = await prompt.handler(promptName, promptArguments, {
          sessionId,
          request: dependencies.request,
          reply: dependencies.reply,
          authContext: dependencies.authContext
        })
        return createResponse(request.id, result)
      } catch (error: any) {
        const result: GetPromptResult = {
          messages: [{
            role: 'user',
            content: {
              type: 'text',
              text: `Prompt execution failed: ${error.message || error}`
            }
          }]
        }
        return createResponse(request.id, result)
      }
    }
  } else {
    // Unsafe prompt without schema - pass arguments as-is
    try {
      const result = await prompt.handler(promptName, promptArguments, {
        sessionId,
        request: dependencies.request,
        reply: dependencies.reply,
        authContext: dependencies.authContext
      })
      return createResponse(request.id, result)
    } catch (error: any) {
      const result: GetPromptResult = {
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: `Prompt execution failed: ${error.message || error}`
          }
        }]
      }
      return createResponse(request.id, result)
    }
  }
}

async function handleTasksGet (request: JSONRPCRequest, dependencies: HandlerDependencies): Promise<JSONRPCResponse | JSONRPCError> {
  const { app, authContext } = dependencies

  if (!app.taskService) {
    return createError(request.id, METHOD_NOT_FOUND, 'Tasks capability not enabled')
  }

  if (!request.params || typeof request.params !== 'object') {
    return createError(request.id, INVALID_PARAMS, 'Invalid params: expected object with taskId field')
  }

  const { taskId } = request.params as { taskId?: unknown }

  if (typeof taskId !== 'string') {
    return createError(request.id, INVALID_PARAMS, 'Invalid params: taskId must be a string')
  }

  try {
    const task = await app.taskService.getTask(taskId, authContext)
    const result: TaskStatusResult = task
    return createResponse(request.id, result)
  } catch (error) {
    return createError(request.id, INVALID_PARAMS, error instanceof Error ? error.message : 'Failed to get task')
  }
}

async function handleTasksList (request: JSONRPCRequest, dependencies: HandlerDependencies): Promise<JSONRPCResponse | JSONRPCError> {
  const { app, authContext } = dependencies

  if (!app.taskService) {
    return createError(request.id, METHOD_NOT_FOUND, 'Tasks capability not enabled')
  }

  try {
    const tasks = await app.taskService.listTasks(authContext)
    const result: ListTasksResult = { tasks }
    return createResponse(request.id, result)
  } catch (error) {
    return createError(request.id, INTERNAL_ERROR, error instanceof Error ? error.message : 'Failed to list tasks')
  }
}

async function handleTasksCancel (request: JSONRPCRequest, dependencies: HandlerDependencies): Promise<JSONRPCResponse | JSONRPCError> {
  const { app, authContext } = dependencies

  if (!app.taskService) {
    return createError(request.id, METHOD_NOT_FOUND, 'Tasks capability not enabled')
  }

  if (!request.params || typeof request.params !== 'object') {
    return createError(request.id, INVALID_PARAMS, 'Invalid params: expected object with taskId field')
  }

  const { taskId } = request.params as { taskId?: unknown }

  if (typeof taskId !== 'string') {
    return createError(request.id, INVALID_PARAMS, 'Invalid params: taskId must be a string')
  }

  try {
    await app.taskService.cancelTask(taskId, authContext)
    const result: EmptyResult = {}
    return createResponse(request.id, result)
  } catch (error) {
    return createError(request.id, INVALID_PARAMS, error instanceof Error ? error.message : 'Failed to cancel task')
  }
}

export async function handleRequest (
  request: JSONRPCRequest,
  sessionId: string | undefined,
  dependencies: HandlerDependencies
): Promise<JSONRPCResponse | JSONRPCError> {
  const { app } = dependencies

  app.log.info({
    method: request.method,
    id: request.id,
    sessionId
  }, `JSON-RPC method invoked: ${request.method}`)

  try {
    switch (request.method) {
      case 'initialize':
        return handleInitialize(request, dependencies)
      case 'ping':
        return handlePing(request)
      case 'logging/setLevel':
        return await handleSetLogLevel(request, dependencies)
      case 'completion/complete':
        return await handleComplete(request, dependencies)
      case 'tools/list':
        return handleToolsList(request, dependencies)
      case 'resources/list':
        return handleResourcesList(request, dependencies)
      case 'prompts/list':
        return handlePromptsList(request, dependencies)
      case 'tools/call':
        return await handleToolsCall(request, sessionId, dependencies)
      case 'resources/read':
        return await handleResourcesRead(request, sessionId, dependencies)
      case 'prompts/get':
        return await handlePromptsGet(request, sessionId, dependencies)
      case 'tasks/get':
        return await handleTasksGet(request, dependencies)
      case 'tasks/list':
        return await handleTasksList(request, dependencies)
      case 'tasks/cancel':
        return await handleTasksCancel(request, dependencies)
      default:
        return createError(request.id, METHOD_NOT_FOUND, `Method ${request.method} not found`)
    }
  } catch (error) {
    return createError(request.id, INTERNAL_ERROR, 'Internal server error', error)
  }
}

export function handleNotification (notification: JSONRPCNotification, app: FastifyInstance): void {
  switch (notification.method) {
    case 'notifications/initialized':
      app.log.info('MCP client initialized')
      break
    case 'notifications/cancelled':
      app.log.info('Request cancelled', notification.params)
      break
    default:
      app.log.warn(`Unknown notification: ${notification.method}`)
  }
}

export async function processMessage (
  message: JSONRPCMessage,
  sessionId: string | undefined,
  dependencies: HandlerDependencies
): Promise<JSONRPCResponse | JSONRPCError | null> {
  if ('id' in message && 'method' in message) {
    return await handleRequest(message as JSONRPCRequest, sessionId, dependencies)
  } else if ('method' in message) {
    handleNotification(message as JSONRPCNotification, dependencies.app)
    return null
  } else {
    throw new Error('Invalid JSON-RPC message')
  }
}
