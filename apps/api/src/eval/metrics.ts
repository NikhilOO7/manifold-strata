/**
 * Matching + scoring helpers for the eval harness.
 *
 * Entity/relation matching is alias-aware and punctuation-insensitive: "3D-GS",
 * "3DGS", and "3D Gaussian Splatting" compare equal. Precision/recall/F1 follow
 * the standard set-overlap definitions.
 */

export interface PRF {
  precision: number;
  recall: number;
  f1: number;
  tp: number;
  fp: number;
  fn: number;
}

/** Collapse to alphanumerics for punctuation/spacing-insensitive comparison. */
function tight(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Loose surface-form equality: exact tight match, or a containment for forms
 * long enough that containment is unlikely to be coincidental. */
export function looseEq(a: string, b: string): boolean {
  const ta = tight(a);
  const tb = tight(b);
  if (!ta || !tb) return false;
  if (ta === tb) return true;
  return ta.length >= 4 && tb.length >= 4 && (ta.includes(tb) || tb.includes(ta));
}

/** Does `mention` match any accepted surface form in `group`? */
export function matchesGroup(mention: string, group: string[]): boolean {
  return group.some((g) => looseEq(mention, g));
}

export function prf(tp: number, fp: number, fn: number): PRF {
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1, tp, fp, fn };
}

/** Aggregate several PRF counts into one micro-averaged PRF. */
export function microAverage(parts: PRF[]): PRF {
  const tp = parts.reduce((s, p) => s + p.tp, 0);
  const fp = parts.reduce((s, p) => s + p.fp, 0);
  const fn = parts.reduce((s, p) => s + p.fn, 0);
  return prf(tp, fp, fn);
}

/**
 * Map a free-text relationship predicate to a canonical edge type. This mirrors
 * `toEdgeType` in knowledge-field/resolve-embed.ts so the eval scores the same
 * canonicalization the live pipeline applies.
 */
export function mapEdgeType(predicate: string): string {
  const p = (predicate || '').toLowerCase();
  if (p.includes('extend')) return 'extends';
  if (p.includes('improv') || p.includes('outperform') || p.includes('better than')) return 'improves';
  if (p.includes('introduc') || p.includes('propos') || p.includes('present')) return 'introduces';
  if (p.includes('cite') || p.includes('referenc')) return 'cites';
  if (p.includes('evaluat') || p.includes('benchmark') || p.includes('tested on') || p.includes('trained on'))
    return 'evaluates_on';
  if (p.includes('compar')) return 'compares_to';
  if (p.includes('author') || p.includes('written by')) return 'authored_by';
  return 'uses';
}

export function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}
