# Refactoring Plan: Replace Global Session Map with MQEmitter Pub/Sub

## Current Implementation Status

✅ **COMPLETED**: Core pub/sub architecture fully implemented with memory backends  
✅ **COMPLETED**: Session metadata store abstraction with message history  
✅ **COMPLETED**: Local stream management per server instance  
✅ **COMPLETED**: Topic-based message routing (`mcp/session/{id}/message`, `mcp/broadcast/notification`)  
✅ **COMPLETED**: SSE connection handling with session subscriptions  
✅ **COMPLETED**: Message replay for Last-Event-ID resumability  
✅ **COMPLETED**: Backward compatibility maintained (100% existing behavior preserved)  
❌ **PENDING**: Redis implementations for horizontal scaling  
❌ **PENDING**: Configuration selection logic  
❌ **PENDING**: Integration tests for Redis backends  

## Current Architecture Overview

The refactoring is **successfully completed** for single-instance deployments with **full horizontal scaling architecture** in place. The implementation is ready for Redis backends to be added without breaking changes.

### Core Components Implemented

**Session Management:**
- `SessionStore` interface with `MemorySessionStore` implementation
- Session metadata storage separate from stream references
- Message history storage with automatic trimming (configurable limit)
- Session cleanup for expired sessions (1 hour timeout)

**Message Broadcasting:**
- `MessageBroker` interface with `MemoryMessageBroker` implementation  
- Topic-based pub/sub using MQEmitter
- Session-specific topics: `mcp/session/{sessionId}/message`
- Broadcast topics: `mcp/broadcast/notification`

**Stream Management:**
- Local `Map<string, Set<FastifyReply>>` for active streams per server
- Session-specific subscriptions on connection
- Automatic cleanup on disconnection
- No global session tracking required

**SSE Integration:**
- Complete SSE support with session management
- Message replay using `getMessagesFrom` for Last-Event-ID resumability
- Heartbeat mechanism for connection health
- Support for both GET and POST endpoints

### File Structure (Current)

```
src/
├── brokers/
│   ├── message-broker.ts          # ✅ Interface definition
│   └── memory-message-broker.ts   # ✅ MQEmitter implementation
├── stores/
│   ├── session-store.ts           # ✅ Interface definition  
│   └── memory-session-store.ts    # ✅ In-memory implementation
├── decorators/
│   ├── decorators.ts              # ✅ Core MCP decorators
│   └── pubsub-decorators.ts       # ✅ Pub/sub decorators
├── handlers.ts                    # ✅ MCP protocol handlers
├── routes.ts                      # ✅ SSE connection handling
├── index.ts                       # ✅ Plugin entry point
├── schema.ts                      # ✅ MCP protocol types
└── types.ts                       # ✅ Plugin types
```

## Implementation Details

### Message Flow (Current)

1. **Client Connection**:
   - Server creates session metadata in `SessionStore`
   - Server subscribes to `mcp/session/{sessionId}/message` topic
   - Server adds stream to local `localStreams` Map
   - Server can replay message history using `getMessagesFrom`

2. **Message Delivery**:
   - Any server publishes to `mcp/session/{sessionId}/message` via `MessageBroker`
   - Only server with active stream receives message and writes to SSE
   - Session metadata updated with `lastEventId` and `lastActivity`

3. **Broadcast Notifications**:
   - Any server publishes to `mcp/broadcast/notification` topic
   - All servers with active sessions receive and forward to their local streams

4. **Client Disconnection**:
   - Server unsubscribes from session topic
   - Server removes stream from local `localStreams` Map
   - Session metadata persists for reconnection (not deleted)

### Interface Improvements Made

**SessionStore Interface Simplification:**
- ✅ Removed `update()` method (handled automatically in `addMessage`)
- ✅ Removed `trimMessageHistory()` method (handled automatically with `maxMessages`)
- ✅ Added constructor parameter for `maxMessages` configuration
- ✅ Atomic operations in `addMessage` prevent race conditions

**Current SessionStore Interface:**
```typescript
interface SessionStore {
  create(metadata: SessionMetadata): Promise<void>
  get(sessionId: string): Promise<SessionMetadata | null>
  delete(sessionId: string): Promise<void>
  cleanup(): Promise<void>
  
  // Message history operations
  addMessage(sessionId: string, eventId: string, message: JSONRPCMessage): Promise<void>
  getMessagesFrom(sessionId: string, fromEventId: string): Promise<Array<{ eventId: string, message: JSONRPCMessage }>>
}
```

### Key Architecture Benefits Achieved

- ✅ **Horizontal Scaling Ready**: Architecture supports Redis backends
- ✅ **Clean Separation**: Session metadata separate from stream management  
- ✅ **Pub/Sub Decoupling**: Message delivery through topics, not direct session access
- ✅ **Resumable SSE**: Message history enables Last-Event-ID reconnection
- ✅ **Local Stream Efficiency**: Each server instance only manages its own streams
- ✅ **Backward Compatible**: Existing behavior preserved with memory implementations
- ✅ **Race Condition Free**: Atomic operations in session updates
- ✅ **Memory Efficient**: Automatic message history trimming

## Remaining Work for Full Horizontal Scaling

### Phase 4: Redis Implementations (Not Started)

**Required Files:**
```
src/
├── brokers/
│   └── redis-message-broker.ts    # ❌ MQEmitter Redis backend
└── stores/
    └── redis-session-store.ts     # ❌ Redis-backed session store
```

**RedisSessionStore Implementation Plan:**
```typescript
class RedisSessionStore implements SessionStore {
  // Use Redis Hash for session metadata
  async create(metadata: SessionMetadata): Promise<void> {
    await this.redis.hset(`session:${metadata.id}`, metadata)
  }
  
  // Use Redis Streams for message history
  async addMessage(sessionId: string, eventId: string, message: JSONRPCMessage): Promise<void> {
    await this.redis.xadd(`session:${sessionId}:history`, `${eventId}-0`, 'message', JSON.stringify(message))
    await this.redis.xtrim(`session:${sessionId}:history`, 'MAXLEN', '~', this.maxMessages)
  }
  
  // Use Redis XRANGE for message replay
  async getMessagesFrom(sessionId: string, fromEventId: string): Promise<Array<{ eventId: string, message: JSONRPCMessage }>> {
    const results = await this.redis.xrange(`session:${sessionId}:history`, `(${fromEventId}-0`, '+')
    return results.map(([id, fields]) => ({
      eventId: id.split('-')[0],
      message: JSON.parse(fields[1])
    }))
  }
}
```

**RedisMessageBroker Implementation Plan:**
```typescript
class RedisMessageBroker implements MessageBroker {
  constructor(private redis: Redis) {
    this.emitter = mqemitter({
      redis: redis,
      // Additional mqemitter-redis configuration
    })
  }
  
  async publish(topic: string, message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      this.emitter.emit({ topic, message }, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }
  
  // ... rest of implementation
}
```

### Phase 5: Configuration Selection (Not Started)

**Required Changes to `src/index.ts`:**
```typescript
export default fp(async function (app: FastifyInstance, opts: MCPPluginOptions) {
  // ... existing code ...
  
  // Add Redis configuration logic
  let sessionStore: SessionStore
  let messageBroker: MessageBroker
  
  if (opts.redis) {
    // Redis implementations
    sessionStore = new RedisSessionStore(opts.redis)
    messageBroker = new RedisMessageBroker(opts.redis)
  } else {
    // Memory implementations (current)
    sessionStore = new MemorySessionStore(100)
    messageBroker = new MemoryMessageBroker()
  }
  
  // ... rest of plugin setup ...
})
```

### Phase 6: Dependencies (Not Started)

**Required Package Additions:**
```json
{
  "dependencies": {
    "mqemitter-redis": "^6.0.0",
    "ioredis": "^5.0.0"
  }
}
```

### Phase 7: Testing & Documentation (Not Started)

**Required Testing:**
- [ ] Integration tests for Redis implementations
- [ ] Multi-instance scaling tests
- [ ] Message replay functionality tests
- [ ] Session failover tests
- [ ] Performance benchmarks

**Required Documentation:**
- [ ] Redis deployment guide
- [ ] Horizontal scaling setup instructions
- [ ] Migration guide from single to multi-instance
- [ ] Monitoring and troubleshooting guide

## Summary

The core architecture refactoring is **100% complete** and successfully implements:
- ✅ Pub/sub message broadcasting
- ✅ Session metadata abstraction
- ✅ Local stream management
- ✅ Message history for SSE resumability
- ✅ Backward compatibility
- ✅ Horizontal scaling architecture

The implementation is **production-ready** for single-instance deployments and **architecture-ready** for horizontal scaling. Adding Redis backends requires no changes to the core interfaces or routing logic.