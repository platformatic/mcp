import type { Static, TSchema, TObject } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { TypeCompiler } from '@sinclair/typebox/compiler'
import type { ValidationError } from './schemas.ts'

// Compiled validator cache
const compiledValidators = new Map<string, ReturnType<typeof TypeCompiler.Compile>>()

/**
 * Get a compiled validator for a schema, with caching
 */
function getValidator<T extends TSchema>(schema: T): ReturnType<typeof TypeCompiler.Compile> {
  const key = JSON.stringify(schema)
  if (!compiledValidators.has(key)) {
    compiledValidators.set(key, TypeCompiler.Compile(schema))
  }
  return compiledValidators.get(key)!
}

/**
 * Validation result type
 */
export type ValidationResult<T> = {
  success: true
  data: T
} | {
  success: false
  error: ValidationError
}

/**
 * Validate data against a TypeBox schema
 */
export function validate<T extends TSchema>(
  schema: T,
  data: unknown
): ValidationResult<Static<T>> {
  const validator = getValidator(schema)
  
  if (validator.Check(data)) {
    return {
      success: true,
      data: data as Static<T>
    }
  }

  // Collect validation errors
  const errors = Array.from(validator.Errors(data)).map(error => ({
    path: error.path,
    message: error.message,
    expected: error.schema?.type?.toString() || 'unknown',
    received: error.value
  }))

  const validationError: ValidationError = {
    code: 'VALIDATION_ERROR',
    message: `Validation failed with ${errors.length} error(s)`,
    errors
  }

  return {
    success: false,
    error: validationError
  }
}

/**
 * Validate data against a TypeBox schema (throws on error)
 */
export function validateOrThrow<T extends TSchema>(
  schema: T,
  data: unknown
): Static<T> {
  const result = validate(schema, data)
  if (!result.success) {
    throw new Error(result.error.message)
  }
  return result.data
}

/**
 * Check if data matches a schema without detailed error information
 */
export function check<T extends TSchema>(
  schema: T,
  data: unknown
): data is Static<T> {
  const validator = getValidator(schema)
  return validator.Check(data)
}

/**
 * Transform data to match a schema (with defaults, etc.)
 */
export function transform<T extends TSchema>(
  schema: T,
  data: unknown
): Static<T> {
  // Apply defaults and transformations
  const transformed = Value.Default(schema, data)
  
  // Validate the transformed data
  return validateOrThrow(schema, transformed)
}

/**
 * Create a validation error response
 */
export function createValidationError(
  message: string,
  errors: ValidationError['errors']
): ValidationError {
  return {
    code: 'VALIDATION_ERROR',
    message,
    errors
  }
}

/**
 * Convert TypeBox validation errors to a user-friendly format
 */
export function formatValidationErrors(errors: ValidationError['errors']): string {
  return errors.map(error => 
    `${error.path}: ${error.message} (expected ${error.expected}, got ${typeof error.received})`
  ).join('; ')
}

/**
 * Schema validation decorator for async functions
 */
export function validateSchema<TParams extends TObject, TResult extends TSchema>(
  paramsSchema: TParams,
  resultSchema?: TResult
) {
  return function <T extends (...args: any[]) => Promise<any>>(
    _target: any,
    _propertyKey: string,
    descriptor: TypedPropertyDescriptor<T>
  ) {
    const originalMethod = descriptor.value!
    
    descriptor.value = async function (this: any, params: unknown, ...args: any[]) {
      // Validate input parameters
      const paramResult = validate(paramsSchema, params)
      if (!paramResult.success) {
        throw new Error(formatValidationErrors(paramResult.error.errors))
      }

      // Call original method with validated parameters
      const result = await originalMethod.call(this, paramResult.data, ...args)

      // Validate result if schema provided
      if (resultSchema) {
        const resultValidation = validate(resultSchema, result)
        if (!resultValidation.success) {
          throw new Error(`Result validation failed: ${formatValidationErrors(resultValidation.error.errors)}`)
        }
        return resultValidation.data
      }

      return result
    } as any
    
    return descriptor
  }
}

/**
 * Utility to get schema hash for caching
 */
export function getSchemaHash(schema: TSchema): string {
  return JSON.stringify(schema)
}