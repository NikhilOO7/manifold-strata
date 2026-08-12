/**
 * Reciprocal Rank Fusion.
 *
 * Retrieval measurement showed the three signals we have are good at different
 * questions and bad at each other's: graph traversal is the only one that
 * answers multi-hop questions at all (100% recall where vector and lexical score
 * 0%), while plain lexical ranking is near-perfect on direct lookups where the
 * graph pipeline buried the answer at rank eight. Picking one loses whatever the
 * other was for.
 *
 * RRF combines ranked lists using only *positions*, never scores:
 *
 *     score(d) = Σ over rankers  weight_r / (k + rank_r(d))
 *
 * Position-only is the important property here. A cosine similarity of 0.83, a
 * `ts_rank` of 0.09, and a PageRank mass of 0.004 are numbers from three
 * unrelated scales; normalising them against each other means inventing a
 * conversion that no data supports, and that invented constant then silently
 * decides every ranking. Ranks are directly comparable by construction.
 *
 * `k` (conventionally 60) damps the influence of the very top positions so that
 * one confident ranker cannot dominate the others — agreement across rankers
 * matters more than any single ranker's certainty.
 */

export interface RankedList {
  /** Identifier for reporting which signal contributed. */
  name: string;
  /** Document ids in rank order, best first. */
  ids: string[];
  /** Relative influence. Equal weights unless there is evidence to differ. */
  weight?: number;
}

export interface FusedResult {
  id: string;
  score: number;
  /** Which rankers surfaced it, and at what rank — the explanation of the score. */
  sources: Array<{ name: string; rank: number }>;
}

export interface FuseOptions {
  /**
   * Rank damping constant. Higher values flatten the contribution of top
   * positions, favouring documents that several rankers agree on over one that a
   * single ranker put first.
   */
  k?: number;
  /** Cap on the fused output. */
  limit?: number;
}

export const DEFAULT_RRF_K = 60;

export function reciprocalRankFusion(
  lists: RankedList[],
  opts: FuseOptions = {}
): FusedResult[] {
  const k = opts.k ?? DEFAULT_RRF_K;
  const accumulated = new Map<string, FusedResult>();

  for (const list of lists) {
    const weight = list.weight ?? 1;
    if (weight === 0) continue;

    list.ids.forEach((id, index) => {
      const rank = index + 1;
      const contribution = weight / (k + rank);

      const existing = accumulated.get(id);
      if (existing) {
        existing.score += contribution;
        existing.sources.push({ name: list.name, rank });
      } else {
        accumulated.set(id, {
          id,
          score: contribution,
          sources: [{ name: list.name, rank }],
        });
      }
    });
  }

  const fused = [...accumulated.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Deterministic tie-break so repeated runs and tests are stable.
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return opts.limit !== undefined ? fused.slice(0, opts.limit) : fused;
}

/**
 * Normalise fused scores into [0, 1].
 *
 * MMR trades relevance against redundancy on a single scale, so the relevance
 * term has to be bounded for the lambda weighting to mean anything. RRF scores
 * are unbounded above and depend on how many rankers ran, which would otherwise
 * shift the trade-off whenever a ranker returns nothing.
 */
export function normalizeFusedScores(fused: FusedResult[]): Map<string, number> {
  const out = new Map<string, number>();
  if (fused.length === 0) return out;

  const max = fused[0].score;
  if (max <= 0) {
    for (const f of fused) out.set(f.id, 0);
    return out;
  }

  for (const f of fused) out.set(f.id, f.score / max);
  return out;
}
