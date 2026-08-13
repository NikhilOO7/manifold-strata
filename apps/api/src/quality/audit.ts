/**
 * Scanning a domain for nodes that should not exist, and pairs that should be one.
 *
 * Runs as a background job, never inside extraction. Two reasons, and the second
 * is the important one:
 *
 *   1. It is not on the critical path. Extraction is GPU-bound and already the
 *      bottleneck; adding graph-wide analysis to it would slow the thing that
 *      matters to improve something that can wait.
 *   2. **It needs to see the finished graph.** Whether "input-feeding approach"
 *      and "our input-feeding approach" are one entity is a question about the
 *      corpus, not about the chunk being processed. At write time, resolution has
 *      only the mention in front of it; afterwards, the duplicate is obvious.
 *      A cleaner that ran per-chunk would be asking the same question resolution
 *      already answered, with the same information, and would get the same answer.
 *
 * It writes findings, not changes. Applying is a separate, explicit act — see
 * `applyFinding`. The asymmetry from the merge guard applies with more force
 * here: a wrong drop destroys evidence permanently and there is no record it
 * ever existed.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { nodes, edges, graphFindings, sources, propositions } from '../db/schema';
import { DEFAULT_DOMAIN_ID } from '../domains';
import { judgeName, judgeConnectivity, judgePair, type Candidate, type Verdict } from './detectors';

export interface AuditSummary {
  domain: string;
  scanned: number;
  findings: number;
  byVerdict: Record<string, number>;
}

/** Scoped exactly like every other read: the default domain also owns null. */
function domainPredicate(domainId: string) {
  return domainId === DEFAULT_DOMAIN_ID
    ? sql`(n.domain = ${domainId} or n.domain is null)`
    : sql`n.domain = ${domainId}`;
}

export async function auditDomain(domainId: string): Promise<AuditSummary> {
  // Previous proposals for this domain are replaced, not accumulated. A finding
  // is a statement about the graph as it is now; keeping stale ones would leave
  // an operator applying a merge whose target was rebuilt an hour ago.
  await db
    .delete(graphFindings)
    .where(and(eq(graphFindings.domain, domainId), eq(graphFindings.status, 'proposed')));

  const rows = (await db.execute(sql`
    select n.id, n.name, n.type,
           (select count(*) from ${edges} e
             where e.source_id = n.id or e.target_id = n.id)::int as degree
    from ${nodes} n
    where ${domainPredicate(domainId)}
  `)) as unknown as Array<{ id: string; name: string; type: string; degree: number }>;

  interface Draft {
    nodeId: string;
    relatedId: string | null;
    detector: string;
    verdict: Verdict;
    reason: string;
    confidence: string;
  }
  const drafts: Draft[] = [];

  // --- Per-node judgements -------------------------------------------------
  for (const row of rows) {
    const name = judgeName(row.name);
    if (name.verdict !== 'keep') {
      drafts.push({
        nodeId: row.id,
        relatedId: null,
        detector: 'malformed-name',
        verdict: name.verdict,
        reason: name.reason,
        confidence: name.confidence,
      });
      // One finding per node. A fragment that is also isolated does not need
      // saying twice, and the name is the more actionable of the two.
      continue;
    }

    const conn = judgeConnectivity(row.degree);
    if (conn.verdict !== 'keep') {
      drafts.push({
        nodeId: row.id,
        relatedId: null,
        detector: 'orphan',
        verdict: conn.verdict,
        reason: conn.reason,
        confidence: conn.confidence,
      });
    }
  }

  // --- Pairs the same paper named ------------------------------------------
  //
  // Restricted to co-mentioned pairs on purpose. Comparing every node against
  // every other is quadratic and, worse, meaningless: two entities from
  // unrelated papers that happen to look alike are resolution's problem, and
  // resolution already refused to merge them for a stated reason.
  const pairs = (await db.execute(sql`
    select a.id as a_id, a.name as a_name, a.type as a_type,
           b.id as b_id, b.name as b_name, b.type as b_type
    from ${edges} ea
    join ${edges} eb on ea.source_id = eb.source_id
    join ${nodes} a on a.id = ea.target_id
    join ${nodes} b on b.id = eb.target_id
    join ${nodes} n on n.id = a.id
    where ea.type = 'mentions' and eb.type = 'mentions'
      and a.id < b.id
      and ${domainPredicate(domainId)}
      -- Cheap prefilter; the detectors make the actual decision.
      and (b.normalized_name like a.normalized_name || '%'
           or a.normalized_name like b.normalized_name || '%'
           or b.normalized_name like '%' || a.normalized_name
           or a.normalized_name like '%' || b.normalized_name)
    limit 2000
  `)) as unknown as Array<{
    a_id: string; a_name: string; a_type: string;
    b_id: string; b_name: string; b_type: string;
  }>;

  const seenPair = new Set<string>();
  for (const p of pairs) {
    const key = `${p.a_id}|${p.b_id}`;
    if (seenPair.has(key)) continue;
    seenPair.add(key);

    const a: Candidate = { id: p.a_id, name: p.a_name, type: p.a_type };
    const b: Candidate = { id: p.b_id, name: p.b_name, type: p.b_type };
    const judged = judgePair(a, b);
    if (judged.verdict === 'keep') continue;

    drafts.push({
      // The node that would disappear is the subject of the finding.
      nodeId: judged.drop?.id ?? a.id,
      relatedId: judged.keep?.id ?? b.id,
      detector: 'duplicate-within-paper',
      verdict: judged.verdict,
      reason: judged.reason,
      confidence: judged.confidence,
    });
  }

  if (drafts.length > 0) {
    await db.insert(graphFindings).values(
      drafts.map((d) => ({
        domain: domainId,
        nodeId: d.nodeId,
        relatedNodeId: d.relatedId,
        detector: d.detector,
        verdict: d.verdict,
        reason: d.reason,
        confidence: d.confidence,
        status: 'proposed' as const,
      }))
    );
  }

  const byVerdict: Record<string, number> = {};
  for (const d of drafts) byVerdict[d.verdict] = (byVerdict[d.verdict] ?? 0) + 1;

  return { domain: domainId, scanned: rows.length, findings: drafts.length, byVerdict };
}

/**
 * Carry out one proposal.
 *
 * `merge` repoints every reference and deletes the loser; `drop` deletes the
 * node outright. Both are transactional, and both mark the finding `applied` in
 * the same transaction, so a crash cannot leave a proposal that was half-acted
 * on and still looks pending.
 */
export async function applyFinding(findingId: string): Promise<{ applied: string }> {
  return db.transaction(async (tx) => {
    const [finding] = await tx
      .select()
      .from(graphFindings)
      .where(eq(graphFindings.id, findingId))
      .limit(1);
    if (!finding) throw new Error(`Finding ${findingId} not found.`);
    if (finding.status !== 'proposed') throw new Error(`Finding ${findingId} is already ${finding.status}.`);

    if (finding.verdict === 'merge' && finding.relatedNodeId) {
      const keep = finding.relatedNodeId;
      const drop = finding.nodeId;

      await tx.execute(sql`update ${edges} set source_id = ${keep} where source_id = ${drop}`);
      await tx.execute(sql`update ${edges} set target_id = ${keep} where target_id = ${drop}`);
      // Repointing can produce a self-edge, which is not a claim.
      await tx.execute(sql`delete from ${edges} where source_id = target_id`);
      // …and exact duplicates. Keep one, move its provenance onto it.
      await tx.execute(sql`
        with dupes as (
          select id, (array_agg(id) over (
            partition by source_id, target_id, type order by created_at
          ))[1] as keeper
          from ${edges}
        ), losers as (select id, keeper from dupes where id <> keeper)
        update ${sources} s set edge_id = l.keeper from losers l where s.edge_id = l.id
      `);
      await tx.execute(sql`
        delete from ${edges} e where exists (
          select 1 from ${edges} k
          where k.source_id = e.source_id and k.target_id = e.target_id
            and k.type = e.type and k.created_at < e.created_at
        )
      `);
      await tx.execute(sql`
        update ${propositions} p
        set node_ids = (
          select jsonb_agg(distinct case when elem = ${drop} then ${keep} else elem end)
          from jsonb_array_elements_text(p.node_ids) as elem
        )
        where p.node_ids ? ${drop}
      `);
      await tx.delete(nodes).where(eq(nodes.id, drop));
    } else if (finding.verdict === 'drop') {
      // Edges and provenance cascade from the node.
      await tx.delete(nodes).where(eq(nodes.id, finding.nodeId));
    } else {
      throw new Error(`Finding ${findingId} is a "${finding.verdict}" — it has no automatic action.`);
    }

    await tx
      .update(graphFindings)
      .set({ status: 'applied', resolvedAt: new Date() })
      .where(eq(graphFindings.id, findingId));

    return { applied: finding.verdict };
  });
}

/** Record that a human looked and disagreed. Kept, not deleted — see below. */
export async function dismissFindings(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await db
    .update(graphFindings)
    // Dismissals persist so the next audit does not re-propose something a human
    // has already rejected. A tool that keeps asking gets ignored.
    .set({ status: 'dismissed', resolvedAt: new Date() })
    .where(and(inArray(graphFindings.id, ids), eq(graphFindings.status, 'proposed')))
    .returning({ id: graphFindings.id });
  return rows.length;
}
