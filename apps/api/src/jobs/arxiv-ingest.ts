/**
 * Ingest-lane handler: arXiv id → stored paper (network + CPU, no GPU).
 *
 * Moved out of the HTTP route because the route no longer runs anything — it
 * inserts a durable job row and returns. This handler is what a worker executes
 * after claiming that row, possibly on a different instance, possibly after a
 * restart, possibly on attempt three.
 *
 * The retry contract is the point of the file:
 *
 *   throw plain Error          transient (network, arXiv throttling us even
 *                              after politeFetch's patience) → the runner
 *                              re-queues until MAX_JOB_ATTEMPTS
 *   throw PermanentJobError    retrying cannot change the answer (arXiv has no
 *                              such paper; a concurrent request already ingested
 *                              it; the PDF has no text to process) → failed now,
 *                              no attempts burned
 *
 * The old inline version caught everything and marked the job failed itself,
 * which made every transient network blip terminal. Here failure *classification*
 * is the handler's job and failure *disposition* is the runner's.
 */

import { eq } from 'drizzle-orm';
import { db } from '../db';
import { papers, authors, paperAuthors } from '../db/schema';
import { TIMEOUTS } from '../services/http';
import { politeFetch } from '../services/polite-fetch';
import { fetchAndExtractPDF } from '../services/pdf';
import { setJobStatus, createJob, PermanentJobError, type Job } from '../queue';

interface ArxivMetadata {
  title: string;
  abstract: string;
  authors: string[];
  published: string;
  pdfUrl: string;
}

export async function fetchArxivMetadata(arxivId: string): Promise<ArxivMetadata> {
  const apiUrl = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}`;

  const response = await politeFetch(
    apiUrl,
    {
      headers: {
        Accept: 'application/atom+xml',
        // arXiv throttles anonymous callers far more aggressively; identify
        // ourselves as their API guidelines ask.
        'User-Agent': process.env.ARXIV_USER_AGENT || 'Manifold/1.0 (knowledge-graph ingestion)',
      },
    },
    { timeoutMs: TIMEOUTS.metadata, label: 'arXiv API' }
  );
  if (!response.ok) {
    if (response.status === 429) {
      // politeFetch already backed off host-wide and retried; still throttled.
      // Transient by nature — the queue's own retry (with the job re-queued and
      // picked up minutes later) is exactly the right medicine.
      throw new Error(
        'arXiv is rate-limiting this client. The job will be retried; reduce ' +
          'FETCH_CONCURRENCY or raise ARXIV_MIN_INTERVAL_MS if this persists.'
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
  // "Error" — without this the corpus gains a paper called "Error".
  if (/^error$/i.test(title)) {
    throw new PermanentJobError(
      `arXiv has no paper "${arxivId}"${abstract ? ` (${abstract.slice(0, 200)})` : ''}`
    );
  }

  const authorsList: string[] = [];
  for (const match of xmlText.matchAll(/<author>\s*<name>([^<]+)<\/name>/g)) {
    authorsList.push(match[1].trim());
  }

  const publishedMatch = xmlText.match(/<published>([^<]+)<\/published>/);

  return {
    title: title.replace(/\s+/g, ' ').trim(),
    abstract,
    authors: authorsList,
    published: publishedMatch ? publishedMatch[1].split('T')[0] : '',
    pdfUrl: `https://arxiv.org/pdf/${encodeURIComponent(arxivId)}.pdf`,
  };
}

/** Postgres unique violation, wherever Drizzle buried it in the cause chain. */
function isUniqueViolation(err: unknown): boolean {
  for (let current = err, depth = 0; current && depth < 5; depth++) {
    if (typeof current === 'object' && (current as { code?: string }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
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
        [author] = await db.insert(authors).values({ name: authorName, normalizedName }).returning();
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
      .values({ paperId, authorId: author.id, position: i + 1, isCorresponding: i === 0 })
      .onConflictDoNothing();
  }
}

interface IngestMetadata {
  arxivId?: string;
  autoProcess?: boolean;
  domain?: string;
}

export async function runArxivIngestJob(job: Job): Promise<void> {
  const meta = (job.metadata ?? {}) as IngestMetadata;
  const { arxivId, autoProcess = false, domain } = meta;

  if (!arxivId || !domain) {
    throw new PermanentJobError(
      `Job ${job.id} has malformed metadata (arxivId/domain missing) — nothing to ingest.`
    );
  }

  // Retried job for a paper we already stored? Idempotency check first, so a
  // crash between the insert and the terminal status update does not create a
  // duplicate-key failure on the retry.
  const [existing] = await db.select().from(papers).where(eq(papers.arxivId, arxivId)).limit(1);
  if (existing && job.attempts > 1) {
    await finishIngest(job, existing.id, existing.rawText, autoProcess, null);
    return;
  }
  if (existing) {
    throw new PermanentJobError(`Paper ${arxivId} already exists (${existing.id}).`);
  }

  await setJobStatus(job.id, {
    status: 'fetching_metadata',
    progress: 'Fetching paper metadata from arXiv...',
  });

  const metadata = await fetchArxivMetadata(arxivId);
  console.log(`Fetched metadata for: ${metadata.title}`);

  await setJobStatus(job.id, { status: 'downloading_pdf', progress: 'Downloading PDF...' });

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

  await setJobStatus(job.id, { status: 'extracting_text', progress: 'Saving to database...' });

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
        domain,
        processed: false,
      })
      .returning();
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new PermanentJobError(`Paper ${arxivId} was ingested concurrently by another request.`);
    }
    throw err;
  }

  await linkAuthors(paper.id, metadata.authors);
  await finishIngest(job, paper.id, rawText || null, autoProcess, pdfError);
}

/**
 * Terminal bookkeeping, shared with the retry-idempotency path: either chain a
 * process-lane job or complete/fail with an honest message.
 */
async function finishIngest(
  job: Job,
  paperId: string,
  rawText: string | null,
  autoProcess: boolean,
  pdfError: string | null
): Promise<void> {
  if (!autoProcess) {
    await setJobStatus(job.id, {
      status: 'completed',
      paperId,
      progress: pdfError
        ? `Saved without full text (${pdfError}). Extraction pipeline not run.`
        : 'Saved. Run POST /api/papers/:id/process to extract the graph.',
    });
    return;
  }

  if (!rawText) {
    // autoProcess with nothing to process — "completed" would claim a graph was
    // built from a paper we never read. Record the paper on the job first so the
    // batch view can still link to what was saved.
    await setJobStatus(job.id, { paperId });
    throw new PermanentJobError(
      `Paper saved, but its text could not be extracted, so the pipeline did not run: ${
        pdfError ?? 'no text in PDF'
      }`
    );
  }

  // Chain the GPU stage as its OWN durable job in the process lane, inheriting
  // the batch. This is the stage separation: this worker is immediately free to
  // fetch the next document while extraction queues for the GPU, and a restart
  // between the two stages loses nothing — the fetched text is on disk and the
  // process job is a row.
  const processJobId = `job-${Date.now()}-p-${Math.random().toString(36).slice(2, 8)}`;
  await createJob(processJobId, 'process', {
    paperId,
    batchId: job.batchId ?? undefined,
    metadata: { chainedFrom: job.id },
  });

  await setJobStatus(job.id, {
    status: 'completed',
    paperId,
    progress: `Saved; extraction queued as ${processJobId}.`,
  });
}
