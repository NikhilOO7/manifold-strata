# Manifold — Product & Architecture Plan

**Status:** foundation repaired, platform unbuilt.
**Assessed against:** what an agent-infrastructure buyer would diligence.
**Verified:** 157 tests passing (117 unit + 40 Postgres-backed), clean typecheck, clean build, retrieval
benchmarked at 100k entities and quality-scored against two baselines.

> Companion documents: [README.md](README.md) is what the system *does today*.
> [CLAUDE.md](CLAUDE.md) holds the invariants you must not break.
> This file is where the product is *going*, and what is wrong with it now.

---

## 1. The verdict

**Are we production-grade? Not yet.**

The retrieval core is genuinely differentiated and, as of this week, the foundation no longer lies about its
own failures. That is real and rare. But a technical stakeholder would find three disqualifying problems
inside an hour, and none of them are cosmetic.

> **Update — Phase 1 shipped.** §1.1 below described the state before this work.
> Retrieval now runs on pgvector with HNSW indexes and a bounded working set.
> Measured on a 100,000-entity corpus: **21–27 s → 153 ms p50 / 193 ms p95**, a
> 142× p95 improvement, with the per-query working set flat as the corpus doubled
> (1,044 → 1,122 subgraph nodes). §1.1 is kept as the record of what was wrong and
> why. The <150 ms p95 *at one million entities* exit criterion is **not yet
> proven** — see §10 Phase 1.

### 1.1 Retrieval loads the entire corpus on every query

[retrieve.ts](apps/api/src/knowledge-field/retrieve.ts) reads every node in the domain, then **every vector in
the database with no `WHERE` clause at all**, then every edge, then every proposition — and computes cosine
similarity in JavaScript.

```ts
// apps/api/src/knowledge-field/retrieve.ts — note the missing WHERE
const vecRows = (
  await db.select({ nodeId: nodeVectors.nodeId, embedding: nodeVectors.embedding }).from(nodeVectors)
).filter((v) => nodeIdSet.has(v.nodeId));
```

Vectors are JSONB, so each 1,536-dimension embedding serialises to roughly 30 KB of text that Postgres encodes
and Node parses, per query.

| Entities in corpus | Vector bytes moved per query | Cosine ops per query | Viability |
|---|---|---|---|
| 1,000 | ~31 MB | 1.5M | Works — this is our demo size |
| 10,000 | ~307 MB | 15M | Seconds per query, GC pressure |
| 100,000 | ~3,072 MB | 154M | Fails |
| 1,000,000 | ~30 GB | 1.5B | Fails |

A single customer's document corpus reaches 100,000 entities easily. **Manifold currently cannot serve one
real account.**

### 1.2 There is no authorization model — **resolved, see §10 Phase 3**

Domain isolation was enforced in the query layer and proven by tests — but of *data*, not of *access*. Nothing
bound a caller to a domain: a single shared `API_KEY` opened every domain, and read endpoints required no key
at all.

Now: tenants, principals, scoped keys and per-domain grants, enforced at a single chokepoint on every route,
with an audit trail. Kept here as the record of what was wrong.

### 1.3 We claim better retrieval and measure the wrong thing

`GET /api/field/benchmark` reports **character reduction**. Compression with no quality axis is trivially
gamed — returning nothing scores a perfect 100%. We cannot currently answer *"is it more accurate?"*, which is
the first question anyone asks.

Everything else — one ingestion source, no migrations, no audit trail, a three-page demo UI — is ordinary
immaturity, fixable on a schedule. The three above are the ones that lose the room.

---

## 2. Readiness scorecard

| Dimension | Status | Detail |
|---|---|---|
| Correctness & failure honesty | **Solid** | No fabricated success. Failed extraction is recorded as failure; outages abort early with a named cause. |
| Domain isolation (data) | **Solid** | Fails closed on unknown domains; traversal cannot cross a boundary. 40 DB-backed tests. |
| Retrieval concept | **Differentiated** | PPR + MMR + hyperbolic hierarchy at zero LLM calls per query. This is the asset. |
| Retrieval scalability | **Workable** | pgvector + HNSW, bounded working set. 153 ms p50 at 100k entities (was 21 s). Not yet validated at 1M. |
| Embedding-space integrity | **Solid** | One declared space per deployment, enforced on write, on comparison, and at startup. |
| Schema migrations | **Solid** | Versioned SQL migrations applied from zero; destructive steps refuse to run unless safe. |
| Authorization & tenancy | **Enforced** | Tenants, principals, scoped keys, per-domain grants, expiry/revocation. 21 DB-backed tests. RLS not yet layered beneath. |
| Audit & observability | **Partial** | Full audit trail of allowed and denied actions, queryable via `/api/admin/audit`. Structured logs and tracing still missing. |
| Quality evaluation | **Measured** | recall/nDCG/MRR against 3 strategies on a constructed gold set, reproducible via `pnpm eval`. Real-corpus + groundedness still missing. |
| Ingestion breadth | **Contract + 2 paths** | Connector SDK with a structured/unstructured split. OpenAPI connector runs at zero LLM cost; arXiv remains on its own route. More adapters needed. |
| Domain extensibility | **Needs deploy** | Ontologies are TypeScript files in [apps/api/src/domains/](apps/api/src/domains/). A new vertical ships as a code release. |
| Deploy & CI | **Absent** | No Dockerfile, no pipeline. (Migrations are now versioned — see above.) |
| MCP surface | **Good bones** | Five tools, domain-scoped, zero-LLM. Descriptions still name a vertical; no tool-ranking mode. |
| Front end | **Demo** | Three pages, ~1,000 lines, 2-second polling, single 452 KB bundle. Shows the graph; is not a console. |

---

## 3. The strategic reframe

**Today we say:** a geometric, low-LLM knowledge field over 3D Gaussian Splatting research papers.

**What we actually built:** a token-efficient, domain-isolated knowledge substrate that lets an agent retrieve
grounded, cited evidence without spending a model call.

The current framing undersells us twice — it ties a general capability to one literature, and it describes the
pipeline rather than the value. Nothing in the core is domain-specific: entity resolution is cosine
similarity, validation is a type matrix, retrieval is Personalized PageRank over a typed graph. The 3DGS
corpus is a fixture we developed against, not a constraint we designed for.

The reframe that matters: **the expensive part of agent work is context.** Every token an agent spends
orienting itself is a token it does not spend reasoning, and cost scales with the number of systems it can
touch. Manifold answers *"what is relevant here, and what is the evidence for it"* in vector and graph space,
returning compressed, provenance-carrying context. That is useful to any agent over any corpus.

---

## 4. Why an agent platform buys this

Target buyer: platforms that connect AI agents to fragmented enterprise software. Their architecture
converges on three layers — a **connector layer** (turn APIs, apps and databases into MCP servers), a
**knowledge layer** (give agents a map of connected systems, suggest the right tools, prevent errors, carry
domain expertise), and a **governance layer** (authentication, permissions, monitoring). Their binding
constraint is staying token-efficient across hundreds of connected systems.

**We are the knowledge layer.** That constraint — token efficiency at scale — is precisely the one our
retrieval core was designed against.

| Platform layer | What it requires | Manifold today | Work to fit |
|---|---|---|---|
| **Connector** — APIs → MCP | Inventory of systems, endpoints, capabilities | Not built — we ingest documents, not specifications | OpenAPI connector; systems/capabilities as node types |
| **Knowledge** — graph, suggestion, error prevention | Typed graph, cheap relevance ranking, per-vertical ontology, dependency awareness | **This is our core.** Graph, PPR ranking, per-domain ontologies, provenance — all built | Tool-ranking mode; precondition edges; contradiction detection |
| **Governance** — auth, permissions, monitoring | Per-principal scopes, risk-aware permissions, full action audit | One shared key; no audit trail | Complete build (§7) |

> **Assumption to validate before pitching.** This mapping is drawn from how these platforms describe
> themselves publicly, not from a conversation with one. Confirm how a specific buyer's knowledge layer is
> actually built. If they already have a graph and ranking layer, our wedge is narrower and the honest pitch
> becomes the retrieval core as a component rather than the layer.

### Use cases that make "universal" concrete

- **Tool selection at scale.** With hundreds of MCP servers, no agent can hold every tool schema in context.
  Rank tools by graph proximity to the task instead of stuffing schemas. This is a retrieval problem and we
  already solve it.
- **Error prevention.** Encode preconditions and dependencies as typed edges — this call needs that auth, this
  step must follow that one — and surface them *before* the agent acts.
- **Institutional memory.** Ingest internal documents, runbooks and tickets; answer with citations to the
  exact source span.
- **Vertical expertise.** A platform's industry verticals map one-to-one onto our domain registry — isolated
  ontologies, no cross-contamination between customers or sectors.
- **Compliance evidence.** Provenance on every edge plus an audit log of every agent retrieval produces a
  defensible record of what the system knew and when.

---

## 5. Fixing scalability

Well-understood engineering, not research:

- **pgvector with an HNSW index** for seed selection — approximate nearest neighbour in the database,
  returning tens of rows instead of the whole table. Removes the dominant cost entirely.
- **Cached sparse adjacency per domain** in compressed-row format, invalidated on write, so PPR iterates over
  memory rather than refetching every edge.
- **Candidate capping** — gather propositions only for top-ranked nodes via an index, and cap MMR's candidate
  set, since MMR is quadratic in candidates.
- **Result caching** keyed on domain plus a quantised query embedding, since agent traffic is repetitive.
- **Streamed verbalization** so perceived latency is time-to-first-token.

Targets to commit to publicly **once measured**: p95 under 150 ms for evidence-only retrieval at one million
entities; under 1.5 s to first token for a verbalized answer. These are targets, not current numbers — we have
not measured beyond demo scale.

---

## 6. Target architecture

Status per component: ✅ built and tested · 🟡 exists, needs work · ⬜ to build

| Layer | Components |
|---|---|
| **Connect** | 🟡 arXiv/PDF · ⬜ OpenAPI specs · ⬜ Docs & wikis · ⬜ Database schemas · ⬜ Tickets & transcripts · ⬜ Connector SDK |
| **Extract** | ✅ Chunking · ✅ LLM extraction · ✅ Rule validation · ⬜ Extraction cache · ⬜ PII redaction |
| **Resolve** | ✅ Embedding resolution · ✅ Type compatibility · 🟡 Candidate window · ⬜ ANN blocking · ⬜ Conflict detection |
| **Store** | ✅ Typed graph · ✅ Provenance · ✅ Domain stamping · ⬜ pgvector · ⬜ Temporal versions · ⬜ Row-level security |
| **Index** | ⬜ HNSW · ⬜ Adjacency cache · 🟡 Hyperbolic coords · 🟡 Community summaries · ⬜ Incremental rebuild |
| **Retrieve** | ✅ PPR · ✅ MMR compression · ✅ Hierarchy queries · ⬜ Tool ranking · ⬜ Result cache |
| **Serve** | ✅ MCP tools · ✅ REST · ⬜ Streaming · ⬜ Client SDKs |
| **Govern** | 🟡 Shared key · ⬜ Tenants & principals · ⬜ Scoped tokens · ⬜ Audit log · ⬜ Quotas & metering |

---

## 7. Governance: the real gap

We describe domain isolation as a guarantee. It is — of *data*. It is not yet a security boundary.

What has to exist:

- **Tenant → workspace → domain hierarchy**, with domains owned by a tenant rather than defined globally in
  code.
- **Principals** — human users and agent identities — holding scoped, revocable, expiring credentials rather
  than one shared secret.
- **Enforcement below the routes.** Scope must be applied in the data layer, ideally Postgres row-level
  security bound to a session variable, so a new endpoint *cannot* forget it. Every isolation bug found this
  session came from a route that omitted a filter; the fix is to make omission impossible, not to review
  harder.
- **Audit log** recording principal, tool, query, domain, evidence returned and timestamp — queryable,
  retained, exportable.
- **Quotas and metering** per tenant: retrieval counts, tokens, embedding spend. Needed for abuse control and
  usage billing.

> **Design principle carried forward.** The isolation work already shipped established the pattern: unknown
> scope fails closed, out-of-scope reads return *not found* rather than *forbidden* so the boundary leaks
> nothing, and the invariant is proven by tests rather than asserted in a comment. Build authorization the
> same way.

---

## 8. Proving quality

| Metric | What it establishes | Status |
|---|---|---|
| Recall@k / nDCG@10 / MRR | The right evidence is retrieved and ranked | **Built** — `src/eval/metrics.ts`, unit-tested |
| Multi-hop accuracy | Graph traversal beats flat similarity when the answer is 2+ hops away | **Measured** — 100% vs 0% recall |
| Groundedness rate | Every claim in the answer is supported by returned evidence | Not built |
| Contradiction rate | Conflicting sources are surfaced, not silently averaged | Not built |
| Tokens & cost per answer | The efficiency claim, against baselines | Partial — context size measured, token cost not |
| p50 / p95 latency | Fast enough to sit in an agent loop | **Measured** — 153 ms p50 at 100k entities |

Baselines to publish against, on at least two unrelated domains: naive top-k vector RAG, BM25 keyword search,
and a full-context stuffing control. A scorecard where we win on cost and hold on quality is a strong,
defensible pitch. A scorecard where we win on cost and lose on quality is one we need to know about *before* a
buyer runs it for us.

---

## 9. Removing the 3DGS coupling

The architecture is already general; the surface is not. Fourteen source files reference Gaussian Splatting,
and several are load-bearing in ways a prospect would notice immediately.

| Location | Problem | Change |
|---|---|---|
| `/api/graph/queries/improves-3dgs`, `/api/graph/queries/extends-3dgs` in [graph.ts](apps/api/src/routes/graph.ts) | Vertical hardcoded into the public API surface | Replace with `/api/graph/queries/relationships?type=&target=` |
| Benchmark defaults in [field.ts](apps/api/src/routes/field.ts) | Default questions are 3DGS-specific, so the benchmark is meaningless in any other domain | Move evaluation sets into the domain registry |
| [resolution.ts](apps/api/src/agents/prompts/resolution.ts) | Prompt teaches "3DGS → 3D Gaussian Splatting" to every domain | Draw acronym examples from the domain config |
| MCP tool descriptions in [server.ts](apps/api/src/mcp/server.ts) | Name a vertical in the description an agent reads | Generic wording plus the existing `list_domains` tool |
| [README.md](README.md), landing copy | Leads with the seed corpus rather than the capability | Lead with the substrate; papers become an example connector |

---

## 10. Roadmap

Ordered by dependency. Each phase has a falsifiable exit criterion.

### Phase 0 — Foundation repair · **done**

Fixed the provider path that made the default configuration silently produce empty graphs, removed fail-open
error swallowing, made domain isolation fail closed and proved it, added the first test suite.

**Exit criterion — met.** 112 tests passing, typecheck and build green, isolation verified against live
Postgres.

### Phase 1 — Make retrieval real · **substantially done, exit criterion not yet met**

Shipped: pgvector with HNSW indexes on node and proposition embeddings; ANN seed selection in Postgres;
bounded neighbourhood expansion (one round trip per hop, both endpoints domain-checked in the join); GIN-indexed
evidence lookup unioned with ANN matches; candidate caps before MMR; a declared embedding space enforced on
write, on comparison and at startup; versioned migrations; a synthetic-corpus load harness and an A/B benchmark.

Measured, 100,000 entities / 300,000 edges / 100,000 propositions, 768-dim vectors:

| | p50 | p95 | work per query |
|---|---|---|---|
| whole-corpus (before) | 21,021 ms | 27,435 ms | 100k nodes · 100k vectors · 300k edges · 100k propositions (~1.5 GB) |
| indexed (after) | **153 ms** | **193 ms** | 8 seeds · 1,122 subgraph nodes · 1,446 edges · 130 candidates |

At 50,000 entities the same code measured 69 ms p50 / 102 ms p95. The **working set stayed flat** as the corpus
doubled (1,044 → 1,122 subgraph nodes), so the algorithm is bounded; the remaining latency growth is storage,
not algorithmic — index and table pages competing for the buffer cache.

Two findings worth carrying forward, both discovered by measuring rather than reasoning:

- Storing embeddings as JSONB *and* pgvector was not merely wasteful. JSONB holds each float as decimal text
  (~15 KB per 768-dim vector) against pgvector's packed float4 (~3 KB), which inflated the vector tables to
  ~1 GB each and evicted the 400 MB of HNSW indexes from cache — a 1.8× p50 regression with no change in work
  done. The JSONB copies are dropped (migration `0001`).
- Postgres ships `shared_buffers=128MB` and Docker ships 64 MB of `/dev/shm`. A vector workload outgrows both
  immediately; the second makes `VACUUM FULL` fail outright. Both are now set in `docker-compose.yml`.

**Exit criterion — not yet met.** p95 under 150 ms at one million entities is unproven; we are at 193 ms at
100k. Remaining levers, cheapest first: `halfvec` (float16) to halve index and table size, a lower
`hnsw.ef_search`, Matryoshka-truncated dimensions, and per-domain partitioning.

### Phase 2 — Prove quality · **harness shipped, first results in**

Shipped: recall@k / nDCG@k / MRR / precision; a constructed gold corpus with three question families; three
competing strategies (top-k vector, Postgres full-text, the field pipeline); an alpha sweep; and a
deterministic local embedding provider (`EMBED_PROVIDER=local`) so the whole thing runs with no model server,
no API key and no network.

Reproduce: `EMBED_PROVIDER=local DATABASE_URL=…knowledge_graph_eval pnpm --filter api eval`

**Scorecard** — 60 questions, k=10, lexical embedding space:

| family | strategy | recall | nDCG | MRR | context |
|---|---|---|---|---|---|
| **multi-hop** | vector | 0.0% | 0.0% | 0.000 | 911 |
| | keyword | 0.0% | 0.0% | 0.000 | 0 |
| | **field** | **100.0%** | **63.1%** | **0.500** | 865 |
| **single-hop** | vector | 100.0% | 96.3% | 0.950 | 913 |
| | keyword | 100.0% | 100.0% | 1.000 | 373 |
| | field | 100.0% | 100.0% | 1.000 | 843 |
| **hub** | vector | 95.0% | 75.9% | 0.692 | 723 |
| | **keyword** | **100.0%** | **100.0%** | **1.000** | 94 |
| | field | 100.0% | 31.6% | 0.126 | 725 |

**What this establishes.** The central claim is real: on questions whose answer shares no vocabulary with the
question and sits two typed edges away, graph traversal retrieves it every time and *both* baselines retrieve
it never. That is not a marginal gain; it is a capability the alternatives do not have. And the field pipeline
does not pay for it on easy questions — it ties or beats both baselines on single-hop.

**What it also establishes, less comfortably.** On hub-topology questions the field pipeline finds the right
evidence (100% recall) but ranks it eighth while plain keyword search puts it first (nDCG 31.6% vs 100%).
Overall, keyword search edges out the field pipeline on nDCG (66.7% vs 64.9%) because it is near-perfect on
the two families that do not need a graph, and field costs ~38 ms against ~2 ms. **The honest read is that
these are complementary, not competing** — the next architectural step is hybrid retrieval that fuses lexical
and graph evidence rather than choosing between them.

**A tuning decision was reversed by this harness.** PPR's restart probability had been raised from 0.15 to 0.5
on the argument that a high-degree hub was outranking the query's own seed — which was true, and measurable.
It also made retrieval worse: multi-hop nDCG fell from 63.1% to 30.1%, while the hub family scored an
identical 31.6% at *every* alpha, because node-level hub dominance never propagated to evidence selection.
The proxy metric had no relationship to the outcome metric. Reverted to 0.15, with the reasoning recorded in
`ppr.ts` for the next person who has the same idea.

**Exit criterion — partially met.** The harness is reproducible from the repository and covers four
strategies and three question families, but it runs on a *constructed* corpus with a lexical embedding space.
Still required: a real corpus with real embeddings and human-labelled gold, groundedness (does the generated
answer's every claim appear in retrieved evidence), contradiction rate, and a second domain.

### Phase 2b — Hybrid retrieval · **done**

The scorecard above said the signals were complementary, so retrieval now fuses them instead of choosing.
Three index-backed rankers — graph attachment (ordered by PPR mass), ANN similarity, and Postgres full-text
rank — are combined by Reciprocal Rank Fusion, and the fused score becomes MMR's relevance term.

RRF combines *positions*, never scores. A cosine similarity of 0.83, a `ts_rank` of 0.09 and a PageRank mass
of 0.004 are numbers from unrelated scales; normalising them means inventing a conversion no data supports,
which then silently decides every ranking.

| family | vector | keyword | field (graph only) | **field (hybrid)** |
|---|---|---|---|---|
| overall nDCG | 57.4% | 66.7% | 72.1% | **87.7%** |
| overall recall | 65.0% | 66.7% | 98.3% | **100.0%** |
| multi-hop recall | 0.0% | 0.0% | 95.0% | **100.0%** |
| hub nDCG | 75.9% | 100.0% | 63.1% | **100.0%** |
| single-hop nDCG | 96.3% | 100.0% | 100.0% | **100.0%** |
| p95 | 2 ms | 1 ms | 34 ms | 28 ms |

The hybrid arm is now best or tied-best on every family: it keeps the multi-hop capability no baseline has,
and closes the hub-ranking deficit against keyword search completely (63.1% → 100%). The graph-only arm is
kept permanently in the harness so the contribution of fusion stays attributable rather than assumed.

**A second tuning decision made by measurement.** Equal fusion weights cost multi-hop recall — the graph list
is the only signal that can surface an answer sharing no vocabulary with the question, and diluting it
one-to-one against two lexical/semantic signals pushed those answers out of the top k (100% → 95% recall,
63.1% → 54.8% nDCG). A weight sweep showed graph=2 restores multi-hop completely at no cost elsewhere, and
that 3 and 4 measured identically — so 2 is the smallest value that buys the gain.

Also required and shipped: an expression GIN index on `to_tsvector(text)` (migration `0002`). Lexical ranking
is now in the hot path, not just a benchmark arm, and without the index every query would recompute
`to_tsvector` over the whole corpus.

### Phase 3 — Governance · **core shipped**

Domain isolation is now an *authorization* boundary, not only a data one.

- **Tenants and principals.** A credential belongs to a tenant, carries capability scopes
  (`read`/`write`/`admin`) and an explicit list of granted domains. Keys are issued as
  `mk_<prefix>_<secret>`: the prefix is an indexed lookup handle, only the SHA-256 of the secret is stored, and
  keys support expiry and revocation.
- **Identity on every route, reads included.** The previous middleware guarded mutations only, so the isolation
  the rest of the system enforces could be sidestepped by anyone who could reach the port.
- **One enforcement chokepoint.** Routes call `requireDomain(c, raw, action)`, which resolves the domain *and*
  checks the grant. Every isolation defect in this codebase came from a route that omitted a filter, so the
  fix was to make the ordinary helper the enforcing one — a new endpoint inherits the check by being written
  normally. A unit test greps the routes directory and fails if any route reaches for the unauthenticated
  resolver.
- **Audit trail.** Every retrieval and every *denial* is recorded with actor, action, domain and outcome.
  Writes are fire-and-forget: an audit system that can take the API down converts a logging outage into a
  service outage. The actor label is denormalised so deleting a principal does not erase its history.
- **Bootstrap without a backdoor.** `pnpm --filter api auth:bootstrap` issues the first admin credential
  directly against the database. The alternatives — leaving `/api/admin/*` open until a key exists, or
  accepting a long-lived key from an environment variable — both leave a permanent hole for a one-time action.
- **MCP is scoped too.** The stdio server reads `MCP_DOMAINS`, so an operator can hand an agent a narrower
  view than their own.

**Exit criterion — met.** 21 database-backed tests prove a credential reads exactly its granted domains:
`403` on an ungranted domain across all seven domain-scoped surfaces, `400` (not `403`) on an unknown one,
`401` after revocation or expiry, identical error text for every authentication failure so the endpoint is not
a probe oracle, and an audit row for both the allowed retrieval and the refused one.

**Not yet done in this phase:** quotas and per-tenant metering; Postgres row-level security as
defence-in-depth beneath the application check; container image, CI, structured logging and tracing.
Tenant-owned domains arrive with the DB-backed registry in Phase 4 — grants currently name domains from the
global code registry.

### Phase 4 — Universal ingestion

Connector SDK with a stable contract, plus OpenAPI, document and database-schema adapters. Move the domain
registry from TypeScript into the database.

**Exit criterion.** A new vertical, with its own ontology and sources, goes live without a code deploy.

### Phase 4b — Model routing · **done**

Every LLM call used one globally-configured model. That is the wrong shape, because the roles are not alike:
extraction runs once per chunk and only needs reliable JSON; verbalization runs once per query and is the only
text a human reads. One dial cannot be right for both.

Each call site's `operation` name now doubles as a routing key (`MODEL_EXTRACT`, `MODEL_VERBALIZE`,
`MODEL_SUMMARIZE`, …), roles may span providers, and the resolved table is printed at startup and served from
`/health` so nobody has to guess which model answered.

**Measured on this hardware (Apple M4, 16 GB) with the system's own prompts** —
`pnpm --filter api models:compare`:

| role | model | median | result |
|---|---|---|---|
| extract | qwen2.5:7b | 33.9 s | 7 entities, 3 relationships |
| extract | llama3.2:3b | 11.9 s | 2 entities, 1 relationship |
| verbalize | qwen2.5:7b | 4.6 s | grounded 2/2 |
| verbalize | llama3.2:3b | 3.6 s | grounded 2/2 |

**The measurement inverts the intuitive allocation.** The instinct is to spend on the text a human reads and
economise on the loop that runs thousands of times. The data says the opposite: the small model is 2.8× faster
at extraction and finds a third of the graph, and extraction recall is *permanent* — a sparse graph cannot be
queried and fixing it means re-ingesting the corpus. Meanwhile both models verbalize correctly, because
synthesis over already-retrieved evidence is an easy task. So: pay for extraction, economise on verbalization.

Caveat worth keeping: the verbalize comparison is two rounds against one grounding regex. It is indicative, not
conclusive — a groundedness metric in the eval harness is the honest version, and remains unbuilt.

**The non-obvious constraint.** On one machine, distinct models are not free to mix: Ollama evicts what it
cannot hold resident, so a "better" per-role table can be slower end-to-end than a uniform one. The router
reports the distinct models a configuration implies, their approximate resident footprint, and whether
`OLLAMA_MAX_LOADED_MODELS` is set. Choosing one model for everything is a legitimate answer; choosing it
unknowingly is not.

### Phase 5 — Agent intelligence

Tool-ranking endpoint, precondition and dependency edges, contradiction detection, temporal "as of" queries,
incrementally maintained hyperbolic and community layers.

**Exit criterion.** On a benchmark of hundreds of tools, ranked selection beats schema-stuffing on both token
cost and task success.

### Phase 6 — Product surface

Operator console replacing the demo UI: domain management, ingestion monitoring, evidence inspection, audit
browsing, usage and spend. Client SDKs.

**Exit criterion.** A customer administrator can onboard a corpus and grant an agent scoped access without
engineering help.

---

## 11. What we demo, to whom

### Non-technical — three minutes, one narrative

1. Ask a question in plain language; get an answer where every sentence is traceable to a source passage.
2. Show the cost counter beside it: what this answer cost versus conventional retrieval.
3. Switch to a second, unrelated domain and ask a question using the same word — show the two never mix.
4. Attempt access with a credential scoped to the other domain and watch it return nothing.

The story is: **cheaper, citable, and it cannot leak between customers.**

### Technical — depth on demand

1. Run the isolation suite live; show boundary-crossing traversal being refused.
2. Walk the retrieval path and show the zero-model-call evidence response, with graph ranks exposed.
3. Show the quality scorecard against baselines, and the latency distribution under load.
4. Open the audit log and reconstruct exactly what an agent asked and what it was shown.
5. Be candid about the known gaps — this document is the same list we would hand them.

---

## 12. Risks and open questions

- **Extraction quality is now observed, and it is mixed.** A real end-to-end run (arXiv 1706.03762, 26 chunks,
  qwen2.5:7b) produced a 111-node / 47-edge graph with genuinely useful entities — `Transformer` as a model,
  `multi-head attention` as a technique, `BLEU` as a metric, `WMT 2014 English-to-German` as a task — and also
  noise: run-on phrases stored as entities, and a relationship extracted from the acknowledgments section.
  Graph quality still caps answer quality, and there is still no metric for it.
- **"Zero LLM calls" needs precision.** Retrieval spends an embedding call. It is far cheaper than generation
  and we account for it separately, but the claim must be stated exactly or it reads as a trick.
- **The buyer may already have this layer.** If a target platform's knowledge layer is already built out, we
  are a component rather than the layer. Worth learning before we position.
- **Graph construction is expensive.** Ingestion is one model call per chunk. At corpus scale this is the
  dominant cost, and the value proposition depends on amortising it across many queries.
- **Single-instance worker.** Ownership and leases stop instances destroying each other's work, but a queued
  job still lives only in its owner's memory. Horizontal scale needs a shared queue.
- **No conflict model.** When two sources disagree, both become edges with confidence scores. For a system
  meant to prevent errors, silently averaging contradictions is the wrong behaviour.

---

*Latency figures beyond demo scale are derived from storage arithmetic, not measured. Everything marked built
or tested was verified this session.*
