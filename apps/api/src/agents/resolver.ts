import { generateStructuredCompletion } from '../services/ollama';
import { RESOLUTION_SYSTEM_PROMPT, createResolutionUserPrompt } from './prompts/resolution';
import type { ExtractorOutput } from './extractor';

export interface ResolvedEntity {
  mention: string;
  canonicalId: string | null;
  canonicalName: string;
  type: 'method' | 'concept' | 'dataset' | 'metric' | 'paper';
  isNew: boolean;
  confidence: number;
}

export interface ResolvedRelationship {
  sourceName: string;  // Canonical entity name (NOT UUID)
  targetName: string;  // Canonical entity name (NOT UUID)
  type: string;
  confidence: number;
  evidence: string;
}

export interface ResolverOutput {
  resolvedEntities: ResolvedEntity[];
  resolvedRelationships: ResolvedRelationship[];
}

export async function resolveEntities(
  extractedData: ExtractorOutput,
  existingEntities: any[]
): Promise<ResolverOutput> {
  try {
    const userPrompt = createResolutionUserPrompt(extractedData, existingEntities);

    const result = await generateStructuredCompletion<ResolverOutput>(
      RESOLUTION_SYSTEM_PROMPT,
      userPrompt,
      null,
      0.3,
      2,
      'resolver'
    );

    return {
      resolvedEntities: result.resolvedEntities || [],
      resolvedRelationships: result.resolvedRelationships || [],
    };
  } catch (error) {
    console.error('Error in resolver agent:', error);
    return {
      resolvedEntities: [],
      resolvedRelationships: [],
    };
  }
}
