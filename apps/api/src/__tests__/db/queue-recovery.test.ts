/**
 * Restart recovery under the durable queue.
 *
 * The contract CHANGED here, deliberately. The old queue held work in process
 * memory, so the only honest recovery was to fail everything interrupted. The
 * durable queue's whole reason to exist is a batch that outlives restarts, so
 * recovery now means:
 *
 *   queued, unowned          untouched — it is simply still in the queue
 *   interrupted, retriable   RE-QUEUED for any instance (attempts < max)
 *   interrupted, exhausted   failed, honestly
 *   another instance's live  untouched — its lease is current
 *
 * The invariant that survives from the old world: startup must never destroy
 * another instance's in-flight work. That regression shipped once.
 *
 * Requires Postgres:  pnpm --filter api test:db
 */

import 'dotenv/config';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { eq, inArray } from 'drizzle-orm';

const dbUrl = process.env.TEST_DATABASE_URL;
if (dbUrl) process.env.DATABASE_URL = dbUrl;
process.env.NODE_ENV = 'test';

const shouldRun = Boolean(dbUrl);

describe('durable queue recovery', { skip: shouldRun ? false : 'TEST_DATABASE_URL not set' }, () => {
  let db: typeof import('../../db').db;
  let schema: typeof import('../../db/schema');
  let queue: typeof import('../../queue');

  const jobIds: string[] = [];

  const makeJob = async (
    id: string,
    fields: {
      status?: import('../../queue').JobStatus;
      owner?: string | null;
      leaseExpiresAt?: Date | null;
      attempts?: number;
      paperId?: string;
    } = {}
  ) => {
    await db.insert(schema.jobs).values({
      id,
      type: 'ingest',
      status: fields.status ?? 'processing',
      owner: fields.owner === undefined ? null : fields.owner,
      leaseExpiresAt: fields.leaseExpiresAt ?? null,
      attempts: fields.attempts ?? 1,
      paperId: fields.paperId ?? null,
      metadata: { test: true } as never,
    });
    jobIds.push(id);
  };

  const rowOf = async (id: string) => {
    const [row] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, id)).limit(1);
    return row;
  };

  before(async () => {
    ({ db } = await import('../../db'));
    schema = await import('../../db/schema');
    queue = await import('../../queue');
  });

  after(async () => {
    if (!shouldRun) return;
    if (jobIds.length) await db.delete(schema.jobs).where(inArray(schema.jobs.id, jobIds));
    const { closeDb } = await import('../../db');
    await closeDb();
  });

  test('own interrupted job is RE-QUEUED, not failed — the durable-queue payoff', async () => {
    const id = 'RECOVERTEST-own-retriable';
    await makeJob(id, { owner: queue.INSTANCE_ID, leaseExpiresAt: new Date(Date.now() + 60_000), attempts: 1 });

    const result = await queue.recoverOnStartup();
    assert.ok(result.requeued >= 1);

    const row = await rowOf(id);
    assert.equal(row.status, 'queued');
    assert.equal(row.owner, null, 'released for any instance to claim');
    assert.equal(row.leaseExpiresAt, null);
  });

  test('an interrupted job out of attempts fails honestly', async () => {
    const id = 'RECOVERTEST-own-exhausted';
    await makeJob(id, {
      owner: queue.INSTANCE_ID,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      attempts: queue.MAX_JOB_ATTEMPTS,
    });

    await queue.recoverOnStartup();
    const row = await rowOf(id);
    assert.equal(row.status, 'failed');
    assert.match(row.error ?? '', /out of retry attempts/);
  });

  test('a queued unowned job needs no recovery at all', async () => {
    const id = 'RECOVERTEST-queued-durable';
    await makeJob(id, { status: 'queued', owner: null, attempts: 0 });

    await queue.recoverOnStartup();
    const row = await rowOf(id);
    assert.equal(row.status, 'queued');
    assert.equal(row.attempts, 0, 'untouched — it is simply still in the queue');
  });

  test("another instance's live job is untouched", async () => {
    // The invariant that must survive the redesign: this regression shipped once.
    const id = 'RECOVERTEST-other-live';
    await makeJob(id, { owner: 'other-host:9999', leaseExpiresAt: new Date(Date.now() + 60_000) });

    await queue.recoverOnStartup();
    assert.equal((await rowOf(id)).status, 'processing');
  });

  test("a dead instance's job (expired lease) is re-queued by the reaper", async () => {
    const id = 'RECOVERTEST-expired-lease';
    await makeJob(id, { owner: 'dead-host:9999', leaseExpiresAt: new Date(Date.now() - 60_000), attempts: 1 });

    const result = await queue.reapExpiredJobs();
    assert.ok(result.requeued >= 1);
    const row = await rowOf(id);
    assert.equal(row.status, 'queued');
    assert.equal(row.owner, null);
  });

  test('terminal jobs are never revisited', async () => {
    const id = 'RECOVERTEST-terminal';
    await makeJob(id, { status: 'completed', owner: queue.INSTANCE_ID });

    await queue.recoverOnStartup();
    assert.equal((await rowOf(id)).status, 'completed');
  });

  test('a paper whose job was re-queued keeps its in-progress status', async () => {
    // The requeue runs in the same transaction before the paper sweep, so a
    // resumable paper's job is non-terminal again by the time the sweep looks.
    const [paper] = await db
      .insert(schema.papers)
      .values({ title: 'RECOVERTEST resumable', domain: 'nlp', processingStatus: 'extracting_entities' })
      .returning();
    const id = 'RECOVERTEST-paper-resumable';
    await makeJob(id, {
      owner: queue.INSTANCE_ID,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      attempts: 1,
      paperId: paper.id,
    });

    try {
      await queue.recoverOnStartup();
      const [after] = await db.select().from(schema.papers).where(eq(schema.papers.id, paper.id));
      assert.equal(
        after.processingStatus,
        'extracting_entities',
        'the job will resume; failing the paper would lie to the dashboard'
      );
    } finally {
      await db.delete(schema.papers).where(eq(schema.papers.id, paper.id));
    }
  });

  test('a paper whose job exhausted its attempts is reset to failed', async () => {
    const [paper] = await db
      .insert(schema.papers)
      .values({ title: 'RECOVERTEST dead', domain: 'nlp', processingStatus: 'extracting_entities' })
      .returning();
    const id = 'RECOVERTEST-paper-dead';
    await makeJob(id, {
      owner: queue.INSTANCE_ID,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      attempts: queue.MAX_JOB_ATTEMPTS,
      paperId: paper.id,
    });

    try {
      await queue.recoverOnStartup();
      const [after] = await db.select().from(schema.papers).where(eq(schema.papers.id, paper.id));
      assert.equal(after.processingStatus, 'failed');
    } finally {
      await db.delete(schema.papers).where(eq(schema.papers.id, paper.id));
    }
  });
});
