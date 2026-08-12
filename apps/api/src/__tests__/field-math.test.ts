/**
 * The geometric layer's core claims, exercised directly.
 *
 * These are the functions that replace LLM calls — if PPR ranks the wrong nodes
 * or MMR ignores its budget, the product's central premise is false and nothing
 * downstream reveals it, because the output still looks like a plausible answer.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { personalizedPageRank } from '../knowledge-field/ppr';
import { mmrSelect } from '../knowledge-field/compress';
import { validateRelationshipsRules } from '../knowledge-field/validate-rules';
import { cosine, topK } from '../services/embeddings';

describe('personalizedPageRank', () => {
  const chain = [
    { sourceId: 'a', targetId: 'b', weight: 1 },
    { sourceId: 'b', targetId: 'c', weight: 1 },
    { sourceId: 'c', targetId: 'd', weight: 1 },
  ];

  test('distribution is normalized', () => {
    const r = personalizedPageRank(['a', 'b', 'c', 'd'], chain, new Map([['a', 1]]));
    const total = [...r.values()].reduce((s, v) => s + v, 0);
    assert.ok(Math.abs(total - 1) < 1e-6, `expected ~1, got ${total}`);
  });

  test('mass decays with distance beyond the first hop', () => {
    const r = personalizedPageRank(['a', 'b', 'c', 'd'], chain, new Map([['a', 1]]));
    assert.ok(r.get('b')! > r.get('c')!, 'one hop out beats two');
    assert.ok(r.get('c')! > r.get('d')!, 'two hops out beats three');
  });

  test('multi-hop mass reaches well beyond the immediate neighbourhood', () => {
    // This is the property the default restart probability is tuned for. It is
    // in tension with keeping the seed itself on top — see the note below.
    const r = personalizedPageRank(['a', 'b', 'c', 'd'], chain, new Map([['a', 1]]));
    assert.ok(r.get('c')! > 0.05, 'two hops out must receive real mass');
    assert.ok(r.get('d')! > 0.01, 'three hops out must receive mass');
  });

  test('a high-degree hub can outrank the query seed at the default restart', () => {
    // Documented rather than prevented, because measurement said so.
    //
    // At the default alpha a well-connected hub does absorb more mass than the
    // node that actually matched the query. Raising restart fixes that ordering
    // and makes retrieval *worse*: on the evaluation corpus multi-hop nDCG fell
    // from 63.1% to 30.1%, while the hub-topology family scored identically at
    // every alpha. Node ranking is not the outcome — evidence retrieval is, and
    // the relevant spoke still enters the top-ranked set either way.
    //
    // If this assertion ever flips, someone has raised alpha again; re-run
    // `pnpm --filter api eval -- --sweep-alpha` before accepting it.
    const edges = [{ sourceId: 'seed', targetId: 'hub', weight: 1 }];
    const ids = ['seed', 'hub'];
    for (let i = 0; i < 12; i++) {
      edges.push({ sourceId: 'hub', targetId: `n${i}`, weight: 1 });
      ids.push(`n${i}`);
    }

    const r = personalizedPageRank(ids, edges, new Map([['seed', 1]]));
    assert.ok(r.get('hub')! > r.get('seed')!, 'degree drives the walk at low restart');

    // And the counterweight: raising restart does restore seed dominance, so the
    // knob works — it is simply tuned for evidence quality instead.
    const highRestart = personalizedPageRank(ids, edges, new Map([['seed', 1]]), { alpha: 0.5 });
    assert.ok(highRestart.get('seed')! > highRestart.get('hub')!);
  });

  test('an unconnected node gets no propagated mass', () => {
    const r = personalizedPageRank(['a', 'b', 'island'], chain, new Map([['a', 1]]));
    assert.ok(r.get('island')! < r.get('b')!);
  });

  test('edge weight steers propagation', () => {
    const r = personalizedPageRank(
      ['seed', 'strong', 'weak'],
      [
        { sourceId: 'seed', targetId: 'strong', weight: 0.99 },
        { sourceId: 'seed', targetId: 'weak', weight: 0.05 },
      ],
      new Map([['seed', 1]])
    );
    assert.ok(r.get('strong')! > r.get('weak')!);
  });

  test('no usable seeds falls back to a uniform distribution rather than NaN', () => {
    const r = personalizedPageRank(['a', 'b'], [], new Map([['not-in-graph', 1]]));
    assert.ok(Math.abs(r.get('a')! - r.get('b')!) < 1e-9);
    for (const v of r.values()) assert.ok(Number.isFinite(v));
  });

  test('empty graph returns an empty map instead of throwing', () => {
    assert.equal(personalizedPageRank([], [], new Map()).size, 0);
  });

  test('seed weights need not be normalized', () => {
    const a = personalizedPageRank(['a', 'b'], chain, new Map([['a', 1]]));
    const b = personalizedPageRank(['a', 'b'], chain, new Map([['a', 500]]));
    assert.ok(Math.abs(a.get('a')! - b.get('a')!) < 1e-9);
  });
});

describe('mmrSelect', () => {
  const q = [1, 0];
  const near = [1, 0.02];
  const alsoNear = [1, 0.03];
  const different = [0, 1];

  test('respects the item cap', () => {
    const picked = mmrSelect(
      q,
      [near, alsoNear, different].map((v, i) => ({ item: i, vector: v, cost: 10 })),
      { maxItems: 2 }
    );
    assert.equal(picked.length, 2);
  });

  test('respects the character budget — the compression claim', () => {
    const picked = mmrSelect(
      q,
      [near, alsoNear, different].map((v, i) => ({ item: i, vector: v, cost: 100 })),
      { maxItems: 10, maxCost: 250 }
    );
    assert.ok(picked.length <= 2, `budget 250 with cost-100 items allows at most 2`);
  });

  test('an item larger than the whole budget is skipped, not force-included', () => {
    const picked = mmrSelect(q, [{ item: 'huge', vector: near, cost: 5_000 }], { maxCost: 100 });
    assert.equal(picked.length, 0);
  });

  test('prefers a diverse second pick over a near-duplicate of equal relevance', () => {
    // All three are near-equally relevant to the query, so the only thing that
    // can separate the runners-up is the redundancy penalty. `different` here is
    // a genuine alternative direction, not an irrelevant one.
    const query = [1, 1];
    const picked = mmrSelect(
      query,
      [
        { item: 'best', vector: [1, 0.91], cost: 1 },
        { item: 'near-duplicate', vector: [1, 0.9], cost: 1 },
        { item: 'diverse', vector: [0.9, 1], cost: 1 },
      ],
      { lambda: 0.5, maxItems: 2 }
    );
    assert.equal(picked[0].item, 'best');
    assert.equal(picked[1].item, 'diverse', 'MMR must penalize redundancy');
  });

  test('prior (PPR mass) lifts a graph-supported candidate over a merely-similar one', () => {
    const picked = mmrSelect(
      q,
      [
        { item: 'similar-only', vector: [1, 0.5], cost: 1 },
        { item: 'graph-supported', vector: [1, 2], cost: 1, prior: 5 },
      ],
      { maxItems: 1 }
    );
    assert.equal(picked[0].item, 'graph-supported');
  });

  test('prior multiplies relevance, so it cannot rescue an unrelated candidate', () => {
    // Worth pinning: PPR mass scales query similarity rather than being added to
    // it. A proposition orthogonal to the question stays at zero no matter how
    // central its nodes are — graph centrality alone never manufactures evidence.
    const picked = mmrSelect(
      q,
      [
        { item: 'weakly-similar', vector: near, cost: 1 },
        { item: 'orthogonal-but-central', vector: different, cost: 1, prior: 1000 },
      ],
      { maxItems: 1 }
    );
    assert.equal(picked[0].item, 'weakly-similar');
  });

  test('no candidates yields no selection', () => {
    assert.equal(mmrSelect(q, [], {}).length, 0);
  });
});

describe('vector helpers', () => {
  test('cosine of identical vectors is 1, orthogonal is 0', () => {
    assert.ok(Math.abs(cosine([1, 2, 3], [1, 2, 3]) - 1) < 1e-9);
    assert.ok(Math.abs(cosine([1, 0], [0, 1])) < 1e-9);
  });

  test('a zero vector scores 0 instead of producing NaN', () => {
    assert.equal(cosine([0, 0], [1, 1]), 0);
  });

  test('topK returns the closest candidates in order', () => {
    const out = topK(
      [1, 0],
      [
        { item: 'far', vector: [0, 1] },
        { item: 'close', vector: [1, 0.01] },
        { item: 'mid', vector: [1, 1] },
      ],
      2
    );
    assert.deepEqual(out.map((o) => o.item), ['close', 'mid']);
  });
});

describe('validateRelationshipsRules', () => {
  const rel = (over: Partial<Record<string, unknown>> = {}) => ({
    sourceName: 'NeRF',
    targetName: '3DGS',
    type: 'improves',
    confidence: 0.9,
    evidence: 'e',
    ...over,
  });

  const withEntities = (entities: Array<{ canonicalName: string; type: string }>) => ({
    resolvedEntities: entities.map((e) => ({
      mention: e.canonicalName,
      canonicalId: null,
      canonicalName: e.canonicalName,
      type: e.type as 'method',
      isNew: true,
      confidence: 0.8,
    })),
    resolvedRelationships: [] as ReturnType<typeof rel>[],
  });

  test('accepts a well-typed relationship', () => {
    const input = withEntities([
      { canonicalName: 'NeRF', type: 'method' },
      { canonicalName: '3DGS', type: 'method' },
    ]);
    input.resolvedRelationships = [rel()];
    const out = validateRelationshipsRules(input as never);
    assert.equal(out.accepted.length, 1);
  });

  test('rejects a self-referential edge', () => {
    const input = withEntities([{ canonicalName: 'NeRF', type: 'method' }]);
    input.resolvedRelationships = [rel({ targetName: 'nerf' })];
    const out = validateRelationshipsRules(input as never);
    assert.equal(out.accepted.length, 0);
    assert.match(out.rejected[0].reason, /degenerate|self/i);
  });

  test('rejects a type-incompatible edge (a dataset cannot improve a method)', () => {
    const input = withEntities([
      { canonicalName: 'MipNeRF360', type: 'dataset' },
      { canonicalName: '3DGS', type: 'method' },
    ]);
    input.resolvedRelationships = [rel({ sourceName: 'MipNeRF360' })];
    const out = validateRelationshipsRules(input as never);
    assert.equal(out.accepted.length, 0);
    assert.match(out.rejected[0].reason, /type mismatch/);
  });

  test('rejects evaluates_on pointing at something that is not a dataset or metric', () => {
    const input = withEntities([
      { canonicalName: '3DGS', type: 'method' },
      { canonicalName: 'NeRF', type: 'method' },
    ]);
    input.resolvedRelationships = [rel({ sourceName: '3DGS', targetName: 'NeRF', type: 'evaluates_on' })];
    const out = validateRelationshipsRules(input as never);
    assert.equal(out.accepted.length, 0);
  });

  test('drops edges below the confidence floor', () => {
    const input = withEntities([
      { canonicalName: 'NeRF', type: 'method' },
      { canonicalName: '3DGS', type: 'method' },
    ]);
    input.resolvedRelationships = [rel({ confidence: 0.1 })];
    const out = validateRelationshipsRules(input as never);
    assert.equal(out.accepted.length, 0);
    assert.match(out.rejected[0].reason, /below floor/);
  });

  test('dedups identical triples', () => {
    const input = withEntities([
      { canonicalName: 'NeRF', type: 'method' },
      { canonicalName: '3DGS', type: 'method' },
    ]);
    input.resolvedRelationships = [rel(), rel()];
    const out = validateRelationshipsRules(input as never);
    assert.equal(out.accepted.length, 1);
    assert.equal(out.rejected.length, 1);
  });

  test('unknown endpoint types soften rather than hard-reject (open type system)', () => {
    const input = withEntities([]);
    input.resolvedRelationships = [rel({ sourceName: 'Mystery', targetName: 'Other' })];
    const out = validateRelationshipsRules(input as never);
    assert.equal(out.accepted.length, 1, 'unknown types must not be treated as violations');
  });
});
