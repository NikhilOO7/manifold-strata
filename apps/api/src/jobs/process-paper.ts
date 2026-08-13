/**
 * Process-lane handler: stored paper → knowledge graph (the GPU stage).
 *
 * Runs through `resumePaper`, which keeps every chunk that already completed
 * against unchanged text and clears only the claims of chunks it is about to
 * re-run. Clearing something is not optional — attempt one may have died after
 * writing edges for chunks 0–11, and re-running the plain path would duplicate
 * every one of them, silently doubling the paper's weight in PPR. The question
 * is only how much to clear, and the honest answer is "exactly what is being
 * redone". A 26-chunk paper that failed at chunk 24 used to discard 23 correct
 * extractions and spend fifteen minutes of GPU rediscovering them.
 *
 * `reprocessPaper` (clear everything, start at chunk 0) remains the right call
 * when the goal is genuinely to rebuild — a changed extractor or model — and is
 * exposed as `?rebuild=true` on the process route rather than being the default.
 */

import { eq } from 'drizzle-orm';
import { db } from '../db';
import { papers } from '../db/schema';
import { reprocessPaper, resumePaper, PausedError } from '../pipeline/processor';
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
        ? `Resuming extraction (claim ${job.attempts}) — completed chunks kept, the rest redone.`
        : 'Running extraction pipeline...',
  });

  // A rebuild is an explicit instruction, not what a retry silently does.
  const rebuild = (job.metadata as { rebuild?: boolean } | null)?.rebuild === true;

  try {
    const stats = rebuild ? await reprocessPaper(job.paperId) : await resumePaper(job.paperId);
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
    // A pause is an operator decision, not a fault. Failing the job would both
    // lie about what happened and burn a retry; the work is parked with its
    // checkpoint intact and resumes for free.
    if (err instanceof PausedError) {
      await setJobStatus(job.id, {
        status: 'paused',
        paperId: job.paperId,
        progress: `${err.message}. Resume to continue from the checkpoint.`,
      });
      return;
    }
    if (err instanceof UnknownDomainError) {
      throw new PermanentJobError(err.message, { cause: err });
    }
    throw err;
  }
}
