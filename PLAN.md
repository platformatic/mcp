# Implementation Plan: Update to MCP Specification 2025-06-18

## Overview

This plan outlines the changes needed to update the fastify-mcp implementation from MCP specification version 2025-03-26 to 2025-06-18. The analysis shows that while the core implementation remains largely compatible, several updates are required to align with the new specification.

## Current Implementation Status

The codebase currently implements:
- ✅ Core JSON-RPC 2.0 protocol 
- ✅ Base lifecycle management (initialize, ping)
- ✅ Server capabilities (tools, resources, prompts, logging)
- ✅ Client capabilities (sampling, roots)
- ✅ Progress tracking and cancellation
- ✅ SSE support with session management
- ✅ Redis-based horizontal scaling

## Required Changes

### 1. Protocol Version Update

**Current State**: `LATEST_PROTOCOL_VERSION = '2025-03-26'`
**Required**: Update to `'2025-06-18'`

**Files to Update**:
- `src/schema.ts`: Update `LATEST_PROTOCOL_VERSION` constant

### 2. Client Capabilities Enhancement

**Current State**: Missing `elicitation` capability support
**Required**: Add elicitation capability definition and implementation

**Changes Needed**:
- Update `ClientCapabilities` interface in `src/schema.ts`
- Add elicitation capability to capability declarations
- Implement elicitation request/response types
- Add elicitation handling in `src/handlers.ts`

### 3. Enhanced Security Documentation

**Current State**: Basic MCP protocol implementation
**Required**: Enhanced security practices alignment

**Changes Needed**:
- Review current tool annotations for security hints
- Ensure proper validation of untrusted inputs
- Add security-focused documentation updates in README/docs
- Review and enhance error handling for security implications

### 4. New Client Feature Support

**Issue**: Elicitation is a new client feature introduced in 2025-06-18
**Required**: Full elicitation support implementation

**Implementation Details**:
- Elicitation allows servers to request additional information from users through clients
- Servers can request structured data using JSON schemas
- Clients maintain control over user interactions and data sharing
- Must include proper security warnings and user consent mechanisms

### 5. Enhanced Tool Annotations

**Current State**: Basic tool annotations with hints
**Required**: Ensure compatibility with enhanced security model

**Changes Needed**:
- Review `ToolAnnotations` interface for any new security-related fields
- Update tool registration to properly handle security annotations
- Ensure proper handling of untrusted tool descriptions

## Implementation Steps

### Phase 1: Core Protocol Updates
1. Update protocol version constant
2. Update schema version references in documentation
3. Run existing tests to ensure backward compatibility

### Phase 2: Elicitation Feature Implementation
1. Add elicitation types to schema:
   - `ElicitationRequest` interface
   - `ElicitationResult` interface  
   - `ElicitationCapability` interface
2. Update `ClientCapabilities` to include elicitation
3. Implement elicitation handlers in request processing
4. Add elicitation method support to plugin decorators
5. Create comprehensive tests for elicitation feature

### Phase 3: Security Enhancements
1. Review and update security-related tool annotations
2. Enhance validation for untrusted inputs
3. Add security warnings to documentation
4. Update examples to demonstrate security best practices

### Phase 4: Documentation and Examples
1. Update README with new protocol version
2. Update spec documentation references
3. Add elicitation usage examples
4. Update security documentation
5. Add migration guide for existing users

### Phase 5: Testing and Validation
1. Create comprehensive test suite for elicitation
2. Test backward compatibility with existing implementations
3. Validate against 2025-06-18 specification requirements
4. Performance testing for new features

## Breaking Changes Assessment

**Good News**: The update appears to be largely backward compatible.

**Potential Breaking Changes**:
- Protocol version negotiation may reject older clients expecting 2025-03-26
- New elicitation capability may cause issues with clients that don't support it
- Enhanced security validation might be stricter

**Mitigation Strategy**:
- Implement graceful fallback for protocol version negotiation
- Make elicitation capability optional and backward-compatible
- Ensure security enhancements don't break existing valid usage

## Timeline Considerations

The implementation should be approached incrementally:

1. **Low Risk Changes** (Protocol version, documentation updates)
2. **Medium Risk Changes** (Elicitation implementation, capability updates)  
3. **High Risk Changes** (Security enhancements, validation changes)

Each phase should include comprehensive testing before proceeding to the next.

## Success Criteria

- [ ] All existing tests pass with new implementation
- [ ] Protocol version correctly reports 2025-06-18
- [ ] Elicitation feature works as specified
- [ ] Enhanced security practices are implemented
- [ ] Documentation is updated and accurate
- [ ] Backward compatibility is maintained where expected
- [ ] New features are properly tested

## Risk Mitigation

- Implement feature flags for new functionality during development
- Maintain comprehensive test coverage throughout implementation
- Create migration guide for users upgrading from 2025-03-26
- Consider implementing both protocol versions temporarily during transition period