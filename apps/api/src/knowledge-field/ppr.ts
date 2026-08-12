/**
 * Personalized PageRank over the knowledge graph (the HippoRAG retrieval core).
 *
 * Multi-hop reasoning ("what improves something that extends 3DGS?") normally
 * costs repeated retrieve→reason→retrieve LLM loops. Here it's a single PPR
 * computation: seed restart mass on the query's entry nodes, propagate over the
 * confidence-weighted edges, and read off the stationary distribution. 0 LLM calls.
 */

export interface GraphEdge {
  sourceId: string;
  targetId: string;
  weight: number;
}

export interface PPROptions {
  /** Restart probability (teleport back to seeds). Higher = stays local. */
  alpha?: number;
  iterations?: number;
}

/**
 * Restart probability.
 *
 * 0.15, chosen by measurement (`pnpm --filter api eval -- --sweep-alpha`).
 *
 * This value was briefly raised to 0.5 on a reasonable-sounding argument: on an
 * undirected graph the walk component drifts toward a degree-proportional
 * distribution, and on a star graph the seed scored 0.18 against a 12-neighbour
 * hub's 0.46 — the node that matched the question ranking below a generic hub.
 * Raising restart fixed that node-level ordering.
 *
 * It did not improve retrieval, which is the thing we actually care about. On the
 * evaluation corpus, multi-hop nDCG fell from 63.1% at alpha=0.15 to 30.1% at
 * 0.5, while the hub family scored an identical 31.6% at *every* alpha tested.
 * Node-level hub dominance turns out not to propagate to evidence: the relevant
 * spoke still enters the top-ranked nodes, and its proposition is still gathered.
 * Meanwhile high restart keeps mass on the seed, which is precisely what starves
 * the distant answer a multi-hop question is asking for.
 *
 * The lesson is in the file for the next person tempted by the same argument:
 * this was optimising a proxy (seed rank vs hub rank) that did not map to the
 * outcome (was the right evidence retrieved, and ranked highly). Change it with
 * a sweep, not with reasoning.
 */
const DEFAULT_ALPHA = 0.15;

/**
 * @param nodeIds  all node ids in the graph
 * @param edges    weighted edges (treated as undirected for propagation)
 * @param seeds    seed nodeId -> restart weight (need not be normalized)
 * @returns        nodeId -> stationary score (sums to ~1)
 */
export function personalizedPageRank(
  nodeIds: string[],
  edges: GraphEdge[],
  seeds: Map<string, number>,
  opts: PPROptions = {}
): Map<string, number> {
  const alpha = opts.alpha ?? DEFAULT_ALPHA;
  const iterations = opts.iterations ?? 30;
  const n = nodeIds.length;
  if (n === 0) return new Map();

  const idx = new Map<string, number>();
  nodeIds.forEach((id, i) => idx.set(id, i));

  // Undirected weighted adjacency.
  const adj: Array<Array<[number, number]>> = Array.from({ length: n }, () => []);
  const rowSum = new Array<number>(n).fill(0);
  for (const e of edges) {
    const i = idx.get(e.sourceId);
    const j = idx.get(e.targetId);
    if (i === undefined || j === undefined || i === j) continue;
    const w = e.weight > 0 ? e.weight : 0.01;
    adj[i].push([j, w]);
    adj[j].push([i, w]);
    rowSum[i] += w;
    rowSum[j] += w;
  }

  // Normalized restart vector s.
  const s = new Array<number>(n).fill(0);
  let seedTotal = 0;
  for (const [id, w] of seeds.entries()) {
    const i = idx.get(id);
    if (i === undefined || w <= 0) continue;
    s[i] += w;
    seedTotal += w;
  }
  if (seedTotal === 0) {
    // No usable seeds — fall back to uniform restart.
    for (let i = 0; i < n; i++) s[i] = 1 / n;
  } else {
    for (let i = 0; i < n; i++) s[i] /= seedTotal;
  }

  let r = s.slice();
  for (let iter = 0; iter < iterations; iter++) {
    const next = new Array<number>(n).fill(0);
    // Teleport component.
    for (let i = 0; i < n; i++) next[i] = alpha * s[i];
    // Propagation component.
    for (let j = 0; j < n; j++) {
      const rj = r[j];
      if (rj === 0) continue;
      if (rowSum[j] === 0) {
        // Dangling node: send its mass back to seeds.
        for (let i = 0; i < n; i++) next[i] += (1 - alpha) * rj * s[i];
        continue;
      }
      const share = ((1 - alpha) * rj) / rowSum[j];
      for (const [i, w] of adj[j]) next[i] += share * w;
    }
    r = next;
  }

  const out = new Map<string, number>();
  nodeIds.forEach((id, i) => out.set(id, r[i]));
  return out;
}
