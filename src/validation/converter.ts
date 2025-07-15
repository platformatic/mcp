import type { TObject, TSchema, TUnion, TArray, TLiteral } from '@sinclair/typebox'
import { Kind } from '@sinclair/typebox'
import type { PromptArgument } from './schemas.ts'

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
  switch (schema[Kind]) {
    case 'String':
      return generateStringDescription(schema as any)
    case 'Number':
      return generateNumberDescription(schema as any)
    case 'Integer':
      return generateIntegerDescription(schema as any)
    case 'Boolean':
      return 'Boolean value'
    case 'Array':
      return generateArrayDescription(schema as TArray)
    case 'Object':
      return 'Object value'
    case 'Union':
      return generateUnionDescription(schema as TUnion)
    case 'Optional':
      return getSchemaDescription((schema as any).anyOf[1])
    case 'Literal':
      return `Literal value: ${(schema as TLiteral).const}`
    default:
      return `Parameter of type ${schema[Kind] || 'unknown'}`
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
 * Convert TypeBox schema to JSON Schema for MCP tool definition
 */
export function typeBoxToJSONSchema (schema: TSchema): any {
  // TypeBox schemas are already JSON Schema compatible
  // We just need to clean up any TypeBox-specific properties
  return JSON.parse(JSON.stringify(schema))
}

/**
 * Extract enum values from a schema if it's an enum
 */
export function getEnumValues (schema: TSchema): string[] | undefined {
  if ('enum' in schema && Array.isArray(schema.enum)) {
    return schema.enum
  }

  // Check for union of literals (enum-like)
  if (schema[Kind] === 'Union') {
    const union = schema as TUnion
    const literals = union.anyOf.filter(s => s[Kind] === 'Literal')
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
  if (schema[Kind]) {
    if (schema[Kind] !== 'Object') {
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
  if (unsupportedTypes.includes(schema[Kind])) {
    errors.push(`Property '${name}' uses unsupported type: ${schema[Kind]}`)
  }

  // Validate nested objects
  if (schema[Kind] === 'Object') {
    const nestedErrors = validateToolSchema(schema)
    errors.push(...nestedErrors.map(err => `${name}.${err}`))
  }

  // Validate arrays
  if (schema[Kind] === 'Array') {
    const arraySchema = schema as TArray
    const itemErrors = validatePropertySchema(`${name}[]`, arraySchema.items)
    errors.push(...itemErrors)
  }

  return errors
}
