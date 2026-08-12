/**
 * The LLM transport's failure contract.
 *
 * The defect these tests exist to prevent: `generateStructuredCompletion` used to
 * return `{entities: [], relationships: [], accepted: [], ...}` after exhausting
 * its retries. Combined with an Ollama provider that could not run at all, a
 * fully-broken default configuration produced papers marked "completed" with an
 * empty graph and no error anywhere in the system.
 */

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseJSONResponse,
  generateStructuredCompletion,
  generateCompletion,
  LLMUnavailableError,
  LLMStructuredOutputError,
} from '../services/llm';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Stub Ollama's /api/chat with a fixed assistant message. */
function stubOllamaChat(content: string, extra: Record<string, unknown> = {}) {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        message: { role: 'assistant', content },
        prompt_eval_count: 11,
        eval_count: 7,
        ...extra,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )) as typeof fetch;
}

describe('parseJSONResponse', () => {
  test('parses bare JSON', () => {
    assert.deepEqual(parseJSONResponse('{"a":1}'), { a: 1 });
  });

  test('parses JSON inside a fenced code block', () => {
    assert.deepEqual(parseJSONResponse('```json\n{"a":1}\n```'), { a: 1 });
  });

  test('parses JSON surrounded by prose', () => {
    assert.deepEqual(parseJSONResponse('Sure! {"a":1} Hope that helps.'), { a: 1 });
  });

  test('tolerates trailing commas', () => {
    assert.deepEqual(parseJSONResponse('{"a":1,}'), { a: 1 });
  });

  test('throws on genuinely unparseable output instead of returning a shape', () => {
    assert.throws(() => parseJSONResponse('I cannot help with that.'), /Failed to parse JSON/);
  });

  test('the error quotes the response so the failure is diagnosable', () => {
    try {
      parseJSONResponse('total nonsense here');
      assert.fail('expected a throw');
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes('total nonsense here'));
    }
  });
});

describe('generateCompletion (ollama transport)', () => {
  test('returns the assistant message and real token counts', async () => {
    stubOllamaChat('ready');
    const result = await generateCompletion('sys', 'user', 0.1, 'test');
    assert.equal(result.text, 'ready');
    // Token accounting was silently zero before: the AI-SDK path read v4 field
    // names (`promptTokens`) off a v5 usage object, so the benchmark's token
    // columns were always 0 on the default local provider.
    assert.equal(result.usage?.promptTokens, 11);
    assert.equal(result.usage?.completionTokens, 7);
    assert.equal(result.usage?.totalTokens, 18);
  });

  test('an unreachable model surfaces as LLMUnavailableError, not a generic failure', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;

    await assert.rejects(() => generateCompletion('sys', 'user', 0.1, 'test'), LLMUnavailableError);
  });

  test('a missing model names the fix', async () => {
    globalThis.fetch = (async () => new Response('model not found', { status: 404 })) as typeof fetch;

    await assert.rejects(
      () => generateCompletion('sys', 'user', 0.1, 'test'),
      (err: unknown) => {
        assert.ok(err instanceof LLMUnavailableError);
        assert.match(err.message, /ollama pull/);
        return true;
      }
    );
  });
});

describe('generateStructuredCompletion failure policy', () => {
  test('returns parsed JSON on success', async () => {
    stubOllamaChat('{"entities":[{"mention":"3DGS"}],"relationships":[]}');
    const out = await generateStructuredCompletion<{ entities: unknown[] }>(
      'sys',
      'user',
      null,
      0.3,
      2,
      'extractor'
    );
    assert.equal(out.entities.length, 1);
  });

  test('THROWS after exhausting retries — never fabricates an empty result', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(
        JSON.stringify({ message: { content: 'I am unable to produce JSON.' } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }) as typeof fetch;

    await assert.rejects(
      () => generateStructuredCompletion('sys', 'user', null, 0.3, 2, 'extractor'),
      LLMStructuredOutputError
    );
    assert.equal(calls, 2, 'should have used both attempts');
  });

  test('a transport failure propagates immediately without burning retries', async () => {
    // Re-prompting an unreachable server with the same input cannot succeed; it
    // just multiplies the wait before the pipeline learns it failed.
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw new TypeError('fetch failed');
    }) as typeof fetch;

    await assert.rejects(
      () => generateStructuredCompletion('sys', 'user', null, 0.3, 3, 'extractor'),
      LLMUnavailableError
    );
    assert.equal(calls, 1, 'transport errors must not be retried here');
  });

  test('the thrown error is distinguishable by type, so callers can set policy', async () => {
    stubOllamaChat('not json');
    try {
      await generateStructuredCompletion('sys', 'user', null, 0.3, 1, 'extractor');
      assert.fail('expected a throw');
    } catch (err) {
      assert.ok(err instanceof LLMStructuredOutputError);
      assert.equal(err.attempts, 1);
    }
  });
});
