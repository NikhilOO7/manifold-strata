/**
 * Resume must keep completed work and redo only what is unfinished.
 *
 * The defect this replaces: a paper that failed at chunk 24 of 26 had its whole
 * contribution cleared and started again at chunk 0 — fifteen minutes of correct
 * GPU work discarded because an edge could not be attributed to a chunk, so the
 * only provably-safe undo was "undo everything".
 *
 * The properties worth pinning are the two that could silently rot:
 *   - a kept chunk's evidence survives, and an unfinished chunk's does not
 *   - a checkpoint stops counting the moment its text changes, because chunk N
 *     meaning different text is how resume would corrupt provenance
 *
 * Requires Postgres:  pnpm --filter api test:db
 */

import 'dotenv/config';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq, inArray, sql } from 'drizzle-orm';

const dbUrl = process.env.TEST_DATABASE_URL;
if (dbUrl) process.env.DATABASE_URL = dbUrl;
process.env.NODE_ENV = 'test';
process.env.EMBED_PROVIDER = 'local';

const shouldRun = Boolean(dbUrl);

describe('chunk checkpoints', { skip: shouldRun ? false : 'TEST_DATABASE_URL not set' }, () => {
  let db: typeof import('../../db').db;
  let schema: typeof import('../../db/schema');
  let clearChunkContributions: typeof import('../../pipeline/processor').clearChunkContributions;
  let app: import('hono').Hono;

  const paperIds: string[] = [];

  /** A paper with two chunks' worth of edges, each attributed to its chunk. */
  const seedPaper = async (title: string) => {
    const [paper] = await db
      .insert(schema.papers)
      .values({ title, domain: 'nlp', processingStatus: 'failed', rawText: 'x' })
      .returning();
    paperIds.push(paper.id);

    const [a] = await db
      .insert(schema.nodes)
      .values({ type: 'method', domain: 'nlp', name: `${title} A`, normalizedName: `${title} a` })
      .returning();
    const [b] = await db
      .insert(schema.nodes)
      .values({ type: 'method', domain: 'nlp', name: `${title} B`, normalizedName: `${title} b` })
      .returning();

    const mkEdge = async (chunkIndex: number) => {
      const [edge] = await db
        .insert(schema.edges)
        .values({ sourceId: a.id, targetId: b.id, type: `rel_${chunkIndex}`, domain: 'nlp' })
        .returning();
      await db.insert(schema.sources).values({ edgeId: edge.id, paperId: paper.id, chunkIndex });
      return edge.id;
    };

    const edge0 = await mkEdge(0);
    const edge1 = await mkEdge(1);

    await db.insert(schema.paperChunks).values([
      { paperId: paper.id, chunkIndex: 0, status: 'completed', contentHash: 'hash-0', entities: 3 },
      { paperId: paper.id, chunkIndex: 1, status: 'completed', contentHash: 'hash-1', entities: 2 },
    ]);

    return { paper, edge0, edge1 };
  };

  /**
   * Neither jobs nor nodes cascade with papers — `nodes.paper_id` is
   * ON DELETE SET NULL, deliberately, because entities outlive the paper that
   * first named them. So a suite that only deletes papers leaves both behind,
   * and the unique identity index turns that leak into a hard failure on the
   * second run rather than silently duplicating as it used to.
   */
  const purgeOwnRows = async () => {
    await db.execute(
      sql`delete from jobs where id like 'RESUMETEST%'
          or paper_id in (select id from papers where title like 'RESUMETEST%')`
    );
    await db.execute(sql`delete from nodes where name like 'RESUMETEST%'`);
  };

  before(async () => {
    ({ db } = await import('../../db'));
    schema = await import('../../db/schema');
    ({ clearChunkContributions } = await import('../../pipeline/processor'));
    ({ app } = await import('../../index'));
    await purgeOwnRows();
    await db.execute(sql`delete from papers where title like 'RESUMETEST%'`);
  });

  after(async () => {
    if (!shouldRun) return;
    await purgeOwnRows();
    if (paperIds.length) await db.delete(schema.papers).where(inArray(schema.papers.id, paperIds));
    const { closeDb } = await import('../../db');
    await closeDb();
  });

  test('keeping chunk 0 preserves its evidence and drops only chunk 1', async () => {
    const { paper, edge0, edge1 } = await seedPaper('RESUMETEST keep-one');

    const cleared = await clearChunkContributions(paper.id, [0]);
    assert.equal(cleared.sources, 1, 'exactly one chunk of provenance removed');

    const surviving = await db
      .select()
      .from(schema.edges)
      .where(inArray(schema.edges.id, [edge0, edge1]));
    assert.deepEqual(
      surviving.map((e) => e.id),
      [edge0],
      "the completed chunk's edge survives; the unfinished one's does not"
    );

    const checkpoints = await db
      .select()
      .from(schema.paperChunks)
      .where(eq(schema.paperChunks.paperId, paper.id));
    assert.deepEqual(
      checkpoints.map((c) => c.chunkIndex),
      [0],
      'the checkpoint for the undone chunk is forgotten, so it will be redone'
    );
  });

  test('keeping nothing is exactly the old whole-paper rebuild', async () => {
    const { paper, edge0, edge1 } = await seedPaper('RESUMETEST keep-none');

    await clearChunkContributions(paper.id, []);

    const surviving = await db
      .select()
      .from(schema.edges)
      .where(inArray(schema.edges.id, [edge0, edge1]));
    assert.equal(surviving.length, 0);
    assert.equal(
      (
        await db
          .select()
          .from(schema.paperChunks)
          .where(eq(schema.paperChunks.paperId, paper.id))
      ).length,
      0
    );
  });

  test('an edge another chunk still asserts is not deleted', async () => {
    // Provenance is the point: a claim with surviving support must survive.
    const { paper } = await seedPaper('RESUMETEST shared-edge');
    const [node] = await db
      .insert(schema.nodes)
      .values({ type: 'method', domain: 'nlp', name: 'RESUMETEST shared', normalizedName: 'resumetest shared' })
      .returning();
    const [edge] = await db
      .insert(schema.edges)
      .values({ sourceId: node.id, targetId: node.id, type: 'shared', domain: 'nlp' })
      .returning();
    // Asserted by BOTH chunks.
    await db.insert(schema.sources).values([
      { edgeId: edge.id, paperId: paper.id, chunkIndex: 0 },
      { edgeId: edge.id, paperId: paper.id, chunkIndex: 1 },
    ]);

    await clearChunkContributions(paper.id, [0]);

    const [still] = await db.select().from(schema.edges).where(eq(schema.edges.id, edge.id));
    assert.ok(still, 'chunk 0 still asserts this edge, so it keeps its support');
  });

  test('rows written before chunk attribution existed are redone, not guessed at', async () => {
    const { paper } = await seedPaper('RESUMETEST legacy-null');
    const [node] = await db
      .insert(schema.nodes)
      .values({ type: 'method', domain: 'nlp', name: 'RESUMETEST legacy', normalizedName: 'resumetest legacy' })
      .returning();
    const [edge] = await db
      .insert(schema.edges)
      .values({ sourceId: node.id, targetId: node.id, type: 'legacy', domain: 'nlp' })
      .returning();
    await db.insert(schema.sources).values({ edgeId: edge.id, paperId: paper.id, chunkIndex: null });

    await clearChunkContributions(paper.id, [0, 1]);

    const [gone] = await db.select().from(schema.edges).where(eq(schema.edges.id, edge.id));
    assert.equal(gone, undefined, 'unattributable evidence belongs to no chunk we can vouch for');
  });

  test('the chunk view reports per-chunk progress', async () => {
    const { paper } = await seedPaper('RESUMETEST view');
    const res = await app.request(`/api/papers/${paper.id}/chunks`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      completed: number;
      chunks: Array<{ index: number; status: string; entities: number }>;
    };
    assert.equal(body.completed, 2);
    assert.deepEqual(
      body.chunks.map((c) => c.index),
      [0, 1]
    );
  });

  test('resume schedules a job that keeps completed chunks', async () => {
    const { paper } = await seedPaper('RESUMETEST resume-route');

    const res = await app.request(`/api/papers/${paper.id}/resume`, { method: 'POST' });
    assert.equal(res.status, 202);
    const body = (await res.json()) as { jobId: string; resumingFromChunk: number };
    assert.equal(body.resumingFromChunk, 2, 'both completed chunks are kept');

    const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, body.jobId));
    assert.equal(job.status, 'queued');
    assert.equal((job.metadata as { rebuild?: boolean }).rebuild, false, 'a retry is not a rebuild');

    // And a paper already scheduled must not get a second competing job.
    const again = await app.request(`/api/papers/${paper.id}/resume`, { method: 'POST' });
    const againBody = (await again.json()) as { jobId: string };
    assert.equal(againBody.jobId, body.jobId, 'no duplicate job for the same paper');
  });

  test('rebuild=true opts out of the checkpoint', async () => {
    const { paper } = await seedPaper('RESUMETEST rebuild');
    const res = await app.request(`/api/papers/${paper.id}/resume?rebuild=true`, { method: 'POST' });
    const body = (await res.json()) as { jobId: string; resumingFromChunk: number };
    assert.equal(body.resumingFromChunk, 0);
    const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, body.jobId));
    assert.equal((job.metadata as { rebuild?: boolean }).rebuild, true);
  });

  test('pausing a queued paper parks it without waiting for a chunk boundary', async () => {
    const { paper } = await seedPaper('RESUMETEST pause');
    const jobId = 'RESUMETEST-pause-job';
    await db
      .insert(schema.jobs)
      .values({ id: jobId, type: 'process', status: 'queued', paperId: paper.id });

    const res = await app.request(`/api/papers/${paper.id}/pause`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { stoppedImmediately: boolean };
    assert.equal(body.stoppedImmediately, true, 'nothing was running, so nothing had to be interrupted');

    const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    assert.equal(job.status, 'paused');
    assert.equal(job.owner, null);

    const [after] = await db.select().from(schema.papers).where(eq(schema.papers.id, paper.id));
    assert.equal(after.processingStatus, 'paused');
  });

  test('a paused job is invisible to claimers', async () => {
    const queue = await import('../../queue');
    // Everything paused; a claimer must find nothing rather than resume it itself.
    const claimed = await queue.claimNextJob('process');
    if (claimed) {
      assert.notEqual(claimed.status, 'paused');
      // Put it back so the suite leaves no claimed work behind.
      await db
        .update(schema.jobs)
        .set({ status: 'queued', owner: null, leaseExpiresAt: null })
        .where(eq(schema.jobs.id, claimed.id));
    }
    const paused = await db
      .select()
      .from(schema.jobs)
      .where(and(eq(schema.jobs.status, 'paused'), eq(schema.jobs.type, 'process')));
    assert.ok(paused.every((j) => j.owner === null), 'paused work is never owned');
  });
});
