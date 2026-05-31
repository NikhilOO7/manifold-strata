import { generateStructuredCompletion } from '../services/ollama';
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
  try {
    const userPrompt = createValidationUserPrompt(resolvedData, graphContext);

    const result = await generateStructuredCompletion<ValidationOutput>(
      VALIDATION_SYSTEM_PROMPT,
      userPrompt,
      null,
      0.3,
      2,
      'validator'
    );

    return {
      accepted: result.accepted || [],
      rejected: result.rejected || [],
      confidenceAdjustments: result.confidenceAdjustments || [],
    };
  } catch (error) {
    console.error('Error in validator agent:', error);
    return {
      accepted: resolvedData.resolvedRelationships,
      rejected: [],
      confidenceAdjustments: [],
    };
  }
}
