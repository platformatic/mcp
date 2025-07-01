# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is a Fastify adapter for the Model Context Protocol (MCP). The project implements a Fastify plugin that enables MCP communication through the JSON-RPC 2.0 specification. The codebase includes MCP protocol specifications in the `spec/` directory that define the messaging format, lifecycle management, and various protocol features.

## Development Commands

- **Build**: `npm run build` - Compiles TypeScript to `dist/` directory
- **Lint**: `npm run lint` - Run ESLint with caching
- **Lint Fix**: `npm run lint:fix` - Run ESLint with auto-fix
- **Type Check**: `npm run typecheck` - Run TypeScript compiler without emitting files
- **Test**: `npm run test` - Run Node.js test runner on test files
- **CI**: `npm run ci` - Full CI pipeline (build + lint + test)

## Architecture

The main entry point is `src/index.ts` which exports a Fastify plugin built with `fastify-plugin`. The plugin structure follows Fastify's standard plugin pattern with proper TypeScript types.

The complete MCP protocol TypeScript definitions are in `src/schema.ts`, which includes:
- JSON-RPC 2.0 message types (requests, responses, notifications, batches)
- MCP protocol lifecycle (initialization, capabilities, ping)
- Core features: resources, prompts, tools, logging, sampling
- Client/server request/response/notification types
- Content types (text, image, audio, embedded resources)
- Protocol constants and error codes

Key dependencies:
- `fastify-plugin` for plugin registration
- `typed-rpc` for RPC communication
- `neostandard` for ESLint configuration

The project uses ESM modules (`"type": "module"`) and includes comprehensive MCP protocol specifications in markdown format under `spec/` covering the same areas as the TypeScript schema.

## TypeScript Configuration

Uses a base TypeScript configuration (`tsconfig.base.json`) extended by the main `tsconfig.json`. The build targets ES modules with strict type checking enabled.