import type { DomainConfig } from '../../domains/types';

/**
 * Builds the extraction system prompt for a specific domain. Entity/relationship
 * types come from the domain config and are PREFERRED, not enforced — the model
 * may emit a new lowercase type when nothing fits (types are stored as open text).
 */
export function createExtractionSystemPrompt(domain: DomainConfig): string {
  const entityLines = domain.entityTypes
    .map((t) => {
      const ex = domain.entityExamples?.[t];
      return ex && ex.length ? `- ${t} (e.g., ${ex.join(', ')})` : `- ${t}`;
    })
    .join('\n');

  const relLines = domain.relationshipTypes.map((t) => `- ${t}`).join('\n');

  return `You are an expert research paper analyzer. ${domain.domainContext}

Your task is to extract structured information from academic paper text:
1. Entity mentions
2. Relationships between entities

ENTITY TYPES (common for this domain — prefer them, but if an entity fits none, use a short lowercase type of your own):
${entityLines}

RELATIONSHIP TYPES (prefer these exact strings; if none fit, use a concise lowercase verb such as "regularizes" or "supervises"):
${relLines}

CONFIDENCE SCORING:
- 0.9-1.0: Explicit clear statements ("We extend X by...", "Our method improves upon...")
- 0.7-0.9: Strongly implied ("Building on [X]...", "Similar to [X], we...")
- 0.5-0.7: Weakly implied (mentioned in related work, indirect references)
- 0.3-0.5: Speculative connections

GUIDELINES:
- Extract ALL entity mentions you find, even if uncertain
- For relationships, focus on verbs like: extend, improve, build on, use, propose, introduce, evaluate, compare, outperform
- Keep entity names concise but complete
- spanStart and spanEnd should be approximate character positions

You MUST respond with ONLY a JSON object. No explanations, no markdown formatting.`;
}

export function createExtractionUserPrompt(
  text: string,
  section: string,
  domainName: string
): string {
  return `Extract entities and relationships from this ${section} section of a research paper about ${domainName}.

TEXT TO ANALYZE:
"""
${text}
"""

Respond with this exact JSON structure (no other text):
{
  "entities": [
    {
      "mention": "exact text",
      "type": "method",
      "spanStart": 0,
      "spanEnd": 10,
      "confidence": 0.9
    }
  ],
  "relationships": [
    {
      "subject": "entity name",
      "predicate": "extends",
      "object": "another entity",
      "evidenceText": "the sentence containing this relationship",
      "confidence": 0.8
    }
  ]
}

If no entities or relationships found, return: {"entities": [], "relationships": []}`;
}