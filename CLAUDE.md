# CLAUDE.md — Manifold-strata

Load this before doing anything in this repository.

**Companion docs:** [README.md](README.md) is what the system does today. [PLAN.md](PLAN.md) is the critical
readiness assessment and the sequenced roadmap — read it before proposing what to build next, and update it
when a phase's exit criterion is met.

---

## The mandate

Act as co-founder and CTO of Manifold-strata. Keep moving the product forward every
session — treat it as your only lifeline and build the best product you are capable
of. This product sets the standard for how good a co-founder, CTO, and visionary you
are. Bias to shipping: find the highest-leverage item on the build queue, do it
excellently, verify it, and report honestly.

## The engineering mandate

Bring the full weight of your engineering knowledge — system design, solution
architecture, distributed systems, security, and hard-won production judgment — to
bear on the system as it actually is, not as the docs describe it. Before building
anything new on a surface, hunt that surface for gaps: fail-open paths, cross-tenant
seams, silent error swallowing, race conditions, missing timeouts, dead safety code
that looks like protection. **Fix causes, not symptoms**: trace every defect to its
root and repair it there, so the entire class dies — a patched symptom is a bug with
better camouflage. **Foundations outrank features**: a feature built on a cracked
foundation is debt disguised as progress, and in a governance product, a foundation
crack *is* the product breaking. Verify every claim of "fixed" (typecheck, lint,
tests, runtime checks — and say plainly what could not be verified).

---

## What this product is

Manifold ingests research papers and builds a queryable knowledge graph, storing and
retrieving knowledge as a **geometric field** rather than calling an LLM at every
step. Entity resolution runs in embedding space, relationship validation in rule
space, retrieval via Personalized PageRank + MMR compression. Ingestion spends one
LLM call per chunk; a full multi-hop query spends one.

**A single instance hosts several isolated research domains.** That isolation is not
a feature — it is the product's central correctness claim. Treat any path that can
leak, merge, or mis-scope data across domains as a P0.

## Architecture map

```
apps/api/src/
  routes/        HTTP surface (graph, ingest, papers, field, domains) + errors.ts
  domains/       Domain registry (config-as-code) + strict resolution + SQL filter
  agents/        Legacy 3-agent LLM pipeline (PIPELINE_MODE=legacy)
  knowledge-field/  resolve-embed, validate-rules, ppr, compress, hyperbolic,
                    communities, retrieve  ← the geometric layer
  services/      llm (Ollama|OpenAI), embeddings, http (timeouts), pdf, metrics
  pipeline/      processor.ts — field/legacy orchestration, the write path
  jobs/          job handlers (arXiv ingest, paper processing) + registry
  queue/         durable claimable queue (SKIP LOCKED) with fetch/process lanes
  middleware/    auth, rate-limit
  connectors/    source adapters (contract + registry); structured ones emit a
                 graph directly and cost zero LLM calls
  auth/          keys, principals, audit, bootstrap CLI
  eval/          retrieval quality harness (metrics, corpus, strategies)
  mcp/           MCP stdio server over the same field functions
  db/            Drizzle schema + connection
apps/web/        React + Vite UI
packages/shared/ shared types
```

---

## Invariants — do not break these

1. **Domains fail closed.** `resolveDomain()` throws `UnknownDomainError` on an
   unregistered id; `resolveStoredDomain()` does the same for a value read from the
   database. Never use the lenient `getDomain()` to decide what to read, write, or
   filter — it exists only for prompt context. A silent fallback to `default` is how
   this system previously leaked one field's graph to a caller asking for another's.
2. **A subgraph never spans domains.** Traversal is pinned to the center node's
   domain, with or without an explicit `?domain=`. Applies to
   `GET /api/graph/subgraph`, `GET /api/graph/nodes/:id`, `/api/field/hierarchy/:id`,
   and the MCP `get_subgraph` tool. Filter on **both endpoint nodes**, not just
   `edges.domain` — a boundary-crossing edge carries one side's stamp, so an
   edge-only filter still drags the far node in. (A test caught exactly this.)
3. **Out-of-scope must 404, not 403.** A node outside a requested domain is reported
   as not found, so the endpoint cannot be used to confirm other domains' entities.
4. **Persist resolved ids only.** `papers.domain` stores the canonical registry id,
   never the raw request string. A paper and its extracted entities must never
   disagree about which domain they are in.
5. **No fabricated success.** The LLM layer throws (`LLMUnavailableError`,
   `LLMStructuredOutputError`); it never returns an empty-but-successful result.
   A chunk that fails increments `chunksFailed`, not `chunksProcessed`. A paper whose
   chunks all failed is `failed`, never `completed`. A job whose pipeline threw is
   `failed`, never `completed`.
6. **Every outbound request has a deadline.** Go through `services/http.ts`
   (`fetchWithTimeout`, `readBodyWithLimit`). Bare `fetch` in a worker path is a
   permanently-consumed concurrency slot waiting to happen.
7. **Every edge has provenance.** Edge + `sources` row are written in one
   transaction. An edge with no source is an unfalsifiable claim.
8. **Processing is idempotent.** Re-running a paper clears its prior contribution
   first (`clearPaperContributions`) — nodes are shared and survive, edges another
   paper also asserts survive.
9. **The jobs table IS the queue.** Work is enqueued by inserting a row
   (`status='queued'`, no owner) and executed by claiming it —
   `claimNextJob`'s `FOR UPDATE SKIP LOCKED` update, nothing else. Never hold
   queued work in process memory; that shape loses the backlog on every restart,
   which is fatal for batches that run for hours. Claiming sets owner/lease and
   increments `attempts`; startup recovery RE-QUEUES interrupted work (own jobs
   and expired leases) until `MAX_JOB_ATTEMPTS`, then fails it honestly. It must
   still never touch another instance's live-leased job — that regression
   shipped once. Handlers signal unretriable failures with `PermanentJobError`;
   everything else is presumed transient. The process-lane handler always clears
   the paper's prior contribution first, so retries cannot duplicate edges
   (proven by a kill-9/restart run). Batch progress is always computed from
   member jobs, never from counters.
10. **An outage is decided once.** `LLMUnavailableError` for
    `LLM_UNAVAILABLE_ABORT_AFTER` consecutive chunks abandons the paper. Content
    failures (unparseable JSON) stay per-chunk.
11. **Retrieval fuses three signals; never silently drop one.** Graph, vector and
    lexical rankings are combined by RRF (`knowledge-field/fuse.ts`) using rank
    positions only — the underlying scores are on incomparable scales. Weights
    default to graph=2/vector=1/lexical=1, chosen by sweep. Removing or
    down-weighting the graph signal costs multi-hop recall, which no other signal
    provides; removing the lexical one costs 37 points of hub nDCG.
12. **Nothing in the retrieval hot path scans a table.** Seeds come from the HNSW
    index, the graph comes from a bounded hop expansion, evidence comes from the
    GIN index and a second ANN query, and everything is capped before MMR (which
    is quadratic in candidates). `RetrieveResult.stats` reports the working set
    precisely so a regression here is visible; the DB tests assert on it.
13. **One embedding space per deployment.** `EMBEDDING_SPACE` declares it; writes
    validate width, comparisons refuse mismatches, and startup checks the column.
    Changing the model is a migration plus a re-embed, never a config edit —
    `cosine()` used to silently truncate to the shorter operand and return a
    confident number for vectors from different models.
14. **Schema changes ship as migrations.** `pnpm db:migrate`, never `db:push`, on
    anything holding data. Destructive steps guard themselves (see `0001`, which
    refuses to drop a column unless its replacement is populated).

## Known gaps (honest state — next on the queue)

- The queue is now durable and multi-instance (Postgres SKIP LOCKED claims), so
  queued work survives restarts and any instance can drain any lane. BullMQ/Redis
  remains the escape hatch only if volume ever outgrows Postgres — the claim
  contract is local to `queue/index.ts`.
- Rate limiting is per-instance and in-memory; N instances allow N× the limit.
- Authorization is enforced in the application layer only. Postgres row-level
  security beneath it would make a forgotten filter harmless rather than merely
  detectable. Quotas and per-tenant metering are unbuilt.
- Domains are still owned by the code registry, not by tenants; grants name global
  domain ids. Tenant-owned domains arrive with the DB-backed registry.
- Retrieval is on pgvector + HNSW and measures 153 ms p50 at 100k entities, but the
  1M-entity target is unproven and latency still grows with corpus size through
  cache pressure. Next levers: `halfvec`, lower `hnsw.ef_search`, fewer dimensions.
- Resolution now reads the index (invariant 24), so *which* candidates it sees is
  settled. What is unproven is the threshold: 0.82 cosine and the same-type rule
  were chosen by inspection, not by a harness like the one governing retrieval.
  A false merge is harder to notice than a false split — measure this next.
- Hyperbolic/community layers are batch, not incrementally maintained.
- No cross-domain bridges: the same concept studied in two fields is two nodes.

---

16. **Authorization goes through the chokepoint.** Routes call
    `requireDomain(c, raw, action)` — never `resolveDomain` — so a new endpoint is
    scoped by being written normally rather than by remembering a check. A unit
    test greps `src/routes/` and fails if that is bypassed. Mutations additionally
    call `requireScopeOn(c, 'write'|'admin', action)`.
17. **Deny quietly, log loudly.** Every authentication failure returns identical
    text (no probe oracle); the reason goes to the audit log. Denials are audited
    as carefully as successes — a trail of only successes cannot answer the
    question asked after an incident.
19. **Entity and relationship types are open.** Any non-empty string a domain,
    extractor, or connector uses is stored as written. Do not reintroduce a
    normaliser that folds unknown types into `concept`/`uses` — one existed, it
    silently contradicted the documented behaviour, and it discarded the entire
    taxonomy of the first structured source that used it.
20. **Structured connectors must not fall back to text extraction.** If a
    connector reports `structured: true`, every unit it emits carries an
    `extraction`. A unit that arrives with only `text` turns a free import into a
    per-operation model bill; the connector tests assert this.
22. **Model choice per role is decided by `models:compare`, not by intuition.**
    The measured answer on this hardware is the opposite of the instinct: spend on
    extraction (recall is permanent — a sparse graph cannot be queried and fixing
    it means re-ingesting), economise on verbalization (synthesis over retrieved
    evidence is easy). Roles route via `MODEL_<ROLE>`; the table is printed at
    startup and served from `/health`.
24. **Entity resolution reads the index, never a window.** Candidates come from
    `knowledge-field/resolve-candidates.ts`: one batched equality probe on
    `nodes_normalized_name_idx` and one batched k-NN lateral over
    `node_vectors_embedding_hnsw`, both scoped to the domain. Never reintroduce a
    "most recent N nodes" preload — that shape made identity depend on creation
    order, so past N nodes a domain forked entities it already contained and only
    logged about it. Filtered ANN asks for `hnsw.iterative_scan` so a domain that
    is a small slice of the corpus still gets K eligible neighbours instead of
    silently fewer. Mentions that are new to the graph are also compared against
    *each other* before minting identities — one chunk naming a thing twice is
    the same defect on the other side of the batch boundary. And never use
    `ilike` where `eq` is meant: on 100k nodes it was a Seq Scan discarding every
    row (cost 3039) against an index scan at cost 12.
25. **A signal is a shutdown, not a crash.** SIGTERM/SIGINT close the HTTP
    server, stop claiming, drain in-flight work for `SHUTDOWN_GRACE_MS`, then
    close the pool. Shutdown must NOT release still-running claims — the job is
    still executing here, so another instance would run the same extraction
    concurrently. Leave it leased; expiry is the safe handover, and it is
    bounded.

23. **Retrieval tuning is decided by the harness, not by argument.** Run
    `pnpm --filter api eval` before and after any change to PPR, MMR, fusion
    weights, seed count, or hop limits. Two tuning decisions have already been
    reversed by measurement: an alpha change that looked correct in isolation cost
    33 points of multi-hop nDCG (`ppr.ts`), and equal fusion weights cost 5 points
    of multi-hop recall (`retrieve.ts`). Both sweeps are built in:
    `--sweep-alpha`, `--sweep-weights`.

## Working rules

- **Verify, then claim.** `pnpm --filter api typecheck`, `pnpm --filter api test`,
  and a real request against a running API. State plainly what you could not verify.
- **Read the code, not the README.** The README has been wrong about working
  behaviour before. When they disagree, the code is the truth and the README is a bug.
- **Prefer the root fix.** If a bug can recur in a sibling call site, you fixed the
  symptom.
- **Leave the docs true.** If you change behaviour, update `README.md` and this file
  in the same change.

## Commands

```bash
docker compose up -d               # Postgres + pgvector on :5433
pnpm db:migrate                    # apply versioned migrations (never db:push)
pnpm dev                           # api :3000 + web :5173
pnpm --filter api typecheck        # tsc --noEmit
pnpm --filter api test             # vitest
pnpm --filter api test:db          # tests incl. Postgres-backed isolation suite
pnpm --filter api mcp              # MCP server on stdio
pnpm --filter api models:compare   # per-role model trade-offs on this hardware
pnpm --filter api eval             # retrieval quality scorecard
pnpm --filter api eval -- --sweep-alpha
pnpm --filter api seed:load        # synthetic corpus for load testing
pnpm --filter api bench:retrieval  # latency A/B vs the old whole-corpus path
```

`EMBED_PROVIDER=local` gives deterministic lexical embeddings with no model
server — enough to run the eval harness and the DB tests anywhere. It is opt-in
only; nothing falls back to it.

Local key-free setup needs **both** `LLM_PROVIDER=ollama` and `EMBED_PROVIDER=ollama`
(`EMBED_PROVIDER` defaults to `openai` independently of `LLM_PROVIDER`), plus
`ollama pull llama3.2:1b` and `ollama pull nomic-embed-text`. `GET /health` returns
503 and names the specific misconfiguration when this is wrong.
