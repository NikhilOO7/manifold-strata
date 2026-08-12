/**
 * Embedding-based entity resolution — replaces the Resolver LLM agent.
 *
 * Instead of asking an LLM to canonicalize/dedup mentions (1 call per chunk),
 * we embed every mention in ONE batch call and match it against existing graph
 * nodes by max(cosine, normalized-name). This collapses "3DGS" / "3D-GS" /
 * "3D Gaussian Splatting" via embedding proximity, with zero LLM calls.
 *
 * Output shape is identical to the LLM resolver (ResolverOutput) so the
 * processor's downstream code is unchanged.
 */

import { embed, cosine } from '../services/embeddings';
import type { ExtractorOutput } from '../agents/extractor';
import type { ResolverOutput, ResolvedEntity, ResolvedRelationship } from '../agents/resolver';

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
  existingNodes: ExistingNode[],
  nodeVectors: Map<string, number[]>
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

  // 3. Precompute existing-node lookup structures.
  const byNormName = new Map<string, ExistingNode>();
  for (const n of existingNodes) {
    if (n.normalizedName) byNormName.set(n.normalizedName, n);
    byNormName.set(norm(n.name), n);
  }

  const resolvedEntities: ResolvedEntity[] = [];
  // Maps normalized mention -> chosen canonical display name (for relationships).
  const canonicalByMention = new Map<string, string>();

  candidates.forEach((cand, i) => {
    const key = norm(cand.mention);
    const vec = vectors[i];
    vectorsByName.set(key, vec);

    // Exact / normalized-name match first (cheap and unambiguous).
    let matched = byNormName.get(key);

    // Embedding match against same-type existing nodes that have a cached vector.
    if (!matched) {
      let best: ExistingNode | undefined;
      let bestScore = SIM_THRESHOLD;
      for (const n of existingNodes) {
        const nodeType = normalizeType(n.type);
        if (nodeType !== cand.type && cand.type !== 'paper' && nodeType !== 'paper') {
          // allow cross-type only when one side is a paper; otherwise require same type
          if (nodeType !== cand.type) continue;
        }
        const nv = nodeVectors.get(n.id);
        if (!nv) continue;
        const score = cosine(vec, nv);
        if (score > bestScore) {
          bestScore = score;
          best = n;
        }
      }
      matched = best;
    }

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
