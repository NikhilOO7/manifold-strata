/**
 * Process-lane handler: stored paper → knowledge graph (the GPU stage).
 *
 * Always runs through `reprocessPaper`, which clears the paper's previous
 * contribution before extracting. That is what makes retries safe: attempt one
 * may have died after writing edges for chunks 0–11, and re-running the plain
 * path would duplicate every one of them — silently doubling the paper's weight
 * in PPR. Clearing first is a no-op on a fresh paper and a correctness
 * requirement on a resumed one.
 */

import { eq } from 'drizzle-orm';
import { db } from '../db';
import { papers } from '../db/schema';
import { reprocessPaper } from '../pipeline/processor';
import { UnknownDomainError } from '../domains';
import { setJobStatus, PermanentJobError, type Job } from '../queue';

export async function runProcessJob(job: Job): Promise<void> {
  if (!job.paperId) {
    throw new PermanentJobError(`Process job ${job.id} has no paperId.`);
  }

  const [paper] = await db.select().from(papers).where(eq(papers.id, job.paperId)).limit(1);
  if (!paper) {
    throw new PermanentJobError(`Paper ${job.paperId} no longer exists.`);
  }

  const structuredUnits = paper.structuredUnits as unknown[] | null;
  if (!paper.rawText && (!structuredUnits || structuredUnits.length === 0)) {
    throw new PermanentJobError(
      `Paper ${job.paperId} has neither raw text nor structured units — nothing to extract.`
    );
  }

  await setJobStatus(job.id, {
    status: 'processing',
    paperId: job.paperId,
    progress:
      job.attempts > 1
        ? `Resuming extraction (attempt ${job.attempts}) — previous partial contribution cleared first.`
        : 'Running extraction pipeline...',
  });

  try {
    const stats = await reprocessPaper(job.paperId);
    await setJobStatus(job.id, {
      status: 'completed',
      paperId: job.paperId,
      progress:
        `Processed ${stats.chunksProcessed} chunk(s): ` +
        `${stats.entitiesCreated} entities, ${stats.relationshipsCreated} relationships` +
        (stats.chunksFailed > 0 ? `, ${stats.chunksFailed} chunk(s) failed` : ''),
    });
  } catch (err) {
    // An unregistered stored domain cannot be fixed by retrying; a model outage
    // can. Everything else defaults to transient — the runner's attempt cap
    // bounds the damage, and for the GPU lane a wasted retry costs real time,
    // which is exactly why the permanent cases are called out.
    if (err instanceof UnknownDomainError) {
      throw new PermanentJobError(err.message, { cause: err });
    }
    throw err;
  }
}
