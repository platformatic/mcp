import { Redis } from 'ioredis'

const CLIENT_METHODS = ['duplicate', 'quit', 'disconnect', 'on', 'get', 'hset'] as const

/**
 * Tell a caller-provided ioredis client apart from RedisOptions or a URL.
 * `instanceof` alone misses clients created by a different copy of ioredis
 * (e.g. a duplicated dependency), so fall back to checking the methods the
 * plugin relies on; a plain options object never has them.
 */
export function isRedisClient (value: unknown): value is Redis {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  if (value instanceof Redis) {
    return true
  }
  const candidate = value as Record<string, unknown>
  return CLIENT_METHODS.every((method) => typeof candidate[method] === 'function')
}
