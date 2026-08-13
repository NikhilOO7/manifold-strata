// Dependency-free force-directed layout.
//
// Runs a small synchronous simulation: every pair of nodes repels (so they don't
// overlap), every edge acts as a spring (so connected nodes cluster), and a weak
// centering force keeps everything on-screen. Good enough for the ~100–500 node
// graphs the Explorer renders, without pulling in d3-force.

export interface LayoutNode {
  id: string;
}

export interface LayoutEdge {
  source: string;
  target: string;
}

export interface Point {
  x: number;
  y: number;
}

export function computeForceLayout(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  opts: { width?: number; height?: number; iterations?: number } = {}
): Map<string, Point> {
  const width = opts.width ?? 1200;
  const height = opts.height ?? 800;
  const iterations = opts.iterations ?? 300;
  const cx = width / 2;
  const cy = height / 2;

  const n = nodes.length;
  const positions = new Map<string, Point>();
  if (n === 0) return positions;

  // Deterministic initial placement on a circle (no Math.random → stable layout
  // across renders for the same data).
  const initRadius = Math.max(200, n * 8);
  const index = new Map<string, number>();
  nodes.forEach((node, i) => {
    index.set(node.id, i);
    const angle = (i / n) * 2 * Math.PI;
    positions.set(node.id, {
      x: cx + Math.cos(angle) * initRadius,
      y: cy + Math.sin(angle) * initRadius,
    });
  });

  // Only keep edges whose endpoints exist in the node set.
  const links = edges.filter((e) => index.has(e.source) && index.has(e.target));

  const k = Math.max(80, initRadius / Math.sqrt(n)); // ideal node spacing
  const repulsion = k * k;
  const springLength = k;
  const springStrength = 0.05;
  const centerPull = 0.01;

  const pos = nodes.map((node) => positions.get(node.id)!);
  const disp = nodes.map(() => ({ x: 0, y: 0 }));

  for (let iter = 0; iter < iterations; iter++) {
    for (let i = 0; i < n; i++) {
      disp[i].x = 0;
      disp[i].y = 0;
    }

    // Pairwise repulsion (O(n^2) — fine at this scale).
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = pos[i].x - pos[j].x;
        let dy = pos[i].y - pos[j].y;
        let distSq = dx * dx + dy * dy;
        if (distSq < 0.01) {
          dx = (i - j) || 1;
          dy = 1;
          distSq = dx * dx + dy * dy;
        }
        const dist = Math.sqrt(distSq);
        const force = repulsion / distSq;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        disp[i].x += fx;
        disp[i].y += fy;
        disp[j].x -= fx;
        disp[j].y -= fy;
      }
    }

    // Spring attraction along edges.
    for (const link of links) {
      const a = index.get(link.source)!;
      const b = index.get(link.target)!;
      const dx = pos[a].x - pos[b].x;
      const dy = pos[a].y - pos[b].y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = (dist - springLength) * springStrength;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      disp[a].x -= fx;
      disp[a].y -= fy;
      disp[b].x += fx;
      disp[b].y += fy;
    }

    // Cooling: limit displacement, shrinking over time for convergence.
    const maxStep = Math.max(2, k * (1 - iter / iterations));
    for (let i = 0; i < n; i++) {
      // Weak pull toward center.
      disp[i].x += (cx - pos[i].x) * centerPull;
      disp[i].y += (cy - pos[i].y) * centerPull;

      const len = Math.sqrt(disp[i].x * disp[i].x + disp[i].y * disp[i].y) || 1;
      pos[i].x += (disp[i].x / len) * Math.min(len, maxStep);
      pos[i].y += (disp[i].y / len) * Math.min(len, maxStep);
    }
  }

  nodes.forEach((node, i) => positions.set(node.id, pos[i]));
  return positions;
}

// ---------------------------------------------------------------------------
// Ego (focus + context) layout
// ---------------------------------------------------------------------------

export interface EgoEdge {
  source: string;
  target: string;
  type: string;
}

/**
 * Radial layout around one focus node.
 *
 * The force-directed overview was rejected twice, and rightly: it optimises for
 * seeing the whole graph at once, when the actual task is "start from an entity
 * and follow its relationships". This layout serves that task directly:
 *
 *   - the focus node sits at the centre
 *   - entities it points AT fan out on the right; entities pointing at IT fan
 *     out on the left — so direction is carried by position, not deciphered
 *     from arrowheads
 *   - within each half, neighbours are grouped by relationship type, so
 *     "everything it `exposes`" reads as one contiguous arc
 *   - second-hop nodes sit on an outer ring near their first-hop parent
 *
 * The ring radius grows with neighbour count, so labels get the arc length they
 * need instead of being forced to overlap. Determinstic: same data, same
 * picture.
 */
export function computeEgoLayout(
  centerId: string,
  edges: EgoEdge[],
  opts: { cx?: number; cy?: number } = {}
): Map<string, Point> {
  const cx = opts.cx ?? 600;
  const cy = opts.cy ?? 420;
  const positions = new Map<string, Point>();
  positions.set(centerId, { x: cx, y: cy });

  // Direct neighbours, split by direction. A node related in both directions
  // counts as outgoing (its arc position matters less than having exactly one).
  const outgoing = new Map<string, string>(); // neighbourId -> relationship type
  const incoming = new Map<string, string>();
  for (const e of edges) {
    if (e.source === centerId && e.target !== centerId) {
      if (!incoming.has(e.target)) outgoing.set(e.target, e.type);
    } else if (e.target === centerId && e.source !== centerId) {
      if (!outgoing.has(e.source)) incoming.set(e.source, e.type);
    }
  }

  /** Order a half's members grouped by type, then place along its arc. */
  const placeHalf = (
    members: Map<string, string>,
    arcStartDeg: number,
    arcEndDeg: number
  ): void => {
    const grouped = [...members.entries()].sort(
      (a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0])
    );
    const n = grouped.length;
    if (n === 0) return;

    // Radius from required arc length: ~64px of arc per node keeps labels clear.
    const arcRad = ((arcEndDeg - arcStartDeg) * Math.PI) / 180;
    const r = Math.max(280, (n * 64) / arcRad);

    grouped.forEach(([id], i) => {
      // n === 1 sits mid-arc; otherwise spread inclusive of both ends.
      const t = n === 1 ? 0.5 : i / (n - 1);
      const deg = arcStartDeg + t * (arcEndDeg - arcStartDeg);
      const rad = (deg * Math.PI) / 180;
      positions.set(id, { x: cx + Math.cos(rad) * r, y: cy + Math.sin(rad) * r });
    });
  };

  placeHalf(outgoing, -70, 70); // right half
  placeHalf(incoming, 110, 250); // left half

  // Second hop: nodes reached through a placed first-hop node. Placed on a
  // short spur outward from their parent, spread slightly so siblings separate.
  const ringOne = new Set(positions.keys());
  const childrenOf = new Map<string, string[]>();
  for (const e of edges) {
    const parentFirst =
      ringOne.has(e.source) && e.source !== centerId && !ringOne.has(e.target);
    const parentSecond =
      ringOne.has(e.target) && e.target !== centerId && !ringOne.has(e.source);
    if (parentFirst) {
      (childrenOf.get(e.source) ?? childrenOf.set(e.source, []).get(e.source)!).push(e.target);
    } else if (parentSecond) {
      (childrenOf.get(e.target) ?? childrenOf.set(e.target, []).get(e.target)!).push(e.source);
    }
  }

  for (const [parentId, kids] of childrenOf) {
    const p = positions.get(parentId)!;
    const baseAngle = Math.atan2(p.y - cy, p.x - cx);
    const unique = [...new Set(kids)].filter((k) => !positions.has(k));
    unique.forEach((kid, i) => {
      // Fan ±0.35 rad around the parent's outward direction.
      const spread = unique.length === 1 ? 0 : (i / (unique.length - 1) - 0.5) * 0.7;
      const angle = baseAngle + spread;
      const r = Math.hypot(p.x - cx, p.y - cy) + 190;
      positions.set(kid, { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r });
    });
  }

  return positions;
}
