/**
 * Retrieval metrics.
 *
 * These decide which retrieval strategy the product ships, so they get pinned
 * against hand-computed values rather than trusted. A quietly wrong nDCG would
 * not throw — it would just recommend the wrong architecture.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  recallAtK,
  precisionAtK,
  reciprocalRank,
  ndcgAtK,
  aggregate,
  scoreQuestion,
} from '../eval/metrics';

const gold = (...ids: string[]) => new Set(ids);

describe('recallAtK', () => {
  test('all relevant items retrieved', () => {
    assert.equal(recallAtK(['a', 'b', 'c'], gold('a', 'b'), 10), 1);
  });

  test('half retrieved', () => {
    assert.equal(recallAtK(['a', 'x'], gold('a', 'b'), 10), 0.5);
  });

  test('nothing relevant retrieved', () => {
    assert.equal(recallAtK(['x', 'y'], gold('a'), 10), 0);
  });

  test('items beyond k do not count', () => {
    assert.equal(recallAtK(['x', 'x', 'a'], gold('a'), 2), 0);
    assert.equal(recallAtK(['x', 'x', 'a'], gold('a'), 3), 1);
  });

  test('an empty gold set is vacuously satisfied', () => {
    assert.equal(recallAtK([], gold(), 10), 1);
  });
});

describe('precisionAtK', () => {
  test('every retrieved item relevant', () => {
    assert.equal(precisionAtK(['a', 'b'], gold('a', 'b'), 10), 1);
  });

  test('half the retrieved items relevant', () => {
    assert.equal(precisionAtK(['a', 'x'], gold('a'), 10), 0.5);
  });

  test('retrieving nothing scores zero, not one', () => {
    // The failure mode that made the old "character reduction" benchmark
    // meaningless: returning nothing must never look like success.
    assert.equal(precisionAtK([], gold('a'), 10), 0);
  });
});

describe('reciprocalRank', () => {
  test('first position gives 1', () => {
    assert.equal(reciprocalRank(['a', 'x'], gold('a')), 1);
  });

  test('third position gives 1/3', () => {
    assert.ok(Math.abs(reciprocalRank(['x', 'y', 'a'], gold('a')) - 1 / 3) < 1e-9);
  });

  test('absent gives 0', () => {
    assert.equal(reciprocalRank(['x', 'y'], gold('a')), 0);
  });
});

describe('ndcgAtK', () => {
  test('perfect ranking scores 1', () => {
    assert.equal(ndcgAtK(['a', 'b'], gold('a', 'b'), 10), 1);
  });

  test('a single relevant item at rank 1 scores 1', () => {
    assert.equal(ndcgAtK(['a', 'x', 'y'], gold('a'), 10), 1);
  });

  test('the same item at rank 2 scores log2(2)/log2(3)', () => {
    // DCG = 1/log2(3); IDCG = 1/log2(2) = 1. So nDCG = log2(2)/log2(3) ≈ 0.6309.
    const expected = 1 / Math.log2(3);
    assert.ok(Math.abs(ndcgAtK(['x', 'a'], gold('a'), 10) - expected) < 1e-9);
  });

  test('rewards putting relevant items earlier', () => {
    const early = ndcgAtK(['a', 'x', 'y', 'z'], gold('a'), 10);
    const late = ndcgAtK(['x', 'y', 'z', 'a'], gold('a'), 10);
    assert.ok(early > late, 'earlier placement must score higher');
  });

  test('nothing relevant scores 0', () => {
    assert.equal(ndcgAtK(['x'], gold('a'), 10), 0);
  });

  test('two relevant items out of order beat neither being found', () => {
    assert.ok(ndcgAtK(['x', 'a', 'b'], gold('a', 'b'), 10) > 0);
  });
});

describe('aggregate', () => {
  test('averages across questions and reports the found rate', () => {
    const scores = [
      scoreQuestion(['a'], gold('a'), 10, 100, 5),
      scoreQuestion(['x'], gold('b'), 10, 200, 15),
    ];
    const agg = aggregate(scores);
    assert.equal(agg.questions, 2);
    assert.equal(agg.recall, 0.5);
    assert.equal(agg.answeredAtAll, 0.5, 'one of two questions found any evidence');
    assert.equal(agg.meanContextChars, 150);
  });

  test('empty input does not divide by zero', () => {
    const agg = aggregate([]);
    assert.equal(agg.questions, 0);
    assert.equal(agg.recall, 0);
    for (const v of Object.values(agg)) assert.ok(Number.isFinite(v));
  });

  test('reports latency percentiles', () => {
    const scores = Array.from({ length: 10 }, (_, i) =>
      scoreQuestion(['a'], gold('a'), 10, 10, (i + 1) * 10)
    );
    const agg = aggregate(scores);
    assert.equal(agg.p50LatencyMs, 50);
    assert.equal(agg.p95LatencyMs, 100);
  });
});
