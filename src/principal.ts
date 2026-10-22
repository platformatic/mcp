import type { AuthorizationContext } from './types/auth-types.ts'

/**
 * The identity a task or a sealed request state is bound to: the user, and the
 * OAuth client and issuer they came through. A different app acting for the
 * same user, or a colliding subject at another issuer, is a different
 * principal. Undefined when the caller identifies no user at all, which
 * includes a user id that is not a non-empty string (`null` from a resolver
 * for anonymous callers, say): binding those would make every such caller
 * one principal.
 */
export function principalOf (authContext: AuthorizationContext | undefined): string | undefined {
  if (!identifiesUser(authContext)) return undefined
  return JSON.stringify([authContext.userId, authContext.clientId ?? null, authContext.authorizationServer ?? null])
}

/** Whether the context names a user: a non-empty string `userId`. */
export function identifiesUser (authContext: AuthorizationContext | undefined): authContext is AuthorizationContext & { userId: string } {
  return typeof authContext?.userId === 'string' && authContext.userId !== ''
}
