/**
 * When two names are allowed to become one node.
 *
 * ## Why a cosine threshold is not enough
 *
 * Resolution merged any two same-type mentions above 0.82 cosine. Audited
 * against the live graph, that bar sits *below* the similarity of entities that
 * are unambiguously different:
 *
 *   0.917  GNMT + RL [38]                     vs  GNMT + RL Ensemble [38]
 *   0.913  Deep-Att + PosUnk Ensemble [39]    vs  Deep-Att + PosUnk [39]
 *   0.904  WMT 2014 English-to-German task    vs  WMT 2014 English-to-French task
 *   0.888  recurrent neural networks          vs  gated recurrent neural networks
 *   0.870  Convolutional Sequence to Sequence vs  Sequence to Sequence Learning…
 *   0.833  Neural Machine Translation by …    vs  Effective Approaches to …
 *
 * Two distinct papers score 0.87. Two distinct language pairs score 0.90. There
 * is no threshold that separates these from genuine synonyms, because the
 * embedding measures topic, and identity is not topic.
 *
 * The asymmetry decides the design: a false SPLIT leaves two nodes that someone
 * can see and merge later, while a false MERGE destroys the distinction
 * silently and permanently — nothing downstream can recover that two things were
 * ever different. So this module refuses unless it can give a reason to proceed.
 *
 * ## The rules
 *
 * Cosine gets a vote, not a veto. Before any embedding-based merge:
 *
 *   1. Papers never merge by embedding. A paper's identity is its title, not its
 *      subject; two papers about attention are two papers.
 *   2. Numbers must match exactly. "last 20 checkpoints" and "last 5
 *      checkpoints" are different claims, as are [38] and [39], 4-layer and
 *      6-layer.
 *   3. Whatever the two names do NOT share must be generic. "Helios" and
 *      "Helios system" differ by a category word and are one thing; "GNMT + RL"
 *      and "GNMT + RL Ensemble" differ by a technical qualifier and are two.
 *   4. …unless one name is an initialism of the other, which is the case the
 *      whole embedding path exists for ("3DGS" / "3D Gaussian Splatting").
 *
 * Every one of the six pairs above is refused by these rules, and the merges the
 * system exists to make are still made. See merge-guard.test.ts, which asserts
 * exactly that using the real observed names.
 */

/**
 * Words that describe a category rather than an identity. If the only
 * difference between two names is drawn from this list, they name one thing.
 *
 * Deliberately short. Every addition widens what may merge, and the cost of a
 * wrong entry is a silent, permanent conflation — so a word belongs here only if
 * it carries no distinguishing information on its own.
 */
const GENERIC_TOKENS = new Set([
  'a', 'an', 'the', 'of', 'for', 'and', 'to', 'in', 'on', 'with', 'based',
  'system', 'systems',
  'model', 'models',
  'method', 'methods', 'methodology',
  'technique', 'techniques',
  'approach', 'approaches',
  'algorithm', 'algorithms',
  'framework', 'frameworks',
  'module', 'modules',
  'layer', 'layers',
  'mechanism', 'mechanisms',
  'architecture', 'architectures',
  'component', 'components',
  'strategy', 'strategies',
  'scheme', 'schemes',
]);

/** Types whose identity is never decided by topical similarity. */
const IDENTITY_BY_NAME_ONLY = new Set(['paper', 'paper_reference']);

export interface MergeVerdict {
  ok: boolean;
  /** Why the merge was refused — surfaced in logs so splits are explainable. */
  reason?: string;
}

function tokenize(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** Standalone numeric tokens, as a sorted multiset for comparison. */
function numbers(tokens: string[]): string[] {
  return tokens.filter((t) => /^\d+$/.test(t)).sort();
}

/**
 * Is `short` plausibly an initialism of `long`?
 *
 * Accepts both shapes that occur in practice: pure initials ("PPR" for
 * "personalized page rank") and a leading token kept whole with the rest
 * abbreviated ("3DGS" for "3D Gaussian Splatting").
 */
function isInitialism(short: string, longTokens: string[]): boolean {
  const compact = short.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  if (compact.length < 2 || longTokens.length < 2) return false;

  const initials = longTokens.map((t) => t[0]).join('');
  if (compact === initials) return true;

  // First token whole, remainder as initials.
  const head = longTokens[0];
  const tail = longTokens.slice(1).map((t) => t[0]).join('');
  return compact === `${head}${tail}`;
}

/**
 * May these two names become one node?
 *
 * `a` and `b` are interchangeable — the verdict is symmetric, because identity
 * is, and a rule that depended on argument order would merge or split the same
 * pair differently depending on extraction order.
 */
export function mayMerge(
  a: { name: string; type: string },
  b: { name: string; type: string }
): MergeVerdict {
  const typeA = (a.type || '').toLowerCase();
  const typeB = (b.type || '').toLowerCase();

  if (IDENTITY_BY_NAME_ONLY.has(typeA) || IDENTITY_BY_NAME_ONLY.has(typeB)) {
    return {
      ok: false,
      reason: 'papers are identified by title, not by topical similarity',
    };
  }

  const tokensA = tokenize(a.name);
  const tokensB = tokenize(b.name);
  if (tokensA.length === 0 || tokensB.length === 0) {
    return { ok: false, reason: 'a nameless mention has no identity to match' };
  }

  const numsA = numbers(tokensA);
  const numsB = numbers(tokensB);
  if (numsA.join(',') !== numsB.join(',')) {
    return {
      ok: false,
      reason: `different numbers (${numsA.join(',') || 'none'} vs ${numsB.join(',') || 'none'})`,
    };
  }

  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  const onlyA = tokensA.filter((t) => !setB.has(t));
  const onlyB = tokensB.filter((t) => !setA.has(t));

  if (onlyA.length === 0 && onlyB.length === 0) return { ok: true };

  // The abbreviation case: the names share nothing textually, and that is
  // exactly what makes it the case worth having embeddings for.
  if (isInitialism(a.name, tokensB) || isInitialism(b.name, tokensA)) {
    return { ok: true };
  }

  const distinguishing = [...onlyA, ...onlyB].filter((t) => !GENERIC_TOKENS.has(t));
  if (distinguishing.length > 0) {
    return {
      ok: false,
      reason: `distinguished by ${distinguishing.map((t) => `"${t}"`).join(', ')}`,
    };
  }

  return { ok: true };
}

/**
 * How aggressively resolution is allowed to merge.
 *
 *   exact    Only identical normalized names merge. Zero false merges by
 *            construction; the graph will hold synonym pairs the embedding
 *            would have joined.
 *   guarded  Embedding matches allowed, but only when `mayMerge` can justify
 *            them. The default: it makes every merge explainable.
 *   vector   Cosine alone, the original behaviour. Retained so the audit above
 *            can be reproduced, not because it is advisable.
 */
export type MergeMode = 'exact' | 'guarded' | 'vector';

export function mergeMode(): MergeMode {
  const raw = (process.env.RESOLUTION_MERGE || 'guarded').toLowerCase();
  return raw === 'exact' || raw === 'vector' ? raw : 'guarded';
}
