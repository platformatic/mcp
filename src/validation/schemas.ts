import { Type } from '@sinclair/typebox'
import type { Static } from '@sinclair/typebox'

// Core TypeBox schemas for MCP protocol validation

// Error response schema
export const ValidationErrorSchema = Type.Object({
  code: Type.Literal('VALIDATION_ERROR'),
  message: Type.String(),
  errors: Type.Array(Type.Object({
    path: Type.String(),
    message: Type.String(),
    expected: Type.String(),
    received: Type.Unknown()
  }))
})

export type ValidationError = Static<typeof ValidationErrorSchema>

// JSON-RPC validation schemas
export const RequestIdSchema = Type.Union([Type.String(), Type.Number()])

export const JSONRPCRequestSchema = Type.Object({
  jsonrpc: Type.Literal('2.0'),
  id: RequestIdSchema,
  method: Type.String(),
  params: Type.Optional(Type.Record(Type.String(), Type.Unknown()))
})

// MCP protocol schemas
export const ProgressTokenSchema = Type.Union([Type.String(), Type.Number()])

export const CursorSchema = Type.String()

export const AnnotationsSchema = Type.Object({
  audience: Type.Optional(Type.Array(Type.Union([Type.Literal('user'), Type.Literal('assistant')]))),
  priority: Type.Optional(Type.Number({ minimum: 0, maximum: 1 }))
})

// Content schemas
export const TextContentSchema = Type.Object({
  type: Type.Literal('text'),
  text: Type.String(),
  annotations: Type.Optional(AnnotationsSchema)
})

export const ImageContentSchema = Type.Object({
  type: Type.Literal('image'),
  data: Type.String({ format: 'byte' }),
  mimeType: Type.String(),
  annotations: Type.Optional(AnnotationsSchema)
})

export const AudioContentSchema = Type.Object({
  type: Type.Literal('audio'),
  data: Type.String({ format: 'byte' }),
  mimeType: Type.String(),
  annotations: Type.Optional(AnnotationsSchema)
})

export const ContentSchema = Type.Union([
  TextContentSchema,
  ImageContentSchema,
  AudioContentSchema
])

// Tool schemas
export const ToolDefinitionSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  description: Type.Optional(Type.String()),
  inputSchema: Type.Object({
    type: Type.Literal('object'),
    properties: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    required: Type.Optional(Type.Array(Type.String()))
  }),
  annotations: Type.Optional(Type.Object({
    title: Type.Optional(Type.String()),
    readOnlyHint: Type.Optional(Type.Boolean()),
    destructiveHint: Type.Optional(Type.Boolean()),
    idempotentHint: Type.Optional(Type.Boolean()),
    openWorldHint: Type.Optional(Type.Boolean())
  }))
})

export const CallToolRequestSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown()))
})

export const CallToolResultSchema = Type.Object({
  content: Type.Array(ContentSchema),
  isError: Type.Optional(Type.Boolean()),
  _meta: Type.Optional(Type.Record(Type.String(), Type.Unknown()))
})

// Resource schemas
export const ResourceDefinitionSchema = Type.Object({
  uri: Type.String({ format: 'uri' }),
  name: Type.String({ minLength: 1 }),
  description: Type.Optional(Type.String()),
  mimeType: Type.Optional(Type.String()),
  annotations: Type.Optional(AnnotationsSchema),
  size: Type.Optional(Type.Number({ minimum: 0 }))
})

export const ResourceContentsSchema = Type.Object({
  uri: Type.String({ format: 'uri' }),
  mimeType: Type.Optional(Type.String())
})

export const TextResourceContentsSchema = Type.Intersect([
  ResourceContentsSchema,
  Type.Object({
    text: Type.String()
  })
])

export const BlobResourceContentsSchema = Type.Intersect([
  ResourceContentsSchema,
  Type.Object({
    blob: Type.String({ format: 'byte' })
  })
])

export const ReadResourceResultSchema = Type.Object({
  contents: Type.Array(Type.Union([
    TextResourceContentsSchema,
    BlobResourceContentsSchema
  ])),
  _meta: Type.Optional(Type.Record(Type.String(), Type.Unknown()))
})

// Prompt schemas
export const PromptArgumentSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  description: Type.Optional(Type.String()),
  required: Type.Optional(Type.Boolean())
})

export const PromptDefinitionSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  description: Type.Optional(Type.String()),
  arguments: Type.Optional(Type.Array(PromptArgumentSchema))
})

export const PromptMessageSchema = Type.Object({
  role: Type.Union([Type.Literal('user'), Type.Literal('assistant')]),
  content: ContentSchema
})

export const GetPromptResultSchema = Type.Object({
  description: Type.Optional(Type.String()),
  messages: Type.Array(PromptMessageSchema),
  _meta: Type.Optional(Type.Record(Type.String(), Type.Unknown()))
})

// Export type utilities
export type RequestId = Static<typeof RequestIdSchema>
export type ProgressToken = Static<typeof ProgressTokenSchema>
export type Cursor = Static<typeof CursorSchema>
export type Annotations = Static<typeof AnnotationsSchema>
export type TextContent = Static<typeof TextContentSchema>
export type ImageContent = Static<typeof ImageContentSchema>
export type AudioContent = Static<typeof AudioContentSchema>
export type Content = Static<typeof ContentSchema>
export type ToolDefinition = Static<typeof ToolDefinitionSchema>
export type CallToolRequest = Static<typeof CallToolRequestSchema>
export type CallToolResult = Static<typeof CallToolResultSchema>
export type ResourceDefinition = Static<typeof ResourceDefinitionSchema>
export type TextResourceContents = Static<typeof TextResourceContentsSchema>
export type BlobResourceContents = Static<typeof BlobResourceContentsSchema>
export type ReadResourceResult = Static<typeof ReadResourceResultSchema>
export type PromptArgument = Static<typeof PromptArgumentSchema>
export type PromptDefinition = Static<typeof PromptDefinitionSchema>
export type PromptMessage = Static<typeof PromptMessageSchema>
export type GetPromptResult = Static<typeof GetPromptResultSchema>