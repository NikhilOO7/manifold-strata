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
