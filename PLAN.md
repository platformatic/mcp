# TypeBox Integration Plan for Fastify MCP

## Overview

This plan outlines the implementation of type safety and data validation using TypeBox in the Fastify MCP adapter. The goal is to ensure robust validation of tool calls and resource operations while maintaining full TypeScript type safety with automatic schema-driven argument inference.

## Current State Analysis

### Existing Structure
- **Schema definitions**: Complete MCP protocol types in `src/schema.ts`
- **Handler implementations**: Basic parameter validation in `src/handlers.ts`
- **Type definitions**: Tool, resource, and prompt interfaces in `src/types.ts`
- **Current validation**: Minimal runtime validation (mainly null/undefined checks)

### Validation Gaps
1. **Tool parameters**: No validation of tool call arguments against schemas
2. **Resource URIs**: No format validation for resource URIs
3. **Prompt arguments**: No validation of prompt template arguments
4. **Input sanitization**: No data sanitization for untrusted inputs
5. **Error handling**: Limited structured error responses for validation failures

## TypeScript Generic Strategy

### Schema-Driven Type Inference

The core principle is to derive all TypeScript types from TypeBox schemas, eliminating duplication between argument definitions and their schemas. This is achieved through TypeBox's `Static<T>` type utility and strategic use of TypeScript generics.

#### Generic Tool Definition
```typescript
// Base generic tool interface
export interface MCPTool<TSchema extends TObject = TObject> {
  definition: Tool & {
    inputSchema: TSchema
  }
  handler?: ToolHandler<TSchema>
}

// Handler type with automatic parameter inference
export type ToolHandler<TSchema extends TObject> = (
  params: Static<TSchema>,
  context?: { sessionId?: string }
) => Promise<CallToolResult> | CallToolResult

// Registration API with full type inference
declare module 'fastify' {
  interface FastifyInstance {
    mcpAddTool<TSchema extends TObject>(
      definition: Omit<Tool, 'inputSchema'> & { inputSchema: TSchema },
      handler?: ToolHandler<TSchema>
    ): void
  }
}
```

#### Usage Example
```typescript
// Schema defines both validation and types
const SearchToolSchema = Type.Object({
  query: Type.String({ minLength: 1 }),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
  filters: Type.Optional(Type.Array(Type.String()))
})

// Handler automatically receives typed parameters
app.mcpAddTool({
  name: 'search',
  description: 'Search for files',
  inputSchema: SearchToolSchema  // Schema drives both validation and types
}, async (params) => {
  // params is automatically typed as:
  // {
  //   query: string;
  //   limit?: number;
  //   filters?: string[];
  // }
  return { content: [{ type: 'text', text: `Found ${params.query}` }] }
})
```

#### Generic Resource Definition
```typescript
// Generic resource interface
export interface MCPResource<TUriSchema extends TSchema = TString> {
  definition: Resource & {
    uriSchema?: TUriSchema
  }
  handler?: ResourceHandler<TUriSchema>
}

// Handler with URI validation
export type ResourceHandler<TUriSchema extends TSchema = TString> = (
  uri: Static<TUriSchema>
) => Promise<ReadResourceResult> | ReadResourceResult

// Registration with URI schema
declare module 'fastify' {
  interface FastifyInstance {
    mcpAddResource<TUriSchema extends TSchema = TString>(
      definition: Omit<Resource, 'uri'> & { 
        uriPattern: string,
        uriSchema?: TUriSchema 
      },
      handler?: ResourceHandler<TUriSchema>
    ): void
  }
}
```

#### Generic Prompt Definition
```typescript
// Generic prompt interface
export interface MCPPrompt<TArgsSchema extends TObject = TObject> {
  definition: Prompt & {
    argumentSchema?: TArgsSchema
  }
  handler?: PromptHandler<TArgsSchema>
}

// Handler with typed arguments
export type PromptHandler<TArgsSchema extends TObject = TObject> = (
  name: string,
  args: Static<TArgsSchema>
) => Promise<GetPromptResult> | GetPromptResult

// Registration with argument schema
declare module 'fastify' {
  interface FastifyInstance {
    mcpAddPrompt<TArgsSchema extends TObject = TObject>(
      definition: Omit<Prompt, 'arguments'> & { 
        argumentSchema?: TArgsSchema 
      },
      handler?: PromptHandler<TArgsSchema>
    ): void
  }
}
```

### Automatic Argument Inference

The system automatically derives `arguments` array from the schema, eliminating manual duplication:

```typescript
// Internal utility to convert schema to arguments
function schemaToArguments<T extends TObject>(schema: T): PromptArgument[] {
  const properties = schema.properties || {}
  const required = schema.required || []
  
  return Object.entries(properties).map(([name, propSchema]) => ({
    name,
    description: propSchema.description || `Parameter ${name}`,
    required: required.includes(name)
  }))
}

// Applied during registration
app.mcpAddPrompt({
  name: 'code-review',
  description: 'Generate code review',
  argumentSchema: Type.Object({
    language: Type.String({ 
      enum: ['javascript', 'typescript', 'python'],
      description: 'Programming language'
    }),
    complexity: Type.Optional(Type.String({ 
      enum: ['low', 'medium', 'high'],
      description: 'Code complexity level'
    }))
  })
  // arguments array is automatically generated from schema
}, async (name, args) => {
  // args is typed as: { language: 'javascript' | 'typescript' | 'python', complexity?: 'low' | 'medium' | 'high' }
  return { messages: [{ role: 'user', content: { type: 'text', text: `Review ${args.language} code` } }] }
})
```

## Implementation Plan

### Phase 1: TypeBox Foundation

#### 1.1 Dependency Management
- **Add TypeBox dependency**: `npm install @sinclair/typebox`
- **Add validation utilities**: Use `@sinclair/typebox/value` for runtime validation
- **Update TypeScript configuration**: Ensure compatibility with TypeBox types

#### 1.2 Schema Infrastructure
- **Create new file**: `src/validation/schemas.ts`
  - Define core TypeBox schemas for MCP protocol types
  - Create reusable validation utilities
  - Define error response schemas
- **Create validation utilities**: `src/validation/validator.ts`
  - Implement TypeBox value validation wrapper
  - Create structured error response generators
  - Add schema compilation for performance

#### 1.3 Type System Enhancement
- **Update `src/types.ts`**: Add generic interfaces for tools, resources, and prompts
- **Schema-to-arguments converter**: Utility to generate argument arrays from schemas
- **Validation error types**: TypeBox schemas for validation errors

### Phase 2: Tool Validation

#### 2.1 Generic Tool Implementation
- **Enhanced tool interface**: `MCPTool<TSchema>` with automatic type inference
- **Schema registration**: Update `mcpAddTool` to accept TypeBox schema
- **Handler type safety**: Handlers receive `Static<TSchema>` parameters
- **Schema compilation**: Pre-compile schemas for performance

#### 2.2 Tool Call Validation
- **Update `handleToolsCall`**: Add input validation before handler execution
- **Parameter validation**: Validate tool arguments against registered schema
- **Error responses**: Return structured validation errors with field-level details
- **Type-safe handler execution**: Pass validated, typed parameters to handlers

### Phase 3: Resource Validation

#### 3.1 Generic Resource Implementation
- **Enhanced resource interface**: `MCPResource<TUriSchema>` with URI validation
- **URI schema support**: Allow custom URI validation patterns
- **Pattern matching**: Support URI templates with validation
- **Handler enhancement**: Type-safe URI handling

#### 3.2 Resource Handler Updates
- **Update `handleResourcesRead`**: Add URI validation against schema
- **Content validation**: Validate resource content structure
- **Error handling**: Structured errors for invalid URIs or content

### Phase 4: Prompt Validation

#### 4.1 Generic Prompt Implementation
- **Enhanced prompt interface**: `MCPPrompt<TArgsSchema>` with argument validation
- **Automatic argument derivation**: Generate `arguments` array from schema
- **Template validation**: Validate prompt template structure
- **Handler enhancement**: Type-safe argument handling

#### 4.2 Prompt Handler Updates
- **Update `handlePromptsGet`**: Add argument validation against schema
- **Argument conversion**: Convert and validate string arguments to typed objects
- **Response validation**: Ensure valid message structure

### Phase 5: Enhanced Error Handling

#### 5.1 Structured Error System
- **Validation error schema**: TypeBox schema for validation errors
- **Field-level errors**: Detailed error information per field
- **Error aggregation**: Collect multiple validation errors
- **Client-friendly formatting**: Actionable error messages

#### 5.2 Error Response Enhancement
```typescript
const ValidationErrorSchema = Type.Object({
  code: Type.Literal('VALIDATION_ERROR'),
  message: Type.String(),
  errors: Type.Array(Type.Object({
    path: Type.String(),
    message: Type.String(),
    expected: Type.String(),
    received: Type.Unknown()
  }))
})

type ValidationError = Static<typeof ValidationErrorSchema>
```

### Phase 6: Performance Optimization

#### 6.1 Schema Compilation
- **Pre-compile schemas**: Use TypeBox compilation for performance
- **Validator caching**: Cache compiled validators by schema hash
- **Lazy compilation**: Compile schemas on first use
- **Performance monitoring**: Track validation performance

### Phase 7: Testing & Documentation

#### 7.1 Test Suite Enhancement
- **Type safety tests**: Ensure correct type inference
- **Validation tests**: Test all schema validation scenarios
- **Error handling tests**: Test error response formatting
- **Performance tests**: Benchmark validation performance
- **Integration tests**: Test complete validation workflow

#### 7.2 Documentation Updates
- **API documentation**: Document new validation features
- **Schema examples**: Provide common schema patterns
- **Migration guide**: Guide for updating existing code
- **Best practices**: Validation best practices guide

## File Structure Changes

```
src/
├── validation/
│   ├── schemas.ts              # Core TypeBox schemas
│   ├── validator.ts            # Validation utilities
│   ├── errors.ts               # Error response schemas
│   ├── compiler.ts             # Schema compilation utilities
│   └── index.ts                # Public validation API
├── handlers.ts                 # Updated with validation
├── types.ts                    # Enhanced with generic types
├── schema.ts                   # Original MCP protocol types
└── index.ts                    # Plugin entry point
```

## Breaking Changes & Migration

### API Changes
1. **Tool registration**: `inputSchema` now expects TypeBox schema, automatic argument inference
2. **Resource registration**: Enhanced with URI validation schemas
3. **Prompt registration**: Arguments auto-generated from schema, no manual duplication
4. **Handler signatures**: Parameters are now fully typed based on schemas

### Migration Strategy
1. **Gradual migration**: Allow mixed schema types during migration period
2. **Type-safe refactoring**: Leverage TypeScript compiler to guide migration
3. **Schema conversion utilities**: Tools to convert existing patterns to TypeBox
4. **Backward compatibility**: Maintain support for basic usage during transition

## Benefits

### Type Safety
- **Schema-driven types**: Single source of truth for validation and types
- **Automatic inference**: No manual type duplication
- **Compile-time validation**: TypeScript catches type errors before runtime
- **Handler type safety**: Handlers receive fully typed, validated parameters

### Developer Experience
- **No duplication**: Schema defines both validation and types
- **IntelliSense support**: Full autocomplete for validated parameters
- **Error prevention**: Invalid schemas caught at compile time
- **Self-documenting**: Schemas serve as documentation

### Runtime Validation
- **Input sanitization**: All inputs validated against schemas
- **Performance**: Compiled validation for speed
- **Structured errors**: Detailed validation error information
- **Security**: Type-safe parameter handling prevents injection attacks

## Success Metrics

1. **Type safety**: 100% typed tool/resource/prompt handlers with zero duplication
2. **Validation coverage**: All MCP protocol inputs validated against schemas
3. **Performance**: < 1ms validation overhead for typical requests
4. **Error quality**: Structured, field-level error responses
5. **Developer experience**: Improved IDE support and automatic type inference

## Risks & Mitigation

### Risks
1. **Complex generics**: TypeScript generic complexity may confuse developers
2. **Performance impact**: Validation overhead on each request
3. **Breaking changes**: Existing code requires updates
4. **Learning curve**: Developers need to learn TypeBox patterns

### Mitigation
1. **Clear documentation**: Comprehensive guides and examples for generic usage
2. **Performance testing**: Benchmark and optimize validation performance
3. **Gradual migration**: Maintain backward compatibility during transition
4. **Training materials**: Provide TypeBox learning resources and best practices

## Conclusion

This plan provides a comprehensive approach to adding type safety and data validation using TypeBox with automatic type inference. The key innovation is eliminating duplication between argument definitions and schemas through strategic use of TypeScript generics and TypeBox's `Static<T>` utility.

The implementation ensures that schemas serve as the single source of truth for both validation and TypeScript types, providing excellent developer experience while maintaining runtime safety and performance.