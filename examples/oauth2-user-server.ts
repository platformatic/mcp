import Fastify from 'fastify'
import { Type } from '@sinclair/typebox'
import mcpPlugin from '../src/index.ts'
// Load environment variables from .env file using Node.js built-in support
import { readFileSync } from 'fs'
import { parseEnv } from 'util'

let envVars: Record<string, string | undefined> = {}
try {
  const envFile = readFileSync('.env', 'utf-8')
  envVars = parseEnv(envFile)
} catch (error) {
  // .env file doesn't exist, use process.env directly
}

// Helper to get environment variable from .env or process.env
const getEnv = (key: string): string | undefined => envVars[key] || process.env[key]

const fastify = Fastify({
  logger: {
    level: 'info'
  }
})

// Validate required environment variables
const requiredEnvVars = [
  'OAUTH_AUTHORIZATION_SERVER',
  'OAUTH_CLIENT_ID',
  'OAUTH_CLIENT_SECRET',
  'OAUTH_RESOURCE_URI',
  'OAUTH_JWKS_URI'
]

for (const envVar of requiredEnvVars) {
  if (!getEnv(envVar)) {
    console.error(`❌ Missing required environment variable: ${envVar}`)
    console.error('Please copy .env.example to .env and configure your OAuth settings')
    process.exit(1)
  }
}

// Parse OAuth scopes from environment
const scopes = getEnv('OAUTH_SCOPES')?.split(' ') || ['read', 'write']

// Build authorization configuration from environment
const authConfig = {
  enabled: true as const,
  authorizationServers: [getEnv('OAUTH_AUTHORIZATION_SERVER')!],
  resourceUri: getEnv('OAUTH_RESOURCE_URI')!,
  tokenValidation: {
    jwksUri: getEnv('OAUTH_JWKS_URI')!,
    introspectionEndpoint: getEnv('OAUTH_INTROSPECTION_ENDPOINT')
  },
  oauth2Client: {
    clientId: getEnv('OAUTH_CLIENT_ID')!,
    clientSecret: getEnv('OAUTH_CLIENT_SECRET')!,
    authorizationServer: getEnv('OAUTH_AUTHORIZATION_SERVER')!,
    resourceUri: getEnv('OAUTH_RESOURCE_URI')!,
    scopes,
    audicence: 'http://localhost:3000',
    dynamicRegistration: true
  }
}

// Optional Redis configuration for horizontal scaling
const redisConfig = getEnv('REDIS_HOST')
  ? {
      host: getEnv('REDIS_HOST')!,
      port: getEnv('REDIS_PORT') ? parseInt(getEnv('REDIS_PORT')!) : 6379,
      password: getEnv('REDIS_PASSWORD'),
      db: getEnv('REDIS_DB') ? parseInt(getEnv('REDIS_DB')!) : 0
    }
  : undefined

// Register the MCP plugin with OAuth 2.0 authorization
await fastify.register(mcpPlugin, {
  serverInfo: {
    name: 'oauth2-user-server',
    version: '1.0.0'
  },
  capabilities: {
    tools: {},
    resources: {},
    prompts: {}
  },
  instructions: 'An OAuth 2.0 protected MCP server that provides user information tools',
  enableSSE: true,
  authorization: authConfig,
  redis: redisConfig
})

// Schema for the get_user_details tool
const GetUserDetailsSchema = Type.Object({
  includeScopes: Type.Optional(Type.Boolean({
    description: 'Whether to include OAuth scopes in the response',
    default: true
  })),
  includeTokenInfo: Type.Optional(Type.Boolean({
    description: 'Whether to include token metadata (expiration, etc.)',
    default: false
  }))
})

// Add a protected tool that returns user details from the OAuth token
fastify.mcpAddTool({
  name: 'get_user_details',
  description: 'Get details about the authenticated user from their OAuth token',
  inputSchema: GetUserDetailsSchema
}, async (params, context) => {
  const { includeScopes = true, includeTokenInfo = false } = params
  const authContext = context?.authContext

  if (!authContext) {
    return {
      content: [{
        type: 'text',
        text: 'No authentication context available. This tool requires OAuth 2.0 authentication.'
      }],
      isError: true
    }
  }

  try {
    // Build user details response from auth context
    const userDetails: Record<string, any> = {
      userId: authContext.userId || 'Unknown',
      clientId: authContext.clientId || 'Unknown'
    }

    if (includeScopes && authContext.scopes && authContext.scopes.length > 0) {
      userDetails.scopes = authContext.scopes
      userDetails.permissions = authContext.scopes.join(', ')
    }

    if (authContext.audience && authContext.audience.length > 0) {
      userDetails.audience = authContext.audience
    }

    if (authContext.authorizationServer) {
      userDetails.authorizationServer = authContext.authorizationServer
    }

    if (includeTokenInfo) {
      const tokenInfo: Record<string, any> = {}

      if (authContext.expiresAt) {
        tokenInfo.expiresAt = authContext.expiresAt.toISOString()
        tokenInfo.expiresInSeconds = Math.max(0, Math.floor((authContext.expiresAt.getTime() - Date.now()) / 1000))
      }

      if (authContext.issuedAt) {
        tokenInfo.issuedAt = authContext.issuedAt.toISOString()
      }

      if (authContext.tokenType) {
        tokenInfo.tokenType = authContext.tokenType
      }

      if (Object.keys(tokenInfo).length > 0) {
        userDetails.tokenInfo = tokenInfo
      }
    }

    // Format response
    const userText = [
      '👤 **Authenticated User Details**',
      '',
      `**User ID**: ${userDetails.userId}`,
      `**Client ID**: ${userDetails.clientId}`
    ]

    if (userDetails.scopes) {
      userText.push(`**Permissions**: ${userDetails.permissions}`)
    }

    if (userDetails.audience) {
      userText.push(`**Audience**: ${userDetails.audience.join(', ')}`)
    }

    if (userDetails.authorizationServer) {
      userText.push(`**Authorization Server**: ${userDetails.authorizationServer}`)
    }

    if (userDetails.tokenInfo) {
      userText.push('', '🔐 **Token Information**')
      const tokenInfo = userDetails.tokenInfo

      if (tokenInfo.expiresAt) {
        const timeLeft = tokenInfo.expiresInSeconds > 0
          ? `${tokenInfo.expiresInSeconds} seconds`
          : 'Expired'
        userText.push(`**Expires**: ${tokenInfo.expiresAt} (${timeLeft})`)
      }

      if (tokenInfo.issuedAt) {
        userText.push(`**Issued**: ${tokenInfo.issuedAt}`)
      }

      if (tokenInfo.tokenType) {
        userText.push(`**Type**: ${tokenInfo.tokenType}`)
      }
    }

    return {
      content: [{
        type: 'text',
        text: userText.join('\n')
      }]
    }
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Error retrieving user details: ${error.message}`
      }],
      isError: true
    }
  }
})

// Add a tool to check token validity
fastify.mcpAddTool({
  name: 'check_token_status',
  description: 'Check the status and validity of the current OAuth token',
  inputSchema: Type.Object({})
}, async (_params, context) => {
  const authContext = context?.authContext

  if (!authContext) {
    return {
      content: [{
        type: 'text',
        text: '❌ **No Active Token**\n\nNo authentication token is currently active.'
      }],
      isError: true
    }
  }

  const now = new Date()
  const isExpired = authContext.expiresAt && authContext.expiresAt <= now
  const timeUntilExpiry = authContext.expiresAt
    ? Math.max(0, authContext.expiresAt.getTime() - now.getTime())
    : null

  const statusEmoji = isExpired ? '❌' : '✅'
  const statusText = isExpired ? 'Expired' : 'Valid'

  const response = [
    `${statusEmoji} **Token Status: ${statusText}**`,
    ''
  ]

  if (authContext.expiresAt) {
    response.push(`**Expires**: ${authContext.expiresAt.toISOString()}`)

    if (timeUntilExpiry !== null) {
      if (timeUntilExpiry > 0) {
        const minutes = Math.floor(timeUntilExpiry / (1000 * 60))
        const seconds = Math.floor((timeUntilExpiry % (1000 * 60)) / 1000)
        response.push(`**Time Remaining**: ${minutes}m ${seconds}s`)
      } else {
        response.push('**Time Remaining**: Token has expired')
      }
    }
  }

  if (authContext.issuedAt) {
    response.push(`**Issued**: ${authContext.issuedAt.toISOString()}`)
  }

  if (authContext.scopes && authContext.scopes.length > 0) {
    response.push(`**Active Scopes**: ${authContext.scopes.join(', ')}`)
  }

  return {
    content: [{
      type: 'text',
      text: response.join('\n')
    }]
  }
})

// Add a simple protected resource
fastify.mcpAddResource({
  uriPattern: 'oauth://user',
  name: 'Current User',
  description: 'Information about the currently authenticated user',
  mimeType: 'application/json'
}, async (uri, context) => {
  const authContext = context?.authContext

  if (!authContext) {
    return {
      contents: [{
        uri,
        text: JSON.stringify({ error: 'Authentication required' }, null, 2),
        mimeType: 'application/json'
      }]
    }
  }

  const userData = {
    userId: authContext.userId,
    clientId: authContext.clientId,
    scopes: authContext.scopes,
    audience: authContext.audience,
    authorizationServer: authContext.authorizationServer,
    tokenType: authContext.tokenType
  }

  return {
    contents: [{
      uri,
      text: JSON.stringify(userData, null, 2),
      mimeType: 'application/json'
    }]
  }
})

// Start the server
try {
  const port = getEnv('PORT') ? Number(getEnv('PORT')) : 3000
  await fastify.listen({ port })

  console.log(`🚀 OAuth 2.0 MCP Server started on port ${port}`)
  console.log('\n📋 Configuration:')
  console.log(`   Authorization Server: ${getEnv('OAUTH_AUTHORIZATION_SERVER')}`)
  console.log(`   Resource URI: ${getEnv('OAUTH_RESOURCE_URI')}`)
  console.log(`   Client ID: ${getEnv('OAUTH_CLIENT_ID')}`)
  console.log(`   Scopes: ${scopes.join(', ')}`)
  console.log(`   Redis: ${redisConfig ? 'Enabled' : 'Disabled (Memory only)'}`)

  console.log('\n🔧 Available tools (requires OAuth token):')
  console.log('   - get_user_details: Get authenticated user information')
  console.log('   - check_token_status: Check current token validity')

  console.log('\n📄 Available resources (requires OAuth token):')
  console.log('   - oauth://user: Current user information in JSON format')

  console.log('\n🌐 Endpoints:')
  console.log(`   - MCP JSON-RPC: POST http://localhost:${port}/mcp`)
  console.log(`   - MCP SSE: GET http://localhost:${port}/mcp`)
  console.log(`   - OAuth Metadata: GET http://localhost:${port}/.well-known/oauth-protected-resource`)
  console.log(`   - Health Check: GET http://localhost:${port}/.well-known/mcp-resource-health`)

  console.log('\n🔐 Authentication:')
  console.log('   Include OAuth 2.0 Bearer token in Authorization header:')
  console.log('   Authorization: Bearer <your-access-token>')

  console.log('\n📖 To get started:')
  console.log('   1. Copy .env.example to .env and configure your OAuth settings')
  console.log('   2. Obtain an OAuth 2.0 access token from your authorization server')
  console.log('   3. Include the token in the Authorization header of your requests')

  console.log('\n🔧 Auth0 Setup (if using Auth0):')
  console.log('   If your Auth0 connections need to be upgraded to support domain connections,')
  console.log('   use the provided upgrade script:')
  console.log('   ')
  console.log('   export AUTH0_TENANT=your-tenant-name')
  console.log('   export AUTH0_TOKEN=your-management-api-token')
  console.log('   ./examples/upgrade.sh')
  console.log('   ')
  console.log('   This script will automatically update all connections in your Auth0 tenant')
  console.log('   to enable the is_domain_connection flag, which is required for some')
  console.log('   OAuth 2.0 flows and enterprise connections.')
  console.log('   ')
  console.log('   Remember to configure a default Audience in your Auth0 application settings.')
} catch (err) {
  fastify.log.error(err)
  process.exit(1)
}
