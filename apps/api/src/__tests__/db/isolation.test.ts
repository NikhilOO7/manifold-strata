/**
 * Domain isolation, proven against a real database through the real HTTP app.
 *
 * This is the product's central correctness claim ("entities never resolve or
 * link across domains"), and it was false in both directions:
 *
 *   read  — `?domain=<typo>` resolved to the DEFAULT domain and returned its
 *           data with a 200, so asking for one field silently returned another's.
 *   walk  — subgraph/hierarchy traversal was unscoped, so expanding a node
 *           crossed into other domains regardless of the requested scope.
 *
 * Requires Postgres:  pnpm --filter api test:db
 *
 * Gated on TEST_DATABASE_URL specifically — never plain DATABASE_URL. This suite
 * writes and deletes rows, and picking up an ambient DATABASE_URL would point it
 * at a developer's working database. Skips cleanly when unset.
 */

// Load the same .env the API loads: the embedding space (provider, model,
// dimensions) must match the database's vector columns, and a test process
// that missed it would compute 1536-dim vectors against a 768-dim column.
import 'dotenv/config';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql, eq, inArray } from 'drizzle-orm';

const dbUrl = process.env.TEST_DATABASE_URL;
if (dbUrl) process.env.DATABASE_URL = dbUrl;
// Keep the app from binding a port or firing startup probes on import.
process.env.NODE_ENV = 'test';

const shouldRun = Boolean(dbUrl);

describe('domain isolation (Postgres-backed)', { skip: shouldRun ? false : 'TEST_DATABASE_URL not set' }, () => {
  let app: import('hono').Hono;
  let db: typeof import('../../db').db;
  let schema: typeof import('../../db/schema');

  // Ids created by this suite, so teardown never touches anything else.
  const created = { papers: [] as string[], nodes: [] as string[] };
  let nlpNodeId = '';
  let gsNodeId = '';
  let nlpEdgeId = '';

  before(async () => {
    ({ app } = await import('../../index'));
    ({ db } = await import('../../db'));
    schema = await import('../../db/schema');

    const mk = async (domain: string, title: string, entity: string) => {
      const [paper] = await db
        .insert(schema.papers)
        .values({ title, domain, processed: true, processingStatus: 'completed' })
        .returning();
      created.papers.push(paper.id);

      const [paperNode] = await db
        .insert(schema.nodes)
        .values({
          type: 'paper',
          domain,
          name: title,
          normalizedName: title.toLowerCase(),
          paperId: paper.id,
        })
        .returning();

      // Deliberately the SAME entity name in both domains — "attention" in NLP
      // and in vision are different things and must stay different nodes.
      const [entityNode] = await db
        .insert(schema.nodes)
        .values({ type: 'concept', domain, name: entity, normalizedName: entity.toLowerCase() })
        .returning();

      created.nodes.push(paperNode.id, entityNode.id);

      const [edge] = await db
        .insert(schema.edges)
        .values({
          sourceId: paperNode.id,
          targetId: entityNode.id,
          type: 'introduces',
          domain,
          confidence: '0.9',
        })
        .returning();

      await db.insert(schema.propositions).values({
        paperId: paper.id,
        text: `${title} introduces ${entity}.`,
        nodeIds: [paperNode.id, entityNode.id],
        domain,
      });

      return { paperId: paper.id, paperNodeId: paperNode.id, entityNodeId: entityNode.id, edgeId: edge.id };
    };

    const nlp = await mk('nlp', 'ISOLATIONTEST Transformer Paper', 'ISOLATIONTEST attention');
    const gs = await mk('gaussian-splatting', 'ISOLATIONTEST Splatting Paper', 'ISOLATIONTEST attention');

    nlpNodeId = nlp.entityNodeId;
    gsNodeId = gs.entityNodeId;
    nlpEdgeId = nlp.edgeId;

    // A cross-domain edge should never exist in normal operation. Creating one
    // here proves traversal refuses to follow it rather than assuming absence.
    await db.insert(schema.edges).values({
      sourceId: nlp.entityNodeId,
      targetId: gs.entityNodeId,
      type: 'uses',
      domain: 'nlp',
      confidence: '0.9',
    });
  });

  after(async () => {
    if (!shouldRun) return;
    if (created.nodes.length) {
      await db.delete(schema.edges).where(inArray(schema.edges.sourceId, created.nodes));
      await db.delete(schema.edges).where(inArray(schema.edges.targetId, created.nodes));
      await db.delete(schema.nodes).where(inArray(schema.nodes.id, created.nodes));
    }
    if (created.papers.length) {
      await db.delete(schema.propositions).where(inArray(schema.propositions.paperId, created.papers));
      await db.delete(schema.papers).where(inArray(schema.papers.id, created.papers));
    }
    // The pool is shared across every suite in this process, so it is drained
    // once at the very end rather than here.
  });

  // --- Unknown domains fail closed at every entry point ---------------------

  const unknownDomainCases: Array<[string, string]> = [
    ['graph nodes', '/api/graph/nodes?domain=nlpp'],
    ['graph edges', '/api/graph/edges?domain=nlpp'],
    ['graph stats', '/api/graph/stats?domain=nlpp'],
    ['graph types', '/api/graph/types?domain=nlpp'],
    ['papers list', '/api/papers?domain=nlpp'],
    ['field retrieve', '/api/field/retrieve?q=attention&domain=nlpp'],
    ['ingest seed', '/api/ingest/seed/nlpp'],
  ];

  for (const [name, path] of unknownDomainCases) {
    test(`${name}: an unregistered domain is a 400, not the default domain's data`, async () => {
      const res = await app.request(path);
      assert.equal(res.status, 400, `${path} should reject an unknown domain`);
      const body = (await res.json()) as { error: string; knownDomains?: string[] };
      assert.equal(body.error, 'Unknown domain');
      assert.ok(body.knownDomains?.includes('nlp'), 'the error should name the valid domains');
    });
  }

  test('POST /api/ingest/arxiv rejects an unregistered domain before creating a job', async () => {
    const res = await app.request('/api/ingest/arxiv', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ arxivId: '2308.04079', domain: 'nlpp' }),
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: string }).error, 'Unknown domain');
  });

  test('POST /api/domains/backfill refuses to stamp rows into an unregistered domain', async () => {
    // The single most destructive endpoint: it rewrites every NULL-domain row
    // across five tables, irreversibly.
    const res = await app.request('/api/domains/backfill', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ domain: 'nlpp' }),
    });
    assert.equal(res.status, 400);
  });

  test('POST /api/domains/backfill supports a dry run that changes nothing', async () => {
    const res = await app.request('/api/domains/backfill', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ domain: 'nlp', dryRun: true }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { dryRun: boolean; wouldStamp: Record<string, number> };
    assert.equal(body.dryRun, true);
    assert.ok(typeof body.wouldStamp.nodes === 'number');
  });

  // --- Scoped reads return only their own domain ----------------------------

  test('the same entity name in two domains stays two separate nodes', async () => {
    const res = await app.request('/api/graph/nodes?domain=nlp&search=ISOLATIONTEST%20attention');
    const body = (await res.json()) as { nodes: Array<{ id: string; domain: string }> };
    assert.ok(body.nodes.length >= 1);
    for (const n of body.nodes) assert.equal(n.domain, 'nlp');
    assert.ok(body.nodes.some((n) => n.id === nlpNodeId));
    assert.ok(!body.nodes.some((n) => n.id === gsNodeId), 'must not leak the other domain node');
  });

  test('graph stats are scoped, not global', async () => {
    const nlpRes = (await (await app.request('/api/graph/stats?domain=nlp')).json()) as any;
    const allRes = (await (await app.request('/api/graph/stats')).json()) as any;
    assert.ok(allRes.nodes.total >= nlpRes.nodes.total);
  });

  // --- Traversal never crosses a domain boundary ----------------------------

  test('subgraph traversal refuses to follow a cross-domain edge', async () => {
    const res = await app.request(`/api/graph/subgraph?nodeId=${nlpNodeId}&depth=3`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      domain: string;
      nodes: Array<{ id: string; domain: string }>;
    };
    assert.equal(body.domain, 'nlp');
    for (const n of body.nodes) {
      assert.equal(n.domain, 'nlp', `node ${n.id} from domain ${n.domain} leaked into an nlp subgraph`);
    }
    assert.ok(!body.nodes.some((n) => n.id === gsNodeId), 'the cross-domain edge must not be followed');
  });

  test('a node detail view only returns in-domain relationships', async () => {
    const res = await app.request(`/api/graph/nodes/${nlpNodeId}`);
    const body = (await res.json()) as {
      domain: string;
      outgoingEdges: Array<{ targetNode: { id: string; domain: string } }>;
    };
    assert.equal(body.domain, 'nlp');
    for (const e of body.outgoingEdges) {
      assert.equal(e.targetNode.domain, 'nlp');
    }
  });

  test('requesting a node under the wrong domain returns 404, not 403', async () => {
    // A 403 would confirm the node exists in some other domain. Absence is the
    // only safe answer across an isolation boundary.
    const res = await app.request(`/api/graph/nodes/${nlpNodeId}?domain=gaussian-splatting`);
    assert.equal(res.status, 404);
  });

  test('provenance for an edge is hidden from another domain', async () => {
    const ok = await app.request(`/api/graph/queries/provenance/${nlpEdgeId}?domain=nlp`);
    assert.equal(ok.status, 200);
    const wrong = await app.request(`/api/graph/queries/provenance/${nlpEdgeId}?domain=gaussian-splatting`);
    assert.equal(wrong.status, 404);
  });

  // --- Writes persist canonical domain ids ----------------------------------

  test('a paper created via the API stores the canonical (normalized) domain id', async () => {
    const res = await app.request('/api/papers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'ISOLATIONTEST Case Paper', domain: '  NLP  ' }),
    });
    assert.equal(res.status, 201);
    const paper = (await res.json()) as { id: string; domain: string };
    created.papers.push(paper.id);
    // Storing the raw string is what let a paper claim one domain while its
    // extracted entities were stamped with another.
    assert.equal(paper.domain, 'nlp');
  });

  test('a malformed id is a 404, not a 500 leaking a database error', async () => {
    // Postgres rejects a non-UUID literal against a uuid column with a query
    // error, which the route catch turned into "500 Internal Server Error".
    for (const path of [
      '/api/graph/nodes/not-a-uuid',
      '/api/graph/subgraph?nodeId=not-a-uuid',
      '/api/graph/queries/provenance/not-a-uuid',
      '/api/papers/not-a-uuid',
      '/api/field/hierarchy/not-a-uuid',
    ]) {
      const res = await app.request(path);
      assert.equal(res.status, 404, `${path} should be 404`);
    }
  });

  test('an unregistered domain is still rejected when the id is also malformed', async () => {
    // Ordering matters: resolving the scope after the lookup meant a bad id
    // masked a bad domain, and the caller was told the wrong thing was wrong.
    const res = await app.request('/api/graph/subgraph?nodeId=not-a-uuid&domain=nlpp');
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: string }).error, 'Unknown domain');
  });

  test('POST /api/papers rejects an unregistered domain', async () => {
    const res = await app.request('/api/papers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'ISOLATIONTEST Bad Domain', domain: 'nlpp' }),
    });
    assert.equal(res.status, 400);
  });

  test('no row in the database carries an unregistered domain', async () => {
    // A whole-table invariant rather than a per-request one: if any write path
    // still persists a raw string, this catches it regardless of which.
    const rows = (await db.execute(sql`
      select distinct domain, 'nodes' as table_name from nodes where domain is not null
      union select distinct domain, 'edges' from edges where domain is not null
      union select distinct domain, 'papers' from papers where domain is not null
      union select distinct domain, 'propositions' from propositions where domain is not null
    `)) as unknown as Array<{ domain: string; table_name: string }>;

    const { isKnownDomain } = await import('../../domains');
    for (const row of rows) {
      assert.ok(
        isKnownDomain(row.domain),
        `${row.table_name} contains unregistered domain "${row.domain}"`
      );
    }
  });
});

describe('processing failure honesty (Postgres-backed)', { skip: shouldRun ? false : 'TEST_DATABASE_URL not set' }, () => {
  let db: typeof import('../../db').db;
  let schema: typeof import('../../db/schema');
  const papersCreated: string[] = [];

  before(async () => {
    ({ db } = await import('../../db'));
    schema = await import('../../db/schema');
  });

  after(async () => {
    if (!shouldRun) return;
    if (papersCreated.length) {
      await db.delete(schema.papers).where(inArray(schema.papers.id, papersCreated));
    }
    // Last suite in the file — drain the shared pool so the process can exit.
    const { closeDb } = await import('../../db');
    await closeDb();
  });

  test('a paper whose chunks all fail is marked failed, never completed', async () => {
    const { processPaper } = await import('../../pipeline/processor');

    const [paper] = await db
      .insert(schema.papers)
      .values({
        title: 'ISOLATIONTEST Failure Paper',
        domain: 'nlp',
        // Long enough to chunk; content is irrelevant because the model call fails.
        rawText: 'Some paper text about attention mechanisms. '.repeat(50),
      })
      .returning();
    papersCreated.push(paper.id);

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;

    try {
      await assert.rejects(
        () => processPaper(paper.id),
        'processPaper must surface a total extraction failure'
      );
    } finally {
      globalThis.fetch = realFetch;
    }

    const [after] = await db.select().from(schema.papers).where(eq(schema.papers.id, paper.id));
    // The old behaviour: chunks were counted as processed even when they threw,
    // so the paper ended `processed: true, status: completed` with an empty graph.
    assert.equal(after.processingStatus, 'failed');
    assert.equal(after.processed, false);
    assert.ok(after.processingError, 'the reason must be recorded for the operator');
  });

  test('an unreachable model aborts the paper early instead of retrying every chunk', async () => {
    // Observed on a real ingest: with Ollama down, a 47-chunk paper worked
    // through chunk after chunk rediscovering the same outage, holding a worker
    // slot for minutes. An availability failure is a fact about the deployment,
    // so it is decided once.
    const { processPaper } = await import('../../pipeline/processor');

    const [paper] = await db
      .insert(schema.papers)
      .values({
        title: 'ISOLATIONTEST Abort Early Paper',
        domain: 'nlp',
        // Many small paragraphs → many chunks.
        rawText: Array.from({ length: 60 }, (_, i) => `Paragraph ${i} about attention.`).join('\n\n'),
      })
      .returning();
    papersCreated.push(paper.id);

    let calls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls++;
      throw new TypeError('fetch failed');
    }) as typeof fetch;

    try {
      await assert.rejects(() => processPaper(paper.id));
    } finally {
      globalThis.fetch = realFetch;
    }

    assert.ok(
      calls <= 5,
      `should stop after a few consecutive availability failures, made ${calls} model calls`
    );
  });

  test('a paper with an unregistered stored domain refuses to process', async () => {
    const { processPaper } = await import('../../pipeline/processor');

    // Simulates a row written before ingress validation existed. Processing it
    // under the default ontology is what merged its entities into the shared
    // default graph.
    const [paper] = await db
      .insert(schema.papers)
      .values({
        title: 'ISOLATIONTEST Legacy Bad Domain',
        domain: 'nlpp',
        rawText: 'text '.repeat(200),
      })
      .returning();
    papersCreated.push(paper.id);

    await assert.rejects(() => processPaper(paper.id), /Unknown domain/i);

    const [after] = await db.select().from(schema.papers).where(eq(schema.papers.id, paper.id));
    assert.equal(after.processingStatus, 'failed');
  });
});
