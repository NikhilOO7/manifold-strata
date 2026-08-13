import 'dotenv/config';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { serve } from '@hono/node-server';
import { sql } from 'drizzle-orm';
import { db, closeDb } from './db';
import { papersRouter } from './routes/papers';
import { graphRouter } from './routes/graph';
import { ingestRouter } from './routes/ingest';
import { fieldRouter } from './routes/field';
import { domainsRouter } from './routes/domains';
import { adminRouter } from './routes/admin';
import { authenticate, authEnabled } from './middleware/auth';
import { rateLimit } from './middleware/rate-limit';
import {
  recoverOnStartup,
  startWorkers,
  stopWorkers,
  queueDepth,
  inFlightJobIds,
  INSTANCE_ID,
} from './queue';
import { registerDefaultHandlers } from './jobs';
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
      queue: database.ok ? await queueDepth().catch(() => null) : null,
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
    const recovered = await recoverOnStartup();
    if (recovered.requeued + recovered.failed > 0) {
      console.log(
        `✓ Recovery: ${recovered.requeued} interrupted job(s) RE-QUEUED for retry, ` +
          `${recovered.failed} out of attempts → failed, ${recovered.papersReset} paper(s) reset`
      );
    }
    console.log(`  Instance id: ${INSTANCE_ID} (queued work is durable; restarts resume it)`);

    registerDefaultHandlers();
    startWorkers();
  } catch (err) {
    console.warn(
      '! Could not recover orphaned jobs — is the DB migrated? Run `pnpm db:push`.',
      err instanceof Error ? err.message : err
    );
  }

  console.log(`\n✓ Server running at http://localhost:${port}`);
  console.log(`  → API docs: http://localhost:${port}/`);
  console.log(`  → Health: http://localhost:${port}/health\n`);

  const server = serve({ fetch: app.fetch, port });
  installShutdownHandlers(server);
}

/**
 * Shut down on a signal instead of dying on one.
 *
 * Nothing handled SIGTERM before, which made every deploy indistinguishable from
 * a crash: connections cut mid-response, the Postgres pool dropped without
 * closing, and in-flight jobs went to lease-expiry recovery even when they were
 * two seconds from finishing. A deploy is the most frequent "failure" a service
 * experiences, so it is the one worth handling properly.
 *
 * Order matters. Stop accepting new requests first, so nothing new arrives to be
 * abandoned. Then stop claiming and let in-flight jobs land (see `stopWorkers` —
 * it does not release live claims, because that would let another instance run
 * the same extraction concurrently). Close the pool last, once nothing else
 * needs it.
 *
 * A second signal exits immediately: an operator pressing Ctrl-C twice means it,
 * and a shutdown that cannot be interrupted is its own kind of outage.
 */
function installShutdownHandlers(server: { close: (cb?: (err?: Error) => void) => void }): void {
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      console.log(`\n${signal} again — exiting now.`);
      process.exit(130);
    }
    shuttingDown = true;
    console.log(`\n${signal} received — shutting down.`);

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    console.log('  ✓ HTTP server closed to new connections');

    try {
      const { drained, inFlight } = await stopWorkers();
      console.log(`  ✓ Workers stopped — ${drained} job(s) finished during drain`);
      if (inFlight > 0) {
        // Named, not summarised: an operator reading this after a bad deploy
        // needs to know exactly which work is coming back, and when.
        console.log(
          `  · ${inFlight} job(s) still running and left leased: ${inFlightJobIds().join(', ')}`
        );
        console.log('    They are re-queued automatically once the lease expires.');
      }
    } catch (err) {
      console.warn('  ! Worker drain failed:', err instanceof Error ? err.message : err);
    }

    try {
      await closeDb();
      console.log('  ✓ Database pool closed');
    } catch (err) {
      console.warn('  ! Database close failed:', err instanceof Error ? err.message : err);
    }

    console.log('Goodbye.');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

// Only boot when run as the entrypoint, so tests can import `app` without
// binding a port or firing the startup probes.
if (process.env.NODE_ENV !== 'test') {
  startServer().catch((err) => {
    console.error('Fatal startup error:', err);
    process.exit(1);
  });
}
