-- Interruptions are not failures.
--
-- `attempts` counts CLAIMS, so a process restart mid-extraction spent one — the
-- same budget a genuine error spends. Three restarts (a deploy, or `tsx watch`
-- reloading on a file save) permanently failed a paper that had never once
-- errored. Observed in development: two papers marked
-- "Interrupted and out of retry attempts (3)" with no error recorded at all.
--
-- `failures` counts only handler errors, and is what the give-up decision reads.
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "failures" integer DEFAULT 0 NOT NULL;

-- Jobs already failed this way have a paper-side error saying they were
-- interrupted and a job-side error naming the attempt cap, and never recorded a
-- handler error. Those are exactly the ones this migration exists for: return
-- them to the queue rather than leaving work destroyed by a bookkeeping bug.
UPDATE "jobs"
SET status = 'queued', owner = NULL, lease_expires_at = NULL, attempts = 0,
    error = 'Re-queued: previously failed by interruption accounting, not by an error'
WHERE status = 'failed' AND error LIKE 'Interrupted and out of retry attempts%';

UPDATE "papers" p
SET processing_status = 'pending', processing_error = NULL, processing_progress = 0
WHERE p.processing_status = 'failed'
  AND EXISTS (SELECT 1 FROM "jobs" j WHERE j.paper_id = p.id AND j.status = 'queued');
