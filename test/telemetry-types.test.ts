import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { MCPPluginOptions, TracerLike } from '../src/types.ts'

describe('MCPPluginOptions telemetry', () => {
  it('accepts optional telemetry config', () => {
    const opts: MCPPluginOptions = {
      telemetry: { tracer: {} as TracerLike }
    }
    assert.ok(opts.telemetry)
  })

  it('is optional', () => {
    const opts: MCPPluginOptions = {}
    assert.equal(opts.telemetry, undefined)
  })
})
