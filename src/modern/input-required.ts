/**
 * How a tool, resource or prompt handler asks the client for something.
 *
 * Before 2026-07-28 a server could simply send `elicitation/create` down an SSE
 * stream and await the answer. That is gone: the server now ends the request
 * with an interim result and the client comes back with a fresh one. Handlers
 * express this by throwing {@link InputRequired}, which the dispatcher turns
 * into an `InputRequiredResult`, and read the answers off
 * `context.inputResponses` when the client retries.
 */

import type {
  ElicitRequest,
  ElicitRequestFormParams,
  CreateMessageRequest,
  ListRootsRequest
} from '../schema.ts'
import type { InputRequests, InputResponses } from '../schema-2026.ts'

/**
 * Thrown by a handler that cannot finish without more input.
 *
 * `state` is anything the handler needs to resume; it is sealed (HMAC, expiry,
 * principal- and request-bound) before it reaches the client, and handed back
 * as `context.requestState` on the retry.
 */
export class InputRequired extends Error {
  readonly inputRequests?: InputRequests
  readonly state?: unknown

  constructor (options: { inputRequests?: InputRequests, state?: unknown, message?: string } = {}) {
    super(options.message ?? 'Additional client input is required')
    this.name = 'InputRequired'
    this.inputRequests = options.inputRequests
    this.state = options.state

    if (options.inputRequests === undefined && options.state === undefined) {
      throw new TypeError('InputRequired needs at least one of "inputRequests" or "state"')
    }
  }
}

/** Build a form-mode `elicitation/create` to put in `inputRequests`. */
export function elicitForm (
  message: string,
  requestedSchema: ElicitRequestFormParams['requestedSchema']
): ElicitRequest {
  return {
    method: 'elicitation/create',
    params: { mode: 'form', message, requestedSchema }
  } as ElicitRequest
}

/** Build a URL-mode `elicitation/create` to put in `inputRequests`. */
export function elicitUrl (message: string, url: string): ElicitRequest {
  return {
    method: 'elicitation/create',
    params: { mode: 'url', message, url }
  } as ElicitRequest
}

/** Build a `sampling/createMessage` to put in `inputRequests`. */
export function requestSampling (params: CreateMessageRequest['params']): CreateMessageRequest {
  return { method: 'sampling/createMessage', params } as CreateMessageRequest
}

/** Build a `roots/list` to put in `inputRequests`. */
export function requestRoots (): ListRootsRequest {
  return { method: 'roots/list' } as ListRootsRequest
}

/**
 * Which client capability each kind of input request needs.
 *
 * The server must not ask for something the client did not declare, so the
 * dispatcher checks every entry against the request's capabilities before
 * sending the interim result.
 */
export function requiredCapabilityFor (request: { method?: string }): 'elicitation' | 'sampling' | 'roots' | undefined {
  switch (request?.method) {
    case 'elicitation/create': return 'elicitation'
    case 'sampling/createMessage': return 'sampling'
    case 'roots/list': return 'roots'
    default: return undefined
  }
}

export type { InputRequests, InputResponses }
