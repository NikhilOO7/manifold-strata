/**
 * Retrieval quality scorecard.
 *
 *   EMBED_PROVIDER=local DATABASE_URL=...knowledge_graph_eval \
 *     pnpm --filter api eval
 *   pnpm --filter api eval -- --sweep-alpha       # tune PPR restart on evidence
 *
 * Builds a corpus with known answers, runs every strategy over the same
 * questions, and prints recall / nDCG / MRR alongside context size and latency.
 * Tears the corpus down afterwards so the run is repeatable.
 *
 * What this does and does not establish: it measures the *retrieval mechanism*
 * on a construction where ground truth is known exactly. It says nothing about
 * extraction quality, and with EMBED_PROVIDER=local the geometry is lexical
 * rather than semantic. A real-corpus gold set with human labels remains the
 * missing piece — but "does graph traversal find evidence that similarity
 * cannot" is a question this answers honestly.
 */

import 'dotenv/config';
import { closeDb } from '../db';
import { buildEvalCorpus, teardownEvalCorpus, EVAL_DOMAIN, type GoldQuestion } from './corpus';
import { STRATEGIES, fieldWithAlpha, fieldWithWeights, type Strategy } from './strategies';
import { scoreQuestion, aggregate, type QuestionScore, type AggregateScore } from './metrics';
import { EMBEDDING_SPACE } from '../services/embedding-space';

const K = parseInt(process.env.EVAL_K || '10', 10);
const TOPICS = parseInt(process.env.EVAL_TOPICS || '20', 10);

async function runStrategy(
  strategy: Strategy,
  questions: GoldQuestion[]
): Promise<{ overall: AggregateScore; byFamily: Record<string, AggregateScore> }> {
  const scores: QuestionScore[] = [];
  const byFamily: Record<string, QuestionScore[]> = {};

  for (const q of questions) {
    const gold = new Set(q.goldPropositionIds);
    const t0 = performance.now();
    let result;
    try {
      result = await strategy.run(q.question, EVAL_DOMAIN, K);
    } catch (err) {
      // A strategy that errors scores zero rather than aborting the comparison —
      // but the failure is printed, not swallowed.
      console.error(`  ! ${strategy.name} failed on "${q.question}": ${
        err instanceof Error ? err.message : String(err)
      }`);
      result = { propositionIds: [], contextChars: 0 };
    }
    const latency = performance.now() - t0;

    const score = scoreQuestion(result.propositionIds, gold, K, result.contextChars, latency);
    scores.push(score);
    (byFamily[q.family] ??= []).push(score);
  }

  return {
    overall: aggregate(scores),
    byFamily: Object.fromEntries(Object.entries(byFamily).map(([k, v]) => [k, aggregate(v)])),
  };
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function row(label: string, s: AggregateScore): string {
  return (
    `  ${label.padEnd(24)}` +
    `${pct(s.recall).padStart(7)}` +
    `${pct(s.ndcg).padStart(9)}` +
    `${s.mrr.toFixed(3).padStart(8)}` +
    `${pct(s.answeredAtAll).padStart(9)}` +
    `${Math.round(s.meanContextChars).toLocaleString().padStart(9)}` +
    `${s.p95LatencyMs.toFixed(0).padStart(9)} ms`
  );
}

function header(): string {
  return (
    `  ${'strategy'.padEnd(24)}` +
    `${'recall'.padStart(7)}` +
    `${'nDCG'.padStart(9)}` +
    `${'MRR'.padStart(8)}` +
    `${'found'.padStart(9)}` +
    `${'chars'.padStart(9)}` +
    `${'p95'.padStart(12)}`
  );
}

async function main() {
  const sweepAlpha = process.argv.includes('--sweep-alpha');
  const sweepWeights = process.argv.includes('--sweep-weights');

  console.log('\nRetrieval quality evaluation');
  console.log('─'.repeat(80));
  console.log(`Embedding space: ${EMBEDDING_SPACE.id}`);
  console.log(`Topics: ${TOPICS}  ·  k: ${K}  ·  domain: ${EVAL_DOMAIN}`);
  if (EMBEDDING_SPACE.provider === 'local') {
    console.log(
      'NOTE: the local provider is lexical, not semantic. Ranking here reflects\n' +
        '      retrieval mechanics, not language understanding.'
    );
  }
  console.log('');

  console.log('Building corpus...');
  const corpus = await buildEvalCorpus(TOPICS);
  console.log(
    `  ${corpus.questions.length} questions ` +
      `(${corpus.questions.filter((q) => q.family === 'single-hop').length} single-hop, ` +
      `${corpus.questions.filter((q) => q.family === 'multi-hop').length} multi-hop)\n`
  );

  try {
    const strategies = sweepAlpha
      ? [0.15, 0.3, 0.5, 0.7, 0.85].map(fieldWithAlpha)
      : sweepWeights
        ? [
            fieldWithWeights(1, 1, 1),
            fieldWithWeights(2, 1, 1),
            fieldWithWeights(3, 1, 1),
            fieldWithWeights(4, 1, 1),
            fieldWithWeights(3, 1, 2),
            fieldWithWeights(2, 1, 2),
          ]
        : STRATEGIES;

    const results: Array<{ strategy: Strategy; scores: Awaited<ReturnType<typeof runStrategy>> }> = [];
    for (const strategy of strategies) {
      process.stdout.write(`Running ${strategy.name}...\r`);
      results.push({ strategy, scores: await runStrategy(strategy, corpus.questions) });
    }
    process.stdout.write(' '.repeat(40) + '\r');

    console.log('OVERALL');
    console.log(header());
    for (const r of results) console.log(row(r.strategy.name, r.scores.overall));

    for (const family of ['single-hop', 'multi-hop', 'hub']) {
      const present = results.filter((r) => r.scores.byFamily[family]);
      if (present.length === 0) continue;
      console.log(`\n${family.toUpperCase()}`);
      console.log(header());
      for (const r of present) console.log(row(r.strategy.name, r.scores.byFamily[family]));
    }

    if (!sweepAlpha && !sweepWeights) {
      const vector = results.find((r) => r.strategy.name === 'vector');
      const field = results.find((r) => r.strategy.name === 'field (hybrid)');
      if (vector && field) {
        const vm = vector.scores.byFamily['multi-hop'];
        const fm = field.scores.byFamily['multi-hop'];
        const vs = vector.scores.byFamily['single-hop'];
        const fs = field.scores.byFamily['single-hop'];
        console.log('\nVERDICT');
        console.log(
          `  multi-hop recall   vector ${pct(vm.recall)}  →  field ${pct(fm.recall)}` +
            `   (${fm.recall >= vm.recall ? '+' : ''}${((fm.recall - vm.recall) * 100).toFixed(1)} pts)`
        );
        console.log(
          `  single-hop recall  vector ${pct(vs.recall)}  →  field ${pct(fs.recall)}` +
            `   (${fs.recall >= vs.recall ? '+' : ''}${((fs.recall - vs.recall) * 100).toFixed(1)} pts)`
        );
        console.log(
          `  context size       vector ${Math.round(vector.scores.overall.meanContextChars)} chars` +
            `  →  field ${Math.round(field.scores.overall.meanContextChars)} chars`
        );
      }
    }

    console.log('');
  } finally {
    console.log('Tearing down corpus...');
    await teardownEvalCorpus(corpus);
    await closeDb();
  }
}

main().catch(async (err) => {
  console.error('Evaluation failed:', err);
  await closeDb().catch(() => {});
  process.exit(1);
});
