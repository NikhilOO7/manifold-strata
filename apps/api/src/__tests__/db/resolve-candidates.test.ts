/**
 * Entity resolution must not fragment as the graph grows.
 *
 * The defect this suite exists to keep dead: resolution used to compare each
 * mention against the 2000 most recently created nodes in the domain. Past that,
 * an entity introduced early was invisible to every later paper that mentioned
 * it, so the graph grew a second node meaning the same thing — quietly, while
 * logging a warning and continuing. Everything downstream inherits the damage:
 * PPR splits mass across the forks, retrieval returns one of them, and the graph
 * stops being able to answer the question it exists to answer.
 *
 * So the load-bearing test here seeds MORE than the old window and then asks for
 * the oldest entity. A regression that reintroduces any window fails it.
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
// Deterministic lexical embeddings — no model server, so this runs anywhere.
process.env.EMBED_PROVIDER = 'local';

const shouldRun = Boolean(dbUrl);

/** Larger than the old RESOLUTION_CANDIDATE_LIMIT (2000) — that is the point. */
const FILLER_NODES = 2500;

describe('entity resolution candidates', { skip: shouldRun ? false : 'TEST_DATABASE_URL not set' }, () => {
  let db: typeof import('../../db').db;
  let createCandidateSource: typeof import('../../knowledge-field/resolve-candidates').createCandidateSource;
  let embed: typeof import('../../services/embeddings').embed;

  const TAG = 'RESOLVETEST';
  let oldestId = '';

  before(async () => {
    ({ db } = await import('../../db'));
    ({ createCandidateSource } = await import('../../knowledge-field/resolve-candidates'));
    ({ embed } = await import('../../services/embeddings'));

    await db.execute(sql`delete from nodes where name like ${TAG + '%'}`);

    // 1. The oldest entity — the one the old window would lose.
    const [vec] = await embed([`${TAG} Neural Radiance Field`], 'test');
    const literal = `[${vec.join(',')}]`;
    const space = process.env.EMBEDDING_SPACE ?? 'local-lex-768';
    const rows = (await db.execute(sql`
      with n as (
        insert into nodes (type, domain, name, normalized_name, created_at)
        values ('method', 'nlp', ${TAG + ' Neural Radiance Field'},
                ${(TAG + ' Neural Radiance Field').toLowerCase()}, now() - interval '10 years')
        returning id
      )
      insert into node_vectors (node_id, embedding_vec, space)
      select id, ${literal}::vector, ${space} from n
      returning node_id as id
    `)) as unknown as Array<{ id: string }>;
    oldestId = rows[0].id;

    // 2. Bury it under more recent nodes than the old window ever looked at.
    await db.execute(sql`
      insert into nodes (type, domain, name, normalized_name, created_at)
      select 'method', 'nlp', ${TAG + ' filler '} || g, ${TAG.toLowerCase() + ' filler '} || g, now()
      from generate_series(1, ${FILLER_NODES}) g
    `);

    // 2b. Vectors for a slice of the fillers, so the k-NN query has a real field
    //     to discriminate within rather than one candidate it cannot help but
    //     return. These are all NEWER than the target, which is the property
    //     under test: recency must not decide what resolution can see.
    const fillerNames = Array.from({ length: 200 }, (_, i) => `${TAG} filler ${i + 1}`);
    const fillerVecs = await embed(fillerNames, 'test');
    const fillerRows = (await db.execute(sql`
      select id, name from nodes
      where domain = 'nlp' and name like ${TAG + ' filler %'}
    `)) as unknown as Array<{ id: string; name: string }>;
    const idByName = new Map(fillerRows.map((r) => [r.name, r.id]));
    const values = fillerNames
      .map((name, i) => ({ id: idByName.get(name), vec: fillerVecs[i] }))
      .filter((v): v is { id: string; vec: number[] } => Boolean(v.id))
      .map((v) => sql`(${v.id}::uuid, ${`[${v.vec.join(',')}]`}::vector, ${space})`);
    await db.execute(sql`
      insert into node_vectors (node_id, embedding_vec, space) values ${sql.join(values, sql`, `)}
    `);

    // 3. A same-named entity in ANOTHER domain: resolution must never see it.
    await db.execute(sql`
      insert into nodes (type, domain, name, normalized_name)
      values ('method', 'biology', ${TAG + ' Neural Radiance Field'},
              ${(TAG + ' Neural Radiance Field').toLowerCase()})
    `);
  });

  after(async () => {
    if (!shouldRun) return;
    await db.execute(sql`delete from nodes where name like ${TAG + '%'}`);
    const { closeDb } = await import('../../db');
    await closeDb();
  });

  test(`exact name resolves past ${FILLER_NODES} newer nodes — no recency window`, async () => {
    const source = createCandidateSource('nlp');
    const found = await source.byName([(TAG + ' Neural Radiance Field').toLowerCase()]);

    const hit = found.get((TAG + ' Neural Radiance Field').toLowerCase());
    assert.ok(hit, 'the oldest entity in the domain must still be findable');
    assert.equal(hit.id, oldestId, 'and it must be THE node, not a fork of it');
  });

  test('name lookup is domain-scoped — the same name elsewhere is invisible', async () => {
    const source = createCandidateSource('nlp');
    const found = await source.byName([(TAG + ' Neural Radiance Field').toLowerCase()]);
    assert.equal(found.get((TAG + ' Neural Radiance Field').toLowerCase())?.id, oldestId);

    // And the reverse direction: biology sees its own, never nlp's.
    const other = await createCandidateSource('biology').byName([
      (TAG + ' Neural Radiance Field').toLowerCase(),
    ]);
    const otherHit = other.get((TAG + ' Neural Radiance Field').toLowerCase());
    assert.ok(otherHit);
    assert.notEqual(otherHit.id, oldestId, 'a subgraph never spans domains — nor does resolution');
  });

  test('a near-miss mention resolves by vector, through the index, past the window', async () => {
    // Not an exact name, so this can only be answered by the ANN path.
    const [vec] = await embed([`${TAG} Neural Radiance Fields`], 'test');
    const source = createCandidateSource('nlp');
    const [ranked] = await source.byVector([{ vector: vec, type: 'method' }]);

    assert.ok(ranked.length > 0, 'the k-NN query must return candidates');
    assert.equal(ranked[0].id, oldestId, 'the decade-old entity is still the nearest neighbour');
    assert.ok(ranked[0].score > 0.82, `score ${ranked[0].score} must clear the resolution threshold`);
  });

  test('vector lookup is domain-scoped', async () => {
    const [vec] = await embed([`${TAG} Neural Radiance Fields`], 'test');
    const [ranked] = await createCandidateSource('biology').byVector([
      { vector: vec, type: 'method' },
    ]);
    assert.ok(
      ranked.every((c) => c.id !== oldestId),
      "biology's resolution must never reach an nlp node"
    );
  });

  test('one round trip answers many mentions, each with its own neighbours', async () => {
    const vectors = await embed(
      [`${TAG} Neural Radiance Fields`, `${TAG} filler 7`, 'something wholly unrelated'],
      'test'
    );
    const source = createCandidateSource('nlp');
    const results = await source.byVector(vectors.map((v) => ({ vector: v, type: 'method' })));

    assert.equal(results.length, 3, 'one result bucket per mention, in order');
    assert.equal(results[0][0]?.id, oldestId, 'mention 0 gets its own nearest neighbour');
    assert.equal(
      results[1][0]?.name,
      `${TAG} filler 7`,
      'mention 1 gets ITS nearest neighbour — buckets are per-mention, not shared'
    );
  });

  test('an empty batch costs no query', async () => {
    assert.deepEqual(await createCandidateSource('nlp').byVector([]), []);
    assert.equal((await createCandidateSource('nlp').byName([])).size, 0);
  });
});
