import { Hono } from 'hono';
import { desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { papers, batches, jobs } from '../db/schema';
import { processPaper } from '../pipeline/processor';
import {
  createJob,
  getJob,
  pendingJobCount,
  MAX_PENDING_JOBS,
} from '../queue';
import { requireDomain, requireScopeOn } from '../middleware/auth';
import {
  getConnector,
  listConnectors,
  UnknownConnectorError,
  ConnectorInputError,
  ConnectorSourceError,
} from '../connectors';
import { routeError, isUuid } from './errors';

export const ingestRouter = new Hono();

/**
 * arXiv identifiers, both schemes:
 *   new style  2308.04079 / 2308.04079v2
 *   old style  cs/0112017 / math.GT/0309136v1
 *
 * The id is interpolated into two upstream URLs, so it is validated as a *format*
 * rather than merely trimmed — an unchecked value could otherwise inject query
 * parameters into the metadata request or path segments into the PDF URL.
 */
const ARXIV_ID_PATTERN = /^(\d{4}\.\d{4,5}(v\d+)?|[a-z-]+(\.[A-Z]{2})?\/\d{7}(v\d+)?)$/;

export function normalizeArxivId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // Trim before stripping the prefix: `^arxiv:` cannot match through leading
  // whitespace, so " arXiv:2308.04079" would otherwise survive as an invalid id.
  const cleaned = raw.trim().replace(/^arxiv:\s*/i, '').trim();
  return ARXIV_ID_PATTERN.test(cleaned) ? cleaned : null;
}

let jobCounter = 0;
function newJobId(): string {
  // Counter included because Date.now() has millisecond resolution and bulk
  // ingest creates rows in a tight loop; two jobs sharing an id would overwrite
  // each other's status rows.
  jobCounter = (jobCounter + 1) % 1_000_000;
  return `job-${Date.now()}-${jobCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Admission control.
 *
 * The queue is durable, which cuts both ways: nothing is ever silently lost, so
 * nothing stops a caller from piling up work either. Without a ceiling, a
 * scripted loop of bulk requests builds a backlog measured in GPU-days and every
 * later caller's batch quietly lands behind it. Refusing loudly at a bound —
 * with the current depth in the response — is the honest alternative.
 */
async function admit(c: Parameters<typeof routeError>[0], incoming: number) {
  const pending = await pendingJobCount();
  if (pending + incoming > MAX_PENDING_JOBS) {
    return c.json(
      {
        error: 'Queue is full',
        message:
          `Admitting ${incoming} job(s) would exceed the pending-work ceiling ` +
          `(${pending} pending, limit ${MAX_PENDING_JOBS}). Retry when the backlog drains, ` +
          'or raise MAX_PENDING_JOBS.',
        pending,
        limit: MAX_PENDING_JOBS,
      },
      429
    );
  }
  return null;
}

// --- Single-document ingest ---------------------------------------------------

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

    const resolvedDomain = requireDomain(c, domain, 'ingest.read').id;

    const existing = await db.select().from(papers).where(eq(papers.arxivId, arxivId)).limit(1);
    if (existing.length > 0) {
      return c.json(
        { error: 'Paper already exists', paperId: existing[0].id, status: 'duplicate' },
        409
      );
    }

    const full = await admit(c, 1);
    if (full) return full;

    // The route's entire job is this row. A worker — this instance or any other,
    // now or after a restart — claims and runs it. Nothing is held in memory.
    const jobId = newJobId();
    await createJob(jobId, 'ingest', {
      metadata: { arxivId, autoProcess, domain: resolvedDomain },
    });

    return c.json({ jobId, status: 'queued', domain: resolvedDomain }, 202);
  } catch (error) {
    return routeError(c, error, 'Failed to create ingestion job');
  }
});

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

// --- Batch ingest -------------------------------------------------------------

ingestRouter.post('/bulk', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { arxivIds, autoProcess = false, domain, note } = body ?? {};

    requireScopeOn(c, 'write', 'ingest.bulk');

    if (!Array.isArray(arxivIds) || arxivIds.length === 0) {
      return c.json({ error: 'arxivIds array is required' }, 400);
    }
    if (arxivIds.length > 100) {
      return c.json({ error: 'Maximum 100 papers per batch' }, 400);
    }

    const resolvedDomain = requireDomain(c, domain, 'ingest.read').id;

    // Validate the whole batch before creating any of it, so a single typo
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

    const unique = [...new Set(normalized)];
    // Each document may chain a process job, so a batch admits at up to 2× size.
    const full = await admit(c, unique.length * (autoProcess ? 2 : 1));
    if (full) return full;

    // Batch + jobs in one transaction: a batch that exists with half its jobs
    // missing would report completion forever.
    const { batch, queued } = await db.transaction(async (tx) => {
      const [batch] = await tx
        .insert(batches)
        .values({
          note: typeof note === 'string' ? note.slice(0, 500) : null,
          domain: resolvedDomain,
          total: unique.length,
        })
        .returning();

      const queued: { arxivId: string; jobId: string }[] = [];
      for (const arxivId of unique) {
        const jobId = newJobId();
        await tx.insert(jobs).values({
          id: jobId,
          type: 'ingest',
          status: 'queued',
          batchId: batch.id,
          metadata: { arxivId, autoProcess, domain: resolvedDomain } as never,
        });
        queued.push({ arxivId, jobId });
      }
      return { batch, queued };
    });

    return c.json(
      {
        message: `Queued ${queued.length} papers for ingestion`,
        batchId: batch.id,
        statusUrl: `/api/ingest/batches/${batch.id}`,
        domain: resolvedDomain,
        jobs: queued,
      },
      202
    );
  } catch (error) {
    return routeError(c, error, 'Failed to create bulk ingestion');
  }
});

/**
 * Batch progress, computed from the member jobs at read time — never from
 * counters, which drift. A batch is complete when every job (including chained
 * process jobs) is terminal.
 */
ingestRouter.get('/batches/:id', async (c) => {
  try {
    const id = c.req.param('id');
    if (!isUuid(id)) return c.json({ error: 'Batch not found' }, 404);

    const [batch] = await db.select().from(batches).where(eq(batches.id, id)).limit(1);
    if (!batch) return c.json({ error: 'Batch not found' }, 404);

    const members = await db
      .select({
        id: jobs.id,
        type: jobs.type,
        status: jobs.status,
        attempts: jobs.attempts,
        paperId: jobs.paperId,
        error: jobs.error,
        progress: jobs.progress,
        metadata: jobs.metadata,
        updatedAt: jobs.updatedAt,
      })
      .from(jobs)
      .where(eq(jobs.batchId, id))
      .orderBy(jobs.createdAt);

    const counts: Record<string, number> = {};
    for (const j of members) counts[j.status] = (counts[j.status] ?? 0) + 1;
    const terminal = (counts.completed ?? 0) + (counts.failed ?? 0);

    return c.json({
      batch,
      complete: members.length > 0 && terminal === members.length,
      counts,
      jobs: members.map((j) => ({
        ...j,
        arxivId: (j.metadata as { arxivId?: string } | null)?.arxivId,
        metadata: undefined,
      })),
    });
  } catch (error) {
    return routeError(c, error, 'Failed to fetch batch');
  }
});

ingestRouter.get('/batches', async (c) => {
  try {
    const recent = await db.select().from(batches).orderBy(desc(batches.createdAt)).limit(20);
    if (recent.length === 0) return c.json({ batches: [] });

    const rows = await db
      .select({ batchId: jobs.batchId, status: jobs.status, count: sql<number>`count(*)::int` })
      .from(jobs)
      .where(inArray(jobs.batchId, recent.map((b) => b.id)))
      .groupBy(jobs.batchId, jobs.status);

    const byBatch = new Map<string, Record<string, number>>();
    for (const r of rows) {
      if (!r.batchId) continue;
      const entry = byBatch.get(r.batchId) ?? {};
      entry[r.status] = r.count;
      byBatch.set(r.batchId, entry);
    }

    return c.json({
      batches: recent.map((b) => ({ ...b, counts: byBatch.get(b.id) ?? {} })),
    });
  } catch (error) {
    return routeError(c, error, 'Failed to list batches');
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
 * Structured connectors run inline: zero model calls, so the work is parsing and
 * inserts, and a caller who just imported an API surface would rather have the
 * result than a job id to poll. Unstructured documents with `autoProcess` go to
 * the process lane instead — they are minutes of GPU work and belong on the
 * durable queue like any other extraction.
 */
ingestRouter.post('/connector/:id', async (c) => {
  try {
    requireScopeOn(c, 'write', `ingest.connector.${c.req.param('id')}`);

    const connector = getConnector(c.req.param('id'));
    const body = await c.req.json().catch(() => ({}));
    const domain = requireDomain(c, body?.domain, 'ingest.connector').id;
    const autoProcess = body?.autoProcess !== false;

    const documents = await connector.collect(body ?? {}, { domainId: domain });

    const full = await admit(c, connector.structured ? 0 : documents.length);
    if (full) return full;

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

      if (autoProcess && connector.structured) {
        try {
          const stats = await processPaper(row.id);
          results.push({ documentId: row.id, title: doc.title, units: doc.units?.length ?? null, status: 'processed', stats });
        } catch (err) {
          results.push({
            documentId: row.id,
            title: doc.title,
            status: 'failed',
            error: err instanceof Error ? err.message : String(err),
          });
        }
        continue;
      }

      if (autoProcess) {
        const jobId = newJobId();
        await createJob(jobId, 'process', { paperId: row.id });
        results.push({ documentId: row.id, title: doc.title, status: 'queued', jobId });
        continue;
      }

      results.push({ documentId: row.id, title: doc.title, units: doc.units?.length ?? null, status: 'stored' });
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
