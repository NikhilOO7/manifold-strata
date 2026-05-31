import { generateStructuredCompletion } from '../services/ollama';
import { EXTRACTION_SYSTEM_PROMPT, createExtractionUserPrompt } from './prompts/extraction';

export interface ExtractorInput {
  paperId: string;
  chunkIndex: number;
  text: string;
  section: string;
}

export interface EntityMention {
  mention: string;
  type: 'method' | 'concept' | 'dataset' | 'metric' | 'paper_reference';
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
    const userPrompt = createExtractionUserPrompt(
      input.paperId,
      input.chunkIndex,
      input.text,
      input.section
    );

    const result = await generateStructuredCompletion<ExtractorOutput>(
      EXTRACTION_SYSTEM_PROMPT,
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
