import { createSigner, createVerifier } from 'fast-jwt'
import type { AuthorizationConfig } from '../src/types/auth-types.ts'

export interface TestJWTOptions {
  kid?: string
  alg?: string
  iss?: string
  aud?: string | string[]
  sub?: string
  exp?: number
  iat?: number
}

export interface MockJWKSKey {
  kid: string
  kty: string
  alg: string
  use: string
  n: string
  e: string
}

// Test RSA key pair for JWT signing/verification
export const TEST_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKB
wEiOfQIU5+8nXwAmJ8O5CcBYVCmQDy0o3VTfqTFz7dJH7bGFfXIQUKm1MBD7e7vb
1s7QEu7jRGC9h2x38TLH65uH5qWC4XD3KfqZfmO7Ty8KJdEXm0HIlC2mL6iCu0hA
EQQWb8JQo7rHUO4BrBn2nHKAAFfzfKP7hRF7qZe5h1l7TU6G9iLJhPhNDzjS6Zhr
M0JNKs8LFYR9BTSFcNrPsrqA+zU5TmMY7YQpfqKcECDuFw/X8cAY5QnQFmR/cBvN
TDbOLPu7eiVAbLsNB8KJV+8yLuiPGR7iqXzfZl5D+VnMLyNXjfzN+kjQm4ZdZLn+
H7Z4d8YNAgMBAAECggEAIfE+lBXdKuNOc5YQc3s4A4B+X1qXV7/1Qb9HaOJlp7D9
YKxpgC+TDL9g8YnKdZh3o4pHXc+HQIj1FQN+lNzAH8Vl/ZLTR4TrCi7VJJqN0qcI
uYjrI5X7KTi/l3B+oV5K+8B3u9Mw8p8bBJqTlTr6iNzGhLcX4+YHJXd6pJhNgN9X
AQIDAQABAO2YHPV4K8KZY9xq4pv6k8L6kj2AHqA8J6lFZCzSzNh8yx+lBv0RaGV4
NQKBgQDZyGdHHk8uxWGa2WU6e1Xr8BwTyJdE1IYr9J8cN5hX3w8Nx6NvXpNl8F7L
yDdY3IUvC6L9uHLjjP6lXtZxL9Ht5wKBgQDXTqO9BDwF5YJ6sHZ3zLDL9DnLHZsY
TJlD8l9rV4fJZRdCh4R6A1Xk9e+k5Cw9gN8JIzB6PQKBgBqLcX6QJ5lJrFcvZG4
5z6L5yzB1W6b4P2J7L0F5QY9o1uQ8vK8T6S5hKGzQKBgQCyqGhD6JYqNQ4V5u8X
V6J1lIxT1G3qD5D8W8YHjI6R9QKBgAMWg4vG4L7K8Q4q8D5aW2Q
-----END PRIVATE KEY-----`

export const TEST_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAu1SU1L7VLPHCgcBIjn0C
FOfvJ18AJifDuQnAWFQpkA8tKN1U36kxc+3SR+2xhX1yEFCptTAQ+3u729bO0BLu
40RgvYdsd/Eyx+ubh+alguFw9yn6mX5ju08vCiXRF5tByJQtpi+ogrtIQBEEFm/C
UKO6x1DuAawZ9pxygABX83yj+4URe6mXuYdZe01OhvYiyYT4TQ840umYazNCTSrP
CxWEfQU0hXDaz7K6gPs1OU5jGO2EKX6inBAg7hcP1/HAGOUJ0BZkf3AbzUw2ziz7
u3olQGy7DQfCiVfvMi7ojxke4ql832ZeQ/lZzC8jV438zfpI0JuGXWS5/h+2eHfG
DQIDAQAB
-----END PUBLIC KEY-----`

export const MOCK_JWKS_RESPONSE = {
  keys: [
    {
      kid: 'test-key-1',
      kty: 'RSA',
      alg: 'RS256',
      use: 'sig',
      n: 'u1SU1L7VLPHCgcBIjn0CFOfvJ18AJifDuQnAWFQpkA8tKN1U36kxc-3SR-2xhX1yEFCptTAQ-3u729bO0BLu40RgvYdsd_Eyx-ubh-alguFw9yn6mX5ju08vCiXRF5tByJQtpi-ogrtIQBEEFm_CUKO6x1DuAawZ9pxygABX83yj-4URe6mXuYdZe01OhvYiyYT4TQ840umYazNCTSrPCxWEfQU0hXDaz7K6gPs1OU5jGO2EKX6inBAg7hcP1_HAGOUJBZkf3AbzUw2ziz7u3olQGy7DQfCiVfvMi7ojxke4ql832ZeQ_lZzC8jV438zfpI0JuGXWS5_h-2eHfGDQ',
      e: 'AQAB'
    }
  ]
}

export function createTestAuthConfig (overrides: Partial<AuthorizationConfig> = {}): AuthorizationConfig {
  return {
    enabled: true,
    authorizationServers: ['https://auth.example.com'],
    resourceUri: 'https://mcp.example.com',
    tokenValidation: {
      jwksUri: 'https://auth.example.com/.well-known/jwks.json',
      validateAudience: true,
      ...overrides.tokenValidation
    },
    ...overrides
  }
}

export function createTestJWT (payload: TestJWTOptions = {}): string {
  const signer = createSigner({
    key: TEST_PRIVATE_KEY,
    algorithm: 'RS256',
    kid: payload.kid || 'test-key-1'
  })

  const defaultPayload = {
    iss: 'https://auth.example.com',
    aud: 'https://mcp.example.com',
    sub: 'test-user',
    exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
    iat: Math.floor(Date.now() / 1000),
    ...payload
  }

  return signer(defaultPayload)
}

export function createExpiredJWT (payload: TestJWTOptions = {}): string {
  return createTestJWT({
    ...payload,
    exp: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
    iat: Math.floor(Date.now() / 1000) - 7200  // 2 hours ago
  })
}

export function createJWTWithInvalidAudience (payload: TestJWTOptions = {}): string {
  return createTestJWT({
    ...payload,
    aud: 'https://different.example.com'
  })
}

export function verifyTestJWT (token: string): any {
  const verifier = createVerifier({
    key: TEST_PUBLIC_KEY,
    algorithms: ['RS256']
  })
  return verifier(token)
}

export function mockFetch (responses: Record<string, any>) {
  const originalFetch = global.fetch
  
  global.fetch = async (url: string | URL, options?: any) => {
    const urlString = url.toString()
    
    if (responses[urlString]) {
      const response = responses[urlString]
      return Promise.resolve({
        ok: response.status ? response.status < 400 : true,
        status: response.status || 200,
        json: async () => response.body || response,
        headers: response.headers || {}
      } as Response)
    }
    
    // Fallback to original fetch or throw error
    if (originalFetch) {
      return originalFetch(url, options)
    }
    
    throw new Error(`No mock response configured for ${urlString}`)
  }
  
  return () => {
    global.fetch = originalFetch
  }
}

export function createIntrospectionResponse (active: boolean = true, overrides: any = {}) {
  return {
    active,
    scope: 'mcp:read mcp:write',
    client_id: 'test-client',
    username: 'test-user',
    token_type: 'access_token',
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
    sub: 'test-user',
    aud: 'https://mcp.example.com',
    iss: 'https://auth.example.com',
    ...overrides
  }
}