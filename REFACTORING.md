# Refactoring Plan: Split src/index.ts

## Overview
The current `src/index.ts` file contains 648 lines and handles multiple responsibilities. This plan outlines how to split it into focused, maintainable modules.

## Current Structure Analysis
The file currently contains:
- Type definitions and interfaces (lines 32-76)
- Core MCP request/response handlers (lines 94-285)
- SSE session management (lines 287-396)
- HTTP route handlers (lines 398-590)
- Fastify decorators and plugin setup (lines 592-647)

## Proposed File Structure

### 1. `src/types.ts`
**Purpose**: Centralize all type definitions and interfaces
**Content**:
- `ToolHandler`, `ResourceHandler`, `PromptHandler` types (lines 43-45)
- `MCPTool`, `MCPResource`, `MCPPrompt` interfaces (lines 47-60)
- `MCPPluginOptions` interface (lines 62-67)
- `SSESession` interface (lines 69-75)
- Fastify module augmentation (lines 32-41)

### 2. `src/handlers/mcp-handlers.ts`
**Purpose**: Core MCP protocol request/response handling
**Content**:
- `createResponse()` and `createError()` utility functions (lines 94-108)
- `handleRequest()` function with all MCP method implementations (lines 110-285)
- `handleNotification()` function (lines 287-298)
- `processMessage()` function (lines 300-309)

### 3. `src/session/sse-session.ts`
**Purpose**: SSE session management and utilities
**Content**:
- `createSSESession()` function (lines 311-322)
- `supportsSSE()` function (lines 324-327)
- `hasActiveSSESession()` function (lines 329-333)
- `replayMessagesFromEventId()` function (lines 335-359)
- `sendSSEMessage()` function (lines 361-396)

### 4. `src/routes/mcp-routes.ts`
**Purpose**: HTTP route handlers for MCP endpoints
**Content**:
- POST `/mcp` route handler (lines 398-489)
- GET `/mcp` route handler (lines 492-590)
- Route-specific helper functions

### 5. `src/decorators/mcp-decorators.ts`
**Purpose**: Fastify decorators for MCP functionality
**Content**:
- `mcpSessions` decorator (line 592)
- `mcpBroadcastNotification()` decorator (lines 594-605)
- `mcpSendToSession()` decorator (lines 607-620)
- `mcpAddTool()` decorator (lines 622-628)
- `mcpAddResource()` decorator (lines 630-636)
- `mcpAddPrompt()` decorator (lines 638-644)

### 6. `src/index.ts` (refactored)
**Purpose**: Main plugin entry point and orchestration
**Content**:
- Import all modules
- Plugin options processing
- Initialize maps and state
- Register routes and decorators
- Export the plugin

## Implementation Steps

1. **Create `src/types.ts`**
   - Move all interfaces and type definitions
   - Export all types for use in other modules

2. **Create `src/handlers/mcp-handlers.ts`**
   - Move core MCP protocol handling logic
   - Accept dependencies as parameters (tools, resources, prompts maps)
   - Return pure functions that can be easily tested

3. **Create `src/session/sse-session.ts`**
   - Move SSE-related functionality
   - Make functions accept session management dependencies
   - Ensure proper separation of concerns

4. **Create `src/routes/mcp-routes.ts`**
   - Move route handlers
   - Accept handler functions as dependencies
   - Keep routes focused on HTTP concerns only

5. **Create `src/decorators/mcp-decorators.ts`**
   - Move all Fastify decorators
   - Accept maps and configuration as parameters
   - Return decorator registration functions

6. **Refactor `src/index.ts`**
   - Import and orchestrate all modules
   - Maintain the same plugin interface
   - Ensure backward compatibility

## Benefits of This Refactoring

### Maintainability
- Each file has a single, clear responsibility
- Easier to locate and modify specific functionality
- Reduced cognitive load when working on individual features

### Testability
- Individual modules can be unit tested in isolation
- Handler functions become pure and predictable
- Easier to mock dependencies in tests

### Reusability
- SSE session management could be reused in other contexts
- MCP handlers could be used with different HTTP frameworks
- Type definitions are centralized and consistent

### Code Organization
- Related functionality is grouped together
- Clear separation between HTTP, protocol, and session concerns
- Follows single responsibility principle

## Detailed Implementation Plan

### Step 1: Create `src/types.ts`
1. Create new file `src/types.ts`
2. Move Fastify module augmentation (lines 32-41)
3. Move handler type definitions (lines 43-45)
4. Move interface definitions (lines 47-75)
5. Export all types

### Step 2: Create `src/handlers/mcp-handlers.ts`
1. Create new file `src/handlers/mcp-handlers.ts`
2. Import necessary types from `./types.ts` and `./schema.ts`
3. Move `createResponse()` function (lines 94-99)
4. Move `createError()` function (lines 102-108)
5. Move `handleRequest()` function (lines 110-285)
6. Move `handleNotification()` function (lines 287-298)
7. Move `processMessage()` function (lines 300-309)
8. Refactor functions to accept dependencies as parameters

### Step 3: Create `src/session/sse-session.ts`
1. Create new file `src/session/sse-session.ts`
2. Import necessary types from `./types.ts`
3. Move `createSSESession()` function (lines 311-322)
4. Move `supportsSSE()` function (lines 324-327)
5. Move `hasActiveSSESession()` function (lines 329-333)
6. Move `replayMessagesFromEventId()` function (lines 335-359)
7. Move `sendSSEMessage()` function (lines 361-396)
8. Make functions accept session map as parameter

### Step 4: Create `src/routes/mcp-routes.ts`
1. Create new file `src/routes/mcp-routes.ts`
2. Import dependencies from other modules
3. Move POST `/mcp` route handler (lines 398-489)
4. Move GET `/mcp` route handler (lines 492-590)
5. Create route registration function that accepts handlers

### Step 5: Create `src/decorators/mcp-decorators.ts`
1. Create new file `src/decorators/mcp-decorators.ts`
2. Import necessary types
3. Move decorator functions (lines 594-644)
4. Create decorator registration function

### Step 6: Refactor `src/index.ts`
1. Import all new modules
2. Keep plugin options processing
3. Initialize maps and state
4. Wire up dependencies between modules
5. Register routes and decorators
6. Maintain the same plugin export interface

### Step 7: Testing and Validation
1. Run `npm run build` to check TypeScript compilation
2. Run `npm run test` to verify functionality
3. Run `npm run lint` to check code style
4. Run `npm run typecheck` for type validation

## Backward Compatibility
- The plugin interface remains unchanged
- All exported functionality stays the same
- No breaking changes for users of the library