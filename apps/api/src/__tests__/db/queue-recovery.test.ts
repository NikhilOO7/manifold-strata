/**
 * Startup recovery must not destroy another instance's live work.
 *
 * Found in production use, not in review: a second API process starting up
 * (a test run, a second instance, or `tsx watch` reloading on a file change)
 * marked *every* non-terminal job in the shared database as
 * "Interrupted by server restart" — including a job that a different, still-running
 * instance had accepted seconds earlier. Ingestion silently died mid-flight and
 * the user was told their paper had been interrupted by a restart that never
 * touched it.
 *
 * Requires Postgres:  pnpm --filter api test:db
 */

// Load the same .env the API loads: the embedding space (provider, model,
// dimensions) must match the database's vector columns, and a test process
// that missed it would compute 1536-dim vectors against a 768-dim column.
import 'dotenv/config';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { eq, inArray } from 'drizzle-orm';

const dbUrl = process.env.TEST_DATABASE_URL;
if (dbUrl) process.env.DATABASE_URL = dbUrl;
process.env.NODE_ENV = 'test';

const shouldRun = Boolean(dbUrl);

describe('job recovery ownership', { skip: shouldRun ? false : 'TEST_DATABASE_URL not set' }, () => {
  let db: typeof import('../../db').db;
  let schema: typeof import('../../db/schema');
  let recoverOrphanedJobs: typeof import('../../queue').recoverOrphanedJobs;
  let INSTANCE_ID: string;

  const jobIds: string[] = [];

  const makeJob = async (id: string, owner: string | null, leaseExpiresAt: Date | null) => {
    await db.insert(schema.jobs).values({
      id,
      type: 'ingest',
      status: 'processing',
      owner,
      leaseExpiresAt,
      metadata: { test: true },
    });
    jobIds.push(id);
  };

  const statusOf = async (id: string) => {
    const [row] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, id)).limit(1);
    return row?.status;
  };

  before(async () => {
    ({ db } = await import('../../db'));
    schema = await import('../../db/schema');
    ({ recoverOrphanedJobs, INSTANCE_ID } = await import('../../queue'));
  });

  after(async () => {
    if (!shouldRun) return;
    if (jobIds.length) await db.delete(schema.jobs).where(inArray(schema.jobs.id, jobIds));
    const { closeDb } = await import('../../db');
    await closeDb();
  });

  test('recovers this instance\'s own interrupted jobs', async () => {
    // Our in-memory queue is empty at startup by definition, so anything we own
    // that is still "processing" died with the previous process.
    const id = 'QUEUETEST-own-job';
    await makeJob(id, INSTANCE_ID, new Date(Date.now() + 60_000));

    const result = await recoverOrphanedJobs();
    assert.ok(result.ownJobs >= 1);
    assert.equal(await statusOf(id), 'failed');
  });

  test('leaves a live job owned by ANOTHER instance untouched', async () => {
    // The regression. Its owner is alive and renewing, so it is still running.
    const id = 'QUEUETEST-other-live';
    await makeJob(id, 'other-host:9999', new Date(Date.now() + 60_000));

    await recoverOrphanedJobs();
    assert.equal(
      await statusOf(id),
      'processing',
      'another instance\'s in-flight job must survive our startup'
    );
  });

  test('recovers a job whose owner stopped renewing its lease', async () => {
    // The safety net: a permanently-dead instance must not strand work forever.
    const id = 'QUEUETEST-expired-lease';
    await makeJob(id, 'dead-host:9999', new Date(Date.now() - 60_000));

    const result = await recoverOrphanedJobs();
    assert.ok(result.expiredLeases >= 1);
    assert.equal(await statusOf(id), 'failed');
  });

  test('recovers pre-ownership rows that have no owner recorded', async () => {
    const id = 'QUEUETEST-legacy';
    await makeJob(id, null, null);

    await recoverOrphanedJobs();
    assert.equal(await statusOf(id), 'failed');
  });

  test('does not touch jobs that already reached a terminal state', async () => {
    const id = 'QUEUETEST-terminal';
    await db.insert(schema.jobs).values({
      id,
      type: 'ingest',
      status: 'completed',
      owner: INSTANCE_ID,
      progress: 'all good',
    });
    jobIds.push(id);

    await recoverOrphanedJobs();
    assert.equal(await statusOf(id), 'completed');
  });

  test('a paper still owned by another instance\'s live job keeps its in-progress status', async () => {
    const [paper] = await db
      .insert(schema.papers)
      .values({
        title: 'QUEUETEST Live Paper',
        domain: 'nlp',
        processingStatus: 'extracting_entities',
      })
      .returning();

    const id = 'QUEUETEST-other-live-paper';
    await db.insert(schema.jobs).values({
      id,
      type: 'process',
      status: 'processing',
      paperId: paper.id,
      owner: 'other-host:9999',
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    jobIds.push(id);

    try {
      await recoverOrphanedJobs();
      const [after] = await db
        .select()
        .from(schema.papers)
        .where(eq(schema.papers.id, paper.id));
      assert.equal(
        after.processingStatus,
        'extracting_entities',
        'a paper being worked on elsewhere must not be marked failed'
      );
    } finally {
      await db.delete(schema.jobs).where(eq(schema.jobs.id, id));
      await db.delete(schema.papers).where(eq(schema.papers.id, paper.id));
    }
  });
});
