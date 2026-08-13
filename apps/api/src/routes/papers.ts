import { Hono } from 'hono';
import { db } from '../db';
import { papers, jobs, paperChunks, nodes, edges } from '../db/schema';
import { eq, and, desc, inArray, sql } from 'drizzle-orm';
import {
  createJob,
  workerCapacity,
  NON_TERMINAL_JOB_STATUSES,
  AlreadyScheduledError,
} from '../queue';
import { clearPaperContributions } from '../pipeline/processor';
import { domainWhere } from '../domains/filter';
import { requireDomain, requireScopeOn } from '../middleware/auth';
import { routeError, isUuid } from './errors';

export const papersRouter = new Hono();

function pageParams(c: { req: { query: (k: string) => string | undefined } }) {
  const rawLimit = parseInt(c.req.query('limit') || '20', 10);
  const rawOffset = parseInt(c.req.query('offset') || '0', 10);
  return {
    limit: Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 20,
    offset: Number.isFinite(rawOffset) ? Math.max(rawOffset, 0) : 0,
  };
}

papersRouter.get('/', async (c) => {
  try {
    const { limit, offset } = pageParams(c);
    const rawDomain = c.req.query('domain');
    const where = rawDomain ? domainWhere(papers.domain, requireDomain(c, rawDomain, 'papers.read').id) : undefined;

    const allPapers = await db
      .select()
      .from(papers)
      .where(where)
      .orderBy(desc(papers.createdAt))
      .limit(limit)
      .offset(offset);

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(papers)
      .where(where);

    return c.json({
      papers: allPapers,
      pagination: { limit, offset, total: count ?? 0 },
    });
  } catch (error) {
    return routeError(c, error, 'Failed to fetch papers');
  }
});

papersRouter.get('/processing', async (c) => {
  try {
    const processingPapers = await db
      .select()
      .from(papers)
      .where(
        // 'failed' and 'paused' belong here, and their absence was a real bug:
        // this is the view that carries the Retry and Resume controls, so
        // excluding the two states that NEED those controls made them
        // unreachable. A paper stuck in a state only an operator can clear is
        // exactly what an operations view is for.
        inArray(papers.processingStatus, [
          'pending',
          'downloading_pdf',
          'extracting_text',
          'chunking',
          'extracting_entities',
          'resolving_entities',
          'validating',
          'paused',
          'failed',
        ])
      )
      .orderBy(desc(papers.createdAt));

    // Why each paper is where it is, not just that it is waiting.
    //
    // `processingStatus: 'pending'` alone cannot distinguish "queued, a worker
    // will pick this up" from "nothing is scheduled, press the button" — and the
    // dashboard rendered both as "Pending" beside a Process Now button, which
    // reads as the second when it is usually the first. A queue nobody can see
    // the shape of looks like a system doing nothing.
    const liveJobs = await db
      .select({
        paperId: jobs.paperId,
        status: jobs.status,
        owner: jobs.owner,
        createdAt: jobs.createdAt,
      })
      .from(jobs)
      .where(and(eq(jobs.type, 'process'), inArray(jobs.status, NON_TERMINAL_JOB_STATUSES)))
      .orderBy(jobs.createdAt);

    const queueState = new Map<string, { state: string; position?: number }>();
    let position = 0;
    for (const job of liveJobs) {
      if (!job.paperId) continue;
      if (job.owner) {
        queueState.set(job.paperId, { state: 'running' });
      } else {
        position += 1;
        queueState.set(job.paperId, { state: 'queued', position });
      }
    }

    const capacity = workerCapacity();
    return c.json({
      papers: processingPapers.map((p) => ({
        ...p,
        // 'unscheduled' is the honest label for a paper with no job at all:
        // it really does need the button.
        queue: queueState.get(p.id) ?? { state: 'unscheduled' },
      })),
      workers: {
        processConcurrency: capacity.process,
        running: [...queueState.values()].filter((q) => q.state === 'running').length,
        queued: position,
      },
    });
  } catch (error) {
    return routeError(c, error, 'Failed to fetch processing papers');
  }
});

/**
 * Pause a paper between chunks.
 *
 * Cooperative, not a kill: the processor checks this status before each chunk
 * and stops cleanly, so the ~34s already spent on the chunk in flight is not
 * thrown away and the checkpoint stays exact. A paper that is merely queued
 * pauses immediately — there is nothing to interrupt.
 */
papersRouter.post('/:id/pause', async (c) => {
  try {
    const id = c.req.param('id');
    if (!isUuid(id)) return c.json({ error: 'Paper not found' }, 404);

    const [paper] = await db.select().from(papers).where(eq(papers.id, id)).limit(1);
    if (!paper) return c.json({ error: 'Paper not found' }, 404);
    requireDomain(c, paper.domain ?? undefined, 'papers.pause');
    requireScopeOn(c, 'write', 'papers.pause');

    if (paper.processingStatus === 'completed') {
      return c.json({ error: 'Paper has already finished processing' }, 409);
    }
    if (paper.processingStatus === 'paused') {
      return c.json({ message: 'Already paused', paperId: id, status: 'paused' });
    }

    await db.update(papers).set({ processingStatus: 'paused' }).where(eq(papers.id, id));

    // A job that has not been claimed has no loop to notice the flag, so park it
    // directly. A running one is left alone: its next chunk boundary is where a
    // clean stop actually happens.
    const parked = await db
      .update(jobs)
      .set({ status: 'paused', owner: null, leaseExpiresAt: null, updatedAt: new Date() })
      .where(and(eq(jobs.paperId, id), eq(jobs.status, 'queued')))
      .returning({ id: jobs.id });

    return c.json({
      message: parked.length
        ? 'Paused before it started'
        : 'Pause requested — it will stop after the current chunk',
      paperId: id,
      status: 'paused',
      stoppedImmediately: parked.length > 0,
    });
  } catch (error) {
    return routeError(c, error, 'Failed to pause paper');
  }
});

/**
 * Resume (or retry) a paper from its checkpoint.
 *
 * The same operation serves both, because they are the same operation: put the
 * work back on the queue and let the handler keep whatever chunks already
 * completed. `?rebuild=true` opts out and starts from chunk 0, which is what you
 * want after changing the extractor or the model — not after a crash.
 */
papersRouter.post('/:id/resume', async (c) => {
  try {
    const id = c.req.param('id');
    if (!isUuid(id)) return c.json({ error: 'Paper not found' }, 404);

    const [paper] = await db.select().from(papers).where(eq(papers.id, id)).limit(1);
    if (!paper) return c.json({ error: 'Paper not found' }, 404);
    requireDomain(c, paper.domain ?? undefined, 'papers.resume');
    requireScopeOn(c, 'write', 'papers.resume');

    const rebuild = c.req.query('rebuild') === 'true';

    // Already queued or running? Resuming again would create a second job for
    // the same paper and the two would fight over the same rows.
    const [live] = await db
      .select({ id: jobs.id, status: jobs.status })
      .from(jobs)
      .where(and(eq(jobs.paperId, id), inArray(jobs.status, NON_TERMINAL_JOB_STATUSES)))
      .limit(1);
    if (live) {
      return c.json({ message: 'Already scheduled', paperId: id, jobId: live.id, status: live.status });
    }

    const done = await db
      .select({ chunkIndex: paperChunks.chunkIndex })
      .from(paperChunks)
      .where(and(eq(paperChunks.paperId, id), eq(paperChunks.status, 'completed')));

    await db
      .update(papers)
      .set({
        processingStatus: 'pending',
        processingError: null,
        // A rebuild retains nothing, so it must not claim prior progress.
        ...(rebuild ? { processingProgress: 0 } : {}),
      })
      .where(eq(papers.id, id));

    const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await createJob(jobId, 'process', { paperId: id, metadata: { rebuild } });
    } catch (err) {
      if (err instanceof AlreadyScheduledError) {
        return c.json({ message: 'Already scheduled', paperId: id, status: 'queued' });
      }
      throw err;
    }

    return c.json(
      {
        message: rebuild
          ? 'Rebuilding from the first chunk'
          : `Resuming — ${done.length} completed chunk(s) will be kept`,
        paperId: id,
        jobId,
        status: 'queued',
        resumingFromChunk: rebuild ? 0 : done.length,
      },
      202
    );
  } catch (error) {
    return routeError(c, error, 'Failed to resume paper');
  }
});

/**
 * Move a paper to another domain, and rebuild its contribution there.
 *
 * This exists because a corpus silently split across domains is invisible until
 * you go looking for it. Six papers landed in `default` and one in `nlp`; every
 * one of them is about attention and transformers, and not one could relate to
 * another — resolution is domain-scoped by design, so "self-attention" existed
 * twice, once per domain, unable to merge. The graph looked sparse when it was
 * actually severed.
 *
 * A rebuild, not a resume, and deliberately so. The chunk texts are unchanged
 * but resolution is domain-scoped, so every identity decision this paper made
 * was made against the wrong neighbourhood. Keeping those checkpoints would
 * carry the old domain's answers into the new one — the paper and its entities
 * would disagree about where they live (invariant 4).
 */
papersRouter.post('/:id/domain', async (c) => {
  try {
    const id = c.req.param('id');
    if (!isUuid(id)) return c.json({ error: 'Paper not found' }, 404);

    const body = await c.req.json().catch(() => ({}) as { domain?: string });
    if (!body.domain) return c.json({ error: 'Body must include a "domain"' }, 400);

    const [paper] = await db.select().from(papers).where(eq(papers.id, id)).limit(1);
    if (!paper) return c.json({ error: 'Paper not found' }, 404);

    // Authorised on BOTH sides: moving a paper reads it out of one domain and
    // writes it into another, so a caller who may only write to the target
    // could otherwise pull data across a boundary they do not hold.
    requireDomain(c, paper.domain ?? undefined, 'papers.domain.from');
    const target = requireDomain(c, body.domain, 'papers.domain.to');
    requireScopeOn(c, 'write', 'papers.domain');

    if (target.id === paper.domain) {
      return c.json({ message: 'Already in that domain', paperId: id, domain: target.id });
    }

    // Its contribution belongs to the old domain and cannot follow it.
    const previousDomain = paper.domain ?? '';
    const cleared = await clearPaperContributions(id);

    // …and neither can its nodes.
    //
    // `clearPaperContributions` deliberately keeps nodes: within one domain they
    // are canonical and shared, so deleting them would cascade away other
    // papers' edges. Across a domain move that reasoning inverts. The nodes are
    // stamped with the OLD domain and the paper is leaving, so keeping them
    // leaves the paper and its entities disagreeing about where they live —
    // exactly what invariant 4 forbids. Observed: one paper in `nlp` still
    // owning 255 nodes stamped `default`.
    //
    // Only nodes nothing references are removed. A node another paper in the old
    // domain still asserts an edge to is still that domain's, and survives.
    const orphaned = (await db.execute(sql`
      delete from ${nodes} n
      where n.paper_id = ${id}
        and coalesce(n.domain, '') = ${previousDomain}
        and not exists (
          select 1 from ${edges} e where e.source_id = n.id or e.target_id = n.id
        )
      returning n.id
    `)) as unknown as Array<{ id: string }>;

    await db
      .update(papers)
      // The canonical registry id, never the raw request string (invariant 4).
      // Progress resets too: the contribution was just cleared, so a paper
      // reporting 100% here would be describing work that no longer exists.
      .set({
        domain: target.id,
        processed: false,
        processingStatus: 'pending',
        processingProgress: 0,
        processingError: null,
      })
      .where(eq(papers.id, id));

    const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await createJob(jobId, 'process', { paperId: id, metadata: { rebuild: true } });
    } catch (err) {
      if (err instanceof AlreadyScheduledError) {
        return c.json({
          message: `Moved to "${target.id}"; a rebuild was already scheduled`,
          paperId: id,
          domain: target.id,
          cleared,
        });
      }
      throw err;
    }

    return c.json(
      {
        message: `Moved to "${target.id}" and queued for rebuild`,
        paperId: id,
        domain: target.id,
        jobId,
        cleared: { ...cleared, orphanedNodes: orphaned.length },
      },
      202
    );
  } catch (error) {
    return routeError(c, error, 'Failed to move paper');
  }
});

/** Per-chunk progress: what has been extracted, what is left, what failed. */
papersRouter.get('/:id/chunks', async (c) => {
  try {
    const id = c.req.param('id');
    if (!isUuid(id)) return c.json({ error: 'Paper not found' }, 404);

    const [paper] = await db.select().from(papers).where(eq(papers.id, id)).limit(1);
    if (!paper) return c.json({ error: 'Paper not found' }, 404);
    requireDomain(c, paper.domain ?? undefined, 'papers.chunks');

    const rows = await db
      .select()
      .from(paperChunks)
      .where(eq(paperChunks.paperId, id))
      .orderBy(paperChunks.chunkIndex);

    return c.json({
      paperId: id,
      completed: rows.filter((r) => r.status === 'completed').length,
      chunks: rows.map((r) => ({
        index: r.chunkIndex,
        status: r.status,
        section: r.section,
        entities: r.entities,
        relationships: r.relationships,
        error: r.error,
      })),
    });
  } catch (error) {
    return routeError(c, error, 'Failed to fetch chunk progress');
  }
});

papersRouter.get('/:id', async (c) => {
  try {
    const id = c.req.param('id');
    if (!isUuid(id)) return c.json({ error: 'Paper not found' }, 404);

    const [paper] = await db.select().from(papers).where(eq(papers.id, id)).limit(1);
    if (!paper) {
      return c.json({ error: 'Paper not found' }, 404);
    }
    return c.json(paper);
  } catch (error) {
    return routeError(c, error, 'Failed to fetch paper');
  }
});

papersRouter.post('/', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { title, abstract, arxivId, doi, pdfUrl, publicationDate, venue, rawText, domain } =
      body ?? {};

    requireScopeOn(c, 'write', 'papers.create');

    if (!title || typeof title !== 'string' || !title.trim()) {
      return c.json({ error: 'Title is required' }, 400);
    }

    // Same strictness as /api/ingest: an unregistered domain string stored here
    // would be re-read by the processor and rejected there instead, after the row
    // already existed.
    const resolvedDomain = requireDomain(c, domain, 'papers.read').id;

    const [newPaper] = await db
      .insert(papers)
      .values({
        title,
        abstract,
        arxivId,
        doi,
        pdfUrl,
        publicationDate,
        venue,
        rawText,
        domain: resolvedDomain,
      })
      .returning();

    return c.json(newPaper, 201);
  } catch (error) {
    return routeError(c, error, 'Failed to create paper');
  }
});

papersRouter.post('/:id/process', async (c) => {
  try {
    requireScopeOn(c, 'write', 'papers.process');

    const id = c.req.param('id');
    if (!isUuid(id)) return c.json({ error: 'Paper not found' }, 404);

    const [paper] = await db.select().from(papers).where(eq(papers.id, id)).limit(1);
    if (!paper) {
      return c.json({ error: 'Paper not found' }, 404);
    }

    if (!paper.rawText) {
      return c.json(
        { error: 'Paper has no text content. Please ingest the PDF first.', paperId: id },
        400
      );
    }

    const alreadyContributed = paper.processed || paper.processingStatus === 'completed';

    await db
      .update(papers)
      .set({
        processed: false,
        processingStatus: 'pending',
        processingProgress: 0,
        processingError: null,
      })
      .where(eq(papers.id, id));

    // A durable row in the process lane; the handler always clears the paper's
    // previous contribution before extracting, so first-run and re-run are the
    // same idempotent operation and a mid-run restart resumes cleanly.
    const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await createJob(jobId, 'process', { paperId: id });

    return c.json(
      {
        message: alreadyContributed ? 'Reprocessing queued' : 'Processing queued',
        paperId: id,
        jobId,
        status: 'queued',
      },
      202
    );
  } catch (error) {
    return routeError(c, error, 'Failed to process paper');
  }
});
