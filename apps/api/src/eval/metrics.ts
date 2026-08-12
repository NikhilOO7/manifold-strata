/**
 * Retrieval quality metrics.
 *
 * The system previously reported only *character reduction* and called it a
 * benchmark. Compression without a quality axis is not just incomplete, it is
 * gameable in the wrong direction: returning nothing scores a perfect 100%.
 * These are the standard information-retrieval measures, so a number here means
 * the same thing it means everywhere else.
 *
 * Relevance is binary — a retrieved item either is or is not in the gold set.
 * Graded relevance would be better and needs human labelling; binary is what a
 * constructed gold set can honestly support.
 */

export interface RankedItem {
  id: string;
}

/**
 * Fraction of the gold set that appears anywhere in the top k.
 *
 * The headline number for "did we find it at all". A retrieval layer feeding an
 * LLM cares more about recall than precision: evidence that was never retrieved
 * cannot be reasoned over, while a few extra items only cost tokens.
 */
export function recallAtK(retrieved: string[], gold: Set<string>, k: number): number {
  if (gold.size === 0) return 1;
  const top = retrieved.slice(0, k);
  let hits = 0;
  for (const id of top) if (gold.has(id)) hits++;
  return hits / gold.size;
}

/** Fraction of the top k that is relevant — the token-efficiency side of the trade. */
export function precisionAtK(retrieved: string[], gold: Set<string>, k: number): number {
  const top = retrieved.slice(0, k);
  if (top.length === 0) return 0;
  let hits = 0;
  for (const id of top) if (gold.has(id)) hits++;
  return hits / top.length;
}

/**
 * Reciprocal rank of the first relevant item.
 *
 * Position matters when the consumer is a language model with a finite context:
 * evidence at rank 1 gets read, evidence at rank 40 may be truncated away.
 */
export function reciprocalRank(retrieved: string[], gold: Set<string>): number {
  for (let i = 0; i < retrieved.length; i++) {
    if (gold.has(retrieved[i])) return 1 / (i + 1);
  }
  return 0;
}

/**
 * Normalised discounted cumulative gain at k, binary relevance.
 *
 * Unlike recall, this rewards putting the right evidence *early*, and unlike MRR
 * it accounts for every relevant item rather than only the first.
 */
export function ndcgAtK(retrieved: string[], gold: Set<string>, k: number): number {
  if (gold.size === 0) return 1;

  let dcg = 0;
  const top = retrieved.slice(0, k);
  for (let i = 0; i < top.length; i++) {
    if (gold.has(top[i])) dcg += 1 / Math.log2(i + 2);
  }

  // Ideal ordering: every relevant item packed at the front.
  let idcg = 0;
  const ideal = Math.min(gold.size, k);
  for (let i = 0; i < ideal; i++) idcg += 1 / Math.log2(i + 2);

  return idcg === 0 ? 0 : dcg / idcg;
}

export interface QuestionScore {
  recall: number;
  precision: number;
  ndcg: number;
  mrr: number;
  contextChars: number;
  latencyMs: number;
  found: boolean;
}

export function scoreQuestion(
  retrieved: string[],
  gold: Set<string>,
  k: number,
  contextChars: number,
  latencyMs: number
): QuestionScore {
  const recall = recallAtK(retrieved, gold, k);
  return {
    recall,
    precision: precisionAtK(retrieved, gold, k),
    ndcg: ndcgAtK(retrieved, gold, k),
    mrr: reciprocalRank(retrieved, gold),
    contextChars,
    latencyMs,
    found: recall > 0,
  };
}

export interface AggregateScore {
  questions: number;
  recall: number;
  precision: number;
  ndcg: number;
  mrr: number;
  answeredAtAll: number;
  meanContextChars: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function aggregate(scores: QuestionScore[]): AggregateScore {
  const n = scores.length;
  if (n === 0) {
    return {
      questions: 0,
      recall: 0,
      precision: 0,
      ndcg: 0,
      mrr: 0,
      answeredAtAll: 0,
      meanContextChars: 0,
      p50LatencyMs: 0,
      p95LatencyMs: 0,
    };
  }
  const mean = (pick: (s: QuestionScore) => number) =>
    scores.reduce((sum, s) => sum + pick(s), 0) / n;

  return {
    questions: n,
    recall: mean((s) => s.recall),
    precision: mean((s) => s.precision),
    ndcg: mean((s) => s.ndcg),
    mrr: mean((s) => s.mrr),
    answeredAtAll: scores.filter((s) => s.found).length / n,
    meanContextChars: mean((s) => s.contextChars),
    p50LatencyMs: percentile(scores.map((s) => s.latencyMs), 50),
    p95LatencyMs: percentile(scores.map((s) => s.latencyMs), 95),
  };
}
