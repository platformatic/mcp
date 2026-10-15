/**
 * Checks accepted elicitation answers against the `requestedSchema` they
 * answer.
 *
 * Unlike tool schemas, which are registered once at startup, elicitation
 * schemas are often built per request (a default set to the user's current
 * value, an enum of their files), so compiled validators are kept in a bounded
 * cache and evicted from AJV as well.
 */

import { Ajv2020 } from 'ajv/dist/2020.js'
import type { ValidateFunction } from 'ajv/dist/2020.js'
import stringify from 'safe-stable-stringify'

/** Compiled answer validators kept at once; older ones are compiled again on demand. */
const MAX_COMPILED_SCHEMAS = 256

/**
 * Keywords that describe a schema without constraining it, dropped before
 * compiling and from the cache key, so schemas that differ only in wording
 * share a validator. `$schema` and `$id` go too: the flat subset elicitation
 * allows means the same in draft-07 and 2020-12, and AJV would otherwise
 * refuse a draft-07 meta-schema or an `$id` it cannot resolve.
 */
const IGNORED_KEYWORDS = new Set(['$schema', '$id', 'title', 'description', 'default', 'examples', '$comment'])

/** A copy of `schema` with only the keywords that constrain a value. */
export function normalizeAnswerSchema (schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(normalizeAnswerSchema)
  if (schema === null || typeof schema !== 'object') return schema
  // Built with fromEntries so a key such as `__proto__` stays an own property.
  const normalized: Array<[string, unknown]> = []
  for (const [key, value] of Object.entries(schema)) {
    if (IGNORED_KEYWORDS.has(key)) continue
    if (key === 'enum' || key === 'const') {
      // Values, not schemas: an object among them must match as written.
      normalized.push([key, value])
    } else if (key === 'properties' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      // Property names are data, not keywords: keep every one of them.
      normalized.push([key, Object.fromEntries(Object.entries(value).map(([name, property]) => [name, normalizeAnswerSchema(property)]))])
    } else {
      normalized.push([key, normalizeAnswerSchema(value)])
    }
  }
  return Object.fromEntries(normalized)
}

export class AnswerValidator {
  #ajv = new Ajv2020({
    addUsedSchema: false,
    allErrors: false,
    strict: false,
    validateFormats: false,
    // Answers reach handlers exactly as the client sent them.
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false
  })

  /** Most recently used last. */
  #compiled = new Map<string, { schema: object, validate: ValidateFunction }>()

  /**
   * The validator for an already normalized schema. Throws when AJV cannot
   * compile it, so a handler's broken schema is caught when it asks.
   */
  compile (schema: object): ValidateFunction {
    const key = stringify(schema)
    const cached = this.#compiled.get(key)
    if (cached) {
      this.#compiled.delete(key)
      this.#compiled.set(key, cached)
      return cached.validate
    }

    const validate = this.#ajv.compile(schema)
    this.#compiled.set(key, { schema, validate })
    if (this.#compiled.size > MAX_COMPILED_SCHEMAS) {
      const [oldestKey, oldest] = this.#compiled.entries().next().value!
      this.#compiled.delete(oldestKey)
      // AJV keeps its own cache keyed by the schema object.
      this.#ajv.removeSchema(oldest.schema)
    }
    return validate
  }

  /** What is wrong with `data`, or `null` when it matches. */
  validate (schema: object, data: unknown): string | null {
    const validate = this.compile(schema)
    if (validate(data)) return null
    return (validate.errors ?? [])
      .map(error => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`)
      .join('; ')
  }

  /** How many compiled schemas are held, for tests. */
  get size (): number {
    return this.#compiled.size
  }
}
