import { createSigner, createVerifier } from 'fast-jwt'
import { createPublicKey } from 'crypto'
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici'
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

// Test RSA key pair for JWT signing/verification (compatible with fast-jwt)
export const TEST_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCFZOIj8m8BYoV3
RPwpQuyPIQhcZbgfB6dTJOSLwbuhmbyk9bPDRsIbPeQxG2nmVLh3zE4Yi0HrZsZS
U1c5xwEAYDGwo0RKRbW4hdSkMeiDf7bx9koPbLrqLm/DaBz4Rg1FhX6kIZO8skFd
jwZaXkG4pSo48ozMHQ82MlOdiSDLwM+xBOkG6IU4IygU22M8XepG6xExKjwlJyq7
9qO3/2F54M0PHi3wGYXebatPP7wFYc9Drt36/I4GDM+V7svl4VvjgShpq7I+axc/
xMgg1CuTsnaqUPr+7ZVe7WLtPJqk8M4DYE4ndnfIamZ8sPg4k/uKiOCcLIfG2loJ
8f6ZB90fAgMBAAECggEAA6eRaIG2V9fepzddHzZFq+AwTfO9eSApDeaXWlra7KD9
IZnXrHRuUfe+njfNjXFpwmJ3C0YZbr0Ylt3QqHUSynNYOSon7078nQsRmdQCNkQT
+4oPWl/UuSC/kB90l7q3l12CbDW9SfCqSMln16b4bvobb4b5o4fySD5Vux2sJ9jc
16TQXfZGRlJzhmdBgeUdbE4MfqeyKxDam+F+6jgkspuwvXectuxe5ZM6Nj/RrZQv
N//VV+rnuToG5Jb6DI3LV+oV7mDgXr/bFcQQxJ57m0RmSxsSyPslss5VHom5bfvX
TvlmUNtM9RucAiUsyLSR57dNhdJXbMHojjQRUQnkMQKBgQC5CF/0Xda/G9I81Ch1
Rt48/XDHnghEx/y1vUNcDEuuZd7g6l9tLNLO5UcBMs4HmFFtvfXMEUk5i0lTogaQ
/xVvwoRpx11sdx6dZ7AkFCDEsnBQTA3x3gVouPpw1G18LKIAm5mYXdbsRevyn+8o
EWv2ZrcKJzbQPDGpxg5CpGUpMQKBgQC4jlD5rsCc5EAd0U4RXkbQX3BV4PQUxON/
zCQo/FJmw0Ctvi5LfJ3I3+WbkkfwiZlti0asSjDZs1TlusBuS/p9LELYFuQommzv
qwEaStROLZvAfreuOhTrI9dwTCjgfWbtgwzjhM/6F7Foa3PC6QNKUjMK1jfEXA86
sXGY3bjXTwKBgAwhwXDbSj5Di7hTTMfLuryS/XcJJI+l8SrVWvpJEBlCMqfaliEp
ZDUOkWZBt4KF+SjR4LDdnUh5mngyUm3lW7l1Lotk9/opoUc+yizDaRacgIKzSeLG
5OHl5v3I39jZcFHL4fk8hd/+Aadp1xtwcPy55Vx0D8L9f2AbTUoPT1axAoGAQoG+
uot4C9HRLS2dBXNE75hFAh2jt8xP82DccwyioTehmjrbsgZBUf8lXg+z7wGXEbvM
BxBhVEJkyLio2dZ1eSA3Imn1ZJBpy2CDcDchFN8orpC7noR9v1LWMziuzl9CdTrx
rRfSXtyk6O039ThFIEZI8JHL3O4T6uHA/wZ/ss8CgYEAq21vYkTUO8aDjQp4uSiv
TYO5c6WWWWHgIhTxzZV3hRmG7inp8hkTGPWb9vuGmy4y84H8RS24p6FUbfq3XjgF
uw1pIOOUI9xEBUFy0oIZH6lFc27RHsumidQkwYZ3xb/0zqAksOy1dwHdXh/d+waR
EHQXdOk6vtShUdWYQPjMiq8=
-----END PRIVATE KEY-----`

export const TEST_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAhWTiI/JvAWKFd0T8KULs
jyEIXGW4HwenUyTki8G7oZm8pPWzw0bCGz3kMRtp5lS4d8xOGItB62bGUlNXOccB
AGAxsKNESkW1uIXUpDHog3+28fZKD2y66i5vw2gc+EYNRYV+pCGTvLJBXY8GWl5B
uKUqOPKMzB0PNjJTnYkgy8DPsQTpBuiFOCMoFNtjPF3qRusRMSo8JScqu/ajt/9h
eeDNDx4t8BmF3m2rTz+8BWHPQ67d+vyOBgzPle7L5eFb44EoaauyPmsXP8TIINQr
k7J2qlD6/u2VXu1i7TyapPDOA2BOJ3Z3yGpmfLD4OJP7iojgnCyHxtpaCfH+mQfd
HwIDAQAB
-----END PUBLIC KEY-----`

export function generateMockJWKSResponse (kid: string | undefined = 'test-key-1'): any {
  const publicKey = createPublicKey(TEST_PUBLIC_KEY)
  const jwk = publicKey.export({ format: 'jwk' })

  const key: any = {
    ...jwk,
    alg: 'RS256',
    use: 'sig'
  }

  if (kid !== undefined) {
    key.kid = kid
  }

  return {
    keys: [key]
  }
}

export function createTestAuthConfig (overrides: Partial<AuthorizationConfig> = {}): AuthorizationConfig {
  const base = {
    enabled: true as const,
    authorizationServers: ['https://auth.example.com'],
    resourceUri: 'https://mcp.example.com',
    tokenValidation: {
      jwksUri: 'https://auth.example.com/.well-known/jwks.json',
      validateAudience: true,
      ...('tokenValidation' in overrides ? overrides.tokenValidation : {})
    },
    ...overrides
  }

  return base
}

export function createTestJWT (payload: TestJWTOptions = {}): string {
  let kid: string | undefined = payload.kid || 'test-key-1'
  if (Object.prototype.hasOwnProperty.call(payload, 'kid') === true && (payload.kid === null || payload.kid === undefined)) {
    kid = undefined
  }
  const signer = createSigner({
    key: TEST_PRIVATE_KEY,
    algorithm: 'RS256',
    kid
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

export function setupMockAgent (responses: Record<string, any>) {
  const mockAgent = new MockAgent()
  mockAgent.disableNetConnect()

  const originalDispatcher = getGlobalDispatcher()
  setGlobalDispatcher(mockAgent)

  // Setup mock responses
  for (const [url, response] of Object.entries(responses)) {
    const urlObj = new URL(url)
    const mockPool = mockAgent.get(urlObj.origin)

    const statusCode = response.status || 200
    const responseBody = response.body || response
    const headers = response.headers || { 'content-type': 'application/json' }

    mockPool.intercept({
      path: urlObj.pathname + urlObj.search,
      method: 'GET'
    }).reply(statusCode, JSON.stringify(responseBody), headers).persist()

    // Also intercept POST for introspection endpoints
    if (url.includes('/introspect')) {
      mockPool.intercept({
        path: urlObj.pathname + urlObj.search,
        method: 'POST'
      }).reply(statusCode, JSON.stringify(responseBody), headers).persist()
    }
  }

  return () => {
    setGlobalDispatcher(originalDispatcher)
    mockAgent.close()
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
