/**
 * Startup verification of the vector storage contract.
 *
 * Three things must line up for retrieval to work, and all three fail quietly if
 * they don't:
 *
 *   - the `vector` extension must be installed, or every ANN query errors at
 *     request time rather than at boot;
 *   - the column width must equal this deployment's configured dimension, or
 *     inserts fail one row at a time under load while reads return nothing;
 *   - an HNSW index must exist, or the same query still *works* but degrades to
 *     a sequential scan — the exact O(corpus) behaviour this layer was built to
 *     remove, with no error to notice.
 *
 * The third is why this check exists at all. A missing index is invisible: the
 * answers stay correct and the latency quietly becomes unusable.
 */

import { sql } from 'drizzle-orm';
import { db } from './index';
import { EMBEDDING_SPACE } from '../services/embedding-space';

export interface VectorHealth {
  ok: boolean;
  extension: string | null;
  dimensions: Record<string, number | null>;
  missingIndexes: string[];
  problems: string[];
}

const EXPECTED_VECTOR_COLUMNS = [
  { table: 'node_vectors', column: 'embedding_vec', index: 'node_vectors_embedding_hnsw' },
  { table: 'propositions', column: 'embedding_vec', index: 'propositions_embedding_hnsw' },
];

export async function checkVectorStorage(): Promise<VectorHealth> {
  const problems: string[] = [];
  const dimensions: Record<string, number | null> = {};
  const missingIndexes: string[] = [];

  const extRows = (await db.execute(
    sql`select extversion from pg_extension where extname = 'vector'`
  )) as unknown as Array<{ extversion: string }>;
  const extension = extRows[0]?.extversion ?? null;

  if (!extension) {
    problems.push(
      'The pgvector extension is not installed. Run `pnpm db:migrate` (it creates the ' +
        'extension), and ensure the Postgres image provides it — docker-compose.yml uses ' +
        'pgvector/pgvector:pg16.'
    );
    return { ok: false, extension, dimensions, missingIndexes, problems };
  }

  const expected = EMBEDDING_SPACE.dimensions;

  for (const target of EXPECTED_VECTOR_COLUMNS) {
    // atttypmod carries the declared dimension for a vector column.
    const rows = (await db.execute(sql`
      select a.atttypmod as dim
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname = ${target.table}
        and a.attname = ${target.column}
        and a.attnum > 0
        and not a.attisdropped
    `)) as unknown as Array<{ dim: number }>;

    const dim = rows[0]?.dim ?? null;
    dimensions[`${target.table}.${target.column}`] = dim;

    if (dim === null) {
      problems.push(`Column ${target.table}.${target.column} is missing — run \`pnpm db:migrate\`.`);
      continue;
    }

    if (dim !== expected) {
      problems.push(
        `Column ${target.table}.${target.column} is ${dim}-dimensional but this deployment's ` +
          `embedding space (${EMBEDDING_SPACE.id}) produces ${expected}-dimensional vectors. ` +
          `Changing the embedding model requires a migration and a re-embed — vectors from ` +
          `different models are not comparable.`
      );
    }

    const idxRows = (await db.execute(sql`
      select indexname from pg_indexes
      where schemaname = 'public' and indexname = ${target.index}
    `)) as unknown as Array<{ indexname: string }>;

    if (idxRows.length === 0) {
      missingIndexes.push(target.index);
      problems.push(
        `Index ${target.index} is missing. Queries will still return correct results, but by ` +
          `sequential scan — the O(corpus) behaviour this layer exists to avoid.`
      );
    }
  }

  return { ok: problems.length === 0, extension, dimensions, missingIndexes, problems };
}
