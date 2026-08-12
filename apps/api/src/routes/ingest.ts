import { Hono } from 'hono';
import { db } from '../db';
import { papers, authors, paperAuthors } from '../db/schema';
import { eq } from 'drizzle-orm';
import { fetchAndExtractPDF } from '../services/pdf';
import { TIMEOUTS } from '../services/http';
import { politeFetch } from '../services/polite-fetch';
import { processPaper } from '../pipeline/processor';
import { paperQueue, createJob, setJobStatus, getJob } from '../queue';
import { requireDomain, requireScopeOn } from '../middleware/auth';
import { getConnector, listConnectors, UnknownConnectorError, ConnectorInputError, ConnectorSourceError } from '../connectors';
import { routeError } from './errors';

export const ingestRouter = new Hono();

interface ArxivMetadata {
  title: string;
  abstract: string;
  authors: string[];
  published: string;
  pdfUrl: string;
}

/**
 * arXiv identifiers, both schemes:
 *   new style  2308.04079 / 2308.04079v2
 *   old style  cs/0112017 / math.GT/0309136v1
 *
 * The id is interpolated into two upstream URLs, so it is validated as a *format*
 * rather than merely trimmed — an unchecked value could otherwise inject query
 * parameters into the metadata request or path segments into the PDF URL. It also
 * turns a typo into a 400 at the edge instead of a confusing failure three
 * network calls deep.
 */
const ARXIV_ID_PATTERN = /^(\d{4}\.\d{4,5}(v\d+)?|[a-z-]+(\.[A-Z]{2})?\/\d{7}(v\d+)?)$/;

export function normalizeArxivId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // Trim before stripping the prefix: `^arxiv:` cannot match through leading
  // whitespace, so " arXiv:2308.04079" would otherwise survive as an invalid id.
  const cleaned = raw.trim().replace(/^arxiv:\s*/i, '').trim();
  return ARXIV_ID_PATTERN.test(cleaned) ? cleaned : null;
}

async function fetchArxivMetadata(arxivId: string): Promise<ArxivMetadata> {
  const apiUrl = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}`;

  // Throttled and retried: arXiv asks for a gap between requests, and bulk
  // ingest would otherwise open `JOB_CONCURRENCY` lookups simultaneously and
  // convert its own impatience into a wall of failed jobs.
  const response = await politeFetch(
    apiUrl,
    {
      headers: {
        Accept: 'application/atom+xml',
        // arXiv's API guidelines ask clients to identify themselves, and
        // anonymous callers are throttled far more aggressively. The PDF fetch
        // has always sent one; the metadata call did not, which is a large part
        // of why bulk ingest kept earning 429s.
        'User-Agent': process.env.ARXIV_USER_AGENT || 'Manifold/1.0 (knowledge-graph ingestion)',
      },
    },
    { timeoutMs: TIMEOUTS.metadata, label: 'arXiv API' }
  );
  if (!response.ok) {
    if (response.status === 429) {
      throw new Error(
        'arXiv is rate-limiting this client and did not relent after several retries. ' +
          'Reduce JOB_CONCURRENCY or raise ARXIV_MIN_INTERVAL_MS, then retry.'
      );
    }
    throw new Error(`arXiv API request failed: ${response.status} ${response.statusText}`);
  }

  const xmlText = await response.text();

  const titleMatch = xmlText.match(/<title>([^<]+)<\/title>/g);
  // [0] is the feed title, [1] is the entry title.
  const title =
    titleMatch && titleMatch.length > 1
      ? titleMatch[1].replace(/<\/?title>/g, '').trim()
      : `Paper ${arxivId}`;

  const summaryMatch = xmlText.match(/<summary>([^]*?)<\/summary>/);
  const abstract = summaryMatch ? summaryMatch[1].trim().replace(/\s+/g, ' ') : '';

  // arXiv answers an unknown id with HTTP 200 and an entry literally titled
  // "Error". Without this check the corpus silently gains a paper called "Error"
  // whose "abstract" is the API's complaint.
  if (/^error$/i.test(title)) {
    throw new Error(
      `arXiv has no paper "${arxivId}"${abstract ? ` (${abstract.slice(0, 200)})` : ''}`
    );
  }

  const authorMatches = xmlText.matchAll(/<author>\s*<name>([^<]+)<\/name>/g);
  const authorsList: string[] = [];
  for (const match of authorMatches) {
    authorsList.push(match[1].trim());
  }

  const publishedMatch = xmlText.match(/<published>([^<]+)<\/published>/);
  const published = publishedMatch ? publishedMatch[1].split('T')[0] : '';

  return {
    title: title.replace(/\s+/g, ' ').trim(),
    abstract,
    authors: authorsList,
    published,
    pdfUrl: `https://arxiv.org/pdf/${encodeURIComponent(arxivId)}.pdf`,
  };
}

/**
 * Postgres unique-violation, i.e. the paper already exists.
 *
 * The driver error is wrapped by Drizzle, so the SQLSTATE lives on `cause`, not
 * on the object thrown. Checking only the top level meant every duplicate ingest
 * surfaced as an unhandled `DrizzleQueryError` with the whole INSERT statement in
 * the log, instead of the "already exists" the code was written to report.
 */
function isUniqueViolation(err: unknown): boolean {
  for (let current = err, depth = 0; current && depth < 5; depth++) {
    if (typeof current === 'object' && (current as { code?: string }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

ingestRouter.post('/arxiv', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { autoProcess = false, domain } = body ?? {};

    requireScopeOn(c, 'write', 'ingest.arxiv');

    const arxivId = normalizeArxivId(body?.arxivId);
    if (!arxivId) {
      return c.json(
        {
          error: 'A valid arxivId is required',
          message: 'Expected e.g. "2308.04079", "2308.04079v2", or "cs/0112017".',
        },
        400
      );
    }

    // Resolved (and persisted) rather than passed through raw: storing an
    // unregistered string here is what let a paper claim one domain while its
    // extracted entities were stamped with another.
    const resolvedDomain = requireDomain(c, domain, 'ingest.read').id;

    const existing = await db.select().from(papers).where(eq(papers.arxivId, arxivId)).limit(1);
    if (existing.length > 0) {
      return c.json(
        { error: 'Paper already exists', paperId: existing[0].id, status: 'duplicate' },
        409
      );
    }

    const jobId = newJobId();
    await createJob(jobId, 'ingest', {
      metadata: { arxivId, autoProcess, domain: resolvedDomain },
    });

    paperQueue.enqueue(jobId, () => processArxivPaper(jobId, arxivId, autoProcess, resolvedDomain));

    return c.json({ jobId, status: 'queued', domain: resolvedDomain }, 202);
  } catch (error) {
    return routeError(c, error, 'Failed to create ingestion job');
  }
});

let jobCounter = 0;
function newJobId(): string {
  // Counter included because Date.now() has millisecond resolution and bulk
  // ingest enqueues in a tight loop; two jobs sharing an id would overwrite each
  // other's status rows.
  jobCounter = (jobCounter + 1) % 1_000_000;
  return `job-${Date.now()}-${jobCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

async function processArxivPaper(
  jobId: string,
  arxivId: string,
  autoProcess: boolean,
  domainId: string
) {
  try {
    await setJobStatus(jobId, {
      status: 'fetching_metadata',
      progress: 'Fetching paper metadata from arXiv...',
    });

    const metadata = await fetchArxivMetadata(arxivId);
    console.log(`Fetched metadata for: ${metadata.title}`);

    await setJobStatus(jobId, { status: 'downloading_pdf', progress: 'Downloading PDF...' });

    let rawText = '';
    let pdfError: string | null = null;
    try {
      const pdfContent = await fetchAndExtractPDF(metadata.pdfUrl);
      rawText = pdfContent.text;
      console.log(`Extracted ${rawText.length} characters from PDF`);
    } catch (err) {
      pdfError = err instanceof Error ? err.message : String(err);
      console.warn(`Failed to extract PDF, continuing with metadata only: ${pdfError}`);
    }

    await setJobStatus(jobId, { status: 'extracting_text', progress: 'Saving to database...' });

    let paper: typeof papers.$inferSelect;
    try {
      [paper] = await db
        .insert(papers)
        .values({
          title: metadata.title,
          abstract: metadata.abstract,
          arxivId,
          pdfUrl: metadata.pdfUrl,
          publicationDate: metadata.published || null,
          rawText: rawText || null,
          domain: domainId,
          processed: false,
        })
        .returning();
    } catch (err) {
      // The pre-flight duplicate check in the route is advisory only — two
      // concurrent ingests of the same id both pass it. The unique index is the
      // real guard; report the race as the duplicate it is, not a 500.
      if (isUniqueViolation(err)) {
        await setJobStatus(jobId, {
          status: 'failed',
          error: `Paper ${arxivId} was ingested concurrently by another request.`,
        });
        return;
      }
      throw err;
    }

    await linkAuthors(paper.id, metadata.authors);

    if (!autoProcess) {
      await setJobStatus(jobId, {
        status: 'completed',
        paperId: paper.id,
        progress: pdfError
          ? `Saved without full text (${pdfError}). Extraction pipeline not run.`
          : 'Saved. Run POST /api/papers/:id/process to extract the graph.',
      });
      return;
    }

    if (!rawText) {
      // autoProcess was requested but there is nothing to process. Saying
      // "completed" here would claim a graph was built from a paper we never read.
      await setJobStatus(jobId, {
        status: 'failed',
        paperId: paper.id,
        error: `Paper saved, but its text could not be extracted, so the pipeline did not run: ${
          pdfError ?? 'no text in PDF'
        }`,
      });
      return;
    }

    await setJobStatus(jobId, {
      status: 'processing',
      progress: 'Running extraction pipeline...',
      paperId: paper.id,
    });

    try {
      const stats = await processPaper(paper.id);
      await setJobStatus(jobId, {
        status: 'completed',
        paperId: paper.id,
        progress:
          `Processed ${stats.chunksProcessed} chunk(s): ` +
          `${stats.entitiesCreated} entities, ${stats.relationshipsCreated} relationships` +
          (stats.chunksFailed > 0 ? `, ${stats.chunksFailed} chunk(s) failed` : ''),
      });
    } catch (processError) {
      // Previously this set status 'completed' with a note in `progress`, so a
      // failed pipeline reported success to every poller and to the UI.
      console.error('Error in processing pipeline:', processError);
      await setJobStatus(jobId, {
        status: 'failed',
        paperId: paper.id,
        error: `Paper saved, but processing failed: ${
          processError instanceof Error ? processError.message : String(processError)
        }`,
      });
    }
  } catch (error) {
    console.error('Error ingesting paper:', error);
    await setJobStatus(jobId, {
      status: 'failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

async function linkAuthors(paperId: string, authorNames: string[]): Promise<void> {
  for (let i = 0; i < authorNames.length; i++) {
    const authorName = authorNames[i];
    const normalizedName = authorName.toLowerCase().trim();
    if (!normalizedName) continue;

    let [author] = await db
      .select()
      .from(authors)
      .where(eq(authors.normalizedName, normalizedName))
      .limit(1);

    if (!author) {
      try {
        [author] = await db
          .insert(authors)
          .values({ name: authorName, normalizedName })
          .returning();
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        [author] = await db
          .select()
          .from(authors)
          .where(eq(authors.normalizedName, normalizedName))
          .limit(1);
      }
    }

    if (!author) continue;

    await db
      .insert(paperAuthors)
      .values({
        paperId,
        authorId: author.id,
        position: i + 1,
        isCorresponding: i === 0,
      })
      .onConflictDoNothing();
  }
}

ingestRouter.get('/status/:jobId', async (c) => {
  try {
    const status = await getJob(c.req.param('jobId'));
    if (!status) {
      return c.json({ error: 'Job not found' }, 404);
    }
    return c.json(status);
  } catch (error) {
    return routeError(c, error, 'Failed to fetch job status');
  }
});

ingestRouter.post('/bulk', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { arxivIds, autoProcess = false, domain } = body ?? {};

    requireScopeOn(c, 'write', 'ingest.bulk');

    if (!Array.isArray(arxivIds) || arxivIds.length === 0) {
      return c.json({ error: 'arxivIds array is required' }, 400);
    }
    if (arxivIds.length > 100) {
      return c.json({ error: 'Maximum 100 papers per batch' }, 400);
    }

    const resolvedDomain = requireDomain(c, domain, 'ingest.read').id;

    // Validate the whole batch before enqueueing any of it, so a single typo
    // can't leave half a batch queued and half rejected.
    const normalized: string[] = [];
    const invalid: unknown[] = [];
    for (const raw of arxivIds) {
      const id = normalizeArxivId(raw);
      if (id) normalized.push(id);
      else invalid.push(raw);
    }

    if (invalid.length > 0) {
      return c.json(
        {
          error: 'Invalid arXiv id(s)',
          message: 'Expected e.g. "2308.04079", "2308.04079v2", or "cs/0112017".',
          invalid,
        },
        400
      );
    }

    const queued: { arxivId: string; jobId: string }[] = [];
    for (const arxivId of [...new Set(normalized)]) {
      const jobId = newJobId();
      await createJob(jobId, 'ingest', {
        metadata: { arxivId, autoProcess, domain: resolvedDomain },
      });
      paperQueue.enqueue(jobId, () => processArxivPaper(jobId, arxivId, autoProcess, resolvedDomain));
      queued.push({ arxivId, jobId });
    }

    return c.json(
      {
        message: `Queued ${queued.length} papers for ingestion`,
        domain: resolvedDomain,
        jobs: queued,
      },
      202
    );
  } catch (error) {
    return routeError(c, error, 'Failed to create bulk ingestion');
  }
});

// Generic seed endpoint — reads the curated arXiv ids from the domain registry.
ingestRouter.get('/seed/:domain', async (c) => {
  try {
    // Strict: `GET /api/ingest/seed/nlpp` used to answer with the *default*
    // domain's seeds under the requested name.
    const domain = requireDomain(c, c.req.param('domain'), 'ingest.read');
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
  } catch (error) {
    return routeError(c, error, 'Failed to fetch seed papers');
  }
});

// --- Generic connector ingestion --------------------------------------------

/** What sources this instance can read, and what each expects. */
ingestRouter.get('/connectors', (c) => {
  return c.json({
    connectors: listConnectors().map((conn) => ({
      id: conn.id,
      name: conn.name,
      description: conn.description,
      input: conn.inputSchema,
      structured: conn.structured,
      llmCallsPerDocument: conn.structured ? 0 : 'one per chunk',
    })),
  });
});

/**
 * Ingest from any registered connector.
 *
 * Structured connectors run inline rather than on the background worker: they
 * make no model calls, so the work is parsing and inserts, and a caller who just
 * imported an API surface would rather have the result than a job id to poll.
 * Unstructured sources still go through the queue, because they are minutes of
 * model calls.
 */
ingestRouter.post('/connector/:id', async (c) => {
  try {
    requireScopeOn(c, 'write', `ingest.connector.${c.req.param('id')}`);

    const connector = getConnector(c.req.param('id'));
    const body = await c.req.json().catch(() => ({}));
    const domain = requireDomain(c, body?.domain, 'ingest.connector').id;
    const autoProcess = body?.autoProcess !== false;

    const documents = await connector.collect(body ?? {}, { domainId: domain });
    const results: Array<Record<string, unknown>> = [];

    for (const doc of documents) {
      const [row] = await db
        .insert(papers)
        .values({
          title: doc.title,
          abstract: doc.summary ?? null,
          pdfUrl: doc.url ?? null,
          publicationDate: doc.publishedAt ?? null,
          rawText: doc.rawText ?? null,
          structuredUnits: (doc.units ?? null) as never,
          connector: connector.id,
          domain,
          processed: false,
        })
        .returning();

      let stats = null;
      if (autoProcess) {
        try {
          stats = await processPaper(row.id);
        } catch (err) {
          results.push({
            documentId: row.id,
            title: doc.title,
            status: 'failed',
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
      }

      results.push({
        documentId: row.id,
        title: doc.title,
        units: doc.units?.length ?? null,
        status: autoProcess ? 'processed' : 'stored',
        stats,
      });
    }

    return c.json(
      {
        connector: connector.id,
        domain,
        llmCalls: connector.structured ? 0 : undefined,
        documents: results,
      },
      201
    );
  } catch (error) {
    if (error instanceof UnknownConnectorError) {
      return c.json(
        { error: 'Unknown connector', message: error.message, available: error.known },
        400
      );
    }
    if (error instanceof ConnectorInputError) {
      return c.json({ error: 'Invalid connector input', message: error.message }, 400);
    }
    if (error instanceof ConnectorSourceError) {
      return c.json({ error: 'Could not read the source', message: error.message }, 422);
    }
    return routeError(c, error, 'Connector ingestion failed');
  }
});
