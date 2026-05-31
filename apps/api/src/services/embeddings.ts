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

const provider = process.env.EMBED_PROVIDER || process.env.LLM_PROVIDER || 'openai';
const openaiApiKey = process.env.OPENAI_API_KEY;
const openaiEmbedModel = process.env.OPENAI_EMBED_MODEL || 'text-embedding-3-small';
const ollamaBaseURL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const ollamaEmbedModel = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';

export function embedProvider(): string {
  return provider;
}

export function embedModel(): string {
  return provider === 'ollama' ? ollamaEmbedModel : openaiEmbedModel;
}

/** Embed a batch of texts. Returns one vector per input, in order. */
export async function embed(texts: string[], operation: string = 'embed'): Promise<number[][]> {
  if (texts.length === 0) return [];
  // Guard against empty strings, which some providers reject.
  const safe = texts.map((t) => (t && t.trim().length > 0 ? t : ' '));
  if (provider === 'ollama') return embedOllama(safe, operation);
  return embedOpenAI(safe, operation);
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

  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${openaiApiKey}`,
    },
    body: JSON.stringify({ model: openaiEmbedModel, input: texts }),
  });

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
  try {
    const response = await fetch(`${ollamaBaseURL}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: ollamaEmbedModel, input: texts }),
    });

    if (response.ok) {
      const data: any = await response.json();
      if (Array.isArray(data.embeddings)) {
        recordEmbed(operation, 1, 0);
        return data.embeddings as number[][];
      }
    }
  } catch {
    // fall through to per-text path
  }

  const vectors: number[][] = [];
  for (const text of texts) {
    const response = await fetch(`${ollamaBaseURL}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: ollamaEmbedModel, prompt: text }),
    });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Ollama embeddings error: ${response.status} ${error}`);
    }
    const data: any = await response.json();
    vectors.push(data.embedding as number[]);
  }
  recordEmbed(operation, texts.length, 0);
  return vectors;
}

// ---------------------------------------------------------------------------
// Vector math (operates on the number[] vectors returned above)
// ---------------------------------------------------------------------------

export function dot(a: number[], b: number[]): number {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) sum += a[i] * b[i];
  return sum;
}

export function norm(a: number[]): number {
  return Math.sqrt(dot(a, a));
}

export function cosine(a: number[], b: number[]): number {
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
