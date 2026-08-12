/**
 * Provider-agnostic LLM transport (Ollama | OpenAI).
 *
 * Both providers are called over their native HTTP APIs rather than through a
 * model-abstraction SDK. That is deliberate: this file previously routed Ollama
 * through `ollama-ai-provider@1.2.0`, which implements AI SDK specification *v1*,
 * while the installed `ai@5` only accepts *v2* models. Every Ollama completion
 * therefore threw `UnsupportedModelVersionError` before a single byte hit the
 * network — and because the callers swallowed that into an empty result, papers
 * ingested on the documented default configuration were marked "completed" with
 * an empty graph. Two direct fetch calls have no version-drift surface at all,
 * and they give us real token counts from both providers.
 *
 * Failure policy: this module NEVER fabricates a successful-looking empty
 * result. Extraction failure is a fact the pipeline has to see and record, not
 * something to paper over — a knowledge graph that silently loses a paper is
 * worse than one that refuses it.
 */

import { recordLLM } from './metrics';
import { fetchWithTimeout, TIMEOUTS } from './http';
import { roleForOperation, routeFor } from './model-router';

const provider = process.env.LLM_PROVIDER || 'ollama'; // 'ollama' | 'openai'
const baseURL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const ollamaModel = process.env.OLLAMA_MODEL || 'llama3.2:1b';
const openaiModel = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const openaiApiKey = process.env.OPENAI_API_KEY;

const MAX_OUTPUT_TOKENS = 16384;

export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LLMResponse {
  text: string;
  usage?: LLMUsage;
  /** Which model actually served this call — `provider:model`. */
  model?: string;
}

/** Raised when the model could not be reached or returned an error status. */
export class LLMUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LLMUnavailableError';
  }
}

/** Raised when the model answered but not with parseable JSON, after all retries. */
export class LLMStructuredOutputError extends Error {
  readonly attempts: number;
  constructor(message: string, attempts: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LLMStructuredOutputError';
    this.attempts = attempts;
  }
}

export function llmProvider(): string {
  return provider;
}

export function llmModel(): string {
  return provider === 'openai' ? openaiModel : ollamaModel;
}

// --- Completions -------------------------------------------------------------

export async function generateCompletion(
  systemPrompt: string,
  userPrompt: string,
  temperature: number = 0.7,
  operation: string = 'llm'
): Promise<LLMResponse> {
  // The operation name already identifies what this call is for, so it doubles
  // as the routing key — no call site has to learn about model selection.
  const route = routeFor(roleForOperation(operation));

  const started = Date.now();
  const result =
    route.provider === 'openai'
      ? await completeOpenAI(systemPrompt, userPrompt, temperature, route.model)
      : await completeOllama(systemPrompt, userPrompt, temperature, route.model);

  recordLLM(operation, result.usage, undefined, {
    model: `${route.provider}:${route.model}`,
    latencyMs: Date.now() - started,
  });

  return { ...result, model: `${route.provider}:${route.model}` };
}

async function completeOpenAI(
  systemPrompt: string,
  userPrompt: string,
  temperature: number,
  model: string
): Promise<LLMResponse> {
  if (!openaiApiKey) {
    throw new LLMUnavailableError('OPENAI_API_KEY is not set — required for LLM_PROVIDER=openai');
  }

  const response = await fetchWithTimeout(
    'https://api.openai.com/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openaiApiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature,
        max_completion_tokens: MAX_OUTPUT_TOKENS,
      }),
    },
    { timeoutMs: TIMEOUTS.llm, label: 'OpenAI chat completions' }
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new LLMUnavailableError(
      `OpenAI chat completions returned ${response.status}: ${detail.slice(0, 500)}`
    );
  }

  const data: any = await response.json();
  return {
    text: data.choices?.[0]?.message?.content ?? '',
    usage: data.usage
      ? {
          promptTokens: data.usage.prompt_tokens ?? 0,
          completionTokens: data.usage.completion_tokens ?? 0,
          totalTokens: data.usage.total_tokens ?? 0,
        }
      : undefined,
  };
}

/**
 * Ollama's native `/api/chat`. `stream: false` returns one JSON object carrying
 * both the message and the token counts (`prompt_eval_count` / `eval_count`),
 * which is what makes the /api/field/benchmark token columns meaningful on the
 * default local setup.
 */
async function completeOllama(
  systemPrompt: string,
  userPrompt: string,
  temperature: number,
  model: string
): Promise<LLMResponse> {
  let response: Response;
  try {
    response = await fetchWithTimeout(
      `${baseURL}/api/chat`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          options: { temperature, num_predict: MAX_OUTPUT_TOKENS },
        }),
      },
      { timeoutMs: TIMEOUTS.llm, label: `Ollama chat (${model})` }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('ECONNREFUSED') || message.includes('fetch failed')) {
      throw new LLMUnavailableError(
        `Cannot reach Ollama at ${baseURL} — start it with \`ollama serve\``,
        { cause: err }
      );
    }
    throw new LLMUnavailableError(message, { cause: err });
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    // 404 from /api/chat means the model isn't pulled — by far the most common
    // local misconfiguration, so name the fix rather than the status code.
    if (response.status === 404) {
      throw new LLMUnavailableError(
        `Ollama has no model "${model}" — pull it with \`ollama pull ${model}\``
      );
    }
    throw new LLMUnavailableError(
      `Ollama chat returned ${response.status}: ${detail.slice(0, 500)}`
    );
  }

  const data: any = await response.json();
  const promptTokens = Number(data.prompt_eval_count ?? 0);
  const completionTokens = Number(data.eval_count ?? 0);

  return {
    text: data.message?.content ?? '',
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    },
  };
}

// --- Structured (JSON) completions ------------------------------------------

/**
 * Ask for JSON and parse it, retrying only the *parse* failures.
 *
 * Throws `LLMStructuredOutputError` when every attempt fails. It used to return
 * `{entities: [], relationships: [], ...}` instead, which made a total model
 * outage indistinguishable from "this chunk genuinely contained no facts" — the
 * pipeline then marked the paper fully processed. Callers must now decide what a
 * failure means; none of them may silently treat it as emptiness.
 */
export async function generateStructuredCompletion<T>(
  systemPrompt: string,
  userPrompt: string,
  _schema: unknown,
  temperature: number = 0.7,
  attempts: number = 2,
  operation: string = 'llm'
): Promise<T> {
  const totalAttempts = Math.max(1, attempts);
  let lastError: Error | null = null;

  const enhancedSystemPrompt =
    systemPrompt +
    `

CRITICAL: Your response must be ONLY valid JSON. No markdown, no explanations, no text before or after the JSON.
Start your response with { and end with }. Do not use \`\`\`json or any other formatting.`;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    let result: LLMResponse;
    try {
      result = await generateCompletion(enhancedSystemPrompt, userPrompt, temperature, operation);
    } catch (err) {
      // Transport/availability failures are not fixed by asking again with the
      // same prompt — surface them immediately with their original type.
      throw err;
    }

    try {
      return parseJSONResponse<T>(result.text);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.error(
        `[llm] ${operation}: unparseable JSON on attempt ${attempt}/${totalAttempts}: ${lastError.message}`
      );
      if (attempt < totalAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  throw new LLMStructuredOutputError(
    `${operation}: model did not return valid JSON after ${totalAttempts} attempt(s): ${lastError?.message}`,
    totalAttempts,
    { cause: lastError }
  );
}

export function parseJSONResponse<T>(text: string): T {
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
      } catch {
        // fall through to the thrown error below
      }
    }

    throw new Error(
      `Failed to parse JSON: ${e instanceof Error ? e.message : 'Unknown error'} (response began: ${text
        .slice(0, 200)
        .replace(/\s+/g, ' ')})`
    );
  }
}

// --- Health ------------------------------------------------------------------

export interface ProviderHealth {
  provider: string;
  model: string;
  ok: boolean;
  detail?: string;
}

/**
 * Reports whether the configured chat provider can actually serve a request.
 * For Ollama that means the server answers *and* the configured model is
 * present — "server is up but the model was never pulled" is a failure that
 * previously read as healthy, then surfaced as an empty knowledge graph.
 */
export async function checkLLMHealth(): Promise<ProviderHealth> {
  const base: ProviderHealth = { provider, model: llmModel(), ok: false };

  if (provider === 'openai') {
    return openaiApiKey
      ? { ...base, ok: true }
      : { ...base, detail: 'OPENAI_API_KEY is not set' };
  }

  try {
    const response = await fetchWithTimeout(
      `${baseURL}/api/tags`,
      { method: 'GET' },
      { timeoutMs: TIMEOUTS.healthcheck, label: 'Ollama tags' }
    );
    if (!response.ok) {
      return { ...base, detail: `Ollama returned ${response.status} from ${baseURL}` };
    }

    const data: any = await response.json();
    const available: string[] = (data.models ?? []).map((m: any) => String(m.name));
    const hasModel = available.some(
      (name) => name === ollamaModel || name.split(':')[0] === ollamaModel.split(':')[0]
    );

    if (!hasModel) {
      return {
        ...base,
        detail: `Model "${ollamaModel}" not pulled. Available: ${
          available.join(', ') || 'none'
        }. Fix: ollama pull ${ollamaModel}`,
      };
    }

    return { ...base, ok: true };
  } catch (err) {
    return {
      ...base,
      detail: `Cannot reach Ollama at ${baseURL}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function warmupModel(): Promise<void> {
  console.log(`Warming up ${provider} model (${llmModel()})...`);
  try {
    await generateCompletion('You are a helpful assistant.', 'Say "ready" in one word.', 0.1, 'warmup');
    console.log(`${provider} model warmed up successfully`);
  } catch (error) {
    console.error('Failed to warm up model:', error instanceof Error ? error.message : error);
  }
}
