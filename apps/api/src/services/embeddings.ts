/**
 * Provider-agnostic embedding service.
 *
 * Mirrors the LLM_PROVIDER pattern in ollama.ts: an EMBED_PROVIDER switch that
 * defaults to OpenAI (text-embedding-3-small, 1536-d) with an Ollama
 * (nomic-embed-text, 768-d) fallback. All calls are routed through metrics so
 * the benchmark can account for embedding cost separately from LLM cost.
 *
 * Vectors are returned as plain number[] and stored as jsonb in Postgres;
 * similarity is computed in JS (cosine), which is well under 10ms at the
 * hundreds-of-nodes scale of this project. pgvector is the documented scale path.
 */

import { recordEmbed } from './metrics';
import { fetchWithTimeout, TIMEOUTS } from './http';
import { assertComparable, assertVectorShape, EMBEDDING_SPACE } from './embedding-space';
import { embedLocalBatch } from './embed-local';

const provider = process.env.EMBED_PROVIDER || process.env.LLM_PROVIDER || 'openai';
const openaiApiKey = process.env.OPENAI_API_KEY;
const openaiEmbedModel = process.env.OPENAI_EMBED_MODEL || 'text-embedding-3-small';
const ollamaBaseURL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const ollamaEmbedModel = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';

export function embedProvider(): string {
  return provider;
}

export function embedModel(): string {
  return EMBEDDING_SPACE.model;
}

/** Full space identifier (`provider:model:dimensions`) recorded with each vector. */
export function embedSpaceId(): string {
  return EMBEDDING_SPACE.id;
}

/**
 * Embed a batch of texts. Returns one vector per input, in the same order.
 *
 * Callers (entity resolution in particular) pair `vectors[i]` with `texts[i]` by
 * index, so a short or misordered batch would silently attach the wrong vector
 * to a mention and corrupt resolution with no error anywhere. The positional
 * contract is therefore checked here rather than trusted.
 */
export async function embed(texts: string[], operation: string = 'embed'): Promise<number[][]> {
  if (texts.length === 0) return [];
  // Guard against empty strings, which some providers reject.
  const safe = texts.map((t) => (t && t.trim().length > 0 ? t : ' '));
  const vectors =
    provider === 'local'
      ? embedLocalBatch(safe, EMBEDDING_SPACE.dimensions, operation)
      : provider === 'ollama'
        ? await embedOllama(safe, operation)
        : await embedOpenAI(safe, operation);

  if (vectors.length !== safe.length) {
    throw new Error(
      `Embedding provider "${provider}" returned ${vectors.length} vectors for ${safe.length} inputs — refusing to misalign them`
    );
  }

  // Validate width on the way in, not at comparison time. A vector of the wrong
  // dimension is unusable and unstorable (the pgvector column is fixed-width), so
  // the useful place to fail is the call that produced it — where the model and
  // operation are still in scope — rather than deep inside a similarity loop.
  vectors.forEach((v, i) =>
    assertVectorShape(v, `${EMBEDDING_SPACE.id} embedding for "${operation}" input ${i}`)
  );

  return vectors;
}

/** Convenience for a single string. */
export async function embedOne(text: string, operation: string = 'embed'): Promise<number[]> {
  const [vec] = await embed([text], operation);
  return vec;
}

async function embedOpenAI(texts: string[], operation: string): Promise<number[][]> {
  if (!openaiApiKey) {
    throw new Error('OPENAI_API_KEY not set — required for EMBED_PROVIDER=openai');
  }

  const response = await fetchWithTimeout(
    'https://api.openai.com/v1/embeddings',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openaiApiKey}`,
      },
      body: JSON.stringify({ model: openaiEmbedModel, input: texts }),
    },
    { timeoutMs: TIMEOUTS.embed, label: 'OpenAI embeddings' }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI embeddings error: ${response.status} ${error}`);
  }

  const data: any = await response.json();
  // Sort by index defensively — the API returns in order but this is cheap insurance.
  const vectors: number[][] = data.data
    .sort((a: any, b: any) => a.index - b.index)
    .map((d: any) => d.embedding as number[]);

  recordEmbed(operation, 1, data.usage?.total_tokens ?? 0);
  return vectors;
}

async function embedOllama(texts: string[], operation: string): Promise<number[][]> {
  // Newer Ollama exposes /api/embed with batch `input`; fall back to per-text /api/embeddings.
  // Only a *shape* mismatch justifies the fallback — a timeout or a connection
  // failure must surface, not silently turn one batch call into N slow ones.
  const batch = await fetchWithTimeout(
    `${ollamaBaseURL}/api/embed`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: ollamaEmbedModel, input: texts }),
    },
    { timeoutMs: TIMEOUTS.embed, label: `Ollama embed (${ollamaEmbedModel})` }
  );

  if (batch.ok) {
    const data: any = await batch.json();
    if (Array.isArray(data.embeddings) && data.embeddings.length === texts.length) {
      recordEmbed(operation, 1, 0);
      return data.embeddings as number[][];
    }
  } else if (batch.status !== 404) {
    // 404 means this Ollama build predates /api/embed; anything else is a real error.
    const detail = await batch.text().catch(() => '');
    throw new Error(`Ollama embed error: ${batch.status} ${detail.slice(0, 300)}`);
  }

  const vectors: number[][] = [];
  for (const text of texts) {
    const response = await fetchWithTimeout(
      `${ollamaBaseURL}/api/embeddings`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: ollamaEmbedModel, prompt: text }),
      },
      { timeoutMs: TIMEOUTS.embed, label: `Ollama embeddings (${ollamaEmbedModel})` }
    );
    if (!response.ok) {
      const error = await response.text().catch(() => '');
      throw new Error(`Ollama embeddings error: ${response.status} ${error.slice(0, 300)}`);
    }
    const data: any = await response.json();
    vectors.push(data.embedding as number[]);
  }
  recordEmbed(operation, texts.length, 0);
  return vectors;
}

/**
 * Can the configured embedding provider actually serve a request?
 *
 * Field mode is embedding-driven: without embeddings there is no entity
 * resolution, no PPR seeding, and no retrieval. `EMBED_PROVIDER` defaults to
 * `openai` even when `LLM_PROVIDER=ollama`, so "I configured Ollama and it still
 * wants an API key" is the single most likely setup failure — worth reporting up
 * front instead of at the first ingest.
 */
export async function checkEmbedHealth(): Promise<{
  provider: string;
  model: string;
  ok: boolean;
  detail?: string;
}> {
  const base = { provider, model: embedModel(), ok: false as boolean };

  if (provider === 'local') {
    // No dependency to check — that is the entire point of this provider.
    return { ...base, ok: true, detail: 'Deterministic local embeddings (lexical only, not semantic)' };
  }

  if (provider !== 'ollama') {
    return openaiApiKey
      ? { ...base, ok: true }
      : {
          ...base,
          detail:
            'OPENAI_API_KEY is not set. EMBED_PROVIDER defaults to "openai" — set EMBED_PROVIDER=ollama for a key-free local run.',
        };
  }

  try {
    const response = await fetchWithTimeout(
      `${ollamaBaseURL}/api/tags`,
      { method: 'GET' },
      { timeoutMs: TIMEOUTS.healthcheck, label: 'Ollama tags' }
    );
    if (!response.ok) {
      return { ...base, detail: `Ollama returned ${response.status} from ${ollamaBaseURL}` };
    }
    const data: any = await response.json();
    const available: string[] = (data.models ?? []).map((m: any) => String(m.name));
    const hasModel = available.some(
      (name) => name === ollamaEmbedModel || name.split(':')[0] === ollamaEmbedModel.split(':')[0]
    );
    return hasModel
      ? { ...base, ok: true }
      : {
          ...base,
          detail: `Embedding model "${ollamaEmbedModel}" not pulled. Fix: ollama pull ${ollamaEmbedModel}`,
        };
  } catch (err) {
    return {
      ...base,
      detail: `Cannot reach Ollama at ${ollamaBaseURL}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

// ---------------------------------------------------------------------------
// Vector math (operates on the number[] vectors returned above)
// ---------------------------------------------------------------------------

/**
 * Dot product over two vectors of equal length.
 *
 * The length check is the point. This used to iterate `Math.min(a.length, b.length)`,
 * which silently truncated the longer operand — so comparing an OpenAI vector to
 * an Ollama one produced a plausible score from the first 768 coordinates of two
 * unrelated spaces. Mismatched dimensions mean mismatched models, which is a
 * corpus-level configuration error, not something to quietly average over.
 */
export function dot(a: number[], b: number[]): number {
  assertComparable(a, b, 'dot');
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

export function norm(a: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * a[i];
  return Math.sqrt(sum);
}

export function cosine(a: number[], b: number[]): number {
  assertComparable(a, b, 'cosine');
  const denom = norm(a) * norm(b);
  return denom === 0 ? 0 : dot(a, b) / denom;
}

export interface Scored<T> {
  item: T;
  score: number;
}

/** Top-k items by cosine similarity to `query`. */
export function topK<T>(
  query: number[],
  candidates: Array<{ item: T; vector: number[] }>,
  k: number
): Array<Scored<T>> {
  return candidates
    .map(({ item, vector }) => ({ item, score: cosine(query, vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
