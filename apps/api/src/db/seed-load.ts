/**
 * Synthetic corpus generator for load measurement.
 *
 *   pnpm --filter api seed:load -- --nodes 50000 --domain nlp
 *
 * Generates a graph of the requested size with deterministic pseudo-random
 * vectors. The vectors are not semantically meaningful and this says nothing
 * about answer quality — it exists purely to measure how retrieval behaves as the
 * corpus grows, which was the untested axis: everything worked at demo scale and
 * nobody had run it at a size a customer would bring.
 *
 * Writes to whatever DATABASE_URL points at, so point it at a scratch database.
 */

import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { nodes, edges, nodeVectors, propositions, papers } from './schema';
import { EMBEDDING_SPACE } from '../services/embedding-space';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** Deterministic PRNG so a run is reproducible without a seeded corpus on disk. */
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
    // Box–Muller: normal components give directions spread over the sphere,
    // which is closer to how real embeddings sit than uniform noise.
    const u1 = Math.max(rand(), 1e-12);
    const u2 = rand();
    const g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    v[i] = g;
    norm += g * g;
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dims; i++) v[i] = Number((v[i] / norm).toFixed(6));
  return v;
}

async function main() {
  const nodeCount = parseInt(arg('nodes', '50000'), 10);
  const domain = arg('domain', 'nlp');
  const edgesPerNode = parseInt(arg('edges-per-node', '3'), 10);
  const propsPerNode = Number(arg('props-per-node', '1'));
  const dims = EMBEDDING_SPACE.dimensions;

  const connectionString =
    process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/knowledge_graph';
  const client = postgres(connectionString, { max: 4 });
  const db = drizzle(client);

  const rand = mulberry32(42);
  const started = Date.now();

  console.log(
    `Seeding ${nodeCount.toLocaleString()} nodes into "${domain}" ` +
      `(${dims}-dim vectors, ~${edgesPerNode} edges/node)`
  );

  const [paper] = await db
    .insert(papers)
    .values({
      title: `LOADTEST corpus (${nodeCount} nodes)`,
      domain,
      processed: true,
      processingStatus: 'completed',
    })
    .returning();

  // Clear any previous fixture first.
  //
  // Without this the generator is additive: running it twice produced 100,000
  // rows over 50,000 distinct names, because every run restarts its counter at
  // zero. The corpus then no longer describes what it claims to — and, since
  // entity identity is unique per domain (migration 0008), it is not a corpus
  // the system could ever actually hold. A fixture that cannot exist in
  // production is not measuring production.
  const [cleared] = (await db.execute(sql`
    with gone as (delete from nodes where name like 'LOADTEST%' returning 1)
    select count(*)::int as n from gone
  `)) as unknown as Array<{ n: number }>;
  if (cleared.n > 0) console.log(`Cleared ${cleared.n} node(s) from a previous seed.`);
  await db.execute(sql`delete from papers where title like 'LOADTEST%'`);

  const BATCH = 1000;
  const nodeIds: string[] = [];

  for (let start = 0; start < nodeCount; start += BATCH) {
    const size = Math.min(BATCH, nodeCount - start);

    const nodeRows = await db
      .insert(nodes)
      .values(
        Array.from({ length: size }, (_, i) => ({
          type: (['method', 'concept', 'dataset', 'metric'] as const)[(start + i) % 4],
          domain,
          name: `LOADTEST entity ${start + i}`,
          normalizedName: `loadtest entity ${start + i}`,
        }))
      )
      .returning({ id: nodes.id });

    const ids = nodeRows.map((n) => n.id);
    nodeIds.push(...ids);

    const vectors = ids.map(() => unitVector(rand, dims));
    await db.insert(nodeVectors).values(
      ids.map((id, i) => ({
        nodeId: id,
        embeddingVec: vectors[i],
        model: EMBEDDING_SPACE.model,
        space: EMBEDDING_SPACE.id,
      }))
    );

    if (propsPerNode > 0) {
      const propCount = Math.max(1, Math.round(size * propsPerNode));
      const propVectors = Array.from({ length: propCount }, () => unitVector(rand, dims));
      await db.insert(propositions).values(
        Array.from({ length: propCount }, (_, i) => {
          const a = ids[i % ids.length];
          const b = ids[(i * 7 + 3) % ids.length];
          return {
            paperId: paper.id,
            text: `LOADTEST proposition ${start + i}: entity ${start + (i % size)} relates to another entity in a measurable way.`,
            embeddingVec: propVectors[i],
            nodeIds: [a, b],
            section: 'methods',
            domain,
            space: EMBEDDING_SPACE.id,
          };
        })
      );
    }

    if ((start / BATCH) % 10 === 0) {
      process.stdout.write(`  ${(start + size).toLocaleString()} / ${nodeCount.toLocaleString()}\r`);
    }
  }

  console.log(`\n  nodes + vectors + propositions done (${((Date.now() - started) / 1000).toFixed(1)}s)`);

  // Edges: mostly local (neighbours in id order) with a few long-range links, so
  // the graph has both clusters and shortcuts rather than being uniformly random.
  let edgeTotal = 0;
  for (let start = 0; start < nodeIds.length; start += BATCH) {
    const size = Math.min(BATCH, nodeIds.length - start);
    const batch: Array<typeof edges.$inferInsert> = [];

    for (let i = 0; i < size; i++) {
      const from = nodeIds[start + i];
      for (let e = 0; e < edgesPerNode; e++) {
        const longRange = rand() < 0.15;
        const targetIdx = longRange
          ? Math.floor(rand() * nodeIds.length)
          : Math.min(nodeIds.length - 1, start + i + 1 + Math.floor(rand() * 20));
        const to = nodeIds[targetIdx];
        if (!to || to === from) continue;
        batch.push({
          sourceId: from,
          targetId: to,
          type: (['extends', 'improves', 'uses', 'evaluates_on'] as const)[e % 4],
          domain,
          confidence: (0.5 + rand() * 0.5).toFixed(2),
        });
      }
    }

    if (batch.length) {
      await db.insert(edges).values(batch);
      edgeTotal += batch.length;
    }
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`  ${edgeTotal.toLocaleString()} edges done`);
  console.log(`✓ Seeded in ${elapsed}s — remember to ANALYZE for accurate planning`);

  await client.end();
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
