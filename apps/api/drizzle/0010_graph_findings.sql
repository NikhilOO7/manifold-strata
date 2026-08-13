-- Graph-quality proposals from the background audit.
--
-- Stored, not acted on. A false merge destroys a distinction; a false drop
-- destroys the evidence with it, leaving no record the node ever existed. So the
-- audit states what it believes and why, and applying is an explicit, separate
-- act by someone who can read the reason.
CREATE TABLE IF NOT EXISTS "graph_findings" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "domain"          text NOT NULL,
  "node_id"         uuid NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
  "related_node_id" uuid REFERENCES "nodes"("id") ON DELETE CASCADE,
  "detector"        text NOT NULL,
  "verdict"         text NOT NULL,
  "reason"          text NOT NULL,
  "confidence"      text NOT NULL,
  "status"          text NOT NULL DEFAULT 'proposed',
  "created_at"      timestamp NOT NULL DEFAULT now(),
  "resolved_at"     timestamp
);
CREATE INDEX IF NOT EXISTS "graph_findings_domain_status_idx" ON "graph_findings" ("domain", "status");
CREATE INDEX IF NOT EXISTS "graph_findings_node_idx" ON "graph_findings" ("node_id");

-- The audit is a third lane on the durable queue: CPU work, off the GPU path.
-- `jobs.type` is deliberately `text`, not an enum, so a new lane needs no
-- migration to the type itself — the same reasoning that keeps node and edge
-- types open (invariant 19).
