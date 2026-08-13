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
import { inArray, sql } from 'drizzle-orm';

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
    // Dated to the epoch so FIFO puts it first regardless of what else any other
    // suite has left in the process lane — the property under test is lane
    // separation, not "this suite owns the queue".
    await db.insert(schema.jobs).values({
      id: 'LANE-p1',
      type: 'process',
      status: 'queued',
      createdAt: new Date(0),
      metadata: { test: true } as never,
    });
    jobIds.push('LANE-p1');

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

  test('the processing view says WHY each paper is waiting', async () => {
    // The dashboard rendered "queued, a worker will take it" and "nothing is
    // scheduled" identically, which is what made a working queue look idle.
    const [scheduled] = await db
      .insert(schema.papers)
      .values({ title: 'QUEUEVIEW scheduled', domain: 'nlp', processingStatus: 'pending' })
      .returning();
    const [unscheduled] = await db
      .insert(schema.papers)
      .values({ title: 'QUEUEVIEW unscheduled', domain: 'nlp', processingStatus: 'pending' })
      .returning();

    const queuedId = 'QUEUEVIEW-job-queued';
    await db.insert(schema.jobs).values({
      id: queuedId,
      type: 'process',
      status: 'queued',
      paperId: scheduled.id,
      createdAt: new Date(Date.now() - 60_000),
    });
    jobIds.push(queuedId);

    try {
      const res = await app.request('/api/papers/processing');
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        papers: Array<{ id: string; queue?: { state: string; position?: number } }>;
        workers?: { processConcurrency: number; running: number; queued: number };
      };

      const byId = new Map(body.papers.map((p) => [p.id, p]));
      assert.equal(byId.get(scheduled.id)?.queue?.state, 'queued');
      assert.ok(
        (byId.get(scheduled.id)?.queue?.position ?? 0) >= 1,
        'a queued paper knows its place in line'
      );
      assert.equal(
        byId.get(unscheduled.id)?.queue?.state,
        'unscheduled',
        'a paper with no job must not be reported as queued — it needs the button'
      );
      assert.ok(
        (body.workers?.processConcurrency ?? 0) >= 1,
        'the lane width is reported so a backlog can be explained, not just shown'
      );
    } finally {
      await db
        .delete(schema.papers)
        .where(inArray(schema.papers.id, [scheduled.id, unscheduled.id]));
    }
  });

  test('parked papers are listed but do not count as activity', async () => {
    // The dashboard polls fast while work is moving and slowly when it is not.
    // That decision used to key off the length of this list — which was correct
    // until the list started including `failed` and `paused` papers so their
    // controls could be reached. After that the list is never empty while
    // anything is parked, and the dashboard polled every two seconds forever
    // with nothing running. `workers` has to stay an honest activity signal.
    const [parked] = await db
      .insert(schema.papers)
      .values({ title: 'PARKEDTEST paused', domain: 'nlp', processingStatus: 'paused' })
      .returning();
    const [broken] = await db
      .insert(schema.papers)
      .values({ title: 'PARKEDTEST failed', domain: 'nlp', processingStatus: 'failed' })
      .returning();

    try {
      const body = (await (await app.request('/api/papers/processing')).json()) as {
        papers: Array<{ id: string }>;
        workers?: { running: number; queued: number };
      };

      const ids = new Set(body.papers.map((p) => p.id));
      assert.ok(ids.has(parked.id), 'a paused paper is still shown — it needs its Resume control');
      assert.ok(ids.has(broken.id), 'and so is a failed one');

      assert.equal(
        (body.workers?.running ?? 0) + (body.workers?.queued ?? 0),
        0,
        'neither is running or queued, so neither is activity'
      );
    } finally {
      await db.delete(schema.papers).where(inArray(schema.papers.id, [parked.id, broken.id]));
    }
  });

  test('a claimed job shows as running, not queued', async () => {
    const [paper] = await db
      .insert(schema.papers)
      .values({ title: 'QUEUEVIEW running', domain: 'nlp', processingStatus: 'extracting_entities' })
      .returning();
    const runningId = 'QUEUEVIEW-job-running';
    await db.insert(schema.jobs).values({
      id: runningId,
      type: 'process',
      status: 'processing',
      owner: 'some-instance:3000',
      leaseExpiresAt: new Date(Date.now() + 60_000),
      paperId: paper.id,
    });
    jobIds.push(runningId);

    try {
      const body = (await (await app.request('/api/papers/processing')).json()) as {
        papers: Array<{ id: string; queue?: { state: string } }>;
      };
      assert.equal(body.papers.find((p) => p.id === paper.id)?.queue?.state, 'running');
    } finally {
      await db.delete(schema.papers).where(inArray(schema.papers.id, [paper.id]));
    }
  });

  test('a paper cannot be scheduled twice', async () => {
    // Two routes could schedule a paper and only one remembered to check first.
    // Both jobs run resumePaper, which clears unfinished contribution before
    // rebuilding — so with concurrency they clear work the other is writing.
    const [paper] = await db
      .insert(schema.papers)
      .values({ title: 'SCHEDULETEST once', domain: 'nlp', processingStatus: 'pending' })
      .returning();

    try {
      const first = await app.request(`/api/papers/${paper.id}/resume`, { method: 'POST' });
      const firstBody = (await first.json()) as { jobId?: string };
      if (firstBody.jobId) jobIds.push(firstBody.jobId);

      // Straight at the queue, bypassing the route's own guard — the database
      // must be the thing that refuses, not the check above it.
      await assert.rejects(
        () => queue.createJob('SCHEDULETEST-dup', 'process', { paperId: paper.id }),
        (err: Error) => err.name === 'AlreadyScheduledError'
      );

      const live = await db.execute(
        sql`select count(*)::int as n from jobs
            where paper_id = ${paper.id} and type = 'process'
              and status not in ('completed','failed','paused')`
      );
      assert.equal((live as unknown as Array<{ n: number }>)[0].n, 1);
    } finally {
      await db.execute(sql`delete from jobs where paper_id = ${paper.id}`);
      await db.delete(schema.papers).where(inArray(schema.papers.id, [paper.id]));
    }
  });

  test('a paused paper can be scheduled again', async () => {
    // `paused` is terminal for the queue, so it must not block a resume.
    const [paper] = await db
      .insert(schema.papers)
      .values({ title: 'SCHEDULETEST paused', domain: 'nlp', processingStatus: 'paused' })
      .returning();
    await db.insert(schema.jobs).values({
      id: 'SCHEDULETEST-paused-job',
      type: 'process',
      status: 'paused',
      paperId: paper.id,
    });

    try {
      await queue.createJob('SCHEDULETEST-after-pause', 'process', { paperId: paper.id });
      const live = await db.execute(
        sql`select count(*)::int as n from jobs
            where paper_id = ${paper.id} and status = 'queued'`
      );
      assert.equal((live as unknown as Array<{ n: number }>)[0].n, 1);
    } finally {
      await db.execute(sql`delete from jobs where paper_id = ${paper.id}`);
      await db.delete(schema.papers).where(inArray(schema.papers.id, [paper.id]));
    }
  });

  test('an unknown batch id is a 404, and a malformed one does not 500', async () => {
    assert.equal((await app.request('/api/ingest/batches/not-a-uuid')).status, 404);
    assert.equal(
      (await app.request('/api/ingest/batches/00000000-0000-4000-8000-000000000000')).status,
      404
    );
  });
});
