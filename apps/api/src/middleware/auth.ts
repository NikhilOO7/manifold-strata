import type { Context, MiddlewareHandler } from 'hono';
import {
  resolvePrincipal,
  authEnabled,
  ANONYMOUS_PRINCIPAL,
  AuthenticationError,
  AuthorizationError,
  requireScope,
  requireDomainAccess,
  type Principal,
  type Scope,
} from '../auth/principal';
import { resolveDomain } from '../domains';
import { recordAudit } from '../auth/audit';

/**
 * Attach a principal to every request.
 *
 * This runs on *all* routes, not only writes. The previous middleware guarded
 * mutations and left every read unauthenticated, which meant the domain
 * isolation the rest of the system enforces so carefully could be sidestepped by
 * anyone who could reach the port. Identity is established once, here, and the
 * authorization decision is made per operation by the helpers below.
 *
 * With `AUTH_MODE` unset the request still gets a principal — the explicit
 * anonymous one — so downstream code never has to handle "no principal", and
 * "auth is off" shows up in the audit trail as an actor rather than as silence.
 */
export function authenticate(): MiddlewareHandler {
  return async (c, next) => {
    if (!authEnabled()) {
      c.set('principal', ANONYMOUS_PRINCIPAL);
      return next();
    }

    const header = c.req.header('authorization');
    const bearer = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
    const presented = bearer || c.req.header('x-api-key');

    try {
      c.set('principal', await resolvePrincipal(presented));
    } catch (err) {
      if (err instanceof AuthenticationError) {
        recordAudit({
          action: `${c.req.method} ${new URL(c.req.url).pathname}`,
          outcome: 'denied',
          detail: { reason: 'authentication failed' },
        });
        return c.json(
          {
            error: 'Unauthorized',
            message:
              'Provide a valid API key via "Authorization: Bearer <key>" or "X-API-Key: <key>".',
          },
          401
        );
      }
      throw err;
    }

    return next();
  };
}

/**
 * The principal for this request. Never null once `authenticate()` has run.
 *
 * Throws rather than returning a permissive default if the middleware was
 * somehow skipped — a missing principal is a wiring bug, and inventing one here
 * would turn it into a silent authorization hole.
 */
export function principalOf(c: Context): Principal {
  const principal = c.get('principal') as Principal | undefined;
  if (!principal) {
    throw new Error(
      'No principal on the request context — authenticate() middleware did not run for this route.'
    );
  }
  return principal;
}

/**
 * Resolve a caller-supplied domain **and** check the principal may use it.
 *
 * This is the single chokepoint. Every route already funnelled its domain
 * decision through `resolveDomain`, so making the authorized variant the thing
 * routes call means a new endpoint gets scoping by using the ordinary helper,
 * rather than by remembering a separate check. A test asserts that routes do not
 * call the unauthenticated `resolveDomain` directly.
 *
 * Unknown domain still throws `UnknownDomainError` (400) before the grant is
 * consulted: a caller who names a domain that does not exist has made a
 * different mistake from one who names a domain they cannot see.
 */
export function requireDomain(c: Context, raw: string | undefined | null, action: string) {
  const domain = resolveDomain(raw);
  const principal = principalOf(c);

  try {
    requireDomainAccess(principal, domain.id);
  } catch (err) {
    if (err instanceof AuthorizationError) {
      recordAudit({
        principal,
        action,
        domain: domain.id,
        outcome: 'denied',
        detail: { reason: 'domain not granted' },
      });
    }
    throw err;
  }

  return domain;
}

/** Assert a capability scope, recording the denial. */
export function requireScopeOn(c: Context, scope: Scope, action: string): Principal {
  const principal = principalOf(c);
  try {
    requireScope(principal, scope);
  } catch (err) {
    if (err instanceof AuthorizationError) {
      recordAudit({
        principal,
        action,
        outcome: 'denied',
        detail: { reason: `missing scope: ${scope}` },
      });
    }
    throw err;
  }
  return principal;
}

export { authEnabled };
