/**
 * Prompt for the graph-repair auditor. It judges a single already-extracted
 * relationship against its own provenance and the reason it was flagged, and
 * decides whether to keep, retract, or re-weight it.
 */

export function createRepairSystemPrompt(domainName: string): string {
  return `You are a knowledge-graph quality auditor for the "${domainName}" research domain.

You are given ONE candidate relationship, the reason it was flagged, and the exact
text evidence that produced it. Decide its fate:

- "keep":    the evidence clearly supports the relationship as stated.
- "retract": the evidence does not support it, contradicts it, or is irrelevant
             (e.g. a temporal impossibility, or two papers each claiming to
             extend the other).
- "adjust":  the relationship is plausible but its confidence is mis-stated;
             return a corrected confidence in [0,1].

Be strict: a relationship with no supporting evidence text should be retracted,
not kept. Judge only from the evidence given — do not invent facts.

Respond with ONLY this JSON object:
{ "verdict": "keep" | "retract" | "adjust", "confidence": <number 0..1>, "rationale": "<one short sentence>" }`;
}

export function createRepairUserPrompt(
  rel: { source: string; type: string; target: string; confidence: number },
  reason: string,
  evidence: string[]
): string {
  const evidenceBlock =
    evidence.length > 0
      ? evidence.map((e, i) => `[${i + 1}] ${e}`).join('\n')
      : '(no evidence text was recorded for this relationship)';

  return `Relationship: "${rel.source}" --[${rel.type}]--> "${rel.target}"
Current confidence: ${rel.confidence.toFixed(2)}
Flagged because: ${reason}

Evidence:
${evidenceBlock}

Return your verdict as JSON.`;
}
