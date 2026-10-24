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

import type { ElicitRequestFormParams } from '../schema.ts'
import type {
  CreateMessageInputRequest,
  ElicitInputRequest,
  InputRequests,
  InputResponses,
  ListRootsInputRequest
} from '../schema-2026.ts'

/**
 * Thrown by a handler that cannot finish without more input.
 *
 * `state` is anything the handler needs to resume; it is signed (HMAC, expiry,
 * principal- and request-bound) before it reaches the client, and handed back
 * as `context.requestState` on the retry. It is not encrypted: the client can
 * read it, so it must not carry secrets.
 */
export class InputRequired extends Error {
  readonly inputRequests?: InputRequests
  readonly state?: unknown
  /**
   * Which earlier answers the next retry carries. By default it carries every
   * answer this round was given, except keys asked again; a handler that has
   * folded an answer into its `state`, or no longer needs it, lists only the
   * keys it still wants (`[]` for none), keeping the retry within
   * `requestStateMaxAnswerBytes`.
   */
  readonly carry?: readonly string[]

  constructor (options: { inputRequests?: InputRequests, state?: unknown, carry?: readonly string[], message?: string } = {}) {
    super(options.message ?? 'Additional client input is required')
    this.name = 'InputRequired'
    this.inputRequests = options.inputRequests
    this.state = options.state
    if (options.carry !== undefined) {
      if (!Array.isArray(options.carry) || !options.carry.every(key => typeof key === 'string')) {
        throw new TypeError('InputRequired "carry" must be an array of input keys')
      }
      this.carry = [...options.carry]
    }

    if (options.inputRequests === undefined && options.state === undefined) {
      throw new TypeError('InputRequired needs at least one of "inputRequests" or "state"')
    }
  }
}

/** Build a form-mode `elicitation/create` to put in `inputRequests`. */
export function elicitForm (
  message: string,
  requestedSchema: ElicitRequestFormParams['requestedSchema']
): ElicitInputRequest {
  return {
    method: 'elicitation/create',
    params: { mode: 'form', message, requestedSchema }
  }
}

/** Build a URL-mode `elicitation/create` to put in `inputRequests`. */
export function elicitUrl (message: string, url: string): ElicitInputRequest {
  return {
    method: 'elicitation/create',
    params: { mode: 'url', message, url }
  }
}

/** Build a `sampling/createMessage` to put in `inputRequests`. */
export function requestSampling (params: CreateMessageInputRequest['params']): CreateMessageInputRequest {
  return { method: 'sampling/createMessage', params }
}

/** Build a `roots/list` to put in `inputRequests`. */
export function requestRoots (): ListRootsInputRequest {
  return { method: 'roots/list' }
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
