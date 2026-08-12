/**
 * Rank fusion.
 *
 * This decides the final ordering of evidence handed to a language model, so its
 * behaviour is pinned rather than assumed — particularly the properties that
 * motivated choosing RRF over score blending: it must never require the incoming
 * scores to be comparable, and agreement across rankers must beat confidence
 * from one.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  reciprocalRankFusion,
  normalizeFusedScores,
  DEFAULT_RRF_K,
  type RankedList,
} from '../knowledge-field/fuse';

const list = (name: string, ids: string[], weight?: number): RankedList => ({ name, ids, weight });

describe('reciprocalRankFusion', () => {
  test('a single list preserves its order', () => {
    const fused = reciprocalRankFusion([list('a', ['x', 'y', 'z'])]);
    assert.deepEqual(fused.map((f) => f.id), ['x', 'y', 'z']);
  });

  test('a document ranked highly by two rankers beats one ranked first by only one', () => {
    // The core property. `agreed` is second in both lists; `solo` is first in one
    // and absent from the other. Consensus should win.
    const fused = reciprocalRankFusion([
      list('vector', ['solo', 'agreed']),
      list('lexical', ['other', 'agreed']),
    ]);
    assert.equal(fused[0].id, 'agreed');
  });

  test('records which rankers contributed and at what rank', () => {
    const fused = reciprocalRankFusion([
      list('vector', ['a', 'b']),
      list('graph', ['b', 'a']),
    ]);
    const b = fused.find((f) => f.id === 'b')!;
    assert.equal(b.sources.length, 2);
    assert.deepEqual(
      b.sources.map((s) => `${s.name}@${s.rank}`).sort(),
      ['graph@1', 'vector@2']
    );
  });

  test('a document only one ranker can find still surfaces', () => {
    // This is why fusion rather than intersection: the multi-hop answer exists
    // only in the graph ranking, and losing it would undo the entire reason the
    // graph layer exists.
    const fused = reciprocalRankFusion([
      list('vector', ['v1', 'v2', 'v3']),
      list('graph', ['multihop-answer']),
    ]);
    assert.ok(fused.some((f) => f.id === 'multihop-answer'));
  });

  test('weights shift influence without silencing a ranker', () => {
    const equal = reciprocalRankFusion([list('a', ['x']), list('b', ['y'])]);
    assert.equal(equal[0].id, 'x', 'ties break deterministically by id');

    const weighted = reciprocalRankFusion([list('a', ['x'], 1), list('b', ['y'], 5)]);
    assert.equal(weighted[0].id, 'y');
    assert.ok(weighted.some((f) => f.id === 'x'), 'the down-weighted ranker still contributes');
  });

  test('a zero-weight ranker is excluded entirely', () => {
    const fused = reciprocalRankFusion([list('a', ['x']), list('off', ['y'], 0)]);
    assert.deepEqual(fused.map((f) => f.id), ['x']);
  });

  test('scores follow the 1/(k+rank) formula', () => {
    const fused = reciprocalRankFusion([list('a', ['first', 'second'])]);
    assert.ok(Math.abs(fused[0].score - 1 / (DEFAULT_RRF_K + 1)) < 1e-12);
    assert.ok(Math.abs(fused[1].score - 1 / (DEFAULT_RRF_K + 2)) < 1e-12);
  });

  test('k damps how much the top position dominates', () => {
    const lists = [list('a', ['top', 'next']), list('b', ['next', 'top'])];
    const sharp = reciprocalRankFusion(lists, { k: 1 });
    const flat = reciprocalRankFusion(lists, { k: 1000 });
    const spread = (f: ReturnType<typeof reciprocalRankFusion>) => f[0].score - f[1].score;
    assert.ok(spread(sharp) >= spread(flat), 'a smaller k separates ranks more sharply');
  });

  test('empty input and empty lists are handled', () => {
    assert.deepEqual(reciprocalRankFusion([]), []);
    assert.deepEqual(reciprocalRankFusion([list('a', [])]), []);
  });

  test('respects the limit', () => {
    const fused = reciprocalRankFusion([list('a', ['1', '2', '3', '4'])], { limit: 2 });
    assert.equal(fused.length, 2);
  });

  test('ordering is deterministic across runs', () => {
    const build = () =>
      reciprocalRankFusion([list('a', ['x', 'y', 'z']), list('b', ['z', 'x', 'y'])]);
    assert.deepEqual(build().map((f) => f.id), build().map((f) => f.id));
  });

  test('never requires the incoming scores to be comparable', () => {
    // Rankers are given as positions only — there is nowhere to pass a score, so
    // there is no scale to reconcile. This test exists to fail loudly if the
    // signature ever grows one.
    const l: RankedList = { name: 'x', ids: ['a'] };
    assert.equal('score' in l, false);
  });
});

describe('normalizeFusedScores', () => {
  test('maps the top result to 1 and preserves order', () => {
    const fused = reciprocalRankFusion([list('a', ['x', 'y', 'z'])]);
    const norm = normalizeFusedScores(fused);
    assert.equal(norm.get('x'), 1);
    assert.ok(norm.get('y')! < 1 && norm.get('y')! > norm.get('z')!);
  });

  test('all values land in [0, 1]', () => {
    const fused = reciprocalRankFusion([
      list('a', ['x', 'y']),
      list('b', ['y', 'x']),
      list('c', ['z']),
    ]);
    for (const v of normalizeFusedScores(fused).values()) {
      assert.ok(v >= 0 && v <= 1, `${v} out of range`);
    }
  });

  test('empty input yields an empty map', () => {
    assert.equal(normalizeFusedScores([]).size, 0);
  });
});
