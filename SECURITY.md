# Security Best Practices for Fastify MCP

This document outlines security considerations and best practices when using the Fastify MCP plugin implementation.

## ⚠️ Important Security Notices

### Tool Annotations Are Hints Only

**🚨 CRITICAL:** Tool annotations (such as `destructiveHint`, `openWorldHint`, etc.) are **hints from potentially untrusted servers** and should **NEVER** be used for security decisions.

- Annotations can be provided by untrusted MCP servers
- They are not guaranteed to accurately describe tool behavior  
- Always implement your own security validation regardless of annotations
- Use annotations only for UI/UX improvements, not security controls

### Elicitation Security

When using the elicitation feature (server-to-client information requests):

- **Validate all user inputs** before processing elicitation responses
- **Limit elicitation message length** to prevent DoS attacks
- **Validate schema complexity** to prevent resource exhaustion
- **Implement rate limiting** for elicitation requests
- **Always require user consent** before sharing sensitive information

## Input Validation and Sanitization

### Tool Parameters

The plugin automatically sanitizes tool parameters to prevent common attacks:

- **String length limits:** Maximum 10,000 characters per string
- **Object depth limits:** Maximum 10 levels of nesting
- **Property count limits:** Maximum 100 properties per object
- **Control character removal:** Strips null bytes and control characters
- **Circular reference detection:** Prevents infinite loops

### Schema Validation

All inputs are validated against TypeBox schemas:

```typescript
// Example: Secure tool definition
app.mcpAddTool({
  name: 'secure-tool',
  description: 'A tool with proper validation',
  inputSchema: Type.Object({
    message: Type.String({ 
      minLength: 1, 
      maxLength: 1000,
      description: 'User message'
    }),
    priority: Type.Union([
      Type.Literal('low'),
      Type.Literal('medium'), 
      Type.Literal('high')
    ])
  })
}, async (params) => {
  // params are automatically validated and sanitized
  return { content: [{ type: 'text', text: 'OK' }] }
})
```

## Tool Security Assessment

The plugin automatically assesses tool security risks:

### Risk Levels

- **Low Risk:** Read-only tools with closed-world domains
- **Medium Risk:** Tools that interact with external entities
- **High Risk:** Destructive tools that modify the environment

### Security Warnings

The following warnings are logged for different tool types:

```typescript
// High-risk tool example
app.mcpAddTool({
  name: 'file-delete',
  description: 'Delete files',
  annotations: {
    destructiveHint: true,  // ⚠️ Triggers high-risk warning
    openWorldHint: false
  },
  inputSchema: Type.Object({
    path: Type.String()
  })
}, handler)
```

## Rate Limiting

Implement rate limiting to prevent abuse:

```typescript
import { RateLimiter } from '@platformatic/mcp/security'

const rateLimiter = new RateLimiter(100, 60000) // 100 requests per minute

// Check before processing requests
if (!rateLimiter.isAllowed(sessionId)) {
  throw new Error('Rate limit exceeded')
}
```

## Redis Security (Production Deployments)

When using Redis for horizontal scaling:

### Connection Security

```typescript
await app.register(mcpPlugin, {
  enableSSE: true,
  redis: {
    host: 'your-redis-host',
    port: 6379,
    password: process.env.REDIS_PASSWORD, // Always use authentication
    db: 0,
    // Enable TLS for production
    tls: {
      rejectUnauthorized: true
    }
  }
})
```

### Redis Best Practices

- **Always use authentication:** Set `requirepass` in Redis config
- **Enable TLS encryption:** Especially for remote Redis instances
- **Use dedicated Redis database:** Isolate MCP data with `db` parameter
- **Implement network security:** Use VPCs, security groups, firewalls
- **Regular updates:** Keep Redis version up-to-date
- **Monitor access:** Log and monitor Redis access patterns

## Session Security

### Session Management

- **Session IDs are cryptographically secure:** Generated using Node.js crypto
- **Automatic cleanup:** Sessions expire after 1 hour by default
- **Message history limits:** Prevents unbounded memory growth
- **Cross-instance isolation:** Sessions are properly isolated between instances

### SSE Security

Server-Sent Events implementation includes:

- **Proper CORS handling:** Configure CORS policies appropriately
- **Connection limits:** Implement connection limits per client
- **Heartbeat monitoring:** Automatic cleanup of dead connections
- **Message replay security:** Last-Event-ID validation

## Environment Security

### Environment Variables

Never expose sensitive configuration:

```bash
# ✅ Good: Use environment variables
REDIS_PASSWORD=your-secure-password
MCP_SECRET_KEY=your-secret-key

# ❌ Bad: Hardcoded secrets
const redis = { password: 'hardcoded-password' }
```

### Logging Security

- **Sanitize log output:** Remove sensitive data from logs
- **Log security events:** Tool executions, validation failures
- **Monitor logs:** Set up alerts for suspicious activity

```typescript
// Example: Secure logging
app.log.info({
  tool: toolName,
  sessionId,
  // ❌ Never log sensitive parameters
  // params: toolParams
}, 'Tool executed successfully')
```

## Transport Security

### HTTPS Requirements

**Always use HTTPS in production:**

```typescript
const app = fastify({
  https: {
    key: fs.readFileSync('path/to/key.pem'),
    cert: fs.readFileSync('path/to/cert.pem')
  }
})
```

### WebSocket Security (if applicable)

If extending to WebSocket transport:

- Use `wss://` (WebSocket Secure) in production
- Validate Origin headers
- Implement proper authentication
- Use connection limits

## Error Handling Security

### Information Disclosure

Prevent information leakage in error messages:

```typescript
// ✅ Good: Generic error messages
return createError(request.id, INVALID_PARAMS, 'Invalid parameters')

// ❌ Bad: Detailed error messages
return createError(request.id, INVALID_PARAMS, `SQL injection attempt detected: ${details}`)
```

### Error Logging

Log detailed errors securely:

```typescript
try {
  // risky operation
} catch (error) {
  // Log detailed error for debugging
  app.log.error({ error, sessionId, toolName }, 'Tool execution failed')
  
  // Return generic error to client
  return { content: [{ type: 'text', text: 'Operation failed' }], isError: true }
}
```

## Monitoring and Alerting

### Security Metrics

Monitor these security-related metrics:

- Failed validation attempts per session
- Rate limit violations
- High-risk tool executions  
- Unusual session patterns
- Redis connection failures

### Alert Conditions

Set up alerts for:

- Multiple validation failures from same IP
- Rapid tool execution patterns
- Large payload sizes
- Suspicious schema patterns in elicitation

## Compliance Considerations

### Data Privacy

- **Minimize data collection:** Only collect necessary data
- **Data retention:** Implement appropriate retention policies
- **User consent:** Always obtain consent for data sharing
- **Data encryption:** Encrypt sensitive data at rest and in transit

### Audit Trail

Maintain audit logs for:

- Tool executions with parameters (sanitized)
- Session creation and termination
- Elicitation requests and responses
- Security policy violations

## Security Updates

### Keeping Secure

- **Regular updates:** Keep all dependencies up-to-date
- **Security advisories:** Subscribe to security notifications
- **Vulnerability scanning:** Regularly scan for known vulnerabilities
- **Security testing:** Include security tests in your CI/CD pipeline

### Reporting Security Issues

If you discover a security vulnerability:

1. **Do not create public issues**
2. **Email security concerns** to the maintainers privately
3. **Provide detailed reproduction steps**
4. **Allow reasonable time** for fixes before disclosure

---

## Quick Security Checklist

- [ ] All tool inputs are validated with TypeBox schemas
- [ ] Rate limiting is implemented for high-risk operations
- [ ] Redis authentication and TLS are configured
- [ ] HTTPS is enabled in production
- [ ] Error messages don't leak sensitive information
- [ ] Security monitoring and alerting are in place
- [ ] Regular security updates are applied
- [ ] Audit logging is configured
- [ ] Tool annotations are treated as untrusted hints only
- [ ] Elicitation requests include user consent mechanisms

Remember: Security is a layered approach. No single measure provides complete protection.