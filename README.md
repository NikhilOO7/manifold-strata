# Manifold

**A geometric, low-LLM knowledge field over research papers.**

Manifold ingests academic papers and builds a queryable knowledge graph — but it stores and retrieves that knowledge as a *geometric field* rather than calling an LLM at every step. Entity resolution and relationship validation run in embedding/rule space, retrieval uses HippoRAG-style Personalized PageRank over the graph, concepts are embedded in hyperbolic (Poincaré) space for hierarchy-aware queries, and context is compressed via propositions + MMR before a single answer call. The seed corpus is the 3D Gaussian Splatting literature, but nothing in the pipeline is domain-specific.

The result: ingestion uses **one** LLM call per chunk (extraction) instead of three, and a full multi-hop query uses **one** LLM call (final verbalization) instead of a retrieve→reason→retrieve loop. Set `PIPELINE_MODE=field|legacy` and hit `GET /api/field/benchmark` to measure the difference on your own data.

---

## Why it's interesting

| Concern | Typical RAG / agent stack | Manifold |
|---|---|---|
| Entity resolution | 1 LLM call per chunk | 1 batched **embedding** call, then two indexed lookups — exact name + HNSW k-NN ([resolve-embed.ts](apps/api/src/knowledge-field/resolve-embed.ts), [resolve-candidates.ts](apps/api/src/knowledge-field/resolve-candidates.ts)) |
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
embed(query) → ANN seeds (HNSW) → bounded neighbourhood expansion → Personalized
             PageRank → three signals (graph · vector · lexical) → rank fusion
             → MMR compression (token budget) → ONE verbalize LLM call → answer
```

Retrieval **fuses** three index-backed signals rather than choosing one, because
measurement showed they are complementary: graph traversal is the only signal
that answers multi-hop questions at all, while lexical ranking is near-perfect on
direct lookups where the graph pipeline alone buried the answer. They are combined
by Reciprocal Rank Fusion, which uses rank *positions* only — a cosine score, a
`ts_rank`, and a PageRank mass are not on comparable scales, and normalising them
would mean inventing a conversion that then silently decides every ranking.

Multi-hop reasoning and evidence selection happen in vector/graph space; the LLM only writes the final prose. `GET /api/field/retrieve?q=...` returns the ranked evidence with no LLM call at all.

Every stage is bounded by its own parameters rather than by corpus size — seeds come from the HNSW index, the graph is a capped hop expansion from those seeds, and evidence is index-backed and capped before MMR (which is quadratic in its candidate set). The response reports the working set under `stats`, so a regression back to whole-corpus reads is visible rather than silent.

---

## Tech stack

**Backend** — [Hono](https://hono.dev) (API), [Drizzle ORM](https://orm.drizzle.team) + PostgreSQL 16 with [pgvector](https://github.com/pgvector/pgvector), [Ollama](https://ollama.com) for local LLM/embeddings (OpenAI optional), `pdf-parse`, `zod`.

**Frontend** — React 18 + TypeScript, Vite, TailwindCSS, React Router, TanStack Query, React Flow.

**Infra** — pnpm workspaces (monorepo), Docker Compose (PostgreSQL 16 + pgvector), versioned Drizzle migrations.

### Design choices

- **PostgreSQL over a graph DB** — ACID, mature tooling, and Drizzle's TypeScript integration. Graph traversal uses composite indexes on `(source_id, type)` / `(target_id, type)`; embeddings live in **pgvector** columns with HNSW indexes, so nearest-neighbour search runs in the database rather than pulling the corpus into the application.
- **Local LLM (Ollama) by default** — no API key or cost to run end-to-end; `LLM_PROVIDER=openai` swaps in OpenAI when you want higher-quality extraction. Both providers are called over their **native HTTP APIs** rather than through a model-abstraction SDK: the abstraction layer silently drifted out of version compatibility with its Ollama provider and broke the default configuration entirely, so two direct `fetch` calls are both simpler and harder to break.
- **Geometry over LLM calls** — the field subsystem replaces per-chunk LLM resolution/validation and multi-step retrieval with embeddings, PPR, and rule checks. Fewer calls, deterministic, debuggable.

---

## Prerequisites

- Node.js ≥ 18 and pnpm ≥ 8
- Docker + Docker Compose (for PostgreSQL)
- [Ollama](https://ollama.com) running locally **or** an OpenAI API key

For a fully-local setup, pull a chat model and an embedding model:

```bash
brew install ollama && brew services start ollama
ollama pull qwen2.5:7b       # extraction — recall matters most here
ollama pull llama3.2:3b      # verbalization and utility roles
ollama pull nomic-embed-text # embeddings (768-dim, matches the schema)
```

### Choosing a model per role

Extraction runs once per chunk; verbalization runs once per query and is the only
text a human reads. One model cannot be right for both, so each role routes
independently via `MODEL_<ROLE>` and may even use a different provider.

`pnpm --filter api models:compare` runs the system's own prompts against
candidates on your hardware. Measured on an Apple M4:

| role | model | median | result |
|---|---|---|---|
| extract | qwen2.5:7b | 33.9 s | 7 entities, 3 relationships |
| extract | llama3.2:3b | 11.9 s | 2 entities, 1 relationship |
| verbalize | qwen2.5:7b | 4.6 s | grounded |
| verbalize | llama3.2:3b | 3.6 s | grounded |

This inverts the obvious allocation. The small model is nearly 3× faster at
extraction and finds a third of the graph — and extraction recall is permanent,
since a sparse graph cannot be queried and fixing it means re-ingesting
everything. Verbalizing from evidence that retrieval already found is, by
comparison, easy. **Pay for extraction; economise on verbalization.**

One caution the router will warn you about: distinct local models are not free to
mix. Ollama evicts what it cannot hold resident, so a per-role table can be slower
end-to-end than a uniform one unless `OLLAMA_MAX_LOADED_MODELS` covers them.

> Field mode requires embeddings. `EMBED_PROVIDER` defaults to `openai` **independently of `LLM_PROVIDER`**, so a key-free local run needs *both* `LLM_PROVIDER=ollama` and `EMBED_PROVIDER=ollama`.

`GET /health` returns `503` and names the specific problem when any of these is
missing — it does not report `ok` while the pipeline is unable to extract
anything.

---

## Installation

```bash
git clone <repository-url>
cd manifold-strata
pnpm install

# Start PostgreSQL + pgvector (maps host :5433 → container :5432)
docker compose up -d

# Configure env (see the table below), then apply migrations
pnpm db:migrate
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
| `OLLAMA_MODEL` | `llama3.2:3b` | Default chat model for any role without its own setting |
| `MODEL_EXTRACT` … `MODEL_UTILITY` | — | Per-role model, e.g. `qwen2.5:7b` or `openai:gpt-4o-mini`. Roles: `extract`, `resolve`, `validate`, `verbalize`, `summarize`, `utility` |
| `OLLAMA_EMBED_MODEL` | `nomic-embed-text` | Ollama embedding model |
| `EMBED_PROVIDER` | `openai` (falls back to `LLM_PROVIDER`) | `ollama` or `openai` for embeddings |
| `OPENAI_API_KEY` | — | Required if any provider is `openai` |
| `OPENAI_MODEL` | `gpt-4o-mini` | OpenAI chat model |
| `OPENAI_EMBED_MODEL` | `text-embedding-3-small` | OpenAI embedding model |
| `AUTH_MODE` | — | `required` enforces scoped credentials on every `/api` route. Unset = auth disabled (dev) |
| `MCP_DOMAINS` | — | Comma-separated domains the MCP server may read. Unset = all |
| `FETCH_CONCURRENCY` | `2` | Ingest-lane workers (network/CPU: metadata, PDF, parse) |
| `PROCESS_CONCURRENCY` | `1` | Process-lane workers (GPU extraction; >1 on one GPU buys queueing, not speed) |
| `MAX_PENDING_JOBS` | `500` | Admission ceiling — bulk requests beyond it get `429` with the current depth |
| `MAX_JOB_ATTEMPTS` | `3` | Claims per job before an interrupted/failing job is failed for good |
| `VITE_API_URL` | `http://localhost:3000` | API base URL for the web app |
| `CORS_ORIGINS` | localhost 5173/5174/3000 | Comma-separated allowed origins |
| `INSTANCE_ID` | `<hostname>:<port>` | Identity used for job ownership; must differ between concurrent instances |
| `TRUSTED_PROXY_HOPS` | `0` | Proxies you control in front of the API. `0` ignores `X-Forwarded-For` entirely |
| `RESOLUTION_ANN_K` | `8` | Neighbours fetched per mention from the HNSW index during resolution |
| `RESOLUTION_CANDIDATE_LIMIT` | `2000` | **Legacy pipeline only** — nodes shown to the LLM resolver, bounded by prompt size. The field pipeline reads the index and has no window. |
| `SHUTDOWN_GRACE_MS` | `10000` | How long SIGTERM waits for in-flight jobs before leaving them to lease recovery |
| `LLM_UNAVAILABLE_ABORT_AFTER` | `3` | Consecutive unreachable-model chunk failures before abandoning a paper |
| `MAX_PDF_MB` | `50` | Hard ceiling on a downloaded PDF |
| `LLM_TIMEOUT_MS` | `120000` | Deadline for one model call |
| `EMBED_TIMEOUT_MS` | `60000` | Deadline for one embedding call |
| `PDF_TIMEOUT_MS` | `60000` | Deadline for a PDF download |
| `METADATA_TIMEOUT_MS` | `45000` | Deadline for the arXiv metadata call (arXiv is genuinely slow) |
| `JOB_LEASE_TTL_MS` | `120000` | How long a running job's lease stays valid without renewal |

---

## Running

```bash
# Issue the first admin credential (needs DB access, not HTTP — so the admin
# routes never have to be left open to bootstrap them):
pnpm --filter api auth:bootstrap -- --tenant "Acme Research"

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

- **Durable, claimable job queue** — the `jobs` table *is* the queue ([apps/api/src/queue](apps/api/src/queue/index.ts)). Routes insert rows; workers claim them with `FOR UPDATE SKIP LOCKED`, so any instance can drain any lane and a restart *resumes* the backlog instead of orphaning it — proven by killing the process mid-extraction and watching the job re-queue, reclaim, and complete with zero duplicated edges. Two lanes with separate concurrency: `ingest` (network/CPU — metadata, PDF download, parse in a worker thread) and `process` (GPU — extraction, default 1 because a single GPU serialises it anyway). Interrupted or transiently-failed jobs retry up to `MAX_JOB_ATTEMPTS`; handlers mark dead ends with `PermanentJobError` so retries are never burned reaching the same answer. PDF parsing runs in a `worker_threads` worker — measured on-thread, a 2.2 MB PDF blocked the event loop for the full ~400 ms parse (0 timer ticks); in the worker the loop stays live.
- **Failures are loud** — a chunk that fails is counted as failed, not processed; a paper whose chunks all fail is marked `failed` with the reason in `processingError`, never `completed`; a job whose pipeline threw reports `failed`. If the model is unreachable for `LLM_UNAVAILABLE_ABORT_AFTER` consecutive chunks the paper is abandoned immediately rather than re-discovering the outage on every chunk.
- **Honest health** — `GET /health` checks the database, the chat provider (including whether the configured Ollama model is actually pulled) and the embedding provider, returning `503` and naming the specific misconfiguration. It does not report `ok` while extraction cannot work.
- **Bounded external calls** — every outbound request (arXiv, PDF, LLM, embeddings) has a deadline, and PDF downloads are streamed under a size cap, so one hung or oversized response cannot permanently consume a worker slot or exhaust memory.
- **Scoped credentials and per-domain authorization** — `AUTH_MODE=required` makes every `/api` route (reads included) require a key. A credential belongs to a tenant and carries capability scopes (`read`/`write`/`admin`) plus an explicit list of granted domains, so an agent can be handed exactly one field and nothing else. Keys are `mk_<prefix>_<secret>`; only the hash is stored, and they support expiry and revocation. Unset `AUTH_MODE` for frictionless local dev — the startup banner warns loudly, because in that state every request is an anonymous admin.
- **Audit trail** — every retrieval and every *denial* is recorded with actor, action, domain and outcome, queryable at `GET /api/admin/audit`. Audit writes never block or fail a request.
- **Rate limiting** — in-memory fixed-window limits keyed on the peer address: ingest 10/min, field 30/min, graph & papers 200/min. `X-Forwarded-For` is honoured **only** for the number of proxy hops you declare via `TRUSTED_PROXY_HOPS`; otherwise it is ignored, so a client cannot mint fresh buckets by rotating the header. Responses include `X-RateLimit-*`; `429` with `Retry-After` when exceeded.
- **Idempotent reprocessing** — re-running a paper clears its previous edges/sources/propositions first, so a re-run converges instead of duplicating the paper's contribution. Nodes and edges another paper also asserts are preserved.
- **Open entity & relationship types** — node/edge `type` columns are free-form `text`, not enums. The extractor may discover new types (e.g. `task`, `model`, `loss`, `regularizes`) and they're stored without a migration; the rule validator treats unknown types gracefully (never hard-rejects), and the Explorer's type filter + colors are driven by `GET /api/graph/types` rather than a hardcoded list. `KNOWN_NODE_TYPES`/`KNOWN_EDGE_TYPES` in `packages/shared` are seed defaults only.

## Connectors (any source, one substrate)

A connector turns a source into documents the pipeline can ingest. The contract
distinguishes two kinds, and the distinction is the point:

| | source | cost |
|---|---|---|
| **unstructured** | PDFs, wikis, transcripts | one LLM call per chunk to find the entities |
| **structured** | OpenAPI documents, database schemas, manifests | **zero LLM calls** — the graph is stated, not inferred |

Both converge on the same extraction shape, so resolution, validation,
provenance, embedding and retrieval are identical downstream.

```bash
curl -X POST localhost:3000/api/ingest/connector/openapi \
  -H 'Content-Type: application/json' \
  -d '{"domain":"api-surface","url":"https://example.com/openapi.json"}'
```

Ingesting a four-operation spec produces a typed graph at `llmCalls: 0`:

```
nodes: endpoint 4 · capability 3 · schema 3 · auth 1
edges: exposes 4 · belongs_to 4 · returns 4 · accepts 3 · requires 3
```

which answers structural questions with no model involved at all — *which
endpoints require `bearerAuth`*, *what does `createUser` accept* — and
natural-language ones through the same retrieval path as any other domain. That
is the agent tool-selection problem: with hundreds of connected systems no
context window holds every schema, so picking the right endpoint is retrieval
over a typed graph.

*OpenAPI documents must be JSON; YAML needs a parser dependency.*

## Domains (multi-field isolation)

A single instance can host several research fields without their graphs bleeding into each other. A **domain** is code config ([apps/api/src/domains/](apps/api/src/domains/)) — a `DomainConfig` of preferred entity/relationship types, an extraction-prompt context, examples, and seed papers. Three ship by default: `default` (generic), `gaussian-splatting`, and `nlp`.

How isolation works:
- Papers are tagged with a `domain`; nodes, edges, and propositions are **stamped** with it. Only the canonical registry id is ever persisted, so a paper and its extracted entities can never disagree about which domain they are in.
- Entity resolution only matches within the same domain, so `attention` (NLP) and `attention` (vision) stay separate nodes — **no cross-contamination**. The domain predicate lives inside both resolution lookups, so isolation constrains the index search rather than trimming its results.
- **Unknown domains fail closed.** An unregistered `?domain=` is a `400` naming the valid domains, at every entry point (graph, papers, field, ingest, backfill, MCP). It is never silently treated as the default domain — returning one field's graph to a caller who asked for another's is the exact failure this design exists to prevent.
- **Traversal never crosses a boundary.** Subgraph, node-detail, and hierarchy views are pinned to the center node's domain, and an edge is only followed when *both* endpoints are in it. A node outside the requested scope returns `404`, not `403`, so these endpoints cannot be used to confirm other domains' entities.
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
- `GET /api/ingest/connectors` — available sources, and what each costs in LLM calls
- `POST /api/ingest/connector/:id` — ingest from any connector *(write scope)*
- `POST /api/ingest/arxiv` — ingest one paper from arXiv (optional `domain` in body) *(auth)*
- `POST /api/ingest/bulk` — ingest up to 100 papers (optional `domain`) *(auth)*
- `GET /api/ingest/status/:jobId` — durable job status
- `GET /api/ingest/batches/:id` — batch progress, computed from member jobs (`counts`, `complete`)
- `GET /api/ingest/batches` — recent batches with per-status counts
- `GET /api/ingest/seed/:domain` — curated seed arXiv IDs for a domain

### Admin *(admin scope)*
- `GET|POST /api/admin/tenants` — tenants
- `GET|POST /api/admin/principals` — credentials; the key is returned once, on creation
- `POST /api/admin/principals/:id/revoke` — revoke a credential
- `GET /api/admin/audit?outcome=&action=&principalId=&limit=` — audit trail

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

## Testing

```bash
pnpm typecheck    # api + web
pnpm test         # 117 unit tests, no services required
pnpm test:db      # 40 tests against Postgres (isolation, retrieval, failure honesty, job recovery)
```

### Measuring retrieval

Quality and latency are measured, not asserted. Both harnesses run with
`EMBED_PROVIDER=local`, a deterministic lexical embedder that needs no model
server, API key, or network:

```bash
pnpm --filter api eval                    # recall / nDCG / MRR vs vector and keyword baselines
pnpm --filter api eval -- --sweep-alpha   # tune PPR restart against measured quality
pnpm --filter api seed:load -- --nodes 100000
pnpm --filter api bench:retrieval         # latency A/B against the previous whole-corpus path
```

On a constructed corpus with known answers:

| | vector | keyword | **field (hybrid)** |
|---|---|---|---|
| overall nDCG | 57.4% | 66.7% | **87.7%** |
| overall recall | 65.0% | 66.7% | **100.0%** |
| multi-hop recall | 0.0% | 0.0% | **100.0%** |
| hub nDCG | 75.9% | 100.0% | **100.0%** |

The field pipeline is best or tied-best on every question family. It retrieves the
gold evidence for **multi-hop questions 100% of the time where both baselines
retrieve it 0% of the time**, and — since fusion — matches plain keyword search on
the direct lookups it used to lose. Caveat: this is a *constructed* corpus with a
lexical embedding space, so it measures retrieval mechanics, not language
understanding. Numbers, method and remaining gaps: [PLAN.md](PLAN.md) §10.

`test:db` uses a **separate** `knowledge_graph_test` database and is gated on
`TEST_DATABASE_URL`, so it can never write to a working database:

```bash
docker exec -it <postgres-container> createdb -U postgres knowledge_graph_test
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/knowledge_graph_test pnpm db:push
pnpm test:db
```

The suite runs on Node's built-in test runner via `tsx` — no test framework
dependency. The DB suite drives the real Hono app against real Postgres rather
than mocking the query layer, because the defects worth catching here (a scope
that widens to the wrong domain, a traversal that crosses a boundary) live in the
SQL, not above it.

## Limitations & future work

> A candid readiness assessment — what would fail a technical buyer's scrutiny, and the phased plan to fix it —
> lives in **[PLAN.md](PLAN.md)**. The short version: retrieval does not yet scale past demo size, there is no
> authorization model, and the benchmark measures compression rather than quality.

- **Single-instance worker** — the background queue is in-process with a durable `jobs` table. Jobs are owned by the instance that accepted them and hold a renewed lease, so multiple instances no longer destroy each other's work on startup — but a queued job still only exists in its owner's memory, so it is lost if that process dies before starting it (the lease then lets another instance mark it failed). True horizontal scale wants a shared queue (BullMQ + Redis); the job-table contract is designed so that swap is local to `apps/api/src/queue`.
- **Rate limiting is per-instance** — the fixed windows are in-memory, so N instances permit N× the configured limit. A shared store is the fix.
- **Auth is a data boundary, not an authorization boundary** — domains isolate *data*, but a single shared `API_KEY` grants access to all of them, and read routes are unauthenticated. Per-domain permissions need per-user keys/JWT (see below).
- **Status updates are polled** — the Dashboard/Ingestion pages poll every ~2s. Server-Sent Events would push updates and cut idle DB load.
- **Retrieval is fast but not yet proven at millions of entities** — pgvector + HNSW with a bounded working set measures 153 ms p50 / 193 ms p95 on a 100,000-entity corpus (down from 21 s). Latency still grows with corpus size through buffer-cache pressure; `halfvec`, a lower `hnsw.ef_search`, and fewer dimensions are the next levers. Reproduce with `pnpm --filter api seed:load` and `bench:retrieval`.
- **Resolution quality is unmeasured** — it now reads the whole domain through the index, so *which* candidates it sees is no longer a question. What is still unproven is the threshold: 0.82 cosine and the same-type rule were chosen by inspection, not by a harness like the one that governs retrieval. A false merge (two entities becoming one) is harder to notice after the fact than a false split, so this is the next thing worth measuring.
- **Domains are strictly isolated, with no cross-domain bridges** — each node lives in exactly one domain (see [Domains](#domains-multi-field-isolation)), so a concept studied in two fields becomes two nodes. A future "shared" namespace or a `domains text[]` tag could link them where it's genuinely the same entity. Domains are also config-as-code; a DB-editable registry + per-domain type-compatibility rules are natural extensions.
- **Hyperbolic/community layers are batch** — `train-hyperbolic` and `communities/build` are run on demand, not incrementally maintained as papers arrive.
- **Auth is a single shared key** — fine for a protected deployment; real multi-tenant use wants per-user keys / JWT and scoped permissions, with domain membership enforced per principal rather than only per query.

---

## License

MIT
