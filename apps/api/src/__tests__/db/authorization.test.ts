/**
 * Authorization: a credential reads exactly the domains it was granted.
 *
 * Until now domain isolation was a *data* boundary — the query layer scoped every
 * read and tests proved it, but nothing bound a caller to a domain. One shared
 * key opened all of them and read routes needed no key at all, so the isolation
 * the rest of the system enforces so carefully could be sidestepped by anyone who
 * could reach the port. These tests are the ones a buyer would write.
 *
 * Requires Postgres:  pnpm --filter api test:db
 */

// Load the same .env the API loads: the embedding space (provider, model,
// dimensions) must match the database's vector columns.
import 'dotenv/config';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { eq, inArray, desc } from 'drizzle-orm';

const dbUrl = process.env.TEST_DATABASE_URL;
if (dbUrl) process.env.DATABASE_URL = dbUrl;
process.env.NODE_ENV = 'test';
// Enforcement must be on for this suite; without it every request is the
// anonymous admin and none of these assertions would mean anything.
process.env.AUTH_MODE = 'required';
// Deterministic local embeddings so the retrieval path — and therefore the audit
// row it writes — works without a model server running.
process.env.EMBED_PROVIDER = 'local';

const shouldRun = Boolean(dbUrl);

describe('authorization', { skip: shouldRun ? false : 'TEST_DATABASE_URL not set' }, () => {
  let app: import('hono').Hono;
  let db: typeof import('../../db').db;
  let schema: typeof import('../../db/schema');

  const created = { tenants: [] as string[], principals: [] as string[] };

  // Credentials issued in `before`, each with a different grant.
  let nlpReadKey = '';
  let gsReadKey = '';
  let wildcardAdminKey = '';
  let writerKey = '';
  let revokedKey = '';
  let expiredKey = '';
  let nlpPrincipalId = '';

  const auth = (key: string) => ({ authorization: `Bearer ${key}` });

  before(async () => {
    ({ app } = await import('../../index'));
    ({ db } = await import('../../db'));
    schema = await import('../../db/schema');
    const { issueKey } = await import('../../auth/keys');

    const [tenant] = await db
      .insert(schema.tenants)
      .values({ name: 'AUTHTEST tenant', slug: `authtest-${Date.now()}` })
      .returning();
    created.tenants.push(tenant.id);

    const mk = async (
      name: string,
      scopes: string[],
      domains: string[],
      extra: { revokedAt?: Date; expiresAt?: Date } = {}
    ) => {
      const issued = issueKey();
      const [p] = await db
        .insert(schema.principals)
        .values({
          tenantId: tenant.id,
          name,
          kind: 'agent',
          keyPrefix: issued.prefix,
          keyHash: issued.hash,
          scopes: scopes as never,
          domains: domains as never,
          ...extra,
        })
        .returning();
      created.principals.push(p.id);
      return { key: issued.key, id: p.id };
    };

    const nlp = await mk('AUTHTEST nlp reader', ['read'], ['nlp']);
    nlpReadKey = nlp.key;
    nlpPrincipalId = nlp.id;
    gsReadKey = (await mk('AUTHTEST gs reader', ['read'], ['gaussian-splatting'])).key;
    wildcardAdminKey = (await mk('AUTHTEST admin', ['admin'], ['*'])).key;
    writerKey = (await mk('AUTHTEST writer', ['read', 'write'], ['nlp'])).key;
    revokedKey = (await mk('AUTHTEST revoked', ['read'], ['*'], { revokedAt: new Date() })).key;
    expiredKey = (
      await mk('AUTHTEST expired', ['read'], ['*'], { expiresAt: new Date(Date.now() - 1000) })
    ).key;
  });

  after(async () => {
    if (!shouldRun) return;
    if (created.principals.length) {
      await db.delete(schema.auditLog).where(inArray(schema.auditLog.principalId, created.principals));
      await db.delete(schema.principals).where(inArray(schema.principals.id, created.principals));
    }
    if (created.tenants.length) {
      await db.delete(schema.tenants).where(inArray(schema.tenants.id, created.tenants));
    }
    delete process.env.AUTH_MODE;
    const { closeDb } = await import('../../db');
    await closeDb();
  });

  // --- Authentication --------------------------------------------------------

  test('a request with no credential is rejected', async () => {
    const res = await app.request('/api/graph/nodes?domain=nlp');
    assert.equal(res.status, 401);
  });

  test('reads are protected, not just writes', async () => {
    // The specific hole this closes: previously only mutations were guarded.
    for (const path of [
      '/api/graph/nodes',
      '/api/graph/stats',
      '/api/papers',
      '/api/field/retrieve?q=x',
    ]) {
      const res = await app.request(path);
      assert.equal(res.status, 401, `${path} must require a credential`);
    }
  });

  test('a malformed key is rejected', async () => {
    for (const key of ['garbage', 'mk_short_x', 'mk_zzzzzzzzzzzzzzzz_secret', '']) {
      const res = await app.request('/api/graph/nodes', { headers: auth(key) });
      assert.equal(res.status, 401, `"${key}" must not authenticate`);
    }
  });

  test('a valid key authenticates', async () => {
    const res = await app.request('/api/graph/nodes?domain=nlp', { headers: auth(nlpReadKey) });
    assert.equal(res.status, 200);
  });

  test('a revoked key stops working', async () => {
    const res = await app.request('/api/graph/nodes?domain=nlp', { headers: auth(revokedKey) });
    assert.equal(res.status, 401);
  });

  test('an expired key stops working', async () => {
    const res = await app.request('/api/graph/nodes?domain=nlp', { headers: auth(expiredKey) });
    assert.equal(res.status, 401);
  });

  test('every authentication failure returns the same message', async () => {
    // Distinguishing "no such key" from "revoked" from "expired" hands an
    // attacker a probe oracle. The difference belongs in the audit log.
    const bodies = await Promise.all(
      [revokedKey, expiredKey, 'mk_00000000000000ff_nope'].map(async (key) => {
        const res = await app.request('/api/graph/nodes', { headers: auth(key) });
        return ((await res.json()) as { message: string }).message;
      })
    );
    assert.equal(new Set(bodies).size, 1, `messages differed: ${JSON.stringify(bodies)}`);
  });

  // --- Domain authorization --------------------------------------------------

  test('a credential scoped to one domain can read it', async () => {
    const res = await app.request('/api/graph/nodes?domain=nlp', { headers: auth(nlpReadKey) });
    assert.equal(res.status, 200);
  });

  test('and cannot read another domain — the exit criterion', async () => {
    const res = await app.request('/api/graph/nodes?domain=gaussian-splatting', {
      headers: auth(nlpReadKey),
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error: string; domain: string };
    assert.equal(body.error, 'Forbidden');
    assert.equal(body.domain, 'gaussian-splatting');
  });

  test('the denial is symmetric', async () => {
    const res = await app.request('/api/graph/nodes?domain=nlp', { headers: auth(gsReadKey) });
    assert.equal(res.status, 403);
  });

  test('a wildcard grant reaches every domain', async () => {
    for (const domain of ['nlp', 'gaussian-splatting', 'default']) {
      const res = await app.request(`/api/graph/nodes?domain=${domain}`, {
        headers: auth(wildcardAdminKey),
      });
      assert.equal(res.status, 200, `admin should read ${domain}`);
    }
  });

  test('the grant is enforced across every domain-scoped surface, not just one route', async () => {
    // The chokepoint is what makes this true: routes call the authorized domain
    // resolver, so a new endpoint inherits the check by using the ordinary helper.
    const forbidden = [
      '/api/graph/nodes?domain=gaussian-splatting',
      '/api/graph/edges?domain=gaussian-splatting',
      '/api/graph/stats?domain=gaussian-splatting',
      '/api/graph/types?domain=gaussian-splatting',
      '/api/papers?domain=gaussian-splatting',
      '/api/field/retrieve?q=x&domain=gaussian-splatting',
      '/api/ingest/seed/gaussian-splatting',
    ];
    for (const path of forbidden) {
      const res = await app.request(path, { headers: auth(nlpReadKey) });
      assert.equal(res.status, 403, `${path} should be forbidden for an nlp-only credential`);
    }
  });

  test('an unknown domain is still a 400, distinct from a forbidden one', async () => {
    // Different mistakes deserve different answers: "that domain does not exist"
    // is not the same as "you may not use it".
    const res = await app.request('/api/graph/nodes?domain=nlpp', { headers: auth(nlpReadKey) });
    assert.equal(res.status, 400);
  });

  // --- Capability scopes -----------------------------------------------------

  test('a read-only credential cannot write', async () => {
    const res = await app.request('/api/papers', {
      method: 'POST',
      headers: { ...auth(nlpReadKey), 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'AUTHTEST should not exist', domain: 'nlp' }),
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { requiredScope: string };
    assert.equal(body.requiredScope, 'write');
  });

  test('a write credential can write', async () => {
    const res = await app.request('/api/papers', {
      method: 'POST',
      headers: { ...auth(writerKey), 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'AUTHTEST writer paper', domain: 'nlp' }),
    });
    assert.equal(res.status, 201);
    const paper = (await res.json()) as { id: string };
    await db.delete(schema.papers).where(eq(schema.papers.id, paper.id));
  });

  test('write scope does not imply admin', async () => {
    const res = await app.request('/api/domains/backfill', {
      method: 'POST',
      headers: { ...auth(writerKey), 'content-type': 'application/json' },
      body: JSON.stringify({ domain: 'nlp', dryRun: true }),
    });
    assert.equal(res.status, 403);
  });

  test('admin implies the lesser scopes', async () => {
    const res = await app.request('/api/domains/backfill', {
      method: 'POST',
      headers: { ...auth(wildcardAdminKey), 'content-type': 'application/json' },
      body: JSON.stringify({ domain: 'nlp', dryRun: true }),
    });
    assert.equal(res.status, 200);
  });

  test('a non-admin cannot provision credentials or read the audit trail', async () => {
    for (const path of ['/api/admin/principals', '/api/admin/tenants', '/api/admin/audit']) {
      const res = await app.request(path, { headers: auth(writerKey) });
      assert.equal(res.status, 403, `${path} must be admin-only`);
    }
  });

  // --- Audit -----------------------------------------------------------------

  test('a successful retrieval is recorded', async () => {
    await app.request('/api/field/retrieve?q=AUDITPROBE&domain=nlp', { headers: auth(nlpReadKey) });

    // The audit write is fire-and-forget so it does not sit in the request path.
    await new Promise((r) => setTimeout(r, 300));

    const [entry] = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.principalId, nlpPrincipalId))
      .orderBy(desc(schema.auditLog.createdAt))
      .limit(1);

    assert.ok(entry, 'a retrieval should produce an audit row');
    assert.equal(entry.action, 'field.retrieve');
    assert.equal(entry.outcome, 'allowed');
    assert.equal(entry.domain, 'nlp');
    assert.match(JSON.stringify(entry.detail), /AUDITPROBE/);
  });

  test('a denied attempt is recorded too', async () => {
    // The more important half: an audit trail containing only successes cannot
    // answer the question anyone asks after an incident.
    await app.request('/api/graph/nodes?domain=gaussian-splatting', { headers: auth(nlpReadKey) });
    await new Promise((r) => setTimeout(r, 300));

    const denials = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.principalId, nlpPrincipalId))
      .orderBy(desc(schema.auditLog.createdAt))
      .limit(20);

    assert.ok(
      denials.some((d) => d.outcome === 'denied' && d.domain === 'gaussian-splatting'),
      'the refused cross-domain read should appear in the audit log'
    );
  });

  test('audit rows carry an actor label that survives the principal', async () => {
    const rows = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.principalId, nlpPrincipalId))
      .limit(1);
    assert.match(rows[0].actor ?? '', /AUTHTEST nlp reader/);
  });
});
