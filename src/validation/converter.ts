import type { TObject, TSchema, TUnion, TArray, TLiteral } from '@sinclair/typebox'
import type { PromptArgument } from './schemas.ts'
import { isTypeBoxSchema } from './validator.ts'

/**
 * Convert a TypeBox schema to MCP prompt arguments array
 */
export function schemaToArguments (schema: TObject): PromptArgument[] {
  const properties = schema.properties || {}
  const required = schema.required || []

  return Object.entries(properties).map(([name, propSchema]) => ({
    name,
    description: getSchemaDescription(propSchema),
    required: required.includes(name)
  }))
}

/**
 * Extract description from a TypeBox schema
 */
function getSchemaDescription (schema: TSchema): string {
  // Check for explicit description
  if ('description' in schema && typeof schema.description === 'string') {
    return schema.description
  }

  // Generate description based on schema type
  // Check for literal first (has const property)
  if ('const' in schema) {
    return `Literal value: ${(schema as TLiteral).const}`
  }

  // Check for union (has anyOf property)
  if ('anyOf' in schema && Array.isArray(schema.anyOf)) {
    return generateUnionDescription(schema as TUnion)
  }

  // Use standard JSON Schema type property
  switch (schema.type) {
    case 'string':
      return generateStringDescription(schema as any)
    case 'number':
      return generateNumberDescription(schema as any)
    case 'integer':
      return generateIntegerDescription(schema as any)
    case 'boolean':
      return 'Boolean value'
    case 'array':
      return generateArrayDescription(schema as TArray)
    case 'object':
      return 'Object value'
    default:
      return `Parameter of type ${schema.type || 'unknown'}`
  }
}

/**
 * Generate description for string schema
 */
function generateStringDescription (schema: any): string {
  const parts = ['String']

  if (schema.enum) {
    parts.push(`(one of: ${schema.enum.join(', ')})`)
  } else {
    const constraints = []
    if (schema.minLength !== undefined) {
      constraints.push(`min length: ${schema.minLength}`)
    }
    if (schema.maxLength !== undefined) {
      constraints.push(`max length: ${schema.maxLength}`)
    }
    if (schema.pattern) {
      constraints.push(`pattern: ${schema.pattern}`)
    }
    if (schema.format) {
      constraints.push(`format: ${schema.format}`)
    }

    if (constraints.length > 0) {
      parts.push(`(${constraints.join(', ')})`)
    }
  }

  return parts.join(' ')
}

/**
 * Generate description for number schema
 */
function generateNumberDescription (schema: any): string {
  const parts = ['Number']
  const constraints = []

  if (schema.minimum !== undefined) {
    constraints.push(`min: ${schema.minimum}`)
  }
  if (schema.maximum !== undefined) {
    constraints.push(`max: ${schema.maximum}`)
  }
  if (schema.exclusiveMinimum !== undefined) {
    constraints.push(`exclusive min: ${schema.exclusiveMinimum}`)
  }
  if (schema.exclusiveMaximum !== undefined) {
    constraints.push(`exclusive max: ${schema.exclusiveMaximum}`)
  }
  if (schema.multipleOf !== undefined) {
    constraints.push(`multiple of: ${schema.multipleOf}`)
  }

  if (constraints.length > 0) {
    parts.push(`(${constraints.join(', ')})`)
  }

  return parts.join(' ')
}

/**
 * Generate description for integer schema
 */
function generateIntegerDescription (schema: any): string {
  const parts = ['Integer']
  const constraints = []

  if (schema.minimum !== undefined) {
    constraints.push(`min: ${schema.minimum}`)
  }
  if (schema.maximum !== undefined) {
    constraints.push(`max: ${schema.maximum}`)
  }
  if (schema.exclusiveMinimum !== undefined) {
    constraints.push(`exclusive min: ${schema.exclusiveMinimum}`)
  }
  if (schema.exclusiveMaximum !== undefined) {
    constraints.push(`exclusive max: ${schema.exclusiveMaximum}`)
  }
  if (schema.multipleOf !== undefined) {
    constraints.push(`multiple of: ${schema.multipleOf}`)
  }

  if (constraints.length > 0) {
    parts.push(`(${constraints.join(', ')})`)
  }

  return parts.join(' ')
}

/**
 * Generate description for array schema
 */
function generateArrayDescription (schema: TArray): string {
  const itemType = getSchemaDescription(schema.items)
  const parts = [`Array of ${itemType}`]

  const constraints = []
  if (schema.minItems !== undefined) {
    constraints.push(`min items: ${schema.minItems}`)
  }
  if (schema.maxItems !== undefined) {
    constraints.push(`max items: ${schema.maxItems}`)
  }
  if (schema.uniqueItems) {
    constraints.push('unique items')
  }

  if (constraints.length > 0) {
    parts.push(`(${constraints.join(', ')})`)
  }

  return parts.join(' ')
}

/**
 * Generate description for union schema
 */
function generateUnionDescription (schema: TUnion): string {
  const types = schema.anyOf.map(s => getSchemaDescription(s))
  return `One of: ${types.join(' | ')}`
}

/**
 * Extract enum values from a schema if it's an enum
 */
export function getEnumValues (schema: TSchema): string[] | undefined {
  if ('enum' in schema && Array.isArray(schema.enum)) {
    return schema.enum
  }

  // Check for union of literals (enum-like)
  if ('anyOf' in schema && Array.isArray(schema.anyOf)) {
    const union = schema as TUnion
    const literals = union.anyOf.filter(s => 'const' in s)
    if (literals.length === union.anyOf.length) {
      return literals.map(l => (l as TLiteral).const as string)
    }
  }

  return undefined
}

/**
 * Check if a property is optional in an object schema
 */
export function isOptionalProperty (objectSchema: TObject, propertyName: string): boolean {
  const required = objectSchema.required || []
  return !required.includes(propertyName)
}

/**
 * Get the inner schema from an optional schema
 */
export function getInnerSchema (schema: any): TSchema {
  return schema.anyOf[1]
}

/**
 * Validate that a schema is suitable for MCP tool parameters
 */
export function validateToolSchema (schema: any): string[] {
  const errors: string[] = []

  // Handle TypeBox schemas
  if (isTypeBoxSchema(schema)) {
    if (schema.type !== 'object') {
      errors.push('Tool parameter schema must be an object')
      return errors
    }

    const objectSchema = schema as TObject
    const properties = objectSchema.properties || {}

    // Check each property
    for (const [name, propSchema] of Object.entries(properties)) {
      const propertyErrors = validatePropertySchema(name, propSchema)
      errors.push(...propertyErrors)
    }
  } else if (typeof schema === 'object' && schema !== null) {
    // Handle regular JSON Schema objects
    if (schema.type !== 'object') {
      errors.push('Tool parameter schema must be an object')
      return errors
    }

    const properties = schema.properties || {}

    // Basic validation for JSON Schema properties
    for (const [name, propSchema] of Object.entries(properties)) {
      if (typeof propSchema !== 'object' || propSchema === null) {
        errors.push(`Property '${name}' must be an object`)
      }
    }
  } else {
    errors.push('Tool parameter schema must be an object')
  }

  return errors
}

/**
 * Validate a single property schema
 */
function validatePropertySchema (name: string, schema: TSchema): string[] {
  const errors: string[] = []

  // Check for unsupported types
  const unsupportedTypes = ['Function', 'Symbol', 'Undefined', 'Null', 'Void']
  if (schema.type && unsupportedTypes.includes(schema.type)) {
    errors.push(`Property '${name}' uses unsupported type: ${schema.type}`)
  }

  // Validate nested objects
  if (schema.type === 'object') {
    const nestedErrors = validateToolSchema(schema)
    errors.push(...nestedErrors.map(err => `${name}.${err}`))
  }

  // Validate arrays
  if (schema.type === 'array') {
    const arraySchema = schema as TArray
    const itemErrors = validatePropertySchema(`${name}[]`, arraySchema.items)
    errors.push(...itemErrors)
  }

  return errors
}
