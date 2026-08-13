-- Entity identity, enforced by the database rather than by a check-then-insert.
--
-- Resolution's lookups (exact name, then guarded ANN) decide *which* node a
-- mention belongs to. None of that helps against concurrency: the write path
-- ended in
--
--     SELECT ... WHERE normalized_name = $1 AND domain = $2   -- miss
--     INSERT INTO nodes ...                                   -- create
--
-- which is a classic time-of-check-to-time-of-use race. Two workers extracting
-- two different papers that both mention "Transformer" can both miss and both
-- insert. Demonstrated with two concurrent transactions: two nodes, same
-- normalized_name, same domain.
--
-- This is reachable in the shipped configuration — PROCESS_CONCURRENCY is a knob
-- and the queue is deliberately multi-instance — so it is closed at the only
-- layer that can actually serialise it.

-- 1. Merge any duplicates that already exist. These are EXACT normalized-name
--    matches inside one domain, which is precisely what resolution treats as one
--    entity, so merging them is what the system already believes. The oldest row
--    wins: it is the one other rows are most likely to already reference.
CREATE TEMP TABLE dupe_map AS
SELECT n.id AS loser, c.canonical
FROM nodes n
JOIN (
  SELECT coalesce(domain, '') AS d, normalized_name AS nn,
         (array_agg(id ORDER BY created_at, id))[1] AS canonical
  FROM nodes
  WHERE normalized_name IS NOT NULL
  GROUP BY 1, 2
  HAVING count(*) > 1
) c ON coalesce(n.domain, '') = c.d AND n.normalized_name = c.nn
WHERE n.id <> c.canonical;

-- 2. Repoint everything that references a loser.
UPDATE edges SET source_id = m.canonical FROM dupe_map m WHERE edges.source_id = m.loser;
UPDATE edges SET target_id = m.canonical FROM dupe_map m WHERE edges.target_id = m.loser;

-- Repointing can turn an edge into a self-edge, which is not a claim.
DELETE FROM edges WHERE source_id = target_id;

-- …and can produce exact duplicate edges. Keep one, move its provenance onto it.
CREATE TEMP TABLE edge_map AS
SELECT e.id AS loser, k.keeper
FROM edges e
JOIN (
  SELECT source_id, target_id, type, coalesce(domain, '') AS d,
         (array_agg(id ORDER BY created_at, id))[1] AS keeper
  FROM edges GROUP BY 1, 2, 3, 4 HAVING count(*) > 1
) k ON e.source_id = k.source_id AND e.target_id = k.target_id
   AND e.type = k.type AND coalesce(e.domain, '') = k.d
WHERE e.id <> k.keeper;

UPDATE sources SET edge_id = m.keeper FROM edge_map m WHERE sources.edge_id = m.loser;
DELETE FROM edges WHERE id IN (SELECT loser FROM edge_map);

-- Propositions carry node ids in a jsonb array; rewrite them elementwise.
UPDATE propositions p
SET node_ids = (
  SELECT jsonb_agg(DISTINCT coalesce(m.canonical::text, elem))
  FROM jsonb_array_elements_text(p.node_ids) AS elem
  LEFT JOIN dupe_map m ON m.loser::text = elem
)
WHERE EXISTS (
  SELECT 1 FROM jsonb_array_elements_text(p.node_ids) AS e2
  JOIN dupe_map m2 ON m2.loser::text = e2
);

-- One vector per node is a unique constraint, so a loser's vector is dropped
-- rather than repointed when the canonical already has one.
DELETE FROM node_vectors v USING dupe_map m
WHERE v.node_id = m.loser
  AND EXISTS (SELECT 1 FROM node_vectors c WHERE c.node_id = m.canonical);
UPDATE node_vectors v SET node_id = m.canonical FROM dupe_map m WHERE v.node_id = m.loser;

DELETE FROM nodes WHERE id IN (SELECT loser FROM dupe_map);

-- 3. The guarantee itself. Partial, because a node without a normalized name has
--    no identity to compare — and NULLs do not conflict in Postgres anyway, so
--    including them would silently weaken the constraint rather than widen it.
CREATE UNIQUE INDEX IF NOT EXISTS nodes_identity_unique
  ON nodes ((coalesce(domain, '')), normalized_name)
  WHERE normalized_name IS NOT NULL;
