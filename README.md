# Fastify MCP Server

A Fastify plugin that implements the Model Context Protocol (MCP) server using JSON-RPC 2.0. This plugin enables Fastify applications to expose tools, resources, and prompts following the MCP **2026-07-28** specification, while continuing to serve clients that speak the earlier handshake-based revisions on the same endpoint.

## Installation

```bash
npm install @platformatic/mcp
```

### TypeBox Support (Optional)

For type-safe schema validation, install TypeBox:

```bash
npm install @sinclair/typebox
```

## Features

- **MCP 2026-07-28 Support**: Stateless per-request protocol with `server/discover`, multi round-trip requests, `subscriptions/listen`, cacheable results and header-based routing
- **Dual-era**: The same endpoint serves 2026-07-28 statelessly *and* answers `initialize` for `2025-11-25`, `2025-06-18`, `2025-03-26` and `2024-11-05` clients
- **Multi Round-Trip Requests**: Handlers ask for elicitation, sampling or roots by throwing `InputRequired`; state travels through the client, integrity-protected
- **Tasks Extension**: `io.modelcontextprotocol/tasks` with `tasks/get` polling, `tasks/update` and `tasks/cancel`
- **Elicitation Support**: Server-to-client information requests in both form and URL mode, with schema validation
- **Icons**: Optional icon metadata on tools, resources, resource templates and prompts
- **TypeBox Validation**: Type-safe schema validation with automatic TypeScript inference
- **Security Enhancements**: Input sanitization, rate limiting, and security assessment
- **Multiple Transport Support**: HTTP/SSE and stdio transports for flexible communication
- **SSE Streaming**: Server-Sent Events for real-time communication
- **Horizontal Scaling**: Redis-backed session management and message broadcasting
- **Session Persistence**: Message history and reconnection support with Last-Event-ID
- **Memory & Redis Backends**: Seamless switching between local and distributed storage
- **Production Ready**: Comprehensive test coverage, security features, and authentication support

## Quick Start

```typescript
import Fastify from 'fastify'
import mcpPlugin from '@platformatic/mcp'
// Or use named import:
// import { mcpPlugin } from '@platformatic/mcp'

const app = Fastify({ logger: true })

// Register the MCP plugin
await app.register(mcpPlugin, {
  serverInfo: {
    name: 'my-mcp-server',
    version: '1.0.0'
  },
  capabilities: {
    tools: { listChanged: true },
    resources: { subscribe: true },
    prompts: {}
  },
  instructions: 'This server provides custom tools and resources'
})

// Add tools, resources, and prompts with handlers
app.mcpAddTool({
  name: 'calculator',
  description: 'Performs basic arithmetic operations',
  inputSchema: {
    type: 'object',
    properties: {
      operation: { type: 'string', enum: ['add', 'subtract', 'multiply', 'divide'] },
      a: { type: 'number' },
      b: { type: 'number' }
    },
    required: ['operation', 'a', 'b']
  }
}, async (params) => {
  const { operation, a, b } = params
  let result
  switch (operation) {
    case 'add': result = a + b; break
    case 'subtract': result = a - b; break
    case 'multiply': result = a * b; break
    case 'divide': result = a / b; break
    default: throw new Error('Invalid operation')
  }
  return {
    content: [{ type: 'text', text: `Result: ${result}` }]
  }
})

app.mcpAddResource({
  uri: 'file://config.json',
  name: 'Application Config',
  description: 'Server configuration file',
  mimeType: 'application/json'
}, async (uri, context) => {
  // Read and return the configuration file
  const config = { setting1: 'value1', setting2: 'value2' }
  return {
    contents: [{
      uri,
      text: JSON.stringify(config, null, 2),
      mimeType: 'application/json'
    }]
  }
})

app.mcpAddPrompt({
  name: 'code-review',
  description: 'Generates code review comments',
  arguments: [{
    name: 'language',
    description: 'Programming language',
    required: true
  }]
}, async (name, args, context) => {
  const language = args?.language || 'javascript'
  return {
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: `Please review this ${language} code for best practices, potential bugs, and improvements.`
      }
    }]
  }
})

await app.listen({ port: 3000 })
```

## In-process MCP Client

The plugin decorates the Fastify instance with `mcpClient()`, a client that talks to the
server through `app.inject()` — no port binding, so it's equally useful for tests or for
driving the server from other in-process code.

It accepts both JSON and `text/event-stream` responses; notifications streamed before the
result are returned in `response.notifications`. Pass extra `_meta` (such as a
`progressToken`) with `callTool(name, args, { meta })`. A result with a `resultType` it does
not understand is rejected. It does not retry on its own: on `-32022` pick a version from
`error.data.supported`, and on `-32020` re-run `listTools()` before retrying.

```typescript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import mcpPlugin from '@platformatic/mcp'

test('calls an MCP tool', async (t) => {
  const app: FastifyInstance = Fastify()
  t.after(() => app.close())

  await app.register(mcpPlugin, { enableSSE: true })

  app.mcpAddTool({
    name: 'echo',
    description: 'Echo a message',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string' }
      },
      required: ['message'],
      additionalProperties: false
    }
  }, async ({ message }) => {
    return {
      content: [{ type: 'text', text: message }]
    }
  })

  await app.ready()

  const client = app.mcpClient()

  await client.initialize()

  const response = await client.callTool('echo', {
    message: 'hello'
  })

  assert.equal(response.statusCode, 200)
  assert.ok('result' in response.body)
  assert.deepEqual(response.body.result, {
    content: [{ type: 'text', text: 'hello' }]
  })
})
```

The client defaults to `LATEST_LEGACY_PROTOCOL_VERSION`, so existing code keeps the
handshake and session lifecycle shown above. To use the stateless revision, select it
explicitly and call methods without `initialize()`:

```typescript
import { LATEST_PROTOCOL_VERSION } from '@platformatic/mcp'

const modern = app.mcpClient({
  protocolVersion: LATEST_PROTOCOL_VERSION,
  clientInfo: { name: 'my-client', version: '1.0.0' },
  clientCapabilities: {}
})

const discovery = await modern.discover()
const tools = await modern.listTools()
const result = await modern.callTool('echo', { message: 'hello' })
```

In modern mode the client adds the required per-request `_meta`, `Mcp-Method`, encoded
`Mcp-Name`, and protocol-version headers. Calling `listTools()` also caches tool schemas so a
later `callTool()` can mirror `x-mcp-header` arguments into encoded `Mcp-Param-*` headers.
For a direct call before listing, pass those headers through `callTool(..., { headers })`.
It does not create or send a session; `initialize()` rejects because that method was removed
in `2026-07-28`.

When a call returns `resultType: 'input_required'`, retry it with the returned state and the
client's answers:

```typescript
await modern.callTool('interactive-tool', args, {
  requestState: response.body.result.requestState,
  inputResponses: {
    confirmation: { action: 'accept', content: { confirmed: true } }
  }
})
```

The client:

- Uses `app.inject()` only (no port binding).
- Manages sequential JSON-RPC request IDs per client instance.
- In legacy mode, `initialize()` performs the complete lifecycle handshake (`initialize` plus `notifications/initialized`).
- Rejects a legacy initialization when `notifications/initialized` is not accepted with an empty `202` or `204` response.
- Commits `mcp-session-id` and negotiated protocol version only after the full legacy handshake succeeds.
- Forwards headers passed to `initialize()` to both lifecycle requests, except MCP-managed `mcp-session-id` and `mcp-protocol-version` on `notifications/initialized`.
- Captures committed `mcp-session-id` from successful legacy initialization and sends it automatically on later requests.
- Lets you pass custom headers (including authorization) globally or per request.

Responses are a discriminated union — narrow with `'result' in response.body` or
`'error' in response.body`. Malformed or non-JSON-RPC responses throw a coded Fastify error
instead of returning.

Note: no OAuth/JWT credentials are generated for you.

## Protocol Versions

This plugin is a **dual-era** server, in the spec's terminology. The `2026-07-28` revision
removed the `initialize` handshake, protocol-level sessions, and SSE resumability; rather
than drop the clients that still need them, the same `/mcp` endpoint serves both:

```typescript
import {
  LATEST_PROTOCOL_VERSION,
  LATEST_LEGACY_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS
} from '@platformatic/mcp'

LATEST_PROTOCOL_VERSION         // '2026-07-28'
LATEST_LEGACY_PROTOCOL_VERSION  // '2025-11-25' — newest revision reachable via initialize
SUPPORTED_PROTOCOL_VERSIONS     // ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
```

A request is served as **modern** when its `params._meta` carries
`io.modelcontextprotocol/protocolVersion` or its `MCP-Protocol-Version` header names a modern
revision. A request with neither takes the legacy path, so the two eras can interleave freely
on one server. Header-based detection ensures modern routing headers can never bypass their
required header/body validation.

### Modern requests (2026-07-28)

There is no negotiation step. Every request states what it speaks and what the client can do:

```jsonc
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "get_weather",
    "arguments": { "location": "Seattle" },
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { "name": "ExampleClient", "version": "1.0.0" },
      "io.modelcontextprotocol/clientCapabilities": {}
    }
  }
}
```

sent with these headers, which the server checks against the body:

```http
MCP-Protocol-Version: 2026-07-28
Mcp-Method: tools/call
Mcp-Name: get_weather
```

`protocolVersion` and `clientCapabilities` are required — a request missing either is
answered with `-32602` and HTTP 400. An `initialize` without that `_meta` always takes the
legacy handshake, whatever `MCP-Protocol-Version` header it carries.

A tool parameter annotated with `x-mcp-header` is mirrored into an `Mcp-Param-*` header and
must be a string, integer or boolean: a plain `type`, a nullable one, an `enum`/`const` of one of
those, or a union of such literals (TypeBox's `Type.Union` of `Type.Literal`s). `mcpAddTool`
throws for an annotation the transport cannot mirror, or one not reachable through `properties`
alone, since 2026-07-28 clients could never call that tool. Every result comes back with `resultType`, the server's
identity in `_meta`, and caching hints where the revision defines them.

The status codes matter, because a dual-era *client* uses them to work out which kind of
server it reached:

| Condition | HTTP | JSON-RPC error |
|---|---|---|
| Headers disagree with the body (the version included), or a required one is missing | `400` | `-32020` `HeaderMismatch` |
| Client did not declare a capability the request needs | `400` | `-32021` `MissingRequiredClientCapability` |
| Version unknown or unsupported | `400` | `-32022` `UnsupportedProtocolVersion` |
| Method not implemented, or removed in this revision | `404` | `-32601` `Method not found` |
| Unknown tool, missing resource, failed handler | `200` | `-32602` / `-32603` |

`server/discover` reports everything a client might want up front, and is the probe a
dual-era client uses on stdio:

```bash
curl -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: server/discover' \
  -d '{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":{
        "io.modelcontextprotocol/protocolVersion":"2026-07-28",
        "io.modelcontextprotocol/clientCapabilities":{}}}}'
```

`supportedVersions` (and `data.supported` on `-32022`) lists every revision the server speaks,
legacy ones included, as the specification's own example does. Only `2026-07-28` can be sent
per request in `_meta`; the legacy revisions are reached through `initialize`, so a client that
gets `-32022` for a legacy version should start a handshake rather than retry with `_meta`.

A modern notification (a message without an `id`) is acknowledged with `202` once it is a
well-formed JSON-RPC message; its `_meta` and mirrored headers are not checked, since nothing
is answered to it. A tool with no handler answers `tools/call` with an `isError` result, as on
the legacy path, while a resource or prompt with no handler answers `-32603`. The list
operations return everything in one page and ignore a `cursor`.

### What 2026-07-28 removed

These are answered with `404` and `-32601` on the modern path, and continue to work
unchanged for legacy clients:

| Removed | Replacement |
|---|---|
| `initialize` / `notifications/initialized` | per-request `_meta` |
| `Mcp-Session-Id`, HTTP `GET` and `DELETE` | nothing — the protocol is stateless |
| `ping` | none; use transport-level health checks |
| `logging/setLevel` | `io.modelcontextprotocol/logLevel` in a request's `_meta` |
| `resources/subscribe` / `resources/unsubscribe` | `subscriptions/listen` |
| Server-initiated requests on SSE streams | [multi round-trip requests](#multi-round-trip-requests-2026-07-28) |
| `Last-Event-ID` resumability | re-issue the request with a new id |
| `tasks/result`, `tasks/list` | `tasks/get` polling |

### Legacy requests (2025-11-25 and earlier)

The handshake path is unchanged. The server answers `initialize` with the client's requested
revision when it supports it, and otherwise with `2025-11-25` — never with `2026-07-28`,
which a client sending `initialize` by definition cannot speak.

**Responses are shaped to the revision the client negotiated.** A client on an older revision
never sees a field or method that revision does not define:

| | `< 2025-11-25` | `2025-11-25` |
|---|---|---|
| `tasks` capability | not advertised | advertised |
| `tasks/*` methods | `-32601` method not found | available |
| `task` field on `tools/call` | ignored | honoured |
| `icons` on listings | stripped | present |
| `execution.taskSupport` | stripped | present |
| `$schema` on tool schemas | omitted | JSON Schema 2020-12 |
| URL mode elicitation | refused | available |

The negotiated revision is stored on the session and is **authoritative**:
a request whose `MCP-Protocol-Version` header contradicts what the session agreed is rejected
with `400`, so a client cannot opt into newer behaviour after negotiating an older revision.
When the header is omitted the session's revision is used in preference to the `2025-03-26`
default. `initialize` is exempt, so a client may re-negotiate on an existing session.

> A request sent without an `Mcp-Session-Id` has no session to remember the negotiation, so it
> is judged solely by its header. A client that omits it falls back to `2025-03-26` and will not
> see `2025-11-25` features. Compliant clients always send the header.

## Sessions

Session management is part of the Streamable HTTP transport and works whether or not SSE is
enabled:

- `initialize` on `POST /mcp` creates a session and returns its id in the `Mcp-Session-Id`
  response header. Clients send it back on later requests.
- `DELETE /mcp` with the `Mcp-Session-Id` header terminates the session (`204`), answering
  `404` for an unknown session and `400` when the header is missing.
- `enableSSE` only controls `GET /mcp`. Without it, `GET /mcp` answers `405` with
  `Allow: POST, DELETE`.

With SSE disabled, requests that do not carry an `Mcp-Session-Id` keep working statelessly and
no session is created for them. With SSE enabled, every request without a known session id gets
a new session, as before.

Sessions expire after `sessionTtlMs` milliseconds without activity (default `3600000`, one
hour), so clients that disconnect without sending `DELETE` do not leave sessions behind. Every
request carrying the session id, every message stored for it, and every heartbeat on an open SSE
stream counts as activity, so a session in use is never expired from under a live connection.
The Redis store applies this as the key TTL; the memory store checks it on every read and sweeps
expired sessions on an unref'd timer that is cleared when the server closes.

```typescript
await app.register(mcpPlugin, {
  sessionTtlMs: 15 * 60_000 // expire sessions after 15 idle minutes
})
```

## Request Body Errors

Body-parser failures and bodies that are not JSON-RPC messages on `POST /mcp` are answered
with a JSON-RPC error (with `id: null`) while keeping the HTTP status code:

| Cause | Status | JSON-RPC error |
| --- | --- | --- |
| Malformed or empty JSON | `400` | `-32700` Parse error |
| Body larger than Fastify's `bodyLimit` | `413` | `-32600` Invalid Request |
| Unsupported `Content-Type` | `415` | `-32600` Invalid Request |
| Not a JSON-RPC request, notification or response (`null`, a number, a string, a `text/plain` body, or an object with none of `method`, `result` or `error`) | `400` | `-32600` Invalid Request |

A body that is not a JSON-RPC message is rejected before any SSE session is created for it.
A JSON-RPC response posted by the client is answered with `202` and handed to
`onClientResponse`.

The body-parser error handler is scoped to the `POST /mcp` route. Any other error on that route, and every
error on your other routes, still goes to your own (or Fastify's default) error handler.

## Multi Round-Trip Requests (2026-07-28)

A stateless server cannot hold a request open while it asks the user something. Instead it
ends the request with an interim result, and the client comes back with the answers on a new
one. Handlers express this by throwing `InputRequired`:

```typescript
import mcpPlugin, { InputRequired, elicitForm, type ElicitResult } from '@platformatic/mcp'

app.mcpAddTool({
  name: 'create-issue',
  inputSchema: Type.Object({ title: Type.String() })
}, async (args, context) => {
  // Each answer is the result of the method it asked with: an elicitation
  // answer is an `ElicitResult`, a sampling answer a `CreateMessageResult`.
  const answer = context.inputResponses?.repo as ElicitResult | undefined

  if (!answer) {
    throw new InputRequired({
      inputRequests: {
        repo: elicitForm('Which repository?', {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name']
        })
      },
      // Anything the handler needs to resume. It is signed, not encrypted: the
      // client cannot change it, but can read it, so keep secrets out of it.
      state: { title: args.title }
    })
  }

  // On the retry, `requestState` is the value above, verified and unsealed.
  const { title } = context.requestState as { title: string }
  // The user may decline or cancel: only an accepted answer carries content.
  if (answer.action !== 'accept') {
    return { content: [{ type: 'text', text: 'Cancelled' }], isError: true }
  }
  return { content: [{ type: 'text', text: `Created "${title}" in ${answer.content?.name}` }] }
})
```

Answers are checked before the handler sees them: each must be a result of the method it
answered, and an accepted elicitation must match what was asked — content conforming to the
form's `requestedSchema`, or no content for a URL-mode elicitation. A non-conforming answer is
refused with `-32602`, on a retry and on `tasks/update` alike. Content sent with `decline` or
`cancel` is not checked against the `requestedSchema` (only its shape is), so handlers should
look at `action` first. An input request holding a non-finite number (`Infinity`, `NaN`), in a
`requestedSchema` or in sampling parameters, is the handler's error, since JSON would hand the
client `null` in its place.

An accepted answer may carry properties the form did not ask for, unless its `requestedSchema`
sets `additionalProperties: false`. Pick the fields you asked for rather than spreading
`content` into a record, or a client could set ones you never offered (`isAdmin`, say).

`requestState` is signed, not encrypted. Besides the handler's `state`, a client that decodes it
can read the caller's identity (`userId`, OAuth client id and issuer), the answers being carried
and the forms asked. None of that is more than the client already knows, but do not forward
`requestState` to a third party, and keep secrets out of `state`.

A handler may ask in several steps. Each retry hands it the answers given so far, not just
the latest round's, so the second step still sees the first answer, as it would when running
as a task. A key asked again is replaced by its new answer. The client echoes those answers
back on every retry, so they are bounded by `requestStateMaxAnswerBytes` (64 KiB of JSON by
default; `0` turns carrying off). Answers are never dropped silently: when a handler asks again
after gathering more than that, the request fails with `-32602` (and the server logs a warning),
since a handler that lost an earlier answer would only ask for it again. A handler that gathers
large answers, such as a sampled draft, should keep what it needs in its own `state` and say
which answers are still worth carrying with `carry`:

```typescript
// The draft is summarised into state; only the confirmation is asked next.
throw new InputRequired({
  inputRequests: { confirm: elicitForm('Publish this summary?', confirmSchema) },
  state: { summary: summarise(draft) },
  carry: [] // carry no earlier answers
})
```

An accepted form answer is validated against the `requestedSchema` exactly as written, every
keyword included (`pattern` too, so keep patterns simple). Annotations (`title`,
`description`, `default`, `examples`) and `$schema` / `$id` are ignored, so a draft-07 schema
works. The formats elicitation defines (`email`, `uri`, `date`, `date-time`) are checked; any
other `format` is accepted as is. A schema that cannot be compiled fails the request with `-32603` when the handler asks,
rather than leaving its answers unchecked.

`elicitForm`, `elicitUrl`, `requestSampling` and `requestRoots` build the entries. The
dispatcher refuses to send a request the client did not declare support for, answering
`-32021` instead — so a handler cannot accidentally elicit from a client that cannot elicit.

### requestState security

`requestState` passes through the client, so it is attacker-controlled by definition. The
plugin seals it with HMAC-SHA256 and binds it to the authenticated principal, an expiry, and
a digest of the originating request. State that is tampered with, expired, presented by
another principal, or replayed onto a different call is refused with `-32602`.

```typescript
await app.register(mcpPlugin, {
  // Required when more than one instance can serve a retry — the default is a
  // per-process random key, so a retry landing on another replica would be refused.
  requestStateSecret: process.env.MCP_REQUEST_STATE_SECRET,
  requestStateTtlMs: 5 * 60 * 1000, // default
  requestStateMaxAnswerBytes: 64 * 1024 // default
})
```

> Replay is *bounded*, not eliminated. If a given `requestState` must be consumed at most
> once, enforce that in your own handler.

Applications that authenticate in their own Fastify hooks can expose that identity to MCP
without enabling the built-in OAuth plugin:

```typescript
app.addHook('preHandler', async (request, reply) => {
  request.user = await authenticateRequest(request, reply)
})

await app.register(mcpPlugin, {
  resolveAuthorizationContext: (request) => request.user
    ? { userId: request.user.id, scopes: request.user.scopes }
    : undefined
})
```

The resolver runs once per MCP request after Fastify preHandlers (POST, and the legacy SSE
GET and DELETE, which check who owns the session) and is authoritative when configured. It
only maps an already-authenticated request; it does **not** reject anonymous requests for you,
so it must not throw for one. Return a stable string `userId` so legacy sessions, `requestState`, modern and legacy tasks, tool
access hooks, and handler contexts all use the same principal. If the resolver returns no
`userId`, principal-bound request state is refused and the caller owns no tasks.

The resolver is not called for requests from the stdio transport, which carry no HTTP
credentials (see [stdio](#stdio-transport)). An authentication hook of your own should let them
through; `isStdioRequest(request)` tells them apart in hooks added after the plugin is
registered:

```typescript
import { isStdioRequest } from '@platformatic/mcp'

app.addHook('preHandler', async (request, reply) => {
  if (isStdioRequest(request)) return
  request.user = await authenticateRequest(request, reply)
})
```

## Subscriptions (2026-07-28)

`subscriptions/listen` replaces both the standalone `GET` stream and `resources/subscribe`.
The client names what it wants and the response *is* the stream:

```jsonc
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "subscriptions/listen",
  "params": {
    "notifications": {
      "toolsListChanged": true,
      "resourceSubscriptions": ["file:///project/config.json"]
    },
    "_meta": { /* ... */ }
  }
}
```

The server acknowledges with `notifications/subscriptions/acknowledged`, reporting the subset
it agreed to honour — an opt-in for something the server has no capability for is dropped.
Every message on the stream carries `io.modelcontextprotocol/subscriptionId`, and
`app.mcpBroadcastNotification()` feeds both these streams and legacy SSE sessions.

A notification type is only acknowledged when the server's capabilities say it is emitted:
`listChanged` for the list types, `resources.subscribe` for `resourceSubscriptions`. The default
capabilities declare `listChanged: true` for tools, prompts and resources, and
`resources.subscribe` once `app.mcpSetResourceSubscribeHandler()` is called; an explicit
`capabilities` option is used exactly as given.

A stream whose reader falls more than 1 MB behind is closed with `notifications/cancelled`
and no final response: notifications were lost, so the client should reconnect and
resynchronize rather than treat it as a graceful end. On stdio the same limit applies once
stdout stops draining.

Each stream holds a socket and buffers, so streams are bounded:
`subscriptionMaxStreamsPerPrincipal` per caller (default 10, refused with HTTP `429`),
`subscriptionMaxStreams` per instance (default 1000), and `subscriptionMaxResourceUris` per
stream (default 1000, each at most 2048 characters). A stream's id goes into every notification
it carries, so 2026-07-28 request ids are limited to 256 characters (longer ones are refused
with `-32600`). A caller is a user at an issuer, whichever
OAuth client they use; when the deployment cannot identify callers, only the per-instance limit
applies.

Resource subscriptions go through the same handlers as the legacy `resources/subscribe`: the
subscribe handler runs for each requested URI with the caller's `authContext`, and a URI whose
handler throws is left out of the acknowledgement. Throw there for resources the caller may not
watch; update notifications reveal what changed and when. The unsubscribe handler runs for an
accepted URI once the last listen stream on that instance holding it ends, however it ends, so a
handler may start a watcher on subscribe (idempotently) and stop it on unsubscribe. It runs with
the context of the stream that ended last. Legacy `resources/unsubscribe` calls are not counted:
they still run the handler for that session. Without a subscribe handler nothing can
check access, so no URI is accepted, even when `capabilities` declares `resources.subscribe`.

```typescript
app.mcpSetResourceSubscribeHandler(async ({ uri }, { authContext }) => {
  if (!canRead(authContext, uri)) throw new Error('Forbidden')
  watch(uri)
  return {}
})
app.mcpSetResourceUnsubscribeHandler(async ({ uri }) => {
  unwatch(uri)
  return {}
})
```

With the default capabilities, adding a tool, resource or prompt after the server is ready
broadcasts the matching `list_changed` notification. Legacy clients are only told
`listChanged` (and `resources.subscribe`) when `enableSSE` is on, since without SSE they have
no channel to receive notifications.

With Redis, that broadcast reaches every instance, but each instance has its own registry: a
tool added at runtime must be added on every instance, or clients told the list changed may
list it on one that does not have it. Designing this for rolling redeploys is tracked in
[#237](https://github.com/platformatic/mcp/issues/237).

Request-scoped notifications (`notifications/progress`, `notifications/message`) are never
delivered here; they belong on the response stream of the request they relate to.

A stream ends when the access token that opened it expires, or after `sseMaxConnectionMs` when
that comes first, with `notifications/cancelled` and the graceful completion response, so the
client listens again with fresh credentials and misses nothing. A listen whose `expiresAt` has
already passed is refused with HTTP `401` instead. Access is checked only when the stream opens:
a token with no expiry, or one revoked before it expires, keeps its stream open, so deployments
that revoke tokens should set `sseMaxConnectionMs`. The stream limits above are per instance, so
behind a balancer with N instances a caller may hold up to N times as many. Callers the deployment cannot
identify all share `subscriptionMaxStreams` (1000 by default) and have no per-caller limit, so
one anonymous client can hold every slot; deployments that accept anonymous listeners should
bound them upstream (per IP, say) or lower the limit.

## Progress and Logging (2026-07-28)

Handlers report progress and log messages through their context:

```typescript
app.mcpAddTool({ name: 'import', inputSchema: Type.Object({}) }, async (_args, context) => {
  context.sendProgress(0, 3, 'Reading')
  context.log('info', { step: 'read' }, 'importer')
  // ...
  context.sendProgress(3, 3, 'Done')
  return { content: [{ type: 'text', text: 'imported' }] }
})
```

Both are sent only when the client asked for them, on the response stream of that request:

- `context.sendProgress(progress, total?, message?)` emits `notifications/progress` when the
  request carries `_meta.progressToken`. `progress` must increase; a value that does not is
  dropped.
- `context.log(level, data, logger?)` emits `notifications/message` when the request sets
  `io.modelcontextprotocol/logLevel`, and only at or above that level.

Notifications are held until the outcome is known, or until the handler has run for 200ms.
A request that never reports, or that fails before then, answers with plain JSON and its
proper status. Otherwise the response is a `text/event-stream` carrying the notifications and
then the result. Once streaming has started the status is committed to `200`, so a later
error arrives inside the stream. Nothing is sent after the response. Both are no-ops on the
legacy path and for tasks, whose creating request has already been answered.

A missing client capability must be answered with `400` and `-32021`, which a stream can no
longer do. So a `tools/call`, `prompts/get` or `resources/read` only starts streaming early
when the handler cannot need a capability the client lacks: by default, when the client
declared every capability an input request can need (`elicitation` form and URL,
`sampling` with `tools` and `context`, and `roots`). Otherwise its notifications wait for the
outcome. A tool can name what it may ask for, so clients that declared that much still get
live progress:

```typescript
app.mcpAddTool({
  name: 'deploy',
  inputSchema: Type.Object({}),
  // Only ever asks with elicitForm(): clients with form elicitation get live progress.
  inputCapabilities: { elicitation: { form: {} } }
}, handler)
```

In practice few clients declare all of these, so **a tool without `inputCapabilities` usually
delivers its progress together with its result**. Declare `inputCapabilities` on every tool
whose progress should arrive live. `inputCapabilities: {}` says the tool never asks for input,
so it always streams early.
`inputCapabilities` is never listed to clients. A tool that then asks for more than it
declared, after progress has streamed, gets an internal error instead of `-32021`.

## Result Caching (2026-07-28)

`server/discover`, the four list operations and `resources/read` must carry `ttlMs` and
`cacheScope`. The default is `{ ttlMs: 0, cacheScope: 'private' }` — immediately stale and
never shared between callers, which is safe for every server. Opt into caching explicitly:

```typescript
await app.register(mcpPlugin, {
  caching: {
    discover: { ttlMs: 3_600_000, cacheScope: 'public' },
    toolsList: { ttlMs: 300_000, cacheScope: 'public' },
    resourcesRead: { ttlMs: 30_000, cacheScope: 'private' }
  }
})
```

> `cacheScope: 'public'` lets shared proxies serve one caller's response to another, **even
> from an authenticated endpoint**. Only use it for results that genuinely do not vary per
> user, and never rely on it for access control.

## Origin Validation

Browser clients can be protected against DNS rebinding by allow-listing origins. A rejected
origin is answered with `403`:

```typescript
await app.register(mcpPlugin, {
  allowedOrigins: ['https://app.example.com'] // omit to disable, '*' or true to allow any
})
```

Requests without an `Origin` header are always accepted — the header is set by browsers, so
its absence means the request did not come from one.

`allowedOrigins` must be `true`, `'*'` or an array of strings; any other value (including a
single origin string) makes registration throw. Wrap a single origin in an array.

## CORS

The plugin does not set CORS headers on `/mcp`; browser clients need the application to
configure CORS for it, for example with [`@fastify/cors`](https://github.com/fastify/fastify-cors):

```typescript
import cors from '@fastify/cors'

await app.register(cors, {
  origin: ['https://app.example.com'],
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'Last-Event-ID',
    'Mcp-Session-Id',
    'Mcp-Protocol-Version',
    'Mcp-Method',
    'Mcp-Name'
  ],
  exposedHeaders: ['Mcp-Session-Id']
})
await app.register(mcpPlugin, { /* ... */ })
```

`allowedHeaders` does not accept wildcards, so list any `Mcp-Param-*` headers your clients send.
When authorization is enabled, the `/.well-known/*` discovery endpoints answer cross-origin
requests from any origin on their own; that CORS handling is scoped to those routes and does not
affect the rest of the application.

## Tasks

Tasks let a tool call return immediately with a task handle while the work continues in the
background, and the client polls for the outcome.

The shape differs by era. In `2026-07-28` tasks are the official
`io.modelcontextprotocol/tasks` **extension**: the client declares it in its per-request
capabilities, the server advertises it under `capabilities.extensions`, and polling is
`tasks/get` alone. In `2025-11-25` tasks were part of the core protocol, with a per-call
`task` field and a blocking `tasks/result`. One `enableTasks: true` turns on both.

| | `2025-11-25` (core) | `2026-07-28` (extension) |
|---|---|---|
| Negotiated via | `capabilities.tasks` | `capabilities.extensions['io.modelcontextprotocol/tasks']` |
| Client opts in | `task` field per call | extension in `clientCapabilities` |
| Poll | `tasks/get` | `tasks/get` (result and error inlined) |
| Await result | `tasks/result` (blocks) | — removed, poll instead |
| Provide input | — | `tasks/update` |
| Enumerate | `tasks/list` | — removed |
| Cancel | `tasks/cancel` | `tasks/cancel` |
| Handle field names | `ttl`, `pollInterval` | `ttlMs`, `pollIntervalMs` |

Enable the feature on the plugin, then opt individual tools in with `execution.taskSupport`:

```typescript
await app.register(mcpPlugin, { enableTasks: true })

app.mcpAddTool({
  name: 'generate-report',
  description: 'Builds a large report',
  inputSchema: Type.Object({ month: Type.String() }),
  execution: { taskSupport: 'optional' } // 'forbidden' (default) | 'optional' | 'required'
}, async (params) => {
  return { content: [{ type: 'text', text: await buildReport(params.month) }] }
})
```

On `2026-07-28`, a client that declared the extension may get a task handle back from any
tool that permits one — the server decides, and there is no per-call opt-in:

```jsonc
// -> tools/call, with "io.modelcontextprotocol/tasks": {} in clientCapabilities.extensions
// <- CreateTaskResult
{ "resultType": "task", "taskId": "…", "status": "working", "ttlMs": 60000, "pollIntervalMs": 1000 }

// -> tasks/get { "taskId": "…" }
// <- the terminal state, with the original result inlined
{ "resultType": "complete", "status": "completed", "result": { "content": [ ... ] } }
```

A tool declaring `taskSupport: 'required'` refuses a client that did not declare the
extension, with `-32021`.

While a task waits in `input_required`, `tasks/get` shows the input requests its handler made,
which were checked against the capabilities of the request that created the task. Poll with
the same capabilities you created it with.

A task's handler may ask the client for input up to `taskMaxInputRounds` times (32 by default)
before the task fails; a synchronous call has no such bound, because each retry is the client's
choice. A handler that throws `InputRequired` with only `state` and nothing to ask is run again
after the task's `pollIntervalMs`, as a client would retry it, rather than at once. Such rounds
do not count toward `taskMaxInputRounds`: a handler may poll something else this way for as
long as the task's ttl allows.

A tool result with `isError: true` completes a 2026-07-28 task: the extension reserves
`failed` for JSON-RPC errors, and the error result is inlined like any other. A 2025-11-25
task with such a result is still reported `failed`, as before.

On `2025-11-25`, the client opts in per call instead:

```jsonc
// -> tools/call
{ "name": "generate-report", "arguments": { "month": "July" }, "task": { "ttl": 60000 } }
// <- CreateTaskResult
{ "task": { "taskId": "…", "status": "working", "ttl": 60000, "pollInterval": 1000 } }
```

and may then use `tasks/get`, `tasks/result` (blocks until the task is terminal),
`tasks/list` and `tasks/cancel`, plus optional `notifications/tasks/status` pushes over SSE.
A blocked `tasks/result` stops waiting when its client disconnects. When the server closes it
answers with a JSON-RPC `-32603` "Server shutting down" error, so `app.close()` never waits on a
task running on another instance; for a task running on this one it waits for the drain (see
`taskShutdownTimeoutMs`) and answers with the task's outcome.

Retention defaults to 60 seconds when the client does not request a `ttl`. Tasks are meant
for long-running work, so if your tools can outlive that, raise the bounds — otherwise a task
can expire before it finishes and its `tasks/result` returns "not found":

```typescript
await app.register(mcpPlugin, {
  enableTasks: true,
  taskDefaultTtlMs: 15 * 60_000, // retention when the client requests no ttl
  taskMaxTtlMs: 60 * 60_000      // ceiling on a client-requested ttl
})
```

A client-requested `ttl` must be a non-negative integer number of milliseconds; anything else
(a string, a negative or fractional number) is rejected with `-32602` Invalid params. A valid
`ttl` is clamped between 1 second and `taskMaxTtlMs`, and the effective value is returned in the
`CreateTaskResult`.

Tasks are stored in memory by default and in Redis when a `redis` option is given, so any
instance can serve a poll for a task created on another.

`tasks/list` returns the caller's tasks newest first, 50 per page. When more remain, the
result carries an opaque `nextCursor`; pass it back as `params.cursor` to fetch the next
page. An unrecognised cursor is rejected with `-32602` (Invalid params). The Redis store keeps
a per-owner index, so a listing only reads the caller's own tasks.

Each caller (a user at an issuer, whichever OAuth client they come through) may keep at most
`taskMaxRetainedPerPrincipal` tasks stored (default 100), for both protocol eras. Finished tasks
count until their `ttl` expires, so one caller cannot fill the store with results it never
collects. When a caller is at its quota, its oldest finished task is evicted to make room (one
created through the same OAuth client first, and only then one another of the user's clients has
not collected yet); if all
of them are still running, a 2025-11-25 `tools/call` fails with `-32029` "Task limit reached",
and a 2026-07-28 call that would run as a task fails with `-32600` "Cannot create a task: Task
limit reached" (`-32029` lies in the range 2026-07-28 reserves), rather than running a long call
synchronously. The same errors answer `taskMaxConcurrent` and `taskMaxPerPrincipal`. Callers the deployment cannot identify share a single
quota, so raise it if you expect many concurrent anonymous tasks. The in-memory store also holds
at most `taskStoreMaxTasks` tasks in total (default 1000); when full, it evicts the caller's
oldest finished task, then the oldest finished task of any caller, before refusing. Eviction
can drop a finished result its client has not read yet. The Redis store enforces the quota
atomically with a per-user sorted set, so it holds across instances, and prunes expired
entries from it whenever that caller creates or lists tasks.

The instance running a task (of either era) holds a lease on it and renews it every third of
`taskLeaseMs` (default 15 seconds). If that instance dies or shuts down before the task
finishes, renewals stop. Once the lease lapses, the next `tasks/get` or `tasks/result`
(including one already waiting) marks the task `failed`, so it no longer reads `working` until
its ttl runs out. A caller at `taskMaxRetainedPerPrincipal` gets the same treatment for their
orphaned tasks when they create a new one. The check is a compare-and-set, so a renewal or
completion that lands first always wins. With Redis, the lease is set and checked against the
Redis server clock, so clock skew between instances can never fail a task that is still
running:

```typescript
await app.register(mcpPlugin, {
  enableTasks: true,
  taskMaxRetainedPerPrincipal: 20, // tasks each caller may keep, finished ones included
  taskLeaseMs: 15_000 // a dead instance's tasks are failed this long after its last renewal
})
```

**Security**: when built-in authorization or `resolveAuthorizationContext` is configured,
tasks are bound to the resolved principal (user, OAuth client and issuer) and a requestor can
only reach its own. Without an
identity resolver no requestor can be identified, so tasks are reachable by anyone holding
the (random UUID) task id, and `tasks/list` is both unadvertised **and refused** — otherwise
it would hand every anonymous task's id to any caller and defeat that model.

## Elicitation Support (MCP 2025-11-25)

The plugin supports the elicitation capability, allowing servers to request structured information from clients. This enables dynamic data collection with schema validation.

Two modes are available. **Form mode** collects structured data through the client, and
**URL mode** sends the user out of band for anything sensitive — credentials, payments,
third-party OAuth — so it never passes through the MCP client:

```typescript
// URL mode: returns the elicitation id, or null if the request could not be sent
const elicitationId = await app.mcpElicitUrl(
  sessionId,
  'Authorize access to your Example Co files',
  'https://mcp.example.com/connect'
)

// Later, once the out-of-band interaction finishes
if (elicitationId) {
  await app.mcpNotifyElicitationComplete(sessionId, elicitationId)
}
```

Servers **MUST NOT** request passwords, API keys or payment details through form mode — use
URL mode for those. URLs are rejected if they are malformed, use a scheme other than
http(s), or embed credentials.

### Basic Elicitation

Elicitation is a **client** capability: there is nothing to declare in the server's
`capabilities`. The client opts in by sending `capabilities: { elicitation: {} }` (form
mode only), or `{ elicitation: { form: {}, url: {} } }`, in its `initialize` request.
`mcpElicit()` returns `false`, and `mcpElicitUrl()` `null`, when the client did not declare
the mode being requested, as the spec forbids sending it.

The request is delivered over the session's SSE stream, so the client must have it open
(`GET /mcp`). The client answers by POSTing a JSON-RPC response with the same `id`; the
plugin acknowledges it with `202` and passes it to `onClientResponse`.

```typescript
import { Type } from '@sinclair/typebox'

// Register plugin with elicitation support
await app.register(mcpPlugin, {
  enableSSE: true, // Required for elicitation
  // Receives the client's answer (an ElicitResult) to each elicitation request
  onClientResponse: async (response, { sessionId }) => {
    if ('result' in response) {
      app.log.info({ sessionId, id: response.id, result: response.result }, 'Elicitation answered')
    }
  }
})

// In your tool handler, request information from the client
app.mcpAddTool({
  name: 'collect-user-info',
  description: 'Collect user information',
  inputSchema: Type.Object({})
}, async (_params, { sessionId }) => {
  if (!sessionId) {
    return { 
      content: [{ type: 'text', text: 'No session available' }],
      isError: true 
    }
  }

  // Request user details with schema validation
  const success = await app.mcpElicit(sessionId, 'Please enter your details', {
    type: 'object',
    properties: {
      name: { 
        type: 'string', 
        description: 'Your full name',
        minLength: 1,
        maxLength: 100
      },
      email: {
        type: 'string',
        description: 'Your email address',
        format: 'email'
      },
      age: {
        type: 'integer',
        description: 'Your age',
        minimum: 0,
        maximum: 150
      },
      preferences: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['newsletter', 'updates', 'marketing']
        },
        description: 'Communication preferences'
      }
    },
    required: ['name', 'email']
  })

  if (success) {
    return { 
      content: [{ type: 'text', text: 'Information request sent to client' }] 
    }
  } else {
    return { 
      content: [{ type: 'text', text: 'Failed to send elicitation request' }],
      isError: true 
    }
  }
})
```

### Advanced Elicitation with Custom Request IDs

```typescript
// Request with custom ID for tracking
const requestId = 'user-profile-123'
const success = await app.mcpElicit(
  sessionId, 
  'Complete your profile setup',
  {
    type: 'object',
    properties: {
      avatar: { type: 'string', description: 'Avatar URL' },
      bio: { type: 'string', maxLength: 500, description: 'Short bio' },
      skills: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['typescript', 'rust', 'go', 'python']
        },
        maxItems: 4,
        description: 'Your skills'
      }
    }
  },
  requestId
)
```

### Security Considerations for Elicitation

⚠️ **Important Security Notes:**

- Elicitation requests are automatically validated for length and complexity
- Schema depth and size are limited to prevent DoS attacks
- Rate limiting should be implemented for production use
- Always validate client responses before using the data
- Never request sensitive information without explicit user consent

## TypeBox Schema Validation

The plugin supports TypeBox schemas for type-safe validation with automatic TypeScript inference. This eliminates the need for manual type definitions and provides compile-time type checking.

### Benefits

- **Type Safety**: Automatic TypeScript type inference from schemas
- **Runtime Validation**: Input validation with structured error messages
- **Zero Duplication**: Single source of truth for both types and validation
- **IDE Support**: Full autocomplete and IntelliSense for validated parameters
- **Performance**: Compiled validators with caching for optimal performance

### Basic Usage

```typescript
import { Type } from '@sinclair/typebox'
import Fastify from 'fastify'
import mcpPlugin from '@platformatic/mcp'

const app = Fastify({ logger: true })

await app.register(mcpPlugin, {
  serverInfo: { name: 'my-server', version: '1.0.0' },
  capabilities: { tools: {} }
})

// Define TypeBox schema
const SearchToolSchema = Type.Object({
  query: Type.String({ minLength: 1, description: 'Search query' }),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100, description: 'Maximum results' })),
  filters: Type.Optional(Type.Array(Type.String(), { description: 'Filter criteria' }))
})

// Register tool with TypeBox schema
app.mcpAddTool({
  name: 'search',
  description: 'Search for files',
  inputSchema: SearchToolSchema
}, async (params) => {
  // params is automatically typed as:
  // {
  //   query: string;
  //   limit?: number;
  //   filters?: string[];
  // }
  const { query, limit = 10, filters = [] } = params
  
  return {
    content: [{
      type: 'text',
      text: `Searching for "${query}" with limit ${limit} and filters: ${filters.join(', ')}`
    }]
  }
})
```

### Schema Types

#### Tool Input Schemas

```typescript
// Complex nested schema
const ComplexToolSchema = Type.Object({
  user: Type.Object({
    name: Type.String(),
    age: Type.Number({ minimum: 0 })
  }),
  preferences: Type.Object({
    theme: Type.Union([
      Type.Literal('light'),
      Type.Literal('dark'),
      Type.Literal('auto')
    ]),
    notifications: Type.Boolean()
  }),
  tags: Type.Array(Type.String())
})

app.mcpAddTool({
  name: 'update-profile',
  description: 'Update user profile',
  inputSchema: ComplexToolSchema
}, async (params) => {
  // Fully typed nested object
  const { user, preferences, tags } = params
  return { content: [{ type: 'text', text: `Updated profile for ${user.name}` }] }
})
```

#### Resource URI Schemas

```typescript
// URI validation schema
const FileUriSchema = Type.String({
  pattern: '^file://.+',
  description: 'File URI pattern'
})

app.mcpAddResource({
  uriPattern: 'file://documents/*',
  name: 'Document Files',
  description: 'Access document files',
  uriSchema: FileUriSchema
}, async (uri, context) => {
  // uri is validated against the schema
  const content = await readFile(uri)
  return {
    contents: [{ uri, text: content, mimeType: 'text/plain' }]
  }
})
```

#### Prompt Argument Schemas

```typescript
// Prompt with automatic argument generation
const CodeReviewSchema = Type.Object({
  language: Type.Union([
    Type.Literal('javascript'),
    Type.Literal('typescript'),
    Type.Literal('python')
  ], { description: 'Programming language' }),
  complexity: Type.Optional(Type.Union([
    Type.Literal('low'),
    Type.Literal('medium'),
    Type.Literal('high')
  ], { description: 'Code complexity level' }))
})

app.mcpAddPrompt({
  name: 'code-review',
  description: 'Generate code review',
  argumentSchema: CodeReviewSchema
  // arguments array is automatically generated from schema
}, async (name, args, context) => {
  // args is typed as: { language: 'javascript' | 'typescript' | 'python', complexity?: 'low' | 'medium' | 'high' }
  return {
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: `Review this ${args.language} code with ${args.complexity || 'medium'} complexity`
      }
    }]
  }
})
```

### Error Handling

TypeBox validation provides structured error messages:

```typescript
// When validation fails, structured errors are returned:
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "isError": true,
    "content": [{
      "type": "text",
      "text": "Invalid tool arguments: Validation failed with 2 errors:\n/query: Expected string, received number\n/limit: Expected number <= 100, received 150"
    }]
  }
}
```

Prompts and resources report failures as JSON-RPC errors instead of successful results:

- `prompts/get` returns `-32602` (Invalid params) when the arguments fail the TypeBox `argumentSchema`, or, for prompts without a TypeBox schema, when an argument declared with `required: true` in `arguments` is missing. The handler is not invoked.
- `prompts/get` returns `-32603` (Internal error) with the message `Prompt execution failed: <error.message>` when the prompt handler throws.
- `resources/read` returns `-32602` when the URI fails the resource's `uriSchema`, and `-32603` with `Resource read failed: <error.message>` when the resource handler throws.

Handler errors are logged; only the error message is sent to the client, never the stack trace. On 2026-07-28 not even the message is: those clients get `Internal server error` for a prompt and `Resource read failed` for a resource, and the details stay in the log.

### Backward Compatibility

The plugin maintains backward compatibility with JSON Schema and unvalidated tools:

```typescript
// JSON Schema (accepted, but NOT validated at runtime by default — see below)
app.mcpAddTool({
  name: 'legacy-tool',
  description: 'Uses JSON Schema',
  inputSchema: {
    type: 'object',
    properties: {
      param: { type: 'string' }
    }
  }
}, async (params) => {
  // params is typed as 'any'
  return { content: [{ type: 'text', text: 'OK' }] }
})

// Unvalidated tool (unsafe)
app.mcpAddTool({
  name: 'unsafe-tool',
  description: 'No validation'
}, async (params) => {
  // params is typed as 'any' - no validation performed
  return { content: [{ type: 'text', text: 'OK' }] }
})
```

**Important:** only TypeBox schemas are validated at runtime by default. A tool registered with a plain JSON Schema `inputSchema` receives its arguments **unvalidated** unless you opt in to AJV validation.

### Validating plain JSON Schema inputs with AJV

Set `validateJsonSchemaInputs: {}` to validate plain-JSON-Schema tool inputs with [AJV](https://ajv.js.org/) (draft 2020-12, matching the plugin's published schema dialect) before the handler runs. TypeBox tools are unaffected — they keep their existing TypeBox validation.

```typescript
await app.register(mcpPlugin, {
  validateJsonSchemaInputs: {
    allErrors: true
  }
})
```

Behavior when enabled:

- Invalid arguments return a tool execution error (`isError: true` with an `Invalid tool arguments: ...` message, capped at 5 reported errors), not a protocol error — the same SEP-1303 semantics as TypeBox validation.
- Validation is non-mutating: no type coercion, no defaults injection, no property removal, and the `coerceTypes`, `useDefaults` and `removeAdditional` options cannot turn them back on. Handlers receive the arguments exactly as the client sent them. `format` keywords are annotation-only (JSON Schema 2020-12's own default).
- A plain JSON Schema that AJV cannot compile makes `mcpAddTool` throw, so a misconfigured tool fails at startup instead of running unvalidated.
- Compiled validators are cached per schema, and the option also applies to stdio transports and task-augmented (`task: {}`) calls.

### Performance

TypeBox validation is highly optimized:

- **Compiled Validators**: Schemas are compiled to optimized validation functions
- **Caching**: Compiled validators are cached for reuse
- **Minimal Overhead**: Less than 1ms validation overhead for typical schemas
- **Memory Efficient**: Shared validator instances across requests

## Server-Sent Events (SSE) Support

This plugin supports the MCP Streamable HTTP transport specification, enabling both regular JSON responses and Server-Sent Events for streaming communication.

### SSE Configuration

```typescript
await app.register(mcpPlugin, {
  enableSSE: true, // Enable SSE support (default: false)
  // Optionally close streams after a while so clients fall back to polling and
  // resume with Last-Event-ID (SEP-1699). Omit to keep streams open indefinitely.
  sseMaxConnectionMs: 300_000,
  // ... other options
})
```

When authorization is enabled, the access token is only checked when a `GET /mcp` stream opens. So that a stream never outlives that token, the server closes it at the token's `exp` (or after `sseMaxConnectionMs`, whichever comes first). The client then reconnects with a fresh token and resumes with `Last-Event-ID`. Tokens without an `exp` claim are bounded only by `sseMaxConnectionMs`, so set it if your authorization server issues them or if you want revocation and scope changes to take effect within a bounded time.

## Redis Configuration for Horizontal Scaling

The plugin supports Redis-backed session management and message broadcasting for horizontal scaling across multiple server instances.

### Why Redis is Critical for Scalability

**Without Redis (Memory-only):**
- Each server instance maintains isolated session stores
- SSE connections are tied to specific server instances  
- No cross-instance message broadcasting
- Session data is lost when servers restart
- Load balancers can't route clients to different instances

**With Redis (Distributed):**
- **Shared Session State**: All instances access the same session data from Redis
- **Cross-Instance Broadcasting**: Messages sent from any instance reach all connected clients
- **Session Persistence**: Sessions survive server restarts, expiring after one idle hour by default (`sessionTtlMs`)
- **High Availability**: Clients can reconnect to any instance and resume from last event
- **True Horizontal Scaling**: Add more instances without architectural changes

This transforms the plugin from a single-instance application into a distributed system capable of serving thousands of concurrent SSE connections with real-time global synchronization.

### Redis Setup

```typescript
import Fastify from 'fastify'
import mcpPlugin from '@platformatic/mcp'

const app = Fastify({ logger: true })

await app.register(mcpPlugin, {
  enableSSE: true,
  // Required with redis: every instance must verify the request state the others seal
  requestStateSecret: process.env.MCP_REQUEST_STATE_SECRET,
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    db: parseInt(process.env.REDIS_DB || '0'),
    password: process.env.REDIS_PASSWORD,
    // Any other ioredis RedisOptions are accepted and passed through
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(times * 100, 2000)
  },
  serverInfo: {
    name: 'scalable-mcp-server',
    version: '1.0.0'
  }
})
```

### Message Broker Exports

`MemoryMessageBroker`, `RedisMessageBroker`, and the `MessageBroker` interface are exported from the package's public entry point, so you can use them directly without deep-importing into `dist/brokers/...`:

```typescript
import { MessageBroker, MemoryMessageBroker, RedisMessageBroker } from '@platformatic/mcp'

const broker: MessageBroker = new MemoryMessageBroker()
// or: new RedisMessageBroker(redis)
```

- **`MessageBroker`**: the pub/sub interface the plugin uses internally to deliver messages to SSE clients — `publish(topic, message)`, `subscribe(topic, handler)`, `unsubscribe(topic)`, and `close()`.
- **`MemoryMessageBroker`**: in-process implementation backed by [MQEmitter](https://github.com/mcollina/mqemitter). Used automatically when no `redis` option is passed; messages only reach clients connected to the same server instance.
- **`RedisMessageBroker`**: distributed implementation backed by [mqemitter-redis](https://github.com/mcollina/mqemitter-redis). Used automatically when the `redis` option is passed; publishes go through Redis so messages reach clients connected to *any* server instance.

These are the same broker classes the plugin instantiates internally based on the `redis` option. Exporting them lets you construct one directly for custom pub/sub logic, tests, or scripts that need to publish/subscribe without spinning up the full plugin.

### Session Store Exports

`MemorySessionStore`, `RedisSessionStore`, and the `SessionStore`/`SessionMetadata` types are exported from the package's public entry point, matching the broker and task store exports:

```typescript
import { SessionStore, MemorySessionStore, RedisSessionStore } from '@platformatic/mcp'

const store: SessionStore = new MemorySessionStore()
// or: new RedisSessionStore({ redis })
```

- **`SessionStore`**: the interface the plugin uses to persist SSE session metadata, message history, token-to-session mappings, and per-session resource subscriptions (`addResourceSubscription` / `removeResourceSubscription`, exposed as `resourceSubscriptions` on the metadata). The optional `touch(sessionId)` records activity so the session is not expired while in use.
- **`MemorySessionStore`**: in-process implementation used automatically when no `redis` option is passed. Takes an optional `maxMessages` history cap (default 100) and `{ sessionTtlMs }` idle expiry (default 1 hour); call `cleanup()` periodically to free expired sessions when using it outside the plugin.
- **`RedisSessionStore`**: distributed implementation used automatically when the `redis` option is passed; sessions and message history live in Redis so any instance can serve any client.

These are the same store classes the plugin instantiates internally based on the `redis` option. Exporting them lets you construct or inspect one directly in tests and scripts.

### Multi-Instance Deployment

With Redis configuration, you can run multiple instances of your MCP server:

```bash
# Instance 1
PORT=3000 REDIS_HOST=redis.example.com node server.js

# Instance 2  
PORT=3001 REDIS_HOST=redis.example.com node server.js

# Instance 3
PORT=3002 REDIS_HOST=redis.example.com node server.js
```

### Graceful Shutdown

`RedisMessageBroker.close()` is bounded: it waits up to `closeTimeoutMs` (default 2000ms) for
mqemitter-redis to close its Redis connections gracefully, then falls back to forcibly
disconnecting them so Fastify's `onClose` hooks - and the process shutdown deadline enforced by
most orchestrators - are never blocked by a Redis outage or a stuck reconnect. Pass
`closeTimeoutMs` and `onCloseTimeout` as a second argument to `RedisMessageBroker` to customize
this behavior, e.g. to log when a shutdown had to fall back to the forced path.

### Connection Errors

A dropped Redis connection (for example during a Redis restart or failover) does not crash the
process: the plugin logs errors from its Redis client and from the message broker's pub/sub
connections through the Fastify logger, and ioredis keeps reconnecting. When constructing
`RedisMessageBroker` yourself, pass an `onError` callback in its options to observe these errors.

### Session Persistence Features

**Automatic Session Management:**
- Sessions persist across server restarts
- Idle session TTL (`sessionTtlMs`, default 1 hour) with automatic cleanup
- Message history stored in Redis Streams

**Message Replay:**
```javascript
// Client reconnection with Last-Event-ID
const eventSource = new EventSource('/mcp', {
  headers: { 
    'Accept': 'text/event-stream',
    'Last-Event-ID': '1234' // Resume from this event
  }
})
```

**Cross-Instance Broadcasting:**
```typescript
// Any server instance can broadcast to all connected clients
app.mcpBroadcastNotification({
  jsonrpc: '2.0',
  method: 'notifications/message',
  params: { message: 'Global update from instance 2' }
})

// Send to specific session (works across instances)
app.mcpSendToSession('session-xyz', {
  jsonrpc: '2.0',
  method: 'notifications/progress',
  params: { progress: 75 }
})
```

### Implementation Design Decisions

This plugin implements certain behaviors that differ from the strict MCP specification to provide enhanced scalability and resilience in production environments:

#### Multiple Connections per Session

**MCP Specification Intent**: The official MCP specification (line 144-145) states that servers "**MUST** send each of its JSON-RPC messages on only one of the connected streams; that is, it **MUST NOT** broadcast the same message across multiple streams."

**Our Implementation Choice**: We allow multiple SSE connections to share the same session ID and broadcast session-specific messages (`mcpSendToSession`) to all connections within that session.

**Why We Made This Choice**:

1. **Horizontal Scalability**: In distributed deployments with Redis, sessions can span multiple server instances. Broadcasting ensures messages reach all connections regardless of which instance they're connected to.

2. **Connection Resilience**: If a client has multiple connections (e.g., main application + background tools), both can receive notifications even if one connection fails.

3. **Tool Integration**: External tools can join existing sessions by providing the same `mcp-session-id` header, enabling seamless integration with ongoing workflows.

4. **Message Persistence**: All connections in a session benefit from the same message history and can replay missed events using `Last-Event-ID`.

**Trade-off**: This approach may deliver duplicate messages to multiple connections within the same session, but the benefits in production reliability and scalability outweigh this consideration for most use cases.

### Dual-Endpoint Architecture

The plugin uses a dual-endpoint architecture that separates regular MCP protocol communication from SSE streaming:

```mermaid
sequenceDiagram
    participant C1 as Client 1
    participant Tool as Tool/Client 2
    participant Server as Fastify MCP Server
    participant Redis as Redis (Optional)
    participant Broker as Message Broker

    Note over C1,Broker: Session Creation and Multiple Connection Support
    
    C1->>Server: POST /mcp (initialize)
    Server->>C1: Response + Session ID: abc123
    
    C1->>Server: GET /mcp (SSE stream)
    Note right of C1: Accept: text/event-stream<br/>mcp-session-id: abc123
    Server-->>C1: SSE connection established
    
    Note over Tool,Broker: Tool Joins SAME Session (Implementation Choice)
    
    Tool->>Server: POST /mcp (any request)
    Note right of Tool: mcp-session-id: abc123<br/>(reuses existing session)
    Server->>Tool: Response (no new session created)
    
    Tool->>Server: GET /mcp (SSE stream)
    Note right of Tool: Accept: text/event-stream<br/>mcp-session-id: abc123
    Server-->>Tool: SSE connection established
    
    rect rgb(255, 240, 240)
        Note over Server: Implementation Detail:<br/>localStreams.get('abc123') = Set{C1, Tool}<br/>Multiple connections share same session
    end
    
    Note over C1,Broker: Session-Specific Broadcasting (Implementation Choice)
    
    rect rgb(240, 248, 255)
        Note over C1,Tool: Our Implementation: mcpSendToSession('abc123')<br/>broadcasts to ALL connections in session abc123<br/>(Differs from MCP spec for scalability)
        Server->>Broker: mcpSendToSession('abc123', message)
        alt Redis Mode (Cross-Instance)
            Broker->>Redis: Publish to mcp/session/abc123/message
            Redis-->>Broker: Distribute to instance with session abc123
        else Memory Mode
            Broker->>Broker: Route to session abc123 locally
        end
        Broker-->>Server: Forward to ALL streams in session abc123
        Server-->>C1: SSE notification (shared session)
        Server-->>Tool: SSE notification (shared session)
    end
    
    Note over C1,Broker: Reconnection Resilience
    
    Tool->>Server: Disconnect (network issue)
    Note over Server: Session abc123 persists with C1 still connected
    
    Server->>Broker: mcpSendToSession('abc123', message)
    Broker-->>Server: Deliver to remaining connections
    Server-->>C1: SSE notification continues
    
    Tool->>Server: GET /mcp (reconnect)
    Note right of Tool: mcp-session-id: abc123<br/>Last-Event-ID: 15
    alt Redis Mode
        Server->>Redis: Get message history for session abc123
        Redis-->>Server: Return events 16-20
    else Memory Mode
        Server->>Server: Get local history for session abc123
    end
    Server-->>Tool: Replay missed events
    Server-->>Tool: Resume receiving notifications
    
    Note over C1,Broker: Cross-Instance Scalability
    
    rect rgb(240, 255, 240)
        Note over Server,Redis: With Redis: Session abc123 can be accessed<br/>from any server instance. Messages route<br/>to the instance hosting the SSE connections.
        Server->>Broker: mcpSendToSession('abc123', message)<br/>(from any instance)
        Broker->>Redis: Publish to mcp/session/abc123/message
        Redis-->>Broker: Route to correct instance
        Broker-->>Server: Deliver to session abc123 connections
        Server-->>C1: SSE notification
        Server-->>Tool: SSE notification
    end
```

#### POST `/mcp` - MCP Protocol Communication

Handles all standard MCP protocol requests and returns JSON responses:

```javascript
// Regular MCP request (always returns JSON)
const response = await fetch('/mcp', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  },
  body: JSON.stringify({ 
    jsonrpc: '2.0', 
    method: 'tools/call',
    params: { name: 'my-tool', arguments: {} },
    id: 1 
  })
})
const result = await response.json()
```

#### GET `/mcp` - SSE Stream Establishment

Establishes long-lived Server-Sent Events streams for real-time communication:

```javascript
// Establish SSE stream (separate from protocol requests)
const eventSource = new EventSource('/mcp', {
  headers: { 
    'Accept': 'text/event-stream',
    'mcp-session-id': sessionId  // Use session from POST request
  }
})

eventSource.onmessage = (event) => {
  const message = JSON.parse(event.data)
  console.log('Server notification:', message)
}
```

#### Complete Workflow Example

```javascript
// 1. Create session and make MCP requests via POST
const initResponse = await fetch('/mcp', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  },
  body: JSON.stringify({
    jsonrpc: '2.0',
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'my-client', version: '1.0.0' }
    },
    id: 1
  })
})

const sessionId = initResponse.headers.get('mcp-session-id')

// 2. Establish SSE stream for notifications via GET
const eventSource = new EventSource('/mcp', {
  headers: {
    'Accept': 'text/event-stream',
    'mcp-session-id': sessionId
  }
})

// 3. Continue making MCP requests via POST
const toolResponse = await fetch('/mcp', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'mcp-session-id': sessionId
  },
  body: JSON.stringify({
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { name: 'my-tool', arguments: {} },
    id: 2
  })
})

// Server can send notifications via the SSE stream
// while client makes requests via POST
```

### Server-Initiated Notifications

The plugin provides methods to send notifications and messages to connected SSE clients:

```typescript
import Fastify from 'fastify'
import mcpPlugin from '@platformatic/mcp'

const app = Fastify({ logger: true })

await app.register(mcpPlugin, {
  enableSSE: true,
  // ... other options
})

// Broadcast a notification to all connected SSE clients
app.mcpBroadcastNotification({
  jsonrpc: '2.0',
  method: 'notifications/message',
  params: {
    level: 'info',
    message: 'Server status update'
  }
})

// Send a message to a specific session
const success = app.mcpSendToSession('session-id', {
  jsonrpc: '2.0',
  method: 'notifications/progress',
  params: {
    progressToken: 'task-123',
    progress: 50,
    total: 100
  }
})

// Send a request to a specific session (expecting a response)
app.mcpSendToSession('session-id', {
  jsonrpc: '2.0',
  id: 'req-456',
  method: 'sampling/createMessage',
  params: {
    messages: [
      {
        role: 'user',
        content: { type: 'text', text: 'Hello from server!' }
      }
    ]
  }
})

// Example: Broadcast tool list changes
app.mcpBroadcastNotification({
  jsonrpc: '2.0',
  method: 'notifications/tools/list_changed'
})

// Example: Send resource updates. `notifications/resources/updated` is only
// delivered to sessions that called `resources/subscribe` for this URI (and
// have not unsubscribed); every other broadcast reaches all sessions.
app.mcpBroadcastNotification({
  jsonrpc: '2.0',
  method: 'notifications/resources/updated',
  params: {
    uri: 'file://config.json'
  }
})
```

### Real-time Updates Example

```typescript
// Set up a timer to send periodic updates
setInterval(() => {
  app.mcpBroadcastNotification({
    jsonrpc: '2.0',
    method: 'notifications/message',
    params: {
      level: 'info',
      message: `Server time: ${new Date().toISOString()}`
    }
  })
}, 30000) // Every 30 seconds

// Send updates when data changes
function onDataChange(newData: any) {
  app.mcpBroadcastNotification({
    jsonrpc: '2.0',
    method: 'notifications/resources/list_changed'
  })
}
```

## Stdio Transport

The plugin includes a built-in stdio transport utility for MCP communication over stdin/stdout, following the MCP stdio transport specification. This enables command-line tools and local applications to communicate with your Fastify MCP server.

### Key Features

- **MCP stdio transport** following the official specification, for both the handshake
  revisions and 2026-07-28
- **Fastify integration** using the `.inject()` method for consistency with HTTP routes
- **Streaming**: `subscriptions/listen` and request-scoped progress or log notifications are
  written to stdout as they happen
- **Cancellation**: `notifications/cancelled` aborts the request's `context.signal`, whichever
  revision the client speaks, and nothing more is written for it
- **Local trust**: stdio requests are not subject to HTTP bearer authorization, as the spec has
  the stdio transport take credentials from its environment. Pass the identity they act as with
  `runStdioServer(app, { authContext: { userId: process.env.USER } })`; without one they are
  anonymous, and with authorization enabled multi round-trip requests and tasks (which need an
  identified caller) are refused. `resolveAuthorizationContext` is not called for them, and
  `isStdioRequest(request)` lets your own authentication hooks skip them
- **Comprehensive error handling** with proper JSON-RPC error responses
- **Batch request support** for the legacy revisions that allow it
- **Debug logging** to stderr without interfering with the stdio protocol

### Quick Start

```typescript
import fastify from 'fastify'
import mcpPlugin, { runStdioServer } from '@platformatic/mcp'

const app = fastify({
  logger: false // Disable HTTP logging to avoid interference with stdio
})

await app.register(mcpPlugin, {
  serverInfo: {
    name: 'my-mcp-server',
    version: '1.0.0'
  },
  capabilities: {
    tools: {},
    resources: {},
    prompts: {}
  }
})

// Register your tools, resources, and prompts
app.mcpAddTool({
  name: 'echo',
  description: 'Echo back the input text',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string' }
    },
    required: ['text']
  }
}, async (args) => {
  return {
    content: [{
      type: 'text',
      text: `Echo: ${args.text}`
    }]
  }
})

await app.ready()

// Start the stdio transport
await runStdioServer(app, {
  debug: process.env.DEBUG === 'true'
})
```

### Usage Examples

```bash
# Initialize the server
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test-client","version":"1.0.0"}}}' | node server.js

# Ping the server
echo '{"jsonrpc":"2.0","id":2,"method":"ping"}' | node server.js

# List available tools
echo '{"jsonrpc":"2.0","id":3,"method":"tools/list"}' | node server.js

# Call a tool
echo '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"echo","arguments":{"text":"Hello, stdio!"}}}' | node server.js
```

### API Reference

#### `runStdioServer(app, options)`

Starts a Fastify MCP server in stdio mode.

**Parameters:**
- `app` - Fastify instance with MCP plugin registered
- `options` - Optional stdio transport options

**Options:**
- `debug` - Enable debug logging to stderr (default: false)
- `input` - Custom input stream (default: process.stdin)
- `output` - Custom output stream (default: process.stdout)
- `error` - Custom error stream (default: process.stderr)
- `authContext` - Authorization context every request on this stream runs as (stdio has no
  bearer token, so `resolveAuthorizationContext` is not called)

#### `createStdioTransport(app, options)`

Creates a stdio transport instance without starting it.

**Parameters:**
- `app` - Fastify instance with MCP plugin registered
- `options` - Optional stdio transport options

**Returns:** `StdioTransport` instance with `start()` and `stop()` methods

### Transport Protocol

The stdio transport follows the MCP stdio transport specification:

- Messages are exchanged over stdin/stdout
- Each message is a single line of JSON
- Messages are delimited by newlines
- Messages must NOT contain embedded newlines
- Server logs can be written to stderr
- 2026-07-28 messages are always sent one per line; a batch containing one is refused with
  `-32600`. Legacy revisions may still send batches.
- 2026-07-28 has no header layer on stdio: everything travels in the body's `_meta`
- The protocol version negotiated by a legacy `initialize` applies to every later legacy message
  on the stream (a new `initialize` re-negotiates it)

### Error Handling

The stdio transport provides comprehensive error handling:

- Unparseable lines are answered with a `-32700` parse error whose `id` is `null`
- Invalid method calls return "Method not found" errors
- Tool execution errors are captured and returned in the response
- Connection errors are logged to stderr

### Use Cases

The stdio transport is particularly useful for:

- **Command-line tools** that need to communicate with MCP servers
- **Local development and testing** without HTTP overhead
- **Integration with text editors and IDEs** that support stdio protocols
- **Simple client-server communication** in controlled environments
- **Batch processing** of MCP requests from scripts

## OAuth 2.1 Authorization Integration

The plugin includes comprehensive OAuth 2.1 authorization support for secure MCP communication. This enables token-based authentication, session management, and secure multi-user environments.

### Key Features

- **Complete OAuth 2.1 Support**: Authorization Code Flow with PKCE
- **Session-Based Authorization**: Token-to-session mapping with secure context
- **Authorization-Aware SSE**: Authorization context bound to each SSE session
- **JWT Token Validation**: Support for JWT tokens with JWKS endpoints
- **Token Introspection**: RFC 7662 compliant token introspection
- **Dynamic Client Registration**: RFC 7591 compliant client registration
- **Horizontal Scaling**: Redis-backed authorization context persistence

### Quick OAuth Setup

```typescript
import Fastify from 'fastify'
import mcpPlugin from '@platformatic/mcp'

const app = Fastify({ logger: true })

await app.register(mcpPlugin, {
  serverInfo: {
    name: 'secure-mcp-server',
    version: '1.0.0'
  },
  capabilities: {
    tools: {},
    resources: {},
    prompts: {}
  },
  enableSSE: true, // Required for session-based authorization
  // Enable OAuth 2.1 authorization
  authorization: {
    enabled: true,
    authorizationServers: ['https://auth.example.com'],
    resourceUri: 'https://mcp.example.com',
    // JWT Token Validation
    tokenValidation: {
      jwksUri: 'https://auth.example.com/.well-known/jwks.json',
      validateAudience: true
    }
  },
  // Redis for session persistence (recommended), with the shared secret it requires
  requestStateSecret: process.env.MCP_REQUEST_STATE_SECRET,
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379')
  }
})

await app.listen({ port: 3000 })
```

### Authorization Workflow

#### 1. OAuth Authorization Flow

The MCP client discovers the authorization server through the MCP server's
protected-resource metadata. It then registers or identifies itself with that
authorization server and performs Authorization Code with PKCE directly:

1. The MCP client sends its registered `redirect_uri` to the authorization server.
2. The authorization server returns an authorization code to the client callback.
3. The MCP client exchanges the code with its PKCE verifier.
4. The MCP client sends the resulting bearer token to the MCP server.

Client redirect URIs are not sent to the MCP server. The MCP server does not
forward access tokens through browser redirects.

#### 2. Authenticated MCP Requests

```typescript
// Use access token for MCP requests
const mcpResponse = await fetch('/mcp', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${access_token}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  },
  body: JSON.stringify({
    jsonrpc: '2.0',
    method: 'tools/list',
    id: 1
  })
})
```

#### 3. Session-Based SSE Connections

```typescript
// SSE connection with authorization
const eventSource = new EventSource('/mcp', {
  headers: {
    'Authorization': `Bearer ${access_token}`,
    'Accept': 'text/event-stream'
  }
})

eventSource.onmessage = (event) => {
  const message = JSON.parse(event.data)
  console.log('Received:', message)
}
```

### Authorization Configuration

#### Choosing Which Routes Require a Token

By default the plugin adds the bearer-token check as a `preHandler` hook on
the Fastify instance it is registered on. Because the plugin is not
encapsulated, that check also covers every route you register yourself on
that instance. The well-known metadata endpoints and the OAuth flow endpoints
(`/oauth/authorize`, `/oauth/callback`, `/oauth/register`) are always skipped.

Set `protectedRoutes: 'mcp'` to protect only the MCP endpoints the plugin
registers (`POST`, `GET` and `DELETE` `/mcp`) and leave your own routes alone:

```typescript
await app.register(mcpPlugin, {
  authorization: {
    enabled: true,
    authorizationServers: ['https://auth.example.com'],
    resourceUri: 'https://mcp.example.com',
    tokenValidation: {
      jwksUri: 'https://auth.example.com/.well-known/jwks.json'
    },
    protectedRoutes: 'mcp' // default: 'all'
  }
})

// Reachable without a token
app.get('/health', async () => ({ status: 'ok' }))
```

| Value | Behaviour |
|-------|-----------|
| `'all'` (default) | Every route of the app requires a token, except the well-known and OAuth endpoints. |
| `'mcp'` | Only the `/mcp` routes require a token. |

If you keep the default and only need to open a few paths, list them in
`excludedPaths` instead. Each entry is a URL prefix string or a `RegExp`:

```typescript
authorization: {
  enabled: true,
  // ...
  excludedPaths: ['/health', /^\/public\//]
}
```

`excludedPaths` also applies with `protectedRoutes: 'mcp'`, but there it only
matters for the `/mcp` routes.

#### JWT Token Validation

```typescript
authorization: {
  enabled: true,
  tokenValidation: {
    // JWKS endpoint for public key retrieval
    jwksUri: 'https://auth.example.com/.well-known/jwks.json',
    
    // Validate token audience
    validateAudience: true
  }
}
```

#### Token Introspection (RFC 7662)

```typescript
authorization: {
  enabled: true,
  tokenValidation: {
    // Use token introspection instead of JWT
    introspectionEndpoint: 'https://auth.example.com/oauth/introspect',
    clientId: process.env.OAUTH_CLIENT_ID,
    clientSecret: process.env.OAUTH_CLIENT_SECRET
  }
}
```

#### Required Scopes and Scope Hierarchies

`requiredScopes` lists the scopes a token must carry to reach the MCP
endpoints. A valid token missing any of them gets a `403` with a
`WWW-Authenticate: Bearer error="insufficient_scope"` challenge.

By default, scopes are matched exactly. If your authorization server issues
hierarchical scopes, pass `scopeImplies(granted, required)` to decide whether a
granted scope satisfies a required one. The built-in `colonScopeHierarchy`
helper implements the `resource:action` convention: `files` implies
`files:read`, but `files:read` does not imply `files`, and `filesystem` does
not imply `files:read`.

```typescript
import mcpPlugin, { colonScopeHierarchy } from '@platformatic/mcp'

await app.register(mcpPlugin, {
  authorization: {
    enabled: true,
    authorizationServers: ['https://auth.example.com'],
    resourceUri: 'https://mcp.example.com',
    tokenValidation: { jwksUri: 'https://auth.example.com/.well-known/jwks.json' },
    requiredScopes: ['files:read'],
    // A token granted `files` is accepted
    scopeImplies: colonScopeHierarchy
  }
})
```

#### OAuth Client Configuration

This optional configuration is for server-side OAuth client operations. It is
not required for MCP clients, which authorize directly with the advertised
authorization server.

```typescript
authorization: {
  enabled: true,
  oauth2Client: {
    clientId: process.env.OAUTH_CLIENT_ID,
    clientSecret: process.env.OAUTH_CLIENT_SECRET,
    
    // Authorization server
    authorizationServer: 'https://auth.example.com',
    
    // Application configuration
    scopes: ['read', 'write', 'admin'],
    
    // Optional: Dynamic client registration
    dynamicRegistration: true
  }
}
```

### Session-Based Authorization

The plugin maps OAuth tokens to MCP sessions for efficient authorization:

```typescript
// Authorization context automatically added to sessions
interface SessionMetadata {
  id: string
  authorization?: {
    userId: string
    clientId: string
    scopes: string[]
    tokenHash: string // Secure hash of access token
    expiresAt: Date
    // ... additional context
  }
  tokenRefresh?: {
    refreshToken: string
    clientId: string
    authorizationServer: string
    scopes: string[]
  }
}
```

### Token Refresh

Automatic background token refresh is not available yet: there is no
`authorization.tokenRefresh` option and no `app.tokenRefreshService`
decorator. Clients are expected to refresh their own access tokens (for
example through `POST /oauth/refresh` when `oauth2Client` is configured).
End-to-end token refresh is tracked in
[#146](https://github.com/platformatic/mcp/issues/146).

### Authorization-Aware Tools

Access authorization context in tool handlers:

```typescript
app.mcpAddTool({
  name: 'user-profile',
  description: 'Get user profile information',
  inputSchema: Type.Object({})
}, async (params, { authContext }) => {
  if (!authContext?.userId) {
    return {
      content: [{ type: 'text', text: 'Authentication required' }],
      isError: true
    }
  }
  
  // Check required scopes
  if (!authContext.scopes?.includes('profile:read')) {
    return {
      content: [{ type: 'text', text: 'Insufficient permissions' }],
      isError: true
    }
  }
  
  // Use user context
  const profile = await getUserProfile(authContext.userId)
  
  return {
    content: [{
      type: 'text',
      text: `Profile: ${JSON.stringify(profile, null, 2)}`
    }]
  }
})
```

### Per-Tool Authorization

Tool-level checks like the one above keep the tool visible to every client and only fail at call time. To gate tools per request — hiding them from `tools/list` and rejecting `tools/call` in one place — provide a `canAccessTool` hook:

```typescript
await app.register(mcpPlugin, {
  authorization: { /* ... */ },
  canAccessTool: (toolName, context) => {
    if (context.operation === 'list') {
      return canSeeTool(toolName, context.authContext)
    }

    return canExecuteTool(toolName, context.authContext)
  }
})
```

The hook receives the tool name and a per-request context (`authContext`, `request`, `sessionId`, `operation`), and may be sync or async. It is consulted at both dispatch points, so list and call can never disagree:

- `tools/list` omits every tool the hook denies for that request, calling the hook with `operation: 'list'`. Per-tool checks run concurrently with a fixed cap (8 at a time), so an async hook backed by a database or HTTP service is not flooded with one lookup per registered tool; the listing keeps registration order.
- `tools/call` on a denied tool returns the same `-32602` (Invalid params) "Tool 'name' not found" protocol error as an unknown tool, calling the hook with `operation: 'call'`. The hook runs even for unknown names, so callers cannot probe for tools they are not allowed to see by response shape. Response timing is not guaranteed to be indistinguishable — it depends on what the hook itself does per name. Task-augmented calls (`task` field) and `app.mcpCallTool()` also use `operation: 'call'`.

Visibility and execution policies may intentionally differ — a tool hidden from `tools/list` can still be callable by a client that already knows its name.

A hook that throws denies access (fail closed) and logs a warning. Only an explicit `true` grants access. Without the hook, every registered tool stays visible and callable.

## Observing Tool Calls

Provide `onToolCallComplete` to observe every tool call, regardless of transport, in one place:

```typescript
await app.register(mcpPlugin, {
  onToolCallComplete: async (event) => {
    logger.info({
      tool: event.toolName,
      source: event.source,
      durationMs: event.durationMs,
      ok: event.outcome.ok
    }, 'tool call completed')
  }
})
```

The hook fires exactly once per tool call, after it settles: for JSON-RPC `tools/call`, for `app.mcpCallTool()`, and for a task-augmented call once execution finishes (not when the task is merely accepted). It also fires for access denial, unknown tools, invalid arguments, task-required outcomes, and a handler asking for client input (`reason: 'input-required'`; a multi round-trip retry is a new call and fires again). A task that pauses for client input is still one call: the hook fires once, when the task ends, with its final outcome. When the task ended `failed` or `cancelled` although its last round returned a result or asked for input (cancelled after the handler returned, out of input rounds, or timed out waiting for input), the outcome is `{ ok: false, reason: 'task-ended', status, message }`. It does not fire for `tools/list`, initialization/ping, or malformed requests where no tool name was resolved.

`event.source` is `'json-rpc'`, `'in-process'`, or `'task'`. `event.outcome` is the same `McpCallToolOutcome` returned by `mcpCallTool()`. The hook is awaited before the response is sent, so keep it fast; a throwing or rejecting hook is logged and otherwise ignored — it never changes the tool response.

Synchronous sources (`'json-rpc'` and `'in-process'`) expose the active `request`/`reply`. Task events never do: a task can finish after the original HTTP response has already completed, so `request`/`reply` are absent on `source: 'task'` events. Every event, regardless of source, carries `requestId` for correlation.

Duration semantics also differ by source: `'json-rpc'` and `'in-process'` durations include authorization, validation, sanitization, and execution. Task durations measure execution — validation, sanitization, and the tool call — excluding the time the task spent queued; for a task that paused for client input, they run from its first round to its last, waits included.

`event.arguments` are the raw, unredacted tool arguments. Redact sensitive values yourself before logging or persisting them.

## Customizing MCP Route Schemas

Use `transformRouteSchema` to customize Fastify/OpenAPI schema metadata on MCP transport routes without replacing handlers or route definitions.

Avoid adding a `body` schema to the `POST /mcp` route: Fastify answers a validation failure with
its own plain `400`, not a JSON-RPC error, and a 2026-07-28 client reads a `400` without a
recognized JSON-RPC error as a server that does not speak its revision.

```typescript
import Fastify from 'fastify'
import mcpPlugin from '@platformatic/mcp'

const app = Fastify()

await app.register(mcpPlugin, {
  transformRouteSchema (schema, { routeId }) {
    return {
      ...schema,
      tags: ['MCP'],
      security: [{ oauth2: ['tools:read'] }],
      operationId: routeId.replace('.', '-'),
      'x-roles': ['admin']
    }
  }
})
```

Route IDs are stable and map to MCP transport routes:

| Route ID | Method | Purpose |
|---|---|---|
| `mcp.post` | `POST` | MCP JSON-RPC messages |
| `mcp.get` | `GET` | MCP streaming/SSE connection |
| `mcp.delete` | `DELETE` | MCP session termination |

Behavior notes:

- The callback runs once per registered MCP transport route during startup.
- The plugin passes the original route schema object to the callback.
- Spread the incoming schema when you want to preserve existing fields.
- The callback is synchronous and must return a schema object.
- Returned metadata applies only to Fastify/OpenAPI schema fields.
- OAuth and well-known routes are not customized by this option in this version.

Security notes:

- OpenAPI schema metadata does not enforce authentication or authorization.
- For example, `security: [{ oauth2: ['tools:read'] }]` documents expectations but does not install auth checks.
- Enforcement still depends on your configured auth hooks, token validation, and tool access controls.

### OAuth Routes

When `oauth2Client` is configured, the plugin registers these legacy server-side OAuth client routes. They are not used by MCP clients to obtain tokens: client redirect URIs must be sent directly to the authorization server. `/oauth/authorize` rejects `redirect_uri`, and `/oauth/callback` never redirects access tokens.

- `GET /oauth/authorize` - Start the server-side OAuth client flow
- `GET /oauth/callback` - Handle authorization callback
- `POST /oauth/refresh` - Refresh access tokens
- `POST /oauth/validate` - Validate token
- `GET /oauth/status` - Check authorization status
- `POST /oauth/logout` - Revoke tokens and end session
- `POST /oauth/register` - Dynamic client registration (if enabled)

### Well-Known Endpoints

These routes are registered only when `authorization.enabled` is true. They are
all unauthenticated: the bearer-token check skips every path under
`/.well-known/`. They allow cross-origin `GET` requests (CORS) so browser-based
clients can discover them.

- `GET /.well-known/oauth-protected-resource` - OAuth 2.0 Protected Resource Metadata (RFC 9728). Its `resource` field is `resourceUri`.
- `GET /.well-known/oauth-protected-resource{path}` - Same metadata, served when `resourceUri` has a path (e.g. `resourceUri: 'https://mcp.example.com/mcp'` is served at `/.well-known/oauth-protected-resource/mcp`). This is the URL advertised in the `resource_metadata` parameter of `WWW-Authenticate` challenges, as required by RFC 9728 §3.1, and its `resource` field equals `resourceUri` exactly.
- `GET /.well-known/oauth-protected-resource/mcp` - Legacy MCP-specific metadata route, kept for backwards compatibility. Its `resource` field is `resourceUri` with `/mcp` appended. When `resourceUri` already ends in `/mcp`, this path is the RFC 9728 route above instead.
- `GET /.well-known/openid-configuration/mcp` - OpenID Connect style discovery document built from the first entry of `authorizationServers`, plus `mcp_resource_uri` and `mcp_authorization_servers`
- `GET /.well-known/mcp-resource-health` - Health check for the resource server: `{ status: 'healthy', resource, timestamp }`

Authorization server metadata is not served by this plugin. Clients discover it from the authorization servers listed in `authorization_servers` of the protected resource metadata (RFC 8414 / OpenID Connect Discovery on the authorization server itself).

These endpoints send CORS headers for any origin. This applies only to `/.well-known/*`; see [CORS](#cors) for `/mcp`.

### Security Considerations

#### Token Security

- **Secure Token Storage**: Tokens are hashed using SHA-256 for session mapping
- **Token Expiration**: Automatic cleanup of expired tokens and sessions
- **Scope Validation**: Granular permission checking in tool handlers
- **PKCE Support**: Proof Key for Code Exchange prevents authorization code interception

#### Session Isolation

- **User-Specific Sessions**: Sessions are isolated by user ID
- **Cross-Session Protection**: Users can only access their own sessions
- **Token Binding**: Sessions are cryptographically bound to specific tokens

#### Production Deployment

```typescript
// Production security configuration
authorization: {
  enabled: true,
  tokenValidation: {
    jwksUri: 'https://auth.company.com/.well-known/jwks.json',
    validateAudience: true
  }
}
```

### Testing Authorization

```typescript
// Test with valid token
const response = await app.inject({
  method: 'POST',
  url: '/mcp',
  headers: {
    'Authorization': 'Bearer valid-jwt-token',
    'Content-Type': 'application/json'
  },
  payload: {
    jsonrpc: '2.0',
    method: 'tools/list',
    id: 1
  }
})

// Test authorization failure
const unauthorized = await app.inject({
  method: 'POST',
  url: '/mcp',
  payload: { jsonrpc: '2.0', method: 'tools/list', id: 1 }
})
assert.strictEqual(unauthorized.statusCode, 401)
```

## Authentication & Security

The plugin implements comprehensive security measures to protect against common attacks and ensure safe operation with untrusted inputs.

### Security Features

- **OAuth 2.1 Authorization**: Complete authorization framework with session management
- **Input Sanitization**: Automatic sanitization of tool parameters and elicitation requests
- **Schema Validation**: TypeBox-based validation with length and complexity limits
- **Rate Limiting**: Built-in rate limiting capabilities for high-risk operations
- **Security Assessment**: Automatic risk assessment for tool annotations
- **DoS Protection**: Object depth limits, string length limits, and circular reference detection

### Tool Security Assessment

The plugin automatically assesses tool security risks based on annotations:

```typescript
app.mcpAddTool({
  name: 'file-operations',
  description: 'File system operations',
  annotations: {
    destructiveHint: true,  // ⚠️ High risk - logs security warning
    openWorldHint: false,   // 🔒 Closed world - medium risk
    readOnlyHint: false     // ✏️ Can modify environment
  },
  inputSchema: Type.Object({
    operation: Type.Union([
      Type.Literal('read'),
      Type.Literal('write'), 
      Type.Literal('delete')
    ]),
    path: Type.String({ maxLength: 1000 })
  })
}, async (params) => {
  // Tool parameters are automatically sanitized and validated
  // Security warnings are logged for high-risk operations
  return { content: [{ type: 'text', text: 'Operation completed' }] }
})
```

### Input Validation and Sanitization

All inputs undergo automatic security processing:

```typescript
// Automatic security measures applied:
// ✅ String length limits (default max 10,000 chars)
// ✅ Object depth limits (default max 10 levels)
// ✅ Property count limits (default max 100 per object, arrays not counted)
// ✅ Control character removal
// ✅ Circular reference detection
// ✅ Schema complexity validation
```

### Rate Limiting

Implement rate limiting for production deployments:

```typescript
import { RateLimiter } from '@platformatic/mcp'

const rateLimiter = new RateLimiter(100, 60000) // 100 requests per minute

// Use in tool handlers
app.mcpAddTool({
  name: 'rate-limited-tool',
  description: 'Tool with rate limiting',
  inputSchema: Type.Object({})
}, async (params, { sessionId }) => {
  if (sessionId && !rateLimiter.isAllowed(sessionId)) {
    return {
      content: [{ type: 'text', text: 'Rate limit exceeded' }],
      isError: true
    }
  }
  
  // Process request...
  return { content: [{ type: 'text', text: 'Success' }] }
})
```

### Bearer Token Authentication

For production deployments, secure the MCP endpoint using the `@fastify/bearer-auth` plugin:

```bash
npm install @fastify/bearer-auth
```

```typescript
import Fastify from 'fastify'
import mcpPlugin from '@platformatic/mcp'

const app = Fastify({ logger: true })

// Register bearer authentication
await app.register(import('@fastify/bearer-auth'), {
  keys: new Set(['your-secret-bearer-token']),
  auth: {
    // Apply to all routes matching this prefix
    extractToken: (request) => {
      return request.headers.authorization?.replace('Bearer ', '')
    }
  }
})

// Register MCP plugin (routes will inherit authentication)
await app.register(mcpPlugin, {
  // ... your configuration
})

// Usage with authentication
fetch('/mcp', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer your-secret-bearer-token',
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  },
  body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 })
})
```

### Environment-based Token Configuration

```typescript
await app.register(import('@fastify/bearer-auth'), {
  keys: new Set([process.env.MCP_BEARER_TOKEN || 'default-dev-token']),
  auth: {
    extractToken: (request) => {
      return request.headers.authorization?.replace('Bearer ', '')
    }
  }
})
```

## API Reference

### Plugin Options

- `serverInfo`: Server identification (name, version)
- `capabilities`: MCP capabilities configuration. `completions` is not supported (there is no `completion/complete` handler): it is dropped from the advertised capabilities and a warning is logged at registration
- `instructions`: Optional server instructions
- `enableSSE`: Enable Server-Sent Events support on `GET /mcp` (default: false). Sessions and `DELETE /mcp` work either way.
- `resolveAuthorizationContext`: Maps identities established by upstream Fastify authentication hooks into MCP authorization context (optional)
- `canAccessTool`: Per-request tool authorization hook consulted by `tools/list` and `tools/call` (optional)
- `onToolCallComplete`: Transport-neutral hook fired once after every tool call settles, across JSON-RPC, `mcpCallTool()`, and tasks (optional)
- `toolArgumentLimits`: Limits applied to tool arguments before the handler runs (optional): `maxStringLength` (default 10000), `maxObjectProperties` (default 100, arrays not counted), `maxArrayLength` (default unlimited), `maxDepth` (default 10). `Infinity` disables a limit
- `onClientResponse`: Receives the JSON-RPC responses clients POST back for server-initiated requests, such as elicitation results (optional)
- `authorization`: OAuth 2.1 authorization configuration (optional)
  - `enabled`: Enable OAuth 2.1 authorization (default: false)
  - `authorizationServers`: Authorization server URIs. JWTs must carry an `iss` matching one of these (a trailing slash difference is tolerated), plus `sub` and `exp`; introspection responses must carry `sub` and, if they report `iss`, a matching one
  - `resourceUri`: Resource URI. May include a path; the protected resource metadata is then served at `/.well-known/oauth-protected-resource{path}` (RFC 9728 §3.1)
  - `requiredScopes`: Scopes a token must carry (optional). Tokens missing any of them get a 403 `insufficient_scope` challenge. When set, the scopes are also advertised as `scopes_supported` in the protected resource metadata (every `/.well-known/oauth-protected-resource` route) and as `scope="..."` in the `WWW-Authenticate` header of every 401 challenge
  - `scopeImplies`: `(granted, required) => boolean` deciding whether a granted scope satisfies a required one (default: exact match; see `colonScopeHierarchy`)
  - `tokenValidation`: JWT token validation configuration
    - `jwksUri`: JWKS endpoint URL for JWT signature verification
    - `validateAudience`: Enable audience validation
    - `introspectionEndpoint`: Token introspection endpoint (alternative to JWT)
  - `oauth2Client`: OAuth 2.1 client configuration
    - `clientId`: OAuth client identifier
    - `clientSecret`: OAuth client secret
    - `authorizationServer`: Authorization server URI.
    - `resourceUri`: Resource URI.
    - `scopes`: Requested OAuth scopes
    - `dynamicRegistration`: Enable dynamic client registration (default: false)
- `requestStateSecret`: Secret (at least 32 bytes) that seals multi round-trip
  `requestState`. Set it when `redis` is configured, since any instance may serve a retry
  (the plugin warns at startup otherwise). An array rotates secrets: the first seals, any
  verifies. Rotate in three deploys so no retry fails mid-rollout: `[old, new]` (every
  instance accepts the new one), then `[new, old]` (instances seal with it), then `[new]`
  once `requestStateTtlMs` has passed
- `requestStateTtlMs`: How long sealed state stays valid (default 5 minutes). Must be a positive integer; anything else throws at startup
- `requestStateMaxAnswerBytes`: How many bytes of JSON of earlier answers sealed state carries
  into later rounds (default 65536); asking again past it fails with `-32602`, and `0` carries none
- `caching`: Freshness hints per cacheable operation (default `{ ttlMs: 0, cacheScope: 'private' }`)
- `enableTasks`: Enable tasks (the 2025-11-25 core tasks and the 2026-07-28 extension)
- `taskDefaultTtlMs` / `taskMaxTtlMs`: Task retention (defaults 60000 / 3600000)
- `taskMaxConcurrent`: Most tasks one instance runs at once, for both protocol eras (default 1000).
  A task counts until its handler settles, even when that is past its ttl
- `taskMaxPerPrincipal`: Most tasks one caller (a user at an issuer) runs on an instance
  (default 100). Not applied to callers the deployment cannot identify
- `taskStoreMaxTasks`: Capacity of the in-memory task store, finished tasks included until their
  ttl (default 1000). A full store evicts the oldest finished task, and refuses new tasks only when
  every stored task is still running
- `taskMaxRetainedPerPrincipal`: Most tasks one caller keeps stored, finished ones included
  (default 100). At the cap the caller's oldest finished task is evicted
- `taskLeaseMs`: Worker lease; a task whose worker stops renewing it is reported failed
  (default 15000)
- `taskMaxInputRounds`: How many times a 2026-07-28 task's handler may ask the client for input
  before the task fails (default 32). Rounds that only carry state do not count
- `taskShutdownTimeoutMs`: How long `close()` waits for running tasks before failing them
  (default 5000; keep it below Fastify's `pluginTimeout`). Tasks parked in `input_required`
  are failed at once, since no answer can reach them during a shutdown, and
  `subscriptions/listen` streams are ended gracefully only after the drain
- `subscriptionMaxStreams` / `subscriptionMaxStreamsPerPrincipal` /
  `subscriptionMaxResourceUris`: Bounds on `subscriptions/listen` (defaults 1000 / 10 / 1000)
- `redis`: Redis configuration for horizontal scaling (optional)
  - `host`: Redis server hostname
  - `port`: Redis server port
  - `db`: Redis database number
  - `password`: Redis authentication password
  - Any other ioredis [`RedisOptions`](https://github.com/redis/ioredis/blob/main/lib/redis/RedisOptions.ts) (`tls`, `retryStrategy`, `sentinels`, ...); the object is passed to the ioredis constructor as-is

### Decorators

The plugin adds the following decorators to your Fastify instance:

#### Type-Safe Tool Registration

```typescript
// With TypeBox schema (recommended)
app.mcpAddTool<TSchema extends TObject>(
  definition: { name: string, description: string, inputSchema: TSchema },
  handler?: (params: Static<TSchema>, context: HandlerContext) => Promise<CallToolResult>
)

// Without schema (unsafe)
app.mcpAddTool(
  definition: { name: string, description: string },
  handler?: (params: any, context: HandlerContext) => Promise<CallToolResult>
)
```

#### Server-Side Tool Invocation

Use `app.mcpCallTool()` when application code needs to run a registered tool without making a loopback `POST /mcp` request or building a JSON-RPC envelope. The call uses the same tool registry, input validation, `canAccessTool` hook, argument sanitization, required task execution check and handler error conversion as `tools/call`, but it does not create or use an MCP session, SSE stream, message broker or Redis connection. `mcpCallTool()` executes the tool access, validation, sanitization, and handler pipeline. It does not run Fastify lifecycle hooks and is only available in the Fastify encapsulation scope where the MCP plugin was registered and its descendants.

```typescript
const outcome = await app.mcpCallTool('search', { query: 'fastify' }, { request, reply })

if (outcome.ok) {
  return outcome.result
}

switch (outcome.reason) {
  case 'not-found':
    reply.code(404)
    return { error: 'Tool not found' }
  case 'access-denied':
    reply.code(403)
    return { error: 'Tool access denied' }
  case 'invalid-arguments':
    reply.code(400)
    return { error: outcome.detail }
  case 'task-required':
    reply.code(409)
    return { error: 'Tool must be invoked through task-augmented tools/call' }
  case 'input-required':
    reply.code(409)
    return { error: 'Tool needs client input', inputRequests: outcome.inputRequests }
  case 'task-ended': // only reported to onToolCallComplete, for tasks
    reply.code(500)
    return { error: outcome.message }
}
```

The `canAccessTool` hook still runs before validation and before the handler, and receives the same `request` object passed to `mcpCallTool()`. Unlike the JSON-RPC `tools/call` path — which always answers a denied tool exactly like an unknown one, so a remote client cannot probe for tools it is not allowed to see — `mcpCallTool()` is a trusted in-process call and reports the precise reason: `{ ok: false, reason: 'not-found' }` when the tool is not registered, `{ ok: false, reason: 'access-denied' }` when it is registered but `canAccessTool` denied it (existence takes precedence, so an unknown name is always `not-found` even if the hook would also have denied it). Pass the route's real `reply` so tool handlers can use the full Fastify reply API. Pass `authContext` when the in-process caller has one so access hooks and handlers see the same authorization context they would receive over HTTP. If the tool handler throws, the outcome is `{ ok: true, result }` with `result.isError: true`, matching the JSON-RPC `tools/call` path. The exception is `InputRequired`: there is no client to answer it in-process, so the outcome is `{ ok: false, reason: 'input-required', inputRequests }`. Every argument rejection that happens before the handler runs — TypeBox validation, AJV validation, or argument sanitization — is reported as `{ ok: false, reason: 'invalid-arguments', detail }`; the handler is never invoked for those.

#### Type-Safe Resource Registration

```typescript
// With URI schema
app.mcpAddResource<TUriSchema extends TSchema>(
  definition: { uriPattern: string, name: string, description: string, uriSchema?: TUriSchema },
  handler?: (uri: Static<TUriSchema>, context: HandlerContext) => Promise<ReadResourceResult>
)

// Without schema
app.mcpAddResource(
  definition: { uriPattern: string, name: string, description: string },
  handler?: (uri: string, context: HandlerContext) => Promise<ReadResourceResult>
)
```

#### Type-Safe Prompt Registration

```typescript
// With argument schema (automatically generates arguments array)
app.mcpAddPrompt<TArgsSchema extends TObject>(
  definition: { name: string, description: string, argumentSchema?: TArgsSchema },
  handler?: (name: string, args: Static<TArgsSchema>, context: HandlerContext) => Promise<GetPromptResult>
)

// Without schema
app.mcpAddPrompt(
  definition: { name: string, description: string, arguments?: PromptArgument[] },
  handler?: (name: string, args: any, context: HandlerContext) => Promise<GetPromptResult>
)
```

#### Server-Side Tool Registry Introspection

Use these decorators to introspect tool registration state from server-side code:

- `app.mcpHasTool(name: string): boolean`
- `app.mcpListToolNames(): readonly string[]`

Important behavior:

- Available only within the MCP plugin Fastify encapsulation scope (the registration scope and descendants)
- Reports registration state, not request-specific visibility
- Does not evaluate `canAccessTool`
- Returns a read-only snapshot of names in registration order

Because this API is authorization-agnostic by design, avoid exposing it directly to untrusted clients unless you enforce your own authorization.

```typescript
await app.register(mcpPlugin)

app.mcpAddTool({
  name: 'search',
  description: 'Search documents',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' }
    },
    required: ['query']
  }
}, async ({ query }) => {
  return {
    content: [{ type: 'text', text: `Searching for ${query}` }]
  }
})

app.get('/internal/tool-status', async () => {
  return {
    searchRegistered: app.mcpHasTool('search'),
    registeredTools: app.mcpListToolNames()
  }
})
```

This route is illustrative only and should be protected in real deployments.

#### HTTP Context Access in Tool Handlers

Tool handlers can access the Fastify request and reply objects through the context parameter, enabling tools to interact with HTTP-specific features like headers, query parameters, and custom response headers. 

The request and reply objects are now consistently provided across all communication modes (HTTP, SSE, and STDIO), ensuring handlers always have access to HTTP context regardless of how they're invoked.

```typescript
app.mcpAddTool({
  name: 'context-aware-tool',
  description: 'Tool that uses HTTP context',
  inputSchema: Type.Object({
    message: Type.String()
  })
}, async (params, context) => {
  // Access request information
  const userAgent = context.request.headers['user-agent']
  const queryParams = context.request.query
  const requestUrl = context.request.url
  
  // Set custom response headers
  context.reply.header('x-processed-by', 'mcp-tool')
  context.reply.header('x-request-id', Date.now().toString())
  
  return {
    content: [{
      type: 'text',
      text: `Processed "${params.message}" from ${userAgent || 'unknown client'}`
    }]
  }
})
```

#### Available Context Properties

All handlers receive a consistent context object containing:

- `context.request`: Full Fastify request object with access to:
  - `headers`: HTTP request headers
  - `query`: Query string parameters
  - `params`: Route parameters
  - `url`: Request URL
  - `method`: HTTP method
  - `body`: Request body (when applicable)
- `context.reply`: Fastify reply object for setting response headers
- `context.sessionId`: Session identifier (when using SSE)
- `context.authContext`: Authorization context, from built-in OAuth, `resolveAuthorizationContext`,
  or the stdio transport's `authContext` option
- `context.signal`: `AbortSignal` that aborts when the request is cancelled: a 2026-07-28 client
  disconnecting before the response, `notifications/cancelled` on stdio, or `tasks/cancel` for a
  handler running as a task (in either era). A 2026-07-28 request is also aborted when the server
  shuts down, so a long-running handler cannot hold `app.close()` open. Pass it to `fetch` or
  check it between steps to stop work early. A legacy HTTP disconnect does not abort it, since it
  is not a cancellation there.
- `context.protocolVersion`: the protocol revision the request is served under.
- `context.clientCapabilities`: what a 2026-07-28 client declared on this request, so a handler
  can choose URL-mode over form elicitation, or skip asking a client that cannot answer. Absent
  on the legacy path.

#### Backward Compatibility

The context parameter is always provided to handlers. The request and reply objects are now consistently provided in all communication modes (HTTP, SSE, and STDIO):

```typescript
// Existing handler (still works)
app.mcpAddTool({
  name: 'legacy-tool',
  description: 'Works as before',
  inputSchema: Type.Object({ msg: Type.String() })
}, async (params) => {
  return { content: [{ type: 'text', text: params.msg }] }
})

// Handler using only sessionId (still works)
app.mcpAddTool({
  name: 'session-tool',
  description: 'Uses session ID only',
  inputSchema: Type.Object({})
}, async (params, { sessionId }) => {
  return { content: [{ type: 'text', text: `Session: ${sessionId}` }] }
})
```

#### Context Access in Resource and Prompt Handlers

Resource and prompt handlers also receive the same context object as tool handlers, enabling access to HTTP context and authorization information:

When `uriPattern` contains `{name}` placeholders (an RFC 6570 level-1 template), `resources/read` for a concrete URI such as `context://data/42` is routed to it, and the values are available as `context.uriParams` (`{ id: '42' }`). Each placeholder matches a single non-empty segment that does not contain `/`; an exact `uri` registration always takes precedence over a template.

```typescript
// Resource handler with context
app.mcpAddResource({
  name: 'context-aware-resource',
  description: 'Resource that uses HTTP context',
  uriPattern: 'context://data/{id}'
}, async (uri, context) => {
  // Access request information
  const userAgent = context.request.headers['user-agent']
  const authUser = context?.authContext?.userId
  const id = context.uriParams?.id

  return {
    contents: [{
      uri,
      text: `Resource ${id} accessed by ${authUser || 'anonymous'} from ${userAgent || 'unknown client'}`,
      mimeType: 'text/plain'
    }]
  }
})

// Prompt handler with context
app.mcpAddPrompt({
  name: 'context-aware-prompt',
  description: 'Prompt that uses HTTP context'
}, async (name, args, context) => {
  const sessionId = context?.sessionId
  const userId = context?.authContext?.userId
  
  return {
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: `Prompt ${name} for user ${userId || 'anonymous'} in session ${sessionId || 'none'}`
      }
    }]
  }
})
```

### Messaging Functions

- `app.mcpBroadcastNotification(notification)`: Broadcast a notification to all connected SSE clients (works across Redis instances). `notifications/resources/updated` only reaches sessions subscribed to its `params.uri`
- `app.mcpSendToSession(sessionId, message)`: Send a message/request to a specific SSE session (works across Redis instances)

## Handler API Reference

All MCP handlers follow a consistent pattern where the context parameter is always provided as the final parameter:

```typescript
// HandlerContext interface (available to all handlers)
interface HandlerContext {
  sessionId?: string              // Session identifier (SSE mode)
  request: FastifyRequest         // HTTP request object
  reply: FastifyReply            // HTTP reply object
  authContext?: AuthorizationContext  // OAuth authorization data
  protocolVersion?: string        // Revision this request is served under
  clientCapabilities?: ClientCapabilities // Declared per request (2026-07-28)
  signal: AbortSignal             // Aborts when the request is cancelled
  sendProgress: (progress: number, total?: number, message?: string) => void
  log: (level: LoggingLevel, data: unknown, logger?: string) => void
}

// Normalized handler signatures
type ToolHandler = (params: any, context: HandlerContext) => Promise<CallToolResult>
type ResourceHandler = (uri: string, context: HandlerContext) => Promise<ReadResourceResult>
type PromptHandler = (name: string, args: any, context: HandlerContext) => Promise<GetPromptResult>
```

**Handler Invocation Summary:**
- **Tool handlers**: Receive validated, typed arguments and return `CallToolResult`
- **Resource handlers**: Receive validated URIs and return `ReadResourceResult`  
- **Prompt handlers**: Receive the prompt name and validated arguments, return `GetPromptResult`
- **All handlers**: Optionally receive `HandlerContext` with session, HTTP, and auth information

### MCP Endpoints

The plugin exposes the following endpoints using a dual-endpoint architecture:

- `POST /mcp`: Handles all JSON-RPC 2.0 MCP protocol messages
  - Returns `Content-Type: application/json; charset=utf-8`, except for 2026-07-28 requests
    answered as a stream: `subscriptions/listen`, and requests that report progress or logs
    and accept `text/event-stream`
  - Processes initialize, tool calls, resource reads, prompt gets, etc.
  - Creates and manages session IDs when SSE is enabled
  - Authorization-aware when OAuth is enabled
- `GET /mcp`: Establishes Server-Sent Events streams (when SSE is enabled)
  - Always returns `Content-Type: text/event-stream`
  - Requires `Accept: text/event-stream` header
  - Uses session ID from previous POST request or creates new session
  - Provides real-time server-to-client notifications
  - Supports message replay with Last-Event-ID
  - Authorization-aware with user-specific session isolation

### OAuth Endpoints (when `oauth2Client` is configured)

These legacy server-side OAuth client endpoints do not proxy MCP client authorization or redirect access tokens to client callbacks.

- `GET /oauth/authorize`: Start the server-side OAuth client flow with PKCE
- `GET /oauth/callback`: Handle authorization callback and exchange code for tokens
- `POST /oauth/refresh`: Refresh access tokens using refresh tokens
- `POST /oauth/validate`: Validate access tokens (JWT or introspection)
- `GET /oauth/status`: Check current authorization status
- `POST /oauth/logout`: Revoke tokens and end OAuth session
- `POST /oauth/register`: Dynamic client registration (if enabled)

### Well-Known Endpoints

Registered only when authorization is enabled, and always unauthenticated:

- `GET /.well-known/oauth-protected-resource`: OAuth 2.0 Protected Resource Metadata (RFC 9728)
- `GET /.well-known/oauth-protected-resource{path}`: Same metadata at the RFC 9728 §3.1 location when `resourceUri` has a path
- `GET /.well-known/oauth-protected-resource/mcp`: Legacy MCP-specific protected resource metadata
- `GET /.well-known/openid-configuration/mcp`: OpenID Connect style discovery document
- `GET /.well-known/mcp-resource-health`: Resource server health check

The plugin does not register a `/health` route; add your own if you need one.

## Supported MCP Methods

Served on both eras:

- `tools/list`: List available tools
- `tools/call`: Execute a tool (calls registered handler or returns error)
- `resources/list`: List available resources
- `resources/templates/list`: List resource templates
- `resources/read`: Read a resource (calls registered handler or returns error)
- `prompts/list`: List available prompts
- `prompts/get`: Get a prompt (calls registered handler or returns error)

`2026-07-28` only:

- `server/discover`: Supported versions, capabilities and identity in one request
- `subscriptions/listen`: Long-lived notification stream
- `tasks/get`, `tasks/update`, `tasks/cancel`: Tasks extension

`2025-11-25` and earlier only:

- `initialize`: Server initialization
- `ping`: Health check
- `resources/subscribe`, `resources/unsubscribe`: Per-resource subscriptions
- `tasks/get`, `tasks/result`, `tasks/list`, `tasks/cancel`: Core tasks

## Security Best Practices

This section outlines security considerations and best practices when using the Fastify MCP plugin implementation.

### ⚠️ Important Security Notices

#### Tool Annotations Are Hints Only

**🚨 CRITICAL:** Tool annotations (such as `destructiveHint`, `openWorldHint`, etc.) are **hints from potentially untrusted servers** and should **NEVER** be used for security decisions.

- Annotations can be provided by untrusted MCP servers
- They are not guaranteed to accurately describe tool behavior  
- Always implement your own security validation regardless of annotations
- Use annotations only for UI/UX improvements, not security controls

#### Elicitation Security

When using the elicitation feature (server-to-client information requests):

- **Validate all user inputs** before processing elicitation responses
- **Limit elicitation message length** to prevent DoS attacks
- **Validate schema complexity** to prevent resource exhaustion
- **Implement rate limiting** for elicitation requests
- **Always require user consent** before sharing sensitive information

### Input Validation and Sanitization

#### Tool Parameters

The plugin automatically checks tool parameters to prevent common attacks:

- **String length limits:** Maximum 10,000 characters per string
- **Object depth limits:** Maximum 10 levels of nesting
- **Property count limits:** Maximum 100 properties per object (array items are not counted)
- **Array length limits:** Unlimited by default
- **Control character rejection:** Arguments whose keys or string values contain null bytes or other control characters (tabs and newlines excepted) are refused, never rewritten, so the handler sees exactly what the client sent
- **Circular reference detection:** Prevents infinite loops

The limits are configurable with the `toolArgumentLimits` option. Pass `Infinity` to disable one;
Fastify's `bodyLimit` still caps the total request size. Arguments over a limit are refused with an
`isError: true` result and the tool handler is not called.

```typescript
await app.register(mcpPlugin, {
  toolArgumentLimits: {
    maxStringLength: 1_000_000, // default 10000
    maxObjectProperties: 500,   // default 100
    maxArrayLength: 10_000,     // default Infinity
    maxDepth: 10                // default 10
  }
})
```

#### Schema Validation

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

### Tool Security Assessment

The plugin automatically assesses tool security risks:

#### Risk Levels

- **Low Risk:** Read-only tools with closed-world domains
- **Medium Risk:** Tools that interact with external entities
- **High Risk:** Destructive tools that modify the environment

#### Security Warnings

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

### Rate Limiting

Implement rate limiting to prevent abuse:

```typescript
import { RateLimiter } from '@platformatic/mcp'

const rateLimiter = new RateLimiter(100, 60000) // 100 requests per minute

// Check before processing requests
if (!rateLimiter.isAllowed(sessionId)) {
  throw new Error('Rate limit exceeded')
}
```

### Redis Security (Production Deployments)

When using Redis for horizontal scaling:

#### Connection Security

```typescript
await app.register(mcpPlugin, {
  enableSSE: true,
  requestStateSecret: process.env.MCP_REQUEST_STATE_SECRET, // at least 32 bytes
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

#### Redis Best Practices

- **Always use authentication:** Set `requirepass` in Redis config
- **Enable TLS encryption:** Especially for remote Redis instances
- **Use dedicated Redis database:** Isolate MCP data with `db` parameter
- **Implement network security:** Use VPCs, security groups, firewalls
- **Regular updates:** Keep Redis version up-to-date
- **Monitor access:** Log and monitor Redis access patterns

### Session Security

#### Session Management

- **Session IDs are cryptographically secure:** Generated using Node.js crypto
- **Sessions are bound to their owner:** With authorization enabled, a session remembers the issuer and `sub` of the token that created it; a subject is only unique per issuer, so both must match. Requests (POST, GET, DELETE) presenting that `Mcp-Session-Id` with a token from a different issuer or for a different subject get `404 Session not found`, the same answer as for an unknown session, so a leaked session ID cannot be used by another user. The issuer is the verified JWT `iss` (a trailing slash is ignored). Introspection responses may omit `iss` (RFC 7662); the issuer is then taken from configuration as `introspection:<introspectionEndpoint>`, the endpoint that vouched for the token, so such sessions never match a JWT or an introspection response that names an issuer
- **Automatic cleanup:** Sessions expire after 1 hour by default
- **Message history limits:** Prevents unbounded memory growth
- **Cross-instance isolation:** Sessions are properly isolated between instances

#### SSE Security

Server-Sent Events implementation includes:

- **Proper CORS handling:** Configure CORS policies appropriately
- **Connection limits:** Implement connection limits per client
- **Heartbeat monitoring:** Automatic cleanup of dead connections
- **Message replay security:** Last-Event-ID validation

### Environment Security

#### Environment Variables

Never expose sensitive configuration:

```bash
# ✅ Good: Use environment variables
REDIS_PASSWORD=your-secure-password
MCP_SECRET_KEY=your-secret-key

# ❌ Bad: Hardcoded secrets
const redis = { password: 'hardcoded-password' }
```

#### Logging Security

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

### Transport Security

#### HTTPS Requirements

**Always use HTTPS in production:**

```typescript
const app = fastify({
  https: {
    key: fs.readFileSync('path/to/key.pem'),
    cert: fs.readFileSync('path/to/cert.pem')
  }
})
```

### Error Handling Security

#### Information Disclosure

Prevent information leakage in error messages:

```typescript
// ✅ Good: Generic error messages
return createError(request.id, INVALID_PARAMS, 'Invalid parameters')

// ❌ Bad: Detailed error messages
return createError(request.id, INVALID_PARAMS, `SQL injection attempt detected: ${details}`)
```

#### Error Logging

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

### Security Monitoring and Alerting

#### Security Metrics

Monitor these security-related metrics:

- Failed validation attempts per session
- Rate limit violations
- High-risk tool executions  
- Unusual session patterns
- Redis connection failures

#### Alert Conditions

Set up alerts for:

- Multiple validation failures from same IP
- Rapid tool execution patterns
- Large payload sizes
- Suspicious schema patterns in elicitation

### Security Updates

#### Keeping Secure

- **Regular updates:** Keep all dependencies up-to-date
- **Security advisories:** Subscribe to security notifications
- **Vulnerability scanning:** Regularly scan for known vulnerabilities
- **Security testing:** Include security tests in your CI/CD pipeline

### Quick Security Checklist

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

## Migration from Earlier Versions

### Breaking changes in 3.0.0

The 2026-07-28 support ships as a major release. Legacy clients need no changes; these are
the changes to the plugin's own API and defaults:

- **`LATEST_PROTOCOL_VERSION` is `2026-07-28`**, and `SUPPORTED_PROTOCOL_VERSIONS` includes it.
  Use `LATEST_LEGACY_PROTOCOL_VERSION` for the newest handshake revision (see below).
- **`HandlerContext` gained required members**: `signal`, `sendProgress` and `log`. Code that
  builds a context by hand (for example to unit-test a handler) must provide them.
- **`TaskStore` gained methods**: `updateInputResponses`, `acknowledgeInputResponses`,
  `renewLease` and `expireStaleLease`, and `list` takes `{ cursor, limit, era }` and returns
  `{ tasks, nextCursor? }`, throwing `InvalidTaskCursorError` for a cursor it did not issue.
  `create` throws `TaskLimitError` at a caller's retention cap. The plugin builds its own store
  (there is no option to supply one); code that implements the exported `TaskStore` interface
  for its own use must follow these.
- **Redis task records moved** to the `mcp:task:v3:` keyspace, so instances of different
  versions never misread each other's tasks. During a rolling deploy, tasks created by an
  instance of the previous version are invisible to upgraded instances (and the reverse): a
  client polling such a task through an upgraded instance gets "Task not found". Drain tasks
  before upgrading, or accept that tasks in flight may have to be restarted.
- **Tasks are bound to user, OAuth client and issuer**, not the user alone, in both eras.
  `TaskRecord.authSubject` now holds that principal as a JSON string rather than a bare user
  id, so code that reads task records or calls `list(subject)` on a `MemoryTaskStore` or
  `RedisTaskStore` directly must pass it through unchanged. The retention cap counts
  `TaskRecord.quotaKey` (the user at their issuer), so a user's OAuth clients share it.
- **Task limits apply to both eras**: 2025-11-25 tasks count against `taskMaxConcurrent` and
  `taskMaxPerPrincipal` (answering `-32029` past them), are aborted at their ttl and are
  drained on shutdown.
- **Task retention is capped per caller** (`taskMaxRetainedPerPrincipal`, default 100) in both
  stores and both eras; at the cap, and when the in-memory store is full, the oldest finished
  task is evicted, so a finished result its client has not read yet can be lost.
- **`requestStateMaxAnswerBytes` fails rather than truncates**: a retry whose carried answers
  exceed it is answered `-32602`; handlers choose what is carried with `InputRequired`'s `carry`.
- **`HandlerContext.authContext.authorizationServer` is the normalized issuer** the token
  validator vouched for (no trailing slash; `introspection:<endpoint>` for an introspected
  token without `iss`), as sessions already used.
- **`requestStateSecret` must be at least 32 bytes**; with `redis` and no secret the plugin
  warns at startup, as multi round-trip retries would fail across instances.
- **Default capabilities declare `listChanged: true`** for tools, prompts and resources, and
  registering one after ready broadcasts `list_changed`. Legacy clients only see `listChanged`
  when `enableSSE` is on.
- **A tool registered without `inputSchema`** is listed with `{ "type": "object" }`.
- **`outputSchema` is enforced** (2025-06-18 and later): a result without conforming
  `structuredContent` becomes a tool error, and an `outputSchema` declaring a dialect other
  than JSON Schema 2020-12 is refused at registration.
- **Invalid `caching` values throw at startup** instead of being clamped.
- **An argument sanitization failure** is reported by `mcpCallTool()` as
  `{ ok: false, reason: 'invalid-arguments' }`.
- **`McpCallToolOutcome` has an `input-required` variant**: a tool that throws `InputRequired`
  under `mcpCallTool()` now returns `{ ok: false, reason: 'input-required', inputRequests }`
  instead of rejecting, and `onToolCallComplete` fires with it. A `task-ended` variant reports
  to `onToolCallComplete` a 2026-07-28 task that ended differently from its last round.
  Exhaustive `switch` statements over `outcome.reason` need the new cases.
- **Tool arguments are never rewritten.** Keys or string values containing control characters
  (other than tab, newline and carriage return) are refused as invalid arguments instead of
  being stripped, and `validateJsonSchemaInputs` no longer coerces types, injects defaults or
  removes properties (the `coerceTypes`, `useDefaults` and `removeAdditional` AJV options are
  ignored).
- **stdio requests skip HTTP authorization.** stdio has no bearer token: the client is whoever
  started the process. With authorization enabled, stdio requests used to be refused with `401`;
  now they run as the identity passed to `runStdioServer(app, { authContext })`, or anonymously
  without one (then multi round-trip requests and tasks are refused, since they need an
  identified caller). `resolveAuthorizationContext` is not called for them; use the exported
  `isStdioRequest(request)` to let them through your own authentication hooks.
- **`subscriptions/listen` calls the resource subscribe handlers**: `mcpSetResourceSubscribeHandler`
  runs for each requested URI (a throw drops the URI), and the unsubscribe handler when the last
  stream on the instance holding that URI ends. Without a subscribe handler no resource URI is accepted, as `resources/subscribe` answers
  `-32601` then.
- **Legacy clients without `enableSSE` no longer see `resources.subscribe`**, since updates could
  never reach them.
- **`GET /mcp` answers `405` with `Allow: POST, DELETE`** when `enableSSE` is off; a modern
  caller's `GET` or `DELETE` gets `405` with `Allow: POST`.
- **Body-parser errors on `/mcp` are JSON-RPC errors**: malformed JSON is `-32700`, a body over
  the size limit or with the wrong content type is `-32600`, with the same HTTP status as before.
- **Legacy task responses only carry the spec's `Task` fields.**
- **Era detection**: a request whose `_meta` carries `io.modelcontextprotocol/protocolVersion`,
  or whose `MCP-Protocol-Version` header names 2026-07-28, takes the modern path. With
  authorization enabled, a POST with a bad version header now gets `401` before `400`.

### Upgrading to MCP 2026-07-28

Clients that speak `2025-11-25` or earlier need no changes, and adopting the new revision is
opt-in per client. Deployments may need a configuration change: a `redis` deployment should
set `requestStateSecret` (it warns at startup otherwise), and the other items under
[Breaking changes](#breaking-changes-in-300) apply to the legacy path too.

**What is new**

- Requests carry `_meta` with `io.modelcontextprotocol/protocolVersion` and
  `io.modelcontextprotocol/clientCapabilities`, plus `MCP-Protocol-Version`, `Mcp-Method`
  and (where applicable) `Mcp-Name` headers that must agree with the body
- `server/discover`, `subscriptions/listen`, multi round-trip requests, cacheable results
- Tasks moved from the core protocol to the `io.modelcontextprotocol/tasks` extension

**What changes for server authors**

1. **Server-initiated requests are gone.** If you called `app.mcpElicit()` /
   `app.mcpElicitUrl()` to prompt a user mid-call, that only reaches legacy clients. For
   modern clients, throw `InputRequired` from the handler instead and read
   `context.inputResponses` on the retry — see
   [Multi Round-Trip Requests](#multi-round-trip-requests-2026-07-28).
2. **Set `requestStateSecret`** if more than one instance can serve a retry. Without it each
   process seals with its own random key and a retry landing elsewhere is refused. The
   secret must be at least 32 bytes; a shorter or empty one is rejected at startup. To rotate
   it without failing retries mid-rollout, deploy `[old, new]` everywhere first, then
   `[new, old]`, then `[new]` once `requestStateTtlMs` has passed. Deploying `[new, old]`
   straight away would seal state that instances still on `[old]` refuse.
3. **Decide your caching hints.** The default of `ttlMs: 0` is safe but means clients never
   cache. See [Result Caching](#result-caching-2026-07-28).
4. **Sessions do not exist for modern clients.** `context.sessionId` is `undefined` on that
   path, and `app.mcpSendToSession()` cannot reach them. Anything that must span requests
   needs an explicit handle passed as a tool argument.
5. **`enableSSE` no longer gates broadcasts.** `app.mcpBroadcastNotification()` now always
   publishes, because `subscriptions/listen` is core to the modern protocol; legacy SSE
   delivery is still gated by the flag.

**One gotcha for existing code**

`LATEST_PROTOCOL_VERSION` now means `2026-07-28`, not `2025-11-25`. If you send it as the
`MCP-Protocol-Version` header, that header alone commits the request to the modern path —
and a body without `_meta` is then answered with `-32602`. Code that wants the newest
*handshake* revision should use `LATEST_LEGACY_PROTOCOL_VERSION`:

```diff
-import { LATEST_PROTOCOL_VERSION } from '@platformatic/mcp'
-headers: { 'mcp-protocol-version': LATEST_PROTOCOL_VERSION }
+import { LATEST_LEGACY_PROTOCOL_VERSION } from '@platformatic/mcp'
+headers: { 'mcp-protocol-version': LATEST_LEGACY_PROTOCOL_VERSION }
```

The header is deliberately era-determining rather than the body alone. The transport mirrors
body fields into headers so gateways can route on them without parsing JSON; if the era were
decided by the body, a caller could send modern headers with a body that omits `_meta` and
slip past every header/body check onto the unvalidated legacy path — exactly the split-brain
the spec's "Server Validation" section exists to prevent.

**Deprecated upstream** (still functional, removal no earlier than twelve months): Roots,
Sampling, Logging, the HTTP+SSE transport, and OAuth Dynamic Client Registration.

### Upgrading to MCP 2025-06-18

This version introduces elicitation support and enhanced security features:

**New Features:**
- Elicitation capability for server-to-client information requests
- Enhanced input sanitization and validation
- Automatic security assessment for tool annotations
- Built-in rate limiting utilities

**Breaking Changes:**
- Protocol version updated to `2025-06-18`
- Enhanced validation may reject previously accepted inputs
- Security logging may produce additional log entries

**Migration Steps:**
1. Update client applications to support MCP 2025-06-18
2. Elicitation is declared by the client in `initialize` (`capabilities: { elicitation: {} }`), not in the server's `capabilities`
3. Review security logs for any validation warnings
4. Consider implementing rate limiting for production deployments

## License

Apache 2.0
