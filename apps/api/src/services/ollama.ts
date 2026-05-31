import { generateText } from 'ai';
import { ollama } from 'ollama-ai-provider';
import { openai } from '@ai-sdk/openai';
import { recordLLM } from './metrics';

const provider = process.env.LLM_PROVIDER || 'ollama'; // 'ollama' or 'openai'
const baseURL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const ollamaModel = process.env.OLLAMA_MODEL || 'llama3.2:1b';
const openaiModel = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const openaiApiKey = process.env.OPENAI_API_KEY;

export interface OllamaResponse {
  text: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

function getModel() {
  if (provider === 'openai') {
    if (!openaiApiKey) {
      throw new Error('OPENAI_API_KEY not set in environment variables');
    }
    return openai(openaiModel);
  }
  return ollama(ollamaModel);
}

export async function generateCompletion(
  systemPrompt: string,
  userPrompt: string,
  temperature: number = 0.7,
  operation: string = 'llm'
): Promise<OllamaResponse> {
  try {
    // Use OpenAI directly via fetch for reliability
    if (provider === 'openai') {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${openaiApiKey}`,
        },
        body: JSON.stringify({
          model: openaiModel,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature,
          max_tokens: 16384,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`OpenAI API error: ${response.status} ${error}`);
      }

      const data: any = await response.json();
      const text = data.choices[0]?.message?.content || '';

      const usage = data.usage ? {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
      } : undefined;

      recordLLM(operation, usage);

      return { text, usage };
    }

    // Fallback to AI SDK for Ollama
    const result = await generateText({
      model: getModel() as any,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature,
      maxTokens: 16384,
    });

    const usage = result.usage ? {
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      totalTokens: result.usage.totalTokens,
    } : undefined;

    recordLLM(operation, usage);

    return { text: result.text, usage };
  } catch (error) {
    console.error('Error generating completion:', error);

    if (error instanceof Error && error.message.includes('ECONNREFUSED')) {
      throw new Error('Ollama server not running. Start it with: ollama serve');
    }

    throw new Error(`Failed to generate completion: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function generateStructuredCompletion<T>(
  systemPrompt: string,
  userPrompt: string,
  schema: any,
  temperature: number = 0.7,
  retries: number = 2,
  operation: string = 'llm'
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const enhancedSystemPrompt = systemPrompt + `

CRITICAL: Your response must be ONLY valid JSON. No markdown, no explanations, no text before or after the JSON.
Start your response with { and end with }. Do not use \`\`\`json or any other formatting.`;

      const result = await generateCompletion(enhancedSystemPrompt, userPrompt, temperature, operation);
      
      const parsed = parseJSONResponse<T>(result.text);
      return parsed;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.error(`Attempt ${attempt}/${retries} failed:`, lastError.message);
      
      if (attempt < retries) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  console.error('All attempts failed, returning empty result');
  return getEmptyResult<T>();
}

function parseJSONResponse<T>(text: string): T {
  const jsonPatterns = [
    /```json\s*([\s\S]*?)\s*```/,
    /```\s*([\s\S]*?)\s*```/,
    /(\{[\s\S]*\})/,
    /(\[[\s\S]*\])/,
  ];

  let jsonText = text.trim();

  for (const pattern of jsonPatterns) {
    const match = text.match(pattern);
    if (match) {
      jsonText = match[1].trim();
      break;
    }
  }

  jsonText = jsonText
    .replace(/,\s*}/g, '}')
    .replace(/,\s*]/g, ']')
    .replace(/\n/g, ' ')
    .replace(/\r/g, '')
    .replace(/\t/g, ' ');

  jsonText = jsonText.replace(/[\x00-\x1F\x7F]/g, ' ');

  try {
    return JSON.parse(jsonText) as T;
  } catch (e) {
    const objectMatch = jsonText.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/);
    if (objectMatch) {
      try {
        return JSON.parse(objectMatch[0]) as T;
      } catch (e2) {
      }
    }

    console.error('Raw LLM response:', text.substring(0, 500));
    console.error('Cleaned JSON text:', jsonText.substring(0, 500));
    throw new Error(`Failed to parse JSON: ${e instanceof Error ? e.message : 'Unknown error'}`);
  }
}

function getEmptyResult<T>(): T {
  return {
    entities: [],
    relationships: [],
    resolvedEntities: [],
    resolvedRelationships: [],
    accepted: [],
    rejected: [],
    confidenceAdjustments: [],
  } as unknown as T;
}

export async function checkOllamaConnection(): Promise<boolean> {
  if (provider === 'openai') {
    return !!openaiApiKey;
  }

  try {
    const response = await fetch(`${baseURL}/api/tags`);
    if (!response.ok) {
      return false;
    }

    const data: any = await response.json();
    const hasModel = data.models?.some((m: any) =>
      m.name === ollamaModel || m.name.startsWith(ollamaModel.split(':')[0])
    );

    if (!hasModel) {
      console.warn(`Model ${ollamaModel} not found. Available models:`,
        data.models?.map((m: any) => m.name).join(', '));
    }

    return true;
  } catch (error) {
    return false;
  }
}

export async function warmupModel(): Promise<void> {
  const modelName = provider === 'openai' ? openaiModel : ollamaModel;
  console.log(`Warming up ${provider} model (${modelName})...`);
  try {
    await generateCompletion(
      'You are a helpful assistant.',
      'Say "ready" in one word.',
      0.1
    );
    console.log(`${provider} model warmed up successfully`);
  } catch (error) {
    console.error('Failed to warm up model:', error);
  }
}