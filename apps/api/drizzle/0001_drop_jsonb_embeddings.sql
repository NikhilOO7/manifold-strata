-- Drop the JSONB embedding copies now that `embedding_vec` is authoritative.
--
-- Keeping both was a measurable mistake, not just wasted space: JSONB stores
-- each float as decimal text (~15 KB per 768-dim vector) against pgvector's
-- packed float4 (~3 KB), so the two vector tables reached ~1 GB each on a
-- 100k-entity corpus and pushed the 400 MB of HNSW indexes out of the buffer
-- cache. Doubling the corpus then cost 1.8x p50 latency even though the working
-- set per query had not changed.
--
-- This is destructive and irreversible, so it refuses to run unless every row
-- that had a JSONB embedding also has a vector one. A migration that silently
-- discards the only copy of the data is not a migration.
DO $$
DECLARE
  unmigrated_nodes bigint;
  unmigrated_props bigint;
BEGIN
  SELECT count(*) INTO unmigrated_nodes
  FROM node_vectors
  WHERE embedding IS NOT NULL AND embedding_vec IS NULL;

  SELECT count(*) INTO unmigrated_props
  FROM propositions
  WHERE embedding IS NOT NULL AND embedding_vec IS NULL;

  IF unmigrated_nodes > 0 OR unmigrated_props > 0 THEN
    RAISE EXCEPTION
      'Refusing to drop JSONB embeddings: % node_vectors row(s) and % propositions row(s) have no embedding_vec. Run POST /api/field/backfill first.',
      unmigrated_nodes, unmigrated_props;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "node_vectors" DROP COLUMN "embedding";--> statement-breakpoint
ALTER TABLE "propositions" DROP COLUMN "embedding";
