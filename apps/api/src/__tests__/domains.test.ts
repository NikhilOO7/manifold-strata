/**
 * Domain resolution is the isolation boundary. These tests pin the fail-closed
 * contract: an unregistered domain is an error at every entry point, never a
 * silent substitution of the default domain.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveDomain,
  resolveStoredDomain,
  getDomain,
  normalizeDomainId,
  isKnownDomain,
  listDomains,
  UnknownDomainError,
  DEFAULT_DOMAIN_ID,
} from '../domains';

describe('resolveDomain (caller-supplied ids)', () => {
  test('absent domain means "no scope requested" and resolves to default', () => {
    assert.equal(resolveDomain(undefined).id, DEFAULT_DOMAIN_ID);
    assert.equal(resolveDomain(null).id, DEFAULT_DOMAIN_ID);
    assert.equal(resolveDomain('').id, DEFAULT_DOMAIN_ID);
    assert.equal(resolveDomain('   ').id, DEFAULT_DOMAIN_ID);
  });

  test('registered ids resolve to themselves', () => {
    assert.equal(resolveDomain('nlp').id, 'nlp');
    assert.equal(resolveDomain('gaussian-splatting').id, 'gaussian-splatting');
  });

  test('ids are normalized, so case and whitespace name the same domain', () => {
    assert.equal(resolveDomain('NLP').id, 'nlp');
    assert.equal(resolveDomain('  Gaussian-Splatting  ').id, 'gaussian-splatting');
  });

  test('an unregistered domain throws instead of falling back to default', () => {
    // This is the whole point: `?domain=nlpp` previously returned the DEFAULT
    // domain's data with a 200, so a caller asking for one field silently
    // received another's.
    assert.throws(() => resolveDomain('nlpp'), UnknownDomainError);
    assert.throws(() => resolveDomain('does-not-exist'), UnknownDomainError);
  });

  test('the error names the requested id and the valid options', () => {
    try {
      resolveDomain('nlpp');
      assert.fail('expected UnknownDomainError');
    } catch (err) {
      assert.ok(err instanceof UnknownDomainError);
      assert.equal(err.requested, 'nlpp');
      assert.ok(err.known.includes('nlp'));
      assert.ok(err.message.includes('nlpp'));
    }
  });
});

describe('resolveStoredDomain (values read from the database)', () => {
  test('NULL is legacy data and belongs to the default domain', () => {
    assert.equal(resolveStoredDomain(null, 'paper x').id, DEFAULT_DOMAIN_ID);
    assert.equal(resolveStoredDomain(undefined, 'paper x').id, DEFAULT_DOMAIN_ID);
  });

  test('a registered stored id resolves normally', () => {
    assert.equal(resolveStoredDomain('nlp', 'paper x').id, 'nlp');
  });

  test('an unregistered stored id throws rather than processing under the wrong ontology', () => {
    // A row written before ingress validation existed. Treating it as `default`
    // is what merged one field's entities into the shared default graph.
    assert.throws(() => resolveStoredDomain('nlpp', 'paper abc'), UnknownDomainError);
  });

  test('the error names the row so an operator can find it', () => {
    try {
      resolveStoredDomain('nlpp', 'paper abc-123');
      assert.fail('expected UnknownDomainError');
    } catch (err) {
      assert.ok(err instanceof UnknownDomainError);
      assert.ok(err.message.includes('paper abc-123'));
    }
  });
});

describe('getDomain (lenient — prompt context only)', () => {
  test('still falls back, and is therefore never used for scoping', () => {
    assert.equal(getDomain('nlpp').id, DEFAULT_DOMAIN_ID);
    assert.equal(getDomain('nlp').id, 'nlp');
  });
});

describe('helpers', () => {
  test('normalizeDomainId lowercases and trims', () => {
    assert.equal(normalizeDomainId('  NLP '), 'nlp');
  });

  test('isKnownDomain normalizes before checking', () => {
    assert.equal(isKnownDomain('NLP'), true);
    assert.equal(isKnownDomain('nlpp'), false);
  });

  test('every registered domain has a normalized id (registry self-consistency)', () => {
    // If a domain were registered as e.g. "NLP", normalized lookups would never
    // find it and it would be permanently unreachable through the strict path.
    for (const d of listDomains()) {
      assert.equal(d.id, normalizeDomainId(d.id), `domain "${d.id}" is not in normalized form`);
      assert.ok(isKnownDomain(d.id));
    }
  });
});
