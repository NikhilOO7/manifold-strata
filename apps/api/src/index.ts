import 'dotenv/config';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { serve } from '@hono/node-server';
import { sql } from 'drizzle-orm';
import { db } from './db';
import { papersRouter } from './routes/papers';
import { graphRouter } from './routes/graph';
import { ingestRouter } from './routes/ingest';
import { fieldRouter } from './routes/field';
import { domainsRouter } from './routes/domains';
import { adminRouter } from './routes/admin';
import { authenticate, authEnabled } from './middleware/auth';
import { rateLimit } from './middleware/rate-limit';
import { recoverOrphanedJobs, INSTANCE_ID } from './queue';
import { checkLLMHealth, warmupModel, llmProvider, llmModel } from './services/llm';
import { routingTable, routingAdvice } from './services/model-router';
import { checkEmbedHealth } from './services/embeddings';
import { listDomains } from './domains';
import { checkVectorStorage } from './db/vector-check';
import { EMBEDDING_SPACE } from './services/embedding-space';
import { routeError } from './routes/errors';

export const app = new Hono();

app.use('*', logger());

// CORS origins are configurable so a UI deployed anywhere other than localhost
// isn't silently blocked by a hardcoded list.
const corsOrigins = (
  process.env.CORS_ORIGINS ?? 'http://localhost:5173,http://localhost:5174,http://localhost:3000'
)
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use('*', cors({ origin: corsOrigins, credentials: true }));

/**
 * Rate limiting, budgeted by what an operation *costs*.
 *
 * The limits are per method, not per path prefix, because those are not the same
 * thing. Ingest was previously limited to 10/min across the whole prefix — which
 * included `GET /api/ingest/status/:jobId`. Starting five ingests and then
 * polling their status, exactly what the UI does, exhausted the budget on the
 * polling and returned 429 for the status of jobs the caller had just created.
 *
 * A limit that stops you observing the work you started is not protecting
 * anything: the expensive thing already happened. Observability endpoints get
 * the read budget.
 */
const WRITE_LIMIT = { windowMs: 60_000, limit: 10 };
const READ_LIMIT = { windowMs: 60_000, limit: 300 };

app.on(['POST', 'PUT', 'PATCH', 'DELETE'], '/api/ingest/*', rateLimit(WRITE_LIMIT));
app.on('GET', '/api/ingest/*', rateLimit(READ_LIMIT));

app.on(['POST', 'PUT', 'PATCH', 'DELETE'], '/api/field/*', rateLimit({ windowMs: 60_000, limit: 30 }));
app.on('GET', '/api/field/*', rateLimit({ windowMs: 60_000, limit: 60 }));

app.on(['POST', 'PUT', 'PATCH', 'DELETE'], '/api/papers/*', rateLimit(WRITE_LIMIT));
app.on('GET', '/api/papers/*', rateLimit(READ_LIMIT));

app.use('/api/graph/*', rateLimit(READ_LIMIT));

// Identity on EVERY /api route, reads included. Guarding only mutations left
// every read unauthenticated, which meant the domain isolation the rest of the
// system enforces could be sidestepped by anyone who could reach the port.
// Authorization (scopes, domain grants) is decided per operation, not here.
app.use('/api/*', authenticate());

/**
 * Liveness + dependency readiness.
 *
 * Returns 503 when a dependency the pipeline actually needs is unavailable. This
 * used to answer `status: "ok"` unconditionally — including when the configured
 * model was unreachable — so every uptime probe read healthy while ingestion
 * could not extract a single entity.
 */
app.get('/health', async (c) => {
  const [llm, embeddings] = await Promise.all([checkLLMHealth(), checkEmbedHealth()]);

  let database: { ok: boolean; detail?: string };
  let vectors: Awaited<ReturnType<typeof checkVectorStorage>> | { ok: false; problems: string[] };
  try {
    await db.execute(sql`select 1`);
    database = { ok: true };
    vectors = await checkVectorStorage();
  } catch (err) {
    database = { ok: false, detail: err instanceof Error ? err.message : String(err) };
    vectors = { ok: false, problems: ['Database unreachable'] };
  }

  const healthy = database.ok && vectors.ok && llm.ok && embeddings.ok;

  return c.json(
    {
      status: healthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      services: { database, vectors, llm, embeddings },
      models: {
        routes: routingTable().map((r) => ({
          role: r.role,
          model: `${r.provider}:${r.model}`,
          source: r.source,
        })),
        ...routingAdvice(),
      },
      embeddingSpace: EMBEDDING_SPACE.id,
      pipelineMode: process.env.PIPELINE_MODE === 'legacy' ? 'legacy' : 'field',
      authEnabled: authEnabled(),
    },
    healthy ? 200 : 503
  );
});

app.get('/', (c) => {
  return c.json({
    name: 'Manifold API',
    description: 'A geometric, low-LLM knowledge field over research papers',
    version: '1.0.0',
    domains: listDomains().map((d) => d.id),
    endpoints: {
      health: 'GET /health',
      papers: {
        list: 'GET /api/papers?domain=&limit=&offset=',
        processing: 'GET /api/papers/processing',
        get: 'GET /api/papers/:id',
        create: 'POST /api/papers',
        process: 'POST /api/papers/:id/process',
      },
      graph: {
        nodes: 'GET /api/graph/nodes?domain=&type=&search=',
        node: 'GET /api/graph/nodes/:id?domain=',
        edges: 'GET /api/graph/edges?domain=&type=',
        subgraph: 'GET /api/graph/subgraph?nodeId=X&depth=N',
        stats: 'GET /api/graph/stats?domain=',
        types: 'GET /api/graph/types?domain=',
        queries: {
          improves3dgs: 'GET /api/graph/queries/improves-3dgs',
          extends3dgs: 'GET /api/graph/queries/extends-3dgs',
          datasets: 'GET /api/graph/queries/datasets',
          methodRelationships: 'GET /api/graph/queries/method-relationships?name=X',
          provenance: 'GET /api/graph/queries/provenance/:edgeId',
        },
      },
      ingest: {
        arxiv: 'POST /api/ingest/arxiv',
        bulk: 'POST /api/ingest/bulk',
        status: 'GET /api/ingest/status/:jobId',
        seed: 'GET /api/ingest/seed/:domain',
      },
      admin: {
        tenants: 'GET|POST /api/admin/tenants',
        principals: 'GET|POST /api/admin/principals',
        revoke: 'POST /api/admin/principals/:id/revoke',
        audit: 'GET /api/admin/audit',
      },
      domains: {
        list: 'GET /api/domains',
        get: 'GET /api/domains/:id',
        backfill: 'POST /api/domains/backfill',
      },
      field: {
        query: 'POST /api/field/query',
        retrieve: 'GET /api/field/retrieve?q=X&domain=',
        hierarchy: 'GET /api/field/hierarchy/:nodeId',
        backfill: 'POST /api/field/backfill',
        trainHyperbolic: 'POST /api/field/train-hyperbolic',
        communities: 'POST /api/field/communities/build',
        benchmark: 'GET /api/field/benchmark',
      },
    },
  });
});

app.route('/api/papers', papersRouter);
app.route('/api/graph', graphRouter);
app.route('/api/ingest', ingestRouter);
app.route('/api/field', fieldRouter);
app.route('/api/domains', domainsRouter);
app.route('/api/admin', adminRouter);

app.notFound((c) => c.json({ error: 'Not found', path: c.req.path }, 404));

// Backstop classification: a route that forgets to call routeError still returns
// 400 for an unknown domain rather than a 500 that reads like a server bug.
app.onError((err, c) => routeError(c, err, 'Internal server error'));

const port = parseInt(process.env.PORT || '3000', 10);

async function startServer() {
  console.log('\n========================================');
  console.log('  Manifold — Geometric Knowledge Field');
  console.log('========================================\n');

  console.log(`Pipeline mode: ${process.env.PIPELINE_MODE === 'legacy' ? 'legacy' : 'field'}`);
  console.log('Checking services...');

  const [llm, embeddings] = await Promise.all([checkLLMHealth(), checkEmbedHealth()]);

  if (llm.ok) {
    console.log(`✓ LLM: ${llmProvider()} / ${llmModel()}`);
    for (const route of routingTable()) {
      const marker = route.source === 'role-specific' ? '·' : ' ';
      console.log(`  ${marker} ${route.role.padEnd(10)} ${route.provider}:${route.model}`);
    }
    for (const warning of routingAdvice().warnings) {
      console.log(`  ! ${warning}`);
    }
    await warmupModel();
  } else {
    console.log(`✗ LLM (${llmProvider()} / ${llmModel()}): ${llm.detail}`);
    console.log('  → Extraction will fail until this is fixed. Affected papers are marked');
    console.log('    failed rather than silently completed with an empty graph.');
  }

  if (embeddings.ok) {
    console.log(`✓ Embeddings: ${embeddings.provider} / ${embeddings.model}`);
  } else {
    console.log(`✗ Embeddings (${embeddings.provider} / ${embeddings.model}): ${embeddings.detail}`);
    console.log('  → Field mode needs embeddings for resolution and retrieval.');
  }

  if (authEnabled()) {
    console.log('✓ Auth: every /api route requires a scoped credential');
  } else {
    console.log('✗ Auth: DISABLED — every request runs as an anonymous admin,');
    console.log('    including /api/admin/*. Do not expose this beyond localhost.');
    console.log('  → To enable: pnpm --filter api auth:bootstrap   (issues the first key)');
    console.log('    then restart with AUTH_MODE=required');
  }

  try {
    const recovered = await recoverOrphanedJobs();
    const total = recovered.ownJobs + recovered.expiredLeases;
    if (total > 0) {
      console.log(
        `✓ Recovered ${total} interrupted job(s) — ${recovered.ownJobs} own, ` +
          `${recovered.expiredLeases} from expired leases; ${recovered.papers} paper(s) reset`
      );
    }
    console.log(`  Instance id: ${INSTANCE_ID} (owns its jobs; other instances' work untouched)`);
  } catch (err) {
    console.warn(
      '! Could not recover orphaned jobs — is the DB migrated? Run `pnpm db:push`.',
      err instanceof Error ? err.message : err
    );
  }

  console.log(`\n✓ Server running at http://localhost:${port}`);
  console.log(`  → API docs: http://localhost:${port}/`);
  console.log(`  → Health: http://localhost:${port}/health\n`);

  serve({ fetch: app.fetch, port });
}

// Only boot when run as the entrypoint, so tests can import `app` without
// binding a port or firing the startup probes.
if (process.env.NODE_ENV !== 'test') {
  startServer().catch((err) => {
    console.error('Fatal startup error:', err);
    process.exit(1);
  });
}
