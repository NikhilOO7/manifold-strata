/**
 * The claim protocol and the batch surface.
 *
 * The property that matters most is claim exclusivity under concurrency: five
 * workers racing for three jobs must produce exactly three distinct claims and
 * two empty hands, never a double-claim. `FOR UPDATE SKIP LOCKED` promises
 * this; the test holds it to the promise through the real database, because
 * "two instances extracted the same paper for fifteen minutes each" is the
 * expensive way to find out.
 *
 * Requires Postgres:  pnpm --filter api test:db
 */

import 'dotenv/config';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { inArray } from 'drizzle-orm';

const dbUrl = process.env.TEST_DATABASE_URL;
if (dbUrl) process.env.DATABASE_URL = dbUrl;
process.env.NODE_ENV = 'test';

const shouldRun = Boolean(dbUrl);

describe('durable queue claims', { skip: shouldRun ? false : 'TEST_DATABASE_URL not set' }, () => {
  let db: typeof import('../../db').db;
  let schema: typeof import('../../db/schema');
  let queue: typeof import('../../queue');
  let app: import('hono').Hono;

  const jobIds: string[] = [];
  const batchIds: string[] = [];

  before(async () => {
    ({ db } = await import('../../db'));
    schema = await import('../../db/schema');
    queue = await import('../../queue');
    ({ app } = await import('../../index'));
  });

  after(async () => {
    if (!shouldRun) return;
    if (jobIds.length) await db.delete(schema.jobs).where(inArray(schema.jobs.id, jobIds));
    if (batchIds.length) await db.delete(schema.batches).where(inArray(schema.batches.id, batchIds));
    const { closeDb } = await import('../../db');
    await closeDb();
  });

  const seedQueued = async (ids: string[], type: 'ingest' | 'process' = 'ingest') => {
    for (let i = 0; i < ids.length; i++) {
      await db.insert(schema.jobs).values({
        id: ids[i],
        type,
        status: 'queued',
        // Distinct timestamps so FIFO ordering is decidable.
        createdAt: new Date(Date.now() - (ids.length - i) * 1000),
        metadata: { test: true } as never,
      });
      jobIds.push(ids[i]);
    }
  };

  test('five concurrent claimers, three jobs: three distinct claims, two nulls', async () => {
    const ids = ['CLAIM-a', 'CLAIM-b', 'CLAIM-c'];
    await seedQueued(ids);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => queue.claimNextJob('ingest'))
    );

    const claimed = results.filter((r): r is NonNullable<typeof r> => r !== null);
    const misses = results.length - claimed.length;

    assert.equal(claimed.length, 3, 'every job claimed exactly once');
    assert.equal(misses, 2, 'surplus claimers come away empty, not duplicated');
    assert.equal(new Set(claimed.map((j) => j.id)).size, 3, 'no double-claim');
    for (const job of claimed) {
      assert.equal(job.owner, queue.INSTANCE_ID);
      assert.equal(job.attempts, 1, 'claiming is what increments attempts');
      assert.ok(job.leaseExpiresAt && job.leaseExpiresAt.getTime() > Date.now());
    }
  });

  test('claims are FIFO by creation time', async () => {
    await seedQueued(['FIFO-old', 'FIFO-new']);
    const first = await queue.claimNextJob('ingest');
    assert.equal(first?.id, 'FIFO-old', 'the batch submitted first drains first');
  });

  test('lanes are independent: an ingest claimer never takes a process job', async () => {
    await seedQueued(['LANE-p1'], 'process');
    const claimed = await queue.claimNextJob('ingest');
    assert.ok(
      !claimed || claimed.id !== 'LANE-p1',
      'the GPU lane backlog must be invisible to the fetch lane'
    );
    const processClaim = await queue.claimNextJob('process');
    assert.equal(processClaim?.id, 'LANE-p1');
  });

  test('a claimed job is invisible to further claims until released', async () => {
    await seedQueued(['HELD-1']);
    const first = await queue.claimNextJob('ingest');
    assert.equal(first?.id, 'HELD-1');
    const second = await queue.claimNextJob('ingest');
    assert.equal(second, null, 'owned rows are out of the pool even while still "queued"');
  });

  // --- The batch surface ------------------------------------------------------

  test('bulk returns a batch id and durable rows; the batch endpoint aggregates', async () => {
    const res = await app.request('/api/ingest/bulk', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        arxivIds: ['2401.00001', '2401.00002', '2401.00003'],
        autoProcess: false,
        domain: 'nlp',
        note: 'DURABLETEST batch',
      }),
    });
    assert.equal(res.status, 202);
    const body = (await res.json()) as {
      batchId: string;
      statusUrl: string;
      jobs: Array<{ jobId: string }>;
    };
    batchIds.push(body.batchId);
    for (const j of body.jobs) jobIds.push(j.jobId);
    assert.equal(body.jobs.length, 3);

    // Workers are not running under NODE_ENV=test, so the rows sit queued —
    // which is itself the durability claim: they exist with no process attached.
    const status = await app.request(body.statusUrl);
    assert.equal(status.status, 200);
    const report = (await status.json()) as {
      complete: boolean;
      counts: Record<string, number>;
      jobs: Array<{ arxivId?: string; status: string }>;
    };
    assert.equal(report.complete, false);
    assert.equal(report.counts.queued, 3);
    assert.deepEqual(
      report.jobs.map((j) => j.arxivId).sort(),
      ['2401.00001', '2401.00002', '2401.00003']
    );
  });

  test('a duplicate id within a batch is submitted once', async () => {
    const res = await app.request('/api/ingest/bulk', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        arxivIds: ['2402.11111', '2402.11111', 'arXiv:2402.11111'],
        autoProcess: false,
        domain: 'nlp',
      }),
    });
    assert.equal(res.status, 202);
    const body = (await res.json()) as { batchId: string; jobs: Array<{ jobId: string }> };
    batchIds.push(body.batchId);
    for (const j of body.jobs) jobIds.push(j.jobId);
    assert.equal(body.jobs.length, 1);
  });

  test('an unknown batch id is a 404, and a malformed one does not 500', async () => {
    assert.equal((await app.request('/api/ingest/batches/not-a-uuid')).status, 404);
    assert.equal(
      (await app.request('/api/ingest/batches/00000000-0000-4000-8000-000000000000')).status,
      404
    );
  });
});
