# Migration Guide: MCP Spec 2025-06-18 → 2025-11-15 (Draft)

This guide helps you migrate from the previous MCP specification (2025-06-18) to the latest draft specification (2025-11-15).

## Summary

**Good News:** This update is **100% backward compatible**. All existing code will continue to work without changes.

The update adds new optional features and capabilities that you can adopt incrementally:

- **Authorization Enhancements** (OAuth 2.1, OIDC Discovery, Incremental Consent)
- **Icon Metadata** (Visual assets for tools, resources, prompts)
- **Logging Capability** (RFC 5424 severity levels)
- **Completion/Autocompletion** (Argument suggestions)
- **URL Mode Elicitation** (Out-of-band data collection)
- **Client Requests** (Sampling, Roots)
- **Tasks** (Experimental async operations)

## Breaking Changes

**None.** This is a fully backward-compatible update.

---

## New Features

### 1. Authorization Enhancements

#### OpenID Connect Discovery

Servers can now discover OAuth 2.0 Authorization Server metadata automatically:

```typescript
import { discoverAuthorizationServer } from '@platformatic/mcp'

// Auto-discover from issuer URL
const metadata = await discoverAuthorizationServer(
  'https://auth.example.com',
  'auto' // Tries both OAuth 2.0 and OIDC endpoints
)

console.log(metadata.authorization_endpoint)
console.log(metadata.token_endpoint)
console.log(metadata.jwks_uri)
```

#### Client ID Metadata Documents (RECOMMENDED)

The **recommended** client registration method is now Client ID Metadata Documents:

```typescript
await app.register(mcpPlugin, {
  serverInfo: { name: 'my-server', version: '1.0.0' },
  capabilities: { tools: {} },
  authorization: {
    enabled: true,
    resourceUri: 'https://api.example.com',
    authorizationServers: ['https://auth.example.com'],
    oauth2Client: {
      clientRegistration: {
        method: 'metadata-document', // RECOMMENDED
        metadataUrl: 'https://api.example.com/oauth/client-metadata.json',
        scopes: ['read', 'write']
      }
    }
  }
})
```

The plugin automatically serves the metadata document at `/oauth/client-metadata.json`.

#### Incremental Scope Consent

Servers can request additional scopes when needed using RFC 6750 WWW-Authenticate challenges:

```typescript
import { createScopeChallenge, hasRequiredScopes } from '@platformatic/mcp'

// In your tool handler
app.mcpAddTool({
  name: 'delete-file',
  description: 'Delete a file',
  inputSchema: { /* ... */ }
}, async (params, context) => {
  const requiredScopes = ['files:delete']

  // Check if token has required scopes
  if (!hasRequiredScopes(context.authContext?.scopes || [], requiredScopes)) {
    // Return 403 with scope challenge
    context.reply.code(403)
    context.reply.header(
      'WWW-Authenticate',
      createScopeChallenge(
        requiredScopes,
        'https://api.example.com/.well-known/oauth-protected-resource'
      )
    )
    return {
      content: [{ type: 'text', text: 'Insufficient scopes' }],
      isError: true
    }
  }

  // Proceed with deletion
  // ...
})
```

### 2. Icon Metadata

Add visual assets to tools, resources, and prompts:

```typescript
app.mcpAddTool({
  name: 'calculator',
  description: 'Perform calculations',
  icons: [
    {
      src: 'https://example.com/icons/calculator.png',
      mimeType: 'image/png',
      sizes: '32x32'
    },
    {
      src: 'https://example.com/icons/calculator.svg',
      mimeType: 'image/svg+xml'
    }
  ],
  inputSchema: { /* ... */ }
}, handler)

app.mcpAddResource({
  uri: 'file:///documents/readme.txt',
  name: 'README',
  description: 'Project documentation',
  icons: [{
    src: 'https://example.com/icons/document.png',
    mimeType: 'image/png'
  }]
}, handler)

app.mcpAddPrompt({
  name: 'greeting',
  description: 'Generate a greeting',
  icons: [{
    src: 'https://example.com/icons/chat.svg',
    mimeType: 'image/svg+xml'
  }],
  argumentSchema: { /* ... */ }
}, handler)
```

### 3. Logging Capability

Implement server-side logging with RFC 5424 severity levels:

```typescript
await app.register(mcpPlugin, {
  serverInfo: { name: 'my-server', version: '1.0.0' },
  capabilities: {
    tools: {},
    logging: {} // Enable logging capability
  },
  enableSSE: true
})

// Log at different severity levels
await app.mcpLog.debug('Detailed debug information')
await app.mcpLog.info('Informational message')
await app.mcpLog.notice('Normal but significant')
await app.mcpLog.warning('Warning condition')
await app.mcpLog.error('Error condition')
await app.mcpLog.critical('Critical condition')
await app.mcpLog.alert('Action must be taken immediately')
await app.mcpLog.emergency('System is unusable')

// With logger name
await app.mcpLog.info('Processing request', 'request-handler')

// Set minimum log level
await app.mcpSetLogLevel('warning') // Only warning and above

// Get current level
const level = app.mcpGetLogLevel() // 'warning'
```

### 4. Completion/Autocompletion

Provide argument completion suggestions:

```typescript
await app.register(mcpPlugin, {
  serverInfo: { name: 'my-server', version: '1.0.0' },
  capabilities: {
    prompts: {},
    completions: {} // Enable completions
  }
})

// Register a prompt
app.mcpAddPrompt({
  name: 'search',
  description: 'Search with category',
  argumentSchema: Type.Object({
    category: Type.String(),
    query: Type.String()
  })
}, handler)

// Provide completions for category argument
app.mcpRegisterPromptCompletion('search', async (argumentName, argumentValue, context) => {
  if (argumentName === 'category') {
    return ['tech', 'science', 'history', 'art']
  }

  if (argumentName === 'query') {
    // Use context from other arguments
    const category = context?.arguments?.category
    if (category === 'tech') {
      return ['JavaScript', 'TypeScript', 'Python']
    }
  }

  return []
})

// Resource completion
app.mcpRegisterResourceCompletion('file:///{path}', async (argumentName, argumentValue) => {
  if (argumentName === 'path') {
    return ['/home/user/file1.txt', '/home/user/file2.txt']
  }
  return []
})
```

### 5. URL Mode Elicitation

Redirect users to external URLs for data collection:

```typescript
// In your tool handler
app.mcpAddTool({
  name: 'oauth-setup',
  description: 'Set up OAuth connection',
  inputSchema: { /* ... */ }
}, async (params, context) => {
  const sessionId = context.request.headers['x-session-id']
  const elicitationId = crypto.randomUUID()

  // Send URL mode elicitation request to client
  await app.mcpElicitURL(
    sessionId,
    elicitationId,
    'https://example.com/oauth/authorize',
    'Please authorize the connection'
  )

  // Wait for completion (or return immediately)
  return {
    content: [{ type: 'text', text: 'Authorization started' }]
  }
})
```

The external URL should POST to `/elicitation/:elicitationId/complete` when done.

### 6. Client Requests (Sampling & Roots)

Servers can request LLM sampling or file system roots from clients:

```typescript
// Request LLM sampling
await app.mcpRequestSampling(sessionId, [
  {
    role: 'user',
    content: { type: 'text', text: 'What is 2+2?' }
  }
], {
  maxTokens: 100,
  tools: [
    {
      name: 'calculator',
      description: 'Perform calculation',
      inputSchema: { /* ... */ }
    }
  ],
  toolChoice: { mode: 'auto' }
})

// Request file system roots
await app.mcpRequestRoots(sessionId)
```

### 7. Tasks (Experimental)

Support long-running async operations:

```typescript
await app.register(mcpPlugin, {
  serverInfo: { name: 'my-server', version: '1.0.0' },
  capabilities: {
    tools: {},
    tasks: {  // Enable tasks
      list: {},
      cancel: {}
    }
  }
})

// In your tool handler
app.mcpAddTool({
  name: 'process-video',
  description: 'Process a video file',
  inputSchema: { /* ... */ }
}, async (params, context) => {
  // Create async task
  const task = await app.taskService!.createTask(
    5 * 60 * 1000, // 5 minute TTL
    context.authContext
  )

  const taskId = task.task.taskId

  // Start processing asynchronously
  processVideo(params).then(result => {
    app.taskService!.updateTask(taskId, 'completed', result)
  }).catch(error => {
    app.taskService!.updateTask(taskId, 'failed', null, error.message)
  })

  // Return task immediately
  return {
    _meta: {
      'io.modelcontextprotocol/related-task': { taskId }
    },
    content: [{ type: 'text', text: `Processing started. Task ID: ${taskId}` }]
  }
})
```

---

## Configuration Changes

### Redis Backend (Optional)

Tasks now support Redis backend for horizontal scaling:

```typescript
await app.register(mcpPlugin, {
  serverInfo: { name: 'my-server', version: '1.0.0' },
  capabilities: {
    tasks: { list: {}, cancel: {} }
  },
  redis: {
    host: 'localhost',
    port: 6379
  }
})
```

Task store automatically uses Redis when `redis` option is provided.

---

## TypeScript Type Updates

### New Exported Types

```typescript
// Authorization
import type {
  AuthorizationServerMetadata,
  ClientMetadata,
  AuthorizationContext,
  TokenRefreshInfo
} from '@platformatic/mcp'

// Protocol
import type {
  IconResource,
  LogLevel,
  CompleteRequest,
  CompleteResult,
  TaskStatus,
  TaskAugmentation,
  CreateTaskResult,
  TaskCapabilities
} from '@platformatic/mcp'

// Features
import type {
  CompletionProvider
} from '@platformatic/mcp'
```

### New Utility Functions

```typescript
import {
  // Discovery
  discoverAuthorizationServer,
  fetchJWKS,
  fetchClientMetadata,

  // Client metadata
  generateClientMetadata,
  validateClientMetadata,

  // Scope management
  createScopeChallenge,
  createAuthChallenge,
  parseTokenScopes,
  hasRequiredScopes,
  getMissingScopes
} from '@platformatic/mcp'
```

---

## Testing Updates

If you have custom tests, new test utilities are available:

- **Task testing**: Create and verify tasks in tests
- **Logging testing**: Verify log level filtering
- **Completion testing**: Test completion providers
- **Authorization testing**: New JWT/JWKS utilities

---

## Performance Considerations

### Task Cleanup

Tasks are automatically cleaned up every 5 minutes. For custom cleanup intervals:

```typescript
// Access task service directly
setInterval(async () => {
  const count = await app.taskService!.cleanup()
  console.log(`Cleaned up ${count} expired tasks`)
}, 60000) // Every minute
```

### Logging Performance

Logging respects level hierarchy to avoid unnecessary message serialization:

```typescript
// Only serializes and sends if level >= current minimum
await app.mcpLog.debug(expensiveToSerialize())
```

---

## Security Best Practices

### 1. Scope Validation

Always validate scopes for sensitive operations:

```typescript
import { hasRequiredScopes } from '@platformatic/mcp'

if (!hasRequiredScopes(context.authContext?.scopes || [], ['admin'])) {
  throw new Error('Insufficient permissions')
}
```

### 2. Task Authorization

Tasks automatically inherit authorization context:

```typescript
const task = await app.taskService!.createTask(
  60000,
  context.authContext  // Scope task to this user/client
)
```

### 3. URL Elicitation

Validate user identity before completing elicitations in your external URL handler.

---

## Deprecations

**None.** All previous APIs remain supported.

---

## Next Steps

1. **Review new capabilities** - Decide which features benefit your application
2. **Update authorization** - Consider adopting OIDC Discovery and Client ID Metadata Documents
3. **Add icon metadata** - Enhance UX with visual assets
4. **Enable logging** - Improve observability
5. **Implement completions** - Better argument UX
6. **Consider tasks** - For long-running operations

---

## Support

- **GitHub Issues**: https://github.com/platformatic/mcp/issues
- **Documentation**: https://github.com/platformatic/mcp/blob/main/README.md
- **Specification**: https://github.com/platformatic/mcp/tree/main/spec

---

## Version Matrix

| Feature | Spec Version | Plugin Version |
|---------|--------------|----------------|
| Basic MCP | 2025-06-18 | 1.0.0+ |
| Authorization (Basic) | 2025-06-18 | 1.1.0+ |
| All new features | 2025-11-15 (draft) | 1.3.0+ |
