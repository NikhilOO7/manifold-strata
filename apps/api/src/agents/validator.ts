import { generateStructuredCompletion } from '../services/llm';
import { VALIDATION_SYSTEM_PROMPT, createValidationUserPrompt } from './prompts/validation';
import type { ResolverOutput, ResolvedRelationship } from './resolver';

export interface ValidationOutput {
  accepted: ResolvedRelationship[];
  rejected: Array<{
    relationship: ResolvedRelationship;
    reason: string;
  }>;
  confidenceAdjustments: Array<{
    relationshipId: string;
    originalConfidence: number;
    adjustedConfidence: number;
    reason: string;
  }>;
}

export async function validateRelationships(
  resolvedData: ResolverOutput,
  graphContext: any
): Promise<ValidationOutput> {
  const userPrompt = createValidationUserPrompt(resolvedData, graphContext);

  // Propagates model failures. The previous catch returned
  // `accepted: resolvedData.resolvedRelationships` — i.e. when the validator
  // failed, every unvalidated relationship was admitted to the graph. A check
  // that passes everything the moment it breaks is worse than no check, because
  // the graph still looks validated.
  const result = await generateStructuredCompletion<ValidationOutput>(
    VALIDATION_SYSTEM_PROMPT,
    userPrompt,
    null,
    0.3,
    2,
    'validator'
  );

  return {
    accepted: Array.isArray(result?.accepted) ? result.accepted : [],
    rejected: Array.isArray(result?.rejected) ? result.rejected : [],
    confidenceAdjustments: Array.isArray(result?.confidenceAdjustments)
      ? result.confidenceAdjustments
      : [],
  };
}
