/**
 * The cleaner's judgement, tested on names taken from the live graph.
 *
 * Two failure modes matter and they pull in opposite directions. Dropping a real
 * entity destroys evidence permanently; keeping a formula fragment leaves the
 * entry-point lists full of noise. So both directions are pinned, and the
 * genuinely ambiguous cases must return `review` — a detector that guesses
 * confidently on "Base + reverse" vs "Base + reverse + dropout" is worse than
 * one that asks.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { judgeName, judgePair, judgeConnectivity, stripLeadingDeterminer } from '../quality/detectors';

const n = (id: string, name: string, type = 'method') => ({ id, name, type });

describe('name judgement', () => {
  const MUST_DROP: Array<[string, string]> = [
    ['dmodel = 512', 'a formula'],
    ['FFN(x) = max(0, xW1 + b1)W2 + b2 (2)', 'a formula'],
    ['si,j = maxj iS Ti + E Tj . We predict a non-null answer when s', 'a formula and a clause'],
    ['a model architecture eschewing recurrence and instead relying', 'a truncated clause'],
    ['input-feeding approach in which attentional vectors ht are con', 'a relative clause'],
    ['learning contextual representations through a task to predict', 'ends mid-phrase'],
  ];
  for (const [name, why] of MUST_DROP) {
    test(`drops "${name.slice(0, 38)}…" — ${why}`, () => {
      const j = judgeName(name);
      assert.equal(j.verdict, 'drop', j.reason);
      assert.equal(j.confidence, 'high', 'a bulk-appliable verdict must be high confidence');
    });
  }

  const MUST_KEEP = [
    'Transformer',
    'WMT 2014 English-to-German translation task',
    'multi-head attention',
    'BLEU',
    '3D Gaussian Splatting',
    'scaled dot-product attention',
  ];
  for (const name of MUST_KEEP) {
    test(`keeps "${name}"`, () => {
      assert.equal(judgeName(name).verdict, 'keep');
    });
  }

  test('a citation is flagged for review, never dropped outright', () => {
    // It may well be a real referenced work, which the graph should keep.
    for (const name of ['GNMT + RL [38]', 'Bahdanau et al., 2015']) {
      const j = judgeName(name);
      assert.equal(j.verdict, 'review', name);
      assert.notEqual(j.confidence, 'high');
    }
  });

  test('length alone is not a reason to drop', () => {
    // 90 characters, no clause, no formula: suspicious, not condemned.
    const long = 'Extremely Long But Perfectly Legitimate Benchmark Suite Name For Evaluation Purposes Here';
    const j = judgeName(long);
    assert.equal(j.verdict, 'review');
    assert.equal(j.confidence, 'low');
  });

  test('an empty name has nothing to keep', () => {
    assert.equal(judgeName('   ').verdict, 'drop');
  });
});

describe('pair judgement', () => {
  test('a leading determiner is not a distinction', () => {
    const j = judgePair(n('1', 'our input-feeding approach'), n('2', 'input-feeding approach'));
    assert.equal(j.verdict, 'merge');
    assert.equal(j.confidence, 'high');
    assert.equal(j.keep?.id, '2', 'the bare form survives');
  });

  test('the survivor is chosen by quality, not by length', () => {
    // The shorter name here is a truncated fragment; keeping it would discard
    // the good one. This is the bug the first version of the audit shipped.
    const j = judgePair(
      n('1', 'previous state-of-the-art models'),
      n('2', 'the previous state-of-the-art approach in which we ')
    );
    if (j.verdict === 'merge') {
      assert.equal(j.keep?.id, '1', 'a malformed name can never be the survivor');
    }
  });

  test('ablation variants are surfaced, never merged', () => {
    const j = judgePair(n('1', 'Base + reverse'), n('2', 'Base + reverse + dropout'));
    assert.equal(j.verdict, 'review');
    assert.match(j.reason, /variant/);
  });

  test('a citation list is not its member', () => {
    const j = judgePair(
      n('1', 'Bahdanau et al., 2015'),
      n('2', 'Bahdanau et al., 2015; Jean et al., 2015')
    );
    assert.notEqual(j.verdict, 'merge');
  });

  test('different granularities are not duplicates', () => {
    const j = judgePair(n('1', 'WMT'), n('2', 'WMT translation tasks between English and German'));
    assert.notEqual(j.verdict, 'merge');
  });

  test('unrelated names are simply kept', () => {
    assert.equal(judgePair(n('1', 'BLEU'), n('2', 'Transformer')).verdict, 'keep');
  });

  test('the merge guard still governs — a distinguishing word blocks the merge', () => {
    const j = judgePair(n('1', 'GNMT + RL'), n('2', 'GNMT + RL Ensemble'));
    assert.notEqual(j.verdict, 'merge');
  });
});

describe('connectivity and helpers', () => {
  test('an unreachable node is proposed for review, not dropped', () => {
    // It is usually a real entity whose paper has not been rebuilt yet.
    const j = judgeConnectivity(0);
    assert.equal(j.verdict, 'review');
    assert.notEqual(j.confidence, 'high');
  });

  test('a connected node is kept', () => {
    assert.equal(judgeConnectivity(3).verdict, 'keep');
  });

  test('determiners are stripped only from the front', () => {
    assert.equal(stripLeadingDeterminer('our approach'), 'approach');
    assert.equal(stripLeadingDeterminer('the Transformer'), 'Transformer');
    assert.equal(
      stripLeadingDeterminer('models of the world'),
      'models of the world',
      'a determiner inside the name carries meaning'
    );
  });
});
