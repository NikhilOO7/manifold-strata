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
  const alpha = opts.alpha ?? 0.15;
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

export interface LocalPPROptions {
  /** Restart probability. Higher = stays closer to the seeds. */
  alpha?: number;
  /** Residual-per-degree threshold; smaller = more nodes explored, more accurate. */
  epsilon?: number;
  /** Hard cap on push operations (safety bound). */
  maxPushes?: number;
}

/**
 * Bounded, push-based Personalized PageRank (Andersen–Chung–Lang).
 *
 * The dense `personalizedPageRank` above touches every node `iterations` times,
 * so its cost grows with the WHOLE graph even when the query only concerns a
 * local cluster. This variant pushes residual mass outward from the seeds and
 * stops once residuals fall below `epsilon`, so its work — and its output — is
 * bounded by the seed neighborhood, not the graph size. That's what lets
 * retrieval stay flat as the corpus grows from hundreds to tens of thousands of
 * nodes.
 *
 * @param adjacency node id -> [(neighborId, weight)] (undirected)
 * @param rowSum    node id -> total incident weight (degree)
 * @param seeds     seed node id -> restart weight (need not be normalized)
 * @returns         sparse map of touched node id -> approximate stationary score
 */
export function localPushPPR(
  adjacency: Map<string, Array<[string, number]>>,
  rowSum: Map<string, number>,
  seeds: Map<string, number>,
  opts: LocalPPROptions = {}
): Map<string, number> {
  const alpha = opts.alpha ?? 0.15;
  const epsilon = opts.epsilon ?? 1e-4;
  const maxPushes = opts.maxPushes ?? 200_000;

  let seedTotal = 0;
  for (const w of seeds.values()) if (w > 0) seedTotal += w;
  if (seedTotal === 0) return new Map();

  const p = new Map<string, number>(); // approximate PPR mass
  const r = new Map<string, number>(); // residual to be pushed
  for (const [id, w] of seeds) if (w > 0) r.set(id, w / seedTotal);

  const queue: string[] = [...r.keys()];
  const inQueue = new Set<string>(queue);

  const exceedsThreshold = (id: string): boolean => {
    const deg = rowSum.get(id) ?? 0;
    const thresh = deg > 0 ? epsilon * deg : epsilon;
    return (r.get(id) ?? 0) > thresh;
  };

  let pushes = 0;
  while (queue.length > 0 && pushes < maxPushes) {
    const u = queue.shift()!;
    inQueue.delete(u);
    if (!exceedsThreshold(u)) continue;

    pushes++;
    const ru = r.get(u)!;
    r.set(u, 0);

    const neighbors = adjacency.get(u);
    const deg = rowSum.get(u) ?? 0;
    if (!neighbors || neighbors.length === 0 || deg <= 0) {
      // Absorbing/dangling node: keep all of its residual locally.
      p.set(u, (p.get(u) ?? 0) + ru);
      continue;
    }

    p.set(u, (p.get(u) ?? 0) + alpha * ru);
    const mass = (1 - alpha) * ru;
    for (const [v, w] of neighbors) {
      const add = (mass * w) / deg;
      if (add === 0) continue;
      r.set(v, (r.get(v) ?? 0) + add);
      if (!inQueue.has(v) && exceedsThreshold(v)) {
        queue.push(v);
        inQueue.add(v);
      }
    }
  }

  return p;
}
