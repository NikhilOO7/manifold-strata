/**
 * Entity identity is enforced by the database, not by a check-then-insert.
 *
 * Resolution's lookups decide *which* node a mention belongs to. None of that
 * helps against concurrency: the write path ended in a SELECT that missed
 * followed by an INSERT, which two workers can execute simultaneously. Proven
 * before the fix — two concurrent transactions produced two nodes with the same
 * normalized name in the same domain — and reachable in the shipped
 * configuration, because `PROCESS_CONCURRENCY` is a knob and the queue is
 * deliberately multi-instance.
 *
 * The property under test is therefore not "resolution finds the node" (covered
 * by resolve-candidates.test.ts) but "two writers racing cannot both win".
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
const TAG = 'IDENTITYTEST';

describe('node identity', { skip: shouldRun ? false : 'TEST_DATABASE_URL not set' }, () => {
  let db: typeof import('../../db').db;

  /** Exactly what the processor does: create-or-get, decided by the database. */
  const upsertNode = async (name: string, domain: string, type = 'method') => {
    const rows = (await db.execute(sql`
      insert into nodes (type, domain, name, normalized_name)
      values (${type}, ${domain}, ${name}, ${name.toLowerCase()})
      on conflict ((coalesce(domain, '')), normalized_name)
        where normalized_name is not null
        do update set updated_at = now()
      returning id
    `)) as unknown as Array<{ id: string }>;
    return rows[0].id;
  };

  const countOf = async (name: string) => {
    const rows = (await db.execute(sql`
      select count(*)::int as n from nodes where normalized_name = ${name.toLowerCase()}
    `)) as unknown as Array<{ n: number }>;
    return rows[0].n;
  };

  before(async () => {
    ({ db } = await import('../../db'));
    await db.execute(sql`delete from nodes where name like ${TAG + '%'}`);
  });

  after(async () => {
    if (!shouldRun) return;
    await db.execute(sql`delete from nodes where name like ${TAG + '%'}`);
    const { closeDb } = await import('../../db');
    await closeDb();
  });

  test('the unique identity index exists', async () => {
    const rows = (await db.execute(sql`
      select count(*)::int as n from pg_indexes where indexname = 'nodes_identity_unique'
    `)) as unknown as Array<{ n: number }>;
    assert.equal(rows[0].n, 1, 'without the index every other test here is theatre');
  });

  test('eight concurrent writers of the same entity produce ONE node', async () => {
    const name = `${TAG} Transformer`;
    const ids = await Promise.all(Array.from({ length: 8 }, () => upsertNode(name, 'nlp')));

    assert.equal(await countOf(name), 1, 'the race that used to produce duplicates');
    assert.equal(new Set(ids).size, 1, 'and every writer came away with the SAME id');
  });

  test('a losing writer gets the winner back, not an error', async () => {
    // The whole point of the conflict clause: the loser must be able to carry on
    // and attach its edges to the node that won, rather than failing the chunk.
    const name = `${TAG} Attention`;
    const first = await upsertNode(name, 'nlp');
    const second = await upsertNode(name, 'nlp');
    assert.equal(second, first);
  });

  test('the same name in two domains is two nodes — isolation is not deduplication', async () => {
    const name = `${TAG} Shared Concept`;
    const a = await upsertNode(name, 'nlp');
    const b = await upsertNode(name, 'gaussian-splatting');
    assert.notEqual(a, b);
    assert.equal(await countOf(name), 2, 'domains are separate namespaces by design');
  });

  test('two different entities in one domain stay separate', async () => {
    const a = await upsertNode(`${TAG} Alpha`, 'nlp');
    const b = await upsertNode(`${TAG} Beta`, 'nlp');
    assert.notEqual(a, b, 'the constraint must not over-collapse');
  });

  test('case differences are the same identity', async () => {
    const a = await upsertNode(`${TAG} CaseCheck`, 'nlp');
    const b = await upsertNode(`${TAG} casecheck`, 'nlp');
    assert.equal(a, b, 'normalized_name is what identity is keyed on');
  });

  test('a node with no normalized name does not collide with another', async () => {
    // The index is partial: a node without a normalized name has no identity to
    // compare. Two of them must coexist rather than conflict.
    await db.execute(sql`
      insert into nodes (type, domain, name, normalized_name)
      values ('method', 'nlp', ${TAG + ' NoNorm A'}, null),
             ('method', 'nlp', ${TAG + ' NoNorm B'}, null)
    `);
    const rows = (await db.execute(sql`
      select count(*)::int as n from nodes
      where name like ${TAG + ' NoNorm%'} and normalized_name is null
    `)) as unknown as Array<{ n: number }>;
    assert.equal(rows[0].n, 2);
  });
});
