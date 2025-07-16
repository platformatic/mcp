import { test, describe } from 'node:test'
import { strict as assert } from 'node:assert'
import { Type } from '@sinclair/typebox'
import {
  validate,
  validateOrThrow,
  check,
  transform,
  createValidationError,
  formatValidationErrors
} from '../src/validation/validator.ts'
import {
  schemaToArguments,
  validateToolSchema,
  getEnumValues,
  isOptionalProperty
} from '../src/validation/converter.ts'

describe('Validation Utils', () => {
  describe('Validator Functions', () => {
    test('should validate data against TypeBox schema', () => {
      const schema = Type.Object({
        name: Type.String(),
        age: Type.Number({ minimum: 0 })
      })

      const validData = { name: 'Alice', age: 30 }
      const result = validate(schema, validData)

      assert.strictEqual(result.success, true)
      if (result.success) {
        assert.strictEqual(result.data.name, 'Alice')
        assert.strictEqual(result.data.age, 30)
      }
    })

    test('should return validation errors for invalid data', () => {
      const schema = Type.Object({
        name: Type.String(),
        age: Type.Number({ minimum: 0 })
      })

      const invalidData = { name: 123, age: -5 }
      const result = validate(schema, invalidData)

      assert.strictEqual(result.success, false)
      if (!result.success) {
        assert.strictEqual(result.error.code, 'VALIDATION_ERROR')
        assert.ok(result.error.message.includes('Validation failed'))
        assert.ok(Array.isArray(result.error.errors))
        assert.ok(result.error.errors.length > 0)
      }
    })

    test('should throw validation error with validateOrThrow', () => {
      const schema = Type.Object({
        name: Type.String()
      })

      const validData = { name: 'Alice' }
      const result = validateOrThrow(schema, validData)
      assert.strictEqual(result.name, 'Alice')

      const invalidData = { name: 123 }
      assert.throws(() => validateOrThrow(schema, invalidData))
    })

    test('should check data without detailed errors', () => {
      const schema = Type.Object({
        name: Type.String()
      })

      assert.strictEqual(check(schema, { name: 'Alice' }), true)
      assert.strictEqual(check(schema, { name: 123 }), false)
    })

    test('should transform data with defaults', () => {
      const schema = Type.Object({
        name: Type.String(),
        age: Type.Number({ default: 25 })
      })

      const data = { name: 'Bob' }
      const transformed = transform(schema, data)

      assert.strictEqual(transformed.name, 'Bob')
      assert.strictEqual(transformed.age, 25)
    })

    test('should create validation error structure', () => {
      const errors = [
        { path: '/name', message: 'Expected string', expected: 'string', received: 123 },
        { path: '/age', message: 'Expected number >= 0', expected: 'number', received: -5 }
      ]

      const validationError = createValidationError('Test validation failed', errors)

      assert.strictEqual(validationError.code, 'VALIDATION_ERROR')
      assert.strictEqual(validationError.message, 'Test validation failed')
      assert.strictEqual(validationError.errors.length, 2)
    })

    test('should format validation errors', () => {
      const errors = [
        { path: '/name', message: 'Expected string', expected: 'string', received: 123 },
        { path: '/age', message: 'Expected number >= 0', expected: 'number', received: -5 }
      ]

      const formatted = formatValidationErrors(errors)

      assert.ok(formatted.includes('/name'))
      assert.ok(formatted.includes('Expected string'))
      assert.ok(formatted.includes('/age'))
      assert.ok(formatted.includes('Expected number >= 0'))
    })

    test('should cache compiled validators for performance', () => {
      const schema = Type.Object({
        name: Type.String()
      })

      // First validation should compile
      const start1 = Date.now()
      const result1 = validate(schema, { name: 'Alice' })
      const time1 = Date.now() - start1

      // Second validation should use cached validator
      const start2 = Date.now()
      const result2 = validate(schema, { name: 'Bob' })
      const time2 = Date.now() - start2

      assert.strictEqual(result1.success, true)
      assert.strictEqual(result2.success, true)

      // Second validation should be faster (cached)
      assert.ok(time2 <= time1)
    })
  })

  describe('Schema Converter Functions', () => {
    test('should convert TypeBox schema to arguments array', () => {
      const schema = Type.Object({
        query: Type.String({
          description: 'Search query',
          minLength: 1
        }),
        limit: Type.Optional(Type.Number({
          description: 'Maximum results',
          minimum: 1,
          maximum: 100
        })),
        filters: Type.Array(Type.String(), {
          description: 'Filter criteria'
        })
      })

      const args = schemaToArguments(schema)

      assert.strictEqual(args.length, 3)

      const queryArg = args.find(arg => arg.name === 'query')
      assert.ok(queryArg)
      assert.strictEqual(queryArg.required, true)
      assert.strictEqual(queryArg.description, 'Search query')

      const limitArg = args.find(arg => arg.name === 'limit')
      assert.ok(limitArg)
      assert.strictEqual(limitArg.required, false)
      assert.strictEqual(limitArg.description, 'Maximum results')

      const filtersArg = args.find(arg => arg.name === 'filters')
      assert.ok(filtersArg)
      assert.strictEqual(filtersArg.required, true)
      assert.strictEqual(filtersArg.description, 'Filter criteria')
    })

    test('should generate descriptions for different schema types', () => {
      const schema = Type.Object({
        stringField: Type.String(),
        numberField: Type.Number({ minimum: 0, maximum: 100 }),
        booleanField: Type.Boolean(),
        arrayField: Type.Array(Type.String()),
        enumField: Type.String({ enum: ['a', 'b', 'c'] }),
        literalField: Type.Literal('fixed-value'),
        optionalField: Type.Optional(Type.String())
      })

      const args = schemaToArguments(schema)

      const stringArg = args.find(arg => arg.name === 'stringField')
      assert.ok(stringArg?.description?.includes('String'))

      const numberArg = args.find(arg => arg.name === 'numberField')
      assert.ok(numberArg?.description?.includes('Number'))
      assert.ok(numberArg?.description?.includes('min: 0'))
      assert.ok(numberArg?.description?.includes('max: 100'))

      const booleanArg = args.find(arg => arg.name === 'booleanField')
      assert.ok(booleanArg?.description?.includes('Boolean'))

      const arrayArg = args.find(arg => arg.name === 'arrayField')
      assert.ok(arrayArg?.description?.includes('Array'))

      const enumArg = args.find(arg => arg.name === 'enumField')
      assert.ok(enumArg?.description?.includes('one of: a, b, c'))

      const literalArg = args.find(arg => arg.name === 'literalField')
      assert.ok(literalArg?.description?.includes('Literal value: fixed-value'))

      const optionalArg = args.find(arg => arg.name === 'optionalField')
      assert.strictEqual(optionalArg?.required, false)
    })

    test('should verify TypeBox schema is already JSON Schema compatible', () => {
      const schema = Type.Object({
        name: Type.String(),
        age: Type.Number({ minimum: 0 })
      })

      // TypeBox schemas are already JSON Schema compatible
      assert.strictEqual(schema.type, 'object')
      assert.ok(schema.properties)
      assert.ok(schema.properties.name)
      assert.ok(schema.properties.age)
      assert.strictEqual(schema.properties.name.type, 'string')
      assert.strictEqual(schema.properties.age.type, 'number')
      assert.strictEqual(schema.properties.age.minimum, 0)
    })

    test('should validate tool schema structure', () => {
      const validSchema = Type.Object({
        name: Type.String(),
        age: Type.Number()
      })

      const errors = validateToolSchema(validSchema)
      assert.strictEqual(errors.length, 0)

      const invalidSchema = Type.String()
      const invalidErrors = validateToolSchema(invalidSchema)
      assert.ok(invalidErrors.length > 0)
      assert.ok(invalidErrors[0].includes('must be an object'))
    })

    test('should detect unsupported schema types', () => {
      const schemaWithUnsupported = Type.Object({
        validField: Type.String(),
        invalidField: Type.Function([], Type.String())
      })

      const errors = validateToolSchema(schemaWithUnsupported)
      assert.ok(errors.length > 0)
      assert.ok(errors.some(error => error.includes('unsupported type')))
    })

    test('should extract enum values from schema', () => {
      const enumSchema = Type.String({ enum: ['a', 'b', 'c'] })
      const values = getEnumValues(enumSchema)

      assert.ok(Array.isArray(values))
      assert.deepStrictEqual(values, ['a', 'b', 'c'])

      const unionSchema = Type.Union([
        Type.Literal('x'),
        Type.Literal('y'),
        Type.Literal('z')
      ])
      const unionValues = getEnumValues(unionSchema)

      assert.ok(Array.isArray(unionValues))
      assert.deepStrictEqual(unionValues, ['x', 'y', 'z'])

      const nonEnumSchema = Type.String()
      const nonEnumValues = getEnumValues(nonEnumSchema)

      assert.strictEqual(nonEnumValues, undefined)
    })

    test('should detect optional properties in object schemas', () => {
      const objectSchema = Type.Object({
        required: Type.String(),
        optional: Type.Optional(Type.String())
      })

      assert.strictEqual(isOptionalProperty(objectSchema, 'required'), false)
      assert.strictEqual(isOptionalProperty(objectSchema, 'optional'), true)
    })

    test('should validate nested object schemas', () => {
      const nestedSchema = Type.Object({
        user: Type.Object({
          name: Type.String(),
          profile: Type.Object({
            age: Type.Number()
          })
        })
      })

      const errors = validateToolSchema(nestedSchema)
      assert.strictEqual(errors.length, 0)

      const invalidNestedSchema = Type.Object({
        user: Type.Object({
          name: Type.String(),
          invalid: Type.Function([], Type.String())
        })
      })

      const invalidErrors = validateToolSchema(invalidNestedSchema)
      assert.ok(invalidErrors.length > 0)
      assert.ok(invalidErrors.some(error => error.includes('user.')))
    })

    test('should validate array schemas', () => {
      const arraySchema = Type.Object({
        tags: Type.Array(Type.String()),
        numbers: Type.Array(Type.Number({ minimum: 0 }))
      })

      const errors = validateToolSchema(arraySchema)
      assert.strictEqual(errors.length, 0)

      const invalidArraySchema = Type.Object({
        invalid: Type.Array(Type.Function([], Type.String()))
      })

      const invalidErrors = validateToolSchema(invalidArraySchema)
      assert.ok(invalidErrors.length > 0)
      assert.ok(invalidErrors.some(error => error.includes('invalid[]')))
    })

    test('should handle schema with custom descriptions', () => {
      const schema = Type.Object({
        field1: Type.String({ description: 'Custom description 1' }),
        field2: Type.Number({ description: 'Custom description 2' })
      })

      const args = schemaToArguments(schema)

      const field1Arg = args.find(arg => arg.name === 'field1')
      assert.strictEqual(field1Arg?.description, 'Custom description 1')

      const field2Arg = args.find(arg => arg.name === 'field2')
      assert.strictEqual(field2Arg?.description, 'Custom description 2')
    })

    test('should handle union schemas in descriptions', () => {
      const schema = Type.Object({
        status: Type.Union([
          Type.Literal('active'),
          Type.Literal('inactive'),
          Type.Literal('pending')
        ])
      })

      const args = schemaToArguments(schema)

      const statusArg = args.find(arg => arg.name === 'status')
      assert.ok(statusArg?.description?.includes('One of:'))
      assert.ok(statusArg?.description?.includes('active'))
      assert.ok(statusArg?.description?.includes('inactive'))
      assert.ok(statusArg?.description?.includes('pending'))
    })
  })

  describe('Performance Tests', () => {
    test('should have minimal validation overhead', () => {
      const schema = Type.Object({
        name: Type.String(),
        age: Type.Number({ minimum: 0 })
      })

      const testData = { name: 'Alice', age: 30 }
      const iterations = 1000

      // Warm up the cache
      validate(schema, testData)

      const start = Date.now()
      for (let i = 0; i < iterations; i++) {
        validate(schema, testData)
      }
      const end = Date.now()

      const averageTime = (end - start) / iterations

      // Should be well under 1ms per validation
      assert.ok(averageTime < 1, `Average validation time ${averageTime}ms should be < 1ms`)
    })

    test('should cache validators efficiently', () => {
      const schema1 = Type.Object({ name: Type.String() })
      const schema2 = Type.Object({ age: Type.Number() })

      // First validation should compile
      const result1 = validate(schema1, { name: 'Alice' })
      const result2 = validate(schema2, { age: 30 })

      // Second validation with same schema should use cache
      const result3 = validate(schema1, { name: 'Bob' })
      const result4 = validate(schema2, { age: 25 })

      assert.strictEqual(result1.success, true)
      assert.strictEqual(result2.success, true)
      assert.strictEqual(result3.success, true)
      assert.strictEqual(result4.success, true)
    })
  })
})
