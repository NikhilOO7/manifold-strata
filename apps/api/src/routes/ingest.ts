import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { db } from '../db';
import { papers, authors, paperAuthors } from '../db/schema';
import { eq } from 'drizzle-orm';
import { fetchAndExtractPDF } from '../services/pdf';
import { processPaper } from '../pipeline/processor';
import { paperQueue, createJob, setJobStatus, getJob } from '../queue';
import { onEvent } from '../services/events';
import { getDomain } from '../domains';

export const ingestRouter = new Hono();

// --- Live status stream (SSE) -----------------------------------------------
// Replaces client polling: the browser opens ONE EventSource and receives job /
// paper-progress events as they happen. Idle connections cost nothing (no DB
// hits) and a periodic ping keeps the connection alive through proxies.
ingestRouter.get('/stream', (c) => {
  return streamSSE(c, async (stream) => {
    let open = true;
    stream.onAbort(() => {
      open = false;
    });

    const unsubscribe = onEvent((event) => {
      stream.writeSSE({ event: event.type, data: JSON.stringify(event) }).catch(() => {
        // client went away mid-write; cleanup happens in finally
      });
    });

    try {
      await stream.writeSSE({ event: 'ready', data: '{}' });
      while (open) {
        await stream.sleep(15_000);
        if (!open) break;
        await stream.writeSSE({ event: 'ping', data: JSON.stringify({ at: new Date().toISOString() }) });
      }
    } finally {
      unsubscribe();
    }
  });
});

interface ArxivMetadata {
  title: string;
  abstract: string;
  authors: string[];
  published: string;
  pdfUrl: string;
}

async function fetchArxivMetadata(arxivId: string): Promise<ArxivMetadata> {
  const cleanId = arxivId.replace('arXiv:', '').trim();
  const apiUrl = `https://export.arxiv.org/api/query?id_list=${cleanId}`;
  
  const response = await fetch(apiUrl);
  if (!response.ok) {
    throw new Error(`arXiv API request failed: ${response.statusText}`);
  }
  
  const xmlText = await response.text();
  
  const titleMatch = xmlText.match(/<title>([^<]+)<\/title>/g);
  const title = titleMatch && titleMatch.length > 1 
    ? titleMatch[1].replace(/<\/?title>/g, '').trim()
    : `Paper ${cleanId}`;
  
  const summaryMatch = xmlText.match(/<summary>([^]*?)<\/summary>/);
  const abstract = summaryMatch 
    ? summaryMatch[1].trim().replace(/\s+/g, ' ')
    : '';
  
  const authorMatches = xmlText.matchAll(/<author>\s*<name>([^<]+)<\/name>/g);
  const authorsList: string[] = [];
  for (const match of authorMatches) {
    authorsList.push(match[1].trim());
  }
  
  const publishedMatch = xmlText.match(/<published>([^<]+)<\/published>/);
  const published = publishedMatch ? publishedMatch[1].split('T')[0] : '';
  
  return {
    title: title.replace(/\n/g, ' ').trim(),
    abstract,
    authors: authorsList,
    published,
    pdfUrl: `https://arxiv.org/pdf/${cleanId}.pdf`,
  };
}

ingestRouter.post('/arxiv', async (c) => {
  try {
    const body = await c.req.json();
    const { arxivId, autoProcess = false, domain } = body;

    if (!arxivId) {
      return c.json({ error: 'arxivId is required' }, 400);
    }

    const cleanId = arxivId.replace('arXiv:', '').trim();

    const existing = await db
      .select()
      .from(papers)
      .where(eq(papers.arxivId, cleanId))
      .limit(1);

    if (existing.length > 0) {
      return c.json({
        error: 'Paper already exists',
        paperId: existing[0].id,
        status: 'duplicate'
      }, 409);
    }

    const jobId = `job-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    await createJob(jobId, 'ingest', { metadata: { arxivId: cleanId, autoProcess, domain } });

    paperQueue.enqueue(() => processArxivPaper(jobId, cleanId, autoProcess, domain));

    return c.json({ jobId, status: 'queued' }, 202);
  } catch (error) {
    console.error('Error creating ingestion job:', error);
    return c.json({ error: 'Failed to create ingestion job' }, 500);
  }
});

async function processArxivPaper(jobId: string, arxivId: string, autoProcess: boolean, domain?: string) {
  try {
    await setJobStatus(jobId, { status: 'fetching_metadata', progress: 'Fetching paper metadata from arXiv...' });
    
    const metadata = await fetchArxivMetadata(arxivId);
    console.log(`Fetched metadata for: ${metadata.title}`);

    await setJobStatus(jobId, { status: 'downloading_pdf', progress: 'Downloading PDF...' });
    
    let rawText = '';
    try {
      const pdfContent = await fetchAndExtractPDF(metadata.pdfUrl);
      rawText = pdfContent.text;
      console.log(`Extracted ${rawText.length} characters from PDF`);
    } catch (pdfError) {
      console.warn(`Failed to extract PDF, continuing without text: ${pdfError}`);
    }

    await setJobStatus(jobId, { status: 'extracting_text', progress: 'Saving to database...' });

    const [paper] = await db
      .insert(papers)
      .values({
        title: metadata.title,
        abstract: metadata.abstract,
        arxivId: arxivId,
        pdfUrl: metadata.pdfUrl,
        publicationDate: metadata.published || null,
        rawText: rawText || null,
        domain: domain || null,
        processed: false,
      })
      .returning();

    if (metadata.authors.length > 0) {
      for (let i = 0; i < metadata.authors.length; i++) {
        const authorName = metadata.authors[i];
        const normalizedName = authorName.toLowerCase().trim();

        let [author] = await db
          .select()
          .from(authors)
          .where(eq(authors.normalizedName, normalizedName))
          .limit(1);

        if (!author) {
          [author] = await db
            .insert(authors)
            .values({
              name: authorName,
              normalizedName: normalizedName,
            })
            .returning();
        }

        await db
          .insert(paperAuthors)
          .values({
            paperId: paper.id,
            authorId: author.id,
            position: i + 1,
            isCorresponding: i === 0,
          })
          .onConflictDoNothing();
      }
    }

    if (autoProcess && rawText) {
      await setJobStatus(jobId, { status: 'processing', progress: 'Running AI extraction pipeline...', paperId: paper.id });
      
      try {
        await processPaper(paper.id);
        await setJobStatus(jobId, { status: 'completed', paperId: paper.id });
      } catch (processError) {
        console.error('Error in processing pipeline:', processError);
        await setJobStatus(jobId, {
          status: 'completed',
          paperId: paper.id,
          progress: 'Paper saved but processing failed. You can retry processing later.'
        });
      }
    } else {
      await setJobStatus(jobId, { status: 'completed', paperId: paper.id });
    }

    console.log(`Successfully ingested paper: ${metadata.title}`);
  } catch (error) {
    console.error('Error ingesting paper:', error);
    await setJobStatus(jobId, {
      status: 'failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

ingestRouter.get('/status/:jobId', async (c) => {
  try {
    const jobId = c.req.param('jobId');
    const status = await getJob(jobId);

    if (!status) {
      return c.json({ error: 'Job not found' }, 404);
    }

    return c.json(status);
  } catch (error) {
    console.error('Error fetching job status:', error);
    return c.json({ error: 'Failed to fetch job status' }, 500);
  }
});

ingestRouter.post('/bulk', async (c) => {
  try {
    const body = await c.req.json();
    const { arxivIds, autoProcess = false, domain } = body;

    if (!arxivIds || !Array.isArray(arxivIds) || arxivIds.length === 0) {
      return c.json({ error: 'arxivIds array is required' }, 400);
    }

    if (arxivIds.length > 100) {
      return c.json({ error: 'Maximum 100 papers per batch' }, 400);
    }

    const queued: { arxivId: string; jobId: string }[] = [];

    for (const arxivId of arxivIds) {
      const cleanId = arxivId.replace('arXiv:', '').trim();
      if (!cleanId) continue;

      const jobId = `job-${Date.now()}-${Math.random().toString(36).substring(7)}-${queued.length}`;
      await createJob(jobId, 'ingest', { metadata: { arxivId: cleanId, autoProcess, domain } });
      paperQueue.enqueue(() => processArxivPaper(jobId, cleanId, autoProcess, domain));

      queued.push({ arxivId: cleanId, jobId });
    }

    return c.json({
      message: `Queued ${queued.length} papers for ingestion`,
      jobs: queued.map((j) => ({ arxivId: j.arxivId, jobId: j.jobId })),
    }, 202);
  } catch (error) {
    console.error('Error creating bulk ingestion:', error);
    return c.json({ error: 'Failed to create bulk ingestion' }, 500);
  }
});

// Generic seed endpoint — reads the curated arXiv ids from the domain registry.
ingestRouter.get('/seed/:domain', async (c) => {
  const domainId = c.req.param('domain');
  const domain = getDomain(domainId);
  const seedPapers = domain.seedPaperIds ?? [];

  return c.json({
    domain: domain.id,
    message: `Seed paper IDs for the "${domain.name}" domain`,
    description: 'POST these IDs to /api/ingest/bulk (with the same domain) to ingest them',
    arxivIds: seedPapers,
    count: seedPapers.length,
    example: {
      endpoint: 'POST /api/ingest/bulk',
      body: { arxivIds: seedPapers.slice(0, 5), autoProcess: true, domain: domain.id },
    },
  });
});
