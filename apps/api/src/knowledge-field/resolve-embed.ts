/**
 * Embedding-based entity resolution — replaces the Resolver LLM agent.
 *
 * Instead of asking an LLM to canonicalize/dedup mentions (1 call per chunk),
 * we embed every mention in ONE batch call and match it against existing graph
 * nodes by exact normalized name, then by embedding proximity. This collapses
 * "3DGS" / "3D-GS" / "3D Gaussian Splatting" onto one node, with zero LLM calls.
 *
 * Candidates arrive through a `CandidateSource` rather than as a preloaded
 * array. That indirection is the correctness fix, not a style choice: the array
 * form could only ever hold a bounded slice of the graph, so resolution quality
 * decayed as the corpus grew and entities silently forked past the window. See
 * `resolve-candidates.ts` for the measurement and the failure mode. It also
 * keeps this function pure and unit-testable with no database.
 *
 * Output shape is identical to the LLM resolver (ResolverOutput) so the
 * processor's downstream code is unchanged.
 */

import { embed, cosine } from '../services/embeddings';
import type { ExtractorOutput } from '../agents/extractor';
import type { ResolverOutput, ResolvedEntity, ResolvedRelationship } from '../agents/resolver';
import type { CandidateSource, ScoredCandidate } from './resolve-candidates';

/** Resolver output plus the mention embeddings, keyed by normalized canonical
 * name, so the processor can persist node_vectors without re-embedding. */
export interface EmbedResolverOutput extends ResolverOutput {
  vectorsByName: Map<string, number[]>;
}

export interface ExistingNode {
  id: string;
  type: string;
  name: string;
  normalizedName: string | null;
}

/**
 * Entity types are open — any non-empty string a domain or connector uses.
 *
 * This used to collapse anything outside a hardcoded list of five to `concept`,
 * which silently contradicted the system's own claim that types are free-form.
 * The cost only became visible with a structured source: importing an API
 * surface produced `api`, `endpoint`, `capability`, `schema` and `auth` entities
 * and stored all of them as `concept`, discarding a taxonomy the source had
 * stated exactly and that nothing downstream could recover.
 */
type EntityType = string;

// Cosine threshold for treating a mention as an existing node. Same-type matches
// use a slightly lower bar than cross-type (which we disallow except paper).
const SIM_THRESHOLD = 0.82;

/**
 * Canonical form of a type. Only `paper_reference` is folded (into `paper`),
 * because the extractor emits both names for the same thing; every other type
 * is preserved as written.
 */
function normalizeType(t: string): EntityType {
  const canonical = (t || '').trim().toLowerCase();
  if (canonical === 'paper_reference' || canonical === 'paper') return 'paper';
  return canonical || 'concept';
}

function norm(s: string): string {
  return s.toLowerCase().trim();
}

/**
 * Map a predicate to an edge type.
 *
 * A predicate that is already an identifier — `exposes`, `belongs_to`,
 * `evaluates_on` — is used verbatim. Structured connectors and domain ontologies
 * state their relationship types precisely, and running them through the
 * natural-language keyword mapping below turned every one of them into `uses`.
 * Only prose predicates, which is what a language model produces, get mapped.
 */
function toEdgeType(predicate: string): string {
  const raw = (predicate || '').trim();
  if (/^[a-z][a-z0-9_]*$/.test(raw)) return raw;

  const p = raw.toLowerCase();
  if (p.includes('extend')) return 'extends';
  if (p.includes('improv') || p.includes('outperform') || p.includes('better than')) return 'improves';
  if (p.includes('introduc') || p.includes('propos') || p.includes('present')) return 'introduces';
  if (p.includes('cite') || p.includes('referenc')) return 'cites';
  if (p.includes('evaluat') || p.includes('benchmark') || p.includes('tested on') || p.includes('trained on')) return 'evaluates_on';
  if (p.includes('compar')) return 'compares_to';
  if (p.includes('author') || p.includes('written by')) return 'authored_by';
  return 'uses';
}

interface Candidate {
  mention: string;
  type: EntityType;
}

export async function resolveEntitiesEmbed(
  extracted: ExtractorOutput,
  candidates_: CandidateSource
): Promise<EmbedResolverOutput> {
  // 1. Gather all mentions that need a canonical identity: extracted entities
  //    PLUS relationship endpoints (so every edge endpoint exists in the map).
  const typeByMention = new Map<string, EntityType>();
  const candidates: Candidate[] = [];

  const addCandidate = (mention: string, type: EntityType) => {
    const key = norm(mention);
    if (!key || typeByMention.has(key)) return;
    typeByMention.set(key, type);
    candidates.push({ mention: mention.trim(), type });
  };

  for (const e of extracted.entities) {
    addCandidate(e.mention, normalizeType(e.type));
  }
  for (const r of extracted.relationships) {
    if (r.subject) addCandidate(r.subject, typeByMention.get(norm(r.subject)) ?? 'concept');
    if (r.object) addCandidate(r.object, typeByMention.get(norm(r.object)) ?? 'concept');
  }

  if (candidates.length === 0) {
    return { resolvedEntities: [], resolvedRelationships: [], vectorsByName: new Map() };
  }

  // 2. One batch embed call for every mention.
  const vectors = await embed(candidates.map((c) => c.mention), 'resolve-embed');
  const vectorsByName = new Map<string, number[]>();
  candidates.forEach((cand, i) => vectorsByName.set(norm(cand.mention), vectors[i]));

  // 3. Two indexed lookups for the whole batch, over the WHOLE domain: exact
  //    normalized name, then approximate nearest neighbours. Both are bounded by
  //    the number of mentions, not by the size of the graph.
  const byNormName = await candidates_.byName(candidates.map((c) => norm(c.mention)));

  // Only mentions with no exact match need the vector search; skipping the rest
  // keeps the k-NN batch as small as the work actually requires.
  const annIndex: number[] = [];
  const annQueries: Array<{ vector: number[]; type: string }> = [];
  candidates.forEach((cand, i) => {
    if (byNormName.has(norm(cand.mention))) return;
    annIndex.push(i);
    annQueries.push({ vector: vectors[i], type: cand.type });
  });

  const annResults = await candidates_.byVector(annQueries);
  const nearestByCandidate = new Map<number, ExistingNode | undefined>();
  annIndex.forEach((candIdx, queryIdx) => {
    const ranked = annResults[queryIdx] ?? [];
    // Re-apply the threshold and the type rule here as well as in SQL. The
    // storage layer constrains the search; this is the rule the resolver is
    // actually accountable for, and it must hold whatever the source returns.
    const eligible = ranked.filter(
      (c) =>
        c.score > SIM_THRESHOLD &&
        (normalizeType(c.type) === candidates[candIdx].type ||
          normalizeType(c.type) === 'paper' ||
          candidates[candIdx].type === 'paper')
    );
    // Highest score, not first returned. The source promises ordering; the
    // resolver does not depend on it, so a source that relaxes ordering for
    // speed cannot quietly change which entity a mention resolves to.
    let best: ScoredCandidate | undefined;
    for (const c of eligible) if (!best || c.score > best.score) best = c;
    nearestByCandidate.set(candIdx, best);
  });

  const resolvedEntities: ResolvedEntity[] = [];
  // Maps normalized mention -> chosen canonical display name (for relationships).
  const canonicalByMention = new Map<string, string>();

  // Mentions that resolve to nothing in the graph are still not necessarily
  // distinct from each other. A single chunk routinely names one thing twice
  // ("Helios" and "Helios system") and, because neither exists yet, the graph
  // lookups above cannot relate them — they would become two nodes for one
  // entity, in one document. That is the same fragmentation the indexed lookups
  // fixed between documents, and it has to die on both sides or the class is
  // only half dead. So new mentions are also compared against each other, in
  // order, with the same threshold and type rule. First occurrence wins the
  // canonical name: it is deterministic, and the first mention of a thing is
  // usually the definitional one. The comparison is O(new²) in a chunk's handful
  // of mentions, all vectors already in hand from the single batch embed.
  const freshCanonical: Array<{ name: string; vector: number[]; type: EntityType }> = [];

  const typesCompatible = (a: EntityType, b: EntityType): boolean =>
    a === b || a === 'paper' || b === 'paper';

  candidates.forEach((cand, i) => {
    const key = norm(cand.mention);

    // Exact / normalized-name match first (cheap and unambiguous).
    const matched = byNormName.get(key) ?? nearestByCandidate.get(i);

    if (matched) {
      canonicalByMention.set(key, matched.name);
      resolvedEntities.push({
        mention: cand.mention,
        canonicalId: matched.id,
        canonicalName: matched.name,
        type: normalizeType(matched.type),
        isNew: false,
        confidence: 0.9,
      });
    } else {
      // Nothing in the graph. Before minting an identity, check the identities
      // this very batch has already minted.
      const vec = vectors[i];
      let twin: { name: string; type: EntityType } | undefined;
      let twinScore = SIM_THRESHOLD;
      for (const prior of freshCanonical) {
        if (!typesCompatible(prior.type, cand.type)) continue;
        const score = cosine(vec, prior.vector);
        if (score > twinScore) {
          twinScore = score;
          twin = prior;
        }
      }

      if (twin) {
        // Same canonical name as its twin. The processor already keys new nodes
        // by canonical name within a run, so this collapses to one node without
        // any further coordination.
        canonicalByMention.set(key, twin.name);
        resolvedEntities.push({
          mention: cand.mention,
          canonicalId: null,
          canonicalName: twin.name,
          type: twin.type,
          isNew: true,
          confidence: 0.7,
        });
      } else {
        freshCanonical.push({ name: cand.mention, vector: vec, type: cand.type });
        canonicalByMention.set(key, cand.mention);
        resolvedEntities.push({
          mention: cand.mention,
          canonicalId: null,
          canonicalName: cand.mention,
          type: cand.type,
          isNew: true,
          confidence: 0.7,
        });
      }
    }
  });

  // 4. Resolve relationships to canonical endpoint names.
  const resolvedRelationships: ResolvedRelationship[] = [];
  for (const r of extracted.relationships) {
    const sourceName = canonicalByMention.get(norm(r.subject || ''));
    const targetName = canonicalByMention.get(norm(r.object || ''));
    if (!sourceName || !targetName || sourceName === targetName) continue;

    resolvedRelationships.push({
      sourceName,
      targetName,
      type: toEdgeType(r.predicate),
      confidence: r.confidence ?? 0.5,
      evidence: r.evidenceText || '',
    });
  }

  return { resolvedEntities, resolvedRelationships, vectorsByName };
}
