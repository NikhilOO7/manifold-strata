/**
 * Deterministic local embeddings — no model server, no API key, no network.
 *
 * `EMBED_PROVIDER=local`.
 *
 * This is a hashed character-n-gram projection, not a learned model. It captures
 * lexical overlap and nothing else: "cat" and "kitten" are unrelated to it. It
 * exists so that the parts of the system that are *not* the embedding model can
 * be exercised and measured without one — the evaluation harness, the retrieval
 * mechanics, CI, and a first-run developer who has not pulled a model yet.
 *
 * It is deliberately not a fallback. Nothing silently degrades to it; a
 * deployment gets it only by asking for it by name, because a knowledge product
 * quietly answering from lexical hashes would be worse than refusing to answer.
 *
 * Properties that matter for its purpose:
 *   - deterministic: the same text always yields the same vector, so a benchmark
 *     is reproducible across machines and runs
 *   - unit-normalised: cosine similarity behaves as expected
 *   - dimension-configurable: matches whatever the schema declares
 */

import { recordEmbed } from './metrics';

/** FNV-1a, 32-bit. Cheap, well-distributed, and stable across platforms. */
function fnv1a(text: string, seed = 0x811c9dc5): number {
  let hash = seed;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function tokenize(text: string): string[] {
  const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
  const words = normalized.split(/\s+/).filter((w) => w.length > 0);

  const features: string[] = [];
  for (const word of words) {
    features.push(word);
    // Character trigrams give partial credit for morphology and typos, which
    // pure word matching misses ("splatting" vs "splat").
    if (word.length > 3) {
      for (let i = 0; i <= word.length - 3; i++) {
        features.push(`#${word.slice(i, i + 3)}`);
      }
    }
  }

  // Adjacent word pairs carry a little word order.
  for (let i = 0; i < words.length - 1; i++) {
    features.push(`${words[i]}_${words[i + 1]}`);
  }

  return features;
}

/**
 * Project features into `dimensions` via the hashing trick, with a signed
 * second hash so unrelated features cancel rather than always accumulating.
 */
export function localEmbed(text: string, dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const features = tokenize(text);

  if (features.length === 0) {
    // An all-zero vector has no direction; cosine against it is 0 for everything,
    // which is the right answer for empty input but breaks pgvector's HNSW
    // (it cannot order by distance from the origin). Use a fixed direction.
    vector[0] = 1;
    return vector;
  }

  for (const feature of features) {
    const index = fnv1a(feature) % dimensions;
    const sign = fnv1a(feature, 0x9dc5811c) % 2 === 0 ? 1 : -1;
    // Dampen repeated features the way sublinear term frequency does.
    vector[index] += sign;
  }

  let norm = 0;
  for (let i = 0; i < dimensions; i++) {
    vector[i] = Math.sign(vector[i]) * Math.sqrt(Math.abs(vector[i]));
    norm += vector[i] * vector[i];
  }
  norm = Math.sqrt(norm);

  if (norm === 0) {
    vector[0] = 1;
    return vector;
  }

  for (let i = 0; i < dimensions; i++) vector[i] /= norm;
  return vector;
}

export function embedLocalBatch(
  texts: string[],
  dimensions: number,
  operation: string
): number[][] {
  const vectors = texts.map((t) => localEmbed(t, dimensions));
  recordEmbed(operation, texts.length, 0);
  return vectors;
}
