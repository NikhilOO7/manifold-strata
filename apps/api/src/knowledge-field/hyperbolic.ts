/**
 * Hyperbolic (Poincaré-ball) embeddings — the Track A representation.
 *
 * The literature graph is a tree of extends/improves/cites relations. Euclidean
 * embeddings distort tree distances badly; hyperbolic space embeds hierarchies
 * with exponentially less distortion (Nickel & Kiela, 2017). We train low-D
 * Poincaré coords with Riemannian SGD over the hierarchical edges, then use
 * (norm ≈ generality, distance ≈ relatedness) for hierarchy-aware queries.
 *
 * The graph here is small (hundreds of nodes) so this trains in seconds on CPU.
 */

const EPS = 1e-5;

function sub(a: number[], b: number[]): number[] {
  return a.map((x, i) => x - b[i]);
}
function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
function norm2(a: number[]): number {
  return dot(a, a);
}

/** Clip a point to stay strictly inside the unit ball. */
export function project(theta: number[]): number[] {
  const n = Math.sqrt(norm2(theta));
  if (n >= 1 - EPS) {
    const scale = (1 - EPS) / n;
    return theta.map((x) => x * scale);
  }
  return theta;
}

/** Poincaré-ball distance. */
export function poincareDist(u: number[], v: number[]): number {
  const uu = norm2(u);
  const vv = norm2(v);
  const diff = norm2(sub(u, v));
  const arg = 1 + (2 * diff) / ((1 - uu) * (1 - vv) + EPS);
  return Math.acosh(Math.max(1, arg));
}

/** ∂ d(θ, x) / ∂θ. */
function gradDist(theta: number[], x: number[]): number[] {
  const alpha = 1 - norm2(theta);
  const beta = 1 - norm2(x);
  const delta = norm2(sub(theta, x));
  const gamma = 1 + (2 / (alpha * beta + EPS)) * delta;
  const sq = Math.sqrt(Math.max(gamma * gamma - 1, EPS));
  const factor = 4 / (beta * sq + EPS);
  const coef = (norm2(x) - 2 * dot(theta, x) + 1) / (alpha * alpha + EPS);
  return theta.map((t, i) => factor * (coef * t - x[i] / alpha));
}

export interface TrainOptions {
  dim?: number;
  epochs?: number;
  lr?: number;
  negatives?: number;
}

/**
 * Train Poincaré embeddings from undirected hierarchical edges.
 * @returns nodeId -> coords (length `dim`)
 */
export function trainPoincare(
  nodeIds: string[],
  edges: Array<[string, string]>,
  opts: TrainOptions = {}
): Map<string, number[]> {
  const dim = opts.dim ?? 10;
  const epochs = opts.epochs ?? 100;
  const baseLr = opts.lr ?? 0.3;
  const nNeg = opts.negatives ?? 5;

  const idx = new Map<string, number>();
  nodeIds.forEach((id, i) => idx.set(id, i));
  const N = nodeIds.length;
  if (N === 0) return new Map();

  // Small random init near the origin.
  const pts: number[][] = nodeIds.map(() =>
    Array.from({ length: dim }, () => (Math.random() - 0.5) * 1e-3)
  );

  const pairs = edges
    .map(([a, b]) => [idx.get(a), idx.get(b)] as [number | undefined, number | undefined])
    .filter((p): p is [number, number] => p[0] !== undefined && p[1] !== undefined && p[0] !== p[1]);

  if (pairs.length === 0) {
    return new Map(nodeIds.map((id, i) => [id, pts[i]]));
  }

  for (let epoch = 0; epoch < epochs; epoch++) {
    // Burn-in: smaller lr for the first 10 epochs stabilizes training.
    const lr = epoch < 10 ? baseLr / 10 : baseLr;

    for (const [u, v] of pairs) {
      // Candidate set: the positive v plus random negatives.
      const cands = [v];
      for (let k = 0; k < nNeg; k++) {
        const neg = Math.floor(Math.random() * N);
        if (neg !== u && neg !== v) cands.push(neg);
      }

      const dists = cands.map((c) => poincareDist(pts[u], pts[c]));
      // softmax over s = -d
      const maxS = Math.max(...dists.map((d) => -d));
      const exps = dists.map((d) => Math.exp(-d - maxS));
      const Z = exps.reduce((a, b) => a + b, 0) + EPS;
      const probs = exps.map((e) => e / Z);

      // Accumulate gradient for u and each candidate.
      const gradU = new Array<number>(dim).fill(0);
      cands.forEach((c, ci) => {
        const coef = (ci === 0 ? 1 : 0) - probs[ci]; // dL/d(d_uc)
        const gU = gradDist(pts[u], pts[c]);
        const gC = gradDist(pts[c], pts[u]);
        for (let d = 0; d < dim; d++) gradU[d] += coef * gU[d];

        // Riemannian rescale + update for candidate c.
        const scaleC = Math.pow(1 - norm2(pts[c]), 2) / 4;
        for (let d = 0; d < dim; d++) pts[c][d] -= lr * scaleC * coef * gC[d];
        pts[c] = project(pts[c]);
      });

      // Riemannian update for u.
      const scaleU = Math.pow(1 - norm2(pts[u]), 2) / 4;
      for (let d = 0; d < dim; d++) pts[u][d] -= lr * scaleU * gradU[d];
      pts[u] = project(pts[u]);
    }
  }

  return new Map(nodeIds.map((id, i) => [id, pts[i]]));
}

export interface HierarchyNeighbor {
  id: string;
  distance: number;
  norm: number;
}

/**
 * Split a node's nearest neighbors into generalizations (closer to the origin =
 * more abstract) and specializations (farther from the origin = more specific).
 */
export function hierarchyNeighbors(
  targetId: string,
  coords: Map<string, number[]>,
  k = 8
): { generalizations: HierarchyNeighbor[]; specializations: HierarchyNeighbor[] } {
  const target = coords.get(targetId);
  if (!target) return { generalizations: [], specializations: [] };
  const targetNorm = Math.sqrt(norm2(target));

  const neighbors: HierarchyNeighbor[] = [];
  for (const [id, p] of coords.entries()) {
    if (id === targetId) continue;
    neighbors.push({ id, distance: poincareDist(target, p), norm: Math.sqrt(norm2(p)) });
  }
  neighbors.sort((a, b) => a.distance - b.distance);
  const near = neighbors.slice(0, k * 3);

  return {
    generalizations: near.filter((n) => n.norm < targetNorm).slice(0, k),
    specializations: near.filter((n) => n.norm >= targetNorm).slice(0, k),
  };
}
