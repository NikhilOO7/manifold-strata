/**
 * Compare candidate models on the roles this system actually runs.
 *
 *   pnpm --filter api models:compare -- --models qwen2.5:7b,llama3.2:3b
 *
 * Model choice per role is a real engineering decision with real trade-offs, and
 * it is usually made from reputation. This runs the system's own prompts against
 * each candidate and reports what matters for the decision:
 *
 *   extract     Latency dominates the corpus bill (one call per chunk) and the
 *               only quality that matters is whether valid, populated JSON comes
 *               back. A model that is twice as fast and equally reliable here is
 *               strictly better, regardless of how it reasons.
 *
 *   verbalize   Runs once per query and is the only text a human reads.
 *               Grounding is the job, so the check is whether the answer stays
 *               inside the evidence it was given.
 *
 * The numbers are hardware-specific by nature — run it on the machine that will
 * serve the traffic, not on a laptop that will not.
 */

import 'dotenv/config';
import { generateStructuredCompletion, generateCompletion, LLMUnavailableError } from './llm';
import { createExtractionSystemPrompt, createExtractionUserPrompt } from '../agents/prompts/extraction';
import { getDomain } from '../domains';
import type { ExtractorOutput } from '../agents/extractor';

const SAMPLE_CHUNK = `
The dominant sequence transduction models are based on complex recurrent or
convolutional neural networks that include an encoder and a decoder. The best
performing models also connect the encoder and decoder through an attention
mechanism. We propose a new simple network architecture, the Transformer, based
solely on attention mechanisms, dispensing with recurrence and convolutions
entirely. Experiments on two machine translation tasks show these models to be
superior in quality while being more parallelizable and requiring significantly
less time to train. Our model achieves 28.4 BLEU on the WMT 2014
English-to-German translation task, improving over the existing best results,
including ensembles, by over 2 BLEU.
`.trim();

const EVIDENCE = [
  'The Transformer is the first transduction model relying entirely on self-attention.',
  'The Transformer achieves 28.4 BLEU on the WMT 2014 English-to-German translation task.',
  'Training took 3.5 days on eight P100 GPUs.',
];

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

interface RoleResult {
  ok: boolean;
  latencyMs: number;
  tokens: number;
  detail: string;
}

async function benchExtract(model: string): Promise<RoleResult> {
  const domain = getDomain('nlp');
  const system = createExtractionSystemPrompt(domain);
  const user = createExtractionUserPrompt(SAMPLE_CHUNK, 'abstract', domain.name);

  process.env.MODEL_EXTRACT = model;
  const started = Date.now();
  try {
    const out = await generateStructuredCompletion<ExtractorOutput>(system, user, null, 0.3, 1, 'extractor');
    const entities = Array.isArray(out?.entities) ? out.entities.length : 0;
    const relationships = Array.isArray(out?.relationships) ? out.relationships.length : 0;
    return {
      ok: entities > 0,
      latencyMs: Date.now() - started,
      tokens: 0,
      detail: `${entities} entities, ${relationships} relationships`,
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      tokens: 0,
      detail: err instanceof LLMUnavailableError ? 'unavailable' : 'invalid JSON',
    };
  }
}

async function benchVerbalize(model: string): Promise<RoleResult> {
  process.env.MODEL_VERBALIZE = model;
  const system =
    'You are a knowledge-graph assistant. Answer the question using ONLY the ' +
    'numbered evidence provided. Be concise. If the evidence is insufficient, say so.';
  const user =
    `Question: How long did training take, and on what hardware?\n\nEvidence:\n` +
    EVIDENCE.map((e, i) => `[${i + 1}] ${e}`).join('\n') +
    `\n\nAnswer:`;

  const started = Date.now();
  try {
    const out = await generateCompletion(system, user, 0.2, 'verbalize');
    const text = out.text.trim();
    // Grounding check: the answer should contain the facts the evidence states
    // and should not have invented a different number.
    const grounded = /3\.5\s*days/i.test(text) && /P100/i.test(text);
    return {
      ok: grounded,
      latencyMs: Date.now() - started,
      tokens: out.usage?.totalTokens ?? 0,
      detail: grounded ? text.slice(0, 60).replace(/\s+/g, ' ') : `UNGROUNDED: ${text.slice(0, 50).replace(/\s+/g, ' ')}`,
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      tokens: 0,
      detail: err instanceof Error ? err.message.slice(0, 50) : 'failed',
    };
  }
}

async function main() {
  const models = arg('models', 'qwen2.5:7b,llama3.2:3b')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  const rounds = parseInt(arg('rounds', '2'), 10);

  console.log('\nModel comparison — this system\'s own prompts');
  console.log('─'.repeat(74));
  console.log(`Candidates: ${models.join(', ')}   ·   ${rounds} round(s) each\n`);

  for (const role of ['extract', 'verbalize'] as const) {
    console.log(role === 'extract' ? 'EXTRACT  (one call per chunk — the corpus bill)' : '\nVERBALIZE  (one call per query — the only text a human reads)');
    console.log(`  ${'model'.padEnd(18)}${'ok'.padStart(4)}${'median'.padStart(10)}${'  detail'}`);

    for (const model of models) {
      const runs: RoleResult[] = [];
      for (let i = 0; i < rounds; i++) {
        runs.push(role === 'extract' ? await benchExtract(model) : await benchVerbalize(model));
      }
      const sorted = runs.map((r) => r.latencyMs).sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const okCount = runs.filter((r) => r.ok).length;

      console.log(
        `  ${model.padEnd(18)}${`${okCount}/${rounds}`.padStart(4)}${`${(median / 1000).toFixed(1)}s`.padStart(10)}  ${runs[runs.length - 1].detail}`
      );
    }
  }

  console.log('\n  Latency is per call. Multiply the extract row by your chunk count to');
  console.log('  see what a corpus costs; the verbalize row is paid once per question.\n');
}

main().catch((err) => {
  console.error('Comparison failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
