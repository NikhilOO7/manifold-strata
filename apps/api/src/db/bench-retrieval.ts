/**
 * Retrieval latency: the previous whole-corpus algorithm vs the indexed one.
 *
 *   DATABASE_URL=...knowledge_graph_load pnpm --filter api bench:retrieval
 *
 * Both arms run against the same seeded corpus and the same query vectors. The
 * "legacy" arm reproduces exactly what retrieve.ts used to do — select every node
 * in the domain, every vector in the database, every edge, every proposition, and
 * score them in JavaScript — so the comparison is the change in approach, not a
 * change in data or hardware.
 *
 * This measures latency and bytes, not answer quality. Vectors in the load corpus
 * are random, so ranking is meaningless here by construction; quality is a
 * separate harness (see PLAN.md §8).
 */

import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { db, closeDb } from './index';
import { nodes, edges, nodeVectors, propositions } from './schema';
import { retrieveField } from '../knowledge-field/retrieve';
import { personalizedPageRank, type GraphEdge } from '../knowledge-field/ppr';
import { mmrSelect } from '../knowledge-field/compress';
import { cosine } from '../services/embeddings';
import { EMBEDDING_SPACE } from '../services/embedding-space';
import { domainWhere } from '../domains/filter';

const DOMAIN = process.env.BENCH_DOMAIN || 'nlp';
const RUNS = parseInt(process.env.BENCH_RUNS || '5', 10);

function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function unitVector(rand: () => number, dims: number): number[] {
  const v = new Array<number>(dims);
  let norm = 0;
  for (let i = 0; i < dims; i++) {
    const u1 = Math.max(rand(), 1e-12);
    const g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * rand());
    v[i] = g;
    norm += g * g;
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dims; i++) v[i] = v[i] / norm;
  return v;
}

/** Exactly the algorithm retrieve.ts used before pgvector. */
async function legacyRetrieve(qvec: number[], domainId: string) {
  const allNodes = await db.select().from(nodes).where(domainWhere(nodes.domain, domainId));
  const nodeIdSet = new Set(allNodes.map((n) => n.id));

  // The original had no WHERE clause here — every vector in the database.
  const vecRows = (
    await db
      .select({ nodeId: nodeVectors.nodeId, embedding: nodeVectors.embeddingVec })
      .from(nodeVectors)
  ).filter((v) => nodeIdSet.has(v.nodeId));

  const seedScores = vecRows
    .map((v) => ({ id: v.nodeId, score: cosine(qvec, v.embedding as number[]) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  const seeds = new Map<string, number>();
  for (const s of seedScores) if (s.score > 0) seeds.set(s.id, s.score);

  const edgeRows = await db
    .select({ sourceId: edges.sourceId, targetId: edges.targetId, confidence: edges.confidence })
    .from(edges)
    .where(domainWhere(edges.domain, domainId));

  const graphEdges: GraphEdge[] = edgeRows.map((e) => ({
    sourceId: e.sourceId,
    targetId: e.targetId,
    weight: e.confidence ? Number(e.confidence) : 0.5,
  }));

  const ppr = personalizedPageRank(allNodes.map((n) => n.id), graphEdges, seeds);
  const ranked = [...ppr.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
  const topIds = new Set(ranked.map(([id]) => id));

  const propRows = await db
    .select()
    .from(propositions)
    .where(domainWhere(propositions.domain, domainId));

  const candidates = propRows
    .filter((p) => p.embeddingVec)
    .map((p) => {
      const ids = (p.nodeIds as string[] | null) ?? [];
      const mass = ids.reduce((s, id) => s + (ppr.get(id) ?? 0), 0);
      return { p, ids, mass };
    })
    .filter((c) => c.ids.some((id) => topIds.has(id)) || c.mass > 0)
    .map((c) => ({
      item: { text: c.p.text, nodeIds: c.ids },
      vector: c.p.embeddingVec as number[],
      prior: 1 + c.mass * 50,
      cost: c.p.text.length,
    }));

  const selected = mmrSelect(qvec, candidates, { lambda: 0.7, maxItems: 10, maxCost: 2000 });

  return {
    nodesScanned: allNodes.length,
    vectorsScanned: vecRows.length,
    edgesScanned: edgeRows.length,
    propsScanned: propRows.length,
    evidence: selected.length,
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function report(label: string, times: number[]) {
  const sorted = [...times].sort((a, b) => a - b);
  const mean = times.reduce((s, t) => s + t, 0) / times.length;
  console.log(
    `  ${label.padEnd(28)} p50 ${percentile(sorted, 50).toFixed(0).padStart(7)} ms` +
      `   p95 ${percentile(sorted, 95).toFixed(0).padStart(7)} ms` +
      `   mean ${mean.toFixed(0).padStart(7)} ms`
  );
  return { p50: percentile(sorted, 50), p95: percentile(sorted, 95), mean };
}

async function main() {
  const dims = EMBEDDING_SPACE.dimensions;

  const [counts] = (await db.execute(sql`
    select
      (select count(*) from nodes where domain = ${DOMAIN}) as nodes,
      (select count(*) from edges where domain = ${DOMAIN}) as edges,
      (select count(*) from propositions where domain = ${DOMAIN}) as props
  `)) as unknown as Array<{ nodes: string; edges: string; props: string }>;

  console.log('\nRetrieval benchmark');
  console.log('─'.repeat(78));
  console.log(
    `Corpus: ${Number(counts.nodes).toLocaleString()} nodes · ` +
      `${Number(counts.edges).toLocaleString()} edges · ` +
      `${Number(counts.props).toLocaleString()} propositions · ${dims}-dim vectors`
  );
  console.log(`Runs: ${RUNS} per arm (plus one warm-up, discarded)\n`);

  const rand = mulberry32(7);
  const queries = Array.from({ length: RUNS + 1 }, () => unitVector(rand, dims));

  // Warm-up: first query pays for page cache and index load in both arms.
  await legacyRetrieve(queries[0], DOMAIN);
  await retrieveField('warmup', { domain: DOMAIN, queryVector: queries[0] });

  const legacyTimes: number[] = [];
  let legacyShape: Awaited<ReturnType<typeof legacyRetrieve>> | null = null;
  for (let i = 1; i <= RUNS; i++) {
    const t0 = performance.now();
    legacyShape = await legacyRetrieve(queries[i], DOMAIN);
    legacyTimes.push(performance.now() - t0);
  }

  const indexedTimes: number[] = [];
  let indexedShape: Awaited<ReturnType<typeof retrieveField>> | null = null;
  for (let i = 1; i <= RUNS; i++) {
    const t0 = performance.now();
    indexedShape = await retrieveField('bench', { domain: DOMAIN, queryVector: queries[i] });
    indexedTimes.push(performance.now() - t0);
  }

  console.log('Latency');
  const legacy = report('whole-corpus (previous)', legacyTimes);
  const indexed = report('indexed (current)', indexedTimes);

  console.log('\nWork performed per query');
  console.log(
    `  whole-corpus                 ${legacyShape!.nodesScanned.toLocaleString()} nodes · ` +
      `${legacyShape!.vectorsScanned.toLocaleString()} vectors · ` +
      `${legacyShape!.edgesScanned.toLocaleString()} edges · ` +
      `${legacyShape!.propsScanned.toLocaleString()} propositions`
  );
  console.log(
    `  indexed                      ${indexedShape!.stats.seedCount} seeds · ` +
      `${indexedShape!.stats.subgraphNodes.toLocaleString()} subgraph nodes · ` +
      `${indexedShape!.stats.subgraphEdges.toLocaleString()} edges · ` +
      `${indexedShape!.stats.candidateEvidence.toLocaleString()} candidate propositions`
  );

  const bytesPerVector = dims * 20; // JSONB float text, approx
  const legacyBytes = legacyShape!.vectorsScanned * bytesPerVector;
  console.log(
    `\n  vector bytes read: whole-corpus ~${(legacyBytes / 1e6).toFixed(0)} MB` +
      `   ·   indexed ~0 MB (scored inside Postgres)`
  );

  const speedup = legacy.p95 / Math.max(indexed.p95, 0.001);
  console.log(`\n  p95 speed-up: ${speedup.toFixed(1)}x\n`);

  await closeDb();
}

main().catch(async (err) => {
  console.error('Benchmark failed:', err);
  await closeDb().catch(() => {});
  process.exit(1);
});
