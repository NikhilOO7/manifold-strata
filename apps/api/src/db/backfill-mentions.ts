/**
 * Attach every entity to the paper that named it.
 *
 * The processor now writes `paper -[mentions]-> entity` as it extracts, but a
 * corpus ingested before that is full of orphans: entities the extractor named
 * and then did not happen to put in a relationship, which became nodes with no
 * edges. Measured on the live graph before this ran: 441 nodes, 132 edges, and
 * **62% of nodes isolated**. A reader could not reach them, and neither could
 * traversal — they were in the corpus and absent from the knowledge.
 *
 * `nodes.paper_id` already records which paper created each entity, so this is a
 * backfill of a fact we stored, not an inference. Every edge gets a provenance
 * row like any other (invariant 7): an edge no source supports is an
 * unfalsifiable claim, and a backfill is not an excuse to make one.
 *
 *   pnpm --filter api backfill:mentions            # report what it would do
 *   pnpm --filter api backfill:mentions -- --apply # write it
 */

import 'dotenv/config';
import { db, closeDb } from './index';
import { sql } from 'drizzle-orm';

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');

  const [before] = (await db.execute(sql`
    select
      (select count(*) from nodes)::int as nodes,
      (select count(*) from edges)::int as edges,
      (select count(*) from nodes n
        where not exists (select 1 from edges e
                          where e.source_id = n.id or e.target_id = n.id))::int as isolated
  `)) as unknown as Array<{ nodes: number; edges: number; isolated: number }>;

  const pct = (n: number) => ((100 * n) / Math.max(before.nodes, 1)).toFixed(1);
  console.log(
    `\nBefore: ${before.nodes} nodes, ${before.edges} edges ` +
      `(${(before.edges / Math.max(before.nodes, 1)).toFixed(2)} per node), ` +
      `${before.isolated} isolated (${pct(before.isolated)}%)`
  );

  // Candidates: an entity, the paper node of the paper that created it, and no
  // mention edge between them yet.
  const [candidate] = (await db.execute(sql`
    select count(*)::int as n
    from nodes entity
    join nodes paper_node
      on paper_node.paper_id = entity.paper_id and paper_node.type = 'paper'
    where entity.paper_id is not null
      and entity.type <> 'paper'
      and entity.id <> paper_node.id
      and not exists (
        select 1 from edges e
        where e.source_id = paper_node.id and e.target_id = entity.id and e.type = 'mentions'
      )
  `)) as unknown as Array<{ n: number }>;

  console.log(`Missing mention edges: ${candidate.n}`);

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to write them.\n');
    await closeDb();
    return;
  }

  // One transaction: an edge and its provenance are written together or not at
  // all, exactly as the pipeline does it.
  const written = await db.transaction(async (tx) => {
    const inserted = (await tx.execute(sql`
      with candidates as (
        select paper_node.id as paper_node_id, entity.id as entity_id,
               entity.domain as domain, entity.paper_id as paper_id
        from nodes entity
        join nodes paper_node
          on paper_node.paper_id = entity.paper_id and paper_node.type = 'paper'
        where entity.paper_id is not null
          and entity.type <> 'paper'
          and entity.id <> paper_node.id
          and not exists (
            select 1 from edges e
            where e.source_id = paper_node.id and e.target_id = entity.id and e.type = 'mentions'
          )
      ),
      new_edges as (
        insert into edges (source_id, target_id, type, domain, confidence)
        select paper_node_id, entity_id, 'mentions', domain, 1.00 from candidates
        returning id, target_id
      )
      insert into sources (edge_id, paper_id, section, extracted_text)
      select ne.id, c.paper_id, 'backfill',
             'Backfilled: this paper''s extraction created this entity.'
      from new_edges ne join candidates c on c.entity_id = ne.target_id
      returning id
    `)) as unknown as Array<{ id: string }>;
    return inserted.length;
  });

  const [after] = (await db.execute(sql`
    select
      (select count(*) from nodes)::int as nodes,
      (select count(*) from edges)::int as edges,
      (select count(*) from nodes n
        where not exists (select 1 from edges e
                          where e.source_id = n.id or e.target_id = n.id))::int as isolated
  `)) as unknown as Array<{ nodes: number; edges: number; isolated: number }>;

  console.log(`\nWrote ${written} mention edge(s) with provenance.`);
  console.log(
    `After:  ${after.nodes} nodes, ${after.edges} edges ` +
      `(${(after.edges / Math.max(after.nodes, 1)).toFixed(2)} per node), ` +
      `${after.isolated} isolated (${((100 * after.isolated) / Math.max(after.nodes, 1)).toFixed(1)}%)\n`
  );

  await closeDb();
}

main().catch(async (err) => {
  console.error('Backfill failed:', err instanceof Error ? err.message : err);
  await closeDb().catch(() => {});
  process.exit(1);
});
