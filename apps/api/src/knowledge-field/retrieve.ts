/**
 * Field retrieval orchestrator.
 *
 *   embed(query) → seed nodes (cosine) → Personalized PageRank → gather
 *   propositions for the high-ranked nodes → MMR compression → (optional) ONE
 *   verbalize LLM call.
 *
 * The only LLM call in the whole flow is the final verbalization — multi-hop
 * reasoning and evidence selection happen in vector/graph space.
 */

import { db } from '../db';
import { nodes, edges, nodeVectors, propositions } from '../db/schema';
import { isNotNull, and } from 'drizzle-orm';
import { getDomain } from '../domains';
import { domainWhere } from '../domains/filter';
import { embedOne, cosine } from '../services/embeddings';
import { generateCompletion } from '../services/ollama';
import { personalizedPageRank, type GraphEdge } from './ppr';
import { mmrSelect } from './compress';

export interface RetrievedEvidence {
  text: string;
  nodeIds: string[];
  score: number;
}

export interface RetrieveResult {
  seeds: Array<{ id: string; name: string; score: number }>;
  rankedNodes: Array<{ id: string; name: string; type: string; score: number }>;
  evidence: RetrievedEvidence[];
  contextChars: number;
}

export interface RetrieveOptions {
  seedK?: number;       // how many entry nodes
  topNodes?: number;    // how many PPR nodes to gather propositions from
  maxEvidence?: number; // MMR item cap
  maxChars?: number;    // MMR budget
  domain?: string;      // scope retrieval to one domain (default: 'default' + legacy null)
}

export async function retrieveField(
  question: string,
  opts: RetrieveOptions = {}
): Promise<RetrieveResult> {
  const seedK = opts.seedK ?? 5;
  const topNodes = opts.topNodes ?? 25;
  const maxEvidence = opts.maxEvidence ?? 10;
  const maxChars = opts.maxChars ?? 2000;

  const domainId = getDomain(opts.domain).id;
  const qvec = await embedOne(question, 'query');

  // Node metadata + vectors — scoped to the requested domain.
  const allNodes = await db.select().from(nodes).where(domainWhere(nodes.domain, domainId));
  const nodeMeta = new Map<string, { name: string; type: string }>();
  const nodeIdSet = new Set<string>();
  for (const n of allNodes) {
    nodeMeta.set(n.id, { name: n.name, type: n.type });
    nodeIdSet.add(n.id);
  }

  // nodeVectors has no domain column; restrict to vectors of in-domain nodes.
  const vecRows = (
    await db.select({ nodeId: nodeVectors.nodeId, embedding: nodeVectors.embedding }).from(nodeVectors)
  ).filter((v) => nodeIdSet.has(v.nodeId));

  // Seeds: nodes whose embedding is closest to the query.
  const seedScores = vecRows
    .map((v) => ({ id: v.nodeId, score: cosine(qvec, v.embedding as number[]) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, seedK);

  const seeds = new Map<string, number>();
  for (const s of seedScores) if (s.score > 0) seeds.set(s.id, s.score);

  // Edges → PPR (same domain).
  const edgeRows = await db
    .select({ sourceId: edges.sourceId, targetId: edges.targetId, confidence: edges.confidence })
    .from(edges)
    .where(domainWhere(edges.domain, domainId));
  const graphEdges: GraphEdge[] = edgeRows.map((e) => ({
    sourceId: e.sourceId,
    targetId: e.targetId,
    weight: e.confidence ? Number(e.confidence) : 0.5,
  }));

  const ppr = personalizedPageRank(
    allNodes.map((n) => n.id),
    graphEdges,
    seeds
  );

  const rankedNodes = [...ppr.entries()]
    .map(([id, score]) => ({
      id,
      name: nodeMeta.get(id)?.name ?? id,
      type: nodeMeta.get(id)?.type ?? 'unknown',
      score,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topNodes);

  const topNodeIds = new Set(rankedNodes.map((n) => n.id));

  // Candidate propositions: those touching a high-ranked node.
  const propRows = await db
    .select()
    .from(propositions)
    .where(and(isNotNull(propositions.embedding), domainWhere(propositions.domain, domainId)));

  const candidates = propRows
    .map((p) => {
      const ids = (p.nodeIds as string[] | null) ?? [];
      const pprMass = ids.reduce((sum, id) => sum + (ppr.get(id) ?? 0), 0);
      return { p, ids, pprMass };
    })
    .filter((c) => c.ids.some((id) => topNodeIds.has(id)) || c.pprMass > 0)
    .map((c) => ({
      item: { text: c.p.text, nodeIds: c.ids } as RetrievedEvidence,
      vector: c.p.embedding as number[],
      // Blend PPR graph-relevance with a small floor so pure-similarity still ranks.
      prior: 1 + c.pprMass * 50,
      cost: c.p.text.length,
    }));

  const selected = mmrSelect(qvec, candidates, {
    lambda: 0.7,
    maxItems: maxEvidence,
    maxCost: maxChars,
  });

  const evidence: RetrievedEvidence[] = selected.map((s) => ({
    text: s.item.text,
    nodeIds: s.item.nodeIds,
    score: s.score,
  }));

  return {
    seeds: seedScores.map((s) => ({ id: s.id, name: nodeMeta.get(s.id)?.name ?? s.id, score: s.score })),
    rankedNodes,
    evidence,
    contextChars: evidence.reduce((sum, e) => sum + e.text.length, 0),
  };
}

export interface FieldQueryResult extends RetrieveResult {
  answer: string;
  llmCalls: number; // LLM calls used by THIS query (0 or 1)
}

export async function fieldQuery(
  question: string,
  opts: RetrieveOptions & { verbalize?: boolean } = {}
): Promise<FieldQueryResult> {
  const result = await retrieveField(question, opts);
  const verbalize = opts.verbalize !== false;

  if (!verbalize || result.evidence.length === 0) {
    return { ...result, answer: '', llmCalls: 0 };
  }

  const context = result.evidence
    .map((e, i) => `[${i + 1}] ${e.text}`)
    .join('\n');

  const system =
    'You are a knowledge-graph assistant. Answer the question using ONLY the ' +
    'numbered evidence provided. Be concise. If the evidence is insufficient, say so.';
  const user = `Question: ${question}\n\nEvidence:\n${context}\n\nAnswer:`;

  const completion = await generateCompletion(system, user, 0.2, 'verbalize');

  return { ...result, answer: completion.text.trim(), llmCalls: 1 };
}
