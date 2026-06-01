import { Hono } from 'hono';
import { db } from '../db';
import { papers } from '../db/schema';
import { eq, desc, inArray } from 'drizzle-orm';
import { processPaper } from '../pipeline/processor';
import { paperQueue, createJob, setJobStatus } from '../queue';

export const papersRouter = new Hono();

papersRouter.get('/', async (c) => {
  try {
    const limit = parseInt(c.req.query('limit') || '20');
    const offset = parseInt(c.req.query('offset') || '0');

    const allPapers = await db
      .select()
      .from(papers)
      .orderBy(desc(papers.createdAt))
      .limit(limit)
      .offset(offset);

    return c.json({
      papers: allPapers,
      pagination: { limit, offset },
    });
  } catch (error) {
    console.error('Error fetching papers:', error);
    return c.json({ error: 'Failed to fetch papers' }, 500);
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
          'validating'
        ])
      )
      .orderBy(desc(papers.createdAt));

    return c.json({ papers: processingPapers });
  } catch (error) {
    console.error('Error fetching processing papers:', error);
    return c.json({ error: 'Failed to fetch processing papers' }, 500);
  }
});

papersRouter.get('/:id', async (c) => {
  try {
    const id = c.req.param('id');

    const paper = await db
      .select()
      .from(papers)
      .where(eq(papers.id, id))
      .limit(1);

    if (!paper.length) {
      return c.json({ error: 'Paper not found' }, 404);
    }

    return c.json(paper[0]);
  } catch (error) {
    console.error('Error fetching paper:', error);
    return c.json({ error: 'Failed to fetch paper' }, 500);
  }
});

papersRouter.post('/', async (c) => {
  try {
    const body = await c.req.json();
    const { title, abstract, arxivId, doi, pdfUrl, publicationDate, venue, rawText } = body;

    if (!title) {
      return c.json({ error: 'Title is required' }, 400);
    }

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
      })
      .returning();

    return c.json(newPaper, 201);
  } catch (error) {
    console.error('Error creating paper:', error);
    return c.json({ error: 'Failed to create paper' }, 500);
  }
});

papersRouter.post('/:id/process', async (c) => {
  try {
    const id = c.req.param('id');

    const [paper] = await db
      .select()
      .from(papers)
      .where(eq(papers.id, id))
      .limit(1);

    if (!paper) {
      return c.json({ error: 'Paper not found' }, 404);
    }

    if (!paper.rawText) {
      return c.json({ 
        error: 'Paper has no text content. Please ingest the PDF first.',
        paperId: id 
      }, 400);
    }

    // Allow reprocessing if paper previously failed (no entities created)
    if (paper.processed) {
      console.log(`Paper already marked as processed. Allowing reprocessing...`);
    }

    console.log(`Starting processing for paper: ${paper.title}`);

    // Reset paper status before processing
    await db
      .update(papers)
      .set({
        processed: false,
        processingStatus: 'pending',
        processingProgress: 0
      })
      .where(eq(papers.id, id));

    // Enqueue on the background worker instead of blocking the request for
    // minutes. Progress is observable via /api/papers/processing and the job
    // status endpoint.
    const jobId = `job-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    await createJob(jobId, 'process', { status: 'queued', paperId: id });

    paperQueue.enqueue(async () => {
      try {
        await setJobStatus(jobId, { status: 'processing', paperId: id });
        await processPaper(id);
        await setJobStatus(jobId, { status: 'completed', paperId: id });
      } catch (err) {
        console.error('Error in processing pipeline:', err);
        await setJobStatus(jobId, {
          status: 'failed',
          paperId: id,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    });

    return c.json({
      message: 'Processing started',
      paperId: id,
      jobId,
      status: 'queued'
    }, 202);
  } catch (error) {
    console.error('Error processing paper:', error);
    return c.json({ 
      error: 'Failed to process paper',
      details: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});