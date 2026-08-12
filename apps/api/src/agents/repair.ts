/**
 * Agentic graph repair.
 *
 * The Validator agent checks relationships at *insertion* time, but the graph
 * drifts: confidence stays low, later papers create temporal impossibilities, two
 * methods end up each "extending" the other. This auditor periodically re-examines
 * suspect edges against their recorded provenance and an LLM judge, then keeps,
 * re-weights, or retracts them — closing the loop the Validator opens.
 *
 * It is read-only by default (`apply: false`) so a run can be inspected before any
 * mutation. Detection (which edges are suspect) is pure graph/date logic with zero
 * LLM calls; only the per-edge verdict spends one call, capped by `maxEdges`.
 */

import { db } from '../db';
import { edges, nodes, papers, sources } from '../db/schema';
import { eq, inArray } from 'drizzle-orm';
import { domainWhere } from '../domains/filter';
import { getDomain } from '../domains';
import { generateStructuredCompletion } from '../services/ollama';
import { createRepairSystemPrompt, createRepairUserPrompt } from './prompts/repair';

export type RepairReason =
  | 'low_confidence'
  | 'temporal_contradiction'
  | 'mutual_contradiction';

export interface RepairOptions {
  domain?: string;
  /** Edges with confidence <= this are flagged as low-confidence. */
  confidenceThreshold?: number;
  /** Max edges to send to the LLM judge in one run. */
  maxEdges?: number;
  /** Actually mutate the graph. Default false (dry run). */
  apply?: boolean;
}

export interface RepairAction {
  edgeId: string;
  source: string;
  target: string;
  type: string;
  reasons: RepairReason[];
  verdict: 'keep' | 'retract' | 'adjust';
  oldConfidence: number;
  newConfidence?: number;
  rationale: string;
  applied: boolean;
}

export interface RepairReport {
  domain: string;
  scannedEdges: number;
  flagged: number;
  judged: number;
  applied: boolean;
  actions: RepairAction[];
}

interface JudgeResult {
  verdict?: 'keep' | 'retract' | 'adjust';
  confidence?: number;
  rationale?: string;
}

export async function repairGraph(opts: RepairOptions = {}): Promise<RepairReport> {
  const domain = getDomain(opts.domain);
  const confidenceThreshold = opts.confidenceThreshold ?? 0.5;
  const maxEdges = opts.maxEdges ?? 25;
  const apply = opts.apply ?? false;
  const hierTypes = new Set(domain.hierarchicalEdgeTypes ?? ['extends', 'improves', 'cites']);
  const contradictoryTypes = new Set(['extends', 'improves']);

  const edgeRows = await db
    .select({
      id: edges.id,
      sourceId: edges.sourceId,
      targetId: edges.targetId,
      type: edges.type,
      confidence: edges.confidence,
    })
    .from(edges)
    .where(domainWhere(edges.domain, domain.id));

  const nodeRows = await db
    .select({ id: nodes.id, name: nodes.name, paperId: nodes.paperId })
    .from(nodes)
    .where(domainWhere(nodes.domain, domain.id));
  const nodeMap = new Map(nodeRows.map((n) => [n.id, n]));

  // Publication dates for temporal checks.
  const paperIds = [...new Set(nodeRows.map((n) => n.paperId).filter((p): p is string => !!p))];
  const dateMap = new Map<string, string>();
  if (paperIds.length > 0) {
    const paperRows = await db
      .select({ id: papers.id, publicationDate: papers.publicationDate })
      .from(papers)
      .where(inArray(papers.id, paperIds));
    for (const p of paperRows) if (p.publicationDate) dateMap.set(p.id, p.publicationDate);
  }

  const nodeDate = (nodeId: string): string | undefined => {
    const pid = nodeMap.get(nodeId)?.paperId;
    return pid ? dateMap.get(pid) : undefined;
  };

  // --- Detection (no LLM) ---------------------------------------------------
  const reasonsByEdge = new Map<string, Set<RepairReason>>();
  const flag = (id: string, reason: RepairReason) => {
    if (!reasonsByEdge.has(id)) reasonsByEdge.set(id, new Set());
    reasonsByEdge.get(id)!.add(reason);
  };

  // Index for mutual-contradiction lookup: "src→tgt:type".
  const directed = new Set(edgeRows.map((e) => `${e.sourceId}→${e.targetId}:${e.type}`));

  for (const e of edgeRows) {
    const conf = e.confidence ? Number(e.confidence) : 0.5;
    if (conf <= confidenceThreshold) flag(e.id, 'low_confidence');

    // Temporal: for a hierarchical edge, the source (deriving work) must not be
    // OLDER than the target (the work it builds on).
    if (hierTypes.has(e.type)) {
      const sd = nodeDate(e.sourceId);
      const td = nodeDate(e.targetId);
      if (sd && td && sd < td) flag(e.id, 'temporal_contradiction');
    }

    // Mutual: A→B and B→A with a directional type can't both hold.
    if (contradictoryTypes.has(e.type) && directed.has(`${e.targetId}→${e.sourceId}:${e.type}`)) {
      flag(e.id, 'mutual_contradiction');
    }
  }

  const flaggedEdges = edgeRows.filter((e) => reasonsByEdge.has(e.id));
  const toJudge = flaggedEdges.slice(0, maxEdges);

  // --- Judgement (1 LLM call per edge) + optional apply ---------------------
  const system = createRepairSystemPrompt(domain.name);
  const actions: RepairAction[] = [];

  for (const e of toJudge) {
    const reasons = [...reasonsByEdge.get(e.id)!];
    const sourceName = nodeMap.get(e.sourceId)?.name ?? e.sourceId;
    const targetName = nodeMap.get(e.targetId)?.name ?? e.targetId;
    const oldConfidence = e.confidence ? Number(e.confidence) : 0.5;

    const evidenceRows = await db
      .select({ extractedText: sources.extractedText })
      .from(sources)
      .where(eq(sources.edgeId, e.id))
      .limit(5);
    const evidence = evidenceRows.map((r) => r.extractedText).filter((t): t is string => !!t);

    const user = createRepairUserPrompt(
      { source: sourceName, type: e.type, target: targetName, confidence: oldConfidence },
      reasons.join(', '),
      evidence
    );

    const judged = await generateStructuredCompletion<JudgeResult>(
      system,
      user,
      null,
      0,
      2,
      'repair'
    );

    const verdict = judged.verdict ?? 'keep';
    let newConfidence: number | undefined;
    if (verdict === 'adjust' && typeof judged.confidence === 'number') {
      newConfidence = Math.max(0, Math.min(0.99, judged.confidence));
    }

    let applied = false;
    if (apply) {
      if (verdict === 'retract') {
        await db.delete(edges).where(eq(edges.id, e.id)); // cascades to sources
        applied = true;
      } else if (verdict === 'adjust' && newConfidence !== undefined) {
        await db.update(edges).set({ confidence: newConfidence.toFixed(2) }).where(eq(edges.id, e.id));
        applied = true;
      }
    }

    actions.push({
      edgeId: e.id,
      source: sourceName,
      target: targetName,
      type: e.type,
      reasons,
      verdict,
      oldConfidence,
      newConfidence,
      rationale: judged.rationale ?? '',
      applied,
    });
  }

  return {
    domain: domain.id,
    scannedEdges: edgeRows.length,
    flagged: flaggedEdges.length,
    judged: toJudge.length,
    applied: apply,
    actions,
  };
}
