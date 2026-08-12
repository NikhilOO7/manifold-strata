import { Hono } from 'hono';
import { db } from '../db';
import { nodes, edges, nodeVectors, propositions } from '../db/schema';
import { eq, inArray, isNull, isNotNull, and } from 'drizzle-orm';
import { resolveStoredDomain } from '../domains';
import { domainWhere } from '../domains/filter';
import { embed, embedOne, embedModel, embedSpaceId, cosine } from '../services/embeddings';
import { retrieveField, fieldQuery } from '../knowledge-field/retrieve';
import { trainPoincare, hierarchyNeighbors } from '../knowledge-field/hyperbolic';
import { buildCommunities } from '../knowledge-field/communities';
import * as metrics from '../services/metrics';
import { requireDomain, requireScopeOn } from '../middleware/auth';
import { recordAudit, auditText } from '../auth/audit';
import { principalOf } from '../middleware/auth';
import { routeError, isUuid } from './errors';

export const fieldRouter = new Hono();

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// --- Backfill embeddings for existing nodes + propositions ------------------
fieldRouter.post('/backfill', async (c) => {
  try {
    requireScopeOn(c, 'write', 'field.backfill');
    const body = await c.req.json().catch(() => ({}));
    // Optional scope: backfilling one domain at a time keeps the embedding spend
    // predictable on a large corpus.
    const scope = body?.domain ? requireDomain(c, body.domain, 'field.read').id : null;
    const nodeScope = scope ? domainWhere(nodes.domain, scope) : undefined;
    const propScope = scope ? domainWhere(propositions.domain, scope) : undefined;

    const allNodes = await db.select().from(nodes).where(nodeScope);
    const vecRows = await db.select({ nodeId: nodeVectors.nodeId }).from(nodeVectors);
    const haveVec = new Set(vecRows.map((v) => v.nodeId));
    const missing = allNodes.filter((n) => !haveVec.has(n.id));

    let nodesEmbedded = 0;
    for (const batch of chunk(missing, 100)) {
      const texts = batch.map((n) => `${n.name}${n.description ? '. ' + n.description : ''}`);
      const vectors = await embed(texts, 'backfill-node');
      await db
        .insert(nodeVectors)
        .values(
          batch.map((n, i) => ({
            nodeId: n.id,
            embeddingVec: vectors[i],
            model: embedModel(),
            space: embedSpaceId(),
          }))
        )
        .onConflictDoNothing();
      nodesEmbedded += batch.length;
    }

    // Propositions missing embeddings.
    const propMissing = await db
      .select()
      .from(propositions)
      .where(
        propScope
          ? and(isNull(propositions.embeddingVec), propScope)
          : isNull(propositions.embeddingVec)
      );

    let propsEmbedded = 0;
    for (const batch of chunk(propMissing, 100)) {
      const vectors = await embed(batch.map((p) => p.text), 'backfill-prop');
      for (let i = 0; i < batch.length; i++) {
        await db
          .update(propositions)
          .set({ embeddingVec: vectors[i], space: embedSpaceId() })
          .where(eq(propositions.id, batch[i].id));
      }
      propsEmbedded += batch.length;
    }

    return c.json({
      domain: scope ?? 'all',
      nodesEmbedded,
      propsEmbedded,
      model: embedModel(),
      space: embedSpaceId(),
    });
  } catch (error) {
    return routeError(c, error, 'Backfill failed');
  }
});

// --- Train hyperbolic (Poincaré) coordinates --------------------------------
fieldRouter.post('/train-hyperbolic', async (c) => {
  try {
    requireScopeOn(c, 'write', 'field.trainHyperbolic');
    const body = await c.req.json().catch(() => ({}));
    const domain = requireDomain(c, body?.domain, 'field.read');
    const hierTypes = domain.hierarchicalEdgeTypes ?? ['extends', 'improves', 'cites'];

    const allNodes = await db.select().from(nodes).where(domainWhere(nodes.domain, domain.id));
    const hierEdges = await db
      .select({ sourceId: edges.sourceId, targetId: edges.targetId })
      .from(edges)
      .where(and(domainWhere(edges.domain, domain.id), inArray(edges.type, hierTypes)));

    if (hierEdges.length === 0) {
      return c.json(
        {
          error: `No hierarchical edges (${hierTypes.join('/')}) to train on for domain "${domain.id}"`,
        },
        400
      );
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

    return c.json({
      domain: domain.id,
      trainedNodes: coords.size,
      edgesUsed: hierEdges.length,
      persisted: updated,
    });
  } catch (error) {
    return routeError(c, error, 'Training failed');
  }
});

// --- Hierarchy view (generalizations / specializations) ---------------------
fieldRouter.get('/hierarchy/:nodeId', async (c) => {
  try {
    const nodeId = c.req.param('nodeId');
    const requestedDomain = c.req.query('domain');
    const requestedScope = requestedDomain ? requireDomain(c, requestedDomain, 'field.read').id : null;

    if (!isUuid(nodeId)) return c.json({ error: 'Node not found' }, 404);

    const [node] = await db.select().from(nodes).where(eq(nodes.id, nodeId)).limit(1);
    if (!node) {
      return c.json({ error: 'Node not found' }, 404);
    }

    const nodeDomain = resolveStoredDomain(node.domain, `node ${node.id}`).id;
    if (requestedScope && requestedScope !== nodeDomain) {
      return c.json({ error: 'Node not found' }, 404);
    }

    // Hierarchy is only meaningful inside one domain — Poincaré coordinates are
    // trained per domain, so mixing them compares positions from unrelated
    // embeddings. This previously loaded every node in the database and happily
    // returned another field's entities as "generalizations".
    const domainNodes = await db
      .select({ id: nodes.id, name: nodes.name, type: nodes.type })
      .from(nodes)
      .where(domainWhere(nodes.domain, nodeDomain));
    const inDomain = new Set(domainNodes.map((n) => n.id));

    const rows = (
      await db
        .select({ nodeId: nodeVectors.nodeId, hyperbolic: nodeVectors.hyperbolic })
        .from(nodeVectors)
        .where(isNotNull(nodeVectors.hyperbolic))
    ).filter((r) => inDomain.has(r.nodeId));

    if (rows.length === 0) {
      return c.json(
        {
          error: `No hyperbolic coords for domain "${nodeDomain}" — run POST /api/field/train-hyperbolic`,
        },
        400
      );
    }

    const coords = new Map<string, number[]>();
    for (const r of rows) coords.set(r.nodeId, r.hyperbolic as number[]);

    const { generalizations, specializations } = hierarchyNeighbors(nodeId, coords, 8);

    const meta = new Map(domainNodes.map((n) => [n.id, n]));
    const decorate = (arr: { id: string; distance: number; norm: number }[]) =>
      arr.map((x) => ({ ...x, name: meta.get(x.id)?.name, type: meta.get(x.id)?.type }));

    return c.json({
      node: meta.get(nodeId) ?? { id: nodeId },
      domain: nodeDomain,
      generalizations: decorate(generalizations),
      specializations: decorate(specializations),
    });
  } catch (error) {
    return routeError(c, error, 'Hierarchy lookup failed');
  }
});

// --- Build community summaries ----------------------------------------------
fieldRouter.post('/communities/build', async (c) => {
  try {
    requireScopeOn(c, 'write', 'field.communities');
    const body = await c.req.json().catch(() => ({}));
    const domain = requireDomain(c, body?.domain, 'field.read');
    const result = await buildCommunities(domain.id);
    return c.json({ domain: domain.id, ...result });
  } catch (error) {
    return routeError(c, error, 'Community build failed');
  }
});

// --- Debug retrieval (no LLM verbalize) -------------------------------------
fieldRouter.get('/retrieve', async (c) => {
  try {
    const q = c.req.query('q');
    if (!q) return c.json({ error: 'q query param required' }, 400);

    // Resolved here so an unregistered domain is a 400 naming the valid ones,
    // rather than a 200 carrying the default domain's evidence.
    const domain = requireDomain(c, c.req.query('domain'), 'field.retrieve').id;
    const result = await retrieveField(q, { domain });

    // Every retrieval is recorded: what was asked, in which domain, and how much
    // evidence came back. This is the record that answers "what did this agent
    // see" after the fact.
    recordAudit({
      principal: principalOf(c),
      action: 'field.retrieve',
      domain,
      outcome: 'allowed',
      detail: { question: auditText(q), evidenceCount: result.evidence.length },
    });

    return c.json({ domain, ...result });
  } catch (error) {
    return routeError(c, error, 'Retrieve failed');
  }
});

// --- Full query (PPR + compression + 1 verbalize call) ----------------------
fieldRouter.post('/query', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const question = body?.question;
    if (!question || typeof question !== 'string' || !question.trim()) {
      return c.json({ error: 'question is required' }, 400);
    }

    const domain = requireDomain(c, body?.domain, 'field.query').id;
    const result = await fieldQuery(question, { verbalize: body?.verbalize, domain });

    recordAudit({
      principal: principalOf(c),
      action: 'field.query',
      domain,
      outcome: 'allowed',
      detail: {
        question: auditText(question),
        evidenceCount: result.evidence.length,
        llmCalls: result.llmCalls,
      },
    });

    return c.json({
      question,
      domain,
      answer: result.answer,
      llmCalls: result.llmCalls,
      evidenceCount: result.evidence.length,
      contextChars: result.contextChars,
      seeds: result.seeds,
      topNodes: result.rankedNodes.slice(0, 10),
      evidence: result.evidence,
    });
  } catch (error) {
    return routeError(c, error, 'Query failed');
  }
});

// --- Benchmark: prove the LLM-call / token reduction ------------------------
fieldRouter.get('/benchmark', async (c) => {
  try {
    if (c.req.query('reset')) {
      metrics.reset();
      return c.json({ message: 'metrics reset' });
    }

    const domain = requireDomain(c, c.req.query('domain'), 'field.read').id;

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
    const questions = qParam ? qParam.split('|').filter((q) => q.trim()) : defaultQuestions;

    // Both arms read the same domain-scoped corpus — comparing a domain-scoped
    // field retrieval against a whole-database naive baseline would flatter the
    // field arm for the wrong reason.
    const propRows = await db
      .select()
      .from(propositions)
      .where(and(isNotNull(propositions.embeddingVec), domainWhere(propositions.domain, domain)));

    const retrieval = [];
    for (const question of questions) {
      const qvec = await embedOne(question, 'benchmark');

      // Naive RAG: top-10 propositions by pure cosine, full text, no compression.
      const naive = propRows
        .map((p) => ({ text: p.text, score: cosine(qvec, p.embeddingVec as number[]) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 10);
      const naiveChars = naive.reduce((s, x) => s + x.text.length, 0);

      // Field: PPR + MMR-compressed evidence (no verbalize call for the benchmark).
      const field = await retrieveField(question, { domain });

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
      domain,
      ingestion,
      retrieval,
    });
  } catch (error) {
    return routeError(c, error, 'Benchmark failed');
  }
});
