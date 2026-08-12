/**
 * The deployment's embedding space.
 *
 * Every stored vector — node embeddings, proposition embeddings, query vectors —
 * must live in ONE space. Two vectors from different models are not comparable,
 * and nothing about the failure looks like a failure: `cosine()` used to reduce
 * both operands to `Math.min(a.length, b.length)` dimensions, so a 1536-dim
 * OpenAI vector scored 0.71 against a 768-dim Ollama vector — a confident number
 * derived from comparing the first 768 coordinates of unrelated spaces. Flip
 * `EMBED_PROVIDER` on a populated corpus and retrieval quietly becomes noise
 * while every metric still looks healthy.
 *
 * So the space is declared once, here, and enforced at three points: on write
 * (dimension must match), on comparison (operands must match), and at startup
 * (the database column must match). An index in Postgres is bound to a fixed
 * dimension anyway — pgvector cannot build HNSW over a column of mixed width —
 * so this is a constraint the storage layer imposes regardless.
 *
 * Changing model or provider is a re-embedding migration, not a config edit.
 */

/** Output width of the embedding models we ship support for. */
const KNOWN_DIMENSIONS: Record<string, number> = {
  // OpenAI
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
  // Ollama
  'nomic-embed-text': 768,
  'mxbai-embed-large': 1024,
  'all-minilm': 384,
  'snowflake-arctic-embed': 1024,
  // Local provider: width is whatever the schema declares, so it can match an
  // existing column rather than forcing a re-migration to try it.
  'local-hashed-ngram': 768,
};

function resolveDimensions(model: string): number {
  const override = Number(process.env.EMBED_DIMENSIONS);
  if (Number.isFinite(override) && override > 0) return Math.floor(override);

  // Strip any Ollama tag ("nomic-embed-text:latest") before lookup.
  const bare = model.split(':')[0];
  const known = KNOWN_DIMENSIONS[model] ?? KNOWN_DIMENSIONS[bare];
  if (known) return known;

  throw new Error(
    `Unknown embedding model "${model}" — its output dimension is not known, and the ` +
      `vector column plus its index are fixed-width. Set EMBED_DIMENSIONS explicitly, ` +
      `or add the model to KNOWN_DIMENSIONS in services/embedding-space.ts.`
  );
}

const provider = process.env.EMBED_PROVIDER || process.env.LLM_PROVIDER || 'openai';
const model =
  provider === 'local'
    ? 'local-hashed-ngram'
    : provider === 'ollama'
      ? process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text'
      : process.env.OPENAI_EMBED_MODEL || 'text-embedding-3-small';

export const EMBEDDING_SPACE = {
  provider,
  model,
  get dimensions(): number {
    return resolveDimensions(model);
  },
  /** Stable identifier recorded alongside every vector, so drift is auditable. */
  get id(): string {
    return `${provider}:${model}:${resolveDimensions(model)}`;
  },
} as const;

/**
 * Dimension the schema declares for its `vector` columns.
 *
 * Read at module load because Drizzle needs a literal at table-definition time.
 * A deployment that changes this must generate a migration and re-embed; the
 * startup check below refuses to run against a column of a different width
 * rather than letting inserts fail one row at a time under load.
 */
export const VECTOR_DIMENSIONS: number = (() => {
  try {
    return resolveDimensions(model);
  } catch {
    // Fall back so the module can still be imported for tooling (migration
    // generation, tests) — the startup check reports the real problem.
    return 1536;
  }
})();

/** Throws unless `vector` has exactly the configured width. */
export function assertVectorShape(vector: number[], context: string): void {
  if (!Array.isArray(vector)) {
    throw new Error(`${context}: expected an embedding array, got ${typeof vector}`);
  }
  if (vector.length !== EMBEDDING_SPACE.dimensions) {
    throw new Error(
      `${context}: embedding has ${vector.length} dimensions but this deployment's space ` +
        `(${EMBEDDING_SPACE.id}) is ${EMBEDDING_SPACE.dimensions}-dimensional. ` +
        `Vectors from different models are not comparable.`
    );
  }
  const badIndex = vector.findIndex((v) => !Number.isFinite(v));
  if (badIndex !== -1) {
    throw new Error(`${context}: embedding contains a non-finite value at index ${badIndex}`);
  }
}

/** Throws unless two vectors are from the same space. Used by every similarity op. */
export function assertComparable(a: number[], b: number[], context: string): void {
  if (a.length !== b.length) {
    throw new Error(
      `${context}: refusing to compare a ${a.length}-dimensional vector with a ` +
        `${b.length}-dimensional one — they are from different embedding models. ` +
        `Re-embed the corpus after changing EMBED_PROVIDER or the embedding model.`
    );
  }
}

/** Postgres literal for a pgvector value: '[0.1,0.2,...]'. */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`;
}
