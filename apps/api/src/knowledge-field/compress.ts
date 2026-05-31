/**
 * Context compression via Maximal Marginal Relevance (MMR).
 *
 * Naive RAG dumps the top-k raw chunks into the prompt — redundant and
 * token-heavy. MMR instead selects a minimal set of propositions that are each
 * relevant to the query while being non-redundant with what's already chosen,
 * under a hard character/token budget. Pure vector math, 0 LLM calls.
 *
 * This is the buildable equivalent of learned soft-prompt compression
 * (ICAE/gist), which would require model internals we don't control via the API.
 */

import { cosine } from '../services/embeddings';

export interface MmrCandidate<T> {
  item: T;
  vector: number[];
  /** Optional prior relevance (e.g. PPR score) multiplied into query relevance. */
  prior?: number;
  /** Length contribution toward the budget (default: text length if present). */
  cost: number;
}

export interface MmrOptions {
  lambda?: number;     // tradeoff: relevance vs diversity (0..1)
  maxItems?: number;
  maxCost?: number;    // budget (e.g. chars)
}

export interface MmrSelection<T> {
  item: T;
  score: number;
}

export function mmrSelect<T>(
  query: number[],
  candidates: Array<MmrCandidate<T>>,
  opts: MmrOptions = {}
): Array<MmrSelection<T>> {
  const lambda = opts.lambda ?? 0.7;
  const maxItems = opts.maxItems ?? 12;
  const maxCost = opts.maxCost ?? Infinity;

  const remaining = candidates.map((c) => ({
    ...c,
    relevance: cosine(query, c.vector) * (c.prior ?? 1),
  }));

  const selected: Array<MmrSelection<T>> = [];
  const selectedVectors: number[][] = [];
  let usedCost = 0;

  while (selected.length < maxItems && remaining.length > 0) {
    let bestIdx = -1;
    let bestScore = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i];
      if (usedCost + cand.cost > maxCost) continue;

      let maxSimToSelected = 0;
      for (const v of selectedVectors) {
        const sim = cosine(cand.vector, v);
        if (sim > maxSimToSelected) maxSimToSelected = sim;
      }
      const mmr = lambda * cand.relevance - (1 - lambda) * maxSimToSelected;
      if (mmr > bestScore) {
        bestScore = mmr;
        bestIdx = i;
      }
    }

    if (bestIdx === -1) break; // nothing fits the budget
    const [chosen] = remaining.splice(bestIdx, 1);
    selected.push({ item: chosen.item, score: bestScore });
    selectedVectors.push(chosen.vector);
    usedCost += chosen.cost;
  }

  return selected;
}
