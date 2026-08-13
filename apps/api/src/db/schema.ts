import { pgTable, uuid, text, timestamp, boolean, integer, decimal, jsonb, date, pgEnum, primaryKey, index, vector } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { VECTOR_DIMENSIONS } from '../services/embedding-space';

// Node and edge `type` columns are intentionally free-form `text` (not pgEnum):
// the extractor can discover new entity/relationship types and they are stored
// without an `ALTER TYPE` migration. `KNOWN_NODE_TYPES`/`KNOWN_EDGE_TYPES` in the
// shared package are the well-known defaults used for UI seeding, not a constraint.

export const processingStatusEnum = pgEnum('processing_status', [
  'pending',
  'downloading_pdf',
  'extracting_text',
  'chunking',
  'extracting_entities',
  'resolving_entities',
  'validating',
  // Stopped between chunks at an operator's request. Distinct from 'failed':
  // nothing went wrong, and the checkpoint means resuming costs nothing.
  'paused',
  'completed',
  'failed'
]);

export const jobStatusEnum = pgEnum('job_status', [
  'queued',
  'fetching_metadata',
  'downloading_pdf',
  'extracting_text',
  'processing',
  // Parked by an operator. Terminal for the queue (nothing claims it) but not a
  // failure — the checkpoint is intact and resuming re-queues it for free.
  'paused',
  'completed',
  'failed'
]);

export const papers = pgTable('papers', {
  id: uuid('id').defaultRandom().primaryKey(),
  title: text('title').notNull(),
  abstract: text('abstract'),
  arxivId: text('arxiv_id').unique(),
  doi: text('doi'),
  pdfUrl: text('pdf_url'),
  publicationDate: date('publication_date'),
  venue: text('venue'),
  domain: text('domain'),
  rawText: text('raw_text'),
  /** Which connector produced this document ('arxiv', 'openapi', …). */
  connector: text('connector'),
  /**
   * Pre-extracted units from a structured connector.
   *
   * Persisted rather than passed in memory so that reprocessing a structured
   * document behaves exactly like reprocessing a text one — the pipeline reads
   * its input from the row either way, and neither path needs the original
   * source to still be reachable.
   */
  structuredUnits: jsonb('structured_units'),
  processed: boolean('processed').default(false).notNull(),
  processingStatus: processingStatusEnum('processing_status').default('pending').notNull(),
  processingProgress: integer('processing_progress').default(0),
  processingError: text('processing_error'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  arxivIdIdx: index('papers_arxiv_id_idx').on(table.arxivId),
  processedIdx: index('papers_processed_idx').on(table.processed),
  processingStatusIdx: index('papers_processing_status_idx').on(table.processingStatus),
  domainIdx: index('papers_domain_idx').on(table.domain),
}));

export const authors = pgTable('authors', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  normalizedName: text('normalized_name'),
  orcid: text('orcid'),
  affiliations: jsonb('affiliations'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const paperAuthors = pgTable('paper_authors', {
  paperId: uuid('paper_id').notNull().references(() => papers.id, { onDelete: 'cascade' }),
  authorId: uuid('author_id').notNull().references(() => authors.id, { onDelete: 'cascade' }),
  position: integer('position'),
  isCorresponding: boolean('is_corresponding').default(false),
}, (table) => ({
  pk: primaryKey({ columns: [table.paperId, table.authorId] }),
}));

export const nodes = pgTable('nodes', {
  id: uuid('id').defaultRandom().primaryKey(),
  type: text('type').notNull(),
  domain: text('domain'),
  name: text('name').notNull(),
  normalizedName: text('normalized_name'),
  description: text('description'),
  properties: jsonb('properties'),
  paperId: uuid('paper_id').references(() => papers.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  typeIdx: index('nodes_type_idx').on(table.type),
  normalizedNameIdx: index('nodes_normalized_name_idx').on(table.normalizedName),
  paperIdIdx: index('nodes_paper_id_idx').on(table.paperId),
  domainTypeIdx: index('nodes_domain_type_idx').on(table.domain, table.type),
}));

export const edges = pgTable('edges', {
  id: uuid('id').defaultRandom().primaryKey(),
  sourceId: uuid('source_id').notNull().references(() => nodes.id, { onDelete: 'cascade' }),
  targetId: uuid('target_id').notNull().references(() => nodes.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  domain: text('domain'),
  properties: jsonb('properties'),
  confidence: decimal('confidence', { precision: 3, scale: 2 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  sourceIdIdx: index('edges_source_id_idx').on(table.sourceId),
  targetIdIdx: index('edges_target_id_idx').on(table.targetId),
  typeIdx: index('edges_type_idx').on(table.type),
  sourceTypeIdx: index('edges_source_type_idx').on(table.sourceId, table.type),
  targetTypeIdx: index('edges_target_type_idx').on(table.targetId, table.type),
  domainTypeIdx: index('edges_domain_type_idx').on(table.domain, table.type),
}));

export const sources = pgTable('sources', {
  id: uuid('id').defaultRandom().primaryKey(),
  edgeId: uuid('edge_id').notNull().references(() => edges.id, { onDelete: 'cascade' }),
  paperId: uuid('paper_id').notNull().references(() => papers.id, { onDelete: 'cascade' }),
  pageNumber: integer('page_number'),
  section: text('section'),
  extractedText: text('extracted_text'),
  spanStart: integer('span_start'),
  spanEnd: integer('span_end'),
  // Which chunk produced this claim. Without it, "undo one chunk" is impossible
  // and the only safe retry is to wipe the whole paper and start at zero.
  chunkIndex: integer('chunk_index'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  edgeIdIdx: index('sources_edge_id_idx').on(table.edgeId),
  paperIdIdx: index('sources_paper_id_idx').on(table.paperId),
  paperChunkIdx: index('sources_paper_chunk_idx').on(table.paperId, table.chunkIndex),
}));

/**
 * Per-chunk checkpoint: what a paper has already extracted.
 *
 * Extraction is ~34s of GPU per chunk and a paper is ~26 chunks, so a failure at
 * chunk 24 used to throw away fifteen minutes of correct work — the retry
 * cleared the paper's whole contribution and started at chunk 0. That is only
 * the right shape if you cannot attribute work to a chunk. With this table you
 * can, so a retry resumes and a pause is lossless.
 *
 * `contentHash` guards the one assumption resume depends on: that chunk N means
 * the same text it meant last time. Chunking is deterministic given the source
 * text, so if the text changes the boundaries move and every checkpoint is
 * meaningless — better to detect that and redo the paper than to resume onto
 * different content and silently mis-attribute evidence.
 */
export const paperChunks = pgTable('paper_chunks', {
  paperId: uuid('paper_id').notNull().references(() => papers.id, { onDelete: 'cascade' }),
  chunkIndex: integer('chunk_index').notNull(),
  status: text('status').notNull().default('completed'),
  contentHash: text('content_hash').notNull(),
  section: text('section'),
  entities: integer('entities').default(0).notNull(),
  relationships: integer('relationships').default(0).notNull(),
  error: text('error'),
  completedAt: timestamp('completed_at').defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.paperId, table.chunkIndex] }),
  paperIdx: index('paper_chunks_paper_idx').on(table.paperId),
}));

/**
 * Graph-quality proposals, produced by the background audit.
 *
 * Findings are stored rather than acted on. The doctrine that governs merging
 * governs cleaning with more force: a false merge destroys a distinction, and a
 * false *drop* destroys the evidence too, with no record it ever existed. So the
 * audit writes what it believes and why, and applying is a separate act.
 *
 * `dismissed` rows are kept deliberately. Without them the next audit
 * re-proposes what a human already rejected, and a tool that keeps asking the
 * same question gets ignored — which is how a quality system stops working
 * without anyone deciding to switch it off.
 */
export const graphFindings = pgTable('graph_findings', {
  id: uuid('id').defaultRandom().primaryKey(),
  domain: text('domain').notNull(),
  nodeId: uuid('node_id').notNull().references(() => nodes.id, { onDelete: 'cascade' }),
  /** For a merge, the node that should survive. */
  relatedNodeId: uuid('related_node_id').references(() => nodes.id, { onDelete: 'cascade' }),
  detector: text('detector').notNull(),
  verdict: text('verdict').notNull(),
  reason: text('reason').notNull(),
  confidence: text('confidence').notNull(),
  status: text('status').notNull().default('proposed'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  resolvedAt: timestamp('resolved_at'),
}, (table) => ({
  domainStatusIdx: index('graph_findings_domain_status_idx').on(table.domain, table.status),
  nodeIdx: index('graph_findings_node_idx').on(table.nodeId),
}));

/**
 * A batch: one bulk request, many jobs.
 *
 * "100 documents in one request" needs an entity the caller can hold on to.
 * Progress and completion are always COMPUTED from the member jobs, never
 * denormalised onto this row — counters that are written twice drift, and a
 * batch that claims 100/100 while a job row says `failed` is worse than no
 * batch tracking at all.
 */
export const batches = pgTable('batches', {
  id: uuid('id').defaultRandom().primaryKey(),
  note: text('note'),
  domain: text('domain'),
  /** Number of documents submitted — fixed at creation. */
  total: integer('total').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Durable background-job records: the QUEUE ITSELF, not a status mirror.
//
// Previously a job row only mirrored the status of a closure held in the
// worker's memory, which meant a queued job died with its process — fatal for a
// batch that runs 20+ hours on this hardware. Now workers CLAIM rows from this
// table (FOR UPDATE SKIP LOCKED), so any instance can pick up any queued job,
// and a restart resumes the backlog instead of orphaning it.
export const jobs = pgTable('jobs', {
  id: text('id').primaryKey(),                     // "job-{timestamp}-{counter}-{random}"
  type: text('type').notNull(),                    // 'ingest' | 'process' | 'audit'
  status: jobStatusEnum('status').default('queued').notNull(),
  paperId: uuid('paper_id').references(() => papers.id, { onDelete: 'set null' }),
  progress: text('progress'),                      // human-readable status message
  error: text('error'),
  metadata: jsonb('metadata'),                     // flexible payload (arxivId, autoProcess, ...)
  // Which API instance owns this job. The worker is in-process, so a queued job
  // only exists in the memory of the instance that accepted it — no other
  // instance can ever run it. Recording the owner is what lets startup recovery
  // fail *its own* interrupted jobs without destroying another instance's live
  // work (which a global sweep did).
  owner: text('owner'),
  // Lease renewed while the job runs. If an instance dies for good, its lease
  // lapses and any instance may then recover the job.
  leaseExpiresAt: timestamp('lease_expires_at'),
  /** Times this job has been claimed. Retried until MAX_JOB_ATTEMPTS, then failed. */
  attempts: integer('attempts').default(0).notNull(),
  // Handler failures, counted separately from claims. A restart that interrupts
  // a job is not evidence the job is bad, so it must not spend the budget meant
  // for work that actually ran and threw. See queue/index.ts.
  failures: integer('failures').default(0).notNull(),
  batchId: uuid('batch_id').references(() => batches.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  statusIdx: index('jobs_status_idx').on(table.status),
  paperIdIdx: index('jobs_paper_id_idx').on(table.paperId),
  ownerIdx: index('jobs_owner_idx').on(table.owner),
  batchIdx: index('jobs_batch_idx').on(table.batchId),
}));

// --- Identity, authorization, audit ----------------------------------------
//
// Domain isolation was, until now, a *data* boundary only: the query layer
// scoped every read, and tests proved it, but nothing bound a caller to a
// domain. One shared `API_KEY` opened every domain and read routes needed no key
// at all. These tables make the boundary an *authorization* boundary — a
// credential grants access to named domains and nothing else.

export const tenants = pgTable('tenants', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  slugIdx: index('tenants_slug_idx').on(table.slug),
}));

/**
 * A credential holder — a person or an agent.
 *
 * The secret is never stored. A key is issued as `mk_<prefix>_<secret>`: the
 * prefix is an indexed lookup handle so verification is a single row fetch
 * rather than a scan-and-compare over every principal, and only the hash of the
 * secret is persisted. A database dump therefore does not yield working keys.
 */
export const principals = pgTable('principals', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  /** 'user' | 'agent' — recorded for audit reading, not for permission logic. */
  kind: text('kind').notNull().default('agent'),
  /** Public lookup handle, safe to log. */
  keyPrefix: text('key_prefix').notNull().unique(),
  /** SHA-256 of the secret half. */
  keyHash: text('key_hash').notNull(),
  /** Capability scopes: 'read' | 'write' | 'admin'. */
  scopes: jsonb('scopes').notNull(),
  /**
   * Domains this principal may touch. An empty array grants nothing; the
   * wildcard is deliberately explicit (`['*']`) so that a missing or malformed
   * grant list denies rather than opens everything.
   */
  domains: jsonb('domains').notNull(),
  expiresAt: timestamp('expires_at'),
  revokedAt: timestamp('revoked_at'),
  lastUsedAt: timestamp('last_used_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  prefixIdx: index('principals_key_prefix_idx').on(table.keyPrefix),
  tenantIdx: index('principals_tenant_idx').on(table.tenantId),
}));

/**
 * What every credential did.
 *
 * Written for both allowed and denied attempts — a denial is the more
 * interesting record, and an audit trail that only contains successes cannot
 * answer the question anyone actually asks after an incident.
 */
export const auditLog = pgTable('audit_log', {
  id: uuid('id').defaultRandom().primaryKey(),
  principalId: uuid('principal_id').references(() => principals.id, { onDelete: 'set null' }),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'set null' }),
  /** Human-readable principal label, retained even if the principal is deleted. */
  actor: text('actor'),
  action: text('action').notNull(),          // 'field.query', 'graph.nodes', ...
  domain: text('domain'),
  outcome: text('outcome').notNull(),        // 'allowed' | 'denied' | 'error'
  detail: jsonb('detail'),                   // query text, evidence count, reason
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  principalIdx: index('audit_log_principal_idx').on(table.principalId),
  createdAtIdx: index('audit_log_created_at_idx').on(table.createdAt),
  actionIdx: index('audit_log_action_idx').on(table.action),
  outcomeIdx: index('audit_log_outcome_idx').on(table.outcome),
}));

// --- Manifold: geometric knowledge field ---------------------------------

// One vector record per graph node: the Euclidean embedding used for
// resolution / PPR seeding / compression, plus the trained Poincaré (hyperbolic)
// coordinates used for hierarchy-aware queries. Stored as jsonb (number[]);
// cosine similarity is computed in JS. pgvector is the scale path.
export const nodeVectors = pgTable('node_vectors', {
  id: uuid('id').defaultRandom().primaryKey(),
  nodeId: uuid('node_id').notNull().unique().references(() => nodes.id, { onDelete: 'cascade' }),
  // pgvector column: nearest-neighbour search happens in Postgres against an HNSW
  // index. Reading vectors into JS to score them cost O(corpus) bytes per query —
  // roughly 300 MB at ten thousand entities — which is what made retrieval
  // unusable past demo scale.
  embeddingVec: vector('embedding_vec', { dimensions: VECTOR_DIMENSIONS }),
  hyperbolic: jsonb('hyperbolic'),               // number[] | null (Poincaré ball coords)
  model: text('model'),
  /** `provider:model:dimensions` — makes a mixed-space corpus detectable. */
  space: text('space'),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  nodeIdIdx: index('node_vectors_node_id_idx').on(table.nodeId),
  // Cosine distance, matching the similarity used throughout the field layer.
  embeddingHnsw: index('node_vectors_embedding_hnsw')
    .using('hnsw', table.embeddingVec.op('vector_cosine_ops')),
}));

// Atomic factual propositions (sentence-split relationship evidence) with their
// own embedding. These are the unit of compressed retrieval — far smaller than
// the 2000-char chunks the legacy pipeline re-stuffs into prompts.
export const propositions = pgTable('propositions', {
  id: uuid('id').defaultRandom().primaryKey(),
  paperId: uuid('paper_id').references(() => papers.id, { onDelete: 'cascade' }),
  text: text('text').notNull(),
  embeddingVec: vector('embedding_vec', { dimensions: VECTOR_DIMENSIONS }),
  nodeIds: jsonb('node_ids'),                    // string[] (uuids this proposition mentions)
  section: text('section'),
  domain: text('domain'),
  space: text('space'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  paperIdIdx: index('propositions_paper_id_idx').on(table.paperId),
  domainIdx: index('propositions_domain_idx').on(table.domain),
  embeddingHnsw: index('propositions_embedding_hnsw')
    .using('hnsw', table.embeddingVec.op('vector_cosine_ops')),
  // Lexical ranking is part of the retrieval hot path (rank fusion), not just a
  // benchmark baseline. Without this expression index every query recomputes
  // to_tsvector over every proposition in the corpus.
  textSearchGin: index('propositions_text_search_gin')
    .using('gin', sql`to_tsvector('english', ${table.text})`),
  // Evidence gathering asks "which propositions mention any of these node ids".
  // Without a GIN index that predicate is a sequential scan over every
  // proposition in the corpus, decoding each JSONB array.
  nodeIdsGin: index('propositions_node_ids_gin').using('gin', table.nodeIds),
}));

// Cached GraphRAG-style community summaries: one LLM summary per cluster,
// reused across all future queries so broad questions read 1 summary instead of N.
export const communities = pgTable('communities', {
  id: uuid('id').defaultRandom().primaryKey(),
  label: text('label'),
  domain: text('domain'),                        // which domain this community belongs to
  nodeIds: jsonb('node_ids'),                    // string[] (uuids)
  summary: text('summary'),
  embedding: jsonb('embedding'),                 // number[] | null
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const papersRelations = relations(papers, ({ many }) => ({
  authors: many(paperAuthors),
  nodes: many(nodes),
  sources: many(sources),
}));

export const authorsRelations = relations(authors, ({ many }) => ({
  papers: many(paperAuthors),
}));

export const paperAuthorsRelations = relations(paperAuthors, ({ one }) => ({
  paper: one(papers, {
    fields: [paperAuthors.paperId],
    references: [papers.id],
  }),
  author: one(authors, {
    fields: [paperAuthors.authorId],
    references: [authors.id],
  }),
}));

export const nodesRelations = relations(nodes, ({ one, many }) => ({
  paper: one(papers, {
    fields: [nodes.paperId],
    references: [papers.id],
  }),
  outgoingEdges: many(edges, { relationName: 'source' }),
  incomingEdges: many(edges, { relationName: 'target' }),
}));

export const edgesRelations = relations(edges, ({ one, many }) => ({
  source: one(nodes, {
    fields: [edges.sourceId],
    references: [nodes.id],
    relationName: 'source',
  }),
  target: one(nodes, {
    fields: [edges.targetId],
    references: [nodes.id],
    relationName: 'target',
  }),
  sources: many(sources),
}));

export const sourcesRelations = relations(sources, ({ one }) => ({
  edge: one(edges, {
    fields: [sources.edgeId],
    references: [edges.id],
  }),
  paper: one(papers, {
    fields: [sources.paperId],
    references: [papers.id],
  }),
}));
