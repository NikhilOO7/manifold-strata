import 'dotenv/config';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { serve } from '@hono/node-server';
import { papersRouter } from './routes/papers';
import { graphRouter } from './routes/graph';
import { ingestRouter } from './routes/ingest';
import { fieldRouter } from './routes/field';
import { domainsRouter } from './routes/domains';
import { apiKeyAuth, authEnabled } from './middleware/auth';
import { rateLimit } from './middleware/rate-limit';
import { recoverOrphanedJobs } from './queue';
import { checkOllamaConnection, warmupModel } from './services/ollama';

const app = new Hono();

app.use('*', logger());
app.use('*', cors({
  origin: ['http://localhost:5173', 'http://localhost:3000', 'http://localhost:5174'],
  credentials: true,
}));

// Rate limiting — strict on LLM-backed routes, lenient on read-only queries.
app.use('/api/ingest/*', rateLimit({ windowMs: 60_000, limit: 10 }));
app.use('/api/field/*', rateLimit({ windowMs: 60_000, limit: 30 }));
app.use('/api/graph/*', rateLimit({ windowMs: 60_000, limit: 200 }));
app.use('/api/papers/*', rateLimit({ windowMs: 60_000, limit: 200 }));

// API-key auth on state-changing / expensive routes (no-op unless API_KEY is set).
app.on('POST', '/api/ingest/*', apiKeyAuth());
app.on('POST', '/api/papers/*', apiKeyAuth());
app.on(['POST', 'PUT', 'DELETE'], '/api/field/*', apiKeyAuth());
app.on(['POST', 'PUT', 'DELETE'], '/api/domains/*', apiKeyAuth());

app.get('/health', async (c) => {
  const ollamaConnected = await checkOllamaConnection();
  
  return c.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    services: {
      ollama: ollamaConnected ? 'connected' : 'disconnected',
    }
  });
});

app.get('/', (c) => {
  return c.json({
    name: 'Manifold API',
    description: 'A geometric, low-LLM knowledge field over research papers',
    version: '1.0.0',
    endpoints: {
      health: 'GET /health',
      papers: {
        list: 'GET /api/papers',
        get: 'GET /api/papers/:id',
        create: 'POST /api/papers',
        process: 'POST /api/papers/:id/process',
      },
      graph: {
        nodes: 'GET /api/graph/nodes',
        node: 'GET /api/graph/nodes/:id',
        edges: 'GET /api/graph/edges',
        subgraph: 'GET /api/graph/subgraph?nodeId=X&depth=N',
        stats: 'GET /api/graph/stats',
        queries: {
          improves3dgs: 'GET /api/graph/queries/improves-3dgs',
          extends3dgs: 'GET /api/graph/queries/extends-3dgs',
          datasets: 'GET /api/graph/queries/datasets',
          methodRelationships: 'GET /api/graph/queries/method-relationships?name=X',
          provenance: 'GET /api/graph/queries/provenance/:edgeId',
        }
      },
      ingest: {
        arxiv: 'POST /api/ingest/arxiv',
        bulk: 'POST /api/ingest/bulk',
        status: 'GET /api/ingest/status/:jobId',
        seed: 'GET /api/ingest/seed/:domain',
      },
      domains: {
        list: 'GET /api/domains',
        get: 'GET /api/domains/:id',
        backfill: 'POST /api/domains/backfill',
      },
      field: {
        query: 'POST /api/field/query',
        retrieve: 'GET /api/field/retrieve?q=X',
        hierarchy: 'GET /api/field/hierarchy/:nodeId',
        backfill: 'POST /api/field/backfill',
        trainHyperbolic: 'POST /api/field/train-hyperbolic',
        communities: 'POST /api/field/communities/build',
        repair: 'POST /api/field/repair',
        benchmark: 'GET /api/field/benchmark',
      }
    }
  });
});

app.route('/api/papers', papersRouter);
app.route('/api/graph', graphRouter);
app.route('/api/ingest', ingestRouter);
app.route('/api/field', fieldRouter);
app.route('/api/domains', domainsRouter);

app.notFound((c) => {
  return c.json({ error: 'Not found', path: c.req.path }, 404);
});

app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({ error: 'Internal server error', message: err.message }, 500);
});

const port = parseInt(process.env.PORT || '3000');

async function startServer() {
  console.log('\n========================================');
  console.log('  Manifold — Geometric Knowledge Field');
  console.log('========================================\n');

  console.log('Checking services...');

  const ollamaConnected = await checkOllamaConnection();
  if (ollamaConnected) {
    console.log('✓ Ollama: Connected');
    await warmupModel();
  } else {
    console.log('✗ Ollama: Not connected');
    console.log('  → Start Ollama with: ollama serve');
    console.log('  → Pull model with: ollama pull llama3.1:8b');
    console.log('  → The API will still work, but processing will fail\n');
  }

  if (authEnabled()) {
    console.log('✓ Auth: API key required on write routes');
  } else {
    console.log('✗ Auth: disabled (set API_KEY to require a key on write routes)');
  }

  try {
    const recovered = await recoverOrphanedJobs();
    if (recovered > 0) {
      console.log(`✓ Recovered ${recovered} orphaned job(s) from a previous run (marked failed)`);
    }
  } catch (err) {
    console.warn(
      '! Could not recover orphaned jobs — is the DB migrated? Run `pnpm db:push`.',
      err instanceof Error ? err.message : err
    );
  }

  console.log(`\n✓ Server running at http://localhost:${port}`);
  console.log(`  → API docs: http://localhost:${port}/`);
  console.log(`  → Health: http://localhost:${port}/health\n`);

  serve({
    fetch: app.fetch,
    port,
  });
}

startServer().catch(console.error);