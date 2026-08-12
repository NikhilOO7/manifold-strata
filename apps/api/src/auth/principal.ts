/**
 * Who is calling, and what they are allowed to touch.
 *
 * The authorization decision lives here rather than in the routes, because every
 * isolation defect found in this codebase came from a route that forgot a
 * filter. Routes ask this module a question; they do not compute the answer.
 */

import { eq } from 'drizzle-orm';
import { db } from '../db';
import { principals } from '../db/schema';
import { parseKey, verifySecret } from './keys';

export type Scope = 'read' | 'write' | 'admin';

export interface Principal {
  id: string;
  tenantId: string;
  name: string;
  kind: string;
  scopes: Scope[];
  /** Domain ids, or `['*']` for every registered domain. */
  domains: string[];
}

/**
 * The identity used when authentication is switched off entirely.
 *
 * Local development with no `AUTH_MODE` set must keep working, but "no auth" has
 * to be a *visible state* rather than an absence — the startup banner and
 * `/health` both report it, audit rows attribute actions to it, and it is the
 * only principal that is ever synthesised rather than looked up.
 */
export const ANONYMOUS_PRINCIPAL: Principal = {
  id: '00000000-0000-0000-0000-000000000000',
  tenantId: '00000000-0000-0000-0000-000000000000',
  name: 'anonymous (auth disabled)',
  kind: 'anonymous',
  scopes: ['read', 'write', 'admin'],
  domains: ['*'],
};

export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

export class AuthorizationError extends Error {
  readonly requiredScope?: Scope;
  readonly domain?: string;

  constructor(message: string, context: { scope?: Scope; domain?: string } = {}) {
    super(message);
    this.name = 'AuthorizationError';
    this.requiredScope = context.scope;
    this.domain = context.domain;
  }
}

/**
 * Is authentication enforced?
 *
 * `AUTH_MODE=required` turns it on. It is off by default so a first run works,
 * and that default is reported loudly rather than assumed safe.
 */
export function authEnabled(): boolean {
  return process.env.AUTH_MODE === 'required';
}

function asArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Resolve a presented key to a principal.
 *
 * Every failure path returns the same error message. A caller must not be able
 * to distinguish "no such key" from "revoked" from "expired" — that difference
 * is a probe oracle, and the detail belongs in the audit log rather than the
 * response.
 */
export async function resolvePrincipal(presentedKey: string | undefined): Promise<Principal> {
  const parsed = parseKey(presentedKey);
  if (!parsed) {
    throw new AuthenticationError('Invalid or missing API key');
  }

  const [row] = await db
    .select()
    .from(principals)
    .where(eq(principals.keyPrefix, parsed.prefix))
    .limit(1);

  if (!row) throw new AuthenticationError('Invalid or missing API key');
  if (!verifySecret(parsed.secret, row.keyHash)) {
    throw new AuthenticationError('Invalid or missing API key');
  }
  if (row.revokedAt) throw new AuthenticationError('Invalid or missing API key');
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
    throw new AuthenticationError('Invalid or missing API key');
  }

  // Best-effort usage stamp; never block the request on it.
  void db
    .update(principals)
    .set({ lastUsedAt: new Date() })
    .where(eq(principals.id, row.id))
    .catch(() => {});

  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    kind: row.kind,
    scopes: asArray(row.scopes) as Scope[],
    domains: asArray(row.domains),
  };
}

/** `admin` implies the lesser scopes; nothing else is implied. */
export function hasScope(principal: Principal, scope: Scope): boolean {
  if (principal.scopes.includes('admin')) return true;
  return principal.scopes.includes(scope);
}

export function requireScope(principal: Principal, scope: Scope): void {
  if (!hasScope(principal, scope)) {
    throw new AuthorizationError(
      `This credential lacks the "${scope}" scope.`,
      { scope }
    );
  }
}

/**
 * May this principal touch this domain?
 *
 * Default-deny: an unrecognised, empty, or malformed grant list authorises
 * nothing. The wildcard has to be spelled out as `['*']`, so a grant list that
 * failed to load cannot be mistaken for permission to read everything.
 */
export function canAccessDomain(principal: Principal, domainId: string): boolean {
  if (principal.domains.includes('*')) return true;
  return principal.domains.includes(domainId);
}

export function requireDomainAccess(principal: Principal, domainId: string): void {
  if (!canAccessDomain(principal, domainId)) {
    throw new AuthorizationError(
      `This credential is not granted access to domain "${domainId}".`,
      { domain: domainId }
    );
  }
}

/** Domains this principal may read, resolved against the registry. */
export function grantedDomains(principal: Principal, allDomainIds: string[]): string[] {
  if (principal.domains.includes('*')) return [...allDomainIds];
  return allDomainIds.filter((id) => principal.domains.includes(id));
}
