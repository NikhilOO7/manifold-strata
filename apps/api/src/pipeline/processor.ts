import { db } from '../db';
import { papers, nodes, edges, sources, nodeVectors, propositions } from '../db/schema';
import { eq, inArray, and, desc, sql } from 'drizzle-orm';
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

    for (let i = 0; i < chunks.length; i++) {
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
              
              const [newNode] = await db
                .insert(nodes)
                .values({
                  type: nodeType as any,
                  domain: domain.id,
                  name: entity.canonicalName,
                  normalizedName: entity.canonicalName.toLowerCase(),
                  paperId: nodeType === 'paper' ? null : paperId,
                })
                .returning();

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
      } catch (chunkError) {
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