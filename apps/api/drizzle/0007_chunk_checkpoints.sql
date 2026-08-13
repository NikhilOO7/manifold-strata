-- Chunk-level checkpoints, so a retry resumes instead of restarting.
--
-- Extraction costs ~34s of GPU per chunk and a paper runs ~26 chunks. A failure
-- at chunk 24 previously discarded every one of the 23 correct extractions,
-- because the only way to guarantee no duplicates was to clear the paper's whole
-- contribution and begin again. That was the right call while an edge could not
-- be attributed to a chunk. `sources.chunk_index` makes it attributable, so the
-- undo can be per-chunk and the retry can pick up where it stopped.
ALTER TABLE "sources" ADD COLUMN IF NOT EXISTS "chunk_index" integer;
CREATE INDEX IF NOT EXISTS "sources_paper_chunk_idx" ON "sources" ("paper_id", "chunk_index");

CREATE TABLE IF NOT EXISTS "paper_chunks" (
  "paper_id"      uuid NOT NULL REFERENCES "papers"("id") ON DELETE CASCADE,
  "chunk_index"   integer NOT NULL,
  "status"        text NOT NULL DEFAULT 'completed',
  "content_hash"  text NOT NULL,
  "section"       text,
  "entities"      integer NOT NULL DEFAULT 0,
  "relationships" integer NOT NULL DEFAULT 0,
  "error"         text,
  "completed_at"  timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "paper_chunks_pk" PRIMARY KEY ("paper_id", "chunk_index")
);
CREATE INDEX IF NOT EXISTS "paper_chunks_paper_idx" ON "paper_chunks" ("paper_id");

-- Papers can be paused between chunks and resumed from the checkpoint above.
ALTER TYPE "processing_status" ADD VALUE IF NOT EXISTS 'paused';

-- Jobs can be parked too. Terminal for the queue (nothing claims a paused job)
-- but explicitly not a failure: marking a deliberate pause as failed is the same
-- category of lie as showing a failed paper as "Pending".
ALTER TYPE "job_status" ADD VALUE IF NOT EXISTS 'paused';
