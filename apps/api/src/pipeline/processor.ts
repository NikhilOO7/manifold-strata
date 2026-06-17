import { db } from '../db';
import { papers, nodes, edges, sources, nodeVectors, propositions } from '../db/schema';
import { eq, ilike, inArray, and } from 'drizzle-orm';
import { getDomain } from '../domains';
import { domainWhere } from '../domains/filter';
import { extractEntitiesAndRelationships } from '../agents/extractor';
import { resolveEntities } from '../agents/resolver';
import { validateRelationships } from '../agents/validator';
import { resolveEntitiesEmbed } from '../knowledge-field/resolve-embed';
import { validateRelationshipsRules } from '../knowledge-field/validate-rules';
import { embed, embedModel } from '../services/embeddings';
import * as metrics from '../services/metrics';
import { emitPaperProgress } from '../services/events';
import { chunkText, detectSection } from '../services/pdf';

type PipelineMode = 'field' | 'legacy';

interface ProcessingStats {
  chunksProcessed: number;
  entitiesExtracted: number;
  entitiesCreated: number;
  relationshipsCreated: number;
  relationshipsRejected: number;
}

export async function processPaper(paperId: string): Promise<ProcessingStats> {
  const stats: ProcessingStats = {
    chunksProcessed: 0,
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

    if (!paper.rawText) {
      throw new Error(`Paper has no raw text: ${paperId}`);
    }

    const domain = getDomain(paper.domain);
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
          .values({ nodeId: paperNode, embedding: pv, model: embedModel() })
          .onConflictDoNothing();
      } catch (e) {
        console.warn('Failed to embed paper node:', e);
      }
    }

    const chunks = chunkText(paper.rawText, 2000, 200);
    console.log(`Split into ${chunks.length} chunks`);

    // Update status to extracting_entities
    await db
      .update(papers)
      .set({
        processingStatus: 'extracting_entities',
        processingProgress: 0
      })
      .where(eq(papers.id, paperId));

    const entityMap = new Map<string, string>();

    for (let i = 0; i < chunks.length; i++) {
      console.log(`\n--- Processing chunk ${i + 1}/${chunks.length} ---`);

      // Update progress after each chunk
      const progress = Math.floor((i / chunks.length) * 100);
      await db
        .update(papers)
        .set({ processingProgress: progress })
        .where(eq(papers.id, paperId));
      emitPaperProgress({ paperId, status: 'extracting_entities', progress });
      
      const section = detectSection(chunks[i], i, chunks.length);
      console.log(`Detected section: ${section}`);

      try {
        const extractorOutput = await extractEntitiesAndRelationships({
          paperId,
          chunkIndex: i,
          text: chunks[i],
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

        // Scoped to this paper's domain — the isolation boundary for resolution.
        // Field mode resolves by embedding similarity, so it needs the full
        // in-domain node set; a blind LIMIT would silently stop deduplicating
        // against older entities. Legacy mode stuffs nodes into an LLM prompt and
        // must stay bounded. Either way the size is logged so the ceiling is visible.
        const existingNodes = mode === 'field'
          ? await db.select().from(nodes).where(domainWhere(nodes.domain, domain.id))
          : await db.select().from(nodes).where(domainWhere(nodes.domain, domain.id)).limit(RESOLVE_LIMIT_LEGACY);
        if (mode === 'field' && existingNodes.length > RESOLVE_WARN_THRESHOLD) {
          console.warn(
            `Resolution is scanning ${existingNodes.length} nodes in JS — approaching the ` +
            `in-memory ceiling. Move seed/candidate selection to pgvector ANN before this grows further.`
          );
        }

        // Resolve entities: embedding-based (field) or LLM (legacy).
        let resolverOutput;
        let vectorsByName = new Map<string, number[]>();
        if (mode === 'field') {
          const existingIds = existingNodes.map((n) => n.id);
          const nodeVectorMap = new Map<string, number[]>();
          if (existingIds.length > 0) {
            const vecRows = await db
              .select()
              .from(nodeVectors)
              .where(inArray(nodeVectors.nodeId, existingIds));
            for (const v of vecRows) nodeVectorMap.set(v.nodeId, v.embedding as number[]);
          }
          const fieldOut = await resolveEntitiesEmbed(
            extractorOutput,
            existingNodes as any,
            nodeVectorMap
          );
          resolverOutput = fieldOut;
          vectorsByName = fieldOut.vectorsByName;
        } else {
          resolverOutput = await resolveEntities(extractorOutput, existingNodes);
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
            const existingByName = await db
              .select()
              .from(nodes)
              .where(
                and(
                  ilike(nodes.normalizedName, entity.canonicalName.toLowerCase()),
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
                    .values({ nodeId: newNode.id, embedding: vec, model: embedModel() })
                    .onConflictDoNothing();
                }
              }
            }
          } else if (entity.canonicalId) {
            entityMap.set(entity.canonicalName.toLowerCase(), entity.canonicalId);
          }
        }

        const graphContext = {
          nodes: existingNodes.slice(0, 50),
          paperDate: paper.publicationDate,
        };

        const validationOutput = mode === 'field'
          ? validateRelationshipsRules(resolverOutput, {
              nodes: existingNodes as any,
              paperDate: paper.publicationDate,
            })
          : await validateRelationships(resolverOutput, graphContext);
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

            const newConfidence = Number(relationship.confidence) || 0.5;

            // Dedup: an identical (source, target, type) edge within a domain is
            // the SAME claim seen again, not a new one. Creating a second edge
            // double-counts that relation's weight in PPR. Instead, reinforce the
            // existing edge's confidence (noisy-OR) and append another provenance
            // row — every occurrence still gets recorded in `sources`.
            const [existingEdge] = await db
              .select()
              .from(edges)
              .where(
                and(
                  eq(edges.sourceId, sourceId),
                  eq(edges.targetId, targetId),
                  eq(edges.type, relationship.type),
                  domainWhere(edges.domain, domain.id)
                )
              )
              .limit(1);

            let edgeId: string;
            if (existingEdge) {
              const combined = combineConfidence(
                Number(existingEdge.confidence) || 0.5,
                newConfidence
              );
              await db
                .update(edges)
                .set({ confidence: combined.toFixed(2) })
                .where(eq(edges.id, existingEdge.id));
              edgeId = existingEdge.id;
            } else {
              const [edge] = await db
                .insert(edges)
                .values({
                  sourceId,
                  targetId,
                  type: relationship.type as any,
                  domain: domain.id,
                  confidence: String(newConfidence),
                })
                .returning();
              edgeId = edge.id;
              stats.relationshipsCreated++;
            }

            await db.insert(sources).values({
              edgeId,
              paperId: paperId,
              section: section,
              extractedText: relationship.evidence?.slice(0, 1000),
            });

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
        if (mode === 'field' && propsToWrite.length > 0) {
          try {
            const embs = await embed(propsToWrite.map((p) => p.text), 'proposition');
            await db.insert(propositions).values(
              propsToWrite.map((p, idx) => ({
                paperId,
                text: p.text,
                embedding: embs[idx],
                nodeIds: p.nodeIds,
                section,
                domain: domain.id,
              }))
            );
          } catch (propError) {
            console.error('Error writing propositions:', propError);
          }
        }

        stats.chunksProcessed++;
      } catch (chunkError) {
        console.error(`Error processing chunk ${i}:`, chunkError);
        stats.chunksProcessed++;
      }

      await new Promise(resolve => setTimeout(resolve, 500));
    }

    await db
      .update(papers)
      .set({
        processed: true,
        processingStatus: 'completed',
        processingProgress: 100,
        updatedAt: new Date()
      })
      .where(eq(papers.id, paperId));
    emitPaperProgress({ paperId, status: 'completed', progress: 100 });

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Finished processing paper: ${paper.title}`);
    console.log(`Stats: ${JSON.stringify(stats, null, 2)}`);
    console.log(`${'='.repeat(60)}\n`);

    return stats;
  } catch (error) {
    console.error(`Error processing paper ${paperId}:`, error);
    throw error;
  }
}

async function getOrCreatePaperNode(paper: any, domainId: string): Promise<string> {
  const existing = await db
    .select()
    .from(nodes)
    .where(eq(nodes.paperId, paper.id))
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

// Legacy (LLM) resolution stuffs candidate nodes into a prompt, so it must stay
// bounded; field mode has no such limit. Past this many in-domain nodes the JS
// cosine scan is the bottleneck and pgvector ANN is the next step.
const RESOLVE_LIMIT_LEGACY = 500;
const RESOLVE_WARN_THRESHOLD = 5000;

/**
 * Noisy-OR confidence combine for an edge reinforced by repeated evidence:
 * monotonically increasing, bounded in [0, 0.99]. Two independent 0.6 mentions
 * → 0.84, three → ~0.94. Capped below 1 so nothing reads as certain.
 */
function combineConfidence(oldC: number, newC: number): number {
  return Math.min(0.99, 1 - (1 - oldC) * (1 - newC));
}

function findEntityId(entityMap: Map<string, string>, name: string): string | null {
  if (!name) return null;

  const normalized = name.toLowerCase().trim();

  // Exact normalized match is the common, unambiguous case.
  if (entityMap.has(normalized)) {
    return entityMap.get(normalized)!;
  }

  // Guarded fuzzy fallback. Short strings ("GS", "PSNR") collide with too many
  // keys via substring matching, so require length >= 4 on both sides AND a
  // unique match. If more than one key matches, return null and skip the edge —
  // a missing edge is recoverable; a wrong one silently corrupts the graph.
  if (normalized.length < 4) return null;

  const matches: string[] = [];
  for (const [key, value] of entityMap.entries()) {
    if (key.length < 4) continue;
    if (key.includes(normalized) || normalized.includes(key)) {
      matches.push(value);
      if (matches.length > 1) return null;
    }
  }

  return matches.length === 1 ? matches[0] : null;
}

function isValidEdgeType(type: string): boolean {
  // Types are open: accept any non-empty type the extractor/validator produced.
  // The rule validator (validate-rules.ts) handles semantic compatibility.
  return typeof type === 'string' && type.trim().length > 0;
}

export async function reprocessPaper(paperId: string): Promise<ProcessingStats> {
  // Propositions reference the paper row (which survives a reprocess), so they
  // are NOT removed by cascade and would otherwise duplicate on every rerun.
  await db.delete(propositions).where(eq(propositions.paperId, paperId));

  // Deleting this paper's nodes cascades (FK onDelete) to their edges,
  // node_vectors, and the sources attached to those edges — no manual per-node
  // edge sweep needed (the previous version's first delete matched a paper id
  // against an edge's node-id source and silently did nothing).
  await db.delete(nodes).where(eq(nodes.paperId, paperId));

  await db
    .update(papers)
    .set({ processed: false, processingStatus: 'pending', processingProgress: 0 })
    .where(eq(papers.id, paperId));

  return processPaper(paperId);
}