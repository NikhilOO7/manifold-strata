import { generateStructuredCompletion } from '../services/llm';
import { RESOLUTION_SYSTEM_PROMPT, createResolutionUserPrompt } from './prompts/resolution';
import type { ExtractorOutput } from './extractor';

export interface ResolvedEntity {
  mention: string;
  canonicalId: string | null;
  canonicalName: string;
  /** Open — any type the domain, extractor, or connector uses. */
  type: string;
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
  const userPrompt = createResolutionUserPrompt(extractedData, existingEntities);

  // Propagates model failures — see the note in extractor.ts. Swallowing them
  // here dropped every entity in the chunk while reporting success.
  const result = await generateStructuredCompletion<ResolverOutput>(
    RESOLUTION_SYSTEM_PROMPT,
    userPrompt,
    null,
    0.3,
    2,
    'resolver'
  );

  return {
    resolvedEntities: Array.isArray(result?.resolvedEntities) ? result.resolvedEntities : [],
    resolvedRelationships: Array.isArray(result?.resolvedRelationships)
      ? result.resolvedRelationships
      : [],
  };
}
