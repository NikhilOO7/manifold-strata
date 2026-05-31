/**
 * Rule-based relationship validation — replaces the Validator LLM agent.
 *
 * The validator's real job is mechanical: check that an edge type is compatible
 * with its endpoint types, drop low-confidence/degenerate edges, and dedup.
 * None of that needs an LLM. We encode a type-compatibility matrix + a
 * confidence floor and return the existing ValidationOutput shape. Zero LLM calls.
 */

import type { ResolverOutput, ResolvedRelationship } from '../agents/resolver';

export interface ValidationOutput {
  accepted: ResolvedRelationship[];
  rejected: Array<{ relationship: ResolvedRelationship; reason: string }>;
  confidenceAdjustments: Array<{
    relationshipId: string;
    originalConfidence: number;
    adjustedConfidence: number;
    reason: string;
  }>;
}

export interface ValidateContext {
  nodes?: Array<{ id: string; type: string; name: string; normalizedName: string | null }>;
  paperDate?: string | null;
}

type EntityType = 'method' | 'concept' | 'dataset' | 'metric' | 'paper' | 'unknown';

const CONFIDENCE_FLOOR = 0.4;

function norm(s: string): string {
  return (s || '').toLowerCase().trim();
}

function normalizeType(t: string | undefined): EntityType {
  if (!t) return 'unknown';
  if (t === 'paper_reference' || t === 'paper') return 'paper';
  if (t === 'method' || t === 'concept' || t === 'dataset' || t === 'metric') return t;
  return 'unknown';
}

/**
 * Returns 'ok' | 'soft' | 'reject' for an (edgeType, src, tgt) triple.
 * 'unknown' endpoint types never hard-reject (we lack the info), but can soften.
 */
function checkTypes(edgeType: string, src: EntityType, tgt: EntityType): 'ok' | 'soft' | 'reject' {
  const known = (t: EntityType) => t !== 'unknown';

  switch (edgeType) {
    case 'evaluates_on':
      if (known(tgt) && tgt !== 'dataset' && tgt !== 'metric') return 'reject';
      return 'ok';
    case 'extends':
    case 'improves':
    case 'compares_to':
      // method-on-method (papers allowed as proxies). datasets/metrics can't extend/improve.
      if ((known(src) && (src === 'dataset' || src === 'metric')) ||
          (known(tgt) && (tgt === 'dataset' || tgt === 'metric'))) return 'reject';
      return 'ok';
    case 'authored_by':
      // endpoints should involve a paper; soften if clearly not.
      if (known(src) && known(tgt) && src !== 'paper' && tgt !== 'paper') return 'soft';
      return 'ok';
    case 'cites':
    case 'introduces':
    case 'uses':
    default:
      return 'ok';
  }
}

export function validateRelationshipsRules(
  resolved: ResolverOutput,
  context: ValidateContext = {}
): ValidationOutput {
  // Build a name -> type lookup from the freshly resolved entities and the graph.
  const typeByName = new Map<string, EntityType>();
  for (const e of resolved.resolvedEntities) {
    typeByName.set(norm(e.canonicalName), normalizeType(e.type));
  }
  for (const n of context.nodes ?? []) {
    const t = normalizeType(n.type);
    typeByName.set(norm(n.name), t);
    if (n.normalizedName) typeByName.set(n.normalizedName, t);
  }

  const accepted: ResolvedRelationship[] = [];
  const rejected: ValidationOutput['rejected'] = [];
  const confidenceAdjustments: ValidationOutput['confidenceAdjustments'] = [];
  const seen = new Set<string>();

  for (const rel of resolved.resolvedRelationships) {
    const src = typeByName.get(norm(rel.sourceName)) ?? 'unknown';
    const tgt = typeByName.get(norm(rel.targetName)) ?? 'unknown';

    // Degenerate / self edges.
    if (!rel.sourceName || !rel.targetName || norm(rel.sourceName) === norm(rel.targetName)) {
      rejected.push({ relationship: rel, reason: 'degenerate or self-referential edge' });
      continue;
    }

    // Dedup identical triples.
    const key = `${norm(rel.sourceName)}|${rel.type}|${norm(rel.targetName)}`;
    if (seen.has(key)) {
      rejected.push({ relationship: rel, reason: 'duplicate edge' });
      continue;
    }

    const verdict = checkTypes(rel.type, src, tgt);
    if (verdict === 'reject') {
      rejected.push({
        relationship: rel,
        reason: `type mismatch: ${src} --[${rel.type}]--> ${tgt}`,
      });
      continue;
    }

    let confidence = rel.confidence ?? 0.5;
    if (verdict === 'soft') {
      const adjusted = Math.max(0, confidence - 0.2);
      confidenceAdjustments.push({
        relationshipId: key,
        originalConfidence: confidence,
        adjustedConfidence: adjusted,
        reason: `weak type compatibility for ${rel.type}`,
      });
      confidence = adjusted;
    }

    if (confidence < CONFIDENCE_FLOOR) {
      rejected.push({ relationship: rel, reason: `confidence ${confidence.toFixed(2)} below floor` });
      continue;
    }

    seen.add(key);
    accepted.push({ ...rel, confidence });
  }

  return { accepted, rejected, confidenceAdjustments };
}
