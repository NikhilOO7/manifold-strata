/**
 * The indexed retrieval path: correct, domain-scoped, and bounded.
 *
 * "Bounded" is the property under test. The previous implementation was correct
 * and unusable — it read every node, every vector in the database, every edge and
 * every proposition per query, which measured at 12–15 seconds on a 50,000-entity
 * corpus. Correctness alone would not have caught that, so these tests assert on
 * the work performed as well as the answers returned.
 *
 * Requires Postgres:  pnpm --filter api test:db
 */

// Load the same .env the API loads: the embedding space (provider, model,
// dimensions) must match the database's vector columns, and a test process
// that missed it would compute 1536-dim vectors against a 768-dim column.
import 'dotenv/config';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { inArray } from 'drizzle-orm';
import { EMBEDDING_SPACE } from '../../services/embedding-space';

const dbUrl = process.env.TEST_DATABASE_URL;
if (dbUrl) process.env.DATABASE_URL = dbUrl;
process.env.NODE_ENV = 'test';

const shouldRun = Boolean(dbUrl);
const DIMS = EMBEDDING_SPACE.dimensions;

/** A unit vector pointing mostly along one axis — gives us controllable similarity. */
function axisVector(axis: number, noise = 0): number[] {
  const v = new Array<number>(DIMS).fill(0);
  v[axis % DIMS] = 1;
  if (noise > 0) {
    for (let i = 0; i < DIMS; i++) v[i] += ((i * 37) % 13) / 13 * noise;
    const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    for (let i = 0; i < DIMS; i++) v[i] /= n;
  }
  return v;
}

describe('indexed retrieval', { skip: shouldRun ? false : 'TEST_DATABASE_URL not set' }, () => {
  let db: typeof import('../../db').db;
  let schema: typeof import('../../db/schema');
  let retrieveField: typeof import('../../knowledge-field/retrieve').retrieveField;

  const createdPapers: string[] = [];
  const createdNodes: string[] = [];

  // A chain in `nlp`: target <- mid <- near(seed), plus a decoy in another domain.
  let nearId = '';
  let midId = '';
  let farId = '';
  let otherDomainId = '';

  before(async () => {
    ({ db } = await import('../../db'));
    schema = await import('../../db/schema');
    ({ retrieveField } = await import('../../knowledge-field/retrieve'));

    const mkPaper = async (domain: string, title: string) => {
      const [p] = await db
        .insert(schema.papers)
        .values({ title, domain, processed: true, processingStatus: 'completed' })
        .returning();
      createdPapers.push(p.id);
      return p.id;
    };

    const mkNode = async (domain: string, name: string, vec: number[], paperId: string) => {
      const [n] = await db
        .insert(schema.nodes)
        .values({ type: 'concept', domain, name, normalizedName: name.toLowerCase() })
        .returning();
      createdNodes.push(n.id);
      await db.insert(schema.nodeVectors).values({
        nodeId: n.id,
        embeddingVec: vec,
        model: EMBEDDING_SPACE.model,
        space: EMBEDDING_SPACE.id,
      });
      await db.insert(schema.propositions).values({
        paperId,
        text: `RETRIEVALTEST evidence about ${name}.`,
        embeddingVec: vec,
        nodeIds: [n.id],
        domain,
        space: EMBEDDING_SPACE.id,
      });
      return n.id;
    };

    const nlpPaper = await mkPaper('nlp', 'RETRIEVALTEST nlp paper');
    const gsPaper = await mkPaper('gaussian-splatting', 'RETRIEVALTEST gs paper');

    // axis 0 is the query direction; the chain walks away from it.
    nearId = await mkNode('nlp', 'RETRIEVALTEST near', axisVector(0), nlpPaper);
    midId = await mkNode('nlp', 'RETRIEVALTEST mid', axisVector(5), nlpPaper);
    farId = await mkNode('nlp', 'RETRIEVALTEST far', axisVector(9), nlpPaper);

    // Same direction as the query, but in another domain — must never surface.
    otherDomainId = await mkNode(
      'gaussian-splatting',
      'RETRIEVALTEST decoy',
      axisVector(0),
      gsPaper
    );

    await db.insert(schema.edges).values([
      { sourceId: nearId, targetId: midId, type: 'extends', domain: 'nlp', confidence: '0.9' },
      { sourceId: midId, targetId: farId, type: 'improves', domain: 'nlp', confidence: '0.9' },
      // A boundary-crossing edge that must not be followed.
      { sourceId: nearId, targetId: otherDomainId, type: 'uses', domain: 'nlp', confidence: '0.9' },
    ]);
  });

  after(async () => {
    if (!shouldRun) return;
    if (createdNodes.length) {
      await db.delete(schema.edges).where(inArray(schema.edges.sourceId, createdNodes));
      await db.delete(schema.edges).where(inArray(schema.edges.targetId, createdNodes));
      await db.delete(schema.nodes).where(inArray(schema.nodes.id, createdNodes));
    }
    if (createdPapers.length) {
      await db.delete(schema.papers).where(inArray(schema.papers.id, createdPapers));
    }
    const { closeDb } = await import('../../db');
    await closeDb();
  });

  test('ANN finds the nearest entity as the top seed', async () => {
    const result = await retrieveField('irrelevant', {
      domain: 'nlp',
      queryVector: axisVector(0),
    });
    assert.equal(result.seeds[0]?.id, nearId, 'the closest in-domain vector should seed first');
    assert.ok(result.seeds[0].score > 0.9);
  });

  test('seeds never come from another domain, however close the vector', async () => {
    // The decoy shares the query's exact direction; only its domain excludes it.
    const result = await retrieveField('irrelevant', {
      domain: 'nlp',
      queryVector: axisVector(0),
    });
    assert.ok(!result.seeds.some((s) => s.id === otherDomainId));
    assert.ok(!result.rankedNodes.some((n) => n.id === otherDomainId));
  });

  test('expansion reaches multi-hop neighbours the query does not resemble', async () => {
    // `far` is two hops out and orthogonal to the query — pure vector search
    // would never surface it. This is what the graph pass is for.
    const result = await retrieveField('irrelevant', {
      domain: 'nlp',
      queryVector: axisVector(0),
      expandHops: 3,
    });
    const ranked = result.rankedNodes.map((n) => n.id);
    assert.ok(ranked.includes(midId), 'one hop out should rank');
    assert.ok(ranked.includes(farId), 'two hops out should rank');
  });

  test('traversal refuses a boundary-crossing edge', async () => {
    const result = await retrieveField('irrelevant', {
      domain: 'nlp',
      queryVector: axisVector(0),
      expandHops: 3,
    });
    assert.ok(
      !result.rankedNodes.some((n) => n.id === otherDomainId),
      'a cross-domain edge must not be followed even when its stamp is in-domain'
    );
  });

  test('evidence is scoped to the domain', async () => {
    const result = await retrieveField('irrelevant', {
      domain: 'nlp',
      queryVector: axisVector(0),
    });
    assert.ok(result.evidence.length > 0);
    for (const e of result.evidence) {
      assert.ok(!e.text.includes('decoy'), 'evidence leaked from another domain');
    }
  });

  test('hop limit bounds how far expansion reaches', async () => {
    // seedK: 1 so only `near` enters as a seed. With the default seedK the whole
    // three-node chain seeds directly and the hop limit has nothing to constrain.
    const oneHop = await retrieveField('irrelevant', {
      domain: 'nlp',
      queryVector: axisVector(0),
      seedK: 1,
      expandHops: 1,
    });
    const ranked = oneHop.rankedNodes.map((n) => n.id);
    assert.ok(ranked.includes(midId), 'one hop out is reachable');
    assert.ok(!ranked.includes(farId), 'two hops out must not be reached with hops=1');
  });

  test('the working set is reported, and is far smaller than the corpus', async () => {
    const result = await retrieveField('irrelevant', {
      domain: 'nlp',
      queryVector: axisVector(0),
    });
    // The guard against silently reverting to whole-corpus reads: these numbers
    // are a function of the retrieval parameters, not of how much data exists.
    assert.ok(result.stats.seedCount <= 8);
    assert.ok(result.stats.subgraphNodes <= 4000);
    assert.ok(result.stats.candidateEvidence <= 400);
    assert.equal(result.stats.truncated, false);
  });

  test('caps are honoured when asked for a smaller working set', async () => {
    const result = await retrieveField('irrelevant', {
      domain: 'nlp',
      queryVector: axisVector(0),
      seedK: 2,
      maxSubgraphNodes: 3,
      maxEvidence: 1,
    });
    assert.ok(result.stats.seedCount <= 2);
    assert.ok(result.evidence.length <= 1);
  });

  test('an empty domain returns nothing rather than throwing', async () => {
    const result = await retrieveField('irrelevant', {
      domain: 'default',
      queryVector: axisVector(0),
    });
    assert.equal(result.evidence.length, 0);
    assert.equal(result.stats.subgraphNodes, 0);
  });

  test('a query vector from another space is rejected, not silently truncated', async () => {
    await assert.rejects(
      () =>
        retrieveField('irrelevant', {
          domain: 'nlp',
          queryVector: new Array(DIMS + 8).fill(0.1),
        }),
      /dimensional/i
    );
  });
});
