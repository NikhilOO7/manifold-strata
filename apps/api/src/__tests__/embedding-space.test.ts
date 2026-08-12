/**
 * The embedding-space contract.
 *
 * One deployment, one vector space. The defect this guards against produced no
 * error and no warning: `cosine()` reduced both operands to the shorter length,
 * so a 1536-dimension OpenAI vector scored 0.71 against a 768-dimension Ollama
 * one — a confident number computed from the first 768 coordinates of two
 * unrelated spaces. Flipping EMBED_PROVIDER on a populated corpus turned
 * retrieval into noise while every metric still looked healthy.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { cosine, dot, norm, topK } from '../services/embeddings';
import {
  EMBEDDING_SPACE,
  assertVectorShape,
  assertComparable,
  toVectorLiteral,
} from '../services/embedding-space';

const DIMS = EMBEDDING_SPACE.dimensions;
const ones = (n: number) => Array.from({ length: n }, () => 1 / Math.sqrt(n));

describe('cross-space comparison', () => {
  test('cosine refuses vectors of different dimension', () => {
    assert.throws(() => cosine(ones(1536), ones(768)), /different embedding models/);
  });

  test('dot refuses vectors of different dimension', () => {
    assert.throws(() => dot(ones(1536), ones(768)), /different embedding models/);
  });

  test('the error names both widths so the misconfiguration is obvious', () => {
    try {
      cosine(ones(1536), ones(768));
      assert.fail('expected a throw');
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.match(err.message, /1536/);
      assert.match(err.message, /768/);
    }
  });

  test('topK surfaces the mismatch rather than ranking nonsense', () => {
    assert.throws(
      () => topK(ones(1536), [{ item: 'a', vector: ones(768) }], 1),
      /different embedding models/
    );
  });

  test('same-dimension comparison still works normally', () => {
    const a = ones(DIMS);
    assert.ok(Math.abs(cosine(a, a) - 1) < 1e-9);
    assert.ok(Math.abs(norm(a) - 1) < 1e-9);
  });

  test('a zero vector scores 0 rather than NaN', () => {
    assert.equal(cosine(new Array(DIMS).fill(0), ones(DIMS)), 0);
  });
});

describe('assertVectorShape', () => {
  test('accepts a vector of the configured width', () => {
    assert.doesNotThrow(() => assertVectorShape(ones(DIMS), 'test'));
  });

  test('rejects the wrong width, naming the deployment space', () => {
    try {
      assertVectorShape(ones(DIMS + 1), 'node embedding');
      assert.fail('expected a throw');
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.match(err.message, /node embedding/);
      assert.match(err.message, new RegExp(String(DIMS)));
    }
  });

  test('rejects non-finite components', () => {
    const bad = ones(DIMS);
    bad[3] = Number.NaN;
    assert.throws(() => assertVectorShape(bad, 'test'), /non-finite/);
  });

  test('rejects a non-array', () => {
    assert.throws(() => assertVectorShape(undefined as never, 'test'), /expected an embedding/);
  });
});

describe('assertComparable', () => {
  test('passes for equal lengths, throws otherwise', () => {
    assert.doesNotThrow(() => assertComparable([1, 2], [3, 4], 'x'));
    assert.throws(() => assertComparable([1, 2], [3], 'x'), /different embedding models/);
  });
});

describe('space identity', () => {
  test('id encodes provider, model and dimensions', () => {
    // Recorded on every stored vector so a mixed-space corpus is detectable
    // after the fact rather than only when someone notices bad answers.
    assert.match(EMBEDDING_SPACE.id, /^[^:]+:[^:]+:\d+$/);
    assert.ok(EMBEDDING_SPACE.id.endsWith(`:${DIMS}`));
  });

  test('dimensions is a positive integer', () => {
    assert.ok(Number.isInteger(DIMS) && DIMS > 0);
  });
});

describe('toVectorLiteral', () => {
  test('formats as a pgvector literal', () => {
    assert.equal(toVectorLiteral([1, 2.5, -3]), '[1,2.5,-3]');
  });

  test('round-trips through the format pgvector parses', () => {
    const literal = toVectorLiteral(ones(4));
    assert.ok(literal.startsWith('[') && literal.endsWith(']'));
    assert.equal(literal.split(',').length, 4);
  });
});
