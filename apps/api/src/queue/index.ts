import { hostname } from 'node:os';
import { db } from '../db';
import { jobs, papers } from '../db/schema';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';

/**
 * Durable, claimable job queue on Postgres.
 *
 * The previous design held queued work as closures in the worker's memory, with
 * the `jobs` table as a status mirror. That shape has a hard ceiling: a batch of
 * 100 documents is 20+ hours of GPU time on this hardware, and any restart in
 * that window — a deploy, a crash, `tsx watch` reloading on a file save — lost
 * every job not yet started and failed the ones mid-flight. The queue IS the
 * table now:
 *
 *   enqueue      insert a row (status 'queued', no owner). Durable immediately.
 *   claim        `FOR UPDATE SKIP LOCKED` — atomically take the oldest unowned
 *                job in a lane. Any instance can claim any job, which makes
 *                multi-instance scale-out real rather than aspirational, with no
 *                broker to operate. (BullMQ/Redis was considered and rejected:
 *                it adds an infrastructure dependency to move hundreds of jobs a
 *                day through a system that already has Postgres. SKIP LOCKED is
 *                the boring, battle-standard answer at this volume; the enqueue/
 *                claim contract is small enough that a broker swap stays local
 *                to this file if volume ever demands it.)
 *   lease        renewed by heartbeat while running. An instance that dies stops
 *                renewing; the reaper re-queues its jobs for anyone to claim.
 *   retry        two counters, because they answer different questions.
 *                `failures` counts handler errors and is what MAX_JOB_ATTEMPTS
 *                gates: evidence the work is bad. `attempts` counts claims and
 *                is gated by the much wider MAX_JOB_CLAIMS: a crash-loop
 *                backstop. Conflating them meant a restart spent the same budget
 *                as a real error, so three deploys destroyed a paper that had
 *                never failed once.
 *
 * Two lanes, because the pipeline's stages consume different resources:
 *
 *   ingest   network + CPU: arXiv metadata, PDF download (throttled per-host),
 *            parse (worker thread). Cheap, parallelisable.
 *   process  GPU: extraction at ~34s/chunk. Default concurrency 1 — but treat
 *            that as a conservative starting point, not a measured fact. It was
 *            reasoned from "one GPU, one model server", and a model server that
 *            batches concurrent requests can beat that reasoning. Decide it on
 *            the hardware you actually run: `pnpm --filter api bench:lane-width`
 *            times N calls serial vs concurrent, alternating arm order so a
 *            drifting machine cannot fake a result.
 *
 * Separate lanes mean document N+1 fetches while document N extracts, and a
 * whole batch is fetched/parsed (restart-safe on disk) within minutes even
 * though extraction grinds for hours.
 */

export type JobStatus =
  | 'queued'
  | 'fetching_metadata'
  | 'downloading_pdf'
  | 'extracting_text'
  | 'processing'
  | 'paused'
  | 'completed'
  | 'failed';

export type JobType = 'ingest' | 'process' | 'audit';

/** Statuses that mean "this job still has work left to do". */
export const NON_TERMINAL_JOB_STATUSES: JobStatus[] = [
  'queued',
  'fetching_metadata',
  'downloading_pdf',
  'extracting_text',
  'processing',
];
const NON_TERMINAL = NON_TERMINAL_JOB_STATUSES;

export const INSTANCE_ID =
  process.env.INSTANCE_ID || `${hostname()}:${process.env.PORT || '3000'}`;

/**
 * How many times a handler may FAIL before the job is given up on.
 *
 * Counted against `jobs.failures`, not `jobs.attempts`. The distinction is the
 * whole point: `attempts` counts claims, so an interrupted job — a deploy, a
 * crash, `tsx watch` reloading on a file save — used to spend the same budget as
 * a job that ran and threw. Three restarts permanently failed papers that had
 * never once errored, and the recorded reason ("Interrupted and out of retry
 * attempts") admitted it. An interruption is evidence about the *process*, not
 * about the work.
 */
export const MAX_JOB_ATTEMPTS = Math.max(
  1,
  parseInt(process.env.MAX_JOB_ATTEMPTS || '3', 10) || 3
);

/**
 * A far higher ceiling on total claims, so a job that kills its worker every
 * time still cannot loop forever. This is the crash-loop backstop that
 * `MAX_JOB_ATTEMPTS` was accidentally serving — badly, because it could not tell
 * a poisoned job from an unlucky one.
 */
export const MAX_JOB_CLAIMS = Math.max(
  MAX_JOB_ATTEMPTS,
  parseInt(process.env.MAX_JOB_CLAIMS || '25', 10) || 25
);

const LEASE_TTL_MS = Math.max(
  30_000,
  parseInt(process.env.JOB_LEASE_TTL_MS || '120000', 10) || 120_000
);
const HEARTBEAT_MS = Math.max(5_000, Math.floor(LEASE_TTL_MS / 4));
const POLL_MS = Math.max(250, parseInt(process.env.JOB_POLL_MS || '1000', 10) || 1_000);
const REAPER_MS = 60_000;

/**
 * How long a shutdown waits for in-flight jobs. Short on purpose — see
 * `stopWorkers`. Supervisors typically allow ~30s before SIGKILL.
 */
const SHUTDOWN_GRACE_MS = Math.max(
  0,
  parseInt(process.env.SHUTDOWN_GRACE_MS || '10000', 10) || 10_000
);

function leaseDeadline(): Date {
  return new Date(Date.now() + LEASE_TTL_MS);
}

/**
 * Thrown by a handler when retrying cannot change the outcome — an arXiv id
 * that does not exist, a document with no text, an unregistered domain. The
 * runner fails the job immediately instead of burning the remaining attempts
 * (which for the process lane would mean re-running fifteen minutes of GPU
 * work to reach the same dead end).
 */
export class PermanentJobError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PermanentJobError';
  }
}

export type Job = typeof jobs.$inferSelect;
export type JobHandler = (job: Job) => Promise<void>;

const handlers = new Map<JobType, JobHandler>();

export function registerHandler(type: JobType, handler: JobHandler): void {
  handlers.set(type, handler);
}

// --- Durable job rows --------------------------------------------------------

/**
 * Thrown when a paper already has a live process job.
 *
 * Scheduling the same paper twice is not merely wasteful — both jobs run
 * `resumePaper`, which clears unfinished contribution before rebuilding, so two
 * of them can clear work the other is writing. A partial unique index makes it
 * impossible; this is how the impossibility is reported.
 */
export class AlreadyScheduledError extends Error {
  constructor(public readonly paperId: string) {
    super(`Paper ${paperId} already has a process job scheduled.`);
    this.name = 'AlreadyScheduledError';
  }
}

export async function createJob(
  id: string,
  type: JobType,
  fields: { status?: JobStatus; paperId?: string; metadata?: unknown; batchId?: string } = {}
): Promise<void> {
  // No owner and no lease at creation: a queued row belongs to nobody until an
  // instance claims it. That single change is what makes the backlog durable.
  try {
    await db.insert(jobs).values({
      id,
      type,
      status: fields.status ?? 'queued',
      paperId: fields.paperId ?? null,
      metadata: (fields.metadata as never) ?? null,
      batchId: fields.batchId ?? null,
    });
  } catch (err) {
    // `jobs_one_active_per_paper` is the authority, not the caller's check —
    // two routes could schedule a paper and only one of them remembered to look
    // first. Translating the constraint into a typed error means a new route is
    // safe by default rather than by diligence.
    if (type === 'process' && fields.paperId && isUniqueViolationOn(err, 'jobs_one_active_per_paper')) {
      throw new AlreadyScheduledError(fields.paperId);
    }
    throw err;
  }
}

/** Postgres surfaces the constraint name; walk the cause chain to find it. */
function isUniqueViolationOn(err: unknown, constraint: string): boolean {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur; i++) {
    const e = cur as { code?: string; constraint_name?: string; message?: string; cause?: unknown };
    if (e.code === '23505' && (e.constraint_name === constraint || e.message?.includes(constraint))) {
      return true;
    }
    cur = e.cause;
  }
  return false;
}

export async function setJobStatus(
  id: string,
  fields: { status?: JobStatus; paperId?: string; progress?: string; error?: string }
): Promise<void> {
  // 'paused' releases the lease like any terminal state: nothing is running, so
  // holding a lease would only delay a resume behind an expiry that will never
  // matter.
  const terminal =
    fields.status === 'completed' || fields.status === 'failed' || fields.status === 'paused';
  await db
    .update(jobs)
    .set({
      ...fields,
      updatedAt: new Date(),
      leaseExpiresAt: terminal ? null : leaseDeadline(),
    })
    .where(eq(jobs.id, id));
}

export async function getJob(id: string): Promise<Job | null> {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  return job ?? null;
}

// --- Claiming ----------------------------------------------------------------

/**
 * Atomically claim the oldest unowned queued job in a lane.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes N concurrent claimers safe: each
 * SELECT locks a different candidate row or skips past locked ones, so two
 * instances can never take the same job and neither ever waits on the other.
 */
export async function claimNextJob(type: JobType): Promise<Job | null> {
  const rows = (await db.execute(sql`
    update jobs
    set owner = ${INSTANCE_ID},
        lease_expires_at = ${leaseDeadline().toISOString()}::timestamptz,
        attempts = attempts + 1,
        updated_at = now()
    where id = (
      select id from jobs
      where status = 'queued' and owner is null and type = ${type}
      order by created_at
      limit 1
      for update skip locked
    )
    returning id
  `)) as unknown as Array<{ id: string }>;

  if (rows.length === 0) return null;
  return getJob(rows[0].id);
}

/** Return a job to the queue for another attempt (or a later instance). */
async function requeueJob(id: string, reason: string): Promise<void> {
  await db
    .update(jobs)
    .set({
      status: 'queued',
      owner: null,
      leaseExpiresAt: null,
      error: `${reason} — will retry`,
      updatedAt: new Date(),
    })
    .where(eq(jobs.id, id));
}

// --- Worker loops ------------------------------------------------------------

interface Lane {
  type: JobType;
  limit: number;
  active: number;
}

let running = false;
const runningJobIds = new Set<string>();
const timers: NodeJS.Timeout[] = [];

async function runClaimed(job: Job, lane: Lane): Promise<void> {
  const handler = handlers.get(job.type as JobType);
  if (!handler) {
    // A row we cannot run must not be swallowed into limbo — release it for an
    // instance that does have the handler (rolling deploys), leaseless so the
    // reaper picks it up if nobody ever does.
    await requeueJob(job.id, `no handler registered for "${job.type}" on ${INSTANCE_ID}`);
    return;
  }

  runningJobIds.add(job.id);
  try {
    await handler(job);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const permanent = err instanceof PermanentJobError;

    // The handler ran and threw: that IS evidence about the work, so it counts.
    const [row] = await db
      .update(jobs)
      .set({ failures: sql`${jobs.failures} + 1`, updatedAt: new Date() })
      .where(eq(jobs.id, job.id))
      .returning({ failures: jobs.failures });
    const failures = row?.failures ?? job.failures + 1;

    if (permanent || failures >= MAX_JOB_ATTEMPTS) {
      await setJobStatus(job.id, {
        status: 'failed',
        error: permanent ? message : `${message} (after ${failures} failure(s))`,
      }).catch(() => {});
    } else {
      console.warn(`[queue] ${job.type} ${job.id} failure ${failures} — ${message}`);
      await requeueJob(job.id, message).catch(() => {});
    }
  } finally {
    runningJobIds.delete(job.id);
    lane.active -= 1;
  }
}

function startLane(lane: Lane): void {
  const tick = async () => {
    if (!running) return;
    try {
      // Drain up to the lane's limit; stop on empty so idle costs one query per poll.
      while (lane.active < lane.limit) {
        const job = await claimNextJob(lane.type);
        if (!job) break;
        lane.active += 1;
        void runClaimed(job, lane);
      }
    } catch (err) {
      console.warn(`[queue] ${lane.type} lane poll failed:`, err instanceof Error ? err.message : err);
    }
  };

  // Jitter so multiple instances do not synchronise their polls.
  const interval = setInterval(tick, POLL_MS + Math.floor(Math.random() * 250));
  interval.unref?.();
  timers.push(interval);
  void tick();
}

function startHeartbeat(): void {
  const interval = setInterval(() => {
    const ids = [...runningJobIds];
    if (ids.length === 0) return;
    void db
      .update(jobs)
      .set({ leaseExpiresAt: leaseDeadline() })
      .where(inArray(jobs.id, ids))
      .catch((err) => console.warn('[queue] lease renewal failed:', err?.message ?? err));
  }, HEARTBEAT_MS);
  interval.unref?.();
  timers.push(interval);
}

export interface WorkerConfig {
  ingestConcurrency?: number;
  processConcurrency?: number;
}

/**
 * Configured lane widths, so callers can *explain* the queue rather than just
 * report its depth. "Five papers waiting" is alarming on its own and ordinary
 * once you can also say "one extracts at a time, by configuration".
 */
export function workerCapacity(): { ingest: number; process: number } {
  return {
    ingest: Math.max(1, parseInt(process.env.FETCH_CONCURRENCY || '2', 10) || 2),
    process: Math.max(
      1,
      parseInt(process.env.PROCESS_CONCURRENCY || process.env.JOB_CONCURRENCY || '1', 10) || 1
    ),
  };
}

export function startWorkers(config: WorkerConfig = {}): void {
  if (running) return;
  running = true;

  const ingestLimit = config.ingestConcurrency ?? workerCapacity().ingest;
  // Default 1 is the safe choice, not a measured optimum: one concurrent
  // extraction can never thrash a single GPU's memory. Whether widening it pays
  // depends on whether the model server batches — run `bench:lane-width` on the
  // target hardware and set it from the answer. On a hosted extraction provider
  // it should certainly be higher; the bottleneck there is the network.
  const processLimit = config.processConcurrency ?? workerCapacity().process;

  startLane({ type: 'ingest', limit: ingestLimit, active: 0 });
  startLane({ type: 'process', limit: processLimit, active: 0 });
  // A third lane, concurrency 1. Graph auditing is CPU work that reads the whole
  // domain, so it must not sit behind the GPU queue — an operator asking "what is
  // wrong with my graph" should not wait fifteen minutes for an extraction. One
  // at a time because two audits of the same domain would each delete the
  // other's proposals.
  startLane({ type: 'audit', limit: 1, active: 0 });
  startHeartbeat();

  const reaper = setInterval(() => void reapExpiredJobs(), REAPER_MS);
  reaper.unref?.();
  timers.push(reaper);

  console.log(
    `✓ Workers: ingest×${ingestLimit} (network/CPU) · process×${processLimit} (GPU) · ` +
      `audit×1 (graph quality) · retry up to ${MAX_JOB_ATTEMPTS} failure(s) · ${MAX_JOB_CLAIMS} claim ceiling · ` +
      `lease ${Math.round(LEASE_TTL_MS / 1000)}s`
  );
}

export interface DrainResult {
  /** In-flight jobs that finished within the grace period. */
  drained: number;
  /** Jobs still running when we stopped waiting; recovered via lease expiry. */
  inFlight: number;
}

/**
 * Stop claiming and let in-flight work finish, within a bounded grace period.
 *
 * What this deliberately does NOT do is release still-running claims back to the
 * queue. That would look like a faster handover and would be a correctness bug:
 * the job is still executing in this process, so another instance could claim it
 * and both would extract the same paper into the same graph concurrently. The
 * lease exists precisely to make that impossible, so an interrupted job is left
 * leased and recovered the safe way — by expiry, bounded by JOB_LEASE_TTL_MS, or
 * immediately by this instance's own startup recovery if it comes back first.
 *
 * The grace period is short by design. Most ingest-lane work finishes in seconds;
 * extraction takes ~15 minutes and no supervisor waits that long before sending
 * SIGKILL, so waiting for it would only convert a clean shutdown into a killed
 * one. Extraction is idempotent and restart-safe, which is what makes leaving it
 * to the lease an honest answer rather than a resigned one.
 */
export async function stopWorkers(graceMs = SHUTDOWN_GRACE_MS): Promise<DrainResult> {
  const before = runningJobIds.size;
  running = false;
  for (const t of timers) clearInterval(t);
  timers.length = 0;

  const deadline = Date.now() + Math.max(0, graceMs);
  while (runningJobIds.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return { drained: before - runningJobIds.size, inFlight: runningJobIds.size };
}

/** Job ids this instance is currently executing — for shutdown reporting. */
export function inFlightJobIds(): string[] {
  return [...runningJobIds];
}

// --- Recovery ----------------------------------------------------------------

export interface RecoveryResult {
  requeued: number;
  failed: number;
  papersReset: number;
}

/**
 * Re-queue or fail jobs whose owner has stopped renewing its lease.
 *
 * `ownerFilter` narrows the sweep to one instance's jobs regardless of lease —
 * used at startup for our own leftovers, which are dead by definition (we just
 * started; our in-memory running set is empty).
 */
export async function reapExpiredJobs(ownerFilter?: string): Promise<RecoveryResult> {
  const orphaned = ownerFilter
    ? and(
        inArray(jobs.status, NON_TERMINAL),
        sql`(${jobs.owner} = ${ownerFilter} or (${jobs.owner} is not null and ${jobs.leaseExpiresAt} < now()))`
      )
    : and(
        inArray(jobs.status, NON_TERMINAL),
        sql`${jobs.owner} is not null`,
        lt(jobs.leaseExpiresAt, new Date())
      );

  return db.transaction(async (tx) => {
    // Interrupted but retriable: back to the queue for any instance.
    const requeued = await tx
      .update(jobs)
      .set({
        status: 'queued',
        owner: null,
        leaseExpiresAt: null,
        error: 'Interrupted (instance stopped or lease expired) — requeued',
        updatedAt: new Date(),
      })
      // Gated on total CLAIMS, not on the failure budget. This is the line that
      // destroyed work: it read `attempts < MAX_JOB_ATTEMPTS`, so three restarts
      // — which is one afternoon of `tsx watch` — permanently failed a paper
      // that had never thrown. An interruption says the process died, nothing
      // about the paper, so it gets the wide crash-loop ceiling instead.
      .where(and(orphaned, lt(jobs.attempts, MAX_JOB_CLAIMS)))
      .returning({ id: jobs.id });

    // Genuinely stuck: claimed this many times without ever completing. This is
    // a poison-pill backstop, not a retry budget.
    const failed = await tx
      .update(jobs)
      .set({
        status: 'failed',
        owner: null,
        leaseExpiresAt: null,
        error:
          `Claimed ${MAX_JOB_CLAIMS} times without completing — treating as a ` +
          `poison job. Raise MAX_JOB_CLAIMS if the interruptions were external.`,
        updatedAt: new Date(),
      })
      .where(and(orphaned, sql`${jobs.attempts} >= ${MAX_JOB_CLAIMS}`))
      .returning({ id: jobs.id });

    // Papers stuck mid-processing with NO live or queued job behind them: the
    // requeue above keeps resumable papers out of this set, because their job is
    // non-terminal again by the time this runs.
    const papersReset = await tx
      .update(papers)
      .set({
        processed: false,
        processingStatus: 'failed',
        processingError: 'Processing was interrupted and could not be resumed.',
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

    return { requeued: requeued.length, failed: failed.length, papersReset: papersReset.length };
  });
}

/**
 * Startup recovery. Where the old version failed every interrupted job with
 * "please retry", this one retries them itself — that difference is the whole
 * point of the durable queue. Queued unowned jobs need no recovery at all:
 * they are simply still in the queue.
 */
export async function recoverOnStartup(): Promise<RecoveryResult> {
  return reapExpiredJobs(INSTANCE_ID);
}

// --- Introspection -----------------------------------------------------------

export interface QueueDepth {
  queued: number;
  running: number;
  byType: Record<string, { queued: number; running: number }>;
}

export async function queueDepth(): Promise<QueueDepth> {
  const rows = (await db.execute(sql`
    select type,
      count(*) filter (where status = 'queued' and owner is null) as queued,
      count(*) filter (where status in ('queued','fetching_metadata','downloading_pdf','extracting_text','processing') and owner is not null) as running
    from jobs
    group by type
  `)) as unknown as Array<{ type: string; queued: string; running: string }>;

  const byType: QueueDepth['byType'] = {};
  let queued = 0;
  let runningCount = 0;
  for (const r of rows) {
    const q = Number(r.queued);
    const run = Number(r.running);
    byType[r.type] = { queued: q, running: run };
    queued += q;
    runningCount += run;
  }
  return { queued, running: runningCount, byType };
}

/** Non-terminal job count — the admission-control gauge. */
export async function pendingJobCount(): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(jobs)
    .where(inArray(jobs.status, NON_TERMINAL));
  return row?.count ?? 0;
}

export const MAX_PENDING_JOBS = Math.max(
  1,
  parseInt(process.env.MAX_PENDING_JOBS || '500', 10) || 500
);
