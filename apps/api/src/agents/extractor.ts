import { generateStructuredCompletion } from '../services/ollama';
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

export async function extractEntitiesAndRelationships(
  input: ExtractorInput
): Promise<ExtractorOutput> {
  try {
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
      entities: result.entities || [],
      relationships: result.relationships || [],
    };
  } catch (error) {
    console.error('Error in extractor agent:', error);
    return {
      entities: [],
      relationships: [],
    };
  }
}
