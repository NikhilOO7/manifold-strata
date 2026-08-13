/**
 * How wide should the extraction lane be on THIS hardware?
 *
 * `PROCESS_CONCURRENCY` decides how many papers extract at once. The default of
 * 1 was justified in comments with "extraction serialises inside Ollama anyway",
 * and that claim was never actually measured — it was inference from the shape of
 * the problem (one GPU, one model). Inference is how the PPR alpha change got
 * shipped and then reverted by the eval harness, so the same discipline applies
 * here: the knob is decided by measurement, on the machine that will run it.
 *
 * The measurement is easy to get wrong, so this script is careful about two
 * things a naive version gets wrong:
 *
 *   Background load.  A first attempt at this ran while a real extraction was in
 *                     flight and reported a 2.4x gain. That number was garbage:
 *                     the serial arm ran first, the background job finished
 *                     partway through, and the parallel arm inherited a quieter
 *                     GPU. Any drift in load over the run is indistinguishable
 *                     from a real effect if the arms always run in the same
 *                     order.
 *   Ordering.         So each repetition runs the arms in BOTH orders
 *                     (serial→parallel, then parallel→serial) and reports the
 *                     mean. A monotonic drift cancels; a real effect does not.
 *
 * It refuses to run if the queue has live work, because that is exactly the
 * contamination described above.
 *
 *   pnpm --filter api bench:lane-width
 *   pnpm --filter api bench:lane-width -- --n 4 --repeats 3
 */

import 'dotenv/config';
import { db } from '../db';
import { sql } from 'drizzle-orm';
import { generateCompletion } from './llm';
import { routeFor } from './model-router';

interface Arg {
  n: number;
  repeats: number;
}

function parseArgs(): Arg {
  const argv = process.argv.slice(2);
  const read = (flag: string, fallback: number) => {
    const i = argv.indexOf(flag);
    if (i === -1) return fallback;
    const v = parseInt(argv[i + 1] ?? '', 10);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return { n: read('--n', 2), repeats: read('--repeats', 2) };
}

/** A prompt shaped like a real extraction call: a chunk in, structured facts out. */
const CHUNK = `The Helios system introduces adaptive batching for stream processing.
It extends the Chronos scheduler with deadline-aware priority queues and evaluates
on the Meridian benchmark suite against fixed-window baselines.`;

async function oneCall(): Promise<number> {
  const started = Date.now();
  // `operation` doubles as the routing key, so this exercises the same model the
  // extraction lane actually uses rather than whatever the default happens to be.
  await generateCompletion(
    'You extract structured facts from research text.',
    `List the entities and relationships in this text as JSON.\n\n${CHUNK}\n\nJSON:`,
    0,
    'extract'
  );
  return Date.now() - started;
}

async function serial(n: number): Promise<number> {
  const started = Date.now();
  for (let i = 0; i < n; i++) await oneCall();
  return Date.now() - started;
}

async function parallel(n: number): Promise<number> {
  const started = Date.now();
  await Promise.all(Array.from({ length: n }, () => oneCall()));
  return Date.now() - started;
}

async function main(): Promise<void> {
  const { n, repeats } = parseArgs();

  // Refuse to measure through someone else's GPU load.
  // An owned row is not the same as a running job: a crashed instance leaves its
  // claim behind until the lease expires. Only a LIVE lease means a process is
  // actually on the GPU right now.
  const [{ live }] = (await db.execute(sql`
    select count(*)::int as live from jobs
    where type = 'process' and owner is not null
      and status not in ('completed', 'failed')
      and lease_expires_at is not null and lease_expires_at > now()
  `)) as unknown as Array<{ live: number }>;
  if (live > 0) {
    console.error(
      `✗ ${live} extraction job(s) are running. Their GPU load would be measured as if it\n` +
        `  were this benchmark's. Stop the workers (or wait) and re-run.`
    );
    process.exit(1);
  }

  const route = routeFor('extract');
  console.log(`\nExtraction lane width — ${route.provider}:${route.model}`);
  console.log(`  n=${n} concurrent · ${repeats} repetition(s)\n`);

  console.log('  warming the model...');
  await oneCall();

  const serialRuns: number[] = [];
  const parallelRuns: number[] = [];

  for (let r = 0; r < repeats; r++) {
    // Alternate which arm goes first so a drifting machine cannot fake a result.
    if (r % 2 === 0) {
      serialRuns.push(await serial(n));
      parallelRuns.push(await parallel(n));
    } else {
      parallelRuns.push(await parallel(n));
      serialRuns.push(await serial(n));
    }
    console.log(
      `  rep ${r + 1}/${repeats}: serial ${(serialRuns.at(-1)! / 1000).toFixed(1)}s · ` +
        `parallel ${(parallelRuns.at(-1)! / 1000).toFixed(1)}s`
    );
  }

  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const spread = (xs: number[]) =>
    xs.length < 2 ? 0 : (Math.max(...xs) - Math.min(...xs)) / mean(xs);

  const s = mean(serialRuns);
  const p = mean(parallelRuns);
  const gain = s / p;
  const noise = Math.max(spread(serialRuns), spread(parallelRuns));

  console.log(`\n  serial   ${(s / 1000).toFixed(1)}s mean`);
  console.log(`  parallel ${(p / 1000).toFixed(1)}s mean`);
  console.log(`  throughput gain: ${gain.toFixed(2)}x   (run-to-run spread: ${(noise * 100).toFixed(0)}%)\n`);

  // A result smaller than the run-to-run spread is not a result.
  if (Math.abs(gain - 1) * 100 < noise * 100) {
    console.log('  VERDICT: inconclusive — the effect is smaller than the noise.');
    console.log('           Raise --repeats, or accept that this machine shows no clear gain.');
  } else if (gain > 1.15) {
    console.log(`  VERDICT: real gain. Set PROCESS_CONCURRENCY=${n} to claim it.`);
    console.log('           Watch memory: each concurrent request needs its own KV cache.');
  } else {
    console.log('  VERDICT: no meaningful gain — the model server serialises this work.');
    console.log('           Keep PROCESS_CONCURRENCY=1; extra workers would only queue.');
  }

  const { closeDb } = await import('../db');
  await closeDb();
}

main().catch((err) => {
  console.error('Benchmark failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
