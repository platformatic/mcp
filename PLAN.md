# Refactoring Plan: Replace Global Session Map with MQEmitter Pub/Sub

## Current State Analysis

The current implementation in `src/index.ts:592` uses a global `Map<string, SSESession>` stored directly on the Fastify instance:

```typescript
app.decorate('mcpSessions', new Map<string, SSESession>())
```

This creates tight coupling and prevents horizontal scaling since sessions are stored in memory on a single process.

## MQEmitter Architecture Overview

MQEmitter provides a message queue with emitter-style API supporting:
- Topic-based pub/sub with wildcards (`+` for single level, `#` for multiple levels)
- Redis backend for horizontal scaling via `mqemitter-redis`
- Callback-based async operations
- Topic format: `topic/subtopic/action` with `/` separator

## Refactoring Strategy

### Phase 1: Session Metadata Store Interface

Create a lightweight store for session metadata only (no stream references):

```typescript
interface SessionMetadata {
  id: string
  eventId: number
  lastEventId?: string
  createdAt: Date
  lastActivity: Date
}

interface SessionStore {
  create(metadata: SessionMetadata): Promise<void>
  get(sessionId: string): Promise<SessionMetadata | null>
  update(sessionId: string, metadata: SessionMetadata): Promise<void>
  delete(sessionId: string): Promise<void>
  cleanup(): Promise<void>
  
  // Message history operations
  addMessage(sessionId: string, eventId: string, message: JSONRPCMessage): Promise<void>
  getMessagesFrom(sessionId: string, fromEventId: string): Promise<Array<{ eventId: string, message: JSONRPCMessage }>>
  trimMessageHistory(sessionId: string, maxMessages: number): Promise<void>
}
```

**Implementations:**
- `MemorySessionStore`: Current in-memory Map behavior (without streams)
- `RedisSessionStore`: Redis-backed store for horizontal scaling

**Message History Storage in Redis:**

Redis Streams provide the ideal data structure for message history:

```typescript
// RedisSessionStore implementation details
class RedisSessionStore {
  async addMessage(sessionId: string, eventId: string, message: JSONRPCMessage): Promise<void> {
    // Use Redis Stream with custom ID format: eventId-0
    await this.redis.xadd(`session:${sessionId}:history`, `${eventId}-0`, 'message', JSON.stringify(message))
  }

  async getMessagesFrom(sessionId: string, fromEventId: string): Promise<Array<{ eventId: string, message: JSONRPCMessage }>> {
    // XRANGE to get messages after specific event ID
    const results = await this.redis.xrange(`session:${sessionId}:history`, `(${fromEventId}-0`, '+')
    return results.map(([id, fields]) => ({
      eventId: id.split('-')[0], // Extract eventId from stream ID
      message: JSON.parse(fields[1])
    }))
  }

  async trimMessageHistory(sessionId: string, maxMessages: number): Promise<void> {
    // XTRIM to keep only recent messages
    await this.redis.xtrim(`session:${sessionId}:history`, 'MAXLEN', '~', maxMessages)
  }
}
```

**Benefits of Redis Streams for Message History:**
- **Chronological ordering**: Messages are naturally ordered by creation time
- **Efficient replay**: XRANGE allows reading from any event ID with minimal overhead
- **Memory management**: XTRIM provides built-in message history pruning
- **Atomic operations**: All stream operations are atomic at the Redis level
- **Resumability**: Perfect support for SSE Last-Event-ID reconnection pattern

### Phase 2: Message Broadcasting Interface

Replace direct session iteration with pub/sub pattern:

```typescript
interface MessageBroker {
  publish(topic: string, message: JSONRPCMessage): Promise<void>
  subscribe(topic: string, handler: (message: JSONRPCMessage) => void): Promise<void>
  unsubscribe(topic: string): Promise<void>
  close(): Promise<void>
}
```

**Topic Structure:**
- `mcp/session/{sessionId}/message` - Messages to specific session
- `mcp/broadcast/notification` - Global notifications
- `mcp/session/{sessionId}/connect` - Session connection events
- `mcp/session/{sessionId}/disconnect` - Session disconnection events

**Implementations:**
- `MemoryMessageBroker`: Local MQEmitter instance
- `RedisMessageBroker`: MQEmitter with Redis backend

### Phase 3: Stream Management via Pub/Sub

**Key Insight**: Streams are now managed locally on each server instance through pub/sub subscriptions:

1. **Connection Flow**:
   - Client connects to server instance A
   - Server A subscribes to `mcp/session/{sessionId}/message`
   - Server A maintains local stream reference in memory
   - Server A publishes `mcp/session/{sessionId}/connect` event

2. **Message Flow**:
   - Any server publishes to `mcp/session/{sessionId}/message`
   - Only server A (with active stream) receives and writes to SSE
   - No need to track which server has the stream

3. **Disconnection Flow**:
   - Server A detects stream close
   - Server A unsubscribes from session topic
   - Server A publishes `mcp/session/{sessionId}/disconnect` event

### Phase 4: Plugin Configuration

Add configuration options for scalability:

```typescript
interface MCPPluginOptions {
  // ... existing options
  sessionStore?: 'memory' | 'redis'
  messageBroker?: 'memory' | 'redis'
  redis?: {
    host: string
    port: number
    password?: string
    db?: number
  }
}
```

### Phase 5: Implementation Details

**File Structure:**
```
src/
├── stores/
│   ├── session-store.ts        # Interface definition
│   ├── memory-session-store.ts # In-memory implementation
│   └── redis-session-store.ts  # Redis implementation
├── brokers/
│   ├── message-broker.ts       # Interface definition
│   ├── memory-message-broker.ts # Local MQEmitter
│   └── redis-message-broker.ts  # MQEmitter Redis
└── index.ts                    # Updated plugin
```

**Key Changes in `index.ts`:**

1. Replace `app.mcpSessions` Map with SessionStore interface for metadata only
2. Replace `sendSSEMessage` with MessageBroker.publish to session topic
3. Replace `mcpBroadcastNotification` with MessageBroker.publish to broadcast topic
4. Add local `Map<string, Set<FastifyReply>>` for active streams per server instance
5. Subscribe to session-specific topics when streams connect
6. Remove global session tracking - use pub/sub for message delivery

**New Message Flow:**
1. **Client connects**: 
   - Server creates local stream reference
   - Server subscribes to `mcp/session/{id}/message`
   - Server stores/updates session metadata in SessionStore
2. **Send to session**: 
   - Any server calls MessageBroker.publish('mcp/session/{id}/message', message)
   - Only server with active stream receives and writes to SSE
3. **Broadcast notification**: 
   - Any server calls MessageBroker.publish('mcp/broadcast/notification', message)
   - All servers with active sessions write to their local streams
4. **Client disconnects**:
   - Server unsubscribes from session topic
   - Server removes local stream reference
   - Server optionally cleans up session metadata

### Phase 6: Dependencies

Add required packages:
```json
{
  "dependencies": {
    "mqemitter": "^5.0.0",
    "mqemitter-redis": "^6.0.0",
    "ioredis": "^5.0.0"
  }
}
```

### Phase 7: Migration Strategy

1. **Backward Compatibility**: Default to memory implementations
2. **Feature Flag**: Enable Redis via configuration
3. **Gradual Rollout**: Test memory implementations first, then Redis
4. **Monitoring**: Add metrics for session store and message broker performance

### Benefits

- **Horizontal Scaling**: Multiple server instances can share sessions via Redis
- **Decoupling**: Session management separated from Fastify instance
- **Testing**: Easier to unit test with interface abstractions
- **Performance**: MQEmitter's efficient topic matching
- **Reliability**: Redis persistence for session durability

This plan maintains backward compatibility while enabling horizontal scaling through Redis-backed session management and message broadcasting.