/**
 * A constructed evaluation corpus with known ground truth.
 *
 * The product's central retrieval claim is that graph structure finds evidence
 * that similarity alone cannot: "what improves something that extends X" needs
 * two hops, and the answer text may share no vocabulary with the question. That
 * claim had never been tested. This corpus tests it by construction.
 *
 * Two question families, deliberately including one the baseline should win or
 * tie — a benchmark that only contains cases we win is marketing, not evidence:
 *
 *   single-hop  the gold evidence is lexically similar to the question. Plain
 *               vector search should do well; the field pipeline must not do
 *               *worse*, which is the regression this guards against.
 *   multi-hop   the gold evidence shares no vocabulary with the question and is
 *               reachable only by traversing two typed edges from the entity the
 *               question names. Similarity search cannot find it in principle.
 *
 * Distractors matter as much as the gold: every question has decoy propositions
 * that *do* share the question's vocabulary but are attached to unrelated
 * entities. Without them, "return everything" would score perfectly.
 *
 * Vectors come from whatever EMBED_PROVIDER is configured. With the local
 * provider the geometry is lexical, which is exactly what makes the multi-hop
 * construction meaningful: disjoint vocabulary really is distant in that space.
 */

import { db } from '../db';
import { nodes, edges, propositions, papers } from '../db/schema';
import { embed, embedSpaceId, embedModel } from '../services/embeddings';
import { inArray } from 'drizzle-orm';

export const EVAL_DOMAIN = 'nlp';
const TAG = 'EVALSET';

export interface GoldQuestion {
  id: string;
  question: string;
  /** Proposition ids that genuinely answer it. */
  goldPropositionIds: string[];
  family: 'single-hop' | 'multi-hop' | 'hub';
  /** How many typed edges separate the question's entity from the answer. */
  hops: number;
}

export interface EvalCorpus {
  questions: GoldQuestion[];
  paperId: string;
  nodeIds: string[];
}

/**
 * Disjoint vocabularies per topic.
 *
 * Invented tokens rather than real words so that no accidental lexical or
 * semantic overlap leaks between a question and its multi-hop answer — with real
 * vocabulary, "improves" appearing in both would hand the baseline a shortcut
 * the construction is meant to deny it.
 */
const ANCHOR_WORDS = ['zeta', 'corvid', 'analysis'];
const MID_WORDS = ['quill', 'lattice', 'harmonic'];
const TARGET_WORDS = ['morrow', 'fenwick', 'sable'];
const DECOY_WORDS = ['thicket', 'plume', 'varnish'];
const HUB_WORDS = ['vellum', 'cistern'];
const SPOKE_WORDS = ['tallow', 'ridgeway'];

function phrase(words: string[], topic: number): string {
  return words.map((w) => `${w}${topic}`).join(' ');
}

export async function buildEvalCorpus(topics = 20): Promise<EvalCorpus> {
  const [paper] = await db
    .insert(papers)
    .values({
      title: `${TAG} evaluation corpus`,
      domain: EVAL_DOMAIN,
      processed: true,
      processingStatus: 'completed',
    })
    .returning();

  const questions: GoldQuestion[] = [];
  const allNodeIds: string[] = [];

  for (let t = 0; t < topics; t++) {
    const anchorText = phrase(ANCHOR_WORDS, t);
    const midText = phrase(MID_WORDS, t);
    const targetText = phrase(TARGET_WORDS, t);
    const decoyText = phrase(DECOY_WORDS, t);

    const nodeRows = await db
      .insert(nodes)
      .values([
        { type: 'method', domain: EVAL_DOMAIN, name: `${TAG} ${anchorText}`, normalizedName: anchorText },
        { type: 'method', domain: EVAL_DOMAIN, name: `${TAG} ${midText}`, normalizedName: midText },
        { type: 'method', domain: EVAL_DOMAIN, name: `${TAG} ${targetText}`, normalizedName: targetText },
        { type: 'concept', domain: EVAL_DOMAIN, name: `${TAG} ${decoyText}`, normalizedName: decoyText },
      ])
      .returning({ id: nodes.id });

    const [anchor, mid, target, decoy] = nodeRows.map((n) => n.id);
    allNodeIds.push(anchor, mid, target, decoy);

    // The chain the multi-hop question must be traversed to answer:
    //   anchor --extends--> mid --improves--> target
    await db.insert(edges).values([
      { sourceId: anchor, targetId: mid, type: 'extends', domain: EVAL_DOMAIN, confidence: '0.9' },
      { sourceId: mid, targetId: target, type: 'improves', domain: EVAL_DOMAIN, confidence: '0.9' },
    ]);

    // Evidence texts. Node vectors are embedded from names; propositions from
    // their own text, exactly as the ingestion pipeline does it.
    const singleHopGoldText = `${TAG} ${anchorText} is evaluated directly and reports strong results.`;
    const multiHopGoldText = `${TAG} ${targetText} supersedes ${midText} under every configuration tested.`;
    const decoyTexts = [
      `${TAG} ${anchorText} is mentioned in passing by an unrelated ${decoyText} survey.`,
      `${TAG} ${anchorText} appears in a ${decoyText} table of contents.`,
      `${TAG} ${decoyText} discusses ${anchorText} without evaluating it.`,
    ];

    const texts = [singleHopGoldText, multiHopGoldText, ...decoyTexts];
    const vectors = await embed(texts, 'eval-corpus');

    const propRows = await db
      .insert(propositions)
      .values([
        {
          paperId: paper.id,
          text: singleHopGoldText,
          embeddingVec: vectors[0],
          nodeIds: [anchor],
          domain: EVAL_DOMAIN,
          space: embedSpaceId(),
        },
        {
          paperId: paper.id,
          text: multiHopGoldText,
          embeddingVec: vectors[1],
          // Attached to the far end of the chain — two hops from the anchor.
          nodeIds: [target, mid],
          domain: EVAL_DOMAIN,
          space: embedSpaceId(),
        },
        ...decoyTexts.map((text, i) => ({
          paperId: paper.id,
          text,
          embeddingVec: vectors[2 + i],
          // Attached to the decoy node, which the chain never reaches.
          nodeIds: [decoy],
          domain: EVAL_DOMAIN,
          space: embedSpaceId(),
        })),
      ])
      .returning({ id: propositions.id });

    // Node vectors last so ANN seeding can find the anchor by name.
    const nodeVectorTexts = [anchorText, midText, targetText, decoyText];
    const nodeVectors = await embed(nodeVectorTexts, 'eval-corpus');
    const { nodeVectors: nodeVectorsTable } = await import('../db/schema');
    await db.insert(nodeVectorsTable).values(
      [anchor, mid, target, decoy].map((id, i) => ({
        nodeId: id,
        embeddingVec: nodeVectors[i],
        model: embedModel(),
        space: embedSpaceId(),
      }))
    );

    questions.push({
      id: `single-${t}`,
      question: anchorText,
      goldPropositionIds: [propRows[0].id],
      family: 'single-hop',
      hops: 0,
    });

    questions.push({
      id: `multi-${t}`,
      // Names only the anchor. The answer is about the target, two hops away,
      // and shares no vocabulary with this string.
      question: `what supersedes what ${anchorText} extends`,
      goldPropositionIds: [propRows[1].id],
      family: 'multi-hop',
      hops: 2,
    });

    // --- Hub family ---------------------------------------------------------
    //
    // A question whose entity sits next to a high-degree hub. On an undirected
    // graph the random-walk component of PPR drifts toward degree, so with too
    // little restart the hub and its many neighbours absorb the mass and the
    // answer attached to the *specific* neighbour gets buried. This is the
    // failure mode that motivated raising `alpha` in the first place; including
    // it here means the restart probability is chosen against both pressures at
    // once instead of whichever one was measured most recently.
    const hubText = phrase(HUB_WORDS, t);
    const spokeText = phrase(SPOKE_WORDS, t);

    const hubRows = await db
      .insert(nodes)
      .values([
        { type: 'concept', domain: EVAL_DOMAIN, name: `${TAG} ${hubText}`, normalizedName: hubText },
        { type: 'method', domain: EVAL_DOMAIN, name: `${TAG} ${spokeText}`, normalizedName: spokeText },
      ])
      .returning({ id: nodes.id });

    const [hub, spoke] = hubRows.map((n) => n.id);
    allNodeIds.push(hub, spoke);

    // The anchor touches the hub; the hub touches the answer-bearing spoke and
    // a crowd of irrelevant neighbours.
    const hubEdges = [
      { sourceId: anchor, targetId: hub, type: 'uses', domain: EVAL_DOMAIN, confidence: '0.9' },
      { sourceId: hub, targetId: spoke, type: 'improves', domain: EVAL_DOMAIN, confidence: '0.9' },
    ];

    const crowdIds: string[] = [];
    const CROWD = 12;
    const crowdRows = await db
      .insert(nodes)
      .values(
        Array.from({ length: CROWD }, (_, i) => ({
          type: 'concept',
          domain: EVAL_DOMAIN,
          name: `${TAG} ${hubText} neighbour ${i}`,
          normalizedName: `${hubText} neighbour ${i}`,
        }))
      )
      .returning({ id: nodes.id });

    for (const row of crowdRows) {
      crowdIds.push(row.id);
      allNodeIds.push(row.id);
      hubEdges.push({
        sourceId: hub,
        targetId: row.id,
        type: 'uses',
        domain: EVAL_DOMAIN,
        confidence: '0.9',
      });
    }
    await db.insert(edges).values(hubEdges);

    const hubGoldText = `${TAG} ${spokeText} is the component that ${hubText} depends on for correctness.`;
    const crowdTexts = crowdRows.map(
      (_, i) => `${TAG} ${hubText} is also referenced by unrelated component ${i}.`
    );
    const hubTexts = [hubGoldText, ...crowdTexts];
    const hubVectors = await embed(hubTexts, 'eval-corpus');

    const hubPropRows = await db
      .insert(propositions)
      .values([
        {
          paperId: paper.id,
          text: hubGoldText,
          embeddingVec: hubVectors[0],
          nodeIds: [spoke],
          domain: EVAL_DOMAIN,
          space: embedSpaceId(),
        },
        ...crowdTexts.map((text, i) => ({
          paperId: paper.id,
          text,
          embeddingVec: hubVectors[1 + i],
          nodeIds: [crowdIds[i]],
          domain: EVAL_DOMAIN,
          space: embedSpaceId(),
        })),
      ])
      .returning({ id: propositions.id });

    const hubNodeVectors = await embed(
      [hubText, spokeText, ...crowdRows.map((_, i) => `${hubText} neighbour ${i}`)],
      'eval-corpus'
    );
    const { nodeVectors: nvTable } = await import('../db/schema');
    await db.insert(nvTable).values(
      [hub, spoke, ...crowdIds].map((id, i) => ({
        nodeId: id,
        embeddingVec: hubNodeVectors[i],
        model: embedModel(),
        space: embedSpaceId(),
      }))
    );

    questions.push({
      id: `hub-${t}`,
      question: `what does ${hubText} depend on`,
      goldPropositionIds: [hubPropRows[0].id],
      family: 'hub',
      hops: 1,
    });
  }

  return { questions, paperId: paper.id, nodeIds: allNodeIds };
}

/** Remove everything buildEvalCorpus created. */
export async function teardownEvalCorpus(corpus: EvalCorpus): Promise<void> {
  if (corpus.nodeIds.length) {
    await db.delete(edges).where(inArray(edges.sourceId, corpus.nodeIds));
    await db.delete(edges).where(inArray(edges.targetId, corpus.nodeIds));
    await db.delete(nodes).where(inArray(nodes.id, corpus.nodeIds));
  }
  await db.delete(propositions).where(inArray(propositions.paperId, [corpus.paperId]));
  await db.delete(papers).where(inArray(papers.id, [corpus.paperId]));
}
