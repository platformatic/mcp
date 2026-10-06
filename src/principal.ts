import type { AuthorizationContext } from './types/auth-types.ts'

/**
 * The identity a task or a sealed request state is bound to: the user, and the
 * OAuth client and issuer they came through. A different app acting for the
 * same user, or a colliding subject at another issuer, is a different
 * principal. Undefined when the caller identifies no user at all.
 */
export function principalOf (authContext: AuthorizationContext | undefined): string | undefined {
  if (authContext?.userId === undefined) return undefined
  return JSON.stringify([authContext.userId, authContext.clientId ?? null, authContext.authorizationServer ?? null])
}
