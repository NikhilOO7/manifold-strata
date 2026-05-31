# Implementation Plan: Knowledge Graph Improvements

## Overview

This plan transforms the Gaussian Splatting Knowledge Graph from a domain-specific prototype into a production-grade, domain-agnostic research knowledge graph platform. It covers 20 tasks across 7 phases, ordered by dependency and impact.

**Current state**: Working end-to-end pipeline (arXiv → PDF → 3-agent extraction → PostgreSQL → React UI), hardcoded for Gaussian Splatting papers.

**Target state**: Domain-agnostic, background-processed, real-time, well-tested, production-ready platform with staff-level engineering concerns: ontology management, graph quality observability, conflict resolution, temporal modeling, and distributed tracing.

---

## Table of Contents

- [Phase 0: Critical Bug Fixes](#phase-0-critical-bug-fixes-week-1)
- [Phase 1: Domain Generalization](#phase-1-domain-generalization-week-1-2)
- [Phase 2: Infrastructure Improvements](#phase-2-infrastructure-improvements-week-2-3)
- [Phase 3: Data Quality Improvements](#phase-3-data-quality-improvements-week-3-4)
- [Phase 4: Frontend Improvements](#phase-4-frontend-improvements-week-4-5)
- [Phase 5: API Hardening](#phase-5-api-hardening-week-5-6)
- [Phase 6: Testing](#phase-6-testing-ongoing)
- [Phase 7: Staff-Level Engineering](#phase-7-staff-level-engineering-week-7-10)
- [Dependency Graph](#dependency-graph)
- [Critical Files Map](#critical-files-map)
- [Implementation Order](#recommended-implementation-order)

---

## Phase 0: Critical Bug Fixes (Week 1)

Zero-risk fixes that must go first — later phases depend on correct behavior.

All four tasks are **independent** and can be done in parallel.

---

### Task 0.1: Fix `reprocessPaper` Bug

**Size**: S (Small)
**Depends on**: Nothing

**Problem**: In `apps/api/src/pipeline/processor.ts` at lines 275-277, `reprocessPaper()` does:
```typescript
await db.delete(edges).where(eq(edges.sourceId, paperId));
```
But `paperId` is a UUID from the `papers` table, not a node UUID. `edges.sourceId` references `nodes.id`, so this WHERE clause will never match anything (or silently match the wrong rows if UUIDs happen to collide).

The correct logic already exists on lines 279-289 (looks up paper nodes, then deletes their edges). The first delete statement is **redundant and wrong**.

**Fix**: Remove lines 275-277 entirely.

**Files to change**:
| File | Change |
|------|--------|
| `apps/api/src/pipeline/processor.ts` | Remove the incorrect `db.delete(edges).where(eq(edges.sourceId, paperId))` block (lines 275-277) |

---

### Task 0.2: Fix N+1 Query in `/api/graph/edges`

**Size**: S
**Depends on**: Nothing

**Problem**: In `apps/api/src/routes/graph.ts` lines 95-138, the `/edges` endpoint:
1. JOINs edges with source nodes ✓
2. Then runs `Promise.all()` of **N individual `SELECT` queries** for each edge's target node ✗

For 100 edges, this is 101 queries instead of 1.

**Fix**: Replace the two-step approach with a single query that JOINs both source and target nodes using Drizzle's `alias()`.

**Files to change**:
| File | Change |
|------|--------|
| `apps/api/src/routes/graph.ts` | Rewrite the `/edges` handler to use a double JOIN |

**Target query**:
```sql
SELECT e.*, sn.*, tn.*
FROM edges e
INNER JOIN nodes sn ON e.source_id = sn.id
INNER JOIN nodes tn ON e.target_id = tn.id
WHERE e.type = ?    -- optional filter
LIMIT ? OFFSET ?
```

**Implementation using Drizzle**:
```typescript
import { alias } from 'drizzle-orm/pg-core';

const sourceNodes = alias(nodes, 'sourceNodes');
const targetNodes = alias(nodes, 'targetNodes');

const results = await db
  .select({
    edge: edges,
    sourceNode: sourceNodes,
    targetNode: targetNodes,
  })
  .from(edges)
  .innerJoin(sourceNodes, eq(edges.sourceId, sourceNodes.id))
  .innerJoin(targetNodes, eq(edges.targetId, targetNodes.id))
  .where(type ? eq(edges.type, type) : undefined)
  .limit(limit)
  .offset(offset);
```

---

### Task 0.3: Cache `existingNodes` Query

**Size**: S
**Depends on**: Nothing

**Problem**: In `apps/api/src/pipeline/processor.ts` line 91-93, inside the chunk processing loop:
```typescript
for (let i = 0; i < chunks.length; i++) {
  // ... line 91:
  const existingNodes = await db.select().from(nodes).limit(500);
  // This runs 46 times for a single paper!
}
```

**Fix**: Hoist the query before the loop. Update the local array when new nodes are created (push to the array at line 128).

**Files to change**:
| File | Change |
|------|--------|
| `apps/api/src/pipeline/processor.ts` | Move `existingNodes` fetch to before line 61. When creating new nodes (line 120-128), push the new node to the `existingNodes` array |

**Implementation**:
```typescript
// Before the loop (after line 59):
let existingNodes = await db.select().from(nodes).limit(500);

for (let i = 0; i < chunks.length; i++) {
  // ... use existingNodes directly ...
  
  // When creating a new node (inside the entity loop):
  const [newNode] = await db.insert(nodes).values({ ... }).returning();
  existingNodes.push(newNode); // Keep local cache in sync
}
```

---

### Task 0.4: Connection Pooling Config

**Size**: S
**Depends on**: Nothing

**Problem**: Database pool settings are hardcoded in `apps/api/src/db/index.ts` with no environment variable exposure. For production, you need configurable pool sizes, idle timeouts, and connection timeouts.

**Fix**: Read pool configuration from environment variables with sensible defaults.

**Files to change**:
| File | Change |
|------|--------|
| `apps/api/src/db/index.ts` | Read `DB_POOL_MAX`, `DB_IDLE_TIMEOUT`, `DB_CONNECT_TIMEOUT` from `process.env` |

**Implementation**:
```typescript
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!, {
  max: parseInt(process.env.DB_POOL_MAX || '20'),
  idle_timeout: parseInt(process.env.DB_IDLE_TIMEOUT || '20'),
  connect_timeout: parseInt(process.env.DB_CONNECT_TIMEOUT || '10'),
  max_lifetime: parseInt(process.env.DB_MAX_LIFETIME || '1800'), // 30 min
});
```

---

## Phase 1: Domain Generalization (Week 1-2)

This is the foundational change. It restructures enums, prompts, and types to support any research domain — not just Gaussian Splatting.

---

### Task 1.1: Create Domain Configuration System

**Size**: L (Large)
**Depends on**: Nothing (but is the foundation for many later tasks)

**Design**: Introduce a `DomainConfig` interface and a `domains/` directory. Each domain is a configuration object specifying entity types, relationship types, extraction prompts, example entities, and seed paper IDs.

#### New Files to Create

| File | Purpose |
|------|---------|
| `apps/api/src/config/domain.ts` | `DomainConfig` interface definition |
| `apps/api/src/config/domains/gaussian-splatting.ts` | Current GS-specific config extracted from hardcoded prompts |
| `apps/api/src/config/domains/nlp.ts` | Example: NLP domain config (transformers, attention, GLUE, BLEU, etc.) |
| `apps/api/src/config/domains/index.ts` | Registry: `Map<string, DomainConfig>` |
| `apps/api/src/routes/domains.ts` | `GET /api/domains` and `GET /api/domains/:id` endpoints |

#### DomainConfig Interface

```typescript
// apps/api/src/config/domain.ts

export interface DomainConfig {
  id: string;                          // "gaussian-splatting", "nlp", "biology"
  name: string;                        // "3D Gaussian Splatting"
  description: string;                 // "Research papers on 3D scene reconstruction..."
  
  entityTypes: string[];               // ['method', 'concept', 'dataset', 'metric']
  relationshipTypes: string[];         // ['extends', 'improves', 'uses', ...]
  
  // Domain-specific prompt fragments (injected into generic prompt templates)
  domainContext: string;               // "You are analyzing computer vision papers..."
  entityExamples: Record<string, string[]>;  // { method: ['3DGS', 'NeRF'], dataset: ['Mip-NeRF360'] }
  relationshipExamples: Array<{
    source: string;
    type: string;
    target: string;
  }>;
  
  // Optional
  seedPaperIds?: string[];             // Curated arXiv IDs for bootstrapping
  keyTerms?: string[];                 // Domain keywords for section detection
}
```

#### Files to Change

| File | Change |
|------|--------|
| `apps/api/src/db/schema.ts` | **Replace `pgEnum` for `node_type` and `edge_type` with `text` columns.** This avoids `ALTER TYPE` migrations when new domains introduce new types. Add `domain text` column to `papers` table. |
| `packages/shared/src/index.ts` | Change `NodeType` and `EdgeType` from union literals to `string`. Add `DomainConfig` type export. |
| `apps/api/src/agents/prompts/extraction.ts` | Replace hardcoded `EXTRACTION_SYSTEM_PROMPT` with factory: `createExtractionSystemPrompt(domain: DomainConfig): string` |
| `apps/api/src/agents/prompts/resolution.ts` | Same: `createResolutionSystemPrompt(domain: DomainConfig): string` |
| `apps/api/src/agents/prompts/validation.ts` | Same: `createValidationSystemPrompt(domain: DomainConfig): string` |
| `apps/api/src/agents/extractor.ts` | Accept `DomainConfig` parameter, pass to prompt factory |
| `apps/api/src/agents/resolver.ts` | Accept `DomainConfig` parameter |
| `apps/api/src/agents/validator.ts` | Accept `DomainConfig` parameter |
| `apps/api/src/pipeline/processor.ts` | Accept `DomainConfig` in `processPaper(paperId, domain)`. Pass to all agents. `isValidEdgeType()` reads from `domain.relationshipTypes` instead of hardcoded array. |
| `apps/api/src/routes/ingest.ts` | Accept `domain` in POST body. Replace hardcoded seed endpoint with `GET /api/ingest/seed/:domain`. |
| `apps/api/src/routes/graph.ts` | Remove hardcoded `/queries/improves-3dgs` and `/queries/extends-3dgs`. Replace with generic `GET /api/graph/queries/relationships?target=X&type=Y&domain=Z`. |
| `apps/api/src/index.ts` | Mount `domainsRouter`. Remove "Gaussian Splatting" from server branding. |
| `apps/web/src/App.tsx` | Remove "Gaussian Splatting Research" subtitle. Make dynamic or generic. |
| `apps/web/src/pages/Explorer.tsx` | Populate node type filter dropdown dynamically from `GET /api/domains/:id` response, not hardcoded. |
| `apps/web/src/pages/Ingestion.tsx` | Add domain selector dropdown. Pass selected domain to ingestion API calls. |
| `apps/web/src/pages/Dashboard.tsx` | Add domain filter. Show stats per domain or across all. |

#### Example: Gaussian Splatting Domain Config

```typescript
// apps/api/src/config/domains/gaussian-splatting.ts

export const gaussianSplattingDomain: DomainConfig = {
  id: 'gaussian-splatting',
  name: '3D Gaussian Splatting',
  description: 'Research papers on 3D scene reconstruction using Gaussian Splatting',
  
  entityTypes: ['method', 'concept', 'dataset', 'metric', 'paper_reference'],
  relationshipTypes: ['extends', 'improves', 'uses', 'introduces', 'cites', 'evaluates_on', 'compares_to', 'authored_by'],
  
  domainContext: `You are analyzing computer vision and 3D reconstruction papers, 
    specifically focused on Gaussian Splatting and neural radiance fields.`,
  
  entityExamples: {
    method: ['3D Gaussian Splatting', 'Mip-Splatting', 'Scaffold-GS', 'NeRF'],
    concept: ['Novel View Synthesis', 'Radiance Field', 'Differentiable Rendering'],
    dataset: ['Mip-NeRF360', 'Tanks and Temples', 'DTU'],
    metric: ['PSNR', 'SSIM', 'LPIPS', 'FPS'],
  },
  
  relationshipExamples: [
    { source: 'Mip-Splatting', type: 'improves', target: '3D Gaussian Splatting' },
    { source: '3D Gaussian Splatting', type: 'evaluates_on', target: 'Mip-NeRF360' },
    { source: '3D Gaussian Splatting', type: 'introduces', target: 'Gaussian Splatting' },
  ],
  
  seedPaperIds: ['2308.04079', '2311.16493', '2312.02126', /* ... */],
};
```

#### Example: NLP Domain Config

```typescript
// apps/api/src/config/domains/nlp.ts

export const nlpDomain: DomainConfig = {
  id: 'nlp',
  name: 'Natural Language Processing',
  description: 'Research papers on NLP, transformers, and language models',
  
  entityTypes: ['model', 'technique', 'dataset', 'metric', 'task', 'paper_reference'],
  relationshipTypes: ['extends', 'improves', 'uses', 'introduces', 'fine_tunes', 'evaluates_on', 'outperforms', 'is_variant_of'],
  
  domainContext: `You are analyzing natural language processing papers, 
    including transformers, large language models, and NLP benchmarks.`,
  
  entityExamples: {
    model: ['BERT', 'GPT-4', 'T5', 'LLaMA', 'Transformer'],
    technique: ['Attention', 'Self-Supervision', 'RLHF', 'LoRA', 'Chain-of-Thought'],
    dataset: ['GLUE', 'SQuAD', 'MMLU', 'HumanEval'],
    metric: ['BLEU', 'ROUGE', 'Perplexity', 'F1'],
    task: ['Machine Translation', 'Summarization', 'Question Answering'],
  },
  
  relationshipExamples: [
    { source: 'GPT-4', type: 'extends', target: 'GPT-3' },
    { source: 'LoRA', type: 'improves', target: 'Fine-tuning' },
    { source: 'BERT', type: 'evaluates_on', target: 'GLUE' },
  ],
  
  seedPaperIds: ['1706.03762', '1810.04805', '2005.14165'],
};
```

---

## Phase 2: Infrastructure Improvements (Week 2-3)

---

### Task 2.1: Zod Validation at Agent Boundaries

**Size**: M (Medium)
**Depends on**: Nothing

**Design**: Define Zod schemas for `ExtractorOutput`, `ResolverOutput`, and `ValidationOutput`. Use `.safeParse()` after `generateStructuredCompletion()` returns. On validation failure, log structured errors and fall back to empty results.

#### New Files

| File | Purpose |
|------|---------|
| `apps/api/src/agents/schemas.ts` | Zod schemas for all agent I/O types |

#### Zod Schemas

```typescript
// apps/api/src/agents/schemas.ts
import { z } from 'zod';

export const EntityMentionSchema = z.object({
  mention: z.string().min(1),
  type: z.string(),
  spanStart: z.number().int().nonnegative().optional(),
  spanEnd: z.number().int().nonnegative().optional(),
  confidence: z.number().min(0).max(1),
});

export const RelationshipSchema = z.object({
  subject: z.string().min(1),
  predicate: z.string().min(1),
  object: z.string().min(1),
  evidenceText: z.string().optional(),
  confidence: z.number().min(0).max(1),
});

export const ExtractorOutputSchema = z.object({
  entities: z.array(EntityMentionSchema).default([]),
  relationships: z.array(RelationshipSchema).default([]),
});

export const ResolvedEntitySchema = z.object({
  mention: z.string(),
  canonicalId: z.string().nullable(),
  canonicalName: z.string().min(1),
  type: z.string(),
  isNew: z.boolean(),
  confidence: z.number().min(0).max(1),
});

export const ResolvedRelationshipSchema = z.object({
  sourceName: z.string().min(1),
  targetName: z.string().min(1),
  type: z.string().min(1),
  confidence: z.number().min(0).max(1),
  evidence: z.string().optional(),
});

export const ResolverOutputSchema = z.object({
  resolvedEntities: z.array(ResolvedEntitySchema).default([]),
  resolvedRelationships: z.array(ResolvedRelationshipSchema).default([]),
});

export const ValidationOutputSchema = z.object({
  accepted: z.array(ResolvedRelationshipSchema).default([]),
  rejected: z.array(z.object({
    relationship: ResolvedRelationshipSchema,
    reason: z.string(),
  })).default([]),
  confidenceAdjustments: z.array(z.object({
    originalConfidence: z.number(),
    adjustedConfidence: z.number(),
    reason: z.string(),
  })).default([]),
});
```

#### Files to Change

| File | Change |
|------|--------|
| `apps/api/src/agents/extractor.ts` | After `generateStructuredCompletion()`, run `ExtractorOutputSchema.safeParse(result)`. Log validation errors. |
| `apps/api/src/agents/resolver.ts` | Same with `ResolverOutputSchema` |
| `apps/api/src/agents/validator.ts` | Same with `ValidationOutputSchema` |

**Example usage in extractor**:
```typescript
const raw = await generateStructuredCompletion<ExtractorOutput>(...);
const parsed = ExtractorOutputSchema.safeParse(raw);

if (!parsed.success) {
  console.error('Extractor output validation failed:', parsed.error.issues);
  return { entities: [], relationships: [] };
}

return parsed.data;
```

---

### Task 2.2: Persistent Job Status

**Size**: M
**Depends on**: Nothing

**Problem**: Job status lives in an in-memory `Map<string, JobStatus>` in `apps/api/src/routes/ingest.ts`. Server restart = all job status lost.

**Fix**: Add a `jobs` table to the database schema and replace all `Map` operations with DB queries.

#### Schema Addition

```typescript
// Add to apps/api/src/db/schema.ts

export const jobStatusEnum = pgEnum('job_status', [
  'queued', 'fetching_metadata', 'downloading_pdf', 
  'extracting_text', 'processing', 'completed', 'failed'
]);

export const jobs = pgTable('jobs', {
  id: text('id').primaryKey(),                    // "job-{timestamp}-{random}"
  type: text('type').notNull(),                    // "ingest" | "process"
  status: jobStatusEnum('status').default('queued').notNull(),
  paperId: uuid('paper_id').references(() => papers.id, { onDelete: 'set null' }),
  domain: text('domain'),
  progress: integer('progress').default(0),
  error: text('error'),
  metadata: jsonb('metadata'),                     // Flexible additional data
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  statusIdx: index('jobs_status_idx').on(table.status),
  paperIdIdx: index('jobs_paper_id_idx').on(table.paperId),
}));
```

#### Files to Change

| File | Change |
|------|--------|
| `apps/api/src/db/schema.ts` | Add `jobs` table (above) |
| `apps/api/src/routes/ingest.ts` | Replace `jobStatus.set(jobId, ...)` → `db.insert(jobs).values(...)`. Replace `jobStatus.get(jobId)` → `db.select().from(jobs).where(eq(jobs.id, jobId))`. Remove the in-memory `Map`. |

---

### Task 2.3: BullMQ + Redis Background Processing

**Size**: M
**Depends on**: Task 2.2

**Problem**: `processPaper()` blocks the API thread for 3-5 minutes. During processing, other API calls suffer from event loop starvation.

**Fix**: Add Redis to Docker, create a BullMQ queue, and move paper processing to a background worker.

#### New Files

| File | Purpose |
|------|---------|
| `apps/api/src/queue/index.ts` | BullMQ queue setup, Redis connection |
| `apps/api/src/queue/worker.ts` | Worker that calls `processPaper()` |
| `apps/api/src/queue/jobs.ts` | Job type definitions and payload interfaces |

#### Queue Setup

```typescript
// apps/api/src/queue/index.ts
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

export const redis = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

export const paperQueue = new Queue('paper-processing', { connection: redis });
```

#### Worker Setup

```typescript
// apps/api/src/queue/worker.ts
import { Worker, Job } from 'bullmq';
import { redis } from './index';
import { processPaper } from '../pipeline/processor';
import { getDomainConfig } from '../config/domains';

interface ProcessPaperJob {
  paperId: string;
  domain: string;
  jobId: string;
}

const worker = new Worker('paper-processing', async (job: Job<ProcessPaperJob>) => {
  const { paperId, domain, jobId } = job.data;
  const domainConfig = getDomainConfig(domain);
  
  // Update job progress via BullMQ events
  job.updateProgress(0);
  
  const stats = await processPaper(paperId, domainConfig, (progress) => {
    job.updateProgress(progress);
  });
  
  return stats;
}, {
  connection: redis,
  concurrency: 2,   // Process 2 papers at a time
  limiter: {
    max: 10,
    duration: 60000, // Max 10 jobs per minute (OpenAI rate limiting)
  },
});

export { worker };
```

#### Files to Change

| File | Change |
|------|--------|
| `docker-compose.yml` | Add Redis service (`redis:7-alpine`, port 6379) |
| `apps/api/package.json` | Add `bullmq`, `ioredis` dependencies |
| `apps/api/src/routes/ingest.ts` | Replace fire-and-forget `processPaper()` with `paperQueue.add('process', { paperId, domain, jobId })` |
| `apps/api/src/routes/papers.ts` | Replace direct `processPaper()` call in `POST /:id/process` with queue enqueue |
| `apps/api/src/pipeline/processor.ts` | Accept optional `onProgress` callback parameter for progress updates |
| `apps/api/src/index.ts` | Import and start worker (or run in separate process) |

#### Docker Compose Addition

```yaml
# Add to docker-compose.yml
redis:
  image: redis:7-alpine
  container_name: gsplat-kg-redis
  ports:
    - "6379:6379"
  volumes:
    - redis_data:/data
  restart: unless-stopped

# Add to volumes:
volumes:
  postgres_data:
  redis_data:
```

---

### Task 2.4: SSE Instead of Polling

**Size**: M
**Depends on**: Task 2.3

**Problem**: Frontend polls `/api/papers/processing` every 2 seconds. For N connected clients, that's N/2 queries per second hitting the database — even when nothing is processing.

**Fix**: Server-Sent Events endpoint that pushes updates only when status changes.

#### New Files

| File | Purpose |
|------|---------|
| `apps/api/src/routes/events.ts` | SSE endpoints using Hono's `streamSSE()` |
| `apps/api/src/events/emitter.ts` | Centralized EventEmitter for processing events |

#### Event Emitter

```typescript
// apps/api/src/events/emitter.ts
import { EventEmitter } from 'events';

export interface ProcessingEvent {
  type: 'progress' | 'status' | 'completed' | 'failed';
  paperId: string;
  jobId?: string;
  progress?: number;
  status?: string;
  error?: string;
  stats?: any;
}

export const processingEmitter = new EventEmitter();
processingEmitter.setMaxListeners(100); // Support 100 concurrent SSE connections
```

#### SSE Route

```typescript
// apps/api/src/routes/events.ts
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { processingEmitter, ProcessingEvent } from '../events/emitter';

export const eventsRouter = new Hono();

eventsRouter.get('/processing', async (c) => {
  return streamSSE(c, async (stream) => {
    const handler = (event: ProcessingEvent) => {
      stream.writeSSE({
        event: event.type,
        data: JSON.stringify(event),
      });
    };

    processingEmitter.on('update', handler);

    // Keep connection alive with heartbeat
    const heartbeat = setInterval(() => {
      stream.writeSSE({ event: 'heartbeat', data: '' });
    }, 30000);

    // Cleanup on disconnect
    stream.onAbort(() => {
      processingEmitter.off('update', handler);
      clearInterval(heartbeat);
    });

    // Block until client disconnects
    await new Promise(() => {});
  });
});
```

#### Files to Change

| File | Change |
|------|--------|
| `apps/api/src/index.ts` | Mount `eventsRouter` at `/api/events` |
| `apps/api/src/pipeline/processor.ts` | Emit events: `processingEmitter.emit('update', { type: 'progress', paperId, progress })` at each status change |
| `apps/web/src/lib/api.ts` | Add `subscribeToProcessing(): EventSource` helper |
| `apps/web/src/pages/Dashboard.tsx` | Replace `refetchInterval: 2000` with EventSource subscription. Invalidate React Query cache on event. |
| `apps/web/src/pages/Ingestion.tsx` | Replace polling with EventSource for job status |

#### Frontend EventSource Usage

```typescript
// apps/web/src/lib/api.ts
export function subscribeToProcessing(onEvent: (event: ProcessingEvent) => void): () => void {
  const source = new EventSource(`${BASE_URL}/api/events/processing`);
  
  source.addEventListener('progress', (e) => onEvent(JSON.parse(e.data)));
  source.addEventListener('completed', (e) => onEvent(JSON.parse(e.data)));
  source.addEventListener('failed', (e) => onEvent(JSON.parse(e.data)));
  
  source.onerror = () => {
    // Auto-reconnect is built into EventSource
    console.warn('SSE connection lost, reconnecting...');
  };
  
  return () => source.close(); // Cleanup function
}

// In Dashboard.tsx:
useEffect(() => {
  const cleanup = subscribeToProcessing((event) => {
    queryClient.invalidateQueries(['processing-papers']);
    queryClient.invalidateQueries(['graph-stats']);
  });
  return cleanup;
}, []);
```

---

### Task 2.5: Parallel Chunk Processing

**Size**: M
**Depends on**: Task 0.3 (existingNodes cache must be hoisted first)

**Problem**: Chunks are processed sequentially with a 500ms sleep between each. For 46 chunks × 3 agents × ~3s per LLM call = ~7 minutes per paper.

**Fix**: Batch 3-5 chunks through the Extractor in parallel using `Promise.allSettled()`. Resolver and Validator remain sequential per batch to maintain entityMap consistency.

#### Files to Change

| File | Change |
|------|--------|
| `apps/api/src/pipeline/processor.ts` | Replace sequential `for` loop with batched processing. Remove 500ms sleep. |

#### Implementation

```typescript
// apps/api/src/pipeline/processor.ts

const BATCH_SIZE = 4; // Process 4 chunks at a time through extractor

for (let batchStart = 0; batchStart < chunks.length; batchStart += BATCH_SIZE) {
  const batch = chunks.slice(batchStart, batchStart + BATCH_SIZE);
  
  // STEP 1: Parallel extraction (independent per chunk)
  const extractionResults = await Promise.allSettled(
    batch.map((chunk, j) => {
      const chunkIndex = batchStart + j;
      const section = detectSection(chunk, chunkIndex, chunks.length);
      return extractEntitiesAndRelationships({
        paperId, chunkIndex, text: chunk, section,
      });
    })
  );
  
  // STEP 2: Sequential resolution & validation (needs entityMap)
  for (let j = 0; j < extractionResults.length; j++) {
    const result = extractionResults[j];
    if (result.status === 'rejected') continue;
    
    const extractorOutput = result.value;
    
    // Resolve against existing nodes
    const resolverOutput = await resolveEntities(extractorOutput, existingNodes);
    
    // Create new nodes, update entityMap
    // ...existing node creation logic...
    
    // Validate relationships
    const validationOutput = await validateRelationships(resolverOutput, graphContext);
    
    // Insert edges with provenance
    // ...existing edge insertion logic...
  }
  
  // Update progress for the batch
  const progress = Math.floor(((batchStart + batch.length) / chunks.length) * 100);
  await db.update(papers).set({ processingProgress: progress }).where(eq(papers.id, paperId));
}
```

**Expected improvement**: Processing time drops from ~5 min to ~2 min per paper (Extractor calls are the bottleneck and now run 4x parallel).

---

## Phase 3: Data Quality Improvements (Week 3-4)

---

### Task 3.1: UPSERT for Edges

**Size**: S
**Depends on**: Nothing

**Problem**: The pipeline can create duplicate edges (same source, target, type) across chunks. For example, if "3DGS improves NeRF" appears in both the abstract and methods sections, two identical edges are created.

**Fix**: Add a unique constraint and use `ON CONFLICT DO UPDATE` to merge confidence scores.

#### Files to Change

| File | Change |
|------|--------|
| `apps/api/src/db/schema.ts` | Add unique index to `edges` table |
| `apps/api/src/pipeline/processor.ts` | Change `db.insert(edges)` to use `.onConflictDoUpdate()` |

#### Schema Change

```typescript
// In edges table definition, add to the index function:
(table) => ({
  // ...existing indexes...
  uniqueSourceTargetType: uniqueIndex('edges_source_target_type_uniq')
    .on(table.sourceId, table.targetId, table.type),
})
```

#### Processor Change

```typescript
// Replace db.insert(edges).values({...}).returning()
const [edge] = await db
  .insert(edges)
  .values({
    sourceId,
    targetId,
    type: relationship.type as any,
    confidence: String(relationship.confidence || 0.5),
  })
  .onConflictDoUpdate({
    target: [edges.sourceId, edges.targetId, edges.type],
    set: {
      // Keep the higher confidence score
      confidence: sql`GREATEST(${edges.confidence}, EXCLUDED.confidence)`,
    },
  })
  .returning();
```

---

### Task 3.2: Persist EntityMap for Resumable Processing

**Size**: M
**Depends on**: Task 2.3

**Problem**: If processing crashes at chunk 30/46, restarting reprocesses everything from scratch. The `entityMap` (Map<normalizedName, UUID>) is lost.

**Fix**: Store the entityMap and last processed chunk index in the database. On restart, reload and resume.

#### Schema Change

```typescript
// Add to papers table in apps/api/src/db/schema.ts
entityMap: jsonb('entity_map'),              // Serialized Map<string, string>
lastProcessedChunk: integer('last_processed_chunk').default(0),
```

#### Files to Change

| File | Change |
|------|--------|
| `apps/api/src/db/schema.ts` | Add `entityMap` and `lastProcessedChunk` columns to `papers` |
| `apps/api/src/pipeline/processor.ts` | Save entityMap and chunk index after each batch. On startup, check for existing state and resume. |

#### Implementation

```typescript
// At start of processPaper():
let entityMap: Map<string, string>;
let startChunk = 0;

if (paper.entityMap && paper.lastProcessedChunk) {
  // Resume from crash
  entityMap = new Map(Object.entries(paper.entityMap as Record<string, string>));
  startChunk = paper.lastProcessedChunk;
  console.log(`Resuming from chunk ${startChunk} with ${entityMap.size} entities`);
} else {
  entityMap = new Map();
}

// After each batch:
await db.update(papers).set({
  entityMap: Object.fromEntries(entityMap),
  lastProcessedChunk: batchStart + batch.length,
}).where(eq(papers.id, paperId));
```

---

### Task 3.3: pgvector for Semantic Deduplication

**Size**: L
**Depends on**: Task 1.1

**Problem**: Fuzzy matching in `findEntityId()` uses substring matching (`key.includes(name)`). This misses semantic synonyms like "rendering quality" vs "image fidelity" or "training efficiency" vs "computational cost".

**Fix**: Add vector embeddings to nodes. During entity resolution, query by cosine similarity to find semantic near-duplicates.

#### New Files

| File | Purpose |
|------|---------|
| `apps/api/src/services/embeddings.ts` | Embedding generation via OpenAI or local model |

#### Embeddings Service

```typescript
// apps/api/src/services/embeddings.ts

export async function generateEmbedding(text: string): Promise<number[]> {
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: text,
    }),
  });
  
  const data = await response.json();
  return data.data[0].embedding;  // 1536-dimensional vector
}

export async function findSimilarNodes(
  embedding: number[], 
  threshold: number = 0.85,
  limit: number = 5
): Promise<Array<{ id: string; name: string; similarity: number }>> {
  return await db.execute(sql`
    SELECT id, name, 
           1 - (embedding <=> ${JSON.stringify(embedding)}::vector) as similarity
    FROM nodes
    WHERE embedding IS NOT NULL
      AND 1 - (embedding <=> ${JSON.stringify(embedding)}::vector) > ${threshold}
    ORDER BY embedding <=> ${JSON.stringify(embedding)}::vector
    LIMIT ${limit}
  `);
}
```

#### Files to Change

| File | Change |
|------|--------|
| `docker-compose.yml` | Change PostgreSQL image to `pgvector/pgvector:pg16` |
| `apps/api/src/db/schema.ts` | Add `embedding vector(1536)` column to `nodes`. Add HNSW index for fast similarity search. |
| `apps/api/src/pipeline/processor.ts` | Generate embeddings when creating new nodes. Use `findSimilarNodes()` before `findEntityId()` for better dedup. |
| `apps/api/package.json` | Add `pgvector` drizzle extension if needed |

#### Schema Change

```typescript
// In nodes table:
embedding: sql`vector(1536)`,  // pgvector column

// Add HNSW index for fast cosine similarity search:
embeddingIdx: sql`CREATE INDEX IF NOT EXISTS nodes_embedding_idx 
  ON nodes USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)`,
```

---

### Task 3.4: Incremental Reprocessing

**Size**: M
**Depends on**: Task 0.1

**Problem**: `reprocessPaper()` deletes all nodes/edges and reruns the entire pipeline from scratch. For a 46-chunk paper, this wastes ~5 minutes of LLM calls even if only the abstract changed.

**Fix**: Store a hash of each chunk's text. On reprocess, only re-extract chunks whose text has changed.

#### Schema Addition

```typescript
// Add to apps/api/src/db/schema.ts
export const chunkHashes = pgTable('chunk_hashes', {
  id: uuid('id').defaultRandom().primaryKey(),
  paperId: uuid('paper_id').notNull().references(() => papers.id, { onDelete: 'cascade' }),
  chunkIndex: integer('chunk_index').notNull(),
  hash: text('hash').notNull(),  // SHA-256 of chunk text
  processedAt: timestamp('processed_at').defaultNow().notNull(),
}, (table) => ({
  paperChunkIdx: uniqueIndex('chunk_hashes_paper_chunk_idx').on(table.paperId, table.chunkIndex),
}));
```

#### Files to Change

| File | Change |
|------|--------|
| `apps/api/src/db/schema.ts` | Add `chunkHashes` table |
| `apps/api/src/pipeline/processor.ts` | In `processPaper()`: hash each chunk before processing, compare with stored hash, skip unchanged chunks. In `reprocessPaper()`: only delete edges from changed chunks. |

#### Implementation

```typescript
import { createHash } from 'crypto';

function hashChunk(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

// In processPaper(), inside the loop:
const chunkHash = hashChunk(chunks[i]);
const existingHash = await db.select()
  .from(chunkHashes)
  .where(and(eq(chunkHashes.paperId, paperId), eq(chunkHashes.chunkIndex, i)))
  .limit(1);

if (existingHash.length > 0 && existingHash[0].hash === chunkHash) {
  console.log(`Chunk ${i} unchanged, skipping...`);
  continue;
}

// Process the chunk normally...

// After processing, save the hash:
await db.insert(chunkHashes).values({
  paperId, chunkIndex: i, hash: chunkHash,
}).onConflictDoUpdate({
  target: [chunkHashes.paperId, chunkHashes.chunkIndex],
  set: { hash: chunkHash, processedAt: new Date() },
});
```

---

## Phase 4: Frontend Improvements (Week 4-5)

All three tasks are **independent** and can be done in parallel.

---

### Task 4.1: Force-Directed Graph Layout

**Size**: M
**Depends on**: Nothing

**Problem**: The circular layout in `Explorer.tsx` (lines 46-51) distributes nodes evenly around a circle. This gives no semantic clustering — related nodes aren't grouped together.

**Fix**: Replace with a D3-force simulation that clusters connected nodes.

#### New Files

| File | Purpose |
|------|---------|
| `apps/web/src/lib/layout.ts` | Force layout utility function |

#### Layout Utility

```typescript
// apps/web/src/lib/layout.ts
import { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide } from 'd3-force';

interface LayoutNode {
  id: string;
  x?: number;
  y?: number;
}

interface LayoutEdge {
  source: string;
  target: string;
}

export function computeForceLayout(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  width: number = 1200,
  height: number = 800
): Map<string, { x: number; y: number }> {
  const simulation = forceSimulation(nodes as any)
    .force('link', forceLink(edges as any).id((d: any) => d.id).distance(120))
    .force('charge', forceManyBody().strength(-300))
    .force('center', forceCenter(width / 2, height / 2))
    .force('collide', forceCollide().radius(40))
    .stop();

  // Run simulation synchronously (300 ticks)
  for (let i = 0; i < 300; i++) {
    simulation.tick();
  }

  const positions = new Map<string, { x: number; y: number }>();
  for (const node of nodes) {
    positions.set(node.id, { x: (node as any).x, y: (node as any).y });
  }
  return positions;
}
```

#### Files to Change

| File | Change |
|------|--------|
| `apps/web/package.json` | Add `d3-force`, `@types/d3-force` |
| `apps/web/src/pages/Explorer.tsx` | Replace circular layout math (lines 46-51) with `computeForceLayout()`. Run in `useMemo` to avoid recomputation on every render. |

#### Explorer Change

```typescript
// In Explorer.tsx, replace the circular layout:
const flowNodes = useMemo(() => {
  if (!nodesData?.nodes || !edgesData?.edges) return [];
  
  const layoutEdges = edgesData.edges.map(e => ({ source: e.sourceId, target: e.targetId }));
  const positions = computeForceLayout(
    nodesData.nodes.map(n => ({ id: n.id })),
    layoutEdges
  );
  
  return nodesData.nodes.map(node => {
    const pos = positions.get(node.id) || { x: 0, y: 0 };
    return {
      id: node.id,
      position: { x: pos.x, y: pos.y },
      data: { label: node.name, type: node.type },
      style: { /* color by type */ },
    };
  });
}, [nodesData, edgesData]);
```

---

### Task 4.2: Confidence Filtering UI

**Size**: S
**Depends on**: Nothing

**Problem**: Users can't filter out low-confidence edges in the Explorer. All edges are shown regardless of confidence, making the graph noisy.

**Fix**: Add a range slider to the Explorer toolbar.

#### Files to Change

| File | Change |
|------|--------|
| `apps/web/src/pages/Explorer.tsx` | Add state, slider input, and edge filter logic |

#### Implementation

```tsx
// In Explorer.tsx:

// Add state:
const [minConfidence, setMinConfidence] = useState(0);

// Filter edges:
const filteredEdges = useMemo(() => {
  if (!edgesData?.edges) return [];
  return edgesData.edges.filter(e => parseFloat(e.confidence || '0') >= minConfidence);
}, [edgesData, minConfidence]);

// Add to toolbar JSX (alongside existing type filter):
<div className="flex items-center gap-2">
  <label className="text-sm text-gray-600">Min Confidence:</label>
  <input
    type="range"
    min="0"
    max="1"
    step="0.05"
    value={minConfidence}
    onChange={(e) => setMinConfidence(parseFloat(e.target.value))}
    className="w-32"
  />
  <span className="text-sm font-mono">{minConfidence.toFixed(2)}</span>
</div>
```

---

### Task 4.3: Error Boundaries

**Size**: S
**Depends on**: Nothing

**Problem**: No React error boundaries. A single bad node in the graph data (e.g., null name) crashes the entire Explorer page with a white screen.

#### New Files

| File | Purpose |
|------|---------|
| `apps/web/src/components/ErrorBoundary.tsx` | Reusable error boundary component |

#### Error Boundary Component

```tsx
// apps/web/src/components/ErrorBoundary.tsx
import React, { Component, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('Error boundary caught:', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback || (
        <div className="p-8 text-center">
          <h2 className="text-xl font-bold text-red-600 mb-2">Something went wrong</h2>
          <p className="text-gray-600 mb-4">{this.state.error?.message}</p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
          >
            Try Again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
```

#### Files to Change

| File | Change |
|------|--------|
| `apps/web/src/App.tsx` | Wrap `<Routes>` in `<ErrorBoundary>` |
| `apps/web/src/pages/Explorer.tsx` | Wrap `<ReactFlow>` in `<ErrorBoundary>` |

---

## Phase 5: API Hardening (Week 5-6)

---

### Task 5.1: Rate Limiting

**Size**: S
**Depends on**: Nothing (Redis from 2.3 is optional, can use in-memory)

**Problem**: No rate limiting. Anyone can spam `/api/ingest/arxiv` and burn through the OpenAI API budget.

#### Files to Change

| File | Change |
|------|--------|
| `apps/api/package.json` | Add rate limiting middleware package |
| `apps/api/src/index.ts` | Add rate limiting middleware with different limits per route group |

#### Implementation

```typescript
// apps/api/src/index.ts
import { rateLimiter } from 'hono-rate-limiter';

// Strict limit for ingestion (expensive LLM calls)
const ingestLimiter = rateLimiter({
  windowMs: 60 * 1000,  // 1 minute
  limit: 10,             // 10 requests per minute
  keyGenerator: (c) => c.req.header('x-forwarded-for') || 'global',
  message: { error: 'Too many ingestion requests. Try again in a minute.' },
});

// Lenient limit for graph queries
const queryLimiter = rateLimiter({
  windowMs: 60 * 1000,
  limit: 200,
  keyGenerator: (c) => c.req.header('x-forwarded-for') || 'global',
});

app.use('/api/ingest/*', ingestLimiter);
app.use('/api/graph/*', queryLimiter);
app.use('/api/papers/*/process', ingestLimiter);
```

---

### Task 5.2: Batch OpenAI Calls

**Size**: M
**Depends on**: Task 2.3

**Problem**: 138 individual LLM calls per paper at full price. OpenAI's Batch API offers 50% cost reduction for non-real-time workloads.

#### New Files

| File | Purpose |
|------|---------|
| `apps/api/src/services/batch-openai.ts` | Batch API wrapper |

#### Design

```
Normal mode: chunk → LLM call → result (3s latency, full price)
Batch mode:  all chunks → batch file → submit → poll → results (up to 24h, 50% off)
```

#### Files to Change

| File | Change |
|------|--------|
| `apps/api/src/services/batch-openai.ts` | New: `createBatch()`, `checkBatchStatus()`, `retrieveBatchResults()` |
| `apps/api/src/pipeline/processor.ts` | Add `batchMode` branch: collect all chunk prompts, submit as batch, wait for results, then run resolver/validator |
| `apps/api/src/routes/ingest.ts` | Accept `batchMode: boolean` parameter in POST body |

---

## Phase 6: Testing (Ongoing)

---

### Task 6.1: Automated Tests

**Size**: L
**Depends on**: Task 2.1 (Zod schemas), Tasks 0.1/0.2 (bug fixes)

#### New Files

| File | Purpose |
|------|---------|
| `apps/api/vitest.config.ts` | Test configuration |
| `apps/api/src/__tests__/pipeline/processor.test.ts` | Unit tests: `chunkText()`, `detectSection()`, `findEntityId()`, `isValidEdgeType()` |
| `apps/api/src/__tests__/agents/schemas.test.ts` | Zod schema validation with sample LLM outputs |
| `apps/api/src/__tests__/routes/graph.test.ts` | API integration tests with Supertest |
| `apps/api/src/__tests__/routes/papers.test.ts` | Paper CRUD tests |
| `apps/api/src/__tests__/fixtures/` | Golden file LLM responses for deterministic testing |

#### Test Categories

**1. Unit Tests (Pure Functions)**
```typescript
// processor.test.ts
describe('chunkText', () => {
  it('splits text into chunks of specified size', () => { ... });
  it('includes overlap between chunks', () => { ... });
  it('splits on paragraph boundaries when possible', () => { ... });
  it('handles text shorter than chunk size', () => { ... });
  it('handles empty text', () => { ... });
});

describe('findEntityId', () => {
  it('finds exact match by normalized name', () => { ... });
  it('finds substring match', () => { ... });
  it('returns null when no match found', () => { ... });
  it('handles empty entity map', () => { ... });
});

describe('detectSection', () => {
  it('detects abstract section', () => { ... });
  it('detects methods section', () => { ... });
  it('defaults to body for unrecognized sections', () => { ... });
});
```

**2. Schema Validation Tests**
```typescript
// schemas.test.ts
describe('ExtractorOutputSchema', () => {
  it('validates correct extractor output', () => { ... });
  it('rejects missing entities array', () => { ... });
  it('rejects confidence > 1', () => { ... });
  it('applies defaults for missing optional fields', () => { ... });
});
```

**3. API Integration Tests**
```typescript
// graph.test.ts
describe('GET /api/graph/nodes', () => {
  it('returns paginated nodes', () => { ... });
  it('filters by type', () => { ... });
  it('searches by name', () => { ... });
  it('returns 200 with empty result for no matches', () => { ... });
});

describe('GET /api/graph/subgraph', () => {
  it('returns N-hop neighborhood', () => { ... });
  it('caps depth at 3', () => { ... });
  it('returns 400 without nodeId', () => { ... });
  it('returns 404 for non-existent node', () => { ... });
});
```

**4. Golden File Tests**
```typescript
// Save known-good LLM responses as fixtures
// Verify pipeline produces expected nodes/edges from those fixtures
describe('Pipeline with mocked LLM', () => {
  it('produces expected entities from sample extraction', () => { ... });
  it('deduplicates entities correctly', () => { ... });
  it('creates edges with correct confidence', () => { ... });
});
```

#### Files to Change

| File | Change |
|------|--------|
| `apps/api/package.json` | Add `vitest`, `supertest`, `@types/supertest` |
| `package.json` | Add root `test` script: `pnpm --filter api test` |

---

## Phase 7: Staff-Level Engineering (Week 7-10)

These are the concerns that separate a senior engineer's project from a staff engineer's project. Each task demonstrates **systems thinking** — reasoning about failure modes, data integrity at scale, operational visibility, and abstractions that outlast the current requirements.

In an interview, these are the things that make someone say: "This person thinks about systems the way we need them to."

---

### Task 7.1: Ontology Management Layer

**Size**: L
**Depends on**: Task 1.1 (Domain Generalization)

**Why this matters**: The current system has flat entity types (`method`, `concept`, `dataset`). Real knowledge graphs have **type hierarchies**. "LoRA" is-a "fine-tuning method" is-a "training technique" is-a "method". Without an ontology layer, the graph can't answer questions like "show me all training techniques" — it only knows about flat types.

A staff engineer builds the abstraction that lets the graph **grow without code changes**.

#### Design

```
Ontology Layer
├── Type Hierarchies (is-a relationships between types)
├── Relationship Constraints (which types can connect via which edges)
├── Schema Versioning (ontology evolves as domains grow)
└── Validation Rules (enforce constraints on insertion)
```

#### New Files

| File | Purpose |
|------|---------|
| `apps/api/src/ontology/types.ts` | `OntologySchema` interface, type hierarchy representation |
| `apps/api/src/ontology/validator.ts` | Validates nodes/edges against ontology constraints |
| `apps/api/src/ontology/registry.ts` | Manages ontology versions, loads/caches schemas |

#### Ontology Schema Interface

```typescript
// apps/api/src/ontology/types.ts

export interface OntologyType {
  name: string;                     // "fine_tuning_method"
  parent: string | null;            // "training_technique" → forms tree
  description: string;
  properties?: Record<string, {     // Expected JSONB properties for this type
    type: 'string' | 'number' | 'boolean' | 'array';
    required?: boolean;
  }>;
}

export interface RelationshipConstraint {
  type: string;                     // "evaluates_on"
  allowedSourceTypes: string[];     // ["method", "model"]
  allowedTargetTypes: string[];     // ["dataset", "benchmark"]
  symmetric: boolean;               // true for "compares_to"
  transitive: boolean;              // true for "extends" (if A extends B, B extends C → A extends C)
}

export interface OntologySchema {
  version: string;                  // Semver: "2.1.0"
  domain: string;                   // "gaussian-splatting"
  types: OntologyType[];
  relationships: RelationshipConstraint[];
  
  // Type hierarchy helpers
  isSubtypeOf(child: string, parent: string): boolean;
  getAllSubtypes(parent: string): string[];
}
```

#### Schema Addition

```typescript
// Add to apps/api/src/db/schema.ts

export const ontologyVersions = pgTable('ontology_versions', {
  id: uuid('id').defaultRandom().primaryKey(),
  domain: text('domain').notNull(),
  version: text('version').notNull(),           // "2.1.0"
  schema: jsonb('schema').notNull(),             // Full OntologySchema as JSON
  active: boolean('active').default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  migratedFrom: text('migrated_from'),           // Previous version
}, (table) => ({
  domainVersionIdx: uniqueIndex('ontology_domain_version_idx').on(table.domain, table.version),
  activeDomainIdx: index('ontology_active_domain_idx').on(table.domain, table.active),
}));

// Add to nodes table:
ontologyType: text('ontology_type'),             // Detailed type from ontology (e.g., "fine_tuning_method")
// Existing 'type' column becomes the top-level category for backward compat
```

#### Ontology Validator

```typescript
// apps/api/src/ontology/validator.ts

export class OntologyValidator {
  constructor(private schema: OntologySchema) {}

  validateNode(type: string, properties?: Record<string, any>): ValidationResult {
    // Check type exists in ontology
    const typeDef = this.schema.types.find(t => t.name === type);
    if (!typeDef) return { valid: false, error: `Unknown type: ${type}` };
    
    // Validate required properties
    if (typeDef.properties) {
      for (const [key, spec] of Object.entries(typeDef.properties)) {
        if (spec.required && (!properties || !(key in properties))) {
          return { valid: false, error: `Missing required property: ${key}` };
        }
      }
    }
    return { valid: true };
  }

  validateEdge(sourceType: string, targetType: string, edgeType: string): ValidationResult {
    const constraint = this.schema.relationships.find(r => r.type === edgeType);
    if (!constraint) return { valid: false, error: `Unknown relationship type: ${edgeType}` };
    
    // Check source type is allowed (including subtypes)
    const sourceAllowed = constraint.allowedSourceTypes.some(
      allowed => sourceType === allowed || this.schema.isSubtypeOf(sourceType, allowed)
    );
    if (!sourceAllowed) {
      return { valid: false, error: `${sourceType} cannot be source of ${edgeType}` };
    }
    
    // Check target type is allowed (including subtypes)
    const targetAllowed = constraint.allowedTargetTypes.some(
      allowed => targetType === allowed || this.schema.isSubtypeOf(targetType, allowed)
    );
    if (!targetAllowed) {
      return { valid: false, error: `${targetType} cannot be target of ${edgeType}` };
    }
    
    return { valid: true };
  }
}
```

#### How It Changes the Pipeline

```typescript
// In processor.ts, before inserting an edge:
const ontology = await getActiveOntology(domain);
const validator = new OntologyValidator(ontology);

const validation = validator.validateEdge(sourceNode.type, targetNode.type, relationship.type);
if (!validation.valid) {
  console.warn(`Ontology violation: ${validation.error}`);
  stats.ontologyRejections++;
  continue; // Skip this edge
}
```

#### Interview Talking Points

- "The ontology layer decouples domain knowledge from application code. Adding a new entity type or relationship constraint is a config change, not a code change."
- "Type hierarchies enable polymorphic queries — 'show me all training techniques' returns LoRA, QLoRA, full fine-tuning, RLHF without enumerating each."
- "Schema versioning means we can evolve the ontology without breaking existing data. Old papers processed under v1 coexist with new papers under v2."
- "Relationship constraints prevent nonsensical edges at insertion time — a dataset can't 'improve' a metric."

---

### Task 7.2: Graph Quality Metrics & Observability Dashboard

**Size**: L
**Depends on**: Tasks 2.4 (SSE), 3.1 (Edge UPSERT)

**Why this matters**: A staff engineer doesn't just build a system — they build the **ability to know if the system is working well**. The current Dashboard shows raw counts (52 nodes, 25 edges). A production KG needs quality signals: Are extractions getting better? Is deduplication working? Are confidence scores calibrated?

Without observability, you're flying blind.

#### Design

```
Graph Quality Metrics
├── Structural Metrics (connectivity, density, orphans)
├── Extraction Quality (confidence distribution, rejection rates, entity coverage)
├── Agent Performance (latency, token usage, error rates per agent)
├── Temporal Health (stale entities, processing backlog)
└── Cost Attribution ($ per paper, $ per entity, $ per edge)
```

#### New Files

| File | Purpose |
|------|---------|
| `apps/api/src/services/metrics.ts` | Metric computation service |
| `apps/api/src/routes/metrics.ts` | Metrics API endpoints |
| `apps/web/src/pages/Observability.tsx` | Observability dashboard page |

#### Metrics Service

```typescript
// apps/api/src/services/metrics.ts

export interface GraphQualityMetrics {
  // Structural
  totalNodes: number;
  totalEdges: number;
  orphanNodes: number;              // Nodes with 0 edges (extraction noise?)
  graphDensity: number;             // edges / (nodes * (nodes-1)) — how connected
  avgDegree: number;                // Average edges per node
  connectedComponents: number;      // Disconnected subgraphs (ideally 1)
  
  // Extraction Quality
  avgConfidence: number;            // Mean confidence across all edges
  confidenceDistribution: {         // Histogram buckets
    '0.0-0.2': number;
    '0.2-0.4': number;
    '0.4-0.6': number;
    '0.6-0.8': number;
    '0.8-1.0': number;
  };
  rejectionRate: number;            // % relationships rejected by validator
  deduplicationRate: number;        // % entities deduplicated (60 extracted → 42 created = 30%)
  entityCoverage: Record<string, number>;  // % of papers that produce each entity type
  
  // Agent Performance
  agentMetrics: {
    extractor: AgentMetrics;
    resolver: AgentMetrics;
    validator: AgentMetrics;
  };
  
  // Cost
  totalTokensUsed: number;
  estimatedCost: number;            // $ based on token usage
  costPerPaper: number;
  costPerEdge: number;
}

export interface AgentMetrics {
  avgLatencyMs: number;
  p95LatencyMs: number;
  errorRate: number;                // % of calls that returned empty/failed
  avgTokensPerCall: number;
  totalCalls: number;
}

export async function computeGraphQualityMetrics(): Promise<GraphQualityMetrics> {
  // Orphan nodes: nodes with no edges
  const orphans = await db.execute(sql`
    SELECT COUNT(*) as count FROM nodes n
    WHERE NOT EXISTS (SELECT 1 FROM edges e WHERE e.source_id = n.id OR e.target_id = n.id)
  `);
  
  // Confidence distribution
  const confidenceDist = await db.execute(sql`
    SELECT 
      COUNT(*) FILTER (WHERE confidence < 0.2) as bucket_0_2,
      COUNT(*) FILTER (WHERE confidence >= 0.2 AND confidence < 0.4) as bucket_2_4,
      COUNT(*) FILTER (WHERE confidence >= 0.4 AND confidence < 0.6) as bucket_4_6,
      COUNT(*) FILTER (WHERE confidence >= 0.6 AND confidence < 0.8) as bucket_6_8,
      COUNT(*) FILTER (WHERE confidence >= 0.8) as bucket_8_10,
      AVG(confidence::numeric) as avg_confidence
    FROM edges
  `);
  
  // Connected components (simplified — counts distinct subgraphs)
  const components = await db.execute(sql`
    WITH RECURSIVE component AS (
      SELECT id, id as component_id FROM nodes
      UNION
      SELECT n.id, LEAST(c.component_id, n.id)
      FROM nodes n
      JOIN edges e ON e.source_id = n.id OR e.target_id = n.id
      JOIN component c ON c.id = CASE WHEN e.source_id = n.id THEN e.target_id ELSE e.source_id END
    )
    SELECT COUNT(DISTINCT component_id) as count FROM component
  `);
  
  // ... assemble and return metrics
}
```

#### Schema Addition for Agent Metrics Tracking

```typescript
// Add to apps/api/src/db/schema.ts

export const agentLogs = pgTable('agent_logs', {
  id: uuid('id').defaultRandom().primaryKey(),
  paperId: uuid('paper_id').references(() => papers.id, { onDelete: 'cascade' }),
  chunkIndex: integer('chunk_index'),
  agent: text('agent').notNull(),             // 'extractor' | 'resolver' | 'validator'
  
  // Performance
  latencyMs: integer('latency_ms'),
  promptTokens: integer('prompt_tokens'),
  completionTokens: integer('completion_tokens'),
  totalTokens: integer('total_tokens'),
  
  // Quality
  entitiesFound: integer('entities_found'),
  relationshipsFound: integer('relationships_found'),
  accepted: integer('accepted'),
  rejected: integer('rejected'),
  
  // Errors
  success: boolean('success').default(true),
  error: text('error'),
  retryCount: integer('retry_count').default(0),
  
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  paperIdIdx: index('agent_logs_paper_id_idx').on(table.paperId),
  agentIdx: index('agent_logs_agent_idx').on(table.agent),
  createdAtIdx: index('agent_logs_created_at_idx').on(table.createdAt),
}));
```

#### Metrics API Endpoints

```typescript
// apps/api/src/routes/metrics.ts

metricsRouter.get('/graph-quality', async (c) => {
  const metrics = await computeGraphQualityMetrics();
  return c.json(metrics);
});

metricsRouter.get('/agent-performance', async (c) => {
  const timeRange = c.req.query('range') || '24h'; // 1h, 24h, 7d, 30d
  const metrics = await computeAgentPerformance(timeRange);
  return c.json(metrics);
});

metricsRouter.get('/cost-breakdown', async (c) => {
  const breakdown = await computeCostBreakdown();
  return c.json(breakdown);
  // Returns: { totalCost, costPerPaper, costByAgent, costTrend[] }
});

metricsRouter.get('/processing-health', async (c) => {
  const health = await computeProcessingHealth();
  return c.json(health);
  // Returns: { backlogSize, avgProcessingTime, failureRate, stuckJobs }
});
```

#### Frontend Observability Page

The Observability page would show:
- **Confidence histogram** — bar chart showing edge confidence distribution
- **Orphan node count** — metric card with trend (should decrease over time)
- **Agent latency chart** — line chart showing p50/p95 latency per agent over time
- **Token usage tracker** — running total with cost estimate
- **Extraction funnel** — "60 extracted → 42 deduplicated → 31 validated → 25 accepted"
- **Processing health** — backlog size, failure rate, stuck jobs

#### Files to Change

| File | Change |
|------|--------|
| `apps/api/src/index.ts` | Mount `metricsRouter` at `/api/metrics` |
| `apps/api/src/services/ollama.ts` | Track token usage in `generateStructuredCompletion()`, return alongside result |
| `apps/api/src/pipeline/processor.ts` | Log agent metrics to `agent_logs` table after each call |
| `apps/api/src/agents/extractor.ts` | Return timing + token usage alongside result |
| `apps/api/src/agents/resolver.ts` | Same |
| `apps/api/src/agents/validator.ts` | Same |
| `apps/web/src/App.tsx` | Add `/observability` route |
| `apps/web/src/lib/api.ts` | Add metrics API methods |

#### Interview Talking Points

- "I track extraction quality as a distribution, not just counts. If the confidence histogram shifts left over time, I know my prompts are degrading."
- "Orphan nodes are a signal of extraction noise — entities that were extracted but never connected to anything. I monitor this to tune the Extractor's recall threshold."
- "Cost attribution per paper lets me forecast API spend as the corpus grows. We know exactly that each paper costs ~$0.15 and each edge costs ~$0.006."
- "The extraction funnel (60 → 42 → 31 → 25) tells me where the pipeline is losing data. If too many relationships are rejected, the Validator is too strict or the Extractor is too noisy."

---

### Task 7.3: Conflict Resolution & Multi-Source Evidence Aggregation

**Size**: L
**Depends on**: Tasks 3.1 (Edge UPSERT), 7.1 (Ontology)

**Why this matters**: When Paper A says "X improves Y" and Paper B says "X doesn't improve Y", what happens? Currently, both edges are created independently. A staff engineer designs a system that **detects, surfaces, and resolves contradictions**.

This is the difference between a pipeline that dumps data and a system that maintains a **consistent, trustworthy knowledge base**.

#### Design

```
Conflict Resolution
├── Contradiction Detection (opposing edges between same entities)
├── Evidence Aggregation (multiple sources → combined confidence)
├── Resolution Strategies (automated rules + human-in-the-loop)
└── Audit Trail (why was this conflict resolved this way?)
```

#### Schema Additions

```typescript
// Add to apps/api/src/db/schema.ts

export const conflictStatusEnum = pgEnum('conflict_status', [
  'detected', 'auto_resolved', 'pending_review', 'manually_resolved', 'dismissed'
]);

export const conflicts = pgTable('conflicts', {
  id: uuid('id').defaultRandom().primaryKey(),
  
  // The conflicting edges
  edgeId1: uuid('edge_id_1').notNull().references(() => edges.id, { onDelete: 'cascade' }),
  edgeId2: uuid('edge_id_2').notNull().references(() => edges.id, { onDelete: 'cascade' }),
  
  // Conflict details
  conflictType: text('conflict_type').notNull(),   // 'contradiction', 'redundancy', 'temporal_inconsistency'
  description: text('description'),                 // Human-readable explanation
  
  // Resolution
  status: conflictStatusEnum('status').default('detected').notNull(),
  resolution: text('resolution'),                   // What was decided
  resolvedBy: text('resolved_by'),                  // 'auto:confidence_rule' or 'user:nikhil'
  winningEdgeId: uuid('winning_edge_id').references(() => edges.id),
  
  createdAt: timestamp('created_at').defaultNow().notNull(),
  resolvedAt: timestamp('resolved_at'),
}, (table) => ({
  statusIdx: index('conflicts_status_idx').on(table.status),
  edge1Idx: index('conflicts_edge1_idx').on(table.edgeId1),
  edge2Idx: index('conflicts_edge2_idx').on(table.edgeId2),
}));
```

#### Conflict Detection Service

```typescript
// apps/api/src/services/conflicts.ts

// Contradiction pairs — if both exist between same entities, it's a conflict
const CONTRADICTING_TYPES: [string, string][] = [
  ['improves', 'degrades'],
  ['extends', 'replaces'],
  ['outperforms', 'underperforms'],
  ['uses', 'avoids'],
];

// Same-direction redundancy — edges that express the same thing differently
const REDUNDANT_TYPES: string[][] = [
  ['extends', 'improves', 'builds_on'],
  ['uses', 'applies', 'leverages'],
];

export async function detectConflicts(paperId: string): Promise<Conflict[]> {
  const conflicts: Conflict[] = [];
  
  // Find all edges added by this paper
  const paperEdges = await db
    .select({ edge: edges, source: sources })
    .from(edges)
    .innerJoin(sources, eq(sources.edgeId, edges.id))
    .where(eq(sources.paperId, paperId));
  
  for (const { edge } of paperEdges) {
    // Check for contradictions: existing edge between same nodes with opposing type
    for (const [type1, type2] of CONTRADICTING_TYPES) {
      if (edge.type !== type1 && edge.type !== type2) continue;
      
      const oppositeType = edge.type === type1 ? type2 : type1;
      const contradicting = await db.select().from(edges).where(
        and(
          eq(edges.sourceId, edge.sourceId),
          eq(edges.targetId, edge.targetId),
          eq(edges.type, oppositeType as any)
        )
      );
      
      if (contradicting.length > 0) {
        conflicts.push({
          edgeId1: edge.id,
          edgeId2: contradicting[0].id,
          conflictType: 'contradiction',
          description: `"${edge.type}" contradicts "${contradicting[0].type}" between same entities`,
        });
      }
    }
    
    // Check for temporal inconsistency
    // e.g., Paper from 2020 claims to "extend" a method from 2024
    // (handled by looking up source paper dates)
  }
  
  return conflicts;
}
```

#### Multi-Source Evidence Aggregation

```typescript
// apps/api/src/services/evidence.ts

export interface AggregatedEvidence {
  edgeId: string;
  sourceCount: number;              // How many papers support this edge
  papers: Array<{
    paperId: string;
    title: string;
    section: string;
    extractedText: string;
    confidence: number;
  }>;
  aggregatedConfidence: number;     // Combined confidence from all sources
  consensusStrength: 'strong' | 'moderate' | 'weak' | 'contested';
}

export function aggregateConfidence(sources: { confidence: number }[]): {
  aggregated: number;
  strength: string;
} {
  if (sources.length === 0) return { aggregated: 0, strength: 'weak' };
  
  // Weighted aggregation: more sources = higher confidence, but with diminishing returns
  // P(at least one correct) = 1 - ∏(1 - p_i)
  const combined = 1 - sources.reduce((product, s) => product * (1 - s.confidence), 1);
  
  // Consensus strength based on source count and agreement
  const avgConfidence = sources.reduce((sum, s) => sum + s.confidence, 0) / sources.length;
  const strength = sources.length >= 3 && avgConfidence > 0.7 ? 'strong'
    : sources.length >= 2 && avgConfidence > 0.5 ? 'moderate'
    : sources.length === 1 ? 'weak'
    : 'contested';
  
  return { aggregated: Math.min(combined, 0.99), strength };
}
```

#### Auto-Resolution Rules

```typescript
// apps/api/src/services/conflicts.ts

export async function autoResolveConflict(conflict: Conflict): Promise<boolean> {
  const edge1 = await getEdgeWithSources(conflict.edgeId1);
  const edge2 = await getEdgeWithSources(conflict.edgeId2);
  
  // Rule 1: More sources wins
  if (edge1.sources.length > edge2.sources.length * 2) {
    return resolve(conflict, edge1.id, 'auto:source_count');
  }
  
  // Rule 2: Higher aggregate confidence wins (if significant gap)
  const conf1 = aggregateConfidence(edge1.sources);
  const conf2 = aggregateConfidence(edge2.sources);
  if (conf1.aggregated - conf2.aggregated > 0.3) {
    return resolve(conflict, edge1.id, 'auto:confidence_gap');
  }
  
  // Rule 3: More recent paper wins for temporal disputes
  if (conflict.conflictType === 'temporal_inconsistency') {
    const newer = edge1.latestPaperDate > edge2.latestPaperDate ? edge1 : edge2;
    return resolve(conflict, newer.id, 'auto:recency');
  }
  
  // Can't auto-resolve — escalate to human review
  await db.update(conflicts)
    .set({ status: 'pending_review' })
    .where(eq(conflicts.id, conflict.id));
  return false;
}
```

#### Conflict Review API

```typescript
// New endpoints in apps/api/src/routes/conflicts.ts

conflictsRouter.get('/', async (c) => {
  const status = c.req.query('status') || 'pending_review';
  // List conflicts needing review
});

conflictsRouter.post('/:id/resolve', async (c) => {
  const { winningEdgeId, reason } = await c.req.json();
  // Human resolves conflict, marks losing edge as superseded
});

conflictsRouter.post('/:id/dismiss', async (c) => {
  // Both edges can coexist (legitimate disagreement in literature)
});
```

#### Interview Talking Points

- "In a knowledge graph populated by AI, conflicts are inevitable. I designed a three-tier resolution strategy: auto-resolve obvious cases (95%), surface ambiguous ones for human review (4%), and allow legitimate disagreements to coexist (1%)."
- "Evidence aggregation uses probabilistic combination — if three independent papers all say 'X improves Y' with confidence 0.7, the aggregate is 0.97, not 0.7. This models independent confirmation."
- "The conflict detection runs as a post-processing hook after each paper. It checks for contradictions, temporal inconsistencies, and redundancies."
- "Every resolution has an audit trail — who resolved it (auto or human), why, and when. This is critical for a system where AI-generated data feeds into research decisions."

---

### Task 7.4: Temporal Modeling & Graph Evolution

**Size**: L
**Depends on**: Tasks 1.1 (Domain Generalization), 7.1 (Ontology)

**Why this matters**: Knowledge graphs aren't static. "State-of-the-art" in 2020 isn't SOTA in 2025. Methods get superseded. Datasets become deprecated. A staff engineer models **time as a first-class dimension** of the graph.

#### Design

```
Temporal Model
├── Validity Windows (edges are true within a time range)
├── Temporal Queries ("what was SOTA in 2022?")
├── Evolution Tracking (how has a concept's connections changed?)
├── Deprecation Detection (auto-detect superseded methods)
└── Timeline Visualization (frontend)
```

#### Schema Changes

```typescript
// Add temporal columns to edges table in apps/api/src/db/schema.ts

validFrom: date('valid_from'),          // When this relationship became true
validUntil: date('valid_until'),        // When it stopped being true (null = still valid)
temporalContext: text('temporal_context'), // "as of 2023", "until superseded by X"

// Add to nodes table:
firstMentioned: date('first_mentioned'),  // Earliest paper that mentions this entity
lastMentioned: date('last_mentioned'),    // Most recent paper
status: text('status').default('active'), // 'active' | 'deprecated' | 'superseded'
supersededBy: uuid('superseded_by').references(() => nodes.id),
```

#### Temporal Query API

```typescript
// apps/api/src/routes/temporal.ts

// "What was the state of the art in 2022?"
temporalRouter.get('/snapshot', async (c) => {
  const date = c.req.query('date');  // "2022-06-01"
  
  // Return nodes and edges that were valid at this date
  const validNodes = await db.select().from(nodes)
    .where(and(
      lte(nodes.firstMentioned, date),
      or(isNull(nodes.lastMentioned), gte(nodes.lastMentioned, date))
    ));
  
  const validEdges = await db.select().from(edges)
    .where(and(
      or(isNull(edges.validFrom), lte(edges.validFrom, date)),
      or(isNull(edges.validUntil), gte(edges.validUntil, date))
    ));
  
  return c.json({ nodes: validNodes, edges: validEdges, asOf: date });
});

// "How has 3D Gaussian Splatting evolved over time?"
temporalRouter.get('/evolution/:nodeId', async (c) => {
  const nodeId = c.req.param('nodeId');
  
  // Get all edges involving this node, grouped by time period
  const timeline = await db.execute(sql`
    SELECT 
      DATE_TRUNC('quarter', p.publication_date) as period,
      e.type,
      COUNT(*) as relationship_count,
      AVG(e.confidence::numeric) as avg_confidence,
      ARRAY_AGG(DISTINCT target_nodes.name) as connected_entities
    FROM edges e
    JOIN sources s ON s.edge_id = e.id
    JOIN papers p ON s.paper_id = p.id
    JOIN nodes target_nodes ON e.target_id = target_nodes.id
    WHERE e.source_id = ${nodeId} OR e.target_id = ${nodeId}
    GROUP BY period, e.type
    ORDER BY period
  `);
  
  return c.json({ nodeId, timeline });
});

// "What methods have been superseded?"
temporalRouter.get('/deprecated', async (c) => {
  const deprecated = await db.select({
    node: nodes,
    supersededBy: sql`superseding.name`,
    lastPaper: sql`(SELECT MAX(p.publication_date) FROM sources s 
                    JOIN papers p ON s.paper_id = p.id 
                    JOIN edges e ON s.edge_id = e.id 
                    WHERE e.source_id = nodes.id OR e.target_id = nodes.id)`,
  }).from(nodes)
    .leftJoin(sql`nodes superseding`, sql`nodes.superseded_by = superseding.id`)
    .where(eq(nodes.status, 'superseded'));
  
  return c.json(deprecated);
});
```

#### Deprecation Detection

```typescript
// apps/api/src/services/temporal.ts

export async function detectDeprecations(): Promise<void> {
  // Heuristic: If a method hasn't been mentioned in papers 
  // from the last 2 years but was active before, mark as potentially deprecated
  const cutoffDate = new Date();
  cutoffDate.setFullYear(cutoffDate.getFullYear() - 2);
  
  const candidates = await db.execute(sql`
    SELECT n.id, n.name, n.type, n.last_mentioned,
           COUNT(e.id) as total_edges,
           COUNT(e.id) FILTER (WHERE p.publication_date > ${cutoffDate}) as recent_edges
    FROM nodes n
    LEFT JOIN edges e ON e.source_id = n.id OR e.target_id = n.id
    LEFT JOIN sources s ON s.edge_id = e.id
    LEFT JOIN papers p ON s.paper_id = p.id
    WHERE n.type IN ('method', 'model')
      AND n.status = 'active'
      AND n.first_mentioned < ${cutoffDate}
    GROUP BY n.id
    HAVING COUNT(e.id) FILTER (WHERE p.publication_date > ${cutoffDate}) = 0
  `);
  
  // Mark candidates as potentially deprecated
  // Check if there's a successor (entity connected via "supersedes" or "replaces")
  for (const candidate of candidates) {
    const successor = await db.select().from(edges)
      .where(and(
        eq(edges.targetId, candidate.id),
        inArray(edges.type, ['replaces', 'supersedes'])
      )).limit(1);
    
    if (successor.length > 0) {
      await db.update(nodes).set({
        status: 'superseded',
        supersededBy: successor[0].sourceId,
      }).where(eq(nodes.id, candidate.id));
    }
  }
}
```

#### Interview Talking Points

- "Relationships have validity windows. 'NeRF is state-of-the-art' was true in 2020 but not in 2024. Without temporal modeling, the graph can't distinguish current truth from historical fact."
- "The `/snapshot` endpoint lets you query the graph at any point in time — like `git checkout` for knowledge. This is essential for longitudinal research analysis."
- "Deprecation detection runs as a background job. If a method hasn't been cited in 2+ years but was previously active, we flag it. If something explicitly supersedes it, we link them."
- "The evolution timeline shows how a concept's graph neighborhood has changed — new connections appearing, old ones fading. This is a unique feature you can't get from search engines."

---

### Task 7.5: Distributed Tracing with OpenTelemetry

**Size**: M
**Depends on**: Tasks 2.3 (BullMQ), 7.2 (Agent Metrics)

**Why this matters**: When a paper takes 8 minutes instead of 3, where is the time going? When an extraction fails silently, which agent caused it? Without distributed tracing, debugging a multi-agent pipeline is like debugging a distributed system with `console.log`.

A staff engineer instruments the system so that every request can be traced end-to-end.

#### Design

```
Trace: "Process Paper 2308.04079"
├── Span: "Download PDF" (2.1s)
├── Span: "Extract Text" (0.8s)
├── Span: "Chunk Text" (0.01s, 46 chunks)
├── Span: "Process Batch 1" (12.3s)
│   ├── Span: "Extractor Agent - Chunk 0" (3.2s, 580 tokens)
│   ├── Span: "Extractor Agent - Chunk 1" (2.8s, 520 tokens)  ← parallel
│   ├── Span: "Extractor Agent - Chunk 2" (3.1s, 550 tokens)  ← parallel
│   ├── Span: "Resolver Agent - Batch" (4.5s)
│   ├── Span: "Validator Agent - Batch" (3.8s)
│   └── Span: "DB Insert - 8 nodes, 5 edges" (0.1s)
├── Span: "Process Batch 2" ...
└── Span: "Mark Complete" (0.01s)
```

#### New Files

| File | Purpose |
|------|---------|
| `apps/api/src/telemetry/tracing.ts` | OpenTelemetry setup, tracer initialization |
| `apps/api/src/telemetry/middleware.ts` | Hono middleware for automatic HTTP span creation |

#### Tracing Setup

```typescript
// apps/api/src/telemetry/tracing.ts
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { trace, SpanStatusCode, Span } from '@opentelemetry/api';

const sdk = new NodeSDK({
  resource: new Resource({ 'service.name': 'knowledge-graph-api' }),
  traceExporter: new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318/v1/traces',
  }),
});

sdk.start();

export const tracer = trace.getTracer('knowledge-graph');

// Helper: wrap an async function in a span
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    try {
      for (const [key, value] of Object.entries(attributes)) {
        span.setAttribute(key, value);
      }
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      span.recordException(error as Error);
      throw error;
    } finally {
      span.end();
    }
  });
}
```

#### Instrumented Pipeline

```typescript
// In processor.ts, wrap each stage:

export async function processPaper(paperId: string) {
  return withSpan('process_paper', { 'paper.id': paperId }, async (rootSpan) => {
    
    // Each agent call gets its own span
    const extractorOutput = await withSpan('agent.extractor', {
      'chunk.index': i,
      'chunk.section': section,
      'chunk.length': chunk.length,
    }, async (span) => {
      const result = await extractEntitiesAndRelationships(input);
      span.setAttribute('entities.count', result.entities.length);
      span.setAttribute('relationships.count', result.relationships.length);
      return result;
    });
    
    // LLM calls get spans with token usage
    // DB operations get spans with row counts
    // Each batch gets a parent span grouping its children
  });
}
```

#### Instrumented LLM Calls

```typescript
// In services/ollama.ts, wrap generateCompletion:

export async function generateCompletion(systemPrompt: string, userPrompt: string, temperature: number) {
  return withSpan('llm.completion', {
    'llm.provider': provider,
    'llm.model': provider === 'openai' ? openaiModel : ollamaModel,
    'llm.temperature': temperature,
    'prompt.system_length': systemPrompt.length,
    'prompt.user_length': userPrompt.length,
  }, async (span) => {
    const startTime = Date.now();
    const result = await /* ... existing fetch logic ... */;
    
    span.setAttribute('llm.latency_ms', Date.now() - startTime);
    span.setAttribute('llm.prompt_tokens', result.usage?.promptTokens || 0);
    span.setAttribute('llm.completion_tokens', result.usage?.completionTokens || 0);
    span.setAttribute('llm.total_tokens', result.usage?.totalTokens || 0);
    
    return result;
  });
}
```

#### Docker Compose Addition

```yaml
# Add Jaeger for local trace visualization
jaeger:
  image: jaegertracing/all-in-one:latest
  container_name: gsplat-kg-jaeger
  ports:
    - "16686:16686"    # Jaeger UI
    - "4318:4318"      # OTLP HTTP receiver
  environment:
    - COLLECTOR_OTLP_ENABLED=true
```

#### Files to Change

| File | Change |
|------|--------|
| `apps/api/package.json` | Add `@opentelemetry/sdk-node`, `@opentelemetry/api`, `@opentelemetry/exporter-trace-otlp-http` |
| `apps/api/src/index.ts` | Initialize tracing before server start |
| `apps/api/src/pipeline/processor.ts` | Wrap each pipeline stage in `withSpan()` |
| `apps/api/src/services/ollama.ts` | Wrap LLM calls in `withSpan()` with token metrics |
| `apps/api/src/agents/extractor.ts` | Add span attributes for extraction stats |
| `apps/api/src/agents/resolver.ts` | Add span attributes for resolution stats |
| `apps/api/src/agents/validator.ts` | Add span attributes for validation stats |
| `docker-compose.yml` | Add Jaeger service |

#### Interview Talking Points

- "Every paper processing run generates a trace. When processing takes 8 minutes instead of 3, I can see exactly which chunk and which agent call was slow — down to the individual LLM request."
- "Token usage is tracked per-span. I can tell you that the Resolver uses 3x more tokens than the Extractor because it includes the existing node list in its prompt."
- "Traces propagate through the queue — the API request that enqueued the job shares a trace ID with the worker that processed it. This connects the user's action to the eventual result."
- "In production, I'd send these to Datadog or Grafana Tempo. Locally, Jaeger gives the same waterfall view at http://localhost:16686."

---

### Task 7.6: Human-in-the-Loop Review Queue

**Size**: M
**Depends on**: Tasks 7.2 (Metrics), 7.3 (Conflicts)

**Why this matters**: AI extraction is never 100% correct. A staff engineer builds a system where humans can **efficiently review and correct** AI-generated data, and those corrections feed back into improved extraction.

This closes the loop between AI and human expertise.

#### Design

```
Review Queue
├── Flagged Items (low confidence edges, detected conflicts, orphan nodes)
├── Review Interface (approve, reject, edit, merge)
├── Feedback Loop (corrections inform future extraction)
└── Review Metrics (how much human effort is needed?)
```

#### Schema Addition

```typescript
// Add to apps/api/src/db/schema.ts

export const reviewStatusEnum = pgEnum('review_status', [
  'pending', 'approved', 'rejected', 'edited', 'merged'
]);

export const reviewQueue = pgTable('review_queue', {
  id: uuid('id').defaultRandom().primaryKey(),
  
  // What needs review
  itemType: text('item_type').notNull(),       // 'edge', 'node', 'conflict', 'merge_candidate'
  itemId: uuid('item_id').notNull(),            // ID of the edge/node/conflict
  
  // Why it needs review
  reason: text('reason').notNull(),             // 'low_confidence', 'conflict', 'orphan', 'new_type'
  priority: integer('priority').default(0),      // Higher = more urgent
  context: jsonb('context'),                     // Additional context for the reviewer
  
  // Review result
  status: reviewStatusEnum('status').default('pending').notNull(),
  reviewedBy: text('reviewed_by'),
  reviewNote: text('review_note'),
  correction: jsonb('correction'),              // What was changed (for feedback loop)
  
  createdAt: timestamp('created_at').defaultNow().notNull(),
  reviewedAt: timestamp('reviewed_at'),
}, (table) => ({
  statusIdx: index('review_queue_status_idx').on(table.status),
  priorityIdx: index('review_queue_priority_idx').on(table.priority),
  itemTypeIdx: index('review_queue_item_type_idx').on(table.itemType),
}));
```

#### Auto-Queue Rules

```typescript
// apps/api/src/services/review.ts

export async function queueForReview(paperId: string): Promise<void> {
  // Rule 1: Low-confidence edges (0.4 - 0.6 range — uncertain enough to check)
  const uncertainEdges = await db.select().from(edges)
    .innerJoin(sources, eq(sources.edgeId, edges.id))
    .where(and(
      eq(sources.paperId, paperId),
      sql`${edges.confidence}::numeric BETWEEN 0.4 AND 0.6`
    ));
  
  for (const edge of uncertainEdges) {
    await db.insert(reviewQueue).values({
      itemType: 'edge',
      itemId: edge.edges.id,
      reason: 'low_confidence',
      priority: 1,
      context: { confidence: edge.edges.confidence, type: edge.edges.type },
    });
  }
  
  // Rule 2: Orphan nodes (extracted but never connected)
  const orphans = await db.execute(sql`
    SELECT n.id FROM nodes n
    WHERE n.paper_id = ${paperId}
      AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.source_id = n.id OR e.target_id = n.id)
  `);
  
  for (const orphan of orphans) {
    await db.insert(reviewQueue).values({
      itemType: 'node',
      itemId: orphan.id,
      reason: 'orphan',
      priority: 0,
    });
  }
  
  // Rule 3: Detected conflicts (from Task 7.3)
  const newConflicts = await detectConflicts(paperId);
  for (const conflict of newConflicts) {
    await db.insert(reviewQueue).values({
      itemType: 'conflict',
      itemId: conflict.id,
      reason: 'conflict',
      priority: 2, // Conflicts are higher priority
    });
  }
}
```

#### Review API

```typescript
// apps/api/src/routes/review.ts

reviewRouter.get('/', async (c) => {
  const status = c.req.query('status') || 'pending';
  const limit = parseInt(c.req.query('limit') || '20');
  // List review items, ordered by priority DESC, createdAt ASC
});

reviewRouter.get('/:id', async (c) => {
  // Get review item with full context (edge + source nodes + provenance + similar edges)
});

reviewRouter.post('/:id/approve', async (c) => {
  // Mark as approved, optionally adjust confidence
});

reviewRouter.post('/:id/reject', async (c) => {
  // Delete the edge/node, log the correction for feedback
});

reviewRouter.post('/:id/edit', async (c) => {
  // Update the edge/node with corrected data, log what changed
});

reviewRouter.get('/stats', async (c) => {
  // Review queue health: pending count, avg review time, approval rate
});
```

#### Frontend Review Page

```typescript
// apps/web/src/pages/Review.tsx
// New page: /review

// Card-based review interface:
// [Edge Card]
//   Source: "Mip-Splatting" (method)
//   → improves →
//   Target: "3D Gaussian Splatting" (method)
//   Confidence: 0.52
//   Evidence: "We build upon the original 3DGS framework..."
//   
//   [Approve] [Edit] [Reject] [Skip]
```

#### Feedback Loop

```typescript
// When a human rejects or edits an extraction, log the correction
// This data can be used to:
// 1. Fine-tune prompts ("these entity types are often confused")
// 2. Adjust confidence thresholds
// 3. Train a custom classifier for common error patterns

export async function logCorrection(reviewItem: ReviewQueueItem, action: string, correction?: any): Promise<void> {
  // Store in corrections table for future analysis
  await db.insert(corrections).values({
    originalItemType: reviewItem.itemType,
    originalItemId: reviewItem.itemId,
    action,                          // 'rejected', 'edited', 'merged'
    correction,                      // What changed
    agentResponsible: reviewItem.context?.agent || 'unknown', // Which agent made the mistake
    errorPattern: classifyError(reviewItem, correction),       // 'wrong_type', 'hallucinated_entity', etc.
  });
}
```

#### Interview Talking Points

- "AI extraction is probabilistic. I designed a review queue that prioritizes uncertain edges (confidence 0.4-0.6) and detected conflicts. This focuses human attention where it matters most."
- "Every human correction is logged as structured feedback — which agent made the mistake, what kind of error it was. Over time, this data shows us exactly where to improve our prompts."
- "The review interface shows the source evidence alongside the extracted relationship, so reviewers can verify in 5 seconds instead of re-reading the paper."
- "Review metrics track how much human effort the system requires. If 95% of edges are auto-approved, we're at the right confidence threshold. If it drops to 80%, something changed."

---

## Dependency Graph

```
PHASE 0 (bugs — all parallel, do first):
  [0.1 Fix reprocessPaper]  [0.2 Fix N+1]  [0.3 Cache existingNodes]  [0.4 Pool config]
        |                                         |
        |                                         |
PHASE 1 (foundation):                             |
  [1.1 Domain Generalization] ←────────────────── | ── can parallel with Phase 2
        |                                         |
        |                                         |
PHASE 2 (infrastructure):                         |
  [2.1 Zod Validation]                            |
        |                                         |
  [2.2 Persistent Job Status]               [2.5 Parallel Chunks] ← needs 0.3
        |
  [2.3 BullMQ + Redis]
        |
  [2.4 SSE]


PHASE 3 (data quality):
  [3.1 Edge UPSERT]          ← independent
  [3.2 Persist EntityMap]    ← needs 2.3
  [3.3 pgvector Dedup]       ← needs 1.1
  [3.4 Incremental Reprocess]← needs 0.1


PHASE 4 (frontend — all parallel, any time):
  [4.1 Force Layout]  [4.2 Confidence Filter]  [4.3 Error Boundaries]


PHASE 5 (hardening):
  [5.1 Rate Limiting]        ← independent
  [5.2 Batch OpenAI]         ← needs 2.3


PHASE 6 (testing — start after 2.1, grow over time):
  [6.1 Automated Tests]      ← needs 2.1, 0.1, 0.2


PHASE 7 (staff-level — builds on everything):
  [7.1 Ontology]             ← needs 1.1
        |
  [7.2 Observability]        ← needs 2.4, 3.1
        |
  [7.3 Conflict Resolution]  ← needs 3.1, 7.1
        |
  [7.4 Temporal Modeling]     ← needs 1.1, 7.1
        |
  [7.5 OpenTelemetry]        ← needs 2.3, 7.2
        |
  [7.6 Review Queue]         ← needs 7.2, 7.3
```

```
PHASE 0 (bugs — all parallel, do first):
  [0.1 Fix reprocessPaper]  [0.2 Fix N+1]  [0.3 Cache existingNodes]  [0.4 Pool config]
        |                                         |
        |                                         |
PHASE 1 (foundation):                             |
  [1.1 Domain Generalization] ←────────────────── | ── can parallel with Phase 2
        |                                         |
        |                                         |
PHASE 2 (infrastructure):                         |
  [2.1 Zod Validation]                            |
        |                                         |
  [2.2 Persistent Job Status]               [2.5 Parallel Chunks] ← needs 0.3
        |
  [2.3 BullMQ + Redis]
        |
  [2.4 SSE]


PHASE 3 (data quality):
  [3.1 Edge UPSERT]          ← independent
  [3.2 Persist EntityMap]    ← needs 2.3
  [3.3 pgvector Dedup]       ← needs 1.1
  [3.4 Incremental Reprocess]← needs 0.1


PHASE 4 (frontend — all parallel, any time):
  [4.1 Force Layout]  [4.2 Confidence Filter]  [4.3 Error Boundaries]


PHASE 5 (hardening):
  [5.1 Rate Limiting]        ← independent
  [5.2 Batch OpenAI]         ← needs 2.3


PHASE 6 (testing — start after 2.1, grow over time):
  [6.1 Automated Tests]      ← needs 2.1, 0.1, 0.2
```

---

## Critical Files Map

Files ordered by how many tasks touch them:

| File | Tasks | Notes |
|------|-------|-------|
| `apps/api/src/pipeline/processor.ts` | 0.1, 0.3, 1.1, 2.3, 2.5, 3.1, 3.2, 3.3, 3.4, 5.2, 7.1, 7.2, 7.5 | **13 tasks** — plan changes carefully |
| `apps/api/src/db/schema.ts` | 1.1, 2.2, 3.1, 3.2, 3.3, 3.4, 7.1, 7.2, 7.3, 7.4, 7.6 | **11 tasks** — schema migrations |
| `apps/api/src/index.ts` | 1.1, 2.3, 2.4, 5.1, 7.2, 7.5 | **6 tasks** |
| `apps/api/src/services/ollama.ts` | 7.2, 7.5 | **2 tasks** + LLM metrics instrumentation |
| `apps/api/src/routes/ingest.ts` | 1.1, 2.2, 2.3, 5.2 | **4 tasks** |
| `apps/web/src/pages/Explorer.tsx` | 1.1, 4.1, 4.2, 4.3 | **4 tasks** |
| `apps/web/src/App.tsx` | 4.3, 7.2, 7.6 | **3 tasks** — new routes |
| `apps/api/src/agents/extractor.ts` | 1.1, 2.1, 7.2, 7.5 | **4 tasks** |
| `apps/api/src/agents/resolver.ts` | 1.1, 2.1, 7.2, 7.5 | **4 tasks** |
| `apps/api/src/agents/validator.ts` | 1.1, 2.1, 7.2, 7.5 | **4 tasks** |
| `apps/api/src/routes/graph.ts` | 0.2, 1.1 | **2 tasks** |
| `docker-compose.yml` | 2.3, 3.3, 7.5 | **3 tasks** — Redis, pgvector, Jaeger |

---

## Recommended Implementation Order

Optimal sequencing considering dependencies, risk, and parallel opportunities:

| Order | Task | Size | Parallel With |
|-------|------|------|---------------|
| 1 | 0.1 Fix reprocessPaper bug | S | 0.2, 0.3, 0.4 |
| 2 | 0.2 Fix N+1 query | S | 0.1, 0.3, 0.4 |
| 3 | 0.3 Cache existingNodes | S | 0.1, 0.2, 0.4 |
| 4 | 0.4 Connection pooling | S | 0.1, 0.2, 0.3 |
| 5 | 2.1 Zod validation | M | 1.1, 4.1, 4.2, 4.3 |
| 6 | 1.1 Domain generalization | L | 2.1, 4.1, 4.2, 4.3 |
| 7 | 3.1 Edge UPSERT | S | 1.1 |
| 8 | 4.1 Force-directed layout | M | 1.1, 2.1 |
| 9 | 4.2 Confidence filtering | S | 4.1, 4.3 |
| 10 | 4.3 Error boundaries | S | 4.1, 4.2 |
| 11 | 2.2 Persistent job status | M | — |
| 12 | 2.5 Parallel chunk processing | M | 2.2 |
| 13 | 2.3 BullMQ + Redis | M | — |
| 14 | 2.4 SSE | M | — |
| 15 | 3.2 Persist entityMap | M | — |
| 16 | 3.4 Incremental reprocessing | M | 3.2 |
| 17 | 5.1 Rate limiting | S | 3.4 |
| 18 | 3.3 pgvector semantic dedup | L | — |
| 19 | 5.2 Batch OpenAI | M | 3.3 |
| 20 | 6.1 Automated tests | L | Start early, grow incrementally |
| 21 | 7.1 Ontology management | L | — |
| 22 | 7.2 Observability dashboard | L | 7.1 |
| 23 | 7.3 Conflict resolution | L | 7.1, 7.2 |
| 24 | 7.4 Temporal modeling | L | 7.1 |
| 25 | 7.5 OpenTelemetry tracing | M | 7.2 |
| 26 | 7.6 Human-in-the-loop review | M | 7.2, 7.3 |

---

## New Dependencies to Add

| Package | Where | Task |
|---------|-------|------|
| `bullmq` | `apps/api` | 2.3 |
| `ioredis` | `apps/api` | 2.3 |
| `d3-force` | `apps/web` | 4.1 |
| `@types/d3-force` | `apps/web` | 4.1 |
| `hono-rate-limiter` | `apps/api` | 5.1 |
| `vitest` | `apps/api` | 6.1 |
| `supertest` | `apps/api` | 6.1 |
| `@types/supertest` | `apps/api` | 6.1 |
| `@opentelemetry/sdk-node` | `apps/api` | 7.5 |
| `@opentelemetry/api` | `apps/api` | 7.5 |
| `@opentelemetry/exporter-trace-otlp-http` | `apps/api` | 7.5 |
| `recharts` | `apps/web` | 7.2 (observability charts) |

---

## Environment Variables to Add

| Variable | Default | Task | Purpose |
|----------|---------|------|---------|
| `REDIS_URL` | `redis://localhost:6379` | 2.3 | Redis connection for BullMQ |
| `DB_POOL_MAX` | `20` | 0.4 | Max database connections |
| `DB_IDLE_TIMEOUT` | `20` | 0.4 | Idle connection timeout (seconds) |
| `DB_CONNECT_TIMEOUT` | `10` | 0.4 | Connection timeout (seconds) |
| `DB_MAX_LIFETIME` | `1800` | 0.4 | Max connection lifetime (seconds) |
| `WORKER_CONCURRENCY` | `2` | 2.3 | Parallel paper processing workers |
| `BATCH_CHUNK_SIZE` | `4` | 2.5 | Chunks to extract in parallel |
| `DEFAULT_DOMAIN` | `gaussian-splatting` | 1.1 | Default domain when not specified |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318/v1/traces` | 7.5 | OpenTelemetry collector endpoint |
| `OTEL_ENABLED` | `false` | 7.5 | Enable/disable tracing |
| `REVIEW_AUTO_QUEUE_THRESHOLD` | `0.6` | 7.6 | Confidence below this triggers review |

---

## Docker Compose Changes

```yaml
# Final docker-compose.yml with all additions:
services:
  postgres:
    image: pgvector/pgvector:pg16    # Changed from postgres:16 (Task 3.3)
    # ... existing config ...

  redis:                              # New (Task 2.3)
    image: redis:7-alpine
    container_name: gsplat-kg-redis
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data
    restart: unless-stopped

  jaeger:                             # New (Task 7.5)
    image: jaegertracing/all-in-one:latest
    container_name: gsplat-kg-jaeger
    ports:
      - "16686:16686"                 # Jaeger UI
      - "4318:4318"                   # OTLP HTTP receiver
    environment:
      - COLLECTOR_OTLP_ENABLED=true
    restart: unless-stopped

volumes:
  postgres_data:
  redis_data:                         # New
```

---

## Summary

| Phase | Tasks | Total Size | Key Outcome |
|-------|-------|------------|-------------|
| 0 | 4 | 4×S | Correct behavior, no bugs |
| 1 | 1 | 1×L | Domain-agnostic platform |
| 2 | 5 | 5×M | Production infrastructure |
| 3 | 4 | 2×M + 1×L + 1×S | Data integrity and quality |
| 4 | 3 | 1×M + 2×S | Polished user experience |
| 5 | 2 | 1×S + 1×M | API security and cost optimization |
| 6 | 1 | 1×L | Test coverage and confidence |
| 7 | 6 | 4×L + 2×M | **Staff-level engineering** |
| **Total** | **26** | **5S + 10M + 8L** | **Staff-level knowledge graph platform** |

---

## What Phase 7 Signals in an Interview

Phase 7 is what turns "I built a knowledge graph" into "I designed a knowledge graph **platform**." Here's the difference:

| Senior Engineer | Staff Engineer (Phase 7) |
|----------------|--------------------------|
| Builds the extraction pipeline | Builds the ontology layer so the pipeline adapts to any domain (7.1) |
| Counts nodes and edges | Monitors extraction quality, cost attribution, and confidence calibration (7.2) |
| Inserts what the AI extracts | Detects contradictions and aggregates multi-source evidence (7.3) |
| Stores relationships as facts | Models relationships as temporally-scoped assertions (7.4) |
| Debugs with `console.log` | Instruments with distributed tracing so any 8-minute paper is diagnosable (7.5) |
| Trusts AI output | Builds a human-in-the-loop review queue with feedback loops (7.6) |

### Key Interview Narratives

**"I think about knowledge as assertions, not facts."**
Every edge in the graph is an assertion made by a specific paper at a specific time with a specific confidence. The temporal model (7.4) and conflict resolution (7.3) treat knowledge as evolving and potentially contradictory — not as a static truth database.

**"I design for the operator, not just the user."**
The observability dashboard (7.2) and OpenTelemetry tracing (7.5) aren't user-facing features. They're for the engineer running the system. A staff engineer builds the tools to know if the system is healthy, not just functional.

**"I close feedback loops."**
The review queue (7.6) doesn't just let humans correct AI mistakes — it logs corrections as structured feedback that can improve future extraction. This is the difference between a pipeline and a learning system.

**"I separate domain knowledge from application logic."**
The ontology layer (7.1) means adding support for NLP papers, biology papers, or any domain is a configuration change — not a code change. The type hierarchy enables polymorphic queries. Schema versioning means the ontology can evolve without breaking existing data.

### New Files Summary (Phase 7)

| File | Task |
|------|------|
| `apps/api/src/ontology/types.ts` | 7.1 |
| `apps/api/src/ontology/validator.ts` | 7.1 |
| `apps/api/src/ontology/registry.ts` | 7.1 |
| `apps/api/src/services/metrics.ts` | 7.2 |
| `apps/api/src/routes/metrics.ts` | 7.2 |
| `apps/web/src/pages/Observability.tsx` | 7.2 |
| `apps/api/src/services/conflicts.ts` | 7.3 |
| `apps/api/src/services/evidence.ts` | 7.3 |
| `apps/api/src/routes/conflicts.ts` | 7.3 |
| `apps/api/src/routes/temporal.ts` | 7.4 |
| `apps/api/src/services/temporal.ts` | 7.4 |
| `apps/api/src/telemetry/tracing.ts` | 7.5 |
| `apps/api/src/telemetry/middleware.ts` | 7.5 |
| `apps/api/src/services/review.ts` | 7.6 |
| `apps/api/src/routes/review.ts` | 7.6 |
| `apps/web/src/pages/Review.tsx` | 7.6 |

### New DB Tables (Phase 7)

| Table | Task | Purpose |
|-------|------|---------|
| `ontology_versions` | 7.1 | Schema versioning for type hierarchies |
| `agent_logs` | 7.2 | Per-call metrics: latency, tokens, errors |
| `conflicts` | 7.3 | Detected contradictions between edges |
| `review_queue` | 7.6 | Items needing human review |
| `corrections` | 7.6 | Human corrections for feedback loop |
