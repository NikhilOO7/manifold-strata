/**
 * Indexed candidate lookup for entity resolution.
 *
 * ## Why this file exists
 *
 * Resolution used to pick its candidates by loading the `RESOLUTION_CANDIDATE_LIMIT`
 * (2000) most recently created nodes in the domain and comparing every mention
 * against every one of them in JavaScript. That is the same whole-corpus scan the
 * retrieval path was rebuilt to eliminate (invariant 12) — except on the *write*
 * side, where its failure mode is worse than latency.
 *
 * Past 2000 nodes, the window stops covering the graph. An entity created by
 * paper #1 has fallen out of it by paper #40, so paper #40 mentioning the same
 * thing does not match it — it creates a **second node with the same meaning**.
 * The graph does not fail loudly; it silently fragments, and every downstream
 * claim degrades with it: PPR splits mass across the duplicates, retrieval
 * returns one of them, and "what relates to X" answers for half of X. A
 * knowledge graph whose entities fragment as it grows is not a knowledge graph.
 * The old code knew: it logged "Older entities may be duplicated" and carried on.
 *
 * ## The fix
 *
 * Both lookups become bounded index queries, scoped to the domain:
 *
 *   byName    one batched equality probe on `nodes_normalized_name_idx`. Exact
 *             identity, whole domain, no window. (The old path also used `ilike`,
 *             which cannot use a btree index at all — measured on 100k nodes:
 *             Seq Scan, 100,000 rows discarded, plan cost 3039 versus 12 for the
 *             equality it was already semantically equivalent to, since both
 *             sides are lowercased before comparison.)
 *
 *   byVector  one batched k-NN query over `node_vectors_embedding_hnsw` — a
 *             lateral join so N mentions cost one round trip and each gets its
 *             own index search rather than sharing a trimmed result set.
 *
 * The type rule and the domain predicate live inside the lateral, so they are
 * applied while the index scan streams rather than to a finished result set. That
 * distinction matters and the plan is worth reading honestly: pgvector walks the
 * HNSW graph and the executor discards rows failing the filter as they arrive
 * (`EXPLAIN` shows `Index Scan using node_vectors_embedding_hnsw` with the join
 * filter above it, pulling 16 index rows to yield 8). With `hnsw.iterative_scan`
 * off, that walk stops after `ef_search` candidates whether or not K of them
 * passed — so a domain holding a small slice of the corpus can come back with
 * fewer than K eligible neighbours, or none. In retrieval that is a quality
 * wobble; here it would mean minting a duplicate entity, which is permanent. So
 * this query asks for `strict_order` iterative scan: the walk resumes until it
 * has K eligible rows, in true distance order. Measured on 100k nodes it was not
 * needed — 20-node minority domain, filtered top-8, returned 8 either way — but
 * "it happened to work on this corpus" is not a property, and the cost is
 * nothing next to the 34 s of extraction this sits behind.
 *
 * Cost per chunk goes from `mentions × 2000` JS cosines plus ~6 MB of vector
 * transfer, to two indexed statements whose work is bounded by the number of
 * mentions — and correctness stops depending on how recently an entity happened
 * to be created.
 */

import { and, inArray, sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { nodes, nodeVectors } from '../db/schema';
import { DEFAULT_DOMAIN_ID } from '../domains';
import { toVectorLiteral, assertVectorShape } from '../services/embedding-space';
import type { ExistingNode } from './resolve-embed';

/**
 * Neighbours fetched per mention. The resolver only consumes the best one, but
 * asking for a few costs nothing measurable and absorbs HNSW's approximate
 * recall — the index is allowed to miss the true nearest neighbour occasionally,
 * and a duplicated entity is permanent damage where a slightly wider read is not.
 */
const ANN_K = Math.max(1, parseInt(process.env.RESOLUTION_ANN_K || '8', 10) || 8);

export interface ScoredCandidate extends ExistingNode {
  /** Cosine similarity in [-1, 1], computed by pgvector, not by us. */
  score: number;
}

/**
 * What the resolver needs from storage, and nothing more.
 *
 * Keeping this an interface is what lets `resolveEntitiesEmbed` stay a pure
 * function with unit tests that need no database, while the real implementation
 * below is exercised against Postgres where index behaviour is the thing under
 * test.
 */
export interface CandidateSource {
  /** Exact normalized-name matches, keyed by the normalized name queried. */
  byName(normalizedNames: string[]): Promise<Map<string, ExistingNode>>;
  /** Nearest type-eligible neighbours per query, best first. */
  byVector(queries: Array<{ vector: number[]; type: string }>): Promise<ScoredCandidate[][]>;
}

/**
 * The `default` domain also owns rows written before domains existed (null), so
 * it — and only it — reads null as its own. Mirrors `annSeeds` in retrieve.ts;
 * kept explicit here rather than reusing `domainWhere` because this predicate is
 * embedded in raw SQL, where a possibly-undefined return would silently widen
 * the query to every domain.
 */
function domainPredicate(domainId: string): SQL {
  return domainId === DEFAULT_DOMAIN_ID
    ? sql`(n.domain = ${domainId} or n.domain is null)`
    : sql`n.domain = ${domainId}`;
}

/**
 * The resolver's type rule, expressed in SQL so it constrains the index search.
 *
 * Same-type matches only, except that a `paper` on either side may match across
 * types — the extractor names papers both as entities and as citation targets.
 * This reproduces the JS predicate it replaces exactly; widening or narrowing it
 * is a separate, measurable decision, not a side effect of moving the lookup.
 */
function typePredicate(): SQL {
  return sql`(lower(n.type) = m.mtype or lower(n.type) = 'paper' or m.mtype = 'paper')`;
}

/**
 * Tri-state capability cache for `hnsw.iterative_scan` (pgvector >= 0.8).
 * `null` = not yet known. We discover it by using it, because pgvector registers
 * its GUCs when the library loads into a backend, so probing `pg_settings` on a
 * pooled connection can answer "no" for a server that supports it perfectly well.
 */
let iterativeScan: boolean | null = null;

/** Run a k-NN statement with filtered recall guaranteed where the server supports it. */
async function runAnn<T>(statement: SQL): Promise<T> {
  if (iterativeScan !== false) {
    try {
      const rows = await db.transaction(async (tx) => {
        // SET LOCAL needs a transaction; outside one it is a silent no-op.
        await tx.execute(sql`set local hnsw.iterative_scan = 'strict_order'`);
        return tx.execute(statement);
      });
      iterativeScan = true;
      return rows as T;
    } catch (err) {
      // Once it has worked, a later failure is a real error, not a capability gap.
      if (iterativeScan === true) throw err;
      iterativeScan = false;
      console.warn(
        '[resolve-candidates] hnsw.iterative_scan unavailable (pgvector < 0.8); ' +
          'filtered candidate recall is bounded by hnsw.ef_search. Entities in a ' +
          'domain that is a small slice of the corpus may resolve against fewer ' +
          'neighbours than requested.'
      );
    }
  }
  return (await db.execute(statement)) as T;
}

export function createCandidateSource(domainId: string): CandidateSource {
  return {
    async byName(normalizedNames: string[]): Promise<Map<string, ExistingNode>> {
      const found = new Map<string, ExistingNode>();
      const keys = [...new Set(normalizedNames.filter(Boolean))];
      if (keys.length === 0) return found;

      // Equality, not ilike: `normalized_name` is written lowercased and every
      // key arrives lowercased, so these are the same question — but only one of
      // them can use the index.
      const rows = await db
        .select({
          id: nodes.id,
          type: nodes.type,
          name: nodes.name,
          normalizedName: nodes.normalizedName,
        })
        .from(nodes)
        .where(
          and(
            inArray(nodes.normalizedName, keys),
            domainId === DEFAULT_DOMAIN_ID
              ? sql`(${nodes.domain} = ${domainId} or ${nodes.domain} is null)`
              : sql`${nodes.domain} = ${domainId}`
          )
        );

      for (const row of rows) {
        if (row.normalizedName && !found.has(row.normalizedName)) found.set(row.normalizedName, row);
      }
      return found;
    },

    async byVector(queries): Promise<ScoredCandidate[][]> {
      if (queries.length === 0) return [];

      // One VALUES row per mention. Every vector is validated against the
      // deployment's declared embedding space first (invariant 13): pgvector
      // would reject a wrong-width vector anyway, but it would do it as an
      // opaque failure mid-batch instead of naming the misconfiguration.
      const rows = queries.map((q, i) => {
        assertVectorShape(q.vector, 'resolve-candidates');
        return sql`(${i}::int, ${toVectorLiteral(q.vector)}::vector, ${q.type.toLowerCase()}::text)`;
      });

      // The lateral is what makes this one query instead of N: for each mention
      // row, `m.vec` is a constant, so the planner runs a separate HNSW search
      // per mention and each gets its own top-K.
      const statement = sql`
        with mentions(idx, vec, mtype) as (values ${sql.join(rows, sql`, `)})
        select m.idx as idx, c.id as id, c.name as name, c.type as type,
               c.normalized_name as normalized_name, c.distance as distance
        from mentions m
        cross join lateral (
          select n.id, n.name, n.type, n.normalized_name,
                 (nv.embedding_vec <=> m.vec) as distance
          from ${nodeVectors} nv
          join ${nodes} n on n.id = nv.node_id
          where nv.embedding_vec is not null
            and ${domainPredicate(domainId)}
            and ${typePredicate()}
          order by nv.embedding_vec <=> m.vec
          limit ${ANN_K}
        ) c
        order by m.idx, c.distance
      `;

      const result = await runAnn<Array<{
        idx: number;
        id: string;
        name: string;
        type: string;
        normalized_name: string | null;
        distance: number;
      }>>(statement);

      const perQuery: ScoredCandidate[][] = queries.map(() => []);
      for (const row of rows.length ? result : []) {
        const bucket = perQuery[Number(row.idx)];
        if (!bucket) continue;
        bucket.push({
          id: row.id,
          type: row.type,
          name: row.name,
          normalizedName: row.normalized_name,
          // `<=>` with vector_cosine_ops is cosine *distance*.
          score: 1 - Number(row.distance),
        });
      }
      return perQuery;
    },
  };
}
