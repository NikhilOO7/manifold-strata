import { Hono } from 'hono';
import { db } from '../db';
import { papers } from '../db/schema';
import { eq, desc, inArray, sql } from 'drizzle-orm';
import { createJob } from '../queue';
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
        inArray(papers.processingStatus, [
          'pending',
          'downloading_pdf',
          'extracting_text',
          'chunking',
          'extracting_entities',
          'resolving_entities',
          'validating',
        ])
      )
      .orderBy(desc(papers.createdAt));

    return c.json({ papers: processingPapers });
  } catch (error) {
    return routeError(c, error, 'Failed to fetch processing papers');
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
