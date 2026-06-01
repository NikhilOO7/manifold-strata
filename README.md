# Manifold

**A geometric, low-LLM knowledge field over research papers.**

Manifold ingests academic papers and builds a queryable knowledge graph — but it stores and retrieves that knowledge as a *geometric field* rather than calling an LLM at every step. Entity resolution and relationship validation run in embedding/rule space, retrieval uses HippoRAG-style Personalized PageRank over the graph, concepts are embedded in hyperbolic (Poincaré) space for hierarchy-aware queries, and context is compressed via propositions + MMR before a single answer call. The seed corpus is the 3D Gaussian Splatting literature, but nothing in the pipeline is domain-specific.

The result: ingestion uses **one** LLM call per chunk (extraction) instead of three, and a full multi-hop query uses **one** LLM call (final verbalization) instead of a retrieve→reason→retrieve loop. Set `PIPELINE_MODE=field|legacy` and hit `GET /api/field/benchmark` to measure the difference on your own data.

---

## Why it's interesting

| Concern | Typical RAG / agent stack | Manifold |
|---|---|---|
| Entity resolution | 1 LLM call per chunk | 1 batched **embedding** call, cosine + normalized-name match ([resolve-embed.ts](apps/api/src/knowledge-field/resolve-embed.ts)) |
| Relationship validation | 1 LLM call per chunk | **type-compatibility matrix** + confidence floor, 0 LLM calls ([validate-rules.ts](apps/api/src/knowledge-field/validate-rules.ts)) |
| Multi-hop retrieval | repeated retrieve→reason loops | one **Personalized PageRank** pass over the graph ([ppr.ts](apps/api/src/knowledge-field/ppr.ts)) |
| Hierarchy ("what generalizes X?") | not modeled | **Poincaré-ball** embeddings; norm ≈ generality, distance ≈ relatedness ([hyperbolic.ts](apps/api/src/knowledge-field/hyperbolic.ts)) |
| Context assembly | top-k raw chunks stuffed into prompt | **MMR**-compressed propositions under a token budget ([compress.ts](apps/api/src/knowledge-field/compress.ts)) |
| Broad questions | re-read N chunks every time | cached **community summaries** (GraphRAG-style), 1 amortized call ([communities.ts](apps/api/src/knowledge-field/communities.ts)) |
| Answer generation | many calls | **one** verbalization call ([retrieve.ts](apps/api/src/knowledge-field/retrieve.ts)) |

---

## Architecture

```
┌──────────────┐     ┌──────────────────┐     ┌──────────────────────────────────────┐
│  arXiv API   │ ──► │  PDF extraction  │ ──► │            Ingestion pipeline          │
│  (metadata)  │     │   (pdf-parse)    │     │  chunk → Extractor (LLM) → resolve     │
└──────────────┘     └──────────────────┘     │  (embeddings) → validate (rules) →     │
                                               │  nodes / edges / propositions / vectors│
                                               └───────────────────┬────────────────────┘
        background worker (bounded concurrency, durable `jobs` table)│
                                                                     ▼
                                            ┌─────────────────────────────────────────┐
                                            │           PostgreSQL (Drizzle)           │
                                            │ papers · nodes · edges · sources · jobs  │
                                            │ node_vectors · propositions · communities│
                                            └───────────────────┬──────────────────────┘
                                                                ▼
                        ┌───────────────────────────────────────────────────────────┐
                        │                  REST API (Hono)                          │
                        │  /api/graph  ·  /api/ingest  ·  /api/papers  ·  /api/field │
                        │  auth (optional API key) + per-route rate limiting         │
                        └───────────────────────────┬───────────────────────────────┘
                                                     ▼
                        ┌───────────────────────────────────────────────────────────┐
                        │          React UI (Vite + Tailwind + React Flow)          │
                        │  Dashboard  ·  Graph Explorer  ·  Ingestion               │
                        └───────────────────────────────────────────────────────────┘
```

### Ingestion pipeline (`PIPELINE_MODE`)

Paper text is chunked (2000 chars, 200 overlap). For each chunk:

1. **Extractor (LLM)** — identifies entity mentions and candidate relationships. This is the only LLM call in field-mode ingestion.
2. **Resolve** —
   - `field` (default): [resolveEntitiesEmbed](apps/api/src/knowledge-field/resolve-embed.ts) embeds all mentions in one batch and matches them to existing nodes by `max(cosine, normalized-name)`.
   - `legacy`: the original Resolver LLM agent.
3. **Validate** —
   - `field`: [validateRelationshipsRules](apps/api/src/knowledge-field/validate-rules.ts) checks edge-type/endpoint-type compatibility, drops degenerate/low-confidence edges, dedups.
   - `legacy`: the original Validator LLM agent.
4. **Persist** — nodes, edges (with provenance in `sources`), node embeddings (`node_vectors`), and atomic factual **propositions** for retrieval.

Both modes write identical output shapes, so the rest of the system is mode-agnostic — that's what makes the A/B benchmark honest.

### Retrieval (`POST /api/field/query`)

```
embed(query) → seed nodes (cosine) → Personalized PageRank → gather propositions
             → MMR compression (token budget) → ONE verbalize LLM call → answer
```

Multi-hop reasoning and evidence selection happen in vector/graph space; the LLM only writes the final prose. `GET /api/field/retrieve?q=...` returns the ranked evidence with no LLM call at all.

---

## Tech stack

**Backend** — [Hono](https://hono.dev) (API), [Drizzle ORM](https://orm.drizzle.team) + PostgreSQL 16, [Ollama](https://ollama.com) for local LLM/embeddings (OpenAI optional), `pdf-parse`, `zod`.

**Frontend** — React 18 + TypeScript, Vite, TailwindCSS, React Router, TanStack Query, React Flow.

**Infra** — pnpm workspaces (monorepo), Docker Compose (PostgreSQL).

### Design choices

- **PostgreSQL over a graph DB** — ACID, mature tooling, and Drizzle's TypeScript integration. Graph traversal is handled with composite indexes on `(source_id, type)` / `(target_id, type)`; vectors live in JSONB with cosine computed in JS (pgvector is the documented scale path).
- **Local LLM (Ollama) by default** — no API key or cost to run end-to-end; `LLM_PROVIDER=openai` swaps in OpenAI when you want higher-quality extraction.
- **Geometry over LLM calls** — the field subsystem replaces per-chunk LLM resolution/validation and multi-step retrieval with embeddings, PPR, and rule checks. Fewer calls, deterministic, debuggable.

---

## Prerequisites

- Node.js ≥ 18 and pnpm ≥ 8
- Docker + Docker Compose (for PostgreSQL)
- [Ollama](https://ollama.com) running locally **or** an OpenAI API key

For a fully-local setup, pull a chat model and an embedding model:

```bash
ollama pull llama3.2:1b      # OLLAMA_MODEL (chat / extraction)
ollama pull nomic-embed-text # OLLAMA_EMBED_MODEL (embeddings, field mode)
```

> Field mode requires embeddings. `EMBED_PROVIDER` defaults to `openai`, so for a key-free local run set `EMBED_PROVIDER=ollama` (see below).

---

## Installation

```bash
git clone <repository-url>
cd manifold-strata
pnpm install

# Start PostgreSQL (maps host :5433 → container :5432)
docker compose up -d

# Configure env (see the table below), then push the schema
pnpm db:push
```

**`apps/api/.env`** (fully-local example):

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/knowledge_graph
LLM_PROVIDER=ollama
OLLAMA_MODEL=llama3.2:1b
EMBED_PROVIDER=ollama
OLLAMA_EMBED_MODEL=nomic-embed-text
PIPELINE_MODE=field
# API_KEY=your-secret          # uncomment to require a key on write routes
# JOB_CONCURRENCY=2            # background worker parallelism
```

**`apps/web/.env`:**

```bash
VITE_API_URL=http://localhost:3000
```

---

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5433/knowledge_graph` | Postgres connection |
| `PORT` | `3000` | API port |
| `PIPELINE_MODE` | `field` | `field` (geometric, low-LLM) or `legacy` (3-agent LLM) |
| `LLM_PROVIDER` | `ollama` | `ollama` or `openai` (for chat/extraction) |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server |
| `OLLAMA_MODEL` | `llama3.2:1b` | Ollama chat model |
| `OLLAMA_EMBED_MODEL` | `nomic-embed-text` | Ollama embedding model |
| `EMBED_PROVIDER` | `openai` (falls back to `LLM_PROVIDER`) | `ollama` or `openai` for embeddings |
| `OPENAI_API_KEY` | — | Required if any provider is `openai` |
| `OPENAI_MODEL` | `gpt-4o-mini` | OpenAI chat model |
| `OPENAI_EMBED_MODEL` | `text-embedding-3-small` | OpenAI embedding model |
| `API_KEY` | — | If set, write routes require it (Bearer or `X-API-Key`). Unset = auth disabled |
| `JOB_CONCURRENCY` | `2` | Concurrent papers in the background worker |
| `VITE_API_URL` | `http://localhost:3000` | API base URL for the web app |

---

## Running

```bash
pnpm dev          # api (:3000) + web (:5173) in parallel
# or individually:
pnpm --filter api dev
pnpm --filter web dev
```

- Frontend: http://localhost:5173
- API: http://localhost:3000 (the root `/` lists all endpoints)
- DB GUI: `pnpm db:studio`

---

## Quick start

```bash
# 1. Ingest a paper from arXiv (downloads PDF, extracts text, runs the pipeline)
curl -X POST http://localhost:3000/api/ingest/arxiv \
  -H "Content-Type: application/json" \
  -d '{"arxivId": "2308.04079", "autoProcess": true}'
# → { "jobId": "job-...", "status": "queued" }   (202 — runs on the background worker)

# 2. Poll the durable job status
curl http://localhost:3000/api/ingest/status/<jobId>

# 3. Ask the field a multi-hop question (one LLM call)
curl -X POST http://localhost:3000/api/field/query \
  -H "Content-Type: application/json" \
  -d '{"question": "Which methods improve on 3D Gaussian Splatting?"}'

# 4. Inspect retrieval with NO LLM call
curl "http://localhost:3000/api/field/retrieve?q=novel%20view%20synthesis"
```

Then open the **Graph Explorer** at http://localhost:5173/explorer — filter by node type, drag the **confidence slider** to hide weak edges, cap the **node count** for large graphs, and click nodes to see their relationships. The layout is force-directed, so connected concepts cluster.

> First run the geometric layer on existing data: `POST /api/field/backfill` (embeds nodes + propositions), then optionally `POST /api/field/train-hyperbolic` and `POST /api/field/communities/build`.

---

## Operational features

- **Background worker + durable jobs** — ingestion/processing run on an in-process bounded-concurrency queue ([apps/api/src/queue](apps/api/src/queue/index.ts)); the request returns `202` immediately. Job status is persisted in a `jobs` table (survives restarts), and any job left mid-run by a crash is recovered to `failed` on startup so nothing hangs forever.
- **Optional API-key auth** — set `API_KEY` to require a key (`Authorization: Bearer <key>` or `X-API-Key`) on write routes (`POST /api/ingest/*`, `POST /api/papers/*`, mutating `/api/field/*`). Unset for frictionless local dev.
- **Rate limiting** — in-memory per-IP limits: ingest 10/min, field 30/min, graph & papers 200/min. Responses include `X-RateLimit-*` headers; `429` with `Retry-After` when exceeded.
- **Open entity & relationship types** — node/edge `type` columns are free-form `text`, not enums. The extractor may discover new types (e.g. `task`, `model`, `loss`, `regularizes`) and they're stored without a migration; the rule validator treats unknown types gracefully (never hard-rejects), and the Explorer's type filter + colors are driven by `GET /api/graph/types` rather than a hardcoded list. `KNOWN_NODE_TYPES`/`KNOWN_EDGE_TYPES` in `packages/shared` are seed defaults only.

## Domains (multi-field isolation)

A single instance can host several research fields without their graphs bleeding into each other. A **domain** is code config ([apps/api/src/domains/](apps/api/src/domains/)) — a `DomainConfig` of preferred entity/relationship types, an extraction-prompt context, examples, and seed papers. Three ship by default: `default` (generic), `gaussian-splatting`, and `nlp`.

How isolation works:
- Papers are tagged with a `domain`; nodes, edges, and propositions are **stamped** with it.
- Entity resolution only matches within the same domain, so `attention` (NLP) and `attention` (vision) stay separate nodes — **no cross-contamination**.
- Retrieval (`/api/field/query`, MCP tools), graph views, and per-domain hyperbolic/community builds all scope by domain.
- Types stay *open within* a domain (the extractor can still invent new ones); the domain just supplies the preferred set + prompt context.
- Legacy data (created before domains) has a `NULL` domain and is treated as `default`, so nothing breaks. Adopt it into a domain with `POST /api/domains/backfill`.

```bash
# Ingest into a domain
curl -X POST localhost:3000/api/ingest/arxiv \
  -H 'Content-Type: application/json' \
  -d '{"arxivId":"1706.03762","domain":"nlp","autoProcess":true}'

# Seed a domain, query within it
curl localhost:3000/api/ingest/seed/nlp
curl -X POST localhost:3000/api/field/query \
  -H 'Content-Type: application/json' \
  -d '{"question":"Which models extend the Transformer?","domain":"nlp"}'
```

Adding a domain is a new file in `apps/api/src/domains/` registered in `index.ts` — no schema migration. (Per-domain *type rules* and a DB-editable domain registry are natural next steps; see Limitations.)

## Use it from an AI agent (MCP)

Manifold ships an [MCP](https://modelcontextprotocol.io) server ([apps/api/src/mcp/server.ts](apps/api/src/mcp/server.ts)) that exposes the knowledge field as tools any MCP client (Claude Desktop, Claude Code, a larger agent) can call. The retrieval tools run entirely in vector/graph space — the *calling* agent does the reasoning, Manifold just returns compressed, grounded evidence.

| Tool | LLM calls | Purpose |
|---|---|---|
| `search_knowledge(query, maxEvidence?)` | **0** | Embeddings + PPR + MMR → ranked, compressed evidence |
| `find_entity(name, limit?)` | **0** | Resolve a name to node id(s)/types |
| `get_subgraph(nodeId, depth?)` | **0** | N-hop neighborhood (nodes + typed edges) |
| `query_field(question, verbalize?)` | 0 or 1 | Evidence, plus an answer if `verbalize: true` |

Run it (stdio transport):

```bash
pnpm --filter api mcp
```

Register it with a client — e.g. Claude Desktop's `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "manifold": {
      "command": "pnpm",
      "args": ["--filter", "api", "mcp"],
      "cwd": "/absolute/path/to/manifold-strata",
      "env": { "DATABASE_URL": "postgresql://postgres:postgres@localhost:5433/knowledge_graph" }
    }
  }
}
```

It reuses the same DB layer and field functions as the HTTP API — no duplicated logic, no network hop.

---

## Database schema

Relational core + JSONB for flexible/vector data:

- `papers`, `authors`, `paper_authors` — corpus + authorship
- `nodes` — entities (`paper` / `method` / `concept` / `dataset` / `metric`)
- `edges` — directed relationships (`extends`, `improves`, `uses`, `introduces`, `cites`, `evaluates_on`, `compares_to`, `authored_by`) with confidence scores
- `sources` — provenance: links every edge to a paper, section, and text span
- `jobs` — durable background-job status
- `node_vectors` — per-node Euclidean embedding + trained Poincaré (hyperbolic) coords
- `propositions` — atomic factual sentences with embeddings (the unit of compressed retrieval)
- `communities` — cached cluster summaries for broad queries

UUID primary keys; composite indexes on `(source_id, type)` and `(target_id, type)` for traversal.

---

## API reference

### Papers
- `GET /api/papers?limit=&offset=` — list papers
- `GET /api/papers/processing` — papers currently being processed (Dashboard polls this)
- `GET /api/papers/:id` — paper details
- `POST /api/papers` — create a paper manually *(auth)*
- `POST /api/papers/:id/process` — enqueue processing; returns `202` + `jobId` *(auth)*

### Graph
- `GET /api/graph/nodes?type=&search=&limit=&offset=` — list nodes
- `GET /api/graph/nodes/:id` — node with incoming/outgoing edges
- `GET /api/graph/edges?type=&limit=&offset=` — list edges (single double-join query)
- `GET /api/graph/subgraph?nodeId=&depth=` — N-hop neighborhood (depth capped at 3)
- `GET /api/graph/stats` — aggregate counts
- `GET /api/graph/types` — distinct node/edge types present in the graph (drives the UI's filters dynamically)
- `GET /api/graph/queries/{improves-3dgs,extends-3dgs,datasets}` — example domain queries
- `GET /api/graph/queries/method-relationships?name=` — relationships for a method
- `GET /api/graph/queries/provenance/:edgeId` — source evidence for an edge

All graph read endpoints accept an optional `?domain=` filter; omit it to span every domain.

### Ingestion
- `POST /api/ingest/arxiv` — ingest one paper from arXiv (optional `domain` in body) *(auth)*
- `POST /api/ingest/bulk` — ingest up to 100 papers (optional `domain`) *(auth)*
- `GET /api/ingest/status/:jobId` — durable job status
- `GET /api/ingest/seed/:domain` — curated seed arXiv IDs for a domain

### Domains
- `GET /api/domains` — list registered domains
- `GET /api/domains/:id` — full domain config (types, examples, seeds)
- `POST /api/domains/backfill` — stamp legacy NULL-domain rows into a domain *(auth)*

### Field (geometric layer)
- `POST /api/field/query` — embed → PPR → MMR → one verbalize call (optional `domain`) *(auth)*
- `GET /api/field/retrieve?q=&domain=` — ranked evidence, **no** LLM call
- `GET /api/field/hierarchy/:nodeId` — generalizations / specializations (hyperbolic)
- `POST /api/field/backfill` — embed existing nodes + propositions *(auth)*
- `POST /api/field/train-hyperbolic` — train Poincaré coords on extends/improves/cites *(auth)*
- `POST /api/field/communities/build` — cluster + summarize communities *(auth)*
- `GET /api/field/benchmark` — field vs legacy LLM-call and context-size comparison

---

## Benchmarking the field

Process the same paper twice and compare:

```bash
# Legacy (3-agent, all-LLM)
PIPELINE_MODE=legacy pnpm --filter api dev   # ingest a paper, then:
GET /api/field/benchmark                       # records LLM calls per mode

# Field (geometric, low-LLM) — restart with PIPELINE_MODE=field, ingest the same paper
```

The benchmark also compares retrieval: naive top-k raw propositions vs MMR-compressed field context, reporting the character/token reduction per question.

---

## Project structure

```
manifold-strata/
├── apps/
│   ├── api/                     # Hono backend
│   │   └── src/
│   │       ├── routes/          # graph, ingest, papers, field, domains
│   │       ├── domains/         # per-field ontology registry (config-as-code)
│   │       ├── agents/          # legacy 3-agent pipeline + prompts/schemas
│   │       ├── knowledge-field/ # resolve-embed, validate-rules, ppr,
│   │       │                    #   compress, hyperbolic, communities, retrieve
│   │       ├── services/        # ollama, embeddings, metrics, pdf
│   │       ├── pipeline/        # processor (field/legacy orchestration)
│   │       ├── queue/           # durable jobs + background worker
│   │       ├── middleware/      # auth, rate-limit
│   │       ├── mcp/             # MCP server (stdio) over the field functions
│   │       └── db/              # Drizzle schema + connection
│   └── web/                     # React + Vite frontend
│       └── src/
│           ├── pages/           # Dashboard, Explorer, Ingestion
│           └── lib/             # api client, force layout
├── packages/shared/             # shared TypeScript types
└── docker-compose.yml           # PostgreSQL
```

---

## Limitations & future work

- **Single-instance worker** — the background queue is in-process with a durable `jobs` table. Multi-instance/horizontal scale wants a shared queue (BullMQ + Redis); the job-table contract is designed so that swap is local to `apps/api/src/queue`.
- **Status updates are polled** — the Dashboard/Ingestion pages poll every ~2s. Server-Sent Events would push updates and cut idle DB load.
- **Vectors in JSONB** — cosine similarity is computed in JS, which is fine at this corpus size (hundreds–thousands of nodes). pgvector + an HNSW index is the path to larger graphs.
- **Domains are strictly isolated, with no cross-domain bridges** — each node lives in exactly one domain (see [Domains](#domains-multi-field-isolation)), so a concept studied in two fields becomes two nodes. A future "shared" namespace or a `domains text[]` tag could link them where it's genuinely the same entity. Domains are also config-as-code; a DB-editable registry + per-domain type-compatibility rules are natural extensions.
- **Hyperbolic/community layers are batch** — `train-hyperbolic` and `communities/build` are run on demand, not incrementally maintained as papers arrive.
- **Auth is a single shared key** — fine for a protected deployment; real multi-tenant use wants per-user keys / JWT and scoped permissions.

---

## License

MIT
