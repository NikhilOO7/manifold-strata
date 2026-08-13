/**
 * The merge guard, tested against the pairs that actually occur.
 *
 * Every "must not merge" case below was found in the live graph, sitting above
 * the 0.82 cosine threshold that used to be sufficient to merge. They are not
 * hypothetical adversarial inputs — they are what this corpus contains, and any
 * one of them merging would have destroyed a distinction permanently and
 * silently.
 *
 * The "must merge" cases are the reason embedding-based resolution exists at
 * all. A guard that refused those would be a guard that turned the knowledge
 * field back into a pile of string literals, so both directions are pinned.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mayMerge, mergeMode } from '../knowledge-field/merge-guard';

/** Observed in the graph, with the cosine that would have merged them. */
const MUST_NOT_MERGE: Array<[string, string, string, number, string]> = [
  ['GNMT + RL [38]', 'GNMT + RL Ensemble [38]', 'model', 0.917, 'a model and its ensemble'],
  ['Deep-Att + PosUnk Ensemble [39]', 'Deep-Att + PosUnk [39]', 'model', 0.913, 'ditto, reversed'],
  [
    'WMT 2014 English-to-German translation task',
    'WMT 2014 English-to-French translation task',
    'task',
    0.904,
    'two different language pairs',
  ],
  [
    'recurrent neural networks',
    'gated recurrent neural networks',
    'model',
    0.888,
    'a qualifier that changes the architecture',
  ],
  [
    'Convolutional Sequence to Sequence Learning',
    'Sequence to Sequence Learning with Neural Networks',
    'paper',
    0.87,
    'two different papers',
  ],
  [
    'Neural Machine Translation by Jointly Learning to Align and Translate',
    'Effective Approaches to Attention-based Neural Machine Translation',
    'paper',
    0.833,
    'two different papers',
  ],
  [
    'averaging the last 20 checkpoints',
    'averaging the last 5 checkpoints',
    'concept',
    0.839,
    'different numbers are different claims',
  ],
];

/** The merges the embedding path exists to make. */
const MUST_MERGE: Array<[string, string, string, string]> = [
  ['Helios', 'Helios system', 'method', 'a bare name and the same name with a category word'],
  ['3DGS', '3D Gaussian Splatting', 'method', 'an initialism and its expansion'],
  ['PPR', 'personalized page rank', 'method', 'pure initials'],
  ['residual connection', 'residual connection technique', 'technique', 'trailing category word'],
  ['layer normalization', 'layer normalization technique', 'concept', 'trailing category word'],
  ['Transformer', 'Transformer models', 'model', 'plural category word'],
  ['self-attention', 'self-attention layers', 'concept', 'category word'],
];

describe('merge guard', () => {
  for (const [a, b, type, cos, why] of MUST_NOT_MERGE) {
    test(`refuses "${a.slice(0, 34)}" ↔ "${b.slice(0, 34)}" (cos ${cos}) — ${why}`, () => {
      const verdict = mayMerge({ name: a, type }, { name: b, type });
      assert.equal(verdict.ok, false);
      assert.ok(verdict.reason, 'a refusal must explain itself, or the split is unexplainable');
    });

    test(`…and refuses it in the other order too`, () => {
      // Identity is symmetric. A guard that depended on argument order would
      // merge or split the same pair differently depending on extraction order.
      assert.equal(mayMerge({ name: b, type }, { name: a, type }).ok, false);
    });
  }

  for (const [a, b, type, why] of MUST_MERGE) {
    test(`allows "${a}" ↔ "${b}" — ${why}`, () => {
      const verdict = mayMerge({ name: a, type }, { name: b, type });
      assert.equal(verdict.ok, true, verdict.reason);
      assert.equal(mayMerge({ name: b, type }, { name: a, type }).ok, true, 'and symmetrically');
    });
  }

  test('a paper never merges by similarity, whatever the names look like', () => {
    // The strongest form: even near-identical titles stay separate, because a
    // paper's identity is its title and an exact title match never reaches here.
    assert.equal(
      mayMerge(
        { name: 'Attention Is All You Need', type: 'paper' },
        { name: 'Attention Is All You Need Too', type: 'paper' }
      ).ok,
      false
    );
  });

  test('identical names merge', () => {
    assert.equal(mayMerge({ name: 'BERT', type: 'model' }, { name: 'bert', type: 'model' }).ok, true);
  });

  test('an empty name has no identity to match', () => {
    assert.equal(mayMerge({ name: '', type: 'model' }, { name: 'BERT', type: 'model' }).ok, false);
  });

  test('numbers are compared as a set, not as text', () => {
    assert.equal(
      mayMerge({ name: '4-layer transformer', type: 'model' }, { name: '6-layer transformer', type: 'model' }).ok,
      false
    );
    assert.equal(
      mayMerge({ name: 'BERT 2018 model', type: 'model' }, { name: 'BERT 2018', type: 'model' }).ok,
      true,
      'the same number in both is not a distinction'
    );
  });

  test('the mode defaults to guarded and only accepts known values', () => {
    const original = process.env.RESOLUTION_MERGE;
    try {
      delete process.env.RESOLUTION_MERGE;
      assert.equal(mergeMode(), 'guarded');
      process.env.RESOLUTION_MERGE = 'exact';
      assert.equal(mergeMode(), 'exact');
      process.env.RESOLUTION_MERGE = 'vector';
      assert.equal(mergeMode(), 'vector');
      process.env.RESOLUTION_MERGE = 'nonsense';
      assert.equal(mergeMode(), 'guarded', 'an unrecognised mode must not silently loosen merging');
    } finally {
      if (original === undefined) delete process.env.RESOLUTION_MERGE;
      else process.env.RESOLUTION_MERGE = original;
    }
  });
});
