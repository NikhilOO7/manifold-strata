import { hostname } from 'node:os';
import { db } from '../db';
import { jobs, papers } from '../db/schema';
import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';

/**
 * In-process background worker.
 *
 * Paper ingestion/processing is long-running (minutes of LLM calls) and must not
 * block the HTTP request that triggers it, nor run unbounded in parallel and
 * starve the event loop / hammer the local LLM. This is a small bounded-concurrency
 * queue: enqueue() returns immediately, tasks drain `JOB_CONCURRENCY` at a time.
 *
 * Job *status* is persisted to the `jobs` table so it survives restarts and is
 * readable from any request handler. Because the queue itself is in-memory, a
 * job belongs to the instance that accepted it: no other process can run it, and
 * no other process may declare it dead while its owner is alive. Ownership plus a
 * renewed lease is what encodes that. For a shared queue (BullMQ + Redis) the
 * route code stays identical and this file becomes the adapter.
 */

export type JobStatus =
  | 'queued'
  | 'fetching_metadata'
  | 'downloading_pdf'
  | 'extracting_text'
  | 'processing'
  | 'completed'
  | 'failed';

const NON_TERMINAL: JobStatus[] = [
  'queued',
  'fetching_metadata',
  'downloading_pdf',
  'extracting_text',
  'processing',
];

/**
 * Stable identity for this API instance.
 *
 * Must be stable across restarts of the same logical instance (so it reclaims
 * its own interrupted jobs) and distinct between concurrent instances (so it
 * cannot claim theirs). host:port satisfies both: a restarted dev server keeps
 * its port, two concurrent instances cannot share one. Override with INSTANCE_ID
 * when several instances share a port behind different hostnames.
 */
export const INSTANCE_ID =
  process.env.INSTANCE_ID || `${hostname()}:${process.env.PORT || '3000'}`;

/** How long a lease stays valid without renewal. */
const LEASE_TTL_MS = Math.max(
  30_000,
  parseInt(process.env.JOB_LEASE_TTL_MS || '120000', 10) || 120_000
);

/** How often a running job renews its lease. Comfortably inside the TTL. */
const HEARTBEAT_MS = Math.max(5_000, Math.floor(LEASE_TTL_MS / 4));

function leaseDeadline(): Date {
  return new Date(Date.now() + LEASE_TTL_MS);
}

type Task = () => Promise<void>;

class JobQueue {
  private active = 0;
  private readonly pending: Array<{ jobId: string; task: Task }> = [];
  /** Jobs currently executing in this process, kept alive by the heartbeat. */
  private readonly running = new Set<string>();
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(private readonly concurrency: number) {}

  enqueue(jobId: string, task: Task): void {
    this.pending.push({ jobId, task });
    this.drain();
  }

  private drain(): void {
    while (this.active < this.concurrency && this.pending.length > 0) {
      const { jobId, task } = this.pending.shift()!;
      this.active += 1;
      this.running.add(jobId);
      this.ensureHeartbeat();

      task()
        .catch((err) => console.error(`[queue] job ${jobId} failed:`, err))
        .finally(() => {
          this.active -= 1;
          this.running.delete(jobId);
          this.stopHeartbeatIfIdle();
          this.drain();
        });
    }
  }

  private ensureHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      void this.renewLeases();
    }, HEARTBEAT_MS);
    // Never hold the process open just to renew leases.
    this.heartbeat.unref?.();
  }

  private stopHeartbeatIfIdle(): void {
    if (this.running.size > 0 || !this.heartbeat) return;
    clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private async renewLeases(): Promise<void> {
    const ids = [...this.running];
    if (ids.length === 0) return;
    try {
      await db
        .update(jobs)
        .set({ leaseExpiresAt: leaseDeadline() })
        .where(inArray(jobs.id, ids));
    } catch (err) {
      // A transient DB blip must not kill the worker; the lease TTL is generous
      // enough to survive a missed beat or two.
      console.warn('[queue] lease renewal failed:', err instanceof Error ? err.message : err);
    }
  }

  /** Queued-but-not-started jobs, lost if this process exits. */
  pendingJobIds(): string[] {
    return this.pending.map((p) => p.jobId);
  }
}

export const paperQueue = new JobQueue(
  Math.max(1, parseInt(process.env.JOB_CONCURRENCY || '2', 10) || 2)
);

// --- Durable job-status helpers ---------------------------------------------

export async function createJob(
  id: string,
  type: 'ingest' | 'process',
  fields: { status?: JobStatus; paperId?: string; metadata?: unknown } = {}
): Promise<void> {
  await db.insert(jobs).values({
    id,
    type,
    status: fields.status ?? 'queued',
    paperId: fields.paperId ?? null,
    metadata: (fields.metadata as any) ?? null,
    owner: INSTANCE_ID,
    leaseExpiresAt: leaseDeadline(),
  });
}

export async function setJobStatus(
  id: string,
  fields: { status?: JobStatus; paperId?: string; progress?: string; error?: string }
): Promise<void> {
  const terminal = fields.status === 'completed' || fields.status === 'failed';
  await db
    .update(jobs)
    .set({
      ...fields,
      updatedAt: new Date(),
      // Progress is itself proof of life; release the lease once terminal.
      leaseExpiresAt: terminal ? null : leaseDeadline(),
    })
    .where(eq(jobs.id, id));
}

export async function getJob(id: string) {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  return job ?? null;
}

export interface RecoveryResult {
  ownJobs: number;
  expiredLeases: number;
  papers: number;
}

/**
 * Called once on startup.
 *
 * Recovers exactly two categories, and nothing else:
 *
 *  1. Jobs owned by *this* instance. We have just started, so our in-memory
 *     queue is empty by definition — anything we own that is still running was
 *     interrupted by the previous process exiting.
 *  2. Jobs whose lease has expired. Their owner stopped renewing, so it is gone
 *     for good and nobody else will ever run them.
 *
 * It used to fail every non-terminal job unconditionally. With two processes
 * sharing a database — a second instance, a test run, or a dev server reloading
 * on file change — starting one silently killed the other's in-flight ingestion
 * and reported "Interrupted by server restart" on work that was still running.
 *
 * Papers are recovered alongside jobs: recovering only the job row left the
 * paper on a non-terminal `processingStatus`, so `GET /api/papers/processing`
 * (which the Dashboard polls) listed it as in-flight forever.
 */
export async function recoverOrphanedJobs(): Promise<RecoveryResult> {
  return db.transaction(async (tx) => {
    const claimable = or(
      eq(jobs.owner, INSTANCE_ID),
      isNull(jobs.owner), // pre-ownership rows
      isNull(jobs.leaseExpiresAt),
      lt(jobs.leaseExpiresAt, new Date())
    );

    const recovered = await tx
      .update(jobs)
      .set({
        status: 'failed',
        error: 'Interrupted by server restart. Please retry.',
        leaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(and(inArray(jobs.status, NON_TERMINAL), claimable))
      .returning({ id: jobs.id, owner: jobs.owner });

    const ownJobs = recovered.filter((r) => r.owner === INSTANCE_ID).length;

    // Only papers with no live job still working on them. A paper whose job
    // belongs to another running instance must keep its in-progress status.
    const recoveredPapers = await tx
      .update(papers)
      .set({
        processed: false,
        processingStatus: 'failed',
        processingError: 'Interrupted by server restart. Reprocess to retry.',
        updatedAt: new Date(),
      })
      .where(
        and(
          inArray(papers.processingStatus, [
            'downloading_pdf',
            'extracting_text',
            'chunking',
            'extracting_entities',
            'resolving_entities',
            'validating',
          ]),
          sql`not exists (
            select 1 from ${jobs}
            where ${jobs.paperId} = ${papers.id}
              and ${jobs.status} in ('queued','fetching_metadata','downloading_pdf','extracting_text','processing')
          )`
        )
      )
      .returning({ id: papers.id });

    return {
      ownJobs,
      expiredLeases: recovered.length - ownJobs,
      papers: recoveredPapers.length,
    };
  });
}
