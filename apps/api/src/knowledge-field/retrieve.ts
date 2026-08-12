/**
 * Field retrieval orchestrator.
 *
 *   embed(query) → ANN seed lookup → bounded neighbourhood expansion →
 *   Personalized PageRank → three-signal evidence gathering → rank fusion →
 *   MMR compression → (optional) ONE verbalize LLM call.
 *
 * Retrieval fuses graph, vector and lexical signals rather than choosing one.
 * Measurement drove that: the graph signal is the only one that answers
 * multi-hop questions at all, and plain lexical ranking was beating the graph
 * pipeline outright on direct lookups. Fusing them scored better than any of
 * them alone on every question family (see PLAN.md §10, Phase 2).
 *
 * The only LLM call in the whole flow is the final verbalization — multi-hop
 * reasoning and evidence selection happen in vector/graph space.
 *
 * ## Why the work is bounded
 *
 * This used to load the entire corpus per query: every node in the domain, every
 * vector in the *database* (no filter at all), every edge, and every proposition,
 * then scored them in JavaScript. Embeddings are ~30 KB of JSONB each, so a
 * 10,000-entity corpus moved roughly 300 MB per question and a realistic one was
 * simply impossible. Retrieval is now bounded by its own parameters rather than
 * by corpus size:
 *
 *   seeds        ANN over an HNSW index — Postgres returns `seedK` rows
 *   graph        neighbourhood expanded `expandHops` from the seeds, capped at
 *                `maxSubgraphNodes`; PPR then runs over that subgraph in memory
 *   evidence     three index-backed signals (graph attachment, ANN similarity,
 *                lexical rank) fused by RRF and capped before MMR — which
 *                matters because MMR is quadratic in its candidate set
 *
 * Nothing in the hot path scans a table. Multi-hop reasoning survives because
 * the expansion is what defines "multi-hop": three hops from the seeds is the
 * same reachable set PPR would have explored, minus the mass it would have spent
 * on unreachable regions of the graph.
 */

import { db } from '../db';
import { nodes, edges, nodeVectors, propositions } from '../db/schema';
import { and, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { resolveDomain, DEFAULT_DOMAIN_ID } from '../domains';
import { domainWhere } from '../domains/filter';
import { embedOne } from '../services/embeddings';
import { toVectorLiteral, assertVectorShape } from '../services/embedding-space';
import { generateCompletion } from '../services/llm';
import { personalizedPageRank, type GraphEdge } from './ppr';
import { mmrSelect } from './compress';
import { reciprocalRankFusion, normalizeFusedScores } from './fuse';

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
  /** Sizes of each bounded stage — the proof that nothing scanned the corpus. */
  stats: {
    seedCount: number;
    subgraphNodes: number;
    subgraphEdges: number;
    candidateEvidence: number;
    truncated: boolean;
  };
}

export interface RetrieveOptions {
  seedK?: number;            // how many entry nodes
  topNodes?: number;         // how many PPR nodes to gather evidence from
  maxEvidence?: number;      // MMR item cap
  maxChars?: number;         // MMR budget
  domain?: string;           // scope retrieval to one domain
  expandHops?: number;       // neighbourhood radius around the seeds
  maxSubgraphNodes?: number; // hard ceiling on the PPR working set
  maxCandidates?: number;    // hard ceiling on the MMR candidate set
  /**
   * Pre-computed query embedding, skipping the provider round-trip. For callers
   * that already hold the vector (caches, benchmarks, tests) — it must come from
   * this deployment's embedding space or the ANN search is meaningless.
   */
  queryVector?: number[];
  /**
   * PPR restart probability. Exposed so the evaluation harness can sweep it
   * against measured retrieval quality rather than leaving the default to
   * argument; see `pnpm --filter api eval -- --sweep-alpha`.
   */
  pprAlpha?: number;
  /**
   * Relative influence of each retrieval signal in the fusion. Setting one to 0
   * disables it, which is how the evaluation harness isolates a single signal.
   */
  weights?: { graph?: number; vector?: number; lexical?: number };
}

const DEFAULTS = {
  seedK: 8,
  topNodes: 25,
  maxEvidence: 10,
  maxChars: 2000,
  // Three hops covers the multi-hop questions the field is built for
  // ("what improves something that extends X?") without unbounded fan-out.
  expandHops: 3,
  maxSubgraphNodes: 4000,
  maxCandidates: 400,
  /**
   * Fusion weights, chosen by sweep (`pnpm --filter api eval -- --sweep-weights`).
   *
   * Equal weights cost multi-hop recall: the graph list is the only signal that
   * can surface an answer whose wording has nothing in common with the question,
   * and diluting it one-to-one against two lexical/semantic signals pushed such
   * answers out of the top k (recall 100% → 95%, nDCG 63.1% → 54.8%). Doubling
   * the graph weight restores multi-hop completely without costing anything
   * elsewhere — hub and single-hop questions stay at 100% nDCG. Weights of 3 and
   * 4 measured identically to 2, so 2 is the smallest value that buys the gain.
   */
  weights: { graph: 2, vector: 1, lexical: 1 },
};

/**
 * Nearest neighbours by cosine distance, resolved in Postgres.
 *
 * `<=>` is pgvector's cosine-distance operator and is what the HNSW index is
 * built on; similarity is `1 - distance`. Domain scoping is applied inside the
 * same statement so the index search itself is filtered rather than the results
 * being trimmed afterwards.
 */
async function annSeeds(
  queryVector: number[],
  domainId: string,
  limit: number
): Promise<Array<{ id: string; name: string; type: string; score: number }>> {
  const literal = toVectorLiteral(queryVector);
  const domainPredicate =
    domainId === DEFAULT_DOMAIN_ID
      ? sql`(${nodes.domain} = ${domainId} or ${nodes.domain} is null)`
      : sql`${nodes.domain} = ${domainId}`;

  const rows = await db
    .select({
      id: nodes.id,
      name: nodes.name,
      type: nodes.type,
      distance: sql<number>`${nodeVectors.embeddingVec} <=> ${literal}::vector`,
    })
    .from(nodeVectors)
    .innerJoin(nodes, eq(nodeVectors.nodeId, nodes.id))
    .where(and(isNotNull(nodeVectors.embeddingVec), domainPredicate))
    .orderBy(sql`${nodeVectors.embeddingVec} <=> ${literal}::vector`)
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    score: 1 - Number(r.distance),
  }));
}

/**
 * Expand outward from the seeds, one hop at a time, staying inside the domain.
 *
 * Both endpoints of every edge are checked against the domain — an edge's own
 * stamp does not prove where the node on the far end lives, and following one
 * that crosses a boundary would pull another field's graph into the answer.
 */
async function expandNeighbourhood(
  seedIds: string[],
  domainId: string,
  hops: number,
  maxNodes: number
): Promise<{ nodeIds: string[]; edges: GraphEdge[]; truncated: boolean }> {
  const visited = new Set<string>(seedIds);
  const collected = new Map<string, GraphEdge>();
  let frontier = seedIds;
  let truncated = false;

  for (let hop = 0; hop < hops && frontier.length > 0; hop++) {
    if (visited.size >= maxNodes) {
      truncated = true;
      break;
    }

    // One round trip per hop. Joining both endpoints back to `nodes` proves each
    // is in-domain inside the same statement — previously this was a second
    // query per hop, doubling latency for a check the database can do in the
    // join. Both endpoints are verified because an edge's own domain stamp does
    // not say where the node on the far end lives.
    const sourceNodes = alias(nodes, 'expand_source');
    const targetNodes = alias(nodes, 'expand_target');

    const rows = await db
      .select({
        id: edges.id,
        sourceId: edges.sourceId,
        targetId: edges.targetId,
        confidence: edges.confidence,
      })
      .from(edges)
      .innerJoin(sourceNodes, eq(edges.sourceId, sourceNodes.id))
      .innerJoin(targetNodes, eq(edges.targetId, targetNodes.id))
      .where(
        and(
          or(inArray(edges.sourceId, frontier), inArray(edges.targetId, frontier)),
          domainWhere(edges.domain, domainId),
          domainWhere(sourceNodes.domain, domainId),
          domainWhere(targetNodes.domain, domainId)
        )
      )
      // Bound the fan-out of a single hop: a hub node can have tens of thousands
      // of edges, and pulling all of them would reintroduce the unbounded read
      // this design exists to remove.
      .limit(maxNodes * 4);

    if (rows.length === 0) break;

    const next: string[] = [];
    for (const e of rows) {
      collected.set(e.id, {
        sourceId: e.sourceId,
        targetId: e.targetId,
        weight: e.confidence ? Number(e.confidence) : 0.5,
      });
      for (const nid of [e.sourceId, e.targetId]) {
        if (visited.has(nid)) continue;
        if (visited.size >= maxNodes) {
          truncated = true;
          continue;
        }
        visited.add(nid);
        next.push(nid);
      }
    }
    frontier = next;
  }

  return { nodeIds: [...visited], edges: [...collected.values()], truncated };
}

/**
 * Candidate evidence, from three independent signals.
 *
 * Each answers a different question, and measurement showed each is the *only*
 * one that answers some family of questions well:
 *
 *   graph    "what do we know about the entities this question is about" — the
 *            only signal that reaches an answer two hops away whose wording has
 *            nothing in common with the question (100% recall on multi-hop where
 *            the other two score 0%)
 *   vector   "what reads like the question" — catches paraphrase, where lexical
 *            matching fails
 *   lexical  "what contains these exact words" — near-perfect on direct lookups,
 *            where the graph pipeline alone buried the answer at rank eight
 *
 * They are combined by rank fusion rather than by picking one, because the
 * evidence says they are complementary. All three are index-backed and capped.
 */
async function gatherCandidates(
  question: string,
  queryVector: number[],
  domainId: string,
  topNodeIds: string[],
  maxCandidates: number
) {
  const literal = toVectorLiteral(queryVector);
  // Each signal gets its own depth rather than a third of a shared budget.
  // Splitting one budget three ways shortened the graph list enough to drop a
  // multi-hop answer out of the candidate set entirely (recall 100% → 95%) —
  // the fused set is capped after deduplication instead, which is what actually
  // needs bounding, since MMR is quadratic in its input.
  const perSignal = Math.max(1, Math.ceil(maxCandidates / 2));

  // `embeddingVec` rather than the JSONB `embedding`: pgvector stores float4
  // packed, while the JSONB copy is decimal text at roughly five times the size.
  // Reading the JSONB here pulled ~15 KB per candidate over the wire and, more
  // damagingly, kept the vector tables large enough to evict the HNSW indexes
  // from the buffer cache — measured as a 1.8x latency regression when the
  // corpus doubled, despite the working set staying flat.
  const byGraph = topNodeIds.length
    ? await db
        .select({
          id: propositions.id,
          text: propositions.text,
          nodeIds: propositions.nodeIds,
          embedding: propositions.embeddingVec,
        })
        .from(propositions)
        .where(
          and(
            isNotNull(propositions.embeddingVec),
            domainWhere(propositions.domain, domainId),
            // GIN-indexed containment: "mentions any of these node ids".
            // `jsonb_exists_any` is the function form of the `?|` operator.
            // Each id is bound as its own parameter — a JS array handed to the
            // driver whole arrives as a record, not a text[], and interpolating
            // the ids into the SQL text would splice values into the statement.
            sql`jsonb_exists_any(${propositions.nodeIds}, ARRAY[${sql.join(
              topNodeIds.map((id) => sql`${id}`),
              sql`, `
            )}]::text[])`
          )
        )
        .limit(perSignal)
    : [];

  const bySimilarity = await db
    .select({
      id: propositions.id,
      text: propositions.text,
      nodeIds: propositions.nodeIds,
      embedding: propositions.embeddingVec,
    })
    .from(propositions)
    .where(and(isNotNull(propositions.embeddingVec), domainWhere(propositions.domain, domainId)))
    .orderBy(sql`${propositions.embeddingVec} <=> ${literal}::vector`)
    .limit(perSignal);

  // Lexical ranking, backed by the expression GIN index on to_tsvector(text).
  // `plainto_tsquery` treats the question as a bag of words rather than an
  // operator expression, so punctuation in a user question cannot become syntax.
  const byKeyword = question.trim()
    ? await db
        .select({
          id: propositions.id,
          text: propositions.text,
          nodeIds: propositions.nodeIds,
          embedding: propositions.embeddingVec,
        })
        .from(propositions)
        .where(
          and(
            isNotNull(propositions.embeddingVec),
            domainWhere(propositions.domain, domainId),
            sql`to_tsvector('english', ${propositions.text}) @@ plainto_tsquery('english', ${question})`
          )
        )
        .orderBy(
          sql`ts_rank(to_tsvector('english', ${propositions.text}), plainto_tsquery('english', ${question})) desc`
        )
        .limit(perSignal)
    : [];

  type Candidate = {
    id: string;
    text: string;
    nodeIds: unknown;
    embedding: number[] | null;
  };

  const byId = new Map<string, Candidate>();
  for (const row of [...byGraph, ...bySimilarity, ...byKeyword] as Candidate[]) {
    byId.set(row.id, row);
  }

  return {
    byId,
    rankings: {
      graph: (byGraph as Candidate[]).map((r) => r.id),
      vector: (bySimilarity as Candidate[]).map((r) => r.id),
      lexical: (byKeyword as Candidate[]).map((r) => r.id),
    },
  };
}

export async function retrieveField(
  question: string,
  opts: RetrieveOptions = {}
): Promise<RetrieveResult> {
  const seedK = opts.seedK ?? DEFAULTS.seedK;
  const topNodes = opts.topNodes ?? DEFAULTS.topNodes;
  const maxEvidence = opts.maxEvidence ?? DEFAULTS.maxEvidence;
  const maxChars = opts.maxChars ?? DEFAULTS.maxChars;
  const expandHops = opts.expandHops ?? DEFAULTS.expandHops;
  const maxSubgraphNodes = opts.maxSubgraphNodes ?? DEFAULTS.maxSubgraphNodes;
  const maxCandidates = opts.maxCandidates ?? DEFAULTS.maxCandidates;
  const graphWeight = opts.weights?.graph ?? DEFAULTS.weights.graph;
  const vectorWeight = opts.weights?.vector ?? DEFAULTS.weights.vector;
  const lexicalWeight = opts.weights?.lexical ?? DEFAULTS.weights.lexical;

  // Strict: an unregistered domain must not silently degrade into a search over
  // the default domain. Callers that mean "no scope" pass nothing.
  const domainId = resolveDomain(opts.domain).id;
  const qvec = opts.queryVector ?? (await embedOne(question, 'query'));

  // A caller-supplied vector is unvalidated input. Checking it here fails with a
  // message naming the deployment's space, instead of surfacing Postgres's
  // "expected 768 dimensions, not 1536" from three calls deeper.
  assertVectorShape(qvec, 'query vector');

  // 1. Entry points — index lookup, `seedK` rows.
  const seedRows = await annSeeds(qvec, domainId, seedK);
  if (seedRows.length === 0) {
    return {
      seeds: [],
      rankedNodes: [],
      evidence: [],
      contextChars: 0,
      stats: {
        seedCount: 0,
        subgraphNodes: 0,
        subgraphEdges: 0,
        candidateEvidence: 0,
        truncated: false,
      },
    };
  }

  // 2. Working subgraph — bounded expansion, not the whole domain.
  const seedIds = seedRows.map((s) => s.id);
  const { nodeIds, edges: graphEdges, truncated } = await expandNeighbourhood(
    seedIds,
    domainId,
    expandHops,
    maxSubgraphNodes
  );

  // 3. PPR over that subgraph. Restart mass sits on the seeds, weighted by how
  //    well each matched the query.
  const seeds = new Map<string, number>();
  for (const s of seedRows) if (s.score > 0) seeds.set(s.id, s.score);

  const ppr = personalizedPageRank(
    nodeIds,
    graphEdges,
    seeds,
    opts.pprAlpha !== undefined ? { alpha: opts.pprAlpha } : {}
  );

  const nodeMeta = new Map<string, { name: string; type: string }>();
  for (const s of seedRows) nodeMeta.set(s.id, { name: s.name, type: s.type });

  const rankedIds = [...ppr.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topNodes);

  // Names only for the handful we actually report.
  const missingMeta = rankedIds.map(([id]) => id).filter((id) => !nodeMeta.has(id));
  if (missingMeta.length > 0) {
    const metaRows = await db
      .select({ id: nodes.id, name: nodes.name, type: nodes.type })
      .from(nodes)
      .where(inArray(nodes.id, missingMeta));
    for (const m of metaRows) nodeMeta.set(m.id, { name: m.name, type: m.type });
  }

  const rankedNodes = rankedIds.map(([id, score]) => ({
    id,
    name: nodeMeta.get(id)?.name ?? id,
    type: nodeMeta.get(id)?.type ?? 'unknown',
    score,
  }));

  // 4. Evidence — three index-backed signals, capped before fusion.
  const { byId, rankings } = await gatherCandidates(
    question,
    qvec,
    domainId,
    rankedNodes.map((n) => n.id),
    maxCandidates
  );

  // The graph list arrives in id order from the database, so it is re-sorted by
  // the PPR mass of the nodes each proposition mentions — otherwise its "rank"
  // would carry no signal into the fusion.
  const pprMassOf = (id: string): number => {
    const ids = ((byId.get(id)?.nodeIds as string[] | null) ?? []);
    return ids.reduce((sum, nodeId) => sum + (ppr.get(nodeId) ?? 0), 0);
  };
  const graphRanking = [...rankings.graph].sort((a, b) => pprMassOf(b) - pprMassOf(a));

  const fused = reciprocalRankFusion(
    [
      { name: 'graph', ids: graphRanking, weight: graphWeight },
      { name: 'vector', ids: rankings.vector, weight: vectorWeight },
      { name: 'lexical', ids: rankings.lexical, weight: lexicalWeight },
    ],
    { limit: maxCandidates }
  );
  const relevanceById = normalizeFusedScores(fused);

  // Fused order is the relevance order; MMR then trades it against redundancy
  // and the character budget. Candidates are pre-sorted so that when MMR's
  // lambda is high the fused ranking is what survives.
  const candidates = fused
    .map((f) => {
      const row = byId.get(f.id);
      if (!row) return null;
      const ids = (row.nodeIds as string[] | null) ?? [];
      return {
        item: { text: row.text, nodeIds: ids } as RetrievedEvidence,
        vector: row.embedding as number[],
        relevance: relevanceById.get(f.id) ?? 0,
        cost: row.text.length,
      };
    })
    .filter(
      (c): c is NonNullable<typeof c> =>
        c !== null && Array.isArray(c.vector) && c.vector.length > 0
    );

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
    seeds: seedRows.map((s) => ({ id: s.id, name: s.name, score: s.score })),
    rankedNodes,
    evidence,
    contextChars: evidence.reduce((sum, e) => sum + e.text.length, 0),
    stats: {
      seedCount: seedRows.length,
      subgraphNodes: nodeIds.length,
      subgraphEdges: graphEdges.length,
      candidateEvidence: candidates.length,
      truncated,
    },
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

  const context = result.evidence.map((e, i) => `[${i + 1}] ${e.text}`).join('\n');

  const system =
    'You are a knowledge-graph assistant. Answer the question using ONLY the ' +
    'numbered evidence provided. Be concise. If the evidence is insufficient, say so.';
  const user = `Question: ${question}\n\nEvidence:\n${context}\n\nAnswer:`;

  const completion = await generateCompletion(system, user, 0.2, 'verbalize');

  return { ...result, answer: completion.text.trim(), llmCalls: 1 };
}
