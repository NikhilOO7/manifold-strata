/**
 * Judging whether a node is an entity at all, and whether two are the same one.
 *
 * ## Why this is separate from resolution
 *
 * Resolution asks "which existing node does this mention belong to?" and answers
 * it at write time with the information available then. It cannot ask "should
 * this have been an entity in the first place?", because at write time the
 * extractor's output is all there is. Reading the graph afterwards, the answer is
 * often obvious:
 *
 *   "si,j = maxj iS Ti + E Tj . We predict a non-null answer when s"   ← a formula
 *   "a model architecture eschewing recurrence and instead relying"    ← a clause
 *   "masking out (setting to   ) all values in the input of the sof"   ← truncated
 *
 * Those are extraction failures. They can never merge with anything, they inflate
 * every count, and they fill the entry-point lists a reader is meant to choose
 * from. Naming them is cheap; the extractor learning not to produce them is the
 * real fix and is not yet measurable (see the extraction-quality gap).
 *
 * ## The rule this module obeys
 *
 * Everything here is a *proposal*. The doctrine that governs merging governs
 * cleaning too, and more sharply: a false split leaves two nodes someone can
 * merge later, a false drop destroys evidence permanently. So a detector states
 * a verdict, a reason, and a confidence, and the caller decides. Anything
 * genuinely ambiguous returns `review` rather than guessing — and real data is
 * full of pairs that look like duplicates and are not:
 *
 *   "Base + reverse + dropout + global"  vs  "Base + reverse"     ← two ablations
 *   "WMT translation tasks between En…"  vs  "WMT"                ← two granularities
 *   "Bahdanau et al., 2015; Jean et al…" vs  "Jean et al., 2015"  ← a list vs a member
 *
 * Merging any of those would be silent, permanent damage.
 */

import { mayMerge } from '../knowledge-field/merge-guard';

export type Verdict = 'drop' | 'merge' | 'review' | 'keep';

export interface Judgement {
  verdict: Verdict;
  /** Stated in the operator's terms — a proposal nobody can evaluate is noise. */
  reason: string;
  /** How sure. Only `high` is safe to apply in bulk. */
  confidence: 'high' | 'medium' | 'low';
}

/**
 * Words that carry no identity on their own when they lead a name.
 *
 * Stripped as a *prefix* rather than treated as generic tokens anywhere in the
 * name. "our approach" and "approach" are one thing; "our model" and "their
 * model" are two, and a rule that called both words generic would merge them.
 */
const LEADING_DETERMINERS = /^(our|the|a|an|this|these|their|its|such)\s+/i;

/** Characters that appear in formulae and essentially never in an entity name. */
const FORMULA_CHARS = /[=∑∈≈≤≥←→∇·×÷^]|\b\d+\s*[+\-*/]\s*\d+\b/;

/** Markers of running prose: a name containing a finite clause is a sentence. */
const CLAUSE_MARKERS =
  /\b(we|which|that|when|where|whose|because|while|although|however|therefore|thus|hence)\b/i;

/** Reference artefacts: "[38]", "et al., 2015", "; " separating citations. */
const CITATION_MARKER = /\[\d+\]|\bet\s+al\.?,?\s*\d{4}/i;

export function stripLeadingDeterminer(name: string): string {
  return name.replace(LEADING_DETERMINERS, '').trim();
}

/**
 * Is this name an entity, or a piece of the document that leaked into one?
 *
 * Deliberately requires more than length. Long names are common and legitimate —
 * "WMT 2014 English-to-German translation task" is 43 characters and perfectly
 * good — so length alone is a bad detector. What distinguishes a fragment is
 * *structure*: a finite clause, a formula, or a truncation.
 */
export function judgeName(name: string): Judgement {
  const trimmed = (name || '').trim();

  if (trimmed.length === 0) {
    return { verdict: 'drop', reason: 'empty name', confidence: 'high' };
  }

  if (FORMULA_CHARS.test(trimmed)) {
    return {
      verdict: 'drop',
      reason: 'contains formula notation — this is an equation, not an entity',
      confidence: 'high',
    };
  }

  // A clause marker inside a long string is running prose. Both halves matter:
  // "that" inside a short name may be part of a real title.
  if (trimmed.length > 45 && CLAUSE_MARKERS.test(trimmed)) {
    return {
      verdict: 'drop',
      reason: 'reads as a sentence clause rather than a named thing',
      confidence: 'high',
    };
  }

  // Extraction truncation, in the three shapes it actually takes.
  //
  // Each is gated on length because the same pattern is fine in a short name:
  // "3D Gaussian Splatting" ends in a participle and is a perfectly good entity.
  if (trimmed.length > 45) {
    // …cut on a preposition, conjunction or article.
    if (/\b(of|in|on|to|for|with|and|or|the|a|an|at|by|from)$/i.test(trimmed)) {
      return {
        verdict: 'drop',
        reason: 'ends mid-phrase — the extracted span was cut off',
        confidence: 'high',
      };
    }

    // …cut mid-infinitive: "…through a task to predict".
    if (/\bto\s+\w+$/i.test(trimmed)) {
      return {
        verdict: 'drop',
        reason: 'ends on an infinitive — the extracted span was cut off',
        confidence: 'high',
      };
    }

    // …begins as prose. An entity name rarely opens with a bare article; a
    // sentence lifted out of a paragraph almost always does.
    if (/^(a|an|the)\s+/i.test(trimmed)) {
      return {
        verdict: 'drop',
        reason: 'begins with an article — this is a phrase from the text, not a name',
        confidence: 'high',
      };
    }
  }

  if (CITATION_MARKER.test(trimmed)) {
    return {
      verdict: 'review',
      reason: 'contains a citation marker — likely a reference, not a concept',
      confidence: 'medium',
    };
  }

  if (trimmed.length > 80) {
    return {
      verdict: 'review',
      reason: `${trimmed.length} characters — too long to be a name, but no clear structural tell`,
      confidence: 'low',
    };
  }

  return { verdict: 'keep', reason: 'looks like an entity name', confidence: 'high' };
}

/**
 * A node nothing points at and that points at nothing.
 *
 * Not junk by nature — it is usually a real entity whose paper was cleared and
 * has not been rebuilt yet — so this is only ever a proposal, and a caller
 * repairing a half-processed corpus should ignore it.
 */
export function judgeConnectivity(degree: number): Judgement {
  if (degree === 0) {
    return {
      verdict: 'review',
      reason: 'no edges at all — unreachable by any traversal',
      confidence: 'medium',
    };
  }
  return { verdict: 'keep', reason: `${degree} edge(s)`, confidence: 'high' };
}

export interface Candidate {
  id: string;
  name: string;
  type: string;
}

export interface PairJudgement extends Judgement {
  /** When merging, the node that should survive. */
  keep?: Candidate;
  drop?: Candidate;
}

/**
 * Of two names that mean the same thing, which should remain?
 *
 * Quality first: a survivor that is itself malformed defeats the purpose.
 * "Shorter is better" is the usual case — the longer name is longer because the
 * extractor swept in surrounding words — but it fails exactly where it matters:
 * merging "previous state-of-the-art models" into "previous state-of-the-art "
 * would keep a truncated fragment and discard the good name. Then length, then
 * name order, so the choice is deterministic and two runs never disagree.
 */
function chooseSurvivor(a: Candidate, b: Candidate): [Candidate, Candidate] {
  const goodA = judgeName(a.name).verdict === 'keep';
  const goodB = judgeName(b.name).verdict === 'keep';
  if (goodA !== goodB) return goodA ? [a, b] : [b, a];

  const lenA = a.name.trim().length;
  const lenB = b.name.trim().length;
  if (lenA !== lenB) return lenA < lenB ? [a, b] : [b, a];
  return a.name <= b.name ? [a, b] : [b, a];
}

/**
 * Two nodes the same paper named. Are they the same thing?
 *
 * The merge guard is the authority — the same rules that govern write-time
 * merging govern this one, or the cleaner becomes a back door around them. What
 * this adds is the leading determiner: "our input-feeding approach" and
 * "input-feeding approach" are one thing, and the guard alone would refuse them
 * because "our" is a token one side lacks.
 */
export function judgePair(a: Candidate, b: Candidate): PairJudgement {
  const strippedA = stripLeadingDeterminer(a.name);
  const strippedB = stripLeadingDeterminer(b.name);

  if (strippedA.toLowerCase() === strippedB.toLowerCase()) {
    const [keep, drop] = chooseSurvivor(a, b);
    return {
      verdict: 'merge',
      reason: `identical once a leading determiner is dropped ("${a.name}" / "${b.name}")`,
      confidence: 'high',
      keep,
      drop,
    };
  }

  const verdict = mayMerge({ name: strippedA, type: a.type }, { name: strippedB, type: b.type });
  if (verdict.ok) {
    const [keep, drop] = chooseSurvivor(a, b);
    return {
      verdict: 'merge',
      reason: 'the merge guard permits it — they differ only by generic words',
      confidence: 'medium',
      keep,
      drop,
    };
  }

  // One name containing the other looks like a duplicate and frequently is not:
  // "Base + reverse" and "Base + reverse + dropout" are two ablations. Surfaced
  // for a human, never merged automatically.
  const nestA = strippedA.toLowerCase();
  const nestB = strippedB.toLowerCase();
  if (nestA.startsWith(nestB) || nestB.startsWith(nestA)) {
    return {
      verdict: 'review',
      reason: `one name extends the other, but ${verdict.reason} — could be a variant, not a duplicate`,
      confidence: 'low',
    };
  }

  return { verdict: 'keep', reason: verdict.reason ?? 'distinct', confidence: 'high' };
}
