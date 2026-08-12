/**
 * Credential handling and the authorization decision.
 *
 * No database needed — these are the pure parts, and they are where the
 * dangerous mistakes live: a parser that rejects valid keys, a comparison that
 * leaks timing, a grant list that opens everything when it fails to load.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { issueKey, parseKey, hashSecret, verifySecret } from '../auth/keys';
import {
  canAccessDomain,
  hasScope,
  requireScope,
  requireDomainAccess,
  grantedDomains,
  AuthorizationError,
  ANONYMOUS_PRINCIPAL,
  type Principal,
} from '../auth/principal';

const principal = (over: Partial<Principal> = {}): Principal => ({
  ...ANONYMOUS_PRINCIPAL,
  name: 'test',
  scopes: ['read'],
  domains: ['nlp'],
  ...over,
});

describe('issueKey / parseKey', () => {
  test('an issued key parses back to its prefix', () => {
    const issued = issueKey();
    const parsed = parseKey(issued.key);
    assert.ok(parsed);
    assert.equal(parsed.prefix, issued.prefix);
  });

  test('every issued key round-trips — including secrets containing "_"', () => {
    // The regression. Secrets are base64url, whose alphabet includes `_` and `-`,
    // so splitting the key on every `_` produced four or more parts and rejected
    // roughly three keys in four. It failed *intermittently*, which is the worst
    // way for an authentication bug to present.
    for (let i = 0; i < 500; i++) {
      const issued = issueKey();
      const parsed = parseKey(issued.key);
      assert.ok(parsed, `failed to parse ${issued.key}`);
      assert.equal(parsed.prefix, issued.prefix);
      assert.ok(verifySecret(parsed.secret, issued.hash));
    }
  });

  test('at least one generated secret really does contain a separator', () => {
    // Proves the test above is exercising the case rather than getting lucky.
    const keys = Array.from({ length: 200 }, () => issueKey().key);
    assert.ok(
      keys.some((k) => k.slice(k.indexOf('_', k.indexOf('_') + 1) + 1).includes('_')),
      'expected some base64url secrets to contain "_"'
    );
  });

  test('keys are unique', () => {
    const keys = new Set(Array.from({ length: 200 }, () => issueKey().key));
    assert.equal(keys.size, 200);
  });

  test('the secret is not recoverable from what is stored', () => {
    const issued = issueKey();
    assert.ok(!issued.key.includes(issued.hash));
    assert.equal(issued.hash.length, 64, 'sha-256 hex');
  });

  test('malformed keys parse to null rather than a partial result', () => {
    for (const bad of [
      undefined,
      null,
      '',
      'garbage',
      'mk_only-one-part',
      'wrong_0011223344556677_secret',      // bad namespace
      'mk_tooshort_secret',                  // prefix wrong length
      'mk_ZZZZZZZZZZZZZZZZ_secret',          // prefix not hex
      'mk_00112233445566778_secret',         // prefix too long
      'mk_0011223344556677_',                // empty secret
    ]) {
      assert.equal(parseKey(bad as never), null, `"${bad}" should not parse`);
    }
  });
});

describe('verifySecret', () => {
  test('accepts the right secret and rejects a wrong one', () => {
    const issued = issueKey();
    const parsed = parseKey(issued.key)!;
    assert.equal(verifySecret(parsed.secret, issued.hash), true);
    assert.equal(verifySecret('not-the-secret', issued.hash), false);
  });

  test('rejects rather than throwing on a corrupt stored hash', () => {
    // Throwing here would 500 the request, which confirms the row exists.
    assert.doesNotThrow(() => verifySecret('x', 'not-hex'));
    assert.equal(verifySecret('x', 'not-hex'), false);
    assert.equal(verifySecret('x', ''), false);
  });

  test('hashing is deterministic', () => {
    assert.equal(hashSecret('abc'), hashSecret('abc'));
    assert.notEqual(hashSecret('abc'), hashSecret('abd'));
  });
});

describe('domain grants', () => {
  test('a named grant allows exactly that domain', () => {
    const p = principal({ domains: ['nlp'] });
    assert.equal(canAccessDomain(p, 'nlp'), true);
    assert.equal(canAccessDomain(p, 'gaussian-splatting'), false);
    assert.equal(canAccessDomain(p, 'default'), false);
  });

  test('the wildcard must be spelled out', () => {
    assert.equal(canAccessDomain(principal({ domains: ['*'] }), 'anything'), true);
  });

  test('an empty grant list authorises nothing', () => {
    // Default-deny. A grant list that failed to load must not be mistaken for
    // permission to read everything.
    assert.equal(canAccessDomain(principal({ domains: [] }), 'nlp'), false);
  });

  test('requireDomainAccess throws with the domain attached', () => {
    try {
      requireDomainAccess(principal({ domains: ['nlp'] }), 'gaussian-splatting');
      assert.fail('expected a throw');
    } catch (err) {
      assert.ok(err instanceof AuthorizationError);
      assert.equal(err.domain, 'gaussian-splatting');
    }
  });

  test('grantedDomains resolves against the registry', () => {
    const all = ['default', 'nlp', 'gaussian-splatting'];
    assert.deepEqual(grantedDomains(principal({ domains: ['nlp'] }), all), ['nlp']);
    assert.deepEqual(grantedDomains(principal({ domains: ['*'] }), all), all);
    assert.deepEqual(grantedDomains(principal({ domains: [] }), all), []);
    // A grant naming a domain that no longer exists yields nothing, not everything.
    assert.deepEqual(grantedDomains(principal({ domains: ['retired'] }), all), []);
  });
});

describe('scopes', () => {
  test('admin implies read and write', () => {
    const admin = principal({ scopes: ['admin'] });
    assert.equal(hasScope(admin, 'read'), true);
    assert.equal(hasScope(admin, 'write'), true);
    assert.equal(hasScope(admin, 'admin'), true);
  });

  test('write does not imply admin', () => {
    const writer = principal({ scopes: ['read', 'write'] });
    assert.equal(hasScope(writer, 'write'), true);
    assert.equal(hasScope(writer, 'admin'), false);
  });

  test('read does not imply write', () => {
    assert.equal(hasScope(principal({ scopes: ['read'] }), 'write'), false);
  });

  test('no scopes grants nothing', () => {
    assert.equal(hasScope(principal({ scopes: [] }), 'read'), false);
  });

  test('requireScope names the missing scope', () => {
    try {
      requireScope(principal({ scopes: ['read'] }), 'admin');
      assert.fail('expected a throw');
    } catch (err) {
      assert.ok(err instanceof AuthorizationError);
      assert.equal(err.requiredScope, 'admin');
    }
  });
});

describe('the authorization chokepoint', () => {
  test('no route calls the unauthenticated domain resolver directly', () => {
    // Structural guard, not a behavioural one. Every isolation defect found in
    // this codebase came from a route that omitted a check, so routes must go
    // through `requireDomain` (which resolves *and* authorizes). A new endpoint
    // that reaches for `resolveDomain` gets caught here rather than in
    // production.
    const routesDir = join(import.meta.dirname, '..', 'routes');
    const offenders: string[] = [];

    for (const file of readdirSync(routesDir).filter((f) => f.endsWith('.ts'))) {
      const source = readFileSync(join(routesDir, file), 'utf8');
      if (/\bresolveDomain\s*\(/.test(source)) offenders.push(file);
    }

    assert.deepEqual(
      offenders,
      [],
      `these routes bypass the authorization chokepoint: ${offenders.join(', ')}`
    );
  });
});
