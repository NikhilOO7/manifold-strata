import { generateStructuredCompletion } from '../services/llm';
import { createExtractionSystemPrompt, createExtractionUserPrompt } from './prompts/extraction';
import { getDomain, type DomainConfig } from '../domains';

export interface ExtractorInput {
  paperId: string;
  chunkIndex: number;
  text: string;
  section: string;
  domain?: DomainConfig;
}

export interface EntityMention {
  mention: string;
  type: string; // open (free-form), scoped to the paper's domain
  spanStart: number;
  spanEnd: number;
  confidence: number;
}

export interface Relationship {
  subject: string;
  predicate: string;
  object: string;
  evidenceText: string;
  confidence: number;
}

export interface ExtractorOutput {
  entities: EntityMention[];
  relationships: Relationship[];
}

/**
 * Extract entity mentions and candidate relationships from one chunk.
 *
 * Throws on model failure rather than returning `{entities: [], relationships: []}`.
 * An empty result and a failed call are different facts about the corpus: the
 * first says "this chunk asserts nothing", the second says "we do not know what
 * this chunk asserts". Collapsing them let a total LLM outage produce a paper
 * marked fully processed with an empty graph. The processor decides the policy.
 */
export async function extractEntitiesAndRelationships(
  input: ExtractorInput
): Promise<ExtractorOutput> {
  const domain = input.domain ?? getDomain();
  const systemPrompt = createExtractionSystemPrompt(domain);
  const userPrompt = createExtractionUserPrompt(input.text, input.section, domain.name);

  const result = await generateStructuredCompletion<ExtractorOutput>(
    systemPrompt,
    userPrompt,
    null,
    0.3,
    2,
    'extractor'
  );

  return {
    entities: Array.isArray(result?.entities) ? result.entities : [],
    relationships: Array.isArray(result?.relationships) ? result.relationships : [],
  };
}
