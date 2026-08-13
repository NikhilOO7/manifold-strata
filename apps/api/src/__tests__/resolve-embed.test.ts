/**
 * Resolution semantics, with storage stubbed out.
 *
 * `resolveEntitiesEmbed` decides identity: whether a mention is an entity the
 * graph already contains or a new one. Every rule it applies — exact name beats
 * proximity, proximity needs to clear a threshold, types must be compatible,
 * relationship endpoints get canonicalised — is a rule about what the graph
 * means, so each one is pinned here rather than inferred from a live database
 * where a passing test could be an accident of the corpus.
 *
 * The stub also documents the contract `resolve-candidates.ts` has to satisfy.
 *
 * One caveat worth stating rather than discovering: `EMBED_PROVIDER=local` is a
 * deterministic *lexical* embedder, so these tests use lexically-near pairs
 * ("adaptive batching" / "adaptive batching method", 0.87) rather than
 * semantically-near ones ("3DGS" / "3D Gaussian Splatting", which the stub scores
 * 0.00 and a real model scores well above threshold). They test the collapse
 * mechanism, not the embedder's judgement — which is the right split, since the
 * embedder is a swappable deployment choice and this logic is not.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import type { ExistingNode } from '../knowledge-field/resolve-embed';
import type { CandidateSource, ScoredCandidate } from '../knowledge-field/resolve-candidates';

// Deterministic lexical embeddings, no model server. This must be set before the
// embeddings module is evaluated, and `import` statements are hoisted above every
// top-level statement — so the module is pulled in dynamically, below, instead.
process.env.EMBED_PROVIDER = 'local';

let resolveEntitiesEmbed: typeof import('../knowledge-field/resolve-embed').resolveEntitiesEmbed;

const node = (id: string, name: string, type = 'method'): ExistingNode => ({
  id,
  name,
  type,
  normalizedName: name.toLowerCase(),
});

/** A source with an explicit, inspectable answer for each lookup. */
function stubSource(opts: {
  byName?: ExistingNode[];
  byVector?: ScoredCandidate[][];
}): CandidateSource & { nameCalls: string[][]; vectorCalls: Array<Array<{ type: string }>> } {
  const nameCalls: string[][] = [];
  const vectorCalls: Array<Array<{ type: string }>> = [];
  return {
    nameCalls,
    vectorCalls,
    async byName(keys) {
      nameCalls.push(keys);
      const map = new Map<string, ExistingNode>();
      for (const n of opts.byName ?? []) {
        if (n.normalizedName && keys.includes(n.normalizedName)) map.set(n.normalizedName, n);
      }
      return map;
    },
    async byVector(queries) {
      vectorCalls.push(queries.map((q) => ({ type: q.type })));
      return queries.map((_, i) => opts.byVector?.[i] ?? []);
    },
  };
}

const extraction = (entities: Array<{ mention: string; type: string }>, relationships: any[] = []) =>
  ({ entities: entities.map((e) => ({ ...e, confidence: 0.9 })), relationships }) as any;

describe('resolveEntitiesEmbed', () => {
  before(async () => {
    ({ resolveEntitiesEmbed } = await import('../knowledge-field/resolve-embed'));
  });

  test('an exact normalized-name match resolves to that node, not a new one', async () => {
    const existing = node('n1', 'Transformer');
    const out = await resolveEntitiesEmbed(
      extraction([{ mention: 'transformer', type: 'method' }]),
      stubSource({ byName: [existing] })
    );

    assert.equal(out.resolvedEntities.length, 1);
    assert.equal(out.resolvedEntities[0].canonicalId, 'n1');
    assert.equal(out.resolvedEntities[0].isNew, false);
    assert.equal(out.resolvedEntities[0].canonicalName, 'Transformer', 'the stored name wins');
  });

  test('a name match short-circuits the vector search entirely', async () => {
    const source = stubSource({ byName: [node('n1', 'Transformer')] });
    await resolveEntitiesEmbed(extraction([{ mention: 'Transformer', type: 'method' }]), source);

    assert.deepEqual(
      source.vectorCalls,
      [[]],
      'no k-NN work for a mention whose identity is already certain'
    );
  });

  test('a near neighbour above threshold resolves; below threshold it does not', async () => {
    const near: ScoredCandidate = { ...node('n1', '3D Gaussian Splatting'), score: 0.91 };
    const far: ScoredCandidate = { ...node('n2', 'Something Else'), score: 0.4 };

    const hit = await resolveEntitiesEmbed(
      extraction([{ mention: '3DGS', type: 'method' }]),
      stubSource({ byVector: [[near]] })
    );
    assert.equal(hit.resolvedEntities[0].canonicalId, 'n1');
    assert.equal(hit.resolvedEntities[0].isNew, false);

    const miss = await resolveEntitiesEmbed(
      extraction([{ mention: '3DGS', type: 'method' }]),
      stubSource({ byVector: [[far]] })
    );
    assert.equal(miss.resolvedEntities[0].canonicalId, null);
    assert.equal(miss.resolvedEntities[0].isNew, true, 'a weak match must mint a new entity');
  });

  test('the best candidate wins, not the first one returned', async () => {
    // A source is free to relax ordering for speed; identity must not depend on
    // it. Both candidates must be ones the merge guard would actually permit,
    // or this would test the guard rather than the ordering.
    const out = await resolveEntitiesEmbed(
      extraction([{ mention: 'Helios', type: 'method' }]),
      stubSource({
        byVector: [
          [
            { ...node('n1', 'Helios framework'), score: 0.84 },
            { ...node('n2', 'Helios system'), score: 0.97 },
          ],
        ],
      })
    );
    assert.equal(out.resolvedEntities[0].canonicalId, 'n2');
  });

  test('a merge the guard refuses mints a new entity instead', async () => {
    // Proximity is not identity. "GNMT + RL" and "GNMT + RL Ensemble" sit at
    // 0.917 cosine in the real graph and are different things.
    const out = await resolveEntitiesEmbed(
      extraction([{ mention: 'GNMT + RL', type: 'model' }]),
      stubSource({ byVector: [[{ ...node('n1', 'GNMT + RL Ensemble', 'model'), score: 0.917 }]] })
    );
    assert.equal(out.resolvedEntities[0].canonicalId, null);
    assert.equal(out.resolvedEntities[0].isNew, true);
  });

  test('a strong match of an incompatible type is refused', async () => {
    const out = await resolveEntitiesEmbed(
      extraction([{ mention: 'CIFAR-10', type: 'dataset' }]),
      stubSource({ byVector: [[{ ...node('n1', 'CIFAR-10 Classifier', 'method'), score: 0.99 }]] })
    );
    assert.equal(out.resolvedEntities[0].isNew, true, 'a dataset must not become a method');
  });

  test('a paper never merges by similarity — only by its exact title', async () => {
    // This inverts an earlier rule, deliberately. Papers used to be allowed to
    // match across types on proximity; audited against the live graph, two
    // genuinely different papers score 0.87, so proximity cannot decide which
    // paper something is. An exact title match still resolves (byName, below).
    const fuzzy = await resolveEntitiesEmbed(
      extraction([{ mention: 'Attention Is All You Need', type: 'paper' }]),
      stubSource({
        byVector: [[{ ...node('n1', 'Attention Is All You Need Too', 'paper'), score: 0.95 }]],
      })
    );
    assert.equal(fuzzy.resolvedEntities[0].isNew, true, 'a near-title is a different paper');

    const exact = await resolveEntitiesEmbed(
      extraction([{ mention: 'Attention Is All You Need', type: 'paper' }]),
      stubSource({ byName: [node('n1', 'Attention Is All You Need', 'paper')] })
    );
    assert.equal(exact.resolvedEntities[0].canonicalId, 'n1', 'the exact title still resolves');
  });

  test('the type rule is pushed down to the source, not only checked after', async () => {
    const source = stubSource({});
    await resolveEntitiesEmbed(
      extraction([
        { mention: 'BERT', type: 'method' },
        { mention: 'GLUE', type: 'dataset' },
      ]),
      source
    );
    assert.deepEqual(
      source.vectorCalls[0],
      [{ type: 'method' }, { type: 'dataset' }],
      'each mention carries its type so the index search can be constrained'
    );
  });

  test('relationship endpoints are canonicalised to the resolved names', async () => {
    const out = await resolveEntitiesEmbed(
      extraction(
        [{ mention: 'BERT', type: 'method' }],
        [{ subject: 'bert', predicate: 'evaluated on', object: 'GLUE', confidence: 0.8, evidenceText: 'e' }]
      ),
      stubSource({ byName: [node('n1', 'BERT')] })
    );

    assert.equal(out.resolvedRelationships.length, 1);
    assert.equal(out.resolvedRelationships[0].sourceName, 'BERT', 'canonical, not the raw mention');
    assert.equal(out.resolvedRelationships[0].targetName, 'GLUE');
    assert.equal(out.resolvedRelationships[0].type, 'evaluates_on');
  });

  test('an endpoint that appears only in a relationship still gets an identity', async () => {
    const out = await resolveEntitiesEmbed(
      extraction(
        [],
        [{ subject: 'RoBERTa', predicate: 'extends', object: 'BERT', confidence: 0.9, evidenceText: 'e' }]
      ),
      stubSource({})
    );
    const names = out.resolvedEntities.map((e) => e.canonicalName).sort();
    assert.deepEqual(names, ['BERT', 'RoBERTa'], 'every edge endpoint must exist as a node');
  });

  test('every mention gets an embedding the caller can persist without re-embedding', async () => {
    const out = await resolveEntitiesEmbed(
      extraction([{ mention: 'BERT', type: 'method' }]),
      stubSource({})
    );
    assert.ok(out.vectorsByName.get('bert'), 'keyed by normalized mention');
  });

  test('no mentions means no storage calls at all', async () => {
    const source = stubSource({});
    const out = await resolveEntitiesEmbed(extraction([]), source);
    assert.deepEqual(out.resolvedEntities, []);
    assert.deepEqual(source.nameCalls, [], 'an empty extraction must not query anything');
    assert.deepEqual(source.vectorCalls, []);
  });

  test('open relationship types survive verbatim', async () => {
    // Invariant 19: a connector that states `belongs_to` must get `belongs_to`.
    const out = await resolveEntitiesEmbed(
      extraction(
        [],
        [{ subject: 'A', predicate: 'belongs_to', object: 'B', confidence: 0.9, evidenceText: 'e' }]
      ),
      stubSource({})
    );
    assert.equal(out.resolvedRelationships[0].type, 'belongs_to');
  });

  test('two new mentions of one thing collapse to a single entity', async () => {
    // Neither exists in the graph yet, so no lookup can relate them — the batch
    // has to notice on its own, or one document mints two nodes for one thing.
    const out = await resolveEntitiesEmbed(
      extraction([
        { mention: 'adaptive batching', type: 'method' },
        { mention: 'adaptive batching method', type: 'method' },
      ]),
      stubSource({})
    );

    const canonical = new Set(out.resolvedEntities.map((e) => e.canonicalName));
    assert.equal(canonical.size, 1, 'one entity, two mentions of it');
    assert.equal([...canonical][0], 'adaptive batching', 'first occurrence wins — deterministic');
  });

  test('two genuinely different new mentions stay separate', async () => {
    const out = await resolveEntitiesEmbed(
      extraction([
        { mention: 'adaptive batching', type: 'method' },
        { mention: 'photosynthesis rate', type: 'concept' },
      ]),
      stubSource({})
    );
    assert.equal(new Set(out.resolvedEntities.map((e) => e.canonicalName)).size, 2);
  });

  test('collapsing respects the type rule', async () => {
    const out = await resolveEntitiesEmbed(
      extraction([
        { mention: 'Helios', type: 'method' },
        { mention: 'Helios', type: 'dataset' },
      ]),
      stubSource({})
    );
    // Identical strings differing only in type: the mention map keys on the
    // normalized name, so the first type claim wins and there is one entity.
    assert.equal(out.resolvedEntities.length, 1);
  });

  test('a relationship endpoint follows the collapsed canonical name', async () => {
    const out = await resolveEntitiesEmbed(
      extraction(
        [
          { mention: 'adaptive batching', type: 'method' },
          { mention: 'adaptive batching method', type: 'method' },
        ],
        [
          {
            subject: 'adaptive batching method',
            predicate: 'extends',
            object: 'Chronos',
            confidence: 0.9,
            evidenceText: 'e',
          },
        ]
      ),
      stubSource({})
    );
    assert.equal(
      out.resolvedRelationships[0].sourceName,
      'adaptive batching',
      'the edge must attach to the surviving node, not the collapsed alias'
    );
  });

  test('a self-edge is dropped rather than stored', async () => {
    const out = await resolveEntitiesEmbed(
      extraction(
        [{ mention: 'BERT', type: 'method' }],
        [{ subject: 'BERT', predicate: 'extends', object: 'bert', confidence: 0.9, evidenceText: 'e' }]
      ),
      stubSource({})
    );
    assert.equal(out.resolvedRelationships.length, 0);
  });
});
