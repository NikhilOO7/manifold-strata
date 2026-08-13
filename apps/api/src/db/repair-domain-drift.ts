/**
 * Find and repair rows whose domain disagrees with their paper's.
 *
 * Invariant 4 says a paper and its extracted entities must never disagree about
 * which domain they are in. Moving a paper between domains broke that: the move
 * cleared the paper's edges but kept its nodes, because
 * `clearPaperContributions` is written for same-domain reprocessing where nodes
 * are canonical and shared. Across a move the reasoning inverts — the nodes carry
 * the old domain stamp and the paper has left.
 *
 * Observed on the live graph: every paper in `nlp`, and 535 nodes still stamped
 * `default`, one paper alone owning 255 of them. They are unreachable from any
 * paper, they inflate every count, and they made the Explorer list the same
 * document twice.
 *
 * The route no longer creates this state. This repairs corpora that already have
 * it, and doubles as an audit: run it with no flag to find out whether any drift
 * exists at all.
 *
 *   pnpm --filter api repair:domain-drift            # report
 *   pnpm --filter api repair:domain-drift -- --apply # fix
 */

import 'dotenv/config';
import { db, closeDb } from './index';
import { sql } from 'drizzle-orm';

interface Drift {
  paper: string;
  paper_domain: string;
  node_domain: string;
  nodes: number;
  with_edges: number;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');

  const drift = (await db.execute(sql`
    select left(p.title, 44) as paper,
           coalesce(p.domain, '(null)') as paper_domain,
           coalesce(n.domain, '(null)') as node_domain,
           count(*)::int as nodes,
           count(*) filter (where exists (
             select 1 from edges e where e.source_id = n.id or e.target_id = n.id
           ))::int as with_edges
    from nodes n
    join papers p on p.id = n.paper_id
    where n.domain is distinct from p.domain
    group by 1, 2, 3
    order by 4 desc
  `)) as unknown as Drift[];

  if (drift.length === 0) {
    console.log('\nNo domain drift. Every node agrees with its paper.\n');
    await closeDb();
    return;
  }

  console.log('\nNodes whose domain disagrees with their paper:\n');
  for (const d of drift) {
    console.log(
      `  ${d.paper.padEnd(46)} paper=${d.paper_domain.padEnd(9)} nodes=${d.node_domain.padEnd(9)} ` +
        `${d.nodes} node(s), ${d.with_edges} still connected`
    );
  }
  const total = drift.reduce((a, d) => a + d.nodes, 0);
  console.log(`\n  ${total} drifted node(s) across ${drift.length} group(s).`);

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to repair.\n');
    await closeDb();
    return;
  }

  // Delete the drifted rows and everything that depended on them.
  //
  // Their edges go too: an edge between a drifted node and anything else is
  // stamped with a domain no paper occupies, so it can never be traversed and
  // can never be repaired — its provenance points at a paper that has moved.
  // `sources` and `node_vectors` cascade from `edges` and `nodes` respectively.
  const result = await db.transaction(async (tx) => {
    const edgesGone = (await tx.execute(sql`
      with drifted as (
        select n.id from nodes n join papers p on p.id = n.paper_id
        where n.domain is distinct from p.domain
      )
      delete from edges e
      where e.source_id in (select id from drifted) or e.target_id in (select id from drifted)
      returning e.id
    `)) as unknown as Array<{ id: string }>;

    // Propositions reference nodes by id inside a jsonb array.
    await tx.execute(sql`
      delete from propositions p
      where exists (
        select 1
        from jsonb_array_elements_text(p.node_ids) as elem
        join nodes n on n.id::text = elem
        join papers pp on pp.id = n.paper_id
        where n.domain is distinct from pp.domain
      )
    `);

    const nodesGone = (await tx.execute(sql`
      delete from nodes n
      using papers p
      where p.id = n.paper_id and n.domain is distinct from p.domain
      returning n.id
    `)) as unknown as Array<{ id: string }>;

    return { edges: edgesGone.length, nodes: nodesGone.length };
  });

  console.log(`\n  Removed ${result.nodes} node(s) and ${result.edges} edge(s).`);

  const [after] = (await db.execute(sql`
    select
      (select count(*) from nodes)::int as nodes,
      (select count(*) from edges)::int as edges,
      (select count(*) from nodes n join papers p on p.id = n.paper_id
        where n.domain is distinct from p.domain)::int as remaining_drift
  `)) as unknown as Array<{ nodes: number; edges: number; remaining_drift: number }>;

  console.log(
    `  Graph is now ${after.nodes} nodes / ${after.edges} edges, ` +
      `${after.remaining_drift} drifted.\n`
  );

  await closeDb();
}

main().catch(async (err) => {
  console.error('Repair failed:', err instanceof Error ? err.message : err);
  await closeDb().catch(() => {});
  process.exit(1);
});
