import { db } from '../db';
import { papers, nodes, edges, sources, nodeVectors, propositions, paperChunks } from '../db/schema';
import { eq, inArray, and, desc, sql, notInArray } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { resolveStoredDomain } from '../domains';
import { domainWhere } from '../domains/filter';
import { extractEntitiesAndRelationships } from '../agents/extractor';
import { resolveEntities } from '../agents/resolver';
import { validateRelationships } from '../agents/validator';
import { resolveEntitiesEmbed } from '../knowledge-field/resolve-embed';
import { createCandidateSource } from '../knowledge-field/resolve-candidates';
import { validateRelationshipsRules } from '../knowledge-field/validate-rules';
import { embed, embedModel, embedSpaceId } from '../services/embeddings';
import { LLMUnavailableError } from '../services/llm';
import * as metrics from '../services/metrics';
import { chunkText, detectSection } from '../services/pdf';
import type { IngestUnit } from '../connectors/types';

type PipelineMode = 'field' | 'legacy';

export interface ProcessingStats {
  chunksProcessed: number;
  /** Chunks that threw (model unavailable, unparseable output, embedding failure). */
  chunksFailed: number;
  entitiesExtracted: number;
  entitiesCreated: number;
  relationshipsCreated: number;
  relationshipsRejected: number;
}

/**
 * How many existing in-domain nodes entity resolution may compare against.
 *
 * Resolution matching is O(mentions x candidates) in JS, so it has to be
 * bounded. What matters is that the bound is *visible*: the previous `.limit(500)`
 * had no ORDER BY, so once a domain passed 500 nodes Postgres returned an
 * arbitrary subset and every mention outside it silently became a duplicate
 * entity. Now the window is deterministic (most recent first) and hitting it is
 * logged as the recall limitation it is.
 */
const RESOLUTION_CANDIDATE_LIMIT = Math.max(
  1,
  parseInt(process.env.RESOLUTION_CANDIDATE_LIMIT || '2000', 10) || 2000
);

/**
 * Consecutive "cannot reach the model" chunk failures before abandoning the paper.
 *
 * Small but not 1: a single blip (a restarting Ollama, one dropped connection)
 * should not discard a paper that would otherwise process. Three in a row is an
 * outage, not a blip.
 */
const UNAVAILABLE_ABORT_THRESHOLD = Math.max(
  1,
  parseInt(process.env.LLM_UNAVAILABLE_ABORT_AFTER || '3', 10) || 3
);

export async function processPaper(paperId: string): Promise<ProcessingStats> {
  const stats: ProcessingStats = {
    chunksProcessed: 0,
    chunksFailed: 0,
    entitiesExtracted: 0,
    entitiesCreated: 0,
    relationshipsCreated: 0,
    relationshipsRejected: 0,
  };

  const mode: PipelineMode = process.env.PIPELINE_MODE === 'legacy' ? 'legacy' : 'field';
  metrics.setMode(mode);

  try {
    const [paper] = await db
      .select()
      .from(papers)
      .where(eq(papers.id, paperId))
      .limit(1);

    if (!paper) {
      throw new Error(`Paper not found: ${paperId}`);
    }

    // A document is ingestible if it has text to extract from *or* an
    // extraction a structured connector already produced.
    const structuredUnits = (paper.structuredUnits as IngestUnit[] | null) ?? null;
    if (!paper.rawText && (!structuredUnits || structuredUnits.length === 0)) {
      throw new Error(`Document has neither raw text nor structured units: ${paperId}`);
    }

    // Strict: a paper carrying an unregistered domain must not be processed under
    // the default ontology. Doing so stamped its entities `default` while the
    // paper claimed another domain — the two disagreed permanently, and the
    // entities merged into the shared default graph.
    const domain = resolveStoredDomain(paper.domain, `paper ${paper.id}`);
    console.log(`Pipeline mode: ${mode} | domain: ${domain.id}`);

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Processing paper: ${paper.title}`);
    console.log(`${'='.repeat(60)}\n`);

    const paperNode = await getOrCreatePaperNode(paper, domain.id);

    // In field mode, give the paper node an embedding so it can seed retrieval.
    if (mode === 'field') {
      try {
        const [pv] = await embed([`${paper.title}. ${paper.abstract || ''}`.trim()], 'node');
        await db
          .insert(nodeVectors)
          .values({
            nodeId: paperNode,
            embeddingVec: pv,
            model: embedModel(),
            space: embedSpaceId(),
          })
          .onConflictDoNothing();
      } catch (e) {
        console.warn('Failed to embed paper node:', e);
      }
    }

    // Structured sources arrive with their graph already known; text sources are
    // chunked for the extractor. Everything downstream is identical.
    const units: IngestUnit[] =
      structuredUnits && structuredUnits.length > 0
        ? structuredUnits
        : chunkText(paper.rawText!, 2000, 200).map((text, i, all) => ({
            section: detectSection(text, i, all.length),
            text,
          }));

    const chunks = units;
    console.log(
      structuredUnits
        ? `${units.length} pre-extracted unit(s) from connector "${paper.connector ?? 'unknown'}" — no LLM calls needed`
        : `Split into ${units.length} chunks`
    );

    // Update status to extracting_entities
    await db
      .update(papers)
      .set({
        processingStatus: 'extracting_entities',
        processingProgress: 0
      })
      .where(eq(papers.id, paperId));

    const entityMap = new Map<string, string>();
    const chunkErrors: string[] = [];
    let consecutiveUnavailable = 0;

    // Which chunks are already done, and are they still the same chunks?
    //
    // Resume is only sound if chunk N still means the text it meant last run.
    // Chunking is deterministic given the source, so a content hash settles it:
    // matching hashes mean the checkpoint describes this exact text, and a
    // mismatch means the boundaries moved and every checkpoint is stale.
    const chunkHashes = chunks.map((u) => hashUnit(u));
    const priorChunks = await db
      .select()
      .from(paperChunks)
      .where(eq(paperChunks.paperId, paperId));

    const doneChunks = new Set<number>();
    for (const prior of priorChunks) {
      if (prior.status !== 'completed') continue;
      if (prior.chunkIndex >= chunks.length) continue;
      if (prior.contentHash !== chunkHashes[prior.chunkIndex]) continue;
      doneChunks.add(prior.chunkIndex);
    }

    const staleCheckpoints = priorChunks.length - doneChunks.size;
    if (staleCheckpoints > 0 && priorChunks.length > 0) {
      console.log(
        `[processor] ${staleCheckpoints} checkpoint(s) no longer match the current text — those chunks will be redone`
      );
    }
    if (doneChunks.size > 0) {
      console.log(
        `[processor] resuming: ${doneChunks.size}/${chunks.length} chunk(s) already extracted, skipping them`
      );
      stats.chunksProcessed += doneChunks.size;
    }

    for (let i = 0; i < chunks.length; i++) {
      if (doneChunks.has(i)) continue;

      // Cooperative pause, checked between chunks. Interrupting mid-chunk would
      // waste the ~34s already spent on it and leave a partial extraction to
      // clean up; between chunks the checkpoint is exact and resuming is free.
      if (await isPauseRequested(paperId)) {
        console.log(`[processor] pause requested — stopping cleanly after ${i} chunk(s)`);
        await db
          .update(papers)
          .set({
            processingStatus: 'paused',
            processingProgress: Math.floor((i / chunks.length) * 100),
          })
          .where(eq(papers.id, paperId));
        throw new PausedError(`Paused after ${i}/${chunks.length} chunk(s)`);
      }

      console.log(`\n--- Processing chunk ${i + 1}/${chunks.length} ---`);

      // Update progress after each chunk
      const progress = Math.floor((i / chunks.length) * 100);
      await db
        .update(papers)
        .set({ processingProgress: progress })
        .where(eq(papers.id, paperId));
      
      const unit = units[i];
      const section = unit.section;

      try {
        // The one branch that matters: a unit that already carries its
        // extraction costs nothing, which is what makes importing a large API
        // surface free rather than a per-operation model bill.
        const extractorOutput = unit.extraction
          ? unit.extraction
          : await extractEntitiesAndRelationships({
              paperId,
              chunkIndex: i,
              text: unit.text ?? '',
              section,
              domain,
            });

        stats.entitiesExtracted += extractorOutput.entities.length;
        console.log(`Extracted ${extractorOutput.entities.length} entities, ${extractorOutput.relationships.length} relationships`);

        if (extractorOutput.entities.length === 0 && extractorOutput.relationships.length === 0) {
          console.log('No extractions from this chunk, skipping...');
          stats.chunksProcessed++;
          continue;
        }

        // Resolve entities: embedding-based (field) or LLM (legacy).
        //
        // The field path asks storage for candidates through indexed lookups
        // scoped to this paper's domain — the isolation boundary for resolution.
        // It used to preload the 2000 most recent nodes and their vectors and
        // compare in JS, which meant a domain larger than that window resolved
        // against a *slice* of itself and forked entities it had already seen.
        // See resolve-candidates.ts.
        let resolverOutput;
        let vectorsByName = new Map<string, number[]>();
        // Only the legacy prompt-based path needs a materialised node list.
        let legacyNodes: Array<typeof nodes.$inferSelect> = [];
        if (mode === 'field') {
          const fieldOut = await resolveEntitiesEmbed(
            extractorOutput,
            createCandidateSource(domain.id)
          );
          resolverOutput = fieldOut;
          vectorsByName = fieldOut.vectorsByName;
        } else {
          // The legacy LLM resolver still takes a list; it is bounded by prompt
          // size, not by an index, so the window is inherent to that design.
          legacyNodes = await db
            .select()
            .from(nodes)
            .where(domainWhere(nodes.domain, domain.id))
            .orderBy(desc(nodes.createdAt), desc(nodes.id))
            .limit(RESOLUTION_CANDIDATE_LIMIT);
          resolverOutput = await resolveEntities(extractorOutput, legacyNodes);
        }
        console.log(`Resolved ${resolverOutput.resolvedEntities.length} entities`);
        if (resolverOutput.resolvedRelationships.length > 0) {
          console.log(`Resolved ${resolverOutput.resolvedRelationships.length} relationships:`);
          resolverOutput.resolvedRelationships.forEach(rel => {
            console.log(`  ${rel.sourceName} --[${rel.type}]--> ${rel.targetName}`);
          });
        }

        for (const entity of resolverOutput.resolvedEntities) {
          if (entity.isNew && !entityMap.has(entity.canonicalName.toLowerCase())) {
            // `eq`, not `ilike`. Both sides are already lowercased, so these ask
            // the identical question — but ilike cannot use the btree index:
            // measured on 100k nodes it was a Seq Scan discarding all 100,000
            // rows (plan cost 3039) against an Index Scan at cost 12, and this
            // runs once per newly-seen entity per chunk.
            const existingByName = await db
              .select()
              .from(nodes)
              .where(
                and(
                  eq(nodes.normalizedName, entity.canonicalName.toLowerCase()),
                  domainWhere(nodes.domain, domain.id)
                )
              )
              .limit(1);

            if (existingByName.length > 0) {
              entityMap.set(entity.canonicalName.toLowerCase(), existingByName[0].id);
              entity.canonicalId = existingByName[0].id;
              entity.isNew = false;
            } else {
              const nodeType = (entity.type as string) === 'paper_reference' ? 'paper' : entity.type;
              
              // Atomic create-or-get, not check-then-insert.
              //
              // The SELECT above is a fast path, not a guarantee: between it and
              // this INSERT another worker extracting a different paper can
              // create the same entity. Demonstrated with two concurrent
              // transactions — two nodes, same normalized_name, same domain — and
              // reachable in the shipped configuration, because
              // PROCESS_CONCURRENCY is a knob and the queue is deliberately
              // multi-instance. Only the database can serialise this, so the
              // unique index decides it and the conflict clause reads back the
              // winner instead of raising.
              const created = (await db.execute(sql`
                insert into ${nodes} (type, domain, name, normalized_name, paper_id)
                values (
                  ${nodeType}, ${domain.id}, ${entity.canonicalName},
                  ${entity.canonicalName.toLowerCase()},
                  ${nodeType === 'paper' ? null : paperId}
                )
                on conflict ((coalesce(domain, '')), normalized_name)
                  where normalized_name is not null
                  do update set updated_at = now()
                returning id
              `)) as unknown as Array<{ id: string }>;
              const newNode = { id: created[0].id };

              entityMap.set(entity.canonicalName.toLowerCase(), newNode.id);
              entity.canonicalId = newNode.id;
              stats.entitiesCreated++;
              console.log(`Created new ${nodeType}: ${entity.canonicalName}`);

              // Persist the node embedding (reused from resolution — no extra call).
              if (mode === 'field') {
                const vec = vectorsByName.get(entity.canonicalName.toLowerCase());
                if (vec) {
                  await db
                    .insert(nodeVectors)
                    .values({
                      nodeId: newNode.id,
                      embeddingVec: vec,
                      model: embedModel(),
                      space: embedSpaceId(),
                    })
                    .onConflictDoNothing();
                }
              }
            }
          } else if (entity.canonicalId) {
            entityMap.set(entity.canonicalName.toLowerCase(), entity.canonicalId);
          }
        }

        // Every entity this chunk named gets an edge to the paper that named it.
        //
        // Without this, 62% of the graph was isolated nodes. The cause is
        // structural, not a tuning problem: the extractor returns `entities` and
        // `relationships` as two separate lists, so any entity the model did not
        // happen to put in a relationship became a node with no edges — present
        // in the corpus, unreachable in the graph, and useless to a reader.
        //
        // A `mentions` edge is not an inference. We know this paper named this
        // entity; that is the extraction record itself, and it is exactly the
        // structure both questions need. "What does this paper cover" is the
        // paper's own edges. "What do two papers share" is a two-hop path
        // through the entity they both mention — which is only traversable if
        // the entity is attached to both papers in the first place.
        const mentionTargets = new Set<string>();
        for (const entity of resolverOutput.resolvedEntities) {
          const id = entity.canonicalId ?? entityMap.get(entity.canonicalName.toLowerCase());
          // Never link the paper to itself; that is a self-edge, not a claim.
          if (id && id !== paperNode) mentionTargets.add(id);
        }

        for (const targetId of mentionTargets) {
          await db.transaction(async (tx) => {
            // One mention edge per (paper, entity) regardless of how many chunks
            // name it — the claim is "this paper covers this", asserted once.
            const [existing] = await tx
              .select({ id: edges.id })
              .from(edges)
              .where(
                and(
                  eq(edges.sourceId, paperNode),
                  eq(edges.targetId, targetId),
                  eq(edges.type, 'mentions')
                )
              )
              .limit(1);

            const edgeId =
              existing?.id ??
              (
                await tx
                  .insert(edges)
                  .values({
                    sourceId: paperNode,
                    targetId,
                    type: 'mentions',
                    domain: domain.id,
                    confidence: '1.00',
                  })
                  .returning()
              )[0].id;

            // Provenance, chunk-attributed, so a partial resume undoes it
            // exactly like any other claim this chunk made.
            await tx
              .insert(sources)
              .values({ edgeId, paperId, section, chunkIndex: i })
              .onConflictDoNothing();
          });
        }

        // The rule validator needs a name -> type map for every edge endpoint.
        // It used to receive an arbitrary slice of the domain for that, which was
        // both unbounded-in-principle and beside the point: the resolver already
        // adds every relationship endpoint as a candidate and stamps each one
        // with its *stored* type when it matched an existing node. So the
        // resolved set is the authoritative, complete answer — the extra rows
        // could only supply types for names no edge referenced.
        const validationOutput = mode === 'field'
          ? validateRelationshipsRules(resolverOutput, { paperDate: paper.publicationDate })
          : await validateRelationships(resolverOutput, {
              nodes: legacyNodes.slice(0, 50),
              paperDate: paper.publicationDate,
            });
        console.log(`Validated: ${validationOutput.accepted.length} accepted, ${validationOutput.rejected.length} rejected`);

        stats.relationshipsRejected += validationOutput.rejected.length;

        // Accumulate propositions (field mode): one atomic fact per accepted edge.
        const propsToWrite: Array<{ text: string; nodeIds: string[] }> = [];

        for (const relationship of validationOutput.accepted) {
          try {
            // Relationships have canonical entity NAMES, not UUIDs
            // Look them up in entityMap which maps canonicalName.toLowerCase() -> UUID
            const sourceId = entityMap.get(relationship.sourceName?.toLowerCase()) ||
                            findEntityId(entityMap, relationship.sourceName);
            const targetId = entityMap.get(relationship.targetName?.toLowerCase()) ||
                            findEntityId(entityMap, relationship.targetName);

            if (!sourceId || !targetId) {
              console.warn(`Could not find node IDs for relationship:`);
              console.warn(`  Source: "${relationship.sourceName}" -> ${sourceId || 'NOT FOUND'}`);
              console.warn(`  Target: "${relationship.targetName}" -> ${targetId || 'NOT FOUND'}`);
              console.warn(`  Available entities in map: ${Array.from(entityMap.keys()).join(', ')}`);
              continue;
            }

            if (!isValidEdgeType(relationship.type)) {
              console.warn(`Invalid edge type: ${relationship.type}, defaulting to 'uses'`);
              relationship.type = 'uses';
            }

            // Edge and provenance are written together. Separately, a failed
            // `sources` insert left an edge with no evidence behind it — an
            // unfalsifiable claim in a graph whose whole point is that every
            // claim is traceable to a paper.
            await db.transaction(async (tx) => {
              const [edge] = await tx
                .insert(edges)
                .values({
                  sourceId,
                  targetId,
                  type: relationship.type as any,
                  domain: domain.id,
                  confidence: String(relationship.confidence || 0.5),
                })
                .returning();

              await tx.insert(sources).values({
                edgeId: edge.id,
                paperId: paperId,
                section: section,
                extractedText: relationship.evidence?.slice(0, 1000),
                // Attribution to the chunk, which is what makes a per-chunk undo
                // possible and therefore a resume safe.
                chunkIndex: i,
              });
            });

            stats.relationshipsCreated++;

            if (mode === 'field' && relationship.evidence) {
              propsToWrite.push({
                text: relationship.evidence.slice(0, 500),
                nodeIds: [sourceId, targetId],
              });
            }
          } catch (relError) {
            console.error(`Error creating relationship:`, relError);
          }
        }

        // Persist propositions for this chunk in one batched embed call.
        // A failure here loses the retrieval evidence for edges we just wrote, so
        // it counts against the chunk rather than being logged and forgotten.
        if (mode === 'field' && propsToWrite.length > 0) {
          const embs = await embed(propsToWrite.map((p) => p.text), 'proposition');
          await db.insert(propositions).values(
            propsToWrite.map((p, idx) => ({
              paperId,
              text: p.text,
              embeddingVec: embs[idx],
              nodeIds: p.nodeIds,
              section,
              domain: domain.id,
              space: embedSpaceId(),
            }))
          );
        }

        stats.chunksProcessed++;

        // Checkpoint AFTER the writes land, so a crash between the two costs a
        // redo of this chunk rather than silently skipping it next run. Losing
        // a checkpoint is recoverable; recording one that did not happen is not.
        await db
          .insert(paperChunks)
          .values({
            paperId,
            chunkIndex: i,
            status: 'completed',
            contentHash: chunkHashes[i],
            section,
            entities: extractorOutput.entities.length,
            relationships: validationOutput.accepted.length,
          })
          .onConflictDoUpdate({
            target: [paperChunks.paperId, paperChunks.chunkIndex],
            set: {
              status: 'completed',
              contentHash: chunkHashes[i],
              entities: extractorOutput.entities.length,
              relationships: validationOutput.accepted.length,
              error: null,
              completedAt: new Date(),
            },
          });
      } catch (chunkError) {
        if (chunkError instanceof PausedError) throw chunkError;
        // A failed chunk is *not* a processed chunk. Counting it as processed is
        // what made a total model outage look like a paper that simply contained
        // no facts.
        const message = chunkError instanceof Error ? chunkError.message : String(chunkError);
        console.error(`Error processing chunk ${i}: ${message}`);
        stats.chunksFailed++;
        if (chunkErrors.length < 5) chunkErrors.push(`chunk ${i}: ${message}`);

        // Availability failures are a property of the *deployment*, not of this
        // chunk: if the model is unreachable now, it will be unreachable for
        // chunk 47 too. Grinding through the rest re-discovers one outage dozens
        // of times, holding a worker slot for minutes and burying the real cause
        // under identical errors. Content failures (unparseable JSON) are
        // per-chunk and do not trip this.
        if (chunkError instanceof LLMUnavailableError) {
          consecutiveUnavailable++;
          if (consecutiveUnavailable >= UNAVAILABLE_ABORT_THRESHOLD) {
            const summary =
              `Aborted after ${consecutiveUnavailable} consecutive chunks failed to reach the ` +
              `language model (${stats.chunksProcessed}/${chunks.length} chunks completed): ${message}`;
            await markPaperFailed(paperId, summary);
            throw new LLMUnavailableError(summary, { cause: chunkError });
          }
        } else {
          consecutiveUnavailable = 0;
        }
      }

      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Every chunk failing means we learned nothing about this paper. Recording it
    // as processed would bake a false negative into the graph permanently: later
    // queries would report "no evidence" for a paper that was never actually read.
    // A resumed run that had nothing left to do still counts the chunks it
    // inherited, so this check asks the right question: did we learn anything
    // about this paper across all runs, not just this one.
    if (chunks.length > 0 && stats.chunksProcessed === 0) {
      const summary =
        `All ${chunks.length} chunk(s) failed — no knowledge was extracted. ` +
        `First errors: ${chunkErrors.join(' | ')}`;
      await markPaperFailed(paperId, summary);
      throw new Error(summary);
    }

    await db
      .update(papers)
      .set({
        processed: true,
        processingStatus: 'completed',
        processingProgress: 100,
        // Cleared on success so a stale message from an earlier failed run does
        // not linger next to a completed status.
        processingError:
          stats.chunksFailed > 0
            ? `Completed with ${stats.chunksFailed}/${chunks.length} chunk(s) failed: ${chunkErrors.join(' | ')}`
            : null,
        updatedAt: new Date()
      })
      .where(eq(papers.id, paperId));

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Finished processing paper: ${paper.title}`);
    console.log(`Stats: ${JSON.stringify(stats, null, 2)}`);
    console.log(`${'='.repeat(60)}\n`);

    return stats;
  } catch (error) {
    console.error(`Error processing paper ${paperId}:`, error);
    // Without this the paper keeps whatever non-terminal status it had, so
    // GET /api/papers/processing lists it as in-progress forever and the
    // Dashboard shows a spinner that never resolves.
    await markPaperFailed(paperId, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

/**
 * Move a paper to a terminal failed state with the reason attached.
 *
 * Best-effort: if the database itself is what failed we still want the original
 * error to propagate to the caller rather than being masked by this write.
 */
async function markPaperFailed(paperId: string, reason: string): Promise<void> {
  try {
    await db
      .update(papers)
      .set({
        processed: false,
        processingStatus: 'failed',
        processingError: reason.slice(0, 2000),
        updatedAt: new Date(),
      })
      .where(eq(papers.id, paperId));
  } catch (err) {
    console.error(`Failed to record failure state for paper ${paperId}:`, err);
  }
}

async function getOrCreatePaperNode(paper: any, domainId: string): Promise<string> {
  // Scoped to the domain we are processing under: reusing a paper node stamped
  // with a different domain would place this run's entities on the wrong side of
  // the isolation boundary.
  const existing = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.paperId, paper.id), eq(nodes.type, 'paper'), domainWhere(nodes.domain, domainId)))
    .limit(1);

  if (existing.length > 0) {
    return existing[0].id;
  }

  const [paperNode] = await db
    .insert(nodes)
    .values({
      type: 'paper',
      domain: domainId,
      name: paper.title,
      normalizedName: paper.title.toLowerCase(),
      paperId: paper.id,
      description: paper.abstract?.slice(0, 500),
    })
    .returning();

  return paperNode.id;
}

/**
 * Stable identity for a chunk's content.
 *
 * Only used to detect that the text behind chunk N changed, so a fast
 * non-cryptographic digest is the right tool — this is a cache key, not a
 * security boundary.
 */
function hashUnit(unit: IngestUnit): string {
  const body = unit.extraction ? JSON.stringify(unit.extraction) : (unit.text ?? '');
  return createHash('sha1').update(`${unit.section ?? ''}\u0000${body}`).digest('hex');
}

/**
 * Raised when an operator pauses a paper between chunks.
 *
 * It is not a failure, so it must not consume the retry budget or mark the paper
 * failed — the job handler catches it and leaves the work parked, resumable from
 * the checkpoint at zero cost.
 */
export class PausedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PausedError';
  }
}

/** Has an operator asked this paper to stop? Checked between chunks. */
async function isPauseRequested(paperId: string): Promise<boolean> {
  const [row] = await db
    .select({ status: papers.processingStatus })
    .from(papers)
    .where(eq(papers.id, paperId))
    .limit(1);
  return row?.status === 'paused';
}

function findEntityId(entityMap: Map<string, string>, name: string): string | null {
  if (!name) return null;
  
  const normalized = name.toLowerCase();
  
  if (entityMap.has(normalized)) {
    return entityMap.get(normalized)!;
  }

  for (const [key, value] of entityMap.entries()) {
    if (key.includes(normalized) || normalized.includes(key)) {
      return value;
    }
  }

  return null;
}

function isValidEdgeType(type: string): boolean {
  // Types are open: accept any non-empty type the extractor/validator produced.
  // The rule validator (validate-rules.ts) handles semantic compatibility.
  return typeof type === 'string' && type.trim().length > 0;
}

export interface ClearedContributions {
  propositions: number;
  sources: number;
  edges: number;
}

/**
 * Remove everything a single paper contributed to the graph, and nothing else.
 *
 * Processing is not idempotent on its own: nodes dedup by normalized name, but
 * every run inserts fresh `edges`, `sources`, and `propositions`. Re-running
 * `POST /api/papers/:id/process` — which the route explicitly permits — therefore
 * duplicated the paper's entire contribution, inflating PPR edge mass and
 * repeating the same evidence in retrieval. Clearing first makes a re-run
 * converge instead of accumulate.
 *
 * What it deliberately does *not* delete:
 *  - Nodes. They are canonical and shared; an entity first seen in this paper may
 *    be referenced by others, and dropping it would cascade away *their* edges.
 *  - Edges another paper also asserts. Only edges whose sole remaining provenance
 *    was this paper are removed, so co-asserted facts survive with their other
 *    citations intact.
 */
/**
 * Drop only the contribution of chunks NOT in `keep`.
 *
 * This is the per-chunk sibling of `clearPaperContributions`, and it is what
 * makes resume idempotent: the chunks about to be re-run have their previous
 * claims removed first, exactly as a full re-run does for the whole paper, while
 * completed chunks keep theirs. Rows written before `sources.chunk_index`
 * existed have a null index and belong to no chunk we can vouch for, so they are
 * cleared too — attributing them by guess would be worse than redoing them.
 */
export async function clearChunkContributions(
  paperId: string,
  keep: number[]
): Promise<ClearedContributions> {
  return db.transaction(async (tx) => {
    const scope = keep.length
      ? and(
          eq(sources.paperId, paperId),
          sql`(${sources.chunkIndex} is null or ${sources.chunkIndex} not in ${keep})`
        )
      : eq(sources.paperId, paperId);

    const touchedEdgeIds = [
      ...new Set((await tx.select({ edgeId: sources.edgeId }).from(sources).where(scope)).map((r) => r.edgeId)),
    ];

    const deletedSources = await tx.delete(sources).where(scope).returning({ id: sources.id });

    let deletedEdges: { id: string }[] = [];
    if (touchedEdgeIds.length > 0) {
      // An edge another paper (or a kept chunk) also asserts must survive: the
      // claim is still supported, so deleting it would destroy evidence we hold.
      deletedEdges = await tx
        .delete(edges)
        .where(
          and(
            inArray(edges.id, touchedEdgeIds),
            sql`not exists (select 1 from ${sources} s where s.edge_id = ${edges.id})`
          )
        )
        .returning({ id: edges.id });
    }

    // Propositions carry no chunk attribution, and a resumed run rewrites the
    // ones it produces, so only those from re-run chunks need clearing. Without
    // per-chunk attribution the safe move is to drop the paper's propositions
    // only when nothing is being kept.
    let deletedProps: { id: string }[] = [];
    if (keep.length === 0) {
      deletedProps = await tx
        .delete(propositions)
        .where(eq(propositions.paperId, paperId))
        .returning({ id: propositions.id });
    }

    // Forget the checkpoints for chunks we just undid.
    if (keep.length) {
      await tx
        .delete(paperChunks)
        .where(and(eq(paperChunks.paperId, paperId), notInArray(paperChunks.chunkIndex, keep)));
    } else {
      await tx.delete(paperChunks).where(eq(paperChunks.paperId, paperId));
    }

    return {
      edges: deletedEdges.length,
      sources: deletedSources.length,
      propositions: deletedProps.length,
    };
  });
}

export async function clearPaperContributions(paperId: string): Promise<ClearedContributions> {
  return db.transaction(async (tx) => {
    const deletedProps = await tx
      .delete(propositions)
      .where(eq(propositions.paperId, paperId))
      .returning({ id: propositions.id });

    // Capture the affected edges before dropping this paper's provenance rows.
    const touchedEdgeIds = [
      ...new Set(
        (
          await tx
            .select({ edgeId: sources.edgeId })
            .from(sources)
            .where(eq(sources.paperId, paperId))
        ).map((r) => r.edgeId)
      ),
    ];

    const deletedSources = await tx
      .delete(sources)
      .where(eq(sources.paperId, paperId))
      .returning({ id: sources.id });

    let deletedEdges: { id: string }[] = [];
    if (touchedEdgeIds.length > 0) {
      deletedEdges = await tx
        .delete(edges)
        .where(
          and(
            inArray(edges.id, touchedEdgeIds),
            sql`not exists (select 1 from ${sources} where ${sources.edgeId} = ${edges.id})`
          )
        )
        .returning({ id: edges.id });
    }

    return {
      propositions: deletedProps.length,
      sources: deletedSources.length,
      edges: deletedEdges.length,
    };
  });
}

/** Clear this paper's previous contribution, then extract it again from scratch. */
export async function reprocessPaper(paperId: string): Promise<ProcessingStats> {
  const cleared = await clearPaperContributions(paperId);
  console.log(
    `[processor] cleared previous contribution of paper ${paperId}: ` +
      `${cleared.edges} edge(s), ${cleared.sources} source(s), ${cleared.propositions} proposition(s)`
  );

  await db
    .update(papers)
    .set({ processed: false, processingStatus: 'pending', processingProgress: 0 })
    .where(eq(papers.id, paperId));

  return processPaper(paperId);
}

/**
 * Continue a paper from its checkpoint — the default for a retry or a resume.
 *
 * The difference from `reprocessPaper` is the whole point of checkpointing:
 * that one starts over from chunk 0 and is correct but wasteful, this one keeps
 * every chunk that already completed against unchanged text and re-runs only
 * what is left. On a 26-chunk paper that failed at chunk 24, it is the
 * difference between 15 minutes of GPU and one.
 *
 * Idempotency is preserved at the finer grain: the chunks about to run have
 * their previous claims cleared first, exactly as a full re-run does for the
 * whole paper. Use `reprocessPaper` when the goal is genuinely to rebuild — a
 * changed extractor, a new model, a corrected document.
 */
export async function resumePaper(paperId: string): Promise<ProcessingStats> {
  const completed = (
    await db
      .select({ chunkIndex: paperChunks.chunkIndex })
      .from(paperChunks)
      .where(and(eq(paperChunks.paperId, paperId), eq(paperChunks.status, 'completed')))
  ).map((r) => r.chunkIndex);

  const cleared = await clearChunkContributions(paperId, completed);
  console.log(
    `[processor] resuming paper ${paperId}: keeping ${completed.length} completed chunk(s), ` +
      `cleared ${cleared.edges} edge(s) and ${cleared.sources} source(s) from unfinished ones`
  );

  await db
    .update(papers)
    .set({ processed: false, processingStatus: 'pending', processingError: null })
    .where(eq(papers.id, paperId));

  return processPaper(paperId);
}