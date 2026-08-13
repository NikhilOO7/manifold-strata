/**
 * Reading a graph as an argument instead of as adjacency.
 *
 * The Explorer used to answer one question — "what is next to this?" — and a
 * list of neighbours is not an explanation. Someone trying to understand a body
 * of work is asking things with shape: what did this paper *contribute*, what
 * did it *build on*, how was it *validated*, what did it claim to *beat*. Those
 * are the same edges, grouped by what they mean rather than by what they are
 * called.
 *
 * So relationship types are folded into roles. A learner does not care that one
 * edge says `evaluates_on` and another says `achieves`; both answer "how do we
 * know this works". Types stay open (invariant 19) — an unrecognised type is
 * kept verbatim and lands in `covers`, never renamed, never dropped.
 *
 * The ordering of roles is the order the questions get asked, which is why it is
 * fixed here rather than sorted by count: a paper's contribution comes before
 * its lineage, and its evidence before its boasts.
 */

export type LensRole = 'contributes' | 'builds_on' | 'uses' | 'validated_on' | 'compared_with' | 'covers';

export interface RoleDefinition {
  role: LensRole;
  /** Shown as the section heading — phrased as the question it answers. */
  label: string;
  /** One line of context, so a reader learns what the section means. */
  hint: string;
}

export const ROLE_ORDER: RoleDefinition[] = [
  {
    role: 'contributes',
    label: 'Introduces',
    hint: 'What this work puts forward as new.',
  },
  {
    role: 'builds_on',
    label: 'Builds on',
    hint: 'Existing work it extends or improves — the lineage it belongs to.',
  },
  {
    role: 'uses',
    label: 'Uses',
    hint: 'Components and techniques it depends on.',
  },
  {
    role: 'validated_on',
    label: 'Validated on',
    hint: 'The datasets and metrics its claims rest on.',
  },
  {
    role: 'compared_with',
    label: 'Compared with',
    hint: 'What it measures itself against.',
  },
  {
    role: 'covers',
    label: 'Also covers',
    hint: 'Named in the text, without a stated relationship.',
  },
];

/**
 * Which question an edge type answers.
 *
 * Matching is by substring on a normalised type so that the open vocabulary
 * keeps working: a connector emitting `proposes_method` or `is_evaluated_on`
 * lands in the right place without this list being updated, and anything
 * genuinely unrecognised falls through to `covers` rather than being discarded.
 */
export function roleForEdgeType(edgeType: string): LensRole {
  const t = (edgeType || '').toLowerCase();

  if (t === 'mentions') return 'covers';
  if (t.includes('introduc') || t.includes('propos') || t.includes('present') || t.includes('contribut')) {
    return 'contributes';
  }
  if (t.includes('extend') || t.includes('improv') || t.includes('build') || t.includes('fine_tune') || t.includes('based')) {
    return 'builds_on';
  }
  if (t.includes('evaluat') || t.includes('achiev') || t.includes('measur') || t.includes('trained_on') || t.includes('tested')) {
    return 'validated_on';
  }
  if (t.includes('outperform') || t.includes('compar') || t.includes('beat') || t.includes('versus')) {
    return 'compared_with';
  }
  if (t.includes('use') || t.includes('comput') || t.includes('appl') || t.includes('requir')) {
    return 'uses';
  }
  return 'covers';
}

/**
 * Direction matters for meaning, not just for drawing.
 *
 * "A extends B" seen from B is "extended by A" — the same edge teaches a
 * different thing from each end, and showing B a section called "Builds on"
 * containing its own descendants would be actively misleading.
 */
export function roleForIncomingEdgeType(edgeType: string): LensRole {
  const outgoing = roleForEdgeType(edgeType);
  if (outgoing === 'builds_on') return 'contributes'; // things built on this
  if (outgoing === 'contributes') return 'builds_on'; // introduced by
  return outgoing;
}

/** Human phrasing for an incoming edge, e.g. `extends` → `extended by`. */
export function invertPhrase(edgeType: string): string {
  const t = (edgeType || '').toLowerCase().replace(/_/g, ' ');
  if (t.endsWith('s')) return `${t.slice(0, -1)}ed by`.replace(/eed by$/, 'ed by');
  return `${t} by`;
}
