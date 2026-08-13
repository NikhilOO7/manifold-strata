-- One live process job per paper, enforced by the database.
--
-- Two routes could schedule a paper: `POST /:id/resume` checked for an existing
-- non-terminal job first, and `POST /:id/domain` did not. That asymmetry is
-- exactly the shape of bug the authorization chokepoint exists to prevent
-- elsewhere — a rule held by remembering to check it, in one of the two places
-- that needed it. Observed live: four papers with two queued process jobs, and
-- one with a job *processing* while another sat queued behind it.
--
-- The cost is not merely a wasted 15-minute extraction. Both jobs run
-- `resumePaper`, which clears the paper's unfinished contribution before
-- rebuilding it; with PROCESS_CONCURRENCY > 1 or a second instance, the two
-- can overlap and each will clear work the other is writing.
--
-- `paused` counts as terminal here: a parked paper is not scheduled, and
-- resuming it must be able to create a fresh job.

-- 1. Collapse existing duplicates. A claimed job wins over an unclaimed one —
--    it may be mid-extraction and killing it would discard real work. Otherwise
--    the oldest wins, since it is the one a caller was told about first.
WITH ranked AS (
  SELECT id, paper_id,
         row_number() OVER (
           PARTITION BY paper_id
           ORDER BY (owner IS NULL), created_at, id
         ) AS rn
  FROM jobs
  WHERE type = 'process'
    AND paper_id IS NOT NULL
    AND status NOT IN ('completed', 'failed', 'paused')
)
DELETE FROM jobs WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- 2. The guarantee.
CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_active_per_paper
  ON jobs (paper_id)
  WHERE type = 'process'
    AND paper_id IS NOT NULL
    AND status NOT IN ('completed', 'failed', 'paused');
