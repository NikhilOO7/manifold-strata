/**
 * "Most connected" must be true, not sampled.
 *
 * The Explorer used to fetch up to 500 nodes and 500 edges and count degrees in
 * the browser. The display cap merely hid entities; the sample cap made the
 * ranking itself false, because degree counted over an arbitrary 500 edges is
 * not degree. Past a few hundred edges, "most connected" silently meant
 * "whichever hubs landed in the window" — the same defect class as ranking over
 * a candidate window instead of an index.
 *
 * Requires Postgres:  pnpm --filter api test:db
 */

import 'dotenv/config';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';

const dbUrl = process.env.TEST_DATABASE_URL;
if (dbUrl) process.env.DATABASE_URL = dbUrl;
process.env.NODE_ENV = 'test';

const shouldRun = Boolean(dbUrl);
const TAG = 'HUBTEST';

describe('graph hubs', { skip: shouldRun ? false : 'TEST_DATABASE_URL not set' }, () => {
  let db: typeof import('../../db').db;
  let app: import('hono').Hono;

  before(async () => {
    ({ db } = await import('../../db'));
    ({ app } = await import('../../index'));
    await db.execute(sql`delete from nodes where name like ${TAG + '%'}`);

    // One clear hub, one mid, one sparse-but-present type. The hub is created
    // FIRST and the noise after it, so any implementation that samples "recent"
    // rows would rank it wrongly.
    const rows = (await db.execute(sql`
      insert into nodes (type, domain, name, normalized_name)
      values ('method', 'nlp', ${TAG + ' Hub'}, ${TAG.toLowerCase() + ' hub'}),
             ('method', 'nlp', ${TAG + ' Mid'}, ${TAG.toLowerCase() + ' mid'}),
             ('hardware', 'nlp', ${TAG + ' Rare'}, ${TAG.toLowerCase() + ' rare'})
      returning id, name
    `)) as unknown as Array<{ id: string; name: string }>;
    const byName = new Map(rows.map((r) => [r.name, r.id]));
    const hub = byName.get(TAG + ' Hub')!;
    const mid = byName.get(TAG + ' Mid')!;
    const rare = byName.get(TAG + ' Rare')!;

    // Filler nodes created AFTER the hub, each linked to it.
    await db.execute(sql`
      insert into nodes (type, domain, name, normalized_name)
      select 'method', 'nlp', ${TAG + ' filler '} || g, ${TAG.toLowerCase() + ' filler '} || g
      from generate_series(1, 12) g
    `);
    await db.execute(sql`
      insert into edges (source_id, target_id, type, domain)
      select ${hub}::uuid, n.id, 'uses', 'nlp' from nodes n
      where n.name like ${TAG + ' filler %'}
    `);
    await db.execute(sql`
      insert into edges (source_id, target_id, type, domain)
      values (${mid}::uuid, ${rare}::uuid, 'uses', 'nlp')
    `);
  });

  after(async () => {
    if (!shouldRun) return;
    await db.execute(sql`delete from nodes where name like ${TAG + '%'}`);
    const { closeDb } = await import('../../db');
    await closeDb();
  });

  test('the true hub ranks first, however early it was created', async () => {
    const res = await app.request('/api/graph/hubs?domain=nlp&limit=50');
    assert.equal(res.status, 200);
    const { hubs } = (await res.json()) as {
      hubs: Array<{ name: string; degree: number; type: string }>;
    };
    const ours = hubs.filter((h) => h.name.startsWith(TAG));
    assert.equal(ours[0].name, `${TAG} Hub`, 'ranked by degree over the whole domain');
    assert.equal(ours[0].degree, 12);
  });

  test('a sparse category is reachable by filtering, not buried by ranking', async () => {
    // The whole point of the type filter: an entity of a rarely-connected type
    // is invisible in a global top-N, which reads as missing data.
    const res = await app.request('/api/graph/hubs?domain=nlp&type=hardware&limit=10');
    const { hubs } = (await res.json()) as { hubs: Array<{ name: string; type: string }> };
    assert.ok(
      hubs.some((h) => h.name === `${TAG} Rare`),
      'filtering by its type surfaces it'
    );
    assert.ok(hubs.every((h) => h.type === 'hardware'), 'and returns only that type');
  });

  test('entities with no relationships are not offered as entry points', async () => {
    const res = await app.request('/api/graph/hubs?domain=nlp&limit=200');
    const { hubs } = (await res.json()) as { hubs: Array<{ degree: number }> };
    assert.ok(hubs.every((h) => h.degree > 0), 'a node you cannot navigate from is not an entry point');
  });

  test('hubs are domain-scoped', async () => {
    // A different REGISTERED domain. An unregistered one is a 400 by design
    // (domains fail closed), which is a different property — tested below.
    const res = await app.request('/api/graph/hubs?domain=gaussian-splatting&limit=50');
    assert.equal(res.status, 200);
    const { hubs } = (await res.json()) as { hubs: Array<{ name: string }> };
    assert.ok(
      hubs.every((h) => !h.name.startsWith(TAG)),
      "another domain's entities are never offered"
    );
  });

  test('an unknown domain fails closed', async () => {
    const res = await app.request('/api/graph/hubs?domain=not-a-real-domain');
    assert.equal(res.status, 400);
  });

  test('limit is clamped, not trusted', async () => {
    const res = await app.request('/api/graph/hubs?domain=nlp&limit=99999');
    const body = (await res.json()) as { limit: number };
    assert.ok(body.limit <= 200, 'an unbounded limit is an unbounded query');
  });
});
