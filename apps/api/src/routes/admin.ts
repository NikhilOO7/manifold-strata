/**
 * Tenant and credential provisioning.
 *
 * Every route here requires the `admin` scope. With `AUTH_MODE` unset the
 * anonymous principal holds admin, which is what allows a fresh install to issue
 * its first key — the bootstrap problem every credential system has. The
 * startup banner says so plainly rather than leaving it implied.
 */

import { Hono } from 'hono';
import { eq, desc, and } from 'drizzle-orm';
import { db } from '../db';
import { tenants, principals, auditLog } from '../db/schema';
import { issueKey } from '../auth/keys';
import { isKnownDomain, listDomains } from '../domains';
import { requireScopeOn } from '../middleware/auth';
import { recordAudit } from '../auth/audit';
import { routeError, isUuid } from './errors';

export const adminRouter = new Hono();

const VALID_SCOPES = ['read', 'write', 'admin'] as const;

adminRouter.post('/tenants', async (c) => {
  try {
    const actor = requireScopeOn(c, 'admin', 'admin.tenants.create');
    const body = await c.req.json().catch(() => ({}));
    const { name, slug } = body ?? {};

    if (!name || typeof name !== 'string' || !name.trim()) {
      return c.json({ error: 'name is required' }, 400);
    }
    const normalizedSlug =
      typeof slug === 'string' && slug.trim()
        ? slug.trim().toLowerCase()
        : name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    if (!/^[a-z0-9][a-z0-9-]*$/.test(normalizedSlug)) {
      return c.json({ error: 'slug must be lowercase alphanumeric with hyphens' }, 400);
    }

    const [tenant] = await db
      .insert(tenants)
      .values({ name: name.trim(), slug: normalizedSlug })
      .returning();

    recordAudit({ principal: actor, action: 'admin.tenants.create', outcome: 'allowed', detail: { tenantId: tenant.id, slug: tenant.slug } });
    return c.json(tenant, 201);
  } catch (error) {
    return routeError(c, error, 'Failed to create tenant');
  }
});

adminRouter.get('/tenants', async (c) => {
  try {
    requireScopeOn(c, 'admin', 'admin.tenants.list');
    return c.json({ tenants: await db.select().from(tenants).orderBy(desc(tenants.createdAt)) });
  } catch (error) {
    return routeError(c, error, 'Failed to list tenants');
  }
});

/**
 * Issue a credential.
 *
 * The key is returned exactly once, in this response, and never again — only its
 * hash is stored. That is stated in the payload itself so an operator who
 * scrolls past it knows to reissue rather than go looking for it.
 */
adminRouter.post('/principals', async (c) => {
  try {
    const actor = requireScopeOn(c, 'admin', 'admin.principals.create');
    const body = await c.req.json().catch(() => ({}));
    const { tenantId, name, kind, scopes, domains, expiresInDays } = body ?? {};

    if (!isUuid(tenantId)) return c.json({ error: 'A valid tenantId is required' }, 400);
    if (!name || typeof name !== 'string' || !name.trim()) {
      return c.json({ error: 'name is required' }, 400);
    }

    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    if (!tenant) return c.json({ error: 'Tenant not found' }, 404);

    const requestedScopes: string[] = Array.isArray(scopes) ? scopes : ['read'];
    const invalidScope = requestedScopes.find((s) => !VALID_SCOPES.includes(s as never));
    if (invalidScope) {
      return c.json(
        { error: `Unknown scope "${invalidScope}"`, validScopes: VALID_SCOPES },
        400
      );
    }

    // Domain grants are validated against the registry so a typo produces a
    // credential that grants nothing *visibly*, rather than one that silently
    // never matches and looks like a retrieval bug later.
    const requestedDomains: string[] = Array.isArray(domains) ? domains : [];
    if (requestedDomains.length === 0) {
      return c.json(
        {
          error: 'domains is required — use ["*"] to grant every domain',
          knownDomains: listDomains().map((d) => d.id),
        },
        400
      );
    }
    const invalidDomain = requestedDomains.find((d) => d !== '*' && !isKnownDomain(d));
    if (invalidDomain) {
      return c.json(
        { error: `Unknown domain "${invalidDomain}"`, knownDomains: listDomains().map((d) => d.id) },
        400
      );
    }

    const expiresAt =
      typeof expiresInDays === 'number' && expiresInDays > 0
        ? new Date(Date.now() + expiresInDays * 86_400_000)
        : null;

    const issued = issueKey();
    const [principal] = await db
      .insert(principals)
      .values({
        tenantId,
        name: name.trim(),
        kind: kind === 'user' ? 'user' : 'agent',
        keyPrefix: issued.prefix,
        keyHash: issued.hash,
        scopes: requestedScopes as never,
        domains: requestedDomains as never,
        expiresAt,
      })
      .returning();

    recordAudit({
      principal: actor,
      action: 'admin.principals.create',
      outcome: 'allowed',
      detail: { principalId: principal.id, scopes: requestedScopes, domains: requestedDomains },
    });

    return c.json(
      {
        id: principal.id,
        tenantId: principal.tenantId,
        name: principal.name,
        kind: principal.kind,
        scopes: principal.scopes,
        domains: principal.domains,
        expiresAt: principal.expiresAt,
        key: issued.key,
        warning: 'This key is shown once and is not recoverable. Store it now.',
      },
      201
    );
  } catch (error) {
    return routeError(c, error, 'Failed to create principal');
  }
});

adminRouter.get('/principals', async (c) => {
  try {
    requireScopeOn(c, 'admin', 'admin.principals.list');
    const rows = await db
      .select({
        id: principals.id,
        tenantId: principals.tenantId,
        name: principals.name,
        kind: principals.kind,
        keyPrefix: principals.keyPrefix,
        scopes: principals.scopes,
        domains: principals.domains,
        expiresAt: principals.expiresAt,
        revokedAt: principals.revokedAt,
        lastUsedAt: principals.lastUsedAt,
        createdAt: principals.createdAt,
      })
      .from(principals)
      .orderBy(desc(principals.createdAt));
    // Note the absence of keyHash — a listing endpoint has no reason to carry it.
    return c.json({ principals: rows });
  } catch (error) {
    return routeError(c, error, 'Failed to list principals');
  }
});

/**
 * Revoke a credential.
 *
 * Revocation is a timestamp rather than a delete: the audit trail references the
 * principal, and deleting the row would detach the history from the identity
 * that produced it.
 */
adminRouter.post('/principals/:id/revoke', async (c) => {
  try {
    const actor = requireScopeOn(c, 'admin', 'admin.principals.revoke');
    const id = c.req.param('id');
    if (!isUuid(id)) return c.json({ error: 'Principal not found' }, 404);

    const [updated] = await db
      .update(principals)
      .set({ revokedAt: new Date() })
      .where(eq(principals.id, id))
      .returning({ id: principals.id, name: principals.name, revokedAt: principals.revokedAt });

    if (!updated) return c.json({ error: 'Principal not found' }, 404);

    recordAudit({
      principal: actor,
      action: 'admin.principals.revoke',
      outcome: 'allowed',
      detail: { principalId: id },
    });
    return c.json(updated);
  } catch (error) {
    return routeError(c, error, 'Failed to revoke principal');
  }
});

/** Read the audit trail. */
adminRouter.get('/audit', async (c) => {
  try {
    requireScopeOn(c, 'admin', 'admin.audit.read');

    const rawLimit = parseInt(c.req.query('limit') || '100', 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 1000) : 100;

    const conds = [];
    const outcome = c.req.query('outcome');
    if (outcome) conds.push(eq(auditLog.outcome, outcome));
    const action = c.req.query('action');
    if (action) conds.push(eq(auditLog.action, action));
    const principalId = c.req.query('principalId');
    if (principalId && isUuid(principalId)) conds.push(eq(auditLog.principalId, principalId));

    const entries = await db
      .select()
      .from(auditLog)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(auditLog.createdAt))
      .limit(limit);

    return c.json({ entries, count: entries.length });
  } catch (error) {
    return routeError(c, error, 'Failed to read audit log');
  }
});
