-- pgvector must exist before any `vector` column or HNSW index is created.
-- drizzle-kit does not emit extension statements, so this is prepended by hand
-- and must survive regeneration.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'fetching_metadata', 'downloading_pdf', 'extracting_text', 'processing', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."processing_status" AS ENUM('pending', 'downloading_pdf', 'extracting_text', 'chunking', 'extracting_entities', 'resolving_entities', 'validating', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "authors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text,
	"orcid" text,
	"affiliations" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "communities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text,
	"domain" text,
	"node_ids" jsonb,
	"summary" text,
	"embedding" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "edges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"type" text NOT NULL,
	"domain" text,
	"properties" jsonb,
	"confidence" numeric(3, 2),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"paper_id" uuid,
	"progress" text,
	"error" text,
	"metadata" jsonb,
	"owner" text,
	"lease_expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "node_vectors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"embedding" jsonb NOT NULL,
	"embedding_vec" vector(768),
	"hyperbolic" jsonb,
	"model" text,
	"space" text,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "node_vectors_node_id_unique" UNIQUE("node_id")
);
--> statement-breakpoint
CREATE TABLE "nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"domain" text,
	"name" text NOT NULL,
	"normalized_name" text,
	"description" text,
	"properties" jsonb,
	"paper_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paper_authors" (
	"paper_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"position" integer,
	"is_corresponding" boolean DEFAULT false,
	CONSTRAINT "paper_authors_paper_id_author_id_pk" PRIMARY KEY("paper_id","author_id")
);
--> statement-breakpoint
CREATE TABLE "papers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"abstract" text,
	"arxiv_id" text,
	"doi" text,
	"pdf_url" text,
	"publication_date" date,
	"venue" text,
	"domain" text,
	"raw_text" text,
	"processed" boolean DEFAULT false NOT NULL,
	"processing_status" "processing_status" DEFAULT 'pending' NOT NULL,
	"processing_progress" integer DEFAULT 0,
	"processing_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "papers_arxiv_id_unique" UNIQUE("arxiv_id")
);
--> statement-breakpoint
CREATE TABLE "propositions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"paper_id" uuid,
	"text" text NOT NULL,
	"embedding" jsonb,
	"embedding_vec" vector(768),
	"node_ids" jsonb,
	"section" text,
	"domain" text,
	"space" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"edge_id" uuid NOT NULL,
	"paper_id" uuid NOT NULL,
	"page_number" integer,
	"section" text,
	"extracted_text" text,
	"span_start" integer,
	"span_end" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_source_id_nodes_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_target_id_nodes_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_vectors" ADD CONSTRAINT "node_vectors_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_authors" ADD CONSTRAINT "paper_authors_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_authors" ADD CONSTRAINT "paper_authors_author_id_authors_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."authors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "propositions" ADD CONSTRAINT "propositions_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_edge_id_edges_id_fk" FOREIGN KEY ("edge_id") REFERENCES "public"."edges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "edges_source_id_idx" ON "edges" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "edges_target_id_idx" ON "edges" USING btree ("target_id");--> statement-breakpoint
CREATE INDEX "edges_type_idx" ON "edges" USING btree ("type");--> statement-breakpoint
CREATE INDEX "edges_source_type_idx" ON "edges" USING btree ("source_id","type");--> statement-breakpoint
CREATE INDEX "edges_target_type_idx" ON "edges" USING btree ("target_id","type");--> statement-breakpoint
CREATE INDEX "edges_domain_type_idx" ON "edges" USING btree ("domain","type");--> statement-breakpoint
CREATE INDEX "jobs_status_idx" ON "jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "jobs_paper_id_idx" ON "jobs" USING btree ("paper_id");--> statement-breakpoint
CREATE INDEX "jobs_owner_idx" ON "jobs" USING btree ("owner");--> statement-breakpoint
CREATE INDEX "node_vectors_node_id_idx" ON "node_vectors" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "node_vectors_embedding_hnsw" ON "node_vectors" USING hnsw ("embedding_vec" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "nodes_type_idx" ON "nodes" USING btree ("type");--> statement-breakpoint
CREATE INDEX "nodes_normalized_name_idx" ON "nodes" USING btree ("normalized_name");--> statement-breakpoint
CREATE INDEX "nodes_paper_id_idx" ON "nodes" USING btree ("paper_id");--> statement-breakpoint
CREATE INDEX "nodes_domain_type_idx" ON "nodes" USING btree ("domain","type");--> statement-breakpoint
CREATE INDEX "papers_arxiv_id_idx" ON "papers" USING btree ("arxiv_id");--> statement-breakpoint
CREATE INDEX "papers_processed_idx" ON "papers" USING btree ("processed");--> statement-breakpoint
CREATE INDEX "papers_processing_status_idx" ON "papers" USING btree ("processing_status");--> statement-breakpoint
CREATE INDEX "papers_domain_idx" ON "papers" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "propositions_paper_id_idx" ON "propositions" USING btree ("paper_id");--> statement-breakpoint
CREATE INDEX "propositions_domain_idx" ON "propositions" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "propositions_embedding_hnsw" ON "propositions" USING hnsw ("embedding_vec" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "propositions_node_ids_gin" ON "propositions" USING gin ("node_ids");--> statement-breakpoint
CREATE INDEX "sources_edge_id_idx" ON "sources" USING btree ("edge_id");--> statement-breakpoint
CREATE INDEX "sources_paper_id_idx" ON "sources" USING btree ("paper_id");