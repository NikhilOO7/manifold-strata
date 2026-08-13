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
8. **Processing is idempotent, per chunk.** Re-running clears prior contribution
   first — but only for the chunks about to run. `sources.chunk_index` attributes
   every claim to a chunk and `paper_chunks` records what completed, so
   `resumePaper` (the default for a retry) keeps finished chunks and
   `clearChunkContributions` undoes only the rest. `reprocessPaper` — clear
   everything, start at chunk 0 — is now the explicit `?rebuild=true` path, for
   a changed extractor or model. Nodes are shared and survive; an edge another
   paper *or another kept chunk* still asserts survives. A checkpoint is only
   honoured while its `contentHash` matches: chunk N meaning different text is
   how resume would silently mis-attribute evidence.
9. **The jobs table IS the queue.** Work is enqueued by inserting a row
   (`status='queued'`, no owner) and executed by claiming it —
   `claimNextJob`'s `FOR UPDATE SKIP LOCKED` update, nothing else. Never hold
   queued work in process memory; that shape loses the backlog on every restart,
   which is fatal for batches that run for hours. Claiming sets owner/lease and
   increments `attempts`; startup recovery RE-QUEUES interrupted work (own jobs
   and expired leases) until `MAX_JOB_ATTEMPTS`, then fails it honestly. It must
   still never touch another instance's live-leased job — that regression
   shipped once. **An interruption is not a failure.** `jobs.failures` counts
   handler errors and is what `MAX_JOB_ATTEMPTS` gates; `jobs.attempts` counts
   claims and is gated by the far wider `MAX_JOB_CLAIMS` crash-loop ceiling.
   Conflating them meant a restart spent the same budget as a real error, so
   three `tsx watch` reloads permanently failed papers that had never thrown —
   and the recorded reason admitted it ("Interrupted and out of retry
   attempts"). Never gate a give-up decision on a counter that a deploy
   increments. Handlers signal unretriable failures with `PermanentJobError`;
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
12b. **Ranking happens where the data is.** Any "top N by degree/score" is
    computed in SQL over the whole domain, never by pulling a page of rows to
    the client and sorting there. `GET /api/graph/hubs` exists because the
    Explorer did the latter: 500 nodes + 500 edges counted in the browser, so
    "most connected" silently meant "whichever hubs fell in the window", and
    whole entity types were unreachable. A capped list must also say it is
    capped and offer the rest.
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
- `PROCESS_CONCURRENCY` defaults to 1 as a *conservative* choice, not a measured
  optimum — the old comment claimed extraction "serialises inside Ollama
  (measured)" and that measurement did not exist. `pnpm --filter api
  bench:lane-width` decides it on the target hardware: it alternates arm order so
  a drifting machine cannot fake a result, refuses to run while a live lease
  holds the GPU, and calls a result inconclusive when it is smaller than the
  run-to-run spread.
- Rate limiting is per-instance and in-memory; N instances allow N× the limit.
- Authorization is enforced in the application layer only. Postgres row-level
  security beneath it would make a forgotten filter harmless rather than merely
  detectable. Quotas and per-tenant metering are unbuilt.
- Domains are still owned by the code registry, not by tenants; grants name global
  domain ids. Tenant-owned domains arrive with the DB-backed registry.
- Retrieval is on pgvector + HNSW and measures 153 ms p50 at 100k entities, but the
  1M-entity target is unproven and latency still grows with corpus size through
  cache pressure. Next levers: `halfvec`, lower `hnsw.ef_search`, fewer dimensions.
- **Extraction quality is now the binding constraint on the graph, not plumbing.**
  With `mentions` edges in place the graph is connected, but only ~24% of edges
  are semantic (101 of 422): the extractor names many entities and states few
  relationships between them. Worse, some "entities" are sentence fragments —
  "model achieves a BLEU score of 41.0, out", "English-to-German translation on
  the dev" — which are unmergeable by construction and pollute every list. The
  Explorer's lens view makes this visible rather than hiding it behind a graph
  drawing. Fixing it is an extractor-prompt and validation problem, and it should
  be measured, not eyeballed: there is no harness for extraction quality yet.
- Resolution's *candidates* come from the index (invariant 24) and its *merges*
  are guarded (invariant 28), so the known false-merge cases are closed. What is
  still unmeasured is the opposite error: how many genuine synonyms the guard now
  keeps apart. Splits are visible and fixable, which is why they were chosen — but
  nobody has counted them. A merge-decision audit table would make both directions
  measurable; today only refusals are logged.
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
29. **An entity with no edge is not knowledge.** The extractor returns
    `entities` and `relationships` as separate lists, so any entity it does not
    happen to put in a relationship used to become a node with no edges —
    measured at **62% of the graph**. The pipeline now writes
    `paper -[mentions]-> entity` for every entity a chunk names, chunk-attributed
    like any other claim. That is a record, not an inference: we know the paper
    named it. It is also the structure both real questions need — "what does this
    paper cover" is the paper's own edges, "what do two papers share" is a
    two-hop path through an entity both mention. `pnpm --filter api
    backfill:mentions` repairs a corpus ingested before this: 132 → 552 edges,
    isolation 62.4% → 3.6%, retrieval quality unchanged.
30. **A corpus split across domains looks sparse when it is severed.** Papers
    ingested without an explicit domain land in `default`; resolution is
    domain-scoped by design, so those papers can never relate to papers in a real
    domain, and shared concepts exist once per domain unable to merge. This is
    isolation working, not failing — but it is invisible, so check
    `select domain, count(*) from papers group by 1` before concluding the
    extractor is producing a sparse graph. `POST /api/papers/:id/domain` moves a
    paper and rebuilds its contribution (a rebuild, not a resume: every identity
    decision it made was made against the wrong neighbourhood).
32. **One live process job per paper, enforced by a partial unique index.**
    `jobs_one_active_per_paper` covers `type='process'` with a non-terminal,
    non-paused status. Two routes could schedule a paper — `/:id/resume` checked
    first, `/:id/domain` did not — and that asymmetry produced four papers with
    two queued jobs, one of them already `processing`. The cost is not just a
    wasted 15-minute extraction: both jobs run `resumePaper`, which clears
    unfinished contribution before rebuilding, so with concurrency they clear
    what the other is writing. `createJob` translates the violation into
    `AlreadyScheduledError` so a new route is safe by construction rather than
    by remembering. `paused` is terminal here — a parked paper must be
    resumable.
38. **One heartbeat, and everything else keyed off it.** Three dashboard queries
    polled independently, so an idle page sent ~45 requests/minute. Graph stats
    and the paper list cannot change unless a paper finishes, so they poll only
    while `workers.running + workers.queued > 0` and are **off** otherwise
    (`refetchInterval: false`, not a slow timer). `processing-papers` keeps a
    30 s beat because it is how the page learns work started elsewhere. Idle
    traffic: 45 req/min → 2 req/min.
39. **An animation that never stops stops meaning anything.** The Processing
    Papers spinner span unconditionally, so a dashboard with everything paused
    looked identical to one grinding through a batch. It animates only while
    work is moving.
36. **An activity signal must count work, not rows.** The dashboard polls at 2 s
    while work moves and 30 s when it does not, keyed on
    `workers.running + workers.queued` from `/api/papers/processing`. It used to
    key on the length of the returned list, which broke the moment that endpoint
    started returning `failed` and `paused` papers (invariant 27) — the list is
    never empty while anything is parked, so it polled every 2 s forever with
    nothing running. **A change three files away silently re-created the bug the
    interval existed to fix.** A DB test now asserts that parked papers appear in
    the list and contribute zero to `workers`.
37. **A control that fails silently is worse than no control.** Mutation errors
    render in the UI, not only in `console.error` — otherwise a broken button and
    a slow one look identical, and the operator has no way to tell which they are
    looking at.
34. **A paper's nodes cannot stay behind when it moves.**
    `clearPaperContributions` deliberately keeps nodes — within one domain they
    are canonical and shared, so deleting them would cascade away other papers'
    edges. Across a domain move that reasoning inverts: the nodes carry the old
    stamp and the paper has left, which is invariant 4 broken by the very
    operation meant to preserve it. Observed: one paper in `nlp` still owning
    255 nodes stamped `default`. The move now also removes nodes it owns in the
    old domain that nothing else references; `pnpm --filter api
    repair:domain-drift` audits and fixes corpora that already drifted.
35. **`type='paper'` is not "an ingested document".** The extractor creates a
    paper node for every work a document *cites* — seven papers produced
    eighty-five paper nodes, seventy-four of them citation targets with no text
    of their own. Anything offering a document to open must additionally require
    `p.id = n.paper_id and lower(p.title) = n.normalized_name`, which only a
    document's own node satisfies.
33. **Progress must describe work that still exists.** Any path that clears a
    paper's contribution (`?rebuild=true`, a domain move) resets
    `processingProgress` in the same statement. A rebuild that left the old
    percentage showed 100% for a paper holding zero chunks — the same class of
    lie as a failed paper displayed as "Pending".
31. **Entity identity is enforced by the database, not by a check-then-insert.**
    A unique index on `(coalesce(domain,''), normalized_name) where
    normalized_name is not null` decides it, and node creation is an
    `ON CONFLICT … DO UPDATE … RETURNING` upsert so a losing writer reads back
    the winner instead of raising. Resolution's lookups decide *which* node a
    mention belongs to; none of that helps against concurrency. The old path
    ended in a SELECT that missed followed by an INSERT — proven with two
    concurrent transactions to produce two nodes with the same normalized name
    in one domain, and reachable in the shipped configuration because
    `PROCESS_CONCURRENCY` is a knob and the queue is deliberately multi-instance.
    Note what this does NOT do: the same name in two domains is still two nodes.
    Isolation is not deduplication.
28. **Proximity is not identity — a merge must be justifiable.** Cosine gets a
    vote, not a veto. `knowledge-field/merge-guard.ts` must approve every
    embedding-based merge, on both the graph-lookup and the intra-batch path.
    The audit that forced this: on the live graph, *every* same-type pair above
    the 0.82 threshold was a pair of genuinely different things — two distinct
    papers at 0.870 and 0.833, English-to-German vs English-to-French at 0.904,
    a model vs its Ensemble at 0.917. No threshold separates those from real
    synonyms, because the embedding measures topic and identity is not topic.
    The rules: papers merge only on an exact title (never by similarity);
    numeric tokens must match exactly; whatever the two names do not share must
    be generic ("system", "layers") rather than distinguishing ("Ensemble",
    "gated", "French"); initialisms are exempt, since "3DGS"/"3D Gaussian
    Splatting" is the case the embedding path exists for. **The asymmetry is the
    whole argument: a false split leaves two nodes anyone can merge later, a
    false merge destroys the distinction permanently and invisibly.** Never widen
    `GENERIC_TOKENS` without re-running the live audit. `RESOLUTION_MERGE=exact`
    disables embedding merges entirely; `vector` restores the audited-unsafe
    behaviour and exists only to reproduce the audit.
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
27. **A state the operator must clear belongs in the operations view.**
    `GET /api/papers/processing` returns `failed` and `paused` papers, not only
    in-flight ones. Excluding them put the Retry and Resume controls in a list
    that could never contain a paper needing them — the buttons existed and were
    unreachable. A failure with no control is an outage.
26. **A pause is not a failure.** Pausing sets `papers.processing_status` and the
    processor stops at the next chunk boundary — never mid-chunk, which would
    discard the ~34 s already spent and leave a partial extraction to reconcile.
    The job goes to `paused`: terminal for the queue, unclaimable, no retry
    consumed. Resume and retry are the same operation, because they are — put it
    back on the queue and keep the checkpoint.
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
pnpm --filter api bench:lane-width # serial vs concurrent extraction on this hardware
```

`EMBED_PROVIDER=local` gives deterministic lexical embeddings with no model
server — enough to run the eval harness and the DB tests anywhere. It is opt-in
only; nothing falls back to it.

Local key-free setup needs **both** `LLM_PROVIDER=ollama` and `EMBED_PROVIDER=ollama`
(`EMBED_PROVIDER` defaults to `openai` independently of `LLM_PROVIDER`), plus
`ollama pull llama3.2:1b` and `ollama pull nomic-embed-text`. `GET /health` returns
503 and names the specific misconfiguration when this is wrong.
