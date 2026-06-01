import { pgTable, uuid, text, timestamp, boolean, integer, decimal, jsonb, date, pgEnum, primaryKey, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

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
  'completed',
  'failed'
]);

export const jobStatusEnum = pgEnum('job_status', [
  'queued',
  'fetching_metadata',
  'downloading_pdf',
  'extracting_text',
  'processing',
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
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  edgeIdIdx: index('sources_edge_id_idx').on(table.edgeId),
  paperIdIdx: index('sources_paper_id_idx').on(table.paperId),
}));

// Durable background-job records. Replaces the previous in-memory Map so job
// status survives server restarts and is queryable across processes. The
// in-process worker (apps/api/src/queue) claims and runs these.
export const jobs = pgTable('jobs', {
  id: text('id').primaryKey(),                     // "job-{timestamp}-{random}"
  type: text('type').notNull(),                    // 'ingest' | 'process'
  status: jobStatusEnum('status').default('queued').notNull(),
  paperId: uuid('paper_id').references(() => papers.id, { onDelete: 'set null' }),
  progress: text('progress'),                      // human-readable status message
  error: text('error'),
  metadata: jsonb('metadata'),                     // flexible payload (arxivId, autoProcess, ...)
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  statusIdx: index('jobs_status_idx').on(table.status),
  paperIdIdx: index('jobs_paper_id_idx').on(table.paperId),
}));

// --- Manifold: geometric knowledge field ---------------------------------

// One vector record per graph node: the Euclidean embedding used for
// resolution / PPR seeding / compression, plus the trained Poincaré (hyperbolic)
// coordinates used for hierarchy-aware queries. Stored as jsonb (number[]);
// cosine similarity is computed in JS. pgvector is the scale path.
export const nodeVectors = pgTable('node_vectors', {
  id: uuid('id').defaultRandom().primaryKey(),
  nodeId: uuid('node_id').notNull().unique().references(() => nodes.id, { onDelete: 'cascade' }),
  embedding: jsonb('embedding').notNull(),       // number[]
  hyperbolic: jsonb('hyperbolic'),               // number[] | null (Poincaré ball coords)
  model: text('model'),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  nodeIdIdx: index('node_vectors_node_id_idx').on(table.nodeId),
}));

// Atomic factual propositions (sentence-split relationship evidence) with their
// own embedding. These are the unit of compressed retrieval — far smaller than
// the 2000-char chunks the legacy pipeline re-stuffs into prompts.
export const propositions = pgTable('propositions', {
  id: uuid('id').defaultRandom().primaryKey(),
  paperId: uuid('paper_id').references(() => papers.id, { onDelete: 'cascade' }),
  text: text('text').notNull(),
  embedding: jsonb('embedding'),                 // number[] | null
  nodeIds: jsonb('node_ids'),                    // string[] (uuids this proposition mentions)
  section: text('section'),
  domain: text('domain'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  paperIdIdx: index('propositions_paper_id_idx').on(table.paperId),
  domainIdx: index('propositions_domain_idx').on(table.domain),
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
