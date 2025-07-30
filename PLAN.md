# Token Refresh Service Scaling Plan

## Problem Statement

The current `TokenRefreshService` implementation uses `setInterval()` to periodically check for expiring tokens. In a multi-instance deployment, this creates a scaling issue:

- **Multiple refresh attempts**: Each server instance runs its own interval timer
- **Race conditions**: Multiple instances may attempt to refresh the same token simultaneously  
- **Redundant API calls**: Authorization servers receive duplicate refresh requests
- **Resource waste**: Unnecessary network calls and processing overhead

## Current Implementation Issues

```typescript
// Each instance runs this independently
this.intervalId = setInterval(() => {
  this.checkAndRefreshTokens().catch(error => {
    // Multiple instances execute this concurrently
  })
}, this.checkIntervalMs)
```

## Solution: Distributed Token Refresh Coordination

### Option 1: Redis-Based Distributed Locking (Recommended)

Implement distributed locking using Redis to ensure only one instance handles token refresh at a time.

#### Implementation Strategy

1. **Distributed Lock Acquisition**
   ```typescript
   // Use Redis SET with NX and EX for atomic lock acquisition
   const lockKey = `token-refresh:lock:${Math.floor(Date.now() / checkIntervalMs)}`
   const lockAcquired = await redis.set(lockKey, instanceId, 'NX', 'EX', lockDurationSeconds)
   ```

2. **Leader Election Pattern**
   - Only the instance that acquires the lock performs token refresh
   - Lock expires automatically to handle instance failures
   - Failed instances can attempt to acquire the lock in the next cycle

3. **Token Refresh Coordination**
   ```typescript
   async checkAndRefreshTokens(): Promise<void> {
     const lockKey = `token-refresh:lock:${this.getLockWindow()}`
     const acquired = await this.acquireLock(lockKey)
     
     if (!acquired) {
       this.fastify?.log.debug('Token refresh lock not acquired, skipping cycle')
       return
     }
     
     try {
       // Only this instance performs token refresh
       await this.performTokenRefresh()
     } finally {
       await this.releaseLock(lockKey)
     }
   }
   ```

#### Benefits
- **No race conditions**: Only one instance refreshes tokens
- **Fault tolerance**: Automatic failover if leader instance fails
- **Minimal overhead**: Failed lock acquisitions are lightweight Redis operations
- **Configurable timing**: Lock duration can be tuned based on refresh interval

### Option 2: Redis Pub/Sub Coordination

Use Redis pub/sub to coordinate token refresh across instances.

#### Implementation Strategy

1. **Refresh Request Broadcasting**
   ```typescript
   // Leader publishes refresh requests
   await redis.publish('token-refresh:schedule', JSON.stringify({
     timestamp: Date.now(),
     instanceId: this.instanceId
   }))
   ```

2. **Instance Coordination**
   - One instance (determined by lowest instance ID or election) becomes the scheduler
   - Scheduler publishes refresh events on a schedule
   - All instances subscribe and perform refresh only when they receive the event

#### Benefits
- **Event-driven**: More responsive than polling
- **Decoupled**: Scheduler and refresher can be different instances
- **Scalable**: Easy to add more instances

#### Drawbacks
- **Complexity**: More complex than locking approach
- **Network overhead**: More Redis network traffic

### Option 3: Database-Based Coordination

Use Redis (or database) as a coordination mechanism with timestamps.

#### Implementation Strategy

1. **Refresh State Tracking**
   ```typescript
   const refreshState = await redis.hgetall('token-refresh:state')
   const lastRefreshTime = parseInt(refreshState.lastRefresh || '0')
   const refreshInProgress = refreshState.inProgress === 'true'
   ```

2. **Coordinated Refresh Logic**
   ```typescript
   if (Date.now() - lastRefreshTime > this.checkIntervalMs && !refreshInProgress) {
     await redis.hset('token-refresh:state', {
       inProgress: 'true',
       instanceId: this.instanceId,
       startTime: Date.now().toString()
     })
     
     try {
       await this.performTokenRefresh()
       await redis.hset('token-refresh:state', {
         lastRefresh: Date.now().toString(),
         inProgress: 'false'
       })
     } catch (error) {
       await redis.hdel('token-refresh:state', 'inProgress')
       throw error
     }
   }
   ```

## Recommended Implementation: Redis Distributed Locking

### Phase 1: Implement Distributed Locking

1. **Create DistributedLock utility**
   ```typescript
   // src/utils/distributed-lock.ts
   export class DistributedLock {
     constructor(private redis: Redis, private lockPrefix: string) {}
     
     async acquire(key: string, ttlSeconds: number): Promise<boolean>
     async release(key: string): Promise<void>
     async extend(key: string, ttlSeconds: number): Promise<boolean>
   }
   ```

2. **Update TokenRefreshService**
   ```typescript
   // src/auth/token-refresh-service.ts
   export class TokenRefreshService {
     private distributedLock?: DistributedLock
     
     constructor(options: TokenRefreshServiceOptions) {
       if (options.redis) {
         this.distributedLock = new DistributedLock(options.redis, 'token-refresh')
       }
     }
     
     private async checkAndRefreshTokens(): Promise<void> {
       if (this.distributedLock) {
         // Distributed coordination
         await this.checkAndRefreshWithLock()
       } else {
         // Single instance - existing behavior
         await this.performTokenRefresh()
       }
     }
   }
   ```

### Phase 2: Configuration and Monitoring

1. **Add configuration options**
   ```typescript
   interface TokenRefreshServiceOptions {
     // ... existing options
     coordination?: {
       lockTimeoutSeconds?: number  // Default: 30
       maxLockExtensions?: number   // Default: 3
     }
   }
   ```

2. **Add monitoring and logging**
   ```typescript
   this.fastify.log.info({
     lockAcquired: true,
     instanceId: this.instanceId,
     tokensToRefresh: refreshQueue.length
   }, 'Token refresh coordination acquired')
   ```

### Phase 3: Testing and Validation

1. **Multi-instance integration tests**
   - Test with 2-3 FastifyInstance processes
   - Verify only one instance performs refresh
   - Test failover when leader instance stops

2. **Load testing**
   - Test with realistic token volumes
   - Measure refresh coordination overhead
   - Validate no duplicate refresh attempts

## Implementation Timeline

- **Week 1**: Implement DistributedLock utility and basic coordination
- **Week 2**: Update TokenRefreshService with distributed locking
- **Week 3**: Add configuration, monitoring, and error handling
- **Week 4**: Comprehensive testing and performance validation

## Success Criteria

- ✅ Only one instance refreshes tokens in multi-instance deployment
- ✅ Automatic failover when leader instance fails
- ✅ No race conditions or duplicate refresh attempts
- ✅ Minimal performance overhead (< 10ms per coordination cycle)
- ✅ Comprehensive test coverage for multi-instance scenarios
- ✅ Clear monitoring and logging for troubleshooting

## Risk Mitigation

- **Redis failure**: Graceful degradation to allow all instances to refresh (better than no refresh)
- **Lock timeout**: Configurable timeout with automatic extension for long-running refreshes
- **Instance failure**: Lock expiration ensures other instances can take over
- **Performance impact**: Lightweight Redis operations with minimal overhead