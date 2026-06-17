import { Hono } from 'hono';
import { db } from '../db';
import { nodes, edges, nodeVectors, propositions } from '../db/schema';
import { eq, inArray, isNull, isNotNull, and } from 'drizzle-orm';
import { getDomain } from '../domains';
import { domainWhere } from '../domains/filter';
import { embed, embedOne, embedModel, cosine } from '../services/embeddings';
import { retrieveField, fieldQuery } from '../knowledge-field/retrieve';
import { trainPoincare, hierarchyNeighbors } from '../knowledge-field/hyperbolic';
import { buildCommunities } from '../knowledge-field/communities';
import { repairGraph } from '../agents/repair';
import * as metrics from '../services/metrics';

export const fieldRouter = new Hono();

// --- Agentic graph repair ---------------------------------------------------
// Audit suspect edges (low-confidence / temporal or mutual contradictions)
// against their provenance. Dry-run by default; pass { "apply": true } to mutate.
fieldRouter.post('/repair', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const report = await repairGraph({
      domain: body?.domain,
      apply: body?.apply === true,
      confidenceThreshold: typeof body?.confidenceThreshold === 'number' ? body.confidenceThreshold : undefined,
      maxEdges: typeof body?.maxEdges === 'number' ? body.maxEdges : undefined,
    });
    return c.json(report);
  } catch (error) {
    console.error('Repair error:', error);
    return c.json({ error: 'Repair failed', message: String(error) }, 500);
  }
});

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// --- Backfill embeddings for existing nodes + propositions ------------------
fieldRouter.post('/backfill', async (c) => {
  try {
    const allNodes = await db.select().from(nodes);
    const vecRows = await db.select({ nodeId: nodeVectors.nodeId }).from(nodeVectors);
    const haveVec = new Set(vecRows.map((v) => v.nodeId));
    const missing = allNodes.filter((n) => !haveVec.has(n.id));

    let nodesEmbedded = 0;
    for (const batch of chunk(missing, 100)) {
      const texts = batch.map((n) => `${n.name}${n.description ? '. ' + n.description : ''}`);
      const vectors = await embed(texts, 'backfill-node');
      await db.insert(nodeVectors).values(
        batch.map((n, i) => ({ nodeId: n.id, embedding: vectors[i], model: embedModel() }))
      ).onConflictDoNothing();
      nodesEmbedded += batch.length;
    }

    // Propositions missing embeddings.
    const propMissing = await db.select().from(propositions).where(isNull(propositions.embedding));
    let propsEmbedded = 0;
    for (const batch of chunk(propMissing, 100)) {
      const vectors = await embed(batch.map((p) => p.text), 'backfill-prop');
      for (let i = 0; i < batch.length; i++) {
        await db.update(propositions).set({ embedding: vectors[i] }).where(eq(propositions.id, batch[i].id));
      }
      propsEmbedded += batch.length;
    }

    return c.json({ nodesEmbedded, propsEmbedded, model: embedModel() });
  } catch (error) {
    console.error('Backfill error:', error);
    return c.json({ error: 'Backfill failed', message: String(error) }, 500);
  }
});

// --- Train hyperbolic (Poincaré) coordinates --------------------------------
fieldRouter.post('/train-hyperbolic', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const domain = getDomain(body?.domain);
    const hierTypes = domain.hierarchicalEdgeTypes ?? ['extends', 'improves', 'cites'];

    const allNodes = await db.select().from(nodes).where(domainWhere(nodes.domain, domain.id));
    const hierEdges = await db
      .select({ sourceId: edges.sourceId, targetId: edges.targetId })
      .from(edges)
      .where(and(domainWhere(edges.domain, domain.id), inArray(edges.type, hierTypes as any)));

    if (hierEdges.length === 0) {
      return c.json({ error: `No hierarchical edges (${hierTypes.join('/')}) to train on for domain "${domain.id}"` }, 400);
    }

    const coords = trainPoincare(
      allNodes.map((n) => n.id),
      hierEdges.map((e) => [e.sourceId, e.targetId])
    );

    // Persist into existing node_vectors rows (run /backfill first for full coverage).
    let updated = 0;
    for (const [nodeId, vec] of coords.entries()) {
      const res = await db
        .update(nodeVectors)
        .set({ hyperbolic: vec })
        .where(eq(nodeVectors.nodeId, nodeId))
        .returning({ id: nodeVectors.id });
      if (res.length > 0) updated += 1;
    }

    return c.json({ trainedNodes: coords.size, edgesUsed: hierEdges.length, persisted: updated });
  } catch (error) {
    console.error('Hyperbolic training error:', error);
    return c.json({ error: 'Training failed', message: String(error) }, 500);
  }
});

// --- Hierarchy view (generalizations / specializations) ---------------------
fieldRouter.get('/hierarchy/:nodeId', async (c) => {
  try {
    const nodeId = c.req.param('nodeId');
    const rows = await db
      .select({ nodeId: nodeVectors.nodeId, hyperbolic: nodeVectors.hyperbolic })
      .from(nodeVectors)
      .where(isNotNull(nodeVectors.hyperbolic));

    if (rows.length === 0) {
      return c.json({ error: 'No hyperbolic coords yet — run POST /api/field/train-hyperbolic' }, 400);
    }

    const coords = new Map<string, number[]>();
    for (const r of rows) coords.set(r.nodeId, r.hyperbolic as number[]);

    const { generalizations, specializations } = hierarchyNeighbors(nodeId, coords, 8);

    const allNodes = await db.select({ id: nodes.id, name: nodes.name, type: nodes.type }).from(nodes);
    const meta = new Map(allNodes.map((n) => [n.id, n]));
    const decorate = (arr: { id: string; distance: number; norm: number }[]) =>
      arr.map((x) => ({ ...x, name: meta.get(x.id)?.name, type: meta.get(x.id)?.type }));

    return c.json({
      node: meta.get(nodeId) ?? { id: nodeId },
      generalizations: decorate(generalizations),
      specializations: decorate(specializations),
    });
  } catch (error) {
    console.error('Hierarchy error:', error);
    return c.json({ error: 'Hierarchy lookup failed', message: String(error) }, 500);
  }
});

// --- Build community summaries ----------------------------------------------
fieldRouter.post('/communities/build', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const result = await buildCommunities(body?.domain);
    return c.json(result);
  } catch (error) {
    console.error('Communities error:', error);
    return c.json({ error: 'Community build failed', message: String(error) }, 500);
  }
});

// --- Debug retrieval (no LLM verbalize) -------------------------------------
fieldRouter.get('/retrieve', async (c) => {
  try {
    const q = c.req.query('q');
    if (!q) return c.json({ error: 'q query param required' }, 400);
    const domain = c.req.query('domain') || undefined;
    const result = await retrieveField(q, { domain });
    return c.json(result);
  } catch (error) {
    console.error('Retrieve error:', error);
    return c.json({ error: 'Retrieve failed', message: String(error) }, 500);
  }
});

// --- Full query (PPR + compression + 1 verbalize call) ----------------------
fieldRouter.post('/query', async (c) => {
  try {
    const body = await c.req.json();
    const question = body.question;
    if (!question) return c.json({ error: 'question is required' }, 400);

    const result = await fieldQuery(question, { verbalize: body.verbalize, domain: body.domain });
    return c.json({
      question,
      answer: result.answer,
      llmCalls: result.llmCalls,
      latencyMs: result.latencyMs,
      evidenceCount: result.evidence.length,
      contextChars: result.contextChars,
      seeds: result.seeds,
      topNodes: result.rankedNodes.slice(0, 10),
      evidence: result.evidence,
    });
  } catch (error) {
    console.error('Query error:', error);
    return c.json({ error: 'Query failed', message: String(error) }, 500);
  }
});

// --- Benchmark: prove the LLM-call / token reduction ------------------------
fieldRouter.get('/benchmark', async (c) => {
  try {
    const reset = c.req.query('reset');
    if (reset) {
      metrics.reset();
      return c.json({ message: 'metrics reset' });
    }

    // (a) Ingestion: accumulated metrics per pipeline mode (populate by
    //     processing papers under PIPELINE_MODE=legacy then =field).
    const ingestion = {
      field: metrics.snapshot('field'),
      legacy: metrics.snapshot('legacy'),
    };

    // (b) Retrieval: naive top-k raw propositions vs MMR-compressed field context.
    const defaultQuestions = [
      'Which methods improve on 3D Gaussian Splatting?',
      'What datasets are used to evaluate Gaussian Splatting methods?',
      'Which methods extend 3D Gaussian Splatting?',
    ];
    const qParam = c.req.query('questions');
    const questions = qParam ? qParam.split('|') : defaultQuestions;

    const propRows = await db
      .select()
      .from(propositions)
      .where(isNotNull(propositions.embedding));

    const retrieval = [];
    for (const question of questions) {
      const qvec = await embedOne(question, 'benchmark');

      // Naive RAG: top-10 propositions by pure cosine, full text, no compression.
      const naive = propRows
        .map((p) => ({ text: p.text, score: cosine(qvec, p.embedding as number[]) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 10);
      const naiveChars = naive.reduce((s, x) => s + x.text.length, 0);

      // Field: PPR + MMR-compressed evidence (no verbalize call for the benchmark).
      const field = await retrieveField(question);

      retrieval.push({
        question,
        naive: { evidenceCount: naive.length, contextChars: naiveChars },
        field: { evidenceCount: field.evidence.length, contextChars: field.contextChars },
        charReductionPct:
          naiveChars > 0 ? Math.round((1 - field.contextChars / naiveChars) * 100) : 0,
      });
    }

    return c.json({
      note:
        'Ingestion metrics accumulate as papers are processed. Process the same ' +
        'paper under PIPELINE_MODE=legacy and PIPELINE_MODE=field to compare LLM calls.',
      ingestion,
      retrieval,
    });
  } catch (error) {
    console.error('Benchmark error:', error);
    return c.json({ error: 'Benchmark failed', message: String(error) }, 500);
  }
});
