import { db } from '../db';
import { jobs } from '../db/schema';
import { eq, inArray } from 'drizzle-orm';
import { emitJob } from '../services/events';

/**
 * In-process background worker.
 *
 * Paper ingestion/processing is long-running (minutes of LLM calls) and must not
 * block the HTTP request that triggers it, nor run unbounded in parallel and
 * starve the event loop / hammer the local LLM. This is a small bounded-concurrency
 * queue: enqueue() returns immediately, tasks drain `JOB_CONCURRENCY` at a time.
 *
 * Job *status* is persisted to the `jobs` table (see helpers below) so it survives
 * restarts and is readable from any request handler — replacing the old in-memory
 * Map. For multi-instance deployments, swap this class for BullMQ + Redis: the
 * job-table contract and the route code stay identical.
 */

export type JobStatus =
  | 'queued'
  | 'fetching_metadata'
  | 'downloading_pdf'
  | 'extracting_text'
  | 'processing'
  | 'completed'
  | 'failed';

type Task = () => Promise<void>;

class JobQueue {
  private active = 0;
  private readonly pending: Task[] = [];

  constructor(private readonly concurrency: number) {}

  enqueue(task: Task): void {
    this.pending.push(task);
    this.drain();
  }

  private drain(): void {
    while (this.active < this.concurrency && this.pending.length > 0) {
      const task = this.pending.shift()!;
      this.active += 1;
      task()
        .catch((err) => console.error('[queue] task failed:', err))
        .finally(() => {
          this.active -= 1;
          this.drain();
        });
    }
  }
}

export const paperQueue = new JobQueue(parseInt(process.env.JOB_CONCURRENCY || '2'));

// --- Durable job-status helpers ---------------------------------------------

export async function createJob(
  id: string,
  type: 'ingest' | 'process',
  fields: { status?: JobStatus; paperId?: string; metadata?: unknown } = {}
): Promise<void> {
  const status = fields.status ?? 'queued';
  await db.insert(jobs).values({
    id,
    type,
    status,
    paperId: fields.paperId ?? null,
    metadata: (fields.metadata as any) ?? null,
  });
  emitJob({ jobId: id, status, paperId: fields.paperId ?? null });
}

export async function setJobStatus(
  id: string,
  fields: { status?: JobStatus; paperId?: string; progress?: string; error?: string }
): Promise<void> {
  await db
    .update(jobs)
    .set({ ...fields, updatedAt: new Date() })
    .where(eq(jobs.id, id));
  if (fields.status) {
    emitJob({
      jobId: id,
      status: fields.status,
      paperId: fields.paperId ?? null,
      progress: fields.progress ?? null,
      error: fields.error ?? null,
    });
  }
}

export async function getJob(id: string) {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  return job ?? null;
}

/**
 * Called once on startup. Any job still in a non-terminal state was interrupted
 * by the previous process exiting mid-run, so mark it failed rather than leaving
 * it stuck "processing" forever. The user can retry from the UI.
 */
export async function recoverOrphanedJobs(): Promise<number> {
  const orphaned = await db
    .update(jobs)
    .set({
      status: 'failed',
      error: 'Interrupted by server restart. Please retry.',
      updatedAt: new Date(),
    })
    .where(
      inArray(jobs.status, [
        'queued',
        'fetching_metadata',
        'downloading_pdf',
        'extracting_text',
        'processing',
      ])
    )
    .returning({ id: jobs.id });
  return orphaned.length;
}
