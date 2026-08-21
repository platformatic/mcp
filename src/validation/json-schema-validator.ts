import type { Options } from 'ajv'
import { Ajv2020 } from 'ajv/dist/2020.js'
import type { ErrorObject } from 'ajv/dist/2020.js'
import stringify from 'safe-stable-stringify'

function formatJsonSchemaErrors (errors: ErrorObject[]): string {
  return errors
    .map(error => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`)
    .join('; ')
}

export type JsonSchemaValidator = ReturnType<typeof createJsonSchemaValidator>

/**
 * Create a per-plugin-instance AJV validator with a compiled-schema cache,
 * so registering the plugin twice never shares compilation state.
 */
export function createJsonSchemaValidator (customOptions: Options = {}) {
  // Deliberately non-mutating: tool arguments must reach handlers exactly as the
  // client sent them, so no coercion, no defaults injection, no property removal.
  // `strict: false` tolerates MCP-style schemas carrying extra annotation keywords;
  // `validateFormats: false` keeps `format` annotation-only, which is also JSON
  // Schema 2020-12's own default behavior.
  const ajv = new Ajv2020({
    coerceTypes: 'array',
    useDefaults: true,
    removeAdditional: true,
    addUsedSchema: false,
    allErrors: false,
    strict: false,
    validateFormats: false,
    ...customOptions
  })

  // Compiled validator cache, mirroring the TypeBox cache in validator.ts
  const compiledValidators = new Map<string, ReturnType<typeof ajv.compile>>()

  /**
   * Compile a plain JSON Schema with AJV, with caching. Throws when the schema
   * cannot be compiled, so callers can fail fast at tool registration time.
   */
  function compileAndCache (schema: object) {
    const key = stringify(schema)
    let validator = compiledValidators.get(key)
    if (!validator) {
      validator = ajv.compile(schema)
      compiledValidators.set(key, validator)
    }
    return validator
  }

  /**
   * Validate data against a plain JSON Schema. Returns a formatted error message
   * when the data is invalid, or `null` when it passes.
   */
  function validate (schema: object, data: unknown): string | null {
    const validator = compileAndCache(schema)
    if (validator(data)) {
      return null
    }
    return formatJsonSchemaErrors(validator.errors ?? [])
  }

  return { compileAndCache, validate }
}
